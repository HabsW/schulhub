'use strict';
// SQLite through Node's built-in driver. Every query goes through a prepared
// statement with bound parameters - SQL is never built from user input.

const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  oid TEXT NOT NULL UNIQUE,              -- Microsoft object id (stable key)
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('student','teacher','admin')),
  disabled INTEGER NOT NULL DEFAULT 0,
  anonymous_scores INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  sid_hash TEXT PRIMARY KEY,             -- only a hash of the session id is stored
  user_id TEXT,
  data TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS classes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual', -- later: 'teams'
  external_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS class_members (
  class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('teacher','student')),
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (class_id, user_id)
);
CREATE INDEX IF NOT EXISTS class_members_user ON class_members(user_id);
CREATE TABLE IF NOT EXISTS join_codes (
  code TEXT PRIMARY KEY,
  class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS apps (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  emoji TEXT NOT NULL,
  color INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'web',      -- later: 'python'
  origin_key TEXT NOT NULL UNIQUE,       -- host label of the app's own origin
  published_version_id TEXT,
  schoolwide_version_id TEXT,            -- version the admin released for everyone
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS apps_owner ON apps(owner_id);
CREATE TABLE IF NOT EXISTS app_versions (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('uploading','ready')),
  note TEXT NOT NULL DEFAULT '',
  file_count INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (app_id, number)
);
CREATE TABLE IF NOT EXISTS app_files (
  version_id TEXT NOT NULL REFERENCES app_versions(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  path_lower TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,                  -- content lives in data/blobs/<sha256>
  PRIMARY KEY (version_id, path),
  UNIQUE (version_id, path_lower)
);
CREATE INDEX IF NOT EXISTS app_files_sha ON app_files(sha256);

-- An app inside a class. version_id is what the class plays; a newer version
-- of a student-made app waits in requested_version_id until a teacher approves.
CREATE TABLE IF NOT EXISTS class_apps (
  class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')),
  version_id TEXT,
  requested_version_id TEXT,
  added_by TEXT,
  decided_by TEXT,
  decided_at INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (class_id, app_id)
);
CREATE INDEX IF NOT EXISTS class_apps_app ON class_apps(app_id);

-- App data. Everything is keyed by app_id, so one app can never see another's.
CREATE TABLE IF NOT EXISTS saves (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  size INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, user_id, key)
);
CREATE TABLE IF NOT EXISTS shared_data (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  class_id TEXT NOT NULL DEFAULT '',     -- '' = for the whole app
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  size INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, class_id, key)
);
CREATE TABLE IF NOT EXISTS scores (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  board TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, board, user_id)
);
CREATE TABLE IF NOT EXISTS results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  score REAL,
  max_score REAL,
  details TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS results_app_user ON results(app_id, user_id);
CREATE TABLE IF NOT EXISTS plays (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (app_id, user_id)
);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  author_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_app ON comments(app_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor_id TEXT,                         -- set to NULL when the account is deleted
  actor_label TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS audit_at ON audit_log(at);
`;

function openDb(file) {
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  raw.exec(SCHEMA);
  raw.exec('PRAGMA user_version = 1;');

  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) cache.set(sql, (s = raw.prepare(sql)));
    return s;
  };
  let depth = 0;
  return {
    get: (sql, ...params) => stmt(sql).get(...params),
    all: (sql, ...params) => stmt(sql).all(...params),
    run: (sql, ...params) => stmt(sql).run(...params),
    /** Run fn atomically. fn must be synchronous. Nested calls join the outer one. */
    tx(fn) {
      if (depth > 0) return fn();
      raw.exec('BEGIN IMMEDIATE');
      depth++;
      try {
        const result = fn();
        raw.exec('COMMIT');
        return result;
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      } finally {
        depth--;
      }
    },
    close: () => raw.close(),
  };
}

module.exports = { openDb };
