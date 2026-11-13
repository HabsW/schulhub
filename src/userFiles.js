'use strict';
// Files an app saves for ONE person through hub.files (drawings, exported
// JSON, small text). Stored like app files - content under its SHA-256 in
// data/userfiles/, names only as database rows - but kept apart from uploaded
// app code. Only a short allow-list of passive types exists, images must look
// like what they claim to be, and everything is served with a fixed type and
// nosniff, never rendered on the Hub's own origin.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { KEY } = require('./manifest');

const FILE_TYPES = {
  'image/png': (b) => b.length > 8 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG',
  'image/jpeg': (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => b.length > 6 && b.toString('latin1', 0, 4) === 'GIF8',
  'image/webp': (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
  'application/json': (b) => {
    try {
      JSON.parse(b.toString('utf8'));
      return true;
    } catch {
      return false;
    }
  },
  'text/plain': () => true,
  'text/csv': () => true,
};

class FileError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Validate name, type and content. Returns the canonical type. */
function checkFile(name, type, buffer, limits) {
  if (typeof name !== 'string' || !KEY.test(name)) throw new FileError('bad_key', 'Ungültiger Dateiname (erlaubt: Buchstaben, Ziffern, _ . : -, höchstens 64 Zeichen).');
  const t = String(type || '').split(';')[0].trim().toLowerCase();
  if (!Object.hasOwn(FILE_TYPES, t)) throw new FileError('bad_type', `Dieser Dateityp ist nicht erlaubt. Erlaubt: ${Object.keys(FILE_TYPES).join(', ')}.`);
  if (buffer.length > limits.fileBytes) throw new FileError('too_large', `Die Datei ist zu groß (höchstens ${Math.round(limits.fileBytes / 1024)} KB).`, 413);
  if (!FILE_TYPES[t](buffer)) throw new FileError('bad_type', 'Der Inhalt passt nicht zum Dateityp.');
  return t;
}

function createUserFiles(ctx) {
  const { db, config } = ctx;
  const L = config.limits;
  const dir = path.join(config.dataDir, 'userfiles');
  const tmp = path.join(config.dataDir, 'tmp');
  fs.mkdirSync(dir, { recursive: true });

  const blobPath = (sha) => {
    if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error('bad blob id');
    return path.join(dir, sha.slice(0, 2), sha);
  };
  function writeBlob(buffer) {
    const sha = crypto.createHash('sha256').update(buffer).digest('hex');
    const file = blobPath(sha);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const t = path.join(tmp, `uf-${crypto.randomBytes(8).toString('hex')}`);
      // On the disk before the database names it (see uploads.writeBlob).
      const fd = fs.openSync(t, 'w', 0o640);
      try {
        fs.writeFileSync(fd, buffer); // writes all of it (writeSync may write less, e.g. on a full disk)
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(t, file);
    }
    return sha;
  }
  /** Delete content no row references any more. */
  function collectGarbage(shas) {
    if (ctx.gcHold && ctx.gcHold.count > 0) {
      for (const sha of shas) ctx.gcHold.userfiles.add(sha);
      return;
    }
    const doomed = [...new Set(shas)].filter((sha) => !db.get('SELECT 1 AS used FROM user_files WHERE sha256 = ? LIMIT 1', sha));
    if (!doomed.length) return;
    // The transactions that free files are durable (see uploads.collectGarbage).
    for (const sha of doomed) fs.rmSync(blobPath(sha), { force: true });
  }

  /** At start: files no row refers to are removed - with the same guards as uploads.sweep. */
  function sweep() {
    if (db.createdNow) return 0;
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return 0;
    }
    const used = new Set(db.all('SELECT DISTINCT sha256 FROM user_files').map((r) => r.sha256));
    const candidates = [];
    let present = 0;
    for (const sub of entries) {
      if (!/^[0-9a-f]{2}$/.test(sub)) continue;
      for (const name of fs.readdirSync(path.join(dir, sub))) {
        if (!/^[0-9a-f]{64}$/.test(name) || !name.startsWith(sub)) continue;
        present++;
        if (!used.has(name)) candidates.push(path.join(dir, sub, name));
      }
    }
    if (present && !used.size) return 0; // files, but a database that names none of them
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

  const usage = (appId, userId, exceptName = '') =>
    db.get('SELECT COALESCE(SUM(size), 0) AS bytes, COUNT(*) AS n FROM user_files WHERE app_id = ? AND user_id = ? AND name <> ?', appId, userId, exceptName);

  return {
    blobPath,
    collectGarbage,
    sweep,
    usage,
    list: (appId, userId) => db.all('SELECT name, type, size, updated_at FROM user_files WHERE app_id = ? AND user_id = ? ORDER BY name', appId, userId),
    get: (appId, userId, name) => db.get('SELECT name, type, size, sha256, updated_at FROM user_files WHERE app_id = ? AND user_id = ? AND name = ?', appId, userId, name),
    read: (row) => fs.readFileSync(blobPath(row.sha256)),
    put(appId, userId, name, type, buffer) {
      const t = checkFile(name, type, buffer, L);
      const other = usage(appId, userId, name);
      const account = db.get('SELECT COALESCE(SUM(size), 0) AS bytes FROM user_files WHERE user_id = ? AND NOT (app_id = ? AND name = ?)', userId, appId, name).bytes;
      if (account + buffer.length > L.fileAccountBytes) throw new FileError('quota', `Dein Platz für Dateien ist voll (höchstens ${Math.round(L.fileAccountBytes / 1048576)} MB in allen Apps zusammen).`);
      if (other.n >= L.filesPerApp || other.bytes + buffer.length > L.fileTotalBytes) {
        throw new FileError('quota', `Dein Platz für Dateien in dieser App ist voll (höchstens ${L.filesPerApp} Dateien, ${Math.round(L.fileTotalBytes / 1048576)} MB).`);
      }
      const old = db.get('SELECT sha256 FROM user_files WHERE app_id = ? AND user_id = ? AND name = ?', appId, userId, name);
      const sha = writeBlob(buffer);
      // Durable when it replaces a file: the old content is deleted right after (see collectGarbage).
      db.tx(() => db.run(
        `INSERT INTO user_files (app_id, user_id, name, type, size, sha256, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (app_id, user_id, name) DO UPDATE SET type = excluded.type, size = excluded.size, sha256 = excluded.sha256, updated_at = excluded.updated_at`,
        appId, userId, name, t, buffer.length, sha, Date.now()
      ), { durable: Boolean(old && old.sha256 !== sha) });
      if (old && old.sha256 !== sha) collectGarbage([old.sha256]);
      return { name, type: t, size: buffer.length };
    },
    remove(appId, userId, name) {
      const old = db.get('SELECT sha256 FROM user_files WHERE app_id = ? AND user_id = ? AND name = ?', appId, userId, name);
      if (!old) return false;
      db.tx(() => db.run('DELETE FROM user_files WHERE app_id = ? AND user_id = ? AND name = ?', appId, userId, name), { durable: true });
      collectGarbage([old.sha256]);
      return true;
    },
    // Content hashes, collected BEFORE rows go away (deletes and cascades), garbage-collected after.
    shasOfUser: (userId) => db.all('SELECT DISTINCT sha256 FROM user_files WHERE user_id = ?', userId).map((r) => r.sha256),
    shasOfApp: (appId) => db.all('SELECT DISTINCT sha256 FROM user_files WHERE app_id = ?', appId).map((r) => r.sha256),
    shasOfAppUser: (appId, userId) => db.all('SELECT DISTINCT sha256 FROM user_files WHERE app_id = ? AND user_id = ?', appId, userId).map((r) => r.sha256),
  };
}

module.exports = { createUserFiles, checkFile, FileError, FILE_TYPES };
