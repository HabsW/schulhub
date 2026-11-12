'use strict';
// Everything about uploaded app files. All uploads are untrusted.
//
// Storage design: file CONTENT is stored under its SHA-256 hash in
// data/blobs/, file NAMES only exist as rows in the database. A path on disk
// is therefore never built from a name the uploader chose, which rules out
// path traversal by construction (names are still validated strictly).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const yauzl = require('yauzl');
const { HttpError } = require('./util');

// Allowed file types -> the Content-Type they are served with.
const TYPES = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', json: 'application/json; charset=utf-8', map: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', csv: 'text/csv; charset=utf-8',
  xml: 'application/xml', webmanifest: 'application/manifest+json',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', bmp: 'image/bmp',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', flac: 'audio/flac',
  mp4: 'video/mp4', webm: 'video/webm',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  wasm: 'application/wasm',
  // game engine exports and assets (always served as opaque data)
  pck: 'application/octet-stream', data: 'application/octet-stream', bin: 'application/octet-stream',
  dat: 'application/octet-stream', unityweb: 'application/octet-stream', mem: 'application/octet-stream',
  glb: 'model/gltf-binary', gltf: 'model/gltf+json', obj: 'text/plain; charset=utf-8', mtl: 'text/plain; charset=utf-8',
  fnt: 'text/plain; charset=utf-8', atlas: 'text/plain; charset=utf-8', glsl: 'text/plain; charset=utf-8',
  vert: 'text/plain; charset=utf-8', frag: 'text/plain; charset=utf-8', tmx: 'application/xml', tsx: 'application/xml',
  py: 'text/plain; charset=utf-8',
};
const TEXT_VIEW = new Set(['html', 'htm', 'js', 'mjs', 'css', 'json', 'map', 'txt', 'md', 'csv', 'xml', 'webmanifest', 'svg',
  'gltf', 'obj', 'mtl', 'fnt', 'atlas', 'glsl', 'vert', 'frag', 'tmx', 'tsx', 'py']);
const JUNK = new Set(['__MACOSX', 'node_modules', 'Thumbs.db', 'desktop.ini']);

const extOf = (p) => {
  const base = p.slice(p.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
};
const fail = (message) => new HttpError(400, message);

/** Validate a relative file path. Returns the normalised path or throws. */
function normalizePath(input) {
  if (typeof input !== 'string') throw fail('Ungültiger Dateiname.');
  const p = input.normalize('NFC');
  const shown = JSON.stringify(p.slice(0, 80));
  if (p.length === 0 || p.length > 240) throw fail('Ein Dateipfad ist leer oder zu lang (maximal 240 Zeichen).');
  // no control characters, no backslashes, nothing Windows cannot store
  if (/[\u0000-\u001f\u007f\\:*?"<>|]/.test(p)) throw fail(`Der Dateiname ${shown} enthält unerlaubte Zeichen.`);
  if (p.startsWith('/')) throw fail(`Der Dateipfad ${shown} darf nicht mit / beginnen.`);
  const segments = p.split('/');
  if (segments.length > 12) throw fail(`Der Dateipfad ${shown} hat zu viele Unterordner.`);
  for (const s of segments) {
    if (s === '' || s === '.' || s === '..' || s !== s.trim() || s.endsWith('.')) throw fail(`Der Dateipfad ${shown} ist nicht erlaubt.`);
  }
  if (segments[0].toLowerCase() === '_hub') throw fail('Der Ordner "_hub" ist reserviert.');
  return p;
}

/** Hidden files and tool leftovers are skipped silently instead of rejected. */
const isJunk = (p) => p.split('/').some((s) => s.startsWith('.') || JUNK.has(s));

function createUploads(ctx) {
  const { db, config } = ctx;
  const L = config.limits;
  const blobDir = path.join(config.dataDir, 'blobs');
  const tmpDir = path.join(config.dataDir, 'tmp');
  fs.mkdirSync(blobDir, { recursive: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  const types = { ...TYPES };
  for (const ext of config.extraExtensions) if (/^[a-z0-9]{1,12}$/.test(ext) && !types[ext]) types[ext] = 'application/octet-stream';

  const contentType = (p) => types[extOf(p)] || 'application/octet-stream';
  const isTextFile = (p) => TEXT_VIEW.has(extOf(p));
  // The hash is always produced by us, but check the shape anyway before touching the disk.
  const blobPath = (sha) => {
    if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error('bad blob id');
    return path.join(blobDir, sha.slice(0, 2), sha);
  };

  function writeBlob(buffer) {
    const sha = crypto.createHash('sha256').update(buffer).digest('hex');
    const file = blobPath(sha);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = path.join(tmpDir, `blob-${crypto.randomBytes(8).toString('hex')}`);
      fs.writeFileSync(tmp, buffer, { mode: 0o640 });
      fs.renameSync(tmp, file);
    }
    return sha;
  }

  /** Delete blobs that no version references any more. */
  function collectGarbage(shas) {
    for (const sha of new Set(shas)) {
      if (!db.get('SELECT 1 AS used FROM app_files WHERE sha256 = ? LIMIT 1', sha)) fs.rmSync(blobPath(sha), { force: true });
    }
  }

  const userBytes = (ownerId) =>
    db.get(
      `SELECT COALESCE(SUM(f.size), 0) AS n FROM app_files f
         JOIN app_versions v ON v.id = f.version_id JOIN apps a ON a.id = v.app_id WHERE a.owner_id = ?`,
      ownerId
    ).n;

  /**
   * Add one file to a version that is still being uploaded.
   * Checks name, type, size, file count, version size and the owner's quota.
   * Returns false if the file was skipped as junk.
   */
  function addFile(version, ownerId, rawPath, buffer) {
    const p = normalizePath(rawPath);
    if (isJunk(p)) return false;
    const ext = extOf(p);
    if (!types[ext]) throw fail(`Der Dateityp von "${p.slice(0, 80)}" ist nicht erlaubt. Erlaubt sind Web-Dateien wie HTML, CSS, JS, Bilder, Töne, Schriften und WASM.`);
    if (buffer.length > L.maxFileBytes) throw fail(`"${p.slice(0, 80)}" ist zu groß (maximal ${Math.round(L.maxFileBytes / 1048576)} MB pro Datei).`);

    const now = db.get('SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM app_files WHERE version_id = ?', version.id);
    if (now.files + 1 > L.maxFiles) throw fail(`Zu viele Dateien (maximal ${L.maxFiles}).`);
    if (now.bytes + buffer.length > L.maxVersionBytes) throw fail(`Die App ist zu groß (maximal ${Math.round(L.maxVersionBytes / 1048576)} MB).`);
    if (userBytes(ownerId) + buffer.length > L.maxUserBytes) throw fail('Der Speicherplatz dieses Kontos ist voll. Lösche alte Versionen, um Platz zu schaffen.');
    if (db.get('SELECT 1 AS dup FROM app_files WHERE version_id = ? AND path_lower = ?', version.id, p.toLowerCase())) {
      throw fail(`Die Datei "${p.slice(0, 80)}" kommt doppelt vor.`);
    }
    const sha = writeBlob(buffer);
    db.run('INSERT INTO app_files (version_id, path, path_lower, size, sha256) VALUES (?, ?, ?, ?, ?)', version.id, p, p.toLowerCase(), buffer.length, sha);
    return true;
  }

  // ---------- zip archives ----------

  const openZip = (file) => yauzl.openPromise(file, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true });

  /** Read only the directory of the archive (cheap) and validate every entry. */
  async function listZip(file) {
    let zip;
    try {
      zip = await openZip(file);
    } catch {
      throw fail('Die Datei ist kein gültiges ZIP-Archiv.');
    }
    if (zip.entryCount > L.maxFiles * 2 + 200) {
      zip.close();
      throw fail(`Das Archiv enthält zu viele Einträge (maximal ${L.maxFiles} Dateien).`);
    }
    return new Promise((resolve, reject) => {
      const names = [];
      let declared = 0;
      const stop = (err) => {
        zip.close();
        reject(err);
      };
      zip.on('error', () => stop(fail('Das ZIP-Archiv ist beschädigt oder enthält unerlaubte Pfade.')));
      zip.on('end', () => resolve(names));
      zip.on('entry', (entry) => {
        const name = entry.fileName;
        if (name.endsWith('/')) return zip.readEntry(); // directory entry
        try {
          const p = normalizePath(name);
          if (!isJunk(p)) {
            if (entry.isEncrypted()) throw fail('Verschlüsselte ZIP-Archive werden nicht unterstützt.');
            // Unix file type in the upper bits: refuse symlinks and other special files.
            const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
            if (mode !== 0 && mode !== 0o100000) throw fail('Das Archiv enthält Verknüpfungen oder Spezialdateien. Das ist nicht erlaubt.');
            if (entry.uncompressedSize > L.maxFileBytes) throw fail(`"${p.slice(0, 80)}" ist zu groß (maximal ${Math.round(L.maxFileBytes / 1048576)} MB pro Datei).`);
            declared += entry.uncompressedSize;
            if (declared > L.maxVersionBytes) throw fail(`Die App ist entpackt zu groß (maximal ${Math.round(L.maxVersionBytes / 1048576)} MB).`);
            names.push(p);
            if (names.length > L.maxFiles) throw fail(`Zu viele Dateien (maximal ${L.maxFiles}).`);
          }
        } catch (err) {
          return stop(err);
        }
        zip.readEntry();
      });
      zip.readEntry();
    });
  }

  /** If everything sits in one top folder (typical for zipped folders), drop that folder. */
  function commonFolder(names) {
    if (names.some((n) => n.toLowerCase() === 'index.html')) return '';
    const first = names[0] ? names[0].split('/')[0] : '';
    if (!first || !names.every((n) => n.startsWith(`${first}/`))) return '';
    return names.some((n) => n.toLowerCase() === `${first.toLowerCase()}/index.html`) ? `${first}/` : '';
  }

  /** Unpack a zip into a version. Sizes are counted while unpacking, never trusted from the header. */
  async function addZip(version, ownerId, file) {
    const names = await listZip(file);
    const strip = commonFolder(names);
    const zip = await openZip(file);
    let total = 0;
    await new Promise((resolve, reject) => {
      const stop = (err) => {
        zip.close();
        reject(err);
      };
      zip.on('error', () => stop(fail('Das ZIP-Archiv ist beschädigt.')));
      zip.on('end', resolve);
      zip.on('entry', (entry) => {
        let p;
        try {
          if (entry.fileName.endsWith('/')) return zip.readEntry();
          p = normalizePath(entry.fileName);
          if (isJunk(p)) return zip.readEntry();
        } catch (err) {
          return stop(err);
        }
        zip.openReadStream(entry, (err, stream) => {
          if (err) return stop(fail('Das ZIP-Archiv ist beschädigt.'));
          const chunks = [];
          let size = 0;
          stream.on('data', (chunk) => {
            size += chunk.length;
            total += chunk.length;
            // Archive bomb protection: stop as soon as the real output is too big.
            if (size > L.maxFileBytes || total > L.maxVersionBytes) {
              stream.destroy();
              return stop(fail('Das Archiv ist entpackt zu groß.'));
            }
            chunks.push(chunk);
          });
          stream.on('error', () => stop(fail('Das ZIP-Archiv ist beschädigt.')));
          stream.on('end', () => {
            try {
              addFile(version, ownerId, p.slice(strip.length), Buffer.concat(chunks));
            } catch (e) {
              return stop(e);
            }
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  }

  /** Read a request body into a temp file, aborting when it gets too large. */
  function receiveToTemp(req, maxBytes) {
    return new Promise((resolve, reject) => {
      const file = path.join(tmpDir, `upload-${crypto.randomBytes(8).toString('hex')}`);
      const out = fs.createWriteStream(file, { mode: 0o600 });
      let size = 0;
      let done = false;
      const finish = (err) => {
        if (done) return;
        done = true;
        if (!err) return resolve(file);
        out.destroy();
        fs.rm(file, { force: true }, () => reject(err));
      };
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          req.unpipe(out);
          req.resume();
          finish(new HttpError(413, `Das Archiv ist zu groß (maximal ${Math.round(maxBytes / 1048576)} MB).`));
        }
      });
      req.on('error', () => finish(fail('Der Upload wurde abgebrochen.')));
      req.on('aborted', () => finish(fail('Der Upload wurde abgebrochen.')));
      out.on('error', () => finish(new Error('temp write failed')));
      out.on('finish', () => finish());
      req.pipe(out);
    });
  }

  /** Add a local folder (used for the bundled example apps). */
  function addDirectory(version, ownerId, dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix + entry.name;
      if (entry.isDirectory()) addDirectory(version, ownerId, path.join(dir, entry.name), `${rel}/`);
      else if (entry.isFile()) addFile(version, ownerId, rel, fs.readFileSync(path.join(dir, entry.name)));
    }
  }

  // ---------- reading ----------

  const listFiles = (versionId) => db.all('SELECT path, size, sha256 FROM app_files WHERE version_id = ? ORDER BY path_lower', versionId);
  const findFile = (versionId, p) => db.get('SELECT path, size, sha256 FROM app_files WHERE version_id = ? AND path = ?', versionId, p);
  const readBlob = (sha) => fs.readFileSync(blobPath(sha));

  /** Stream a version as a zip download (written by hand to avoid a dependency). */
  function writeZip(res, files) {
    const central = [];
    let offset = 0;
    for (const f of files) {
      const data = readBlob(f.sha256);
      const packed = zlib.deflateRawSync(data);
      const name = Buffer.from(f.path, 'utf8');
      const crc = zlib.crc32(data);
      const head = Buffer.alloc(30);
      head.writeUInt32LE(0x04034b50, 0);
      head.writeUInt16LE(20, 4);
      head.writeUInt16LE(0x0800, 6); // UTF-8 names
      head.writeUInt16LE(8, 8); // deflate
      head.writeUInt32LE(0x00210000, 10); // fixed date 1980-01-01
      head.writeUInt32LE(crc, 14);
      head.writeUInt32LE(packed.length, 18);
      head.writeUInt32LE(data.length, 22);
      head.writeUInt16LE(name.length, 26);
      res.write(head);
      res.write(name);
      res.write(packed);
      const entry = Buffer.alloc(46);
      entry.writeUInt32LE(0x02014b50, 0);
      entry.writeUInt16LE(20, 4);
      entry.writeUInt16LE(20, 6);
      head.copy(entry, 8, 6, 30); // flags .. name length
      entry.writeUInt32LE(offset, 42);
      central.push(entry, name);
      offset += 30 + name.length + packed.length;
    }
    const dir = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(dir.length, 12);
    end.writeUInt32LE(offset, 16);
    res.write(dir);
    res.end(end);
  }

  return { addFile, addZip, addDirectory, receiveToTemp, collectGarbage, listFiles, findFile, readBlob, blobPath, contentType, isTextFile, writeZip, userBytes };
}

module.exports = { createUploads, normalizePath, isJunk };
