'use strict';
// The life of an app inside a class. EVERY change to class_apps goes through
// here, so the rules hold everywhere:
//
//   status    approved  the class plays version_id
//             pending   not playable; a request waits (never approved, or removed earlier)
//             rejected  not playable; the last request was given back
//             removed   not playable any more; version_id is kept so the teacher
//                       can still read the results that were made with it
//   request   requested_version_id + request_state 'waiting' | 'returned'.
//             A returned version stays visible to its reviewer.
//
// Approval is always bound to the exact version the teacher looked at.
// Permission checks happen in the routes (access.js) BEFORE these are called;
// these functions check that the STATE allows the step.

const { bad, cleanText, newId } = require('./util');

function createClassApps(ctx) {
  const { db, access } = ctx;
  const services = () => ctx.services;

  const get = (classId, appId) => db.get('SELECT * FROM class_apps WHERE class_id = ? AND app_id = ?', classId, appId);
  const teachersOf = (classId) => db.all("SELECT user_id FROM class_members WHERE class_id = ? AND role = 'teacher'", classId).map((r) => r.user_id);
  const versionNumber = (id) => (id ? db.get('SELECT number FROM app_versions WHERE id = ?', id)?.number : null);
  function timeline(actor, app, cls, kind, versionId, body = '') {
    db.run(
      'INSERT INTO comments (id, app_id, author_id, body, created_at, kind, version_id, class_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      newId(), app.id, actor ? actor.id : null, body, Date.now(), kind, versionId, cls.id
    );
  }

  /**
   * Put an app into a class. mode comes from access.addToClassMode():
   * 'approve' (a teacher of the class decides at once) or 'submit' (the owner asks).
   * Returns 'approved' or 'waiting'.
   */
  function add(actor, cls, app, mode) {
    if (!app.published_version_id) throw bad('Diese App ist noch nicht veröffentlicht.');
    const row = get(cls.id, app.id);
    if (mode === 'approve') {
      if (row && row.status === 'approved') throw bad('Diese App ist schon in der Klasse.');
      const own = app.owner_id === actor.id || access.isSharedWith(actor, app);
      const version = own ? app.published_version_id : app.schoolwide_version_id;
      const now = Date.now();
      db.tx(() => {
        db.run(
          `INSERT INTO class_apps (class_id, app_id, status, version_id, requested_version_id, request_state, added_by, decided_by, decided_at, created_at)
           VALUES (?, ?, 'approved', ?, NULL, NULL, ?, ?, ?, ?)
           ON CONFLICT (class_id, app_id) DO UPDATE SET status = 'approved', version_id = excluded.version_id,
             requested_version_id = NULL, request_state = NULL, decided_by = excluded.decided_by, decided_at = excluded.decided_at`,
          cls.id, app.id, version, actor.id, actor.id, now, now
        );
        services().audit(actor, 'app_zugewiesen', app.name, cls.name);
      });
      return 'approved';
    }
    submit(actor, cls, app);
    return 'waiting';
  }

  /** The owner asks the class's teachers to review the current published version (first time or again). */
  function submit(actor, cls, app) {
    // Withdraw-and-resubmit in a loop would flood the teacher: a person submits a bounded number per hour.
    ctx.limiter.guard('submit', actor.id);
    const v = app.published_version_id;
    if (!v) throw bad('Diese App ist noch nicht veröffentlicht.');
    const row = get(cls.id, app.id);
    if (row && row.status === 'approved' && row.version_id === v && !row.requested_version_id) throw bad('Diese Version ist in der Klasse schon freigegeben.');
    if (row && row.request_state === 'waiting' && row.requested_version_id === v) throw bad('Diese Version wartet schon auf die Lehrkraft.');
    db.tx(() => {
      if (row) {
        db.run(
          `UPDATE class_apps SET status = CASE WHEN status = 'approved' THEN 'approved' ELSE 'pending' END,
                  requested_version_id = ?, request_state = 'waiting' WHERE class_id = ? AND app_id = ?`,
          v, cls.id, app.id
        );
      } else {
        db.run("INSERT INTO class_apps (class_id, app_id, status, requested_version_id, request_state, added_by, created_at) VALUES (?, ?, 'pending', ?, 'waiting', ?, ?)", cls.id, app.id, v, actor.id, Date.now());
      }
      timeline(actor, app, cls, 'submitted', v);
      services().audit(actor, 'app_eingereicht', app.name, `${cls.name}, Version ${versionNumber(v)}`);
      services().notify(teachersOf(cls.id), 'pruefen', `„${app.name}“ (Version ${versionNumber(v)}) wartet auf deine Prüfung in ${cls.name}.`, `/pruefen/${cls.id}/${app.id}`);
    });
  }

  /** A teacher approves exactly the version that waits. */
  function approve(actor, cls, app, versionId, note = '') {
    const row = get(cls.id, app.id);
    if (!row || row.request_state !== 'waiting' || !versionId || row.requested_version_id !== versionId) {
      throw bad('Diese Version steht nicht (mehr) zur Freigabe. Bitte lade die Seite neu.');
    }
    db.tx(() => {
      db.run(
        `UPDATE class_apps SET status = 'approved', version_id = ?, requested_version_id = NULL, request_state = NULL,
                decided_by = ?, decided_at = ? WHERE class_id = ? AND app_id = ?`,
        versionId, actor.id, Date.now(), cls.id, app.id
      );
      timeline(actor, app, cls, 'approved', versionId, cleanText(note, 2000, { multiline: true }));
      services().audit(actor, 'app_freigegeben', app.name, `${cls.name}, Version ${versionNumber(versionId)}`);
      if (app.owner_id !== actor.id) services().notify([app.owner_id], 'freigegeben', `„${app.name}“ ist jetzt in ${cls.name} freigegeben.`, `/apps/${app.id}`);
    });
  }

  /**
   * A teacher gives the waiting version back, with a reason (required: it is
   * what the student needs to improve the app). An approved older version stays
   * in use; the returned one stays visible to the teacher; the owner can resubmit.
   */
  function giveBack(actor, cls, app, versionId, reason) {
    const row = get(cls.id, app.id);
    if (!row || row.request_state !== 'waiting' || !versionId || row.requested_version_id !== versionId) {
      throw bad('Diese Version steht nicht (mehr) zur Prüfung. Bitte lade die Seite neu.');
    }
    const text = cleanText(reason, 2000, { multiline: true });
    if (text.length < 3) throw bad('Bitte schreib kurz, was noch fehlt – das hilft beim Verbessern.');
    db.tx(() => {
      db.run(
        `UPDATE class_apps SET status = CASE WHEN status = 'approved' THEN 'approved' ELSE 'rejected' END,
                request_state = 'returned', decided_by = ?, decided_at = ? WHERE class_id = ? AND app_id = ?`,
        actor.id, Date.now(), cls.id, app.id
      );
      timeline(actor, app, cls, 'returned', versionId, text);
      services().audit(actor, 'app_zurueckgegeben', app.name, `${cls.name}, Version ${versionNumber(versionId)}`);
      services().notify([app.owner_id], 'zurueckgegeben', `„${app.name}“ wurde in ${cls.name} zurückgegeben. Schau dir an, was noch fehlt.`, `/apps/${app.id}`);
    });
  }

  /** The owner takes back a waiting or returned request (the approved version, if any, stays). */
  function withdraw(actor, cls, app) {
    const row = get(cls.id, app.id);
    if (!row || !row.requested_version_id) throw bad('Hier wartet nichts, das du zurückziehen könntest.');
    db.tx(() => {
      if (row.status === 'approved') {
        db.run('UPDATE class_apps SET requested_version_id = NULL, request_state = NULL WHERE class_id = ? AND app_id = ?', cls.id, app.id);
      } else if (row.version_id) {
        db.run("UPDATE class_apps SET status = 'removed', requested_version_id = NULL, request_state = NULL WHERE class_id = ? AND app_id = ?", cls.id, app.id);
      } else {
        db.run('DELETE FROM class_apps WHERE class_id = ? AND app_id = ?', cls.id, app.id);
      }
      services().audit(actor, 'einreichung_zurueckgezogen', app.name, cls.name);
    });
  }

  /**
   * Take an app out of a class (teacher, or the owner for their own app). If it
   * was ever approved, the row stays as 'removed' so its results remain readable
   * for the teacher; otherwise it is deleted.
   */
  function remove(actor, cls, app) {
    const row = get(cls.id, app.id);
    if (!row || row.status === 'removed') throw bad('Diese App ist nicht (mehr) in der Klasse.');
    db.tx(() => {
      if (row.version_id) {
        db.run("UPDATE class_apps SET status = 'removed', requested_version_id = NULL, request_state = NULL, decided_by = ?, decided_at = ? WHERE class_id = ? AND app_id = ?", actor.id, Date.now(), cls.id, app.id);
      } else {
        db.run('DELETE FROM class_apps WHERE class_id = ? AND app_id = ?', cls.id, app.id);
      }
      services().audit(actor, 'app_aus_klasse_entfernt', app.name, cls.name);
    });
  }

  /** A teacher brings a removed app back with the version it had. */
  function restore(actor, cls, app) {
    const row = get(cls.id, app.id);
    if (!row || row.status !== 'removed' || !row.version_id) throw bad('Diese App kann nicht zurückgeholt werden.');
    db.run("UPDATE class_apps SET status = 'approved', decided_by = ?, decided_at = ? WHERE class_id = ? AND app_id = ?", actor.id, Date.now(), cls.id, app.id);
    services().audit(actor, 'app_zurueckgeholt', app.name, cls.name);
  }

  /**
   * After the owner published a new version: classes where the publisher is a
   * teacher (or the admin publishes) follow at once; everywhere else the class
   * keeps its approved version and the new one waits. Removed apps stay removed.
   */
  function onPublish(actor, app, version) {
    for (const row of db.all("SELECT ca.class_id, ca.status, ca.version_id, c.name FROM class_apps ca JOIN classes c ON c.id = ca.class_id WHERE ca.app_id = ? AND ca.status <> 'removed' AND c.archived_at IS NULL", app.id)) {
      const trusted = actor.role === 'admin' || access.classRole(actor, row.class_id) === 'teacher';
      if (trusted) {
        db.run(
          `UPDATE class_apps SET status = 'approved', version_id = ?, requested_version_id = NULL, request_state = NULL,
                  decided_by = ?, decided_at = ? WHERE class_id = ? AND app_id = ?`,
          version.id, actor.id, Date.now(), row.class_id, app.id
        );
      } else if (row.version_id !== version.id) {
        db.run(
          `UPDATE class_apps SET requested_version_id = ?, request_state = 'waiting',
                  status = CASE WHEN status = 'approved' THEN 'approved' ELSE 'pending' END WHERE class_id = ? AND app_id = ?`,
          version.id, row.class_id, app.id
        );
        timeline(actor, app, { id: row.class_id }, 'submitted', version.id);
        services().notify(teachersOf(row.class_id), 'pruefen', `Neue Version ${version.number} von „${app.name}“ wartet auf deine Prüfung in ${row.name}.`, `/pruefen/${row.class_id}/${app.id}`);
      }
    }
  }

  return { get, add, submit, approve, giveBack, withdraw, remove, restore, onPublish, teachersOf };
}

module.exports = { createClassApps };
