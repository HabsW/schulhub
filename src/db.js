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

// Schema changes after version 1. Each entry runs once, in order, inside a
// transaction; PRAGMA user_version remembers how far a database has come.
// Never edit a migration that has shipped - add a new one.
const MIGRATIONS = [
  null, // 0 -> 1 is SCHEMA above
  // ---------------------------------------------------------------- 1 -> 2
  `
  -- People: display and accessibility choices (made by the person, shown in "Meine Daten").
  ALTER TABLE users ADD COLUMN pref_theme TEXT NOT NULL DEFAULT 'dark' CHECK (pref_theme IN ('auto','dark','light'));
  ALTER TABLE users ADD COLUMN pref_text TEXT NOT NULL DEFAULT 'normal' CHECK (pref_text IN ('normal','large','larger'));
  ALTER TABLE users ADD COLUMN pref_motion TEXT NOT NULL DEFAULT 'auto' CHECK (pref_motion IN ('auto','reduce'));
  ALTER TABLE users ADD COLUMN pref_contrast TEXT NOT NULL DEFAULT 'normal' CHECK (pref_contrast IN ('normal','high'));
  -- Retention: set when an account has not signed in for a long time. Never deletes anything by itself.
  ALTER TABLE users ADD COLUMN flagged_inactive_at INTEGER;

  -- Classes: end-of-year archive and optional catalogue data.
  ALTER TABLE classes ADD COLUMN archived_at INTEGER;
  ALTER TABLE classes ADD COLUMN subject TEXT NOT NULL DEFAULT '';
  ALTER TABLE classes ADD COLUMN grade INTEGER;
  -- A join code makes a student member; a 'teacher' invitation (co-teachers) works only for teacher accounts.
  ALTER TABLE join_codes ADD COLUMN role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student','teacher'));

  -- Apps: catalogue data, sharing with colleagues, school-wide updates that wait for the admin.
  ALTER TABLE apps ADD COLUMN category TEXT NOT NULL DEFAULT '';
  ALTER TABLE apps ADD COLUMN grade_min INTEGER;
  ALTER TABLE apps ADD COLUMN grade_max INTEGER;
  ALTER TABLE apps ADD COLUMN shared INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE apps ADD COLUMN schoolwide_requested_version_id TEXT;
  -- Versions: the validated schulhub.json and the upload check report (both JSON, written by the server).
  ALTER TABLE app_versions ADD COLUMN manifest TEXT;
  ALTER TABLE app_versions ADD COLUMN report TEXT;

  -- Comments double as the review history: decisions are comments of a kind, tied to a version and class.
  ALTER TABLE comments ADD COLUMN kind TEXT NOT NULL DEFAULT 'comment' CHECK (kind IN ('comment','approved','returned','submitted'));
  ALTER TABLE comments ADD COLUMN version_id TEXT;
  ALTER TABLE comments ADD COLUMN class_id TEXT;

  -- The class an app was opened from when a result was recorded (NULL: none, or recorded before v2).
  ALTER TABLE results ADD COLUMN class_id TEXT;
  CREATE INDEX results_class ON results(class_id, app_id);
  CREATE INDEX plays_user ON plays(user_id, last_at);

  -- class_apps is rebuilt: 'removed' keeps results reachable after an app leaves a class, and the
  -- state of a waiting request is explicit ('returned' keeps the version visible to its reviewer).
  CREATE TABLE class_apps_v2 (
    class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
    app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','removed')),
    version_id TEXT,                       -- what the class plays (approved)
    requested_version_id TEXT,             -- a version waiting for, or returned by, the teacher
    request_state TEXT CHECK (request_state IN ('waiting','returned')),
    multiplayer INTEGER NOT NULL DEFAULT 0, -- prepared for later: the teacher's opt-in, not used yet
    added_by TEXT,
    decided_by TEXT,
    decided_at INTEGER,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (class_id, app_id)
  );
  INSERT INTO class_apps_v2 (class_id, app_id, status, version_id, requested_version_id, request_state, added_by, decided_by, decided_at, created_at)
    SELECT class_id, app_id, status, version_id, requested_version_id,
           CASE WHEN requested_version_id IS NOT NULL THEN 'waiting' END,
           added_by, decided_by, decided_at, created_at
      FROM class_apps;
  DROP TABLE class_apps;
  ALTER TABLE class_apps_v2 RENAME TO class_apps;
  CREATE INDEX class_apps_app ON class_apps(app_id);
  CREATE INDEX class_apps_waiting ON class_apps(request_state, class_id);

  CREATE TABLE favorites (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, app_id)
  );

  -- Assignments: an app to work on in a class, optionally until a date.
  CREATE TABLE assignments (
    id TEXT PRIMARY KEY,
    class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
    app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    starts_at INTEGER NOT NULL,
    due_at INTEGER,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX assignments_class ON assignments(class_id);
  -- "Done" is derived from results/progress after starts_at; a student may also mark it done by hand.
  CREATE TABLE assignment_done (
    assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    done_at INTEGER NOT NULL,
    PRIMARY KEY (assignment_id, user_id)
  );

  -- Private feedback from a teacher to one student.
  CREATE TABLE feedback (
    id TEXT PRIMARY KEY,
    class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
    student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    app_id TEXT REFERENCES apps(id) ON DELETE SET NULL,
    assignment_id TEXT REFERENCES assignments(id) ON DELETE SET NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    read_at INTEGER
  );
  CREATE INDEX feedback_student ON feedback(student_id, created_at);
  CREATE INDEX feedback_class ON feedback(class_id);

  -- SDK: progress (0..1) and unlocked achievements per person and app.
  CREATE TABLE progress (
    app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    value REAL NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (app_id, user_id)
  );
  CREATE TABLE achievements (
    app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    achievement TEXT NOT NULL,
    unlocked_at INTEGER NOT NULL,
    PRIMARY KEY (app_id, user_id, achievement)
  );
  -- SDK: per-class settings a teacher edits in the Hub (fields declared in schulhub.json).
  CREATE TABLE class_app_settings (
    class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
    app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    value TEXT NOT NULL,
    updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (class_id, app_id)
  );
  -- SDK: small files (images, JSON, text) an app saves for one person. Content in data/userfiles/<sha256>.
  CREATE TABLE user_files (
    app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (app_id, user_id, name)
  );
  CREATE INDEX user_files_sha ON user_files(sha256);

  -- In-Hub messages to one person (no e-mail). Text and link are composed by the server.
  CREATE TABLE notices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    href TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    read_at INTEGER
  );
  CREATE INDEX notices_user ON notices(user_id, read_at, created_at);

  -- Announcements: to the whole school (class_id NULL, admin) or to one class (its teachers).
  CREATE TABLE announcements (
    id TEXT PRIMARY KEY,
    class_id TEXT REFERENCES classes(id) ON DELETE CASCADE,
    author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    expires_at INTEGER
  );
  CREATE TABLE announcement_dismissed (
    announcement_id TEXT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (announcement_id, user_id)
  );

  -- In-browser editor: one mutable draft per app, private to its owner. Versions stay immutable;
  -- "save as version" copies the draft's rows into a new version.
  CREATE TABLE app_drafts (
    app_id TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
    based_on_version_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE draft_files (
    app_id TEXT NOT NULL REFERENCES app_drafts(app_id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    path_lower TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    PRIMARY KEY (app_id, path),
    UNIQUE (app_id, path_lower)
  );
  CREATE INDEX draft_files_sha ON draft_files(sha256);

  -- Anonymous usage for app authors: openings per day. No people, no classes.
  CREATE TABLE app_usage (
    app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    opens INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (app_id, day)
  );

  -- Settings the admin can change in the Hub (retention etc.). Values are JSON.
  CREATE TABLE hub_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  // ---------------------------------------------------------------- 2 -> 3
  `
  -- The person an audit entry or an in-Hub notice is ABOUT (not who did it), so that deleting
  -- an account can remove their name everywhere (audit targets, other people's notices).
  ALTER TABLE audit_log ADD COLUMN subject_id TEXT;
  CREATE INDEX audit_subject ON audit_log(subject_id);
  ALTER TABLE notices ADD COLUMN subject_id TEXT;
  CREATE INDEX notices_subject ON notices(subject_id);
  -- Results from before version 2 did not record a class: mark them '' ("class unknown").
  -- From now on NULL means "recorded without any class context" and never shows in a class.
  UPDATE results SET class_id = '' WHERE class_id IS NULL;
  `,
  // ---------------------------------------------------------------- 3 -> 4
  `
  -- The app an audit entry is ABOUT (its target may be the app's name at that moment), so that
  -- deleting an account removes the names of the person's apps by id - never by matching names
  -- across other people's entries.
  ALTER TABLE audit_log ADD COLUMN app_id TEXT;
  CREATE INDEX audit_app ON audit_log(app_id);
  CREATE INDEX audit_actor ON audit_log(actor_id);
  `,
];

const SCHEMA_VERSION = MIGRATIONS.length;

function migrate(raw) {
  let version = raw.prepare('PRAGMA user_version').get().user_version;
  if (version === 0) {
    raw.exec(SCHEMA);
    raw.exec('PRAGMA user_version = 1;');
    version = 1;
  }
  if (version > SCHEMA_VERSION) throw new Error(`Die Datenbank ist neuer (Version ${version}) als dieser Hub (Version ${SCHEMA_VERSION}).`);
  for (let v = version; v < SCHEMA_VERSION; v++) {
    // Table rebuilds need foreign key enforcement off; it is switched back on and checked afterwards.
    raw.exec('PRAGMA foreign_keys = OFF;');
    raw.exec('BEGIN IMMEDIATE');
    try {
      raw.exec(MIGRATIONS[v]);
      raw.exec(`PRAGMA user_version = ${v + 1};`);
      const broken = raw.prepare('PRAGMA foreign_key_check').all();
      if (broken.length) throw new Error(`Migration ${v + 1}: ${broken.length} broken references`);
      raw.exec('COMMIT');
    } catch (err) {
      raw.exec('ROLLBACK');
      throw err;
    } finally {
      raw.exec('PRAGMA foreign_keys = ON;');
    }
  }
}

/**
 * The schema SchulHub creates for one version, built fresh in `file` the same
 * way an upgrade builds it (SCHEMA, then the migrations up to that version).
 * Used to check restored backups against exactly what a Hub of that version made.
 */
function schemaForVersion(version, file) {
  if (!Number.isInteger(version) || version < 1 || version > SCHEMA_VERSION) throw new Error(`unknown schema version ${version}`);
  const raw = new DatabaseSync(file);
  try {
    raw.exec('PRAGMA foreign_keys = OFF;');
    raw.exec(SCHEMA);
    for (let v = 1; v < version; v++) raw.exec(MIGRATIONS[v]);
    return raw.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master').all();
  } finally {
    raw.close();
  }
}

function openDb(file) {
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(raw);

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
    /** Consistent copy of the whole database into a new file (for backups). */
    snapshot: (target) => raw.prepare('VACUUM INTO ?').run(target),
    close: () => raw.close(),
  };
}

module.exports = { openDb, schemaForVersion, SCHEMA_VERSION, SCHEMA_V1: SCHEMA };
