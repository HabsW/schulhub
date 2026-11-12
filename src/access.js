'use strict';
// THE permission module. Every "may this user touch this exact thing?"
// question is answered here, from the database only. Routes never decide
// on their own, and nothing the browser sends (role, owner, ids) is trusted.

function createAccess(db) {
  const isAdmin = (user) => Boolean(user) && user.role === 'admin';

  /** 'teacher' | 'student' | null - the user's role inside one class. */
  function classRole(user, classId) {
    if (!user || typeof classId !== 'string') return null;
    const row = db.get('SELECT role FROM class_members WHERE class_id = ? AND user_id = ?', classId, user.id);
    return row ? row.role : null;
  }

  // ----- classes -----
  const canCreateClass = (user) => Boolean(user) && (user.role === 'teacher' || user.role === 'admin');
  const canViewClass = (user, classId) => isAdmin(user) || classRole(user, classId) !== null;
  const canManageClass = (user, classId) => isAdmin(user) || classRole(user, classId) === 'teacher';

  // ----- apps -----
  /** Owner (or admin): edit, upload, publish, delete. */
  const canManageApp = (user, app) => Boolean(user && app) && (app.owner_id === user.id || isAdmin(user));

  /** Classes in which this user is a teacher and the app was added or submitted. */
  function reviewClasses(user, app) {
    if (!user || !app) return [];
    return db.all(
      `SELECT c.id, c.name, ca.status, ca.version_id, ca.requested_version_id
         FROM class_apps ca
         JOIN classes c ON c.id = ca.class_id
         JOIN class_members m ON m.class_id = ca.class_id AND m.user_id = ? AND m.role = 'teacher'
        WHERE ca.app_id = ?`,
      user.id, app.id
    );
  }

  /** May open the app's page: comments, and the versions allowed by canSeeVersion. */
  const canReviewApp = (user, app) => canManageApp(user, app) || reviewClasses(user, app).length > 0;

  /**
   * Preview, source code and download of ONE version. The owner sees all of
   * their versions. A teacher only sees versions that were submitted to or
   * approved in one of their classes - never the owner's private drafts.
   */
  function canSeeVersion(user, app, versionId) {
    if (canManageApp(user, app)) return true;
    return reviewClasses(user, app).some((c) => c.version_id === versionId || c.requested_version_id === versionId);
  }

  /**
   * Decide what (if anything) this user may run.
   * Returns { version, classId, preview } or null.
   *  - versionId given: private preview of exactly that version (owner / reviewing teacher / admin)
   *  - classId given: the version approved for that class
   *  - neither: owner's published version, school-wide release, or any of the user's classes
   */
  function resolvePlay(user, app, { classId = null, versionId = null } = {}) {
    if (!user || !app) return null;
    const ready = (id) => (id ? db.get("SELECT * FROM app_versions WHERE id = ? AND app_id = ? AND status = 'ready'", id, app.id) : null);

    if (versionId) {
      if (!canSeeVersion(user, app, versionId)) return null;
      const version = ready(versionId);
      if (!version) return null;
      if (classId && !canViewClass(user, classId)) return null;
      return { version, classId: classId || null, preview: true };
    }

    if (classId) {
      if (!canViewClass(user, classId)) return null;
      const row = db.get("SELECT version_id FROM class_apps WHERE class_id = ? AND app_id = ? AND status = 'approved'", classId, app.id);
      const version = row && ready(row.version_id);
      return version ? { version, classId, preview: false } : null;
    }

    // One of the user's classes that has the app (gives the app a class context).
    const viaClass = db.get(
      `SELECT ca.class_id, ca.version_id FROM class_apps ca
         JOIN class_members m ON m.class_id = ca.class_id AND m.user_id = ?
        WHERE ca.app_id = ? AND ca.status = 'approved' AND ca.version_id IS NOT NULL
        ORDER BY ca.created_at LIMIT 1`,
      user.id, app.id
    );
    if (canManageApp(user, app) && ready(app.published_version_id)) {
      return { version: ready(app.published_version_id), classId: viaClass ? viaClass.class_id : null, preview: false };
    }
    if (viaClass && ready(viaClass.version_id)) return { version: ready(viaClass.version_id), classId: viaClass.class_id, preview: false };
    if (ready(app.schoolwide_version_id)) return { version: ready(app.schoolwide_version_id), classId: null, preview: false };
    return null;
  }

  // ----- app data of other people -----
  /**
   * A teacher may look at a student's data in an app only if the student is in
   * one of the teacher's classes AND the app is approved in that same class.
   * Owning an app does NOT give access to other people's data in it.
   */
  function canSeeStudentData(user, classId, appId, studentId) {
    if (!canManageClass(user, classId)) return false;
    const inClass = db.get("SELECT 1 AS ok FROM class_members WHERE class_id = ? AND user_id = ? AND role = 'student'", classId, studentId);
    const appInClass = db.get("SELECT 1 AS ok FROM class_apps WHERE class_id = ? AND app_id = ? AND status = 'approved'", classId, appId);
    return Boolean(inClass && appInClass);
  }

  return { isAdmin, classRole, canCreateClass, canViewClass, canManageClass, canManageApp, canReviewApp, canSeeVersion, reviewClasses, resolvePlay, canSeeStudentData };
}

module.exports = { createAccess };
