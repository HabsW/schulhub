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
const { HttpError, plural } = require('./util');
const invisible = require('./invisible');

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
const gone = () => new HttpError(404, 'Diese App gibt es nicht mehr.');

/**
 * Validate a relative file path. Returns the normalised path or throws.
 * lookup: the name only finds a row that is already stored - then invisible
 * characters are not refused (a name stored before that rule existed can still
 * be deleted). Every name that is STORED goes through the full rule.
 */
function normalizePath(input, { lookup = false } = {}) {
  if (typeof input !== 'string') throw fail('Ungültiger Dateiname.');
  const p = input.normalize('NFC');
  // Messages show invisible characters as ⟨U+202E⟩, never raw (JSON.stringify leaves them as they are).
  const shown = JSON.stringify(invisible.plain(p.slice(0, 80), invisible.IN_NAME));
  if (p.length === 0 || p.length > 240) throw fail('Ein Dateipfad ist leer oder zu lang (maximal 240 Zeichen).');
  // no control characters, no backslashes, nothing Windows cannot store
  if (/[\u0000-\u001f\u007f\\:*?"<>|]/.test(p)) throw fail(`Der Dateiname ${shown} enthält unerlaubte Zeichen.`);
  // No invisible format characters (Unicode Cf, e.g. U+202E, which reverses the text after it:
  // "bild\u202Egnp.js" is shown as "bildsj.png") and no line or paragraph separators.
  if (!lookup && invisible.has(p, invisible.IN_NAME)) {
    throw fail(`Der Dateiname ${shown} enthält ein unsichtbares Zeichen (hier als ⟨U+…⟩ zu sehen). Solche Zeichen können einen Namen anders aussehen lassen, als er ist. Benenne die Datei um.`);
  }
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
      // On the disk before the database names it: with synchronous=NORMAL a power cut may keep the row
      // but must never leave it pointing at a file whose content was still only in memory.
      const fd = fs.openSync(tmp, 'w', 0o640);
      try {
        fs.writeFileSync(fd, buffer); // writes all of it (writeSync may write less, e.g. on a full disk)
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, file);
    }
    return sha;
  }

  /** Delete blobs that no version and no editor draft references any more (after a running backup). */
  function collectGarbage(shas) {
    if (ctx.gcHold && ctx.gcHold.count > 0) {
      for (const sha of shas) ctx.gcHold.blobs.add(sha);
      return;
    }
    const doomed = [...new Set(shas)].filter((sha) => !db.get('SELECT 1 AS used FROM app_files WHERE sha256 = ? LIMIT 1', sha) && !db.get('SELECT 1 AS used FROM draft_files WHERE sha256 = ? LIMIT 1', sha));
    if (!doomed.length) return;
    // The transactions that free files are durable (their commit is on the disk before they return), so a
    // power cut can never bring back a row that points at a file deleted here.
    for (const sha of doomed) fs.rmSync(blobPath(sha), { force: true });
  }

  /**
   * At start: content files no row refers to - left by a stop or crash between disk and database, or by
   * deletions that waited for a backup when the Hub stopped - are removed. Never on a database this start
   * created (it was missing, moved away, or a copy without it), never when the database refers to no file at
   * all while files are there (the wrong database), and never a file written in the last hour (a second
   * process on the same folder may be about to name it).
   */
  function sweep() {
    let entries;
    try {
      entries = fs.readdirSync(blobDir);
    } catch {
      return 0;
    }
    const used = new Set([...db.all('SELECT DISTINCT sha256 FROM app_files'), ...db.all('SELECT DISTINCT sha256 FROM draft_files')].map((r) => r.sha256));
    const candidates = [];
    let present = 0;
    for (const dir of entries) {
      if (!/^[0-9a-f]{2}$/.test(dir)) continue;
      for (const name of fs.readdirSync(path.join(blobDir, dir))) {
        if (!/^[0-9a-f]{64}$/.test(name) || !name.startsWith(dir)) continue;
        present++;
        if (!used.has(name)) candidates.push(path.join(blobDir, dir, name));
      }
    }
    if (db.createdNow) {
      // A database created at this start next to files: a hub.sqlite without SchulHub's tables (some other SQLite
      // file put there; a missing or empty one does not even start, see app.js). These files are not its own:
      // untouched - and whoever runs the Hub has to hear of it before anybody works on in an empty school.
      if (present) console.error(`ACHTUNG: Die Datenbank ${db.file} wurde bei diesem Start neu angelegt, aber im Datenordner liegen schon ${plural(present, 'App-Datei', 'App-Dateien')}. Ist das die richtige Datenbank? Hub stoppen und die richtige zurücklegen (oder npm run restore), bevor jemand weiterarbeitet – sonst entfernt ein späterer Start diese Dateien.`);
      return 0;
    }
    if (present && !used.size) return 0; // files, but a database that names none of them: not this folder's database
    let removed = 0;
    const hourAgo = Date.now() - 60 * 60_000;
    for (const file of candidates) {
      try {
        if (fs.statSync(file).mtimeMs > hourAgo) continue;
        fs.rmSync(file, { force: true });
        removed++;
      } catch {
        // gone meanwhile
      }
    }
    return removed;
  }

  /** Bytes an account uses: all versions and editor drafts of all its apps. */
  const userBytes = (ownerId) =>
    db.get(
      `SELECT COALESCE((SELECT SUM(f.size) FROM app_files f JOIN app_versions v ON v.id = f.version_id
                          JOIN apps a ON a.id = v.app_id WHERE a.owner_id = ?), 0)
            + COALESCE((SELECT SUM(d.size) FROM draft_files d JOIN apps a ON a.id = d.app_id WHERE a.owner_id = ?), 0) AS n`,
      ownerId, ownerId
    ).n;

  /** The name of a file for a version: normalised and of an allowed type - or junk, which is skipped silently. */
  function versionFileName(rawPath) {
    const p = normalizePath(rawPath);
    if (isJunk(p)) return { p, junk: true };
    if (!types[extOf(p)]) throw fail(`Der Dateityp von "${p.slice(0, 80)}" ist nicht erlaubt. Erlaubt sind Web-Dateien wie HTML, CSS, JS, Bilder, Töne, Schriften und WASM.`);
    return { p, junk: false };
  }

  /**
   * Add one file to a version that is still being uploaded.
   * Checks name, type, size, file count, version size and the owner's quota.
   * Returns false if the file was skipped as junk.
   */
  function addFile(version, ownerId, rawPath, buffer) {
    const { p, junk } = versionFileName(rawPath);
    if (junk) return false;
    // Checked again now that the body is complete (it may have taken minutes). Meanwhile the version
    // may be gone (with its app, or its owner's account), or finished - and perhaps approved since: it
    // never takes another file. From here to the INSERT below nothing else runs, so check and write
    // are one step.
    const state = db.get('SELECT status FROM app_versions WHERE id = ?', version.id);
    if (!state) throw gone();
    if (state.status !== 'uploading') throw fail('Diese Version ist schon fertig und ändert sich nicht mehr. Lade die Datei in eine neue Version hoch.');
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

  // ---------- editor drafts ----------
  // One mutable draft per app, private to the owner. Files are validated
  // exactly like uploaded files; unlike a version, a draft file may be
  // replaced. Versions made from a draft copy its rows (see services.js).

  function ensureDraft(app, basedOnVersionId = null) {
    db.run('INSERT OR IGNORE INTO app_drafts (app_id, based_on_version_id, created_at, updated_at) VALUES (?, ?, ?, ?)', app.id, basedOnVersionId, Date.now(), Date.now());
  }

  /** The name of a draft file: normalised, not hidden, of an allowed type. */
  function draftFileName(rawPath) {
    const p = normalizePath(rawPath);
    if (isJunk(p)) throw fail(`Versteckte Dateien und Ordner wie "${p.slice(0, 80)}" sind im Editor nicht möglich.`);
    if (!types[extOf(p)]) throw fail(`Der Dateityp von "${p.slice(0, 80)}" ist nicht erlaubt.`);
    return p;
  }

  /**
   * Create or replace one draft file. Returns the normalised path.
   * moving: the stored file this one is renamed from - the caller removes it in the same
   * transaction, so it frees its place and its bytes (a rename at a limit adds nothing).
   */
  function putDraftFile(app, rawPath, buffer, { moving = null } = {}) {
    const p = draftFileName(rawPath);
    if (buffer.length > L.maxFileBytes) throw fail(`"${p.slice(0, 80)}" ist zu groß (maximal ${Math.round(L.maxFileBytes / 1048576)} MB pro Datei).`);
    const saved = db.tx(() => {
      // As with versions: the app (and its owner's account) may be gone by the time the body is read.
      if (!db.get('SELECT 1 AS ok FROM apps WHERE id = ?', app.id)) throw gone();
      ensureDraft(app);
      const old = db.get('SELECT path, size, sha256 FROM draft_files WHERE app_id = ? AND path_lower = ?', app.id, p.toLowerCase());
      // A rename that only changes upper/lower case replaces `old` itself: nothing extra is freed.
      const away = moving && (!old || old.path !== moving.path) ? moving : null;
      const freed = (old ? old.size : 0) + (away ? away.size : 0);
      const now = db.get('SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM draft_files WHERE app_id = ?', app.id);
      const files = now.files + (old ? 0 : 1) - (away ? 1 : 0);
      const bytes = now.bytes - freed + buffer.length;
      if (files > L.maxFiles) throw fail(`Zu viele Dateien (maximal ${L.maxFiles}).`);
      if (bytes > L.maxVersionBytes) throw fail(`Die App ist zu groß (maximal ${Math.round(L.maxVersionBytes / 1048576)} MB).`);
      if (userBytes(app.owner_id) - freed + buffer.length > L.maxUserBytes) throw fail('Der Speicherplatz dieses Kontos ist voll. Lösche alte Versionen, um Platz zu schaffen.');
      const sha = writeBlob(buffer);
      if (old) db.run('DELETE FROM draft_files WHERE app_id = ? AND path = ?', app.id, old.path);
      db.run('INSERT INTO draft_files (app_id, path, path_lower, size, sha256) VALUES (?, ?, ?, ?, ?)', app.id, p, p.toLowerCase(), buffer.length, sha);
      db.run('UPDATE app_drafts SET updated_at = ? WHERE app_id = ?', Date.now(), app.id);
      return { p, freed: old && old.sha256 !== sha ? old.sha256 : null };
    }, { durable: true });
    // After the commit, never inside the transaction: a rolled-back write must still find its file.
    if (saved.freed) collectGarbage([saved.freed]);
    return saved.p;
  }

  function deleteDraftFile(app, rawPath) {
    const p = normalizePath(rawPath, { lookup: true }); // finds a stored name, even one from before a naming rule
    const old = db.get('SELECT sha256 FROM draft_files WHERE app_id = ? AND path = ?', app.id, p);
    if (!old) return false;
    db.tx(() => {
      db.run('DELETE FROM draft_files WHERE app_id = ? AND path = ?', app.id, p);
      db.run('UPDATE app_drafts SET updated_at = ? WHERE app_id = ?', Date.now(), app.id);
    }, { durable: true });
    collectGarbage([old.sha256]);
    return true;
  }

  /** Start (or restart) the draft as a copy of one version. Blobs are shared, nothing is copied on disk. */
  function draftFromVersion(app, version) {
    const old = db.all('SELECT sha256 FROM draft_files WHERE app_id = ?', app.id).map((r) => r.sha256);
    db.tx(() => {
      db.run('DELETE FROM app_drafts WHERE app_id = ?', app.id);
      ensureDraft(app, version ? version.id : null);
      if (version) {
        db.run('INSERT INTO draft_files (app_id, path, path_lower, size, sha256) SELECT ?, path, path_lower, size, sha256 FROM app_files WHERE version_id = ?', app.id, version.id);
      }
    }, { durable: true });
    collectGarbage(old);
  }

  function deleteDraft(app) {
    const old = db.all('SELECT sha256 FROM draft_files WHERE app_id = ?', app.id).map((r) => r.sha256);
    db.tx(() => db.run('DELETE FROM app_drafts WHERE app_id = ?', app.id), { durable: true });
    collectGarbage(old);
  }

  const listDraftFiles = (appId) => db.all('SELECT path, size, sha256 FROM draft_files WHERE app_id = ? ORDER BY path_lower', appId);
  const findDraftFile = (appId, p) => db.get('SELECT path, size, sha256 FROM draft_files WHERE app_id = ? AND path = ?', appId, p);

  // ---------- before a file body is read ----------
  // A folder upload (one PUT per file) and an editor save read the body into
  // memory; only then can addFile or putDraftFile check it. So BEFORE it is
  // read: the body must declare its size (Content-Length; chunked bodies are
  // refused), and that size must fit the file limit, what is left of the
  // version or draft and of the owner's account - counting the bodies that are
  // being read at this moment - and one person reads at most
  // L.parallelUploads bodies at a time. The routes answer a refusal without
  // reading and close the connection. The checks after reading stay in force.

  const reading = new Map(); // 'person:<id>' | 'owner:<id>' | 'into:<version or draft>' -> { n, bytes } being read now
  const inFlight = (key) => reading.get(key) || { n: 0, bytes: 0 };
  function track(keys, n, bytes) {
    for (const key of keys) {
      const r = inFlight(key);
      if (r.n + n > 0) reading.set(key, { n: r.n + n, bytes: r.bytes + bytes });
      else reading.delete(key);
    }
  }
  const mb = (n) => Math.round(n / 1048576);

  /**
   * Admit one body before it is read, or throw (400, 411, 413, 429).
   * into: { key, files, bytes } - what the version or draft holds now; null for
   * a file that is skipped anyway (junk). old: the stored file this body
   * replaces, or null. The admission ends when the response is finished or the
   * connection closes.
   */
  function admitBody(req, res, { person, owner, name, into, old = null, maxBytes = L.maxFileBytes, tooLarge = null, bucket = 'person', limit = L.parallelUploads, busy = null, pooled = false }) {
    const length = req.headers['content-length'];
    if (req.headers['transfer-encoding'] !== undefined || typeof length !== 'string' || !/^\d{1,15}$/.test(length)) {
      throw new HttpError(411, 'Beim Hochladen fehlt die Größe der Datei. Lade die Seite neu und versuche es noch einmal.');
    }
    const size = Number(length);
    if (size > maxBytes) throw new HttpError(413, tooLarge || `"${name.slice(0, 80)}" ist zu groß (maximal ${mb(maxBytes)} MB pro Datei).`);
    if (into) {
      const busy = inFlight(`into:${into.key}`);
      const freed = old ? old.size : 0;
      if (!old && into.files + busy.n + 1 > L.maxFiles) throw fail(`Zu viele Dateien (maximal ${L.maxFiles}).`);
      if (into.bytes - freed + busy.bytes + size > L.maxVersionBytes) throw new HttpError(413, `Die App ist zu groß (maximal ${mb(L.maxVersionBytes)} MB).`);
      if (userBytes(owner) - freed + inFlight(`owner:${owner}`).bytes + size > L.maxUserBytes) {
        throw new HttpError(413, 'Der Speicherplatz dieses Kontos ist voll. Lösche alte Versionen, um Platz zu schaffen.');
      }
    }
    // bucket 'person': every upload body of a person (folder, editor, ZIP, hub.files) shares
    // L.parallelUploads places; other buckets (the SDK data API) have their own limit.
    if (inFlight(`${bucket}:${person}`).n >= limit) {
      throw new HttpError(429, busy || `Du lädst gerade schon ${limit} Dateien gleichzeitig hoch. Warte, bis eine davon fertig ist, und versuche es dann noch einmal.`);
    }
    // Big file bodies (version and editor files over 1 MB, up to 25 MB each) held in memory right now, by
    // everybody together, are capped (L.uploadMemoryBytes) so that a class uploading big files at once cannot
    // take the server's memory; one person gets at most a quarter of it. Everything up to 1 MB never counts -
    // SDK calls, hub.files, ordinary editor saves and app files: those are never refused because others upload.
    // A ZIP goes to a temp file. Several people sending big files slowly together (each at the minimum rate)
    // can still make other BIG uploads wait - the Hub's uploader keeps trying for up to ten minutes.
    if (pooled && size > L.pooledBodyBytes) {
      if (inFlight(`pool:${person}`).bytes + size > L.uploadMemoryBytes / 4) {
        throw new HttpError(429, 'Du lädst gerade viele große Dateien gleichzeitig hoch. Warte, bis eine davon fertig ist.');
      }
      if (inFlight('pool').bytes + size > L.uploadMemoryBytes) {
        throw new HttpError(429, 'Gerade werden sehr viele Dateien hochgeladen. Bitte versuche es in einem Moment noch einmal.');
      }
    }
    const inPool = pooled && size > L.pooledBodyBytes;
    const keys = [...(into ? [`${bucket}:${person}`, `owner:${owner}`, `into:${into.key}`] : [`${bucket}:${person}`]), ...(inPool ? ['pool', `pool:${person}`] : [])];
    track(keys, 1, size);
    if (inPool) watchRate(req, res, size);
    let held = true;
    const release = () => {
      if (!held) return;
      held = false;
      track(keys, -1, -size);
    };
    res.once('finish', release);
    res.once('close', release);
    req.once('error', release);
  }

  /**
   * A pooled body that crawls in would hold its place for up to the request timeout (10 minutes): after
   * 20 seconds it must have come at L.minUploadRate on average (the slowest school Wi-Fi manages that),
   * otherwise the connection is cut and the place freed. Counts the socket's bytes - never reads the body.
   */
  function watchRate(req, res, size) {
    const socket = req.socket;
    if (!socket) return;
    const startedAt = Date.now();
    const startBytes = socket.bytesRead;
    const timer = setInterval(() => {
      const seconds = (Date.now() - startedAt) / 1000;
      const got = socket.bytesRead - startBytes;
      if (got >= size) return clearInterval(timer);
      if (seconds >= 20 && got < seconds * L.minUploadRate) {
        clearInterval(timer);
        req.destroy();
      }
    }, 5000);
    timer.unref();
    const stop = () => clearInterval(timer);
    req.once('end', stop);
    res.once('finish', stop);
    res.once('close', stop);
  }

  /** Before the body of one file for a version that is being uploaded is read (see admitBody). */
  function admitVersionFile(req, res, version, ownerId, personId, rawPath) {
    const { p, junk } = versionFileName(rawPath);
    const into = junk ? null : { key: `version:${version.id}`, ...db.get('SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM app_files WHERE version_id = ?', version.id) };
    admitBody(req, res, { person: personId, owner: ownerId, name: p, into, pooled: true });
  }

  /** Before the body of one editor draft file is read (see admitBody). */
  function admitDraftFile(req, res, app, personId, rawPath) {
    const p = draftFileName(rawPath);
    const old = db.get('SELECT size FROM draft_files WHERE app_id = ? AND path_lower = ?', app.id, p.toLowerCase());
    const now = db.get('SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM draft_files WHERE app_id = ?', app.id);
    admitBody(req, res, { person: personId, owner: app.owner_id, name: p, into: { key: `draft:${app.id}`, files: now.files, bytes: now.bytes }, old, pooled: true });
  }

  // ---------- reading ----------

  const listFiles = (versionId) => db.all('SELECT path, size, sha256 FROM app_files WHERE version_id = ? ORDER BY path_lower', versionId);
  const findFile = (versionId, p) => db.get('SELECT path, size, sha256 FROM app_files WHERE version_id = ? AND path = ?', versionId, p);
  const readBlob = (sha) => fs.readFileSync(blobPath(sha));

  /**
   * Stream a zip download (written by hand to avoid a dependency). Each entry is
   * { path, sha256 } (an app file), { path, file } (a file the server chose on
   * disk, e.g. for backups) or { path, data } (a Buffer). Compression runs off
   * the main thread and the response's back-pressure is respected, so a large
   * download does not block the Hub.
   */
  async function writeZip(res, files) {
    const central = [];
    let offset = 0;
    const deflate = (buf) => new Promise((resolve, reject) => zlib.deflateRaw(buf, (err, out) => (err ? reject(err) : resolve(out))));
    // Wait for 'drain' - or for the connection to close (a cancelled download must not hang here forever).
    const write = (chunk) =>
      res.destroyed || res.write(chunk)
        ? Promise.resolve()
        : new Promise((resolve) => {
            const done = () => {
              res.off('drain', done);
              res.off('close', done);
              resolve();
            };
            res.once('drain', done);
            res.once('close', done);
          });
    // A file on disk (the backup: database copy and content files) is streamed: read, deflated and sent
    // piece by piece, its checksum and sizes follow in a data descriptor (flag bit 3). Never in memory as
    // a whole - a database copy of hundreds of MB (or more than 2 GiB, which readFile refuses) included.
    async function streamed(f, name) {
      const head = Buffer.alloc(30);
      head.writeUInt32LE(0x04034b50, 0);
      head.writeUInt16LE(20, 4);
      head.writeUInt16LE(0x0808, 6); // UTF-8 names, sizes and checksum after the data
      head.writeUInt16LE(8, 8); // deflate
      head.writeUInt32LE(0x00210000, 10); // fixed date 1980-01-01
      head.writeUInt16LE(name.length, 26);
      await write(head);
      await write(name);
      let crc = 0;
      let size = 0;
      let packedSize = 0;
      const source = fs.createReadStream(f.file);
      const deflater = zlib.createDeflateRaw();
      source.on('data', (chunk) => {
        crc = zlib.crc32(chunk, crc);
        size += chunk.length;
      });
      source.on('error', (err) => deflater.destroy(err));
      source.pipe(deflater);
      for await (const chunk of deflater) {
        if (res.destroyed) {
          source.destroy();
          deflater.destroy();
          return null;
        }
        packedSize += chunk.length;
        await write(chunk);
      }
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc >>> 0, 4);
      descriptor.writeUInt32LE(packedSize, 8);
      descriptor.writeUInt32LE(size, 12);
      await write(descriptor);
      head.writeUInt32LE(crc >>> 0, 14); // for the central directory entry
      head.writeUInt32LE(packedSize, 18);
      head.writeUInt32LE(size, 22);
      return { head, length: 30 + name.length + packedSize + 16 };
    }

    for (const f of files) {
      if (res.destroyed) return;
      if (f.file) {
        const name = Buffer.from(f.path, 'utf8');
        const done = await streamed(f, name);
        if (!done || res.destroyed) return;
        const entry = Buffer.alloc(46);
        entry.writeUInt32LE(0x02014b50, 0);
        entry.writeUInt16LE(20, 4);
        entry.writeUInt16LE(20, 6);
        done.head.copy(entry, 8, 6, 30); // flags .. name length, with the real checksum and sizes
        entry.writeUInt32LE(offset, 42);
        central.push(entry, name);
        offset += done.length;
        continue;
      }
      const data = f.data ? f.data : await fs.promises.readFile(blobPath(f.sha256));
      const packed = await deflate(data);
      if (res.destroyed) return;
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
      await write(head);
      await write(name);
      await write(packed);
      if (res.destroyed) return;
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
    await write(dir);
    res.end(end);
  }

  return {
    addFile, addZip, addDirectory, receiveToTemp, collectGarbage, sweep, listFiles, findFile, readBlob, blobPath, contentType, isTextFile, writeZip, userBytes,
    putDraftFile, deleteDraftFile, draftFromVersion, deleteDraft, listDraftFiles, findDraftFile, isAllowedPath: (p) => Boolean(types[extOf(p)]),
    admitVersionFile, admitDraftFile, admitBody,
  };
}

module.exports = { createUploads, normalizePath, isJunk, extOf };
