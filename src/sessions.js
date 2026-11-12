'use strict';
// Server-side session store in SQLite. The browser only holds the signed
// session id cookie; the database only holds a hash of that id.

const crypto = require('node:crypto');
const session = require('express-session');

const sidHash = (sid) => crypto.createHash('sha256').update(String(sid)).digest().subarray(0, 16).toString('base64url');

function createSessionStore(db, sessionMs) {
  class SqliteStore extends session.Store {
    get(sid, cb) {
      try {
        const row = db.get('SELECT data, expires_at FROM sessions WHERE sid_hash = ?', sidHash(sid));
        cb(null, row && row.expires_at > Date.now() ? JSON.parse(row.data) : null);
      } catch (err) {
        cb(err);
      }
    }
    set(sid, sess, cb) {
      try {
        const expires = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + sessionMs;
        db.run(
          `INSERT INTO sessions (sid_hash, user_id, data, expires_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (sid_hash) DO UPDATE SET user_id = excluded.user_id, data = excluded.data, expires_at = excluded.expires_at`,
          sidHash(sid), sess.userId || null, JSON.stringify(sess), expires
        );
        cb && cb(null);
      } catch (err) {
        cb && cb(err);
      }
    }
    destroy(sid, cb) {
      try {
        db.run('DELETE FROM sessions WHERE sid_hash = ?', sidHash(sid));
        cb && cb(null);
      } catch (err) {
        cb && cb(err);
      }
    }
    touch(sid, sess, cb) {
      cb && cb(null); // expiry is absolute (see loadUser), nothing to extend
    }
  }
  const store = new SqliteStore();
  const timer = setInterval(() => db.run('DELETE FROM sessions WHERE expires_at < ?', Date.now()), 10 * 60_000);
  timer.unref();
  return store;
}

module.exports = { createSessionStore, sidHash };
