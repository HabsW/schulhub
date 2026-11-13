'use strict';
// Backups and restores.
//
// A backup is ONE zip file with exactly these entries and nothing else:
//   hub.sqlite                  a consistent copy of the database (VACUUM INTO)
//   blobs/<xx>/<sha256>         app code (versions and editor drafts)
//   userfiles/<xx>/<sha256>     files apps saved for people (hub.files)
// Secrets are never part of it (SESSION_SECRET lives in .env, data/dev-secret
// only in the local test mode).
//
// Creating one (admin only, POST /admin/sicherung): the content files are
// pinned with hard links in data/tmp, the database is copied with VACUUM INTO,
// then files that arrived meanwhile are pinned too. Garbage collection while
// the download runs can therefore never remove a file the copy refers to.
// Everything temporary is removed afterwards (and data/tmp is emptied at every
// start of the Hub anyway).
//
// Restoring (scripts/restore.js, command line only, with the Hub stopped):
// every entry is checked BEFORE anything is written - only the three name
// shapes above, regular files only, bounded sizes, enough free disk space.
// Files are unpacked into a staging folder inside the data folder, every
// content hash is verified, the database is checked (SQLite header,
// quick_check, schema version, no triggers or views), and only then is
// everything moved into place. Nothing from an archive is ever executed.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const yauzl = require('yauzl');
const { DatabaseSync } = require('node:sqlite');
const { schemaForVersion, SCHEMA_VERSION } = require('./db');
const dbJobs = require('./dbJobs');
const { HttpError, plural } = require('./util');

const STORES = ['blobs', 'userfiles'];
const ENTRY = /^(?:hub\.sqlite|(blobs|userfiles)\/([0-9a-f]{2})\/([0-9a-f]{64}))$/;
/** One of the three allowed entry names (the folder must match the start of the hash). */
function isEntryName(name) {
  const m = ENTRY.exec(name);
  return Boolean(m) && (!m[1] || m[3].startsWith(m[2]));
}

// uploads.writeZip writes classic zip (no ZIP64): stay clearly below its limits.
const ZIP_MAX_ENTRIES = 65_000;
const ZIP_MAX_BYTES = 3.5 * 1024 ** 3;
// Bounds for archives being restored.
const RESTORE_MAX = { db: 16 * 1024 ** 3, blobs: 1024 ** 3, userfiles: 64 * 1024 ** 2, entries: 1_000_000, reserve: 256 * 1024 ** 2 };

const LAST_BACKUP_KEY = 'backup.lastAt';

// --------------------------------------------------------------- shared

/** Content files of one store folder (<root>/<xx>/<sha256>), well-formed names only. */
async function listStore(root) {
  let dirs;
  try {
    dirs = await fsp.readdir(root, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const d of dirs) {
    if (!d.isDirectory() || !/^[0-9a-f]{2}$/.test(d.name)) continue;
    for (const f of await fsp.readdir(path.join(root, d.name), { withFileTypes: true })) {
      if (f.isFile() && /^[0-9a-f]{64}$/.test(f.name) && f.name.startsWith(d.name)) out.push(`${d.name}/${f.name}`);
    }
  }
  return out.sort();
}

const statSize = async (file) => {
  try {
    return (await fsp.stat(file)).size;
  } catch {
    return 0;
  }
};

let statsCache = null;
/**
 * Disk usage of the data folder: database (+ WAL), app code, user files.
 * Cached for a minute: the admin overview should not walk the disk on every view.
 */
async function storeStats(dataDir, { fresh = false } = {}) {
  if (!fresh && statsCache && statsCache.dir === dataDir && Date.now() - statsCache.at < 60_000) return statsCache.value;
  const value = { db: 0 };
  for (const name of ['hub.sqlite', 'hub.sqlite-wal', 'hub.sqlite-shm']) value.db += await statSize(path.join(dataDir, name));
  for (const store of STORES) {
    const files = await listStore(path.join(dataDir, store));
    let bytes = 0;
    for (const rel of files) bytes += await statSize(path.join(dataDir, store, rel));
    value[store] = { files: files.length, bytes };
  }
  statsCache = { dir: dataDir, at: Date.now(), value };
  return value;
}

/** When the last backup was downloaded completely (ms), or null. */
function lastBackupAt(db) {
  const row = db.get('SELECT value FROM hub_settings WHERE key = ?', LAST_BACKUP_KEY);
  try {
    const v = row ? JSON.parse(row.value) : null;
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}
/** Direct upsert: settings.set only knows the retention keys. */
function setLastBackupAt(db, ts) {
  db.run(
    'INSERT INTO hub_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    LAST_BACKUP_KEY, JSON.stringify(ts), ts
  );
}

// --------------------------------------------------------------- backup

/** Content files are not deleted while a backup copies the database (see app.js, ctx.gcHold). */
function holdGarbage(ctx) {
  if (ctx.gcHold) ctx.gcHold.count++;
}
function releaseGarbage(ctx) {
  const hold = ctx.gcHold;
  if (!hold || --hold.count > 0) return;
  const blobs = [...hold.blobs];
  const userfiles = [...hold.userfiles];
  hold.blobs.clear();
  hold.userfiles.clear();
  if (blobs.length && ctx.uploads) ctx.uploads.collectGarbage(blobs);
  if (userfiles.length && ctx.userFiles) ctx.userFiles.collectGarbage(userfiles);
}

/** Hard-link (or, where links are impossible, copy) every content file not pinned yet. */
async function pinStore(store, src, dst, pinned) {
  for (const rel of await listStore(src)) {
    const key = `${store}/${rel}`;
    if (pinned.has(key)) continue;
    const from = path.join(src, rel);
    const to = path.join(dst, rel);
    await fsp.mkdir(path.dirname(to), { recursive: true });
    try {
      await fsp.link(from, to);
    } catch (err) {
      if (err.code === 'ENOENT') continue; // removed meanwhile: nothing refers to it any more
      if (err.code !== 'EEXIST') {
        try {
          await fsp.copyFile(from, to);
        } catch (e) {
          if (e.code === 'ENOENT') continue;
          throw e;
        }
      }
    }
    pinned.add(key);
  }
}

/**
 * Prepare a backup. Returns { entries, bytes, counts, cleanup } where entries
 * are { path, file } items for uploads.writeZip. Call cleanup() when done
 * (it may be called more than once).
 */
async function createBackup(ctx) {
  const { db, config } = ctx;
  const tmpRoot = path.join(config.dataDir, 'tmp');
  await fsp.mkdir(tmpRoot, { recursive: true });
  const dir = await fsp.mkdtemp(path.join(tmpRoot, 'sicherung-'));
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    fs.rmSync(dir, { recursive: true, force: true });
  };
  try {
    const pinned = new Set();
    const pinAll = async () => {
      for (const store of STORES) await pinStore(store, path.join(config.dataDir, store), path.join(dir, store), pinned);
    };
    // No content file is deleted from step 1 until step 3 is done: the copy of step 2 may refer to
    // a file that arrives after step 1 and goes again before step 3 (deletions wait, see gcHold).
    holdGarbage(ctx);
    try {
      await pinAll(); // 1. the files that exist now
      await dbJobs.snapshot(db.file, path.join(dir, 'hub.sqlite')); // 2. the database at one moment, in a worker thread
      await pinAll(); // 3. files that arrived while copying
    } finally {
      releaseGarbage(ctx);
    }

    const keys = [...pinned].sort();
    const entries = [{ path: 'hub.sqlite', file: path.join(dir, 'hub.sqlite') }, ...keys.map((k) => ({ path: k, file: path.join(dir, k) }))];
    let bytes = 0;
    for (const e of entries) bytes += await statSize(e.file);
    if (entries.length > ZIP_MAX_ENTRIES || bytes > ZIP_MAX_BYTES) {
      throw new HttpError(413, 'Die Daten sind zu groß für eine Sicherung über den Browser. Sichere stattdessen den Ordner „data“ direkt auf dem Server (siehe Anleitung auf dieser Seite).');
    }
    const counts = { blobs: keys.filter((k) => k.startsWith('blobs/')).length, userfiles: keys.filter((k) => k.startsWith('userfiles/')).length };
    return { entries, bytes, counts, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

// -------------------------------------------------------------- restore

class RestoreError extends Error {}
const fail = (message) => {
  throw new RestoreError(message);
};

const openZip = (file) => yauzl.openPromise(file, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true, autoClose: false });
const shown = (name) => JSON.stringify(String(name).slice(0, 120));

/** Check one directory entry. Returns { name, store, sha, size } or throws a RestoreError. */
function checkEntry(e, seen) {
  const name = e.fileName;
  if (!isEntryName(name)) fail(`Unerlaubter Eintrag im Archiv: ${shown(name)}. Erlaubt sind nur „hub.sqlite“, „blobs/…“ und „userfiles/…“ mit Prüfsummen als Namen.`);
  if (seen.has(name)) fail(`Der Eintrag ${shown(name)} kommt doppelt vor.`);
  if (e.isEncrypted()) fail('Verschlüsselte Archive werden nicht unterstützt.');
  // Unix file type in the upper bits of the external attributes: regular files only.
  const mode = (e.externalFileAttributes >>> 16) & 0o170000;
  if (mode !== 0 && mode !== 0o100000) fail(`${shown(name)} ist eine Verknüpfung oder Spezialdatei. Das ist nicht erlaubt.`);
  if (e.compressionMethod !== 0 && e.compressionMethod !== 8) fail(`${shown(name)} ist mit einem unbekannten Verfahren gepackt.`);
  const m = ENTRY.exec(name);
  const store = m[1] || 'db';
  if (e.uncompressedSize > RESTORE_MAX[store]) fail(`${shown(name)} ist zu groß.`);
  seen.add(name);
  return { name, store, sha: m[3] || null, size: e.uncompressedSize };
}

/** Read the archive's directory and check every entry - nothing is written. */
async function inspectArchive(zipFile) {
  let zip;
  try {
    zip = await openZip(zipFile);
  } catch {
    fail('Die Datei ist kein gültiges ZIP-Archiv.');
  }
  try {
    if (zip.entryCount > RESTORE_MAX.entries) fail('Das Archiv enthält zu viele Einträge.');
    const seen = new Set();
    const entries = [];
    await new Promise((resolve, reject) => {
      zip.on('error', (err) => reject(new RestoreError(`Das Archiv ist beschädigt oder enthält unerlaubte Pfade (${String(err.message).slice(0, 160)}).`)));
      zip.on('end', resolve);
      zip.on('entry', (e) => {
        try {
          entries.push(checkEntry(e, seen));
        } catch (err) {
          return reject(err);
        }
        zip.readEntry();
      });
      zip.readEntry();
    });
    if (!seen.has('hub.sqlite')) fail('Im Archiv fehlt die Datenbank (hub.sqlite).');
    return { entries, total: entries.reduce((n, e) => n + e.size, 0) };
  } finally {
    zip.close();
  }
}

/** Unpack into the staging folder, checking every entry again and verifying content hashes. */
async function extractArchive(zipFile, staging) {
  const zip = await openZip(zipFile);
  const written = new Set();
  try {
    const seen = new Set();
    await new Promise((resolve, reject) => {
      zip.on('error', (err) => reject(new RestoreError(`Das Archiv ist beschädigt (${String(err.message).slice(0, 160)}).`)));
      zip.on('end', resolve);
      zip.on('entry', (e) => {
        let info;
        try {
          info = checkEntry(e, seen);
        } catch (err) {
          return reject(err);
        }
        // The name matched ENTRY: plain hex segments, no "..", no absolute path.
        const target = path.join(staging, ...info.name.split('/'));
        if (!target.startsWith(staging + path.sep)) return reject(new RestoreError(`Unerlaubter Pfad ${shown(info.name)}.`));
        zip.openReadStream(e, (err, stream) => {
          if (err) return reject(new RestoreError(`${shown(info.name)} lässt sich nicht lesen.`));
          fs.mkdirSync(path.dirname(target), { recursive: true });
          const hash = crypto.createHash('sha256');
          let size = 0;
          const count = new Transform({
            transform(chunk, _enc, done) {
              size += chunk.length;
              if (size > RESTORE_MAX[info.store]) return done(new RestoreError(`${shown(info.name)} ist zu groß.`));
              hash.update(chunk);
              done(null, chunk);
            },
          });
          pipeline(stream, count, fs.createWriteStream(target, { flags: 'wx', mode: 0o640 })).then(
            () => {
              if (info.sha && hash.digest('hex') !== info.sha) {
                return reject(new RestoreError(`Die Prüfsumme von ${shown(info.name)} stimmt nicht: Der Inhalt wurde verändert oder ist beschädigt.`));
              }
              written.add(info.name);
              zip.readEntry();
            },
            (e2) => reject(e2 instanceof RestoreError ? e2 : new RestoreError(`${shown(info.name)} ließ sich nicht entpacken (${String(e2.message).slice(0, 160)}).`))
          );
        });
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
  if (!written.has('hub.sqlite')) fail('Im Archiv fehlt die Datenbank (hub.sqlite).');
  return written;
}

/** Schema SQL without comments (quoted parts are kept as they are). */
function stripSqlComments(sql) {
  const s = String(sql ?? '');
  let out = '';
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      let j = i + 1;
      while (j < s.length && !(s[j] === close && s[j + 1] !== close)) j += s[j] === close ? 2 : 1;
      out += s.slice(i, j + 1);
      i = j + 1;
    } else if (c === '-' && s[i + 1] === '-') {
      const nl = s.indexOf('\n', i);
      i = nl < 0 ? s.length : nl + 1;
      out += ' ';
    } else if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      i = end < 0 ? s.length : end + 2;
      out += ' ';
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** What a schema entry really creates, read from its SQL (SQLite trusts the SQL, not the type column). */
function createKind(sql) {
  const m = /^CREATE\s+(?:(?:TEMP|TEMPORARY)\s+)?(?:UNIQUE\s+)?(TABLE|INDEX|TRIGGER|VIEW|VIRTUAL\s+TABLE)\b/i.exec(stripSqlComments(sql).trim());
  return m ? m[1].toLowerCase().replace(/\s+/, ' ') : '';
}

/** One schema as a map "type name" -> { table, sql }; SQL compared without comments, whitespace and identifier quotes. */
function schemaMap(rows) {
  const map = new Map();
  for (const r of rows) {
    if (/^sqlite_stat[1-4]$/.test(r.name)) continue; // statistics written by ANALYZE
    const sql = r.sql === null || r.sql === undefined ? null : stripSqlComments(r.sql).replace(/[\s"`[\]]+/g, '');
    map.set(`${String(r.type).toLowerCase()} ${r.name}`, { table: r.tbl_name, sql });
  }
  return map;
}

/** The schema SchulHub itself creates for a database version (src/db.js builds it fresh in dir). */
function referenceSchema(version, dir) {
  if (!Number.isInteger(version) || version < 1 || version > SCHEMA_VERSION) {
    return fail(`Eine Datenbank der Version ${version} kann dieser Hub nicht prüfen.`);
  }
  return schemaForVersion(version, path.join(dir, `referenz-${version}.sqlite`));
}

/**
 * The database must have exactly the structure SchulHub creates for its
 * version: no triggers, views or virtual tables (whatever the type column
 * claims - SQLite runs what the SQL says), no extra or missing tables,
 * columns, constraints or indexes.
 */
function checkSchema(db, version, dir) {
  const rows = db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master').all();
  for (const r of rows) {
    const type = String(r.type).toLowerCase();
    const kind = createKind(r.sql);
    const name = `„${String(r.name).slice(0, 60)}“`;
    if (type === 'view' || kind === 'view') fail(`Die Datenbank enthält eine Sicht (${name}), die SchulHub nie anlegt. Sie wird nicht übernommen.`);
    if (type === 'trigger' || kind === 'trigger') fail(`Die Datenbank enthält einen Trigger (${name}), den SchulHub nie anlegt. Sie wird nicht übernommen.`);
    if (kind === 'virtual table') fail(`Die Datenbank enthält eine virtuelle Tabelle (${name}), die SchulHub nie anlegt. Sie wird nicht übernommen.`);
    if (r.sql !== null && r.sql !== undefined && kind !== type) fail(`Der Eintrag ${name} im Aufbau der Datenbank ist widersprüchlich. Sie wird nicht übernommen.`);
  }
  const have = schemaMap(rows);
  const want = schemaMap(referenceSchema(version, dir));
  for (const [key, v] of have) {
    const w = want.get(key);
    const name = `„${key.slice(key.indexOf(' ') + 1, key.indexOf(' ') + 61)}“`;
    if (!w) fail(`Der Aufbau der Datenbank passt nicht zu SchulHub (Version ${version}): ${name} gehört nicht dazu. Sie wird nicht übernommen.`);
    if (w.table !== v.table || w.sql !== v.sql) fail(`Der Aufbau der Datenbank passt nicht zu SchulHub (Version ${version}): ${name} ist verändert. Sie wird nicht übernommen.`);
  }
  for (const key of want.keys()) {
    if (!have.has(key)) fail(`Der Aufbau der Datenbank passt nicht zu SchulHub (Version ${version}): „${key.slice(key.indexOf(' ') + 1)}“ fehlt. Sie wird nicht übernommen.`);
  }
}

/** Check the unpacked database; returns a summary. Opens it read-only; dir is for the reference schema. */
function checkDatabase(file, written, dir) {
  const head = Buffer.alloc(16);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, head, 0, 16, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (head.toString('latin1') !== 'SQLite format 3\u0000') fail('hub.sqlite ist keine SQLite-Datenbank.');
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const has = (table) => Boolean(db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
    const check = db.prepare('PRAGMA quick_check').all().map((r) => String(Object.values(r)[0]));
    if (check.length !== 1 || check[0] !== 'ok') fail(`Die Datenbank in der Sicherung ist beschädigt: ${check.slice(0, 3).join('; ')}`);
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (!['users', 'classes', 'apps', 'app_versions', 'app_files', 'sessions'].every(has) || !Number.isInteger(version) || version < 1) {
      fail('hub.sqlite ist keine SchulHub-Datenbank.');
    }
    if (version > SCHEMA_VERSION) {
      fail(`Die Sicherung stammt von einer neueren SchulHub-Version (Datenbank-Version ${version}, dieser Hub kennt Version ${SCHEMA_VERSION}). Aktualisiere zuerst SchulHub.`);
    }
    // Exactly SchulHub's own structure: no triggers or views (also not behind a disguised type), nothing added or changed.
    checkSchema(db, version, dir);

    const count = (table) => (has(table) ? db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n : 0); // fixed names only
    const shas = (sql) => db.prepare(sql).all().map((r) => r.sha256);
    const code = shas(has('draft_files') ? 'SELECT sha256 FROM app_files UNION SELECT sha256 FROM draft_files' : 'SELECT DISTINCT sha256 FROM app_files');
    const files = has('user_files') ? shas('SELECT DISTINCT sha256 FROM user_files') : [];
    const missing = {
      blobs: code.filter((s) => !written.has(`blobs/${String(s).slice(0, 2)}/${s}`)).length,
      userfiles: files.filter((s) => !written.has(`userfiles/${String(s).slice(0, 2)}/${s}`)).length,
    };
    return { version, users: count('users'), classes: count('classes'), apps: count('apps'), missing };
  } catch (err) {
    if (err instanceof RestoreError) throw err;
    fail(`hub.sqlite lässt sich nicht als Datenbank öffnen (${String(err.message).slice(0, 160)}).`);
  } finally {
    if (db) db.close();
  }
  return null;
}

const stampFmt = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin', dateStyle: 'short', timeStyle: 'medium' });
/** "2026-11-12-210610" in school time, like the names of backups. */
const stamp = (d = new Date()) => stampFmt.format(d).replace(' ', '-').replace(/:/g, '');
const HUB_DATA = ['hub.sqlite', 'hub.sqlite-wal', 'hub.sqlite-shm', 'hub.sqlite-journal', 'blobs', 'userfiles'];

/**
 * Restore a backup zip into a data folder.
 *   force: also when the folder is not empty; the Hub's current data is moved
 *          to data/vor-wiederherstellung-<time>/ (nothing is deleted).
 * Returns a summary; throws RestoreError with a German message.
 */
async function restoreBackup({ zipFile, dataDir, force = false, log = () => {} }) {
  let st;
  try {
    st = fs.statSync(zipFile);
  } catch {
    fail(`Die Datei ${shown(zipFile)} gibt es nicht.`);
  }
  if (!st.isFile()) fail(`${shown(zipFile)} ist keine Datei.`);
  fs.mkdirSync(dataDir, { recursive: true });
  // Leftovers of an interrupted restore are ours to remove.
  for (const n of fs.readdirSync(dataDir)) if (n.startsWith('.wiederherstellung-')) fs.rmSync(path.join(dataDir, n), { recursive: true, force: true });
  const present = fs.readdirSync(dataDir);
  if (present.length && !force) {
    fail(`Der Datenordner ${dataDir} ist nicht leer. Stoppe den Hub und starte die Wiederherstellung mit --force: Die vorhandenen Daten werden dann nach „vor-wiederherstellung-…“ verschoben, nicht gelöscht.`);
  }

  // 1. Check the whole archive before anything is written.
  const plan = await inspectArchive(zipFile);
  const counts = { blobs: plan.entries.filter((e) => e.store === 'blobs').length, userfiles: plan.entries.filter((e) => e.store === 'userfiles').length };
  log(`Archiv geprüft: Datenbank, ${plural(counts.blobs, 'App-Datei', 'App-Dateien')}, ${plural(counts.userfiles, 'Nutzerdatei', 'Nutzerdateien')}.`);
  const disk = fs.statfsSync(dataDir);
  if (plan.total > disk.bavail * disk.bsize - RESTORE_MAX.reserve) fail('Auf dem Laufwerk des Datenordners ist nicht genug Platz für diese Sicherung.');

  // 2. Unpack into a staging folder on the same disk, verify hashes and the database.
  const staging = fs.mkdtempSync(path.join(dataDir, '.wiederherstellung-'));
  try {
    const written = await extractArchive(zipFile, staging);
    log('Entpackt, alle Prüfsummen stimmen.');
    const dbFile = path.join(staging, 'hub.sqlite');
    const info = checkDatabase(dbFile, written, staging);
    log(`Datenbank geprüft (Version ${info.version}): ${plural(info.users, 'Konto', 'Konten')}, ${plural(info.classes, 'Klasse', 'Klassen')}, ${plural(info.apps, 'App', 'Apps')}.`);
    if (info.missing.blobs || info.missing.userfiles) {
      log(`Achtung: ${plural(info.missing.blobs, 'App-Datei', 'App-Dateien')} und ${plural(info.missing.userfiles, 'Nutzerdatei', 'Nutzerdateien')}, auf die die Datenbank verweist, fehlen in der Sicherung.`);
    }
    // Sessions from the time of the backup must not come back to life.
    const w = new DatabaseSync(dbFile);
    try {
      w.exec('DELETE FROM sessions;');
    } finally {
      w.close();
    }

    // 3. Move the current data aside (only with --force), then the restored data into place.
    let aside = null;
    const existing = HUB_DATA.filter((n) => fs.existsSync(path.join(dataDir, n)));
    if (existing.length) {
      aside = path.join(dataDir, `vor-wiederherstellung-${stamp()}`);
      fs.mkdirSync(aside);
      for (const n of existing) fs.renameSync(path.join(dataDir, n), path.join(aside, n));
    }
    fs.rmSync(path.join(dataDir, 'tmp'), { recursive: true, force: true });
    for (const store of STORES) {
      const from = path.join(staging, store);
      if (fs.existsSync(from)) fs.renameSync(from, path.join(dataDir, store));
      else fs.mkdirSync(path.join(dataDir, store), { recursive: true });
    }
    fs.renameSync(dbFile, path.join(dataDir, 'hub.sqlite'));
    return { ...info, ...counts, aside };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

module.exports = {
  holdGarbage, releaseGarbage,
  createBackup, restoreBackup, RestoreError, storeStats, lastBackupAt, setLastBackupAt, isEntryName, listStore,
  ZIP_MAX_ENTRIES, ZIP_MAX_BYTES,
};
