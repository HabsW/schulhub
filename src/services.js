'use strict';
// Operations that change several tables at once (create, publish, delete ...).
// Permission checks happen in the routes via access.js BEFORE these are called.

const crypto = require('node:crypto');
const { newId, bad, cleanText } = require('./util');
const { EMOJIS, COLORS } = require('./html');

function createServices(ctx) {
  const { db, config, uploads } = ctx;

  // ---------- audit log ----------
  function audit(actor, action, target = '', detail = '') {
    db.run(
      'INSERT INTO audit_log (at, actor_id, actor_label, action, target, detail) VALUES (?, ?, ?, ?, ?, ?)',
      Date.now(), actor ? actor.id : null, actor ? `${actor.name} (${actor.role})` : 'System', action, String(target).slice(0, 200), String(detail).slice(0, 500)
    );
  }
  function pruneAudit() {
    db.run('DELETE FROM audit_log WHERE at < ?', Date.now() - config.auditRetentionDays * 86_400_000);
  }

  // ---------- classes ----------
  function createClass(user, name) {
    const id = newId();
    db.tx(() => {
      db.run('INSERT INTO classes (id, name, created_at) VALUES (?, ?, ?)', id, name, Date.now());
      db.run("INSERT INTO class_members (class_id, user_id, role, joined_at) VALUES (?, ?, 'teacher', ?)", id, user.id, Date.now());
      audit(user, 'klasse_erstellt', name);
    });
    return id;
  }

  /** New join code; any older code of the class stops working. */
  function createJoinCode(user, classId, minutes) {
    const code = crypto.randomBytes(24).toString('base64url'); // 192 bits
    db.tx(() => {
      db.run('DELETE FROM join_codes WHERE class_id = ?', classId);
      db.run('INSERT INTO join_codes (code, class_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', code, classId, user.id, Date.now(), Date.now() + minutes * 60_000);
    });
    return code;
  }

  function deleteClass(actor, cls) {
    db.tx(() => {
      db.run("DELETE FROM shared_data WHERE class_id = ?", cls.id);
      db.run('DELETE FROM classes WHERE id = ?', cls.id);
      audit(actor, 'klasse_geloescht', cls.name);
    });
  }

  // ---------- apps ----------
  function appFields(body) {
    const name = cleanText(body.name, 60);
    if (name.length < 2) throw bad('Bitte gib der App einen Namen (mindestens 2 Zeichen).');
    const emoji = EMOJIS.includes(body.emoji) ? body.emoji : EMOJIS[0];
    const color = Number.parseInt(body.color, 10);
    return { name, description: cleanText(body.description, 500, { multiline: true }), emoji, color: color >= 0 && color < COLORS ? color : 0 };
  }

  function createApp(user, body) {
    const f = appFields(body);
    if (db.get('SELECT COUNT(*) AS n FROM apps WHERE owner_id = ?', user.id).n >= config.limits.maxAppsPerUser) {
      throw bad(`Du hast schon ${config.limits.maxAppsPerUser} Apps. Lösche eine, bevor du eine neue anlegst.`);
    }
    const id = newId();
    // The origin key becomes a host name: lowercase letters and digits only.
    const originKey = `a${crypto.randomBytes(10).toString('hex')}`;
    db.run(
      'INSERT INTO apps (id, owner_id, name, description, emoji, color, origin_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, user.id, f.name, f.description, f.emoji, f.color, originKey, Date.now(), Date.now()
    );
    audit(user, 'app_erstellt', f.name);
    return id;
  }

  function createVersion(app) {
    return db.tx(() => {
      // Throw away uploads that were started but never finished.
      for (const stale of db.all("SELECT * FROM app_versions WHERE app_id = ? AND status = 'uploading' AND created_at < ?", app.id, Date.now() - 60 * 60_000)) deleteVersionRows(stale);
      if (db.get('SELECT COUNT(*) AS n FROM app_versions WHERE app_id = ?', app.id).n >= config.limits.maxVersionsPerApp) {
        throw bad(`Diese App hat schon ${config.limits.maxVersionsPerApp} Versionen. Lösche eine alte Version, bevor du eine neue hochlädst.`);
      }
      const number = db.get('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM app_versions WHERE app_id = ?', app.id).n;
      const version = { id: newId(), app_id: app.id, number, status: 'uploading' };
      db.run("INSERT INTO app_versions (id, app_id, number, status, created_at) VALUES (?, ?, ?, 'uploading', ?)", version.id, app.id, number, Date.now());
      return version;
    });
  }

  /** Finish an upload: it must contain index.html; afterwards the version never changes. */
  function finishVersion(actor, app, version) {
    const stats = db.get('SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM app_files WHERE version_id = ?', version.id);
    if (!db.get("SELECT 1 AS ok FROM app_files WHERE version_id = ? AND path = 'index.html'", version.id)) {
      deleteVersion(null, app, version);
      throw bad('In der App fehlt die Startdatei "index.html" (sie muss ganz oben im Ordner liegen).');
    }
    db.run("UPDATE app_versions SET status = 'ready', file_count = ?, total_bytes = ? WHERE id = ?", stats.files, stats.bytes, version.id);
    db.run('UPDATE apps SET updated_at = ? WHERE id = ?', Date.now(), app.id);
    audit(actor, 'version_hochgeladen', app.name, `Version ${version.number}, ${stats.files} Dateien`);
  }

  function deleteVersionRows(version) {
    const shas = db.all('SELECT DISTINCT sha256 FROM app_files WHERE version_id = ?', version.id).map((r) => r.sha256);
    db.run('DELETE FROM app_versions WHERE id = ?', version.id);
    return shas;
  }
  function deleteVersion(actor, app, version) {
    const shas = db.tx(() => deleteVersionRows(version));
    uploads.collectGarbage(shas);
    if (actor) audit(actor, 'version_geloescht', app.name, `Version ${version.number}`);
  }

  /**
   * Publish a version. Classes follow automatically only where the publisher
   * is a teacher of that class (or admin). Everywhere else the class keeps the
   * version that was approved, and the new one waits for the teacher.
   */
  function publish(actor, app, version) {
    db.tx(() => {
      db.run('UPDATE apps SET published_version_id = ?, updated_at = ? WHERE id = ?', version.id, Date.now(), app.id);
      for (const row of db.all('SELECT class_id, status, version_id FROM class_apps WHERE app_id = ?', app.id)) {
        const trusted = actor.role === 'admin' || ctx.access.classRole(actor, row.class_id) === 'teacher';
        if (trusted) {
          db.run("UPDATE class_apps SET status = 'approved', version_id = ?, requested_version_id = NULL, decided_by = ?, decided_at = ? WHERE class_id = ? AND app_id = ?", version.id, actor.id, Date.now(), row.class_id, app.id);
        } else if (row.version_id !== version.id) {
          // an already approved app stays approved (old version); a rejected one is asked again
          db.run("UPDATE class_apps SET requested_version_id = ?, status = CASE WHEN version_id IS NULL THEN 'pending' ELSE status END WHERE class_id = ? AND app_id = ?", version.id, row.class_id, app.id);
        }
      }
      audit(actor, 'veroeffentlicht', app.name, `Version ${version.number}`);
    });
  }

  function deleteApp(actor, app) {
    const shas = db.tx(() => {
      const list = db.all('SELECT DISTINCT f.sha256 FROM app_files f JOIN app_versions v ON v.id = f.version_id WHERE v.app_id = ?', app.id).map((r) => r.sha256);
      db.run('DELETE FROM apps WHERE id = ?', app.id); // cascades to versions, files, saves, scores, results, comments
      audit(actor, 'app_geloescht', app.name);
      return list;
    });
    uploads.collectGarbage(shas);
  }

  // ---------- personal data ----------
  /** Remove everything one user stored in one app. */
  function deleteAppData(appId, userId) {
    db.tx(() => {
      for (const table of ['saves', 'scores', 'results', 'plays']) db.run(`DELETE FROM ${table} WHERE app_id = ? AND user_id = ?`, appId, userId);
    });
  }

  /** Delete an account and everything that belongs to it. */
  function deleteUser(actor, user) {
    const shas = db.tx(() => {
      const list = db.all('SELECT DISTINCT f.sha256 FROM app_files f JOIN app_versions v ON v.id = f.version_id JOIN apps a ON a.id = v.app_id WHERE a.owner_id = ?', user.id).map((r) => r.sha256);
      // Classes where this user was the only teacher go away with them.
      const orphaned = db.all(
        `SELECT c.id FROM classes c JOIN class_members m ON m.class_id = c.id AND m.user_id = ? AND m.role = 'teacher'
          WHERE NOT EXISTS (SELECT 1 FROM class_members o WHERE o.class_id = c.id AND o.role = 'teacher' AND o.user_id <> ?)`,
        user.id, user.id
      );
      for (const c of orphaned) {
        db.run('DELETE FROM shared_data WHERE class_id = ?', c.id);
        db.run('DELETE FROM classes WHERE id = ?', c.id);
      }
      db.run('DELETE FROM sessions WHERE user_id = ?', user.id);
      db.run("UPDATE audit_log SET actor_id = NULL, actor_label = 'Gelöschtes Konto' WHERE actor_id = ?", user.id);
      db.run('DELETE FROM users WHERE id = ?', user.id); // cascades: memberships, apps, saves, scores, results, comments
      audit(actor && actor.id !== user.id ? actor : null, 'konto_geloescht', actor && actor.id !== user.id ? 'durch Verwaltung' : 'durch Nutzer/in selbst');
      return list;
    });
    uploads.collectGarbage(shas);
  }

  return { audit, pruneAudit, createClass, createJoinCode, deleteClass, appFields, createApp, createVersion, finishVersion, deleteVersion, publish, deleteApp, deleteAppData, deleteUser };
}

module.exports = { createServices };
