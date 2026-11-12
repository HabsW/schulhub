'use strict';
// Assignments: "work on this app in this class, until then". Whether a student
// is done is DERIVED, the same way everywhere (start page, class overview,
// teacher views), so nobody has to tick boxes:
//
//   done     the student recorded a result in the app IN THIS CLASS after the
//            assignment started, or reached full progress (1.0; progress is
//            personal, not per class) after it started, or
//            marked it done themselves
//   started  the student opened the app after the assignment started
//   open     nothing yet
//
// Permission checks happen in the routes (access.js) before these are called.

function createAssignments(ctx) {
  const { db } = ctx;

  // `x` is the assignment row alias; the SQL is fixed text, values are bound.
  const DONE = `(EXISTS (SELECT 1 FROM assignment_done d WHERE d.assignment_id = x.id AND d.user_id = ?)
      OR EXISTS (SELECT 1 FROM results r WHERE r.app_id = x.app_id AND r.user_id = ? AND r.class_id = x.class_id AND r.created_at >= x.starts_at)
      OR EXISTS (SELECT 1 FROM progress p WHERE p.app_id = x.app_id AND p.user_id = ? AND p.value >= 1 AND p.updated_at >= x.starts_at))`;
  const STARTED = 'EXISTS (SELECT 1 FROM plays pl WHERE pl.app_id = x.app_id AND pl.user_id = ? AND pl.last_at >= x.starts_at)';

  /** Open (not done) assignments of a student in their active classes, most urgent first. */
  function openFor(studentId, { limit = 20 } = {}) {
    return db.all(
      `SELECT x.*, a.name AS app_name, a.emoji, a.color, c.name AS class_name, ${STARTED} AS started
         FROM assignments x
         JOIN classes c ON c.id = x.class_id AND c.archived_at IS NULL
         JOIN class_members m ON m.class_id = x.class_id AND m.user_id = ? AND m.role = 'student'
         JOIN apps a ON a.id = x.app_id
        WHERE x.starts_at <= ? AND NOT ${DONE}
        ORDER BY CASE WHEN x.due_at IS NULL THEN 1 ELSE 0 END, x.due_at, x.created_at
        LIMIT ?`,
      studentId, studentId, Date.now(), studentId, studentId, studentId, limit
    );
  }

  /** 'done' | 'started' | 'open' for one student in one assignment. */
  function stateOf(assignment, studentId) {
    const row = db.get(`SELECT ${DONE} AS done, ${STARTED} AS started FROM assignments x WHERE x.id = ?`, studentId, studentId, studentId, studentId, assignment.id);
    return row && row.done ? 'done' : row && row.started ? 'started' : 'open';
  }

  /** States of all students of the assignment's class: [{ id, name, state, done_at }]. */
  function classStates(assignment) {
    return db
      .all(
        `SELECT u.id, u.name,
                ${DONE.replace(/\?/g, 'u.id')} AS done,
                ${STARTED.replace(/\?/g, 'u.id')} AS started
           FROM class_members m JOIN users u ON u.id = m.user_id
           JOIN assignments x ON x.id = ?
          WHERE m.class_id = x.class_id AND m.role = 'student'
          ORDER BY u.name COLLATE NOCASE`,
        assignment.id
      )
      .map((r) => ({ id: r.id, name: r.name, state: r.done ? 'done' : r.started ? 'started' : 'open' }));
  }

  /** All assignments of a class with counts { done, started, total }, due first. */
  function forClass(classId) {
    return db
      .all(
        `SELECT x.*, a.name AS app_name, a.emoji, a.color FROM assignments x JOIN apps a ON a.id = x.app_id
          WHERE x.class_id = ? ORDER BY CASE WHEN x.due_at IS NULL THEN 1 ELSE 0 END, x.due_at DESC, x.created_at DESC`,
        classId
      )
      .map((x) => {
        const states = classStates(x);
        return { ...x, total: states.length, done: states.filter((s) => s.state === 'done').length, started: states.filter((s) => s.state === 'started').length };
      });
  }

  return { openFor, stateOf, classStates, forClass };
}

module.exports = { createAssignments };
