'use strict';
// THE permission module. Every "may this user touch this exact thing?"
// question is answered here, from the database only. Routes never decide
// on their own, and nothing the browser sends (role, owner, ids) is trusted.

function createAccess(db) {
  /** Two ids name the same person or row only if they are real ids: a missing id (undefined, null, '') is nobody's. */
  const sameId = (a, b) => typeof a === 'string' && a !== '' && a === b;
  const isAdmin = (user) => Boolean(user) && user.role === 'admin';
  /** Staff: may create classes, use colleagues' shared apps, accept co-teacher invitations. */
  const isStaff = (user) => Boolean(user) && (user.role === 'teacher' || user.role === 'admin');

  /** 'teacher' | 'student' | null - the user's role inside one class. */
  function classRole(user, classId) {
    if (!user || typeof classId !== 'string') return null;
    const row = db.get('SELECT role FROM class_members WHERE class_id = ? AND user_id = ?', classId, user.id);
    return row ? row.role : null;
  }
  const classRow = (classId) => (typeof classId === 'string' ? db.get('SELECT * FROM classes WHERE id = ?', classId) : null);
  const isArchived = (classId) => Boolean(classRow(classId)?.archived_at);

  // ----- classes -----
  const canCreateClass = isStaff;
  /**
   * Members see their class. An archived class (end of the school year) is
   * read-only and only its teachers (and the admin) still see it.
   */
  function canViewClass(user, classId) {
    if (isAdmin(user)) return Boolean(classRow(classId));
    const role = classRole(user, classId);
    if (!role) return false;
    return role === 'teacher' || !isArchived(classId);
  }
  /** Teachers of the class (and the admin): see everything in it, archive, restore, delete. */
  const canManageClass = (user, classId) => (isAdmin(user) ? Boolean(classRow(classId)) : classRole(user, classId) === 'teacher');
  /** Change the class or its content (apps, codes, assignments, feedback, settings): never while archived. */
  const canChangeClass = (user, classId) => canManageClass(user, classId) && !isArchived(classId);

  /**
   * Which membership a join code may create for this user, or null.
   * A normal code ALWAYS makes a student (even for a teacher account). A teacher
   * invitation (co-teachers) only works for staff accounts. Nobody joins an
   * archived class. Expiry and the code itself are checked by the caller.
   */
  function joinRoleFor(user, code) {
    if (!user || !code || isArchived(code.class_id)) return null;
    if ((code.role || 'student') === 'student') return removedSince(user, code) ? null : 'student';
    return code.role === 'teacher' && isStaff(user) ? 'teacher' : null;
  }
  /** A teacher removed this person from the code's class after the code was made: it does not let them back in. */
  const removedSince = (user, code) =>
    Boolean(user && code && typeof user.id === 'string' && typeof code.class_id === 'string') &&
    Boolean(db.get('SELECT 1 AS removed FROM class_removals WHERE class_id = ? AND user_id = ? AND removed_at >= ?', code.class_id, user.id, Number(code.created_at) || 0));

  // ----- apps -----
  /** Owner (or admin): edit, upload, use the editor, publish, delete, see usage numbers. */
  const canManageApp = (user, app) => Boolean(user && app) && (sameId(app.owner_id, user.id) || isAdmin(user));
  const ownerIsStaff = (app) => Boolean(app) && isStaff(db.get('SELECT role FROM users WHERE id = ?', app.owner_id));
  /** Only staff may share their own apps with colleagues (students' apps go through review). */
  const canShareApp = (user, app) => canManageApp(user, app) && ownerIsStaff(app);
  /** A colleague's app that its (staff) owner shared, usable by any staff member. */
  const isSharedWith = (user, app) => Boolean(app && app.shared) && isStaff(user) && ownerIsStaff(app) && Boolean(app.published_version_id);

  /** Classes in which this user is a teacher and the app was added, submitted or returned. */
  function reviewClasses(user, app) {
    if (!user || !app) return [];
    return db.all(
      `SELECT c.id, c.name, c.archived_at, ca.status, ca.version_id, ca.requested_version_id, ca.request_state
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
   * Preview, source code, diff and download of ONE version. The owner sees all
   * of their versions. A teacher sees versions that were submitted to, returned
   * in or approved in one of their classes - never the owner's private drafts -
   * and the published version of an app a colleague shared. Anything that is not a version of
   * this app (null, another app's version) is seen by nobody.
   */
  function canSeeVersion(user, app, versionId) {
    if (!app || typeof versionId !== 'string' || !db.get('SELECT 1 AS ok FROM app_versions WHERE id = ? AND app_id = ?', versionId, app.id)) return false;
    if (canManageApp(user, app)) return true;
    if (reviewClasses(user, app).some((c) => c.version_id === versionId || c.requested_version_id === versionId)) return true;
    return isSharedWith(user, app) && app.published_version_id === versionId;
  }

  /**
   * May this user put this app into this class, and how?
   *  'approve' - a teacher of the class adds an app they may use: their own, a
   *              colleague's shared app, or a school-wide app
   *  'submit'  - the owner (e.g. a student) asks the class's teacher to review it
   *  null      - not allowed
   */
  function addToClassMode(user, app, classId) {
    if (!user || !app || !app.published_version_id || !canViewClass(user, classId) || isArchived(classId)) return null;
    const own = sameId(app.owner_id, user.id);
    if (canChangeClass(user, classId) && (own || isSharedWith(user, app) || app.schoolwide_version_id)) return 'approve';
    return own ? 'submit' : null;
  }

  /**
   * Decide what (if anything) this user may run.
   * Returns { version, classId, preview } or null.
   *  - versionId given: private preview of exactly that version (owner / reviewing teacher / admin,
   *    and a colleague trying the published version of a shared app - see canSeeVersion)
   *  - classId given: the version approved for that class
   *  - neither: owner's published version, school-wide release, or any of the user's classes -
   *    or, for staff, a colleague's shared app: its published version as a preview (nothing is
   *    stored), to try it before adding it to a class
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

    // One of the user's (active) classes that has the app (gives the app a class context).
    const viaClass = db.get(
      `SELECT ca.class_id, ca.version_id FROM class_apps ca
         JOIN class_members m ON m.class_id = ca.class_id AND m.user_id = ?
         JOIN classes c ON c.id = ca.class_id AND c.archived_at IS NULL
        WHERE ca.app_id = ? AND ca.status = 'approved' AND ca.version_id IS NOT NULL
        ORDER BY ca.created_at LIMIT 1`,
      user.id, app.id
    );
    if (canManageApp(user, app) && ready(app.published_version_id)) {
      return { version: ready(app.published_version_id), classId: viaClass ? viaClass.class_id : null, preview: false };
    }
    if (viaClass && ready(viaClass.version_id)) return { version: ready(viaClass.version_id), classId: viaClass.class_id, preview: false };
    if (ready(app.schoolwide_version_id)) return { version: ready(app.schoolwide_version_id), classId: null, preview: false };
    if (isSharedWith(user, app) && ready(app.published_version_id)) return { version: ready(app.published_version_id), classId: null, preview: true };
    return null;
  }

  // ----- app data of other people -----
  /**
   * A teacher may look at a student's data in an app only if the student is in
   * one of the teacher's classes AND the app is (or was, before it was removed)
   * in use in that same class. Owning an app does NOT give access to other
   * people's data in it.
   */
  function canSeeStudentData(user, classId, appId, studentId) {
    if (!canManageClass(user, classId)) return false;
    const inClass = db.get("SELECT 1 AS ok FROM class_members WHERE class_id = ? AND user_id = ? AND role = 'student'", classId, studentId);
    return Boolean(inClass && wasApprovedIn(classId, appId));
  }
  /**
   * The app is (or was) in use in this class: approved now, or approved once - then the row keeps
   * the version the class used (version_id; only an approval ever sets it), whatever happened since:
   * taken out ('removed'), submitted again by its owner ('pending') or that new submission given
   * back ('rejected'). Results made in the class stay readable for its teachers through all of these.
   */
  const wasApprovedIn = (classId, appId) => Boolean(db.get('SELECT 1 AS ok FROM class_apps WHERE class_id = ? AND app_id = ? AND version_id IS NOT NULL', classId, appId));
  const isStudentOf = (classId, studentId) => Boolean(db.get("SELECT 1 AS ok FROM class_members WHERE class_id = ? AND user_id = ? AND role = 'student'", classId, studentId));
  const appApprovedIn = (classId, appId) => Boolean(db.get("SELECT 1 AS ok FROM class_apps WHERE class_id = ? AND app_id = ? AND status = 'approved'", classId, appId));

  // ----- assignments -----
  /** Create an assignment: a teacher of an active class, for an app approved in that class. */
  const canAssign = (user, classId, appId) => canChangeClass(user, classId) && appApprovedIn(classId, appId);
  /**
   * The class's teachers (and the admin) see every assignment of it. Students see one only
   * from its start: before that, nothing of a planned assignment (title, note, link) reaches them.
   */
  const canSeeAssignment = (user, a) =>
    Boolean(a) && canViewClass(user, a.class_id) && (canManageClass(user, a.class_id) || a.starts_at <= Date.now());
  const canManageAssignment = (user, a) => Boolean(a) && canChangeClass(user, a.class_id);
  /** Only the student themself marks an assignment as done. */
  const canMarkDone = (user, a) => Boolean(user && a) && isStudentOf(a.class_id, user.id) && !isArchived(a.class_id);

  // ----- feedback (teacher -> one student, private) -----
  const canGiveFeedback = (user, classId, studentId) => canChangeClass(user, classId) && isStudentOf(classId, studentId);
  /** The student it is for, and the teachers of that class. */
  const canReadFeedback = (user, f) => Boolean(user && f) && (sameId(f.student_id, user.id) || canManageClass(user, f.class_id));
  /** The author while the class may change (an archived class is read-only), the student (it is their data), the admin. */
  const canDeleteFeedback = (user, f) =>
    Boolean(user && f) && ((sameId(f.author_id, user.id) && canChangeClass(user, f.class_id)) || sameId(f.student_id, user.id) || isAdmin(user));

  // ----- per-class app settings (declared in schulhub.json) -----
  const canEditAppSettings = (user, classId, appId) => canChangeClass(user, classId) && appApprovedIn(classId, appId);

  // ----- announcements -----
  /** Whole school: admin. One class: its teachers. */
  const canAnnounce = (user, classId) => (classId ? canChangeClass(user, classId) : isAdmin(user));
  const canSeeAnnouncement = (user, a) => Boolean(user && a) && (a.class_id ? canViewClass(user, a.class_id) : true);
  const canDeleteAnnouncement = (user, a) => Boolean(user && a) && (a.class_id ? canManageClass(user, a.class_id) : isAdmin(user));

  // ----- multiplayer (prepared, NOT enabled; see SECURITY.md) -----
  /** Only inside an active class, only for an app approved there, only if its teacher switched multiplayer on. */
  function canJoinRoom(user, app, classId) {
    if (!user || !app || !classId || !canViewClass(user, classId) || isArchived(classId)) return false;
    return Boolean(db.get("SELECT 1 AS ok FROM class_apps WHERE class_id = ? AND app_id = ? AND status = 'approved' AND multiplayer = 1", classId, app.id));
  }

  // ----- lists filtered by permission (search, catalogue, start page) -----
  /**
   * Apps this user can open, with how: own (published), approved in one of
   * their active classes, released school-wide, or shared with staff (a colleague's
   * shared app that is none of the others opens as a preview of its published version).
   * q: optional search text (matched against name/description), category: exact.
   */
  function visibleApps(user, { q = '', category = '', limit = 60 } = {}) {
    if (!user) return [];
    const like = q ? `%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`).slice(0, 60)}%` : '';
    return db.all(
      `SELECT a.*,
              (a.owner_id = ?) AS mine,
              EXISTS (SELECT 1 FROM class_apps ca JOIN class_members m ON m.class_id = ca.class_id AND m.user_id = ?
                        JOIN classes c ON c.id = ca.class_id AND c.archived_at IS NULL
                       WHERE ca.app_id = a.id AND ca.status = 'approved') AS in_class,
              (a.schoolwide_version_id IS NOT NULL) AS schoolwide,
              (a.shared = 1 AND ? = 1 AND EXISTS (SELECT 1 FROM users o WHERE o.id = a.owner_id AND o.role IN ('teacher','admin'))) AS shared_staff
         FROM apps a
        WHERE a.published_version_id IS NOT NULL
          AND (a.owner_id = ? OR a.schoolwide_version_id IS NOT NULL
               OR EXISTS (SELECT 1 FROM class_apps ca JOIN class_members m ON m.class_id = ca.class_id AND m.user_id = ?
                            JOIN classes c ON c.id = ca.class_id AND c.archived_at IS NULL
                           WHERE ca.app_id = a.id AND ca.status = 'approved')
               OR (a.shared = 1 AND ? = 1 AND EXISTS (SELECT 1 FROM users o WHERE o.id = a.owner_id AND o.role IN ('teacher','admin'))))
          AND (? = '' OR a.name LIKE ? ESCAPE '\\' OR a.description LIKE ? ESCAPE '\\')
          AND (? = '' OR a.category = ?)
        ORDER BY a.name COLLATE NOCASE LIMIT ?`,
      user.id, user.id, isStaff(user) ? 1 : 0, user.id, user.id, isStaff(user) ? 1 : 0, like, like, like, category, category, Math.min(Math.max(limit, 1), 200)
    );
  }

  /** Classes this user belongs to (admin: all). Archived ones only for their teachers. */
  function visibleClasses(user, { q = '', archived = false } = {}) {
    if (!user) return [];
    const like = q ? `%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`).slice(0, 60)}%` : '';
    if (isAdmin(user)) {
      return db.all(
        `SELECT c.*, NULL AS my_role FROM classes c
          WHERE (? = '' OR c.name LIKE ? ESCAPE '\\') AND ((? = 1) = (c.archived_at IS NOT NULL))
          ORDER BY c.name COLLATE NOCASE`,
        like, like, archived ? 1 : 0
      );
    }
    return db.all(
      `SELECT c.*, m.role AS my_role FROM classes c JOIN class_members m ON m.class_id = c.id AND m.user_id = ?
        WHERE (? = '' OR c.name LIKE ? ESCAPE '\\')
          AND ((? = 1) = (c.archived_at IS NOT NULL))
          AND (c.archived_at IS NULL OR m.role = 'teacher')
        ORDER BY c.name COLLATE NOCASE`,
      user.id, like, like, archived ? 1 : 0
    );
  }

  // ----- package A -----
  /**
   * Leave a class oneself: a student may always leave an active class; a
   * teacher only while another teacher remains who can sign in (otherwise the
   * class would be orphaned - archive or delete it instead; a blocked account
   * teaches nobody). Archived classes are read-only.
   */
  function canLeaveClass(user, classId) {
    const role = classRole(user, classId);
    if (!role || isArchived(classId)) return false;
    if (role === 'student') return true;
    return Boolean(db.get(
      "SELECT 1 AS ok FROM class_members m JOIN users u ON u.id = m.user_id AND u.disabled = 0 WHERE m.class_id = ? AND m.role = 'teacher' AND m.user_id <> ?",
      classId, user.id
    ));
  }
  /**
   * Results of one app in one class (lists, overview, CSV): the class's teachers
   * (and the admin), while the app is approved there - or after it was removed,
   * also while it waits there again (wasApprovedIn).
   */
  const canSeeClassResults = (user, classId, appId) => canManageClass(user, classId) && wasApprovedIn(classId, appId);
  /** Only the student a feedback is for marks it as read. */
  const canMarkFeedbackRead = (user, f) => Boolean(user && f) && sameId(f.student_id, user.id);
  /**
   * Take an app out of a class (or take back one's own submission): the class's
   * teachers (and the admin) for any app, the app's owner for their own app if
   * they can see the class. Archived classes are read-only for everybody.
   * row: the class_apps row of this class, with the app's owner_id.
   */
  function canRemoveFromClass(user, cls, row) {
    if (!user || !cls || !row || row.class_id !== cls.id || isArchived(cls.id)) return false;
    return canChangeClass(user, cls.id) || (sameId(row.owner_id, user.id) && canViewClass(user, cls.id));
  }
  // ----- package B -----
  /**
   * The request of one app in one class that this user may open in the review
   * workbench: the user may change the class (its teacher or the admin, never
   * while archived) and the app's request there is waiting - or was returned,
   * which the workbench shows read-only. Returns the class_apps row or null.
   */
  function reviewRequest(user, classId, appId) {
    if (typeof classId !== 'string' || typeof appId !== 'string' || !canChangeClass(user, classId)) return null;
    return db.get(
      "SELECT * FROM class_apps WHERE class_id = ? AND app_id = ? AND request_state IN ('waiting','returned') AND requested_version_id IS NOT NULL",
      classId, appId
    ) || null;
  }

  /**
   * The owner's own steps with an app in a class - submit, withdraw, take out.
   * Only the owner: the admin manages every app, but never acts as its owner.
   */
  const isAppOwner = (user, app) => Boolean(user && app) && sameId(app.owner_id, user.id);

  /**
   * Delete a comment on an app: only a plain comment (decisions stay as the
   * review record), and only by its author or the admin.
   */
  const canDeleteComment = (user, comment) =>
    Boolean(user && comment) && comment.kind === 'comment' && (sameId(comment.author_id, user.id) || isAdmin(user));

  // ----- package P2 -----
  /**
   * Name and description of a student's app are part of what was approved: while the app is
   * approved or waiting in an active class, released school-wide or waiting for a school-wide
   * update, classmates (or the whole school) see that text without another review - so its
   * owner cannot change it. Staff owners and the admin are not bound by this.
   * Returns null (free to change) or where it is held:
   * { approved: [class names], waiting: [class names with a waiting request], schoolwide }.
   */
  function appTextLock(user, app) {
    if (!user || !app || isAdmin(user) || ownerIsStaff(app)) return null;
    const rows = db.all(
      `SELECT c.name, ca.status, ca.request_state FROM class_apps ca JOIN classes c ON c.id = ca.class_id AND c.archived_at IS NULL
        WHERE ca.app_id = ? AND (ca.status = 'approved' OR ca.request_state = 'waiting') ORDER BY c.name COLLATE NOCASE`,
      app.id
    );
    const approved = rows.filter((r) => r.status === 'approved').map((r) => r.name);
    const waiting = rows.filter((r) => r.request_state === 'waiting').map((r) => r.name);
    const schoolwide = Boolean(app.schoolwide_version_id || app.schoolwide_requested_version_id);
    return approved.length || waiting.length || schoolwide ? { approved, waiting, schoolwide } : null;
  }
  /** Change an app's name and description: whoever manages it, unless appTextLock holds the text. */
  const canEditAppText = (user, app) => canManageApp(user, app) && !appTextLock(user, app);

  return {
    isAdmin, isStaff, classRole, isArchived,
    canCreateClass, canViewClass, canManageClass, canChangeClass, joinRoleFor, removedSince,
    canManageApp, canShareApp, isSharedWith, canReviewApp, canSeeVersion, reviewClasses, addToClassMode, resolvePlay,
    canSeeStudentData, isStudentOf, appApprovedIn, wasApprovedIn,
    canAssign, canSeeAssignment, canManageAssignment, canMarkDone,
    canGiveFeedback, canReadFeedback, canDeleteFeedback,
    canEditAppSettings,
    canAnnounce, canSeeAnnouncement, canDeleteAnnouncement,
    canJoinRoom,
    visibleApps, visibleClasses,
    canLeaveClass, canSeeClassResults, canMarkFeedbackRead, canRemoveFromClass, // package A
    reviewRequest, isAppOwner, canDeleteComment, // package B
    appTextLock, canEditAppText, // package P2
  };
}

module.exports = { createAccess };
