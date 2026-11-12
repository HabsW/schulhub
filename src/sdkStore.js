'use strict';
// Storage behind the SDK. The method table in appsHost.js decides WHAT a caller
// may do; a store only keeps the data. There are two kinds:
//
//   live     the real tables, always keyed by app (and user or class).
//   preview  memory only. A preview (an owner trying a version, a teacher
//            reviewing a submission) must never write real saves, scores,
//            results or shared data, and must never show up in anyone's
//            results. Reads of shared and class data fall through to the real
//            tables, so a teacher can preview an app with the class's real word
//            list; every write stays in memory and disappears after a while.
//
// Both stores offer exactly the same functions, so every SDK feature gets the
// preview isolation for free.

const { checkFile, FileError } = require('./userFiles');

class ApiError extends Error {
  constructor(code, message, status = 200) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const MB = 1024 * 1024;

/** The real tables. Every query is limited to this app (and this user where personal). */
function liveStore(db, appRow, user, { userFiles } = {}) {
  const A = appRow.id;
  const U = user.id;
  return {
    preview: false,

    // ----- per person ("save") -----
    saveGet: (key) => db.get('SELECT value FROM saves WHERE app_id = ? AND user_id = ? AND key = ?', A, U, key)?.value ?? null,
    saveKeys: () => db.all('SELECT key FROM saves WHERE app_id = ? AND user_id = ? ORDER BY key', A, U).map((r) => r.key),
    saveUsage: (exceptKey) => db.get('SELECT COALESCE(SUM(size), 0) AS bytes, COUNT(*) AS n FROM saves WHERE app_id = ? AND user_id = ? AND key <> ?', A, U, exceptKey),
    savePut: (key, json, size) =>
      db.run(
        `INSERT INTO saves (app_id, user_id, key, value, size, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (app_id, user_id, key) DO UPDATE SET value = excluded.value, size = excluded.size, updated_at = excluded.updated_at`,
        A, U, key, json, size, Date.now()
      ),
    saveDelete: (key) => db.run('DELETE FROM saves WHERE app_id = ? AND user_id = ? AND key = ?', A, U, key),

    // ----- shared data: scope '' = whole app, otherwise a class id -----
    sharedGet: (scope, key) => db.get('SELECT value FROM shared_data WHERE app_id = ? AND class_id = ? AND key = ?', A, scope, key)?.value ?? null,
    sharedKeys: (scope) => db.all('SELECT key FROM shared_data WHERE app_id = ? AND class_id = ? ORDER BY key', A, scope).map((r) => r.key),
    sharedUsage: (scope, exceptKey) => db.get('SELECT COALESCE(SUM(size), 0) AS bytes, COUNT(*) AS n FROM shared_data WHERE app_id = ? AND class_id = ? AND key <> ?', A, scope, exceptKey),
    sharedPut: (scope, key, json, size) =>
      db.run(
        `INSERT INTO shared_data (app_id, class_id, key, value, size, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (app_id, class_id, key) DO UPDATE SET value = excluded.value, size = excluded.size, updated_at = excluded.updated_at`,
        A, scope, key, json, size, Date.now()
      ),
    sharedDelete: (scope, key) => db.run('DELETE FROM shared_data WHERE app_id = ? AND class_id = ? AND key = ?', A, scope, key),

    // ----- leaderboards -----
    scoreGet: (board) => db.get('SELECT score FROM scores WHERE app_id = ? AND board = ? AND user_id = ?', A, board, U)?.score ?? null,
    boardExists: (board) => Boolean(db.get('SELECT 1 AS x FROM scores WHERE app_id = ? AND board = ? LIMIT 1', A, board)),
    boardCount: () => db.get('SELECT COUNT(DISTINCT board) AS n FROM scores WHERE app_id = ?', A).n,
    scorePut: (board, score) =>
      db.run(
        `INSERT INTO scores (app_id, board, user_id, score, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (app_id, board, user_id) DO UPDATE SET score = excluded.score, updated_at = excluded.updated_at`,
        A, board, U, score, Date.now()
      ),
    /**
     * Best entries of one board. `sharesClass` says whether the entry's person
     * is in at least one class together with the caller: only then may the
     * caller see the name (see appsHost.js). order is a fixed keyword.
     */
    top: (board, { order, limit, classId }) =>
      db.all(
        `SELECT s.user_id, s.score, u.name, u.anonymous_scores,
                EXISTS (SELECT 1 FROM class_members mine
                          JOIN class_members theirs ON theirs.class_id = mine.class_id
                          JOIN classes c ON c.id = mine.class_id AND c.archived_at IS NULL
                         WHERE mine.user_id = ? AND theirs.user_id = s.user_id) AS shares_class
           FROM scores s JOIN users u ON u.id = s.user_id
          WHERE s.app_id = ? AND s.board = ?
            AND (? = '' OR s.user_id IN (SELECT user_id FROM class_members WHERE class_id = ?))
          ORDER BY s.score ${order === 'ASC' ? 'ASC' : 'DESC'}, s.updated_at ASC LIMIT ?`,
        U, A, board, classId || '', classId || '', limit
      ),

    // ----- results (the class the app was opened from is recorded with each one) -----
    resultAdd: ({ title, score, maxScore, details, classId }, keepNewest) => {
      db.run('INSERT INTO results (app_id, user_id, title, score, max_score, details, class_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', A, U, title, score, maxScore, details, classId || null, Date.now());
      db.run(
        `DELETE FROM results WHERE app_id = ? AND user_id = ? AND id NOT IN
           (SELECT id FROM results WHERE app_id = ? AND user_id = ? ORDER BY id DESC LIMIT ?)`,
        A, U, A, U, keepNewest
      );
    },
    resultsMine: (limit) =>
      db.all('SELECT title, score, max_score, details, created_at FROM results WHERE app_id = ? AND user_id = ? ORDER BY id DESC LIMIT ?', A, U, limit),

    // ----- progress (0..1) -----
    progressGet: () => db.get('SELECT value, label, updated_at FROM progress WHERE app_id = ? AND user_id = ?', A, U) || null,
    progressPut: (value, label) =>
      db.run(
        `INSERT INTO progress (app_id, user_id, value, label, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (app_id, user_id) DO UPDATE SET value = excluded.value, label = excluded.label, updated_at = excluded.updated_at`,
        A, U, value, label, Date.now()
      ),

    // ----- achievements (definitions come from the version's schulhub.json) -----
    achievementsUnlocked: () => db.all('SELECT achievement, unlocked_at FROM achievements WHERE app_id = ? AND user_id = ?', A, U),
    /** true if newly unlocked, false if it already was. */
    achievementPut: (id) => db.run('INSERT OR IGNORE INTO achievements (app_id, user_id, achievement, unlocked_at) VALUES (?, ?, ?, ?)', A, U, id, Date.now()).changes > 0,

    // ----- files (hub.files) -----
    fileList: () => userFiles.list(A, U),
    fileGet: (name) => {
      const row = userFiles.get(A, U, name);
      return row ? { name: row.name, type: row.type, size: row.size, updated_at: row.updated_at, data: () => userFiles.read(row) } : null;
    },
    filePut: (name, type, buffer) => userFiles.put(A, U, name, type, buffer),
    fileDelete: (name) => userFiles.remove(A, U, name),
  };
}

/**
 * Memory stores for previews, one per (session, app, version). Bounded three
 * ways: bytes per store, number of stores, and bytes overall (least recently
 * used stores are dropped first). Nothing survives a restart.
 */
function createPreviewStores({ maxBytes = 2 * MB, maxStores = 400, maxTotalBytes = 128 * MB, idleMs = 2 * 60 * 60_000 } = {}) {
  const stores = new Map(); // key -> state; Map order = least recently used first
  let total = 0;

  const drop = (key) => {
    const s = stores.get(key);
    if (!s) return;
    total -= s.bytes;
    stores.delete(key);
  };
  const timer = setInterval(() => {
    const cut = Date.now() - idleMs;
    for (const [k, s] of stores) if (s.last < cut) drop(k);
  }, 10 * 60_000);
  timer.unref();

  function stateFor(key) {
    let s = stores.get(key);
    if (s) stores.delete(key);
    else s = { bytes: 0, save: new Map(), shared: new Map(), scores: new Map(), results: [], progress: null, achievements: new Map(), files: new Map() };
    s.last = Date.now();
    stores.set(key, s);
    while (stores.size > maxStores) drop(stores.keys().next().value);
    return s;
  }

  /** Account for `delta` bytes in store s (key k); refuse if the preview store is full. */
  function charge(k, s, delta) {
    if (s.bytes + delta > maxBytes) throw new ApiError('quota', 'In der Vorschau ist der Speicher kleiner – er ist voll.');
    s.bytes += delta;
    total += delta;
    for (const other of stores.keys()) {
      if (total <= maxTotalBytes) break;
      if (other !== k) drop(other);
    }
  }

  const SEP = '\u0000';

  /** A store with the same functions as liveStore, writing only to memory. */
  function previewStore(db, appRow, user, key, limits) {
    const live = liveStore(db, appRow, user);
    const s = stateFor(key);

    function putSized(map, mapKey, json, size) {
      const old = map.get(mapKey);
      charge(key, s, size - (old ? old.size : 0));
      map.set(mapKey, { json, size });
    }
    function del(map, mapKey) {
      const old = map.get(mapKey);
      if (old) charge(key, s, -old.size);
      map.delete(mapKey);
    }
    // Shared/class overlay: memory first (a stored `null` means "deleted in this preview"), then the real table.
    function overlayKeys(scope) {
      const keys = new Set(live.sharedKeys(scope));
      for (const [k, v] of s.shared) {
        if (!k.startsWith(scope + SEP)) continue;
        const name = k.slice(scope.length + 1);
        if (v.json === null) keys.delete(name);
        else keys.add(name);
      }
      return [...keys].sort();
    }

    return {
      preview: true,

      saveGet: (k) => s.save.get(k)?.json ?? null,
      saveKeys: () => [...s.save.keys()].sort(),
      saveUsage: (exceptKey) => {
        let bytes = 0;
        let n = 0;
        for (const [k, v] of s.save) if (k !== exceptKey) (bytes += v.size), n++;
        return { bytes, n };
      },
      savePut: (k, json, size) => putSized(s.save, k, json, size),
      saveDelete: (k) => del(s.save, k),

      sharedGet: (scope, k) => {
        const v = s.shared.get(scope + SEP + k);
        return v ? v.json : live.sharedGet(scope, k);
      },
      sharedKeys: overlayKeys,
      sharedUsage: (scope, exceptKey) => {
        let bytes = 0;
        let n = 0;
        for (const k of overlayKeys(scope)) {
          if (k === exceptKey) continue;
          const v = s.shared.get(scope + SEP + k);
          const json = v ? v.json : live.sharedGet(scope, k);
          bytes += Buffer.byteLength(json || '');
          n++;
        }
        return { bytes, n };
      },
      sharedPut: (scope, k, json, size) => putSized(s.shared, scope + SEP + k, json, size),
      sharedDelete: (scope, k) => {
        // remember the deletion so the real value does not shine through
        const old = s.shared.get(scope + SEP + k);
        charge(key, s, -(old ? old.size : 0));
        s.shared.set(scope + SEP + k, { json: null, size: 0 });
      },

      scoreGet: (board) => (s.scores.has(board) ? s.scores.get(board) : null),
      boardExists: (board) => s.scores.has(board),
      boardCount: () => s.scores.size,
      scorePut: (board, score) => {
        if (!s.scores.has(board)) charge(key, s, 64);
        s.scores.set(board, score);
      },
      // A preview leaderboard shows only the person previewing - never real players.
      top: (board) => (s.scores.has(board) ? [{ user_id: user.id, score: s.scores.get(board), name: user.name, anonymous_scores: 0, shares_class: 1 }] : []),

      resultAdd: ({ title, score, maxScore, details }) => {
        const size = 128 + Buffer.byteLength(title) + (details ? Buffer.byteLength(details) : 0);
        charge(key, s, size);
        s.results.unshift({ title, score, max_score: maxScore, details, created_at: Date.now(), size });
        while (s.results.length > 100) charge(key, s, -s.results.pop().size);
      },
      resultsMine: (limit) => s.results.slice(0, limit),

      progressGet: () => s.progress,
      progressPut: (value, label) => {
        if (!s.progress) charge(key, s, 128);
        s.progress = { value, label, updated_at: Date.now() };
      },

      achievementsUnlocked: () => [...s.achievements].map(([achievement, at]) => ({ achievement, unlocked_at: at })),
      achievementPut: (id) => {
        if (s.achievements.has(id)) return false;
        charge(key, s, 64);
        s.achievements.set(id, Date.now());
        return true;
      },

      fileList: () => [...s.files.values()].map(({ name, type, size, updated_at }) => ({ name, type, size, updated_at })).sort((a, b) => (a.name < b.name ? -1 : 1)),
      fileGet: (name) => {
        const f = s.files.get(name);
        return f ? { name: f.name, type: f.type, size: f.size, updated_at: f.updated_at, data: () => f.data } : null;
      },
      filePut: (name, type, buffer) => {
        const t = checkFile(name, type, buffer, limits);
        let n = 0;
        let bytes = 0;
        for (const f of s.files.values()) if (f.name !== name) (n += 1), (bytes += f.size);
        if (n >= limits.filesPerApp || bytes + buffer.length > limits.fileTotalBytes) throw new FileError('quota', 'Dein Platz für Dateien in dieser App ist voll.');
        const old = s.files.get(name);
        charge(key, s, buffer.length - (old ? old.size : 0));
        s.files.set(name, { name, type: t, size: buffer.length, data: Buffer.from(buffer), updated_at: Date.now() });
        return { name, type: t, size: buffer.length };
      },
      fileDelete: (name) => {
        const old = s.files.get(name);
        if (!old) return false;
        charge(key, s, -old.size);
        s.files.delete(name);
        return true;
      },
    };
  }

  return { previewStore, size: () => ({ stores: stores.size, bytes: total }) };
}

module.exports = { ApiError, liveStore, createPreviewStores };
