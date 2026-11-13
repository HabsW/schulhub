'use strict';
// Operations that change several tables at once (create, publish, delete ...).
// Permission checks happen in the routes via access.js BEFORE these are called.

const crypto = require('node:crypto');
const { newId, bad, cleanText, isLocalPath, dayKey } = require('./util');
const { EMOJIS, COLORS } = require('./html');
const { analyzeVersion } = require('./checks');

const DAY = 86_400_000;
/** The first string after every string that starts with `prefix` (ASCII prefixes: ids and paths). */
const prefixEnd = (prefix) => prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
/** Where the notice about an announcement points: one link per announcement, so its notices can go with it. */
const announcementLink = (id) => `/start#ankuendigung-${id}`;

/**
 * Columns that keep a person's id WITHOUT a foreign key to users (foreign keys cascade or are set
 * to NULL by SQLite itself). deleteUser sets these to NULL and handles the others in its own way;
 * test/people.test.js checks the live schema against both lists, so a new column cannot be forgotten.
 */
const ID_COLUMNS_SET_NULL = [['join_codes', 'created_by'], ['class_apps', 'added_by'], ['class_apps', 'decided_by']];
const ID_COLUMNS_HANDLED = ['sessions.user_id', 'audit_log.actor_id', 'audit_log.subject_id', 'notices.subject_id'];
/** Audit actions about an app (for entries written before they carried the app's id, schema version < 4). */
const APP_ACTIONS = "(action LIKE 'app%' OR action LIKE 'version%' OR action LIKE 'schulweit%' OR action LIKE 'upload%' OR action LIKE 'aufgabe%' OR action IN ('veroeffentlicht', 'einreichung_zurueckgezogen', 'kommentar_geloescht', 'ergebnisse_exportiert'))";

function createServices(ctx) {
  const { db, config, uploads } = ctx;

  // ---------- audit log ----------
  /**
   * Record what happened. `subjectId`: the person the entry is ABOUT (e.g. whose role changed),
   * so that deleting that account can anonymise the entry.
   */
  // subjectId: the person an entry is about; appId: the app it is about (both for account deletion).
  function audit(actor, action, target = '', detail = '', { subjectId = null, appId = null } = {}) {
    db.run(
      'INSERT INTO audit_log (at, actor_id, actor_label, action, target, detail, subject_id, app_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      Date.now(), actor ? actor.id : null, actor ? `${actor.name} (${actor.role})` : 'System', action, String(target).slice(0, 200), String(detail).slice(0, 500), subjectId, appId
    );
  }
  function pruneAudit() {
    db.run('DELETE FROM audit_log WHERE at < ?', Date.now() - ctx.settings.get('retention.auditDays') * DAY);
  }

  // ---------- in-Hub messages ----------
  /**
   * Leave a short message for some people (no e-mail, no push). Text and link
   * are composed by the server; names inside the text are escaped when shown.
   */
  function notify(userIds, kind, text, href = '', { subjectId = null } = {}) {
    const now = Date.now();
    const t = String(text).slice(0, 300);
    const link = isLocalPath(href) ? href : '';
    for (const id of new Set(userIds)) {
      if (!id) continue;
      // The same unread message twice is noise (e.g. withdraw and resubmit in a loop): keep one.
      if (db.get('SELECT 1 AS dup FROM notices WHERE user_id = ? AND read_at IS NULL AND kind = ? AND text = ? AND href = ?', id, String(kind).slice(0, 40), t, link)) continue;
      // subjectId: the person this notice names, so it disappears when that account is deleted.
      db.run('INSERT INTO notices (user_id, kind, text, href, created_at, subject_id) VALUES (?, ?, ?, ?, ?, ?)', id, String(kind).slice(0, 40), t, link, now, subjectId);
      db.run('DELETE FROM notices WHERE user_id = ? AND id NOT IN (SELECT id FROM notices WHERE user_id = ? ORDER BY id DESC LIMIT ?)', id, id, config.limits.noticesPerUser);
    }
  }

  // ---------- use of an app ----------
  /** A real (non-preview) opening: personal "last played" plus an anonymous daily count for the author. */
  function recordPlay(appId, userId) {
    const now = Date.now();
    db.run(
      `INSERT INTO plays (app_id, user_id, first_at, last_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (app_id, user_id) DO UPDATE SET last_at = excluded.last_at, count = count + 1`,
      appId, userId, now, now
    );
    db.run('INSERT INTO app_usage (app_id, day, opens) VALUES (?, ?, 1) ON CONFLICT (app_id, day) DO UPDATE SET opens = opens + 1', appId, dayKey(now));
  }

  // ---------- retention (runs daily) ----------
  /** Apply the admin's retention settings. Accounts are only ever flagged, never deleted here. */
  function maintenance(now = Date.now()) {
    const s = ctx.settings;
    db.run('DELETE FROM audit_log WHERE at < ?', now - s.get('retention.auditDays') * DAY);
    for (const c of db.all('SELECT * FROM classes WHERE archived_at IS NOT NULL AND archived_at < ?', now - s.get('retention.archivedClassDays') * DAY)) {
      deleteClass(null, c, 'automatisch nach Ablauf der Aufbewahrungsfrist');
    }
    const inactiveBefore = now - s.get('retention.inactiveFlagDays') * DAY;
    db.run('UPDATE users SET flagged_inactive_at = ? WHERE flagged_inactive_at IS NULL AND COALESCE(last_login_at, created_at) < ?', now, inactiveBefore);
    // The flag means "no sign-in for the period the admin set NOW": after the admin made it longer, an account
    // flagged under the shorter one is not "lange nicht benutzt" any more (signing in also clears it).
    db.run('UPDATE users SET flagged_inactive_at = NULL WHERE flagged_inactive_at IS NOT NULL AND COALESCE(last_login_at, created_at) >= ?', inactiveBefore);
    db.run('DELETE FROM notices WHERE created_at < ?', now - 180 * DAY);
    db.run('DELETE FROM announcements WHERE expires_at IS NOT NULL AND expires_at < ?', now - 30 * DAY);
    db.run('DELETE FROM app_usage WHERE day < ?', dayKey(now - 400 * DAY));
    db.optimize();
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

  /**
   * New join code; any older code of the same kind for the class stops working.
   * role 'student' (QR code / link for the class) or 'teacher' (co-teacher invitation).
   */
  function createJoinCode(user, classId, minutes, role = 'student') {
    if (role !== 'student' && role !== 'teacher') throw new Error('bad join code role');
    const code = crypto.randomBytes(24).toString('base64url'); // 192 bits
    db.tx(() => {
      db.run('DELETE FROM join_codes WHERE class_id = ? AND role = ?', classId, role);
      db.run('INSERT INTO join_codes (code, class_id, created_by, created_at, expires_at, role) VALUES (?, ?, ?, ?, ?, ?)', code, classId, user.id, Date.now(), Date.now() + minutes * 60_000, role);
    });
    return code;
  }

  /**
   * Notices that point into one class - its assignments, its announcements, its review requests - would
   * lead nowhere and quote titles that are gone. Call while the class's rows still exist.
   */
  function deleteClassNotices(classId) {
    for (const { id } of db.all('SELECT id FROM assignments WHERE class_id = ?', classId)) db.run('DELETE FROM notices WHERE href = ?', `/aufgaben/${id}`);
    for (const { id } of db.all('SELECT id FROM announcements WHERE class_id = ?', classId)) db.run('DELETE FROM notices WHERE href = ?', announcementLink(id));
    const review = `/pruefen/${classId}/`;
    db.run('DELETE FROM notices WHERE href >= ? AND href < ?', review, prefixEnd(review));
  }

  /** Delete a class and what belongs only to it (cascades: members, codes, apps in it, assignments, feedback, settings, announcements). */
  function deleteClass(actor, cls, detail = '') {
    db.tx(() => {
      deleteClassNotices(cls.id);
      db.run('DELETE FROM shared_data WHERE class_id = ?', cls.id);
      db.run('DELETE FROM classes WHERE id = ?', cls.id);
      audit(actor, 'klasse_geloescht', cls.name, detail);
    }, { durable: true });
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
    audit(user, 'app_erstellt', f.name, '', { appId: id });
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

  /**
   * Finish an upload: it must contain index.html; the checks run once and their
   * report and the validated manifest are stored; afterwards the version never changes.
   */
  function finishVersion(actor, app, version) {
    const stats = db.get('SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM app_files WHERE version_id = ?', version.id);
    if (!db.get("SELECT 1 AS ok FROM app_files WHERE version_id = ? AND path = 'index.html'", version.id)) {
      deleteVersion(null, app, version);
      throw bad('In der App fehlt die Startdatei "index.html" (sie muss ganz oben im Ordner liegen).');
    }
    const { manifest, report } = analyzeVersion(ctx, version);
    db.tx(() => {
      db.run(
        "UPDATE app_versions SET status = 'ready', file_count = ?, total_bytes = ?, manifest = ?, report = ? WHERE id = ?",
        stats.files, stats.bytes, manifest ? JSON.stringify(manifest) : null, JSON.stringify(report), version.id
      );
      db.run('UPDATE apps SET updated_at = ? WHERE id = ?', Date.now(), app.id);
      // Catalogue data from the manifest fills fields the author has not set yet.
      if (manifest && manifest.category) db.run("UPDATE apps SET category = ? WHERE id = ? AND category = ''", manifest.category, app.id);
      if (manifest && manifest.grades) db.run('UPDATE apps SET grade_min = ?, grade_max = ? WHERE id = ? AND grade_min IS NULL', manifest.grades[0], manifest.grades[1], app.id);
      audit(actor, 'version_hochgeladen', app.name, `Version ${version.number}, ${stats.files} Dateien`, { appId: app.id });
    });
    return report;
  }

  /**
   * Save the editor draft as a new, immutable version. Only rows are copied:
   * file contents are content-addressed and shared on disk.
   */
  function versionFromDraft(actor, app, note = '') {
    const files = uploads.listDraftFiles(app.id);
    if (!files.some((f) => f.path === 'index.html')) throw bad('In der App fehlt die Startdatei "index.html".');
    const bytes = files.reduce((n, f) => n + f.size, 0);
    if (files.length > config.limits.maxFiles) throw bad(`Zu viele Dateien (maximal ${config.limits.maxFiles}).`);
    if (bytes > config.limits.maxVersionBytes) throw bad(`Die App ist zu groß (maximal ${Math.round(config.limits.maxVersionBytes / 1048576)} MB).`);
    if (uploads.userBytes(app.owner_id) + bytes > config.limits.maxUserBytes) throw bad('Der Speicherplatz dieses Kontos ist voll. Lösche alte Versionen, um Platz zu schaffen.');
    const version = createVersion(app);
    db.tx(() => {
      for (const f of files) {
        db.run('INSERT INTO app_files (version_id, path, path_lower, size, sha256) VALUES (?, ?, ?, ?, ?)', version.id, f.path, f.path.toLowerCase(), f.size, f.sha256);
      }
      db.run('UPDATE app_versions SET note = ? WHERE id = ?', cleanText(note, 500, { multiline: true }), version.id);
    });
    finishVersion(actor, app, version);
    db.run('UPDATE app_drafts SET based_on_version_id = ? WHERE app_id = ?', version.id, app.id);
    return db.get('SELECT * FROM app_versions WHERE id = ?', version.id);
  }

  function deleteVersionRows(version) {
    const shas = db.all('SELECT DISTINCT sha256 FROM app_files WHERE version_id = ?', version.id).map((r) => r.sha256);
    db.run('DELETE FROM app_versions WHERE id = ?', version.id);
    return shas;
  }
  function deleteVersion(actor, app, version) {
    const shas = db.tx(() => deleteVersionRows(version));
    uploads.collectGarbage(shas);
    if (actor) audit(actor, 'version_geloescht', app.name, `Version ${version.number}`, { appId: app.id });
  }

  /**
   * Publish a version. Classes follow automatically only where the publisher
   * is a teacher of that class (or admin). Everywhere else the class keeps the
   * version that was approved, and the new one waits for the teacher.
   */
  function publish(actor, app, version) {
    // Publishing back and forth would flood the classes' review history: a bounded number per hour.
    ctx.limiter.guard('publish', actor.id);
    db.tx(() => {
      db.run('UPDATE apps SET published_version_id = ?, updated_at = ? WHERE id = ?', version.id, Date.now(), app.id);
      // Classes follow at once only where the publisher decides; elsewhere the new version waits.
      ctx.classApps.onPublish(actor, app, version);
      // A school-wide app keeps its released version; the update waits for the admin.
      if (app.schoolwide_version_id && app.schoolwide_version_id !== version.id) {
        if (actor.role === 'admin') db.run('UPDATE apps SET schoolwide_version_id = ?, schoolwide_requested_version_id = NULL WHERE id = ?', version.id, app.id);
        else db.run('UPDATE apps SET schoolwide_requested_version_id = ? WHERE id = ?', version.id, app.id);
      }
      audit(actor, 'veroeffentlicht', app.name, `Version ${version.number}`, { appId: app.id });
    });
  }

  /** Content hashes of app code (versions and drafts) of the given apps. */
  const codeShas = (appIds) =>
    appIds.flatMap((id) => [
      ...db.all('SELECT DISTINCT f.sha256 FROM app_files f JOIN app_versions v ON v.id = f.version_id WHERE v.app_id = ?', id).map((r) => r.sha256),
      ...db.all('SELECT DISTINCT sha256 FROM draft_files WHERE app_id = ?', id).map((r) => r.sha256),
    ]);

  function deleteApp(actor, app) {
    const { code, files } = db.tx(() => {
      const found = { code: codeShas([app.id]), files: ctx.userFiles.shasOfApp(app.id) };
      const assignments = db.all('SELECT id, title FROM assignments WHERE app_id = ?', app.id);
      deleteFeedbackNotices([{ id: app.id, name: app.name }], assignments);
      db.run('DELETE FROM apps WHERE id = ?', app.id); // cascades: versions, files, drafts, saves, scores, results, progress, achievements, user files, comments, assignments …
      // Notices pointing at the app, its review or its assignments would lead nowhere and may quote its name.
      deleteAppNotices(app.id, assignments.map((x) => x.id));
      audit(actor, 'app_geloescht', app.name, '', { appId: app.id });
      return found;
    }, { durable: true });
    uploads.collectGarbage(code);
    ctx.userFiles.collectGarbage(files);
  }

  // ---------- personal data ----------
  /** Remove everything one user stored in one app. */
  function deleteAppData(appId, userId) {
    const files = ctx.userFiles.shasOfAppUser(appId, userId);
    db.tx(() => {
      // fixed table names, never user input
      for (const table of ['saves', 'scores', 'results', 'plays', 'progress', 'achievements', 'user_files']) {
        db.run(`DELETE FROM ${table} WHERE app_id = ? AND user_id = ?`, appId, userId);
      }
    }, { durable: true });
    ctx.userFiles.collectGarbage(files);
  }

  /**
   * Drop what a session keeps for one more page view - a waiting message ("„Marlenes Spiel“ ist
   * freigegeben"), typed form values, the page to return to - wherever it mentions one of `words`.
   * The rest of the session (who is signed in) stays.
   */
  function scrubSessions(words) {
    for (const word of new Set(words)) {
      if (typeof word !== 'string' || word.length < 2) continue;
      const needle = JSON.stringify(word).slice(1, -1); // how the word appears inside the stored JSON
      for (const s of db.all('SELECT sid_hash, data FROM sessions WHERE instr(data, ?) > 0', needle)) {
        let data;
        try {
          data = JSON.parse(s.data);
        } catch {
          continue;
        }
        for (const key of ['flash', 'formState', 'returnTo']) {
          if (data[key] !== undefined && JSON.stringify(data[key]).includes(needle)) delete data[key];
        }
        db.run('UPDATE sessions SET data = ? WHERE sid_hash = ?', JSON.stringify(data), s.sid_hash);
      }
    }
  }

  /**
   * Other people's in-Hub notices about one app: pointing at the app, at its review, or at one of
   * its assignments. Ids are fixed-length random strings, so a prefix of the full id is exact.
   * Links are compared as ranges ("starts with"), so the index on notices.href is used - never a
   * pass over every notice of the school per app.
   */
  function deleteAppNotices(appId, assignmentIds) {
    const prefix = `/apps/${appId}`;
    db.run('DELETE FROM notices WHERE href >= ? AND href < ?', prefix, prefixEnd(prefix));
    db.run("DELETE FROM notices WHERE href >= '/pruefen/' AND href < '/pruefen0' AND instr(href, ?) > 0", `/${appId}`);
    for (const id of assignmentIds) db.run('DELETE FROM notices WHERE href = ?', `/aufgaben/${id}`);
  }

  /**
   * Feedback notices that quote an app or one of its assignments by name („…“), sent to the students
   * who got feedback about it. Call while the app and its feedback links still exist.
   */
  function deleteFeedbackNotices(apps, assignments) {
    if (!apps.length) return;
    const quoted = [...apps.map((a) => a.name), ...assignments.map((x) => x.title)].map((n) => `„${n}“`);
    const ids = apps.map((a) => a.id);
    const marks = ids.map(() => '?').join(', ');
    const told = db.all(
      `SELECT DISTINCT student_id FROM feedback
        WHERE app_id IN (${marks}) OR assignment_id IN (SELECT id FROM assignments WHERE app_id IN (${marks}))`,
      ...ids, ...ids
    );
    for (const { student_id: sid } of told) for (const q of quoted) db.run("DELETE FROM notices WHERE user_id = ? AND kind = 'rueckmeldung' AND instr(text, ?) > 0", sid, q);
  }

  /** Delete an account and everything that belongs to it. */
  function deleteUser(actor, user) {
    const ownApps = db.all('SELECT id FROM apps WHERE owner_id = ?', user.id).map((r) => r.id);
    const userFileShas = [...ctx.userFiles.shasOfUser(user.id), ...ownApps.flatMap((id) => ctx.userFiles.shasOfApp(id))];
    const shas = db.tx(() => {
      const list = codeShas(ownApps);
      // Classes where this user was the only teacher go away with them.
      const orphaned = db.all(
        `SELECT c.id FROM classes c JOIN class_members m ON m.class_id = c.id AND m.user_id = ? AND m.role = 'teacher'
          WHERE NOT EXISTS (SELECT 1 FROM class_members o WHERE o.class_id = c.id AND o.role = 'teacher' AND o.user_id <> ?)`,
        user.id, user.id
      );
      for (const c of orphaned) {
        deleteClassNotices(c.id);
        db.run('DELETE FROM shared_data WHERE class_id = ?', c.id);
        db.run('DELETE FROM classes WHERE id = ?', c.id);
      }
      db.run('DELETE FROM sessions WHERE user_id = ?', user.id);
      // Their apps go too, and with them every trace of their names (app names are often personal,
      // e.g. "Marlenes Spiel"). Audit entries about an app carry its id: the person's apps are the
      // ones they own now and the ones they ever created (their own entries say so - read before
      // those entries lose the person's id). Never by name: other people's entries about their own
      // apps or classes with the same name stay as they are, and a long history costs one statement.
      const apps = db.all('SELECT id, name FROM apps WHERE owner_id = ?', user.id);
      const assignmentsOnApps = db.all('SELECT x.id, x.app_id, x.title FROM assignments x JOIN apps a ON a.id = x.app_id WHERE a.owner_id = ?', user.id);
      db.run(
        `WITH mine(id) AS (
           SELECT id FROM apps WHERE owner_id = ?
           UNION SELECT app_id FROM audit_log WHERE actor_id = ? AND app_id IS NOT NULL AND action IN ('app_erstellt', 'app_aus_vorlage'))
         UPDATE audit_log SET target = CASE WHEN action LIKE 'aufgabe%' THEN 'Gelöschte Aufgabe' ELSE 'Gelöschte App' END,
                              detail = CASE WHEN actor_id = ? THEN '' ELSE detail END
          WHERE app_id IN (SELECT id FROM mine)`,
        user.id, user.id, user.id
      );
      // Entries written before entries carried their app (schema version < 4): the person's own app entries.
      db.run(`UPDATE audit_log SET target = 'Gelöschte App', detail = '' WHERE actor_id = ? AND app_id IS NULL AND ${APP_ACTIONS}`, user.id);
      db.run("UPDATE audit_log SET actor_id = NULL, actor_label = 'Gelöschtes Konto' WHERE actor_id = ?", user.id);
      // Entries ABOUT the person keep what happened, but not who it was.
      db.run("UPDATE audit_log SET target = 'Gelöschtes Konto', detail = '', subject_id = NULL WHERE subject_id = ?", user.id);
      // Older entries without a subject: account actions whose target is exactly this name.
      db.run(
        `UPDATE audit_log SET target = 'Gelöschtes Konto', detail = '' WHERE subject_id IS NULL AND target = ?
           AND action IN ('rolle_geaendert','konto_gesperrt','konto_entsperrt','konto_markiert','konto_geloescht')`,
        user.name
      );
      // Notices to other people that name this person go with them.
      db.run('DELETE FROM notices WHERE subject_id = ?', user.id);
      // Columns that keep a person's id without a foreign key: the row stays, the person goes.
      for (const [table, col] of ID_COLUMNS_SET_NULL) db.run(`UPDATE ${table} SET ${col} = NULL WHERE ${col} = ?`, user.id);

      // Other people's notices about their apps: pointing at an app, its review, or an assignment
      // built on it (those assignments go with the app). Apps deleted earlier took theirs along
      // (deleteApp), so today's apps are all that is left - at most limits.maxAppsPerUser.
      for (const a of apps) deleteAppNotices(a.id, assignmentsOnApps.filter((x) => x.app_id === a.id).map((x) => x.id));
      // ... and feedback about such an app or assignment, which quoted its name to the student.
      deleteFeedbackNotices(apps, assignmentsOnApps);

      // A one-time message still waiting in someone else's session may name them or one of their apps.
      scrubSessions([user.name, user.email, user.id, ...apps.map((a) => a.name)]);

      // cascades: memberships, apps (+ versions, drafts, assignments on them), saves, scores, results,
      // progress, achievements, files, favourites, feedback to them, notices, comments
      db.run('DELETE FROM users WHERE id = ?', user.id);
      // The audit entry names the role, never the person (their data is gone).
      const roleLabel = { student: 'Schüler/in', teacher: 'Lehrkraft', admin: 'Admin' }[user.role] || '';
      audit(actor && actor.id !== user.id ? actor : null, 'konto_geloescht', `Konto (${roleLabel})`, actor && actor.id !== user.id ? 'durch Verwaltung' : 'durch Nutzer/in selbst');
      return list;
    }, { durable: true });
    uploads.collectGarbage(shas);
    ctx.userFiles.collectGarbage(userFileShas);
  }

  return {
    announcementLink,
    audit, pruneAudit, notify, recordPlay, maintenance,
    createClass, createJoinCode, deleteClass, appFields, createApp, createVersion, finishVersion, versionFromDraft, deleteVersion, publish, deleteApp, deleteAppData, deleteUser,
  };
}

module.exports = { createServices, ID_COLUMNS_SET_NULL, ID_COLUMNS_HANDLED };
