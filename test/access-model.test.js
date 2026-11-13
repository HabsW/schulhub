'use strict';
// Property-based tests for the permission module, src/access.js: a fuzzer with a reference model.
//
//  1. A random world from a seeded PRNG (mulberry32): students, teachers and admins (some blocked),
//     classes (some archived), memberships (co-teachers, teachers without classes, teacher accounts
//     that joined with a class code, a teacher demoted to student who kept the class entry), join
//     codes, apps with versions (published or not, shared or not, school-wide, a school-wide update
//     waiting), apps in classes in every state of src/classApps.js, assignments (started or
//     planned), feedback, announcements and comments of every kind. The rows go straight into a
//     real database built by the Hub's own schema (openDb), and access.js answers from it.
//  2. A reference model: every rule of access.js written again in plain JavaScript over the world's
//     arrays - from the doc comments in access.js, SECURITY.md and README.md (each rule quotes its
//     source), not from access.js's code.
//  3. Compare: every exported function, on grids (every user against every class, app, version,
//     assignment, feedback, announcement, comment and code) and on random (user, action, target)
//     triples with nonsense mixed in: null, undefined, ids of other kinds, ids that do not exist,
//     made-up rows, wrong types. An id of the wrong type may make access.js throw (that denies);
//     it never makes it grant. On a mismatch the test prints the seed, finds the smallest world with
//     the same seed that still fails, and drops every row the failing case does not need.
//  4. A slice through HTTP: sampled triples go through the real routes - pages, player and token,
//     SDK writes, results, joining. A route never decides differently from access.js.
//
// Other worlds: ACCESS_SEED=<number> ACCESS_WORLDS=<count> node --test test/access-model.test.js
// ACCESS_KEEP_GOING=1 reports the first mismatch of every function instead of stopping at the first.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isDeepStrictEqual } = require('node:util');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../src/db');
const { createAccess } = require('../src/access');
const { EMOJIS } = require('../src/html');
const { startHub } = require('./helpers');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BASE_SEED = (Number.parseInt(process.env.ACCESS_SEED || '', 10) || 20261113) >>> 0;
const WORLDS = Number.parseInt(process.env.ACCESS_WORLDS || '', 10) || 40;
const KEEP_GOING = process.env.ACCESS_KEEP_GOING === '1';
const ROLES = ['student', 'teacher', 'admin'];
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const sizeOf = (seed) => 1 + (seed % 5);

// =================================================================== randomness

/** mulberry32: 32 bits of state, the same sequence for the same seed. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One 32-bit seed from several parts (FNV-1a), so that every purpose has its own stream. */
function seedOf(...parts) {
  let h = 0x811c9dc5;
  for (const ch of parts.join('/')) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return h;
}

function randomness(seed) {
  const next = mulberry32(seed);
  const int = (n) => Math.floor(next() * n);
  return {
    next,
    int,
    between: (lo, hi) => lo + int(hi - lo + 1),
    chance: (p) => next() < p,
    pick: (list) => list[int(list.length)],
    token: (n, alphabet = B64) => Array.from({ length: n }, () => alphabet[int(alphabet.length)]).join(''),
  };
}

// ==================================================================== the world

const APP_NAMES = ['Vokabeltrainer', 'Quiz-Werkstatt', 'Kopfrechnen', 'Sternenfänger', 'Pixel-Studio', 'Lernkarten', 'Bruchrechnen 100%', 'Wort_Spiel', 'Über\\Mich', 'ÄPFEL zählen', 'Mathe-Quiz', 'zoo'];
const DESCRIPTIONS = ['', '', 'Wörter üben', 'Rechnen mit Brüchen', 'Ein Spiel für die Pause', '50% Spaß, 50_% Lernen', 'Back\\slash'];
const CLASS_NAMES = ['7b Englisch', '5a Mathe', 'AG Robotik', 'Bio_Lab 9', 'Kunst 100%', 'Ärzte-AG', 'q1 Info'];
const CATEGORIES = ['', '', 'Englisch', 'Mathematik', 'Kunst'];
const FIRST = ['Mia', 'Ben', 'Lena', 'Paul', 'Sina', 'Emil', 'Ida', 'Noah'];
const LAST = ['Schmidt', 'Hoffmann', 'Wagner', 'Lehmann', 'Yilmaz', 'Adler', 'Becker'];

/**
 * A random school of the given size (1..5). Every row has the columns of its table (src/db.js),
 * so the same objects go into the database and into the model. The states are the ones the Hub
 * can reach (src/classApps.js): approved plays version_id; pending and rejected carry a waiting
 * or returned request; removed keeps version_id; a request is requested_version_id plus
 * request_state. Only published apps are in classes; school-wide needs a published version, a
 * waiting school-wide update needs a school-wide release.
 */
function makeWorld(seed, size) {
  const r = randomness(seedOf('world', seed, size));
  const now = Date.now();
  const w = { seed, size, now, users: [], classes: [], members: [], codes: [], removals: [], apps: [], versions: [], classApps: [], assignments: [], feedback: [], announcements: [], comments: [] };
  let serial = 0;
  const id = (kind) => `${kind}${serial++}_${r.token(8)}`;
  const membersOf = (classId, role) => w.members.filter((m) => m.class_id === classId && m.role === role).map((m) => m.user_id);

  // ----- people: the first three are an admin, a teacher and a student; the rest is random
  for (let i = 0; i < 4 + 2 * size; i++) {
    const role = i < 3 ? ['admin', 'teacher', 'student'][i] : r.pick(['student', 'student', 'student', 'teacher', 'teacher', 'admin']);
    const uid = id('u');
    w.users.push({ id: uid, oid: `dev-${uid}`, name: `${r.pick(FIRST)} ${r.pick(LAST)}`, email: `${uid}@schule.example`, role, disabled: i >= 3 && r.chance(0.12) ? 1 : 0, created_at: now - 200 * DAY });
  }
  const withRole = (role) => w.users.filter((u) => u.role === role);

  // ----- classes, some archived
  for (let i = 0; i < 1 + size; i++) {
    w.classes.push({ id: id('c'), name: `${r.pick(CLASS_NAMES)} #${i}`, created_at: now - 100 * DAY, archived_at: r.chance(0.25) ? now - r.between(1, 30) * DAY : null });
  }

  // ----- members: 0..3 teachers per class (co-teachers); students join by code - a teacher or admin
  // account that uses a class code becomes a student; rarely a student account keeps a teacher entry
  // (a teacher whom the admin made a student: "In N Klassen bleibt der Eintrag als Lehrkraft bestehen")
  for (const c of w.classes) {
    const taken = new Set();
    const add = (u, role) => {
      if (taken.has(u.id)) return;
      taken.add(u.id);
      w.members.push({ class_id: c.id, user_id: u.id, role, joined_at: now - r.between(1, 90) * DAY });
    };
    for (let n = r.pick([0, 1, 1, 1, 2, 2, 3]); n > 0; n--) {
      const pool = r.chance(0.08) ? withRole('student') : r.chance(0.2) ? withRole('admin') : withRole('teacher');
      add(r.pick(pool), 'teacher');
    }
    for (const u of w.users) if (r.chance(u.role === 'student' ? 0.45 : 0.07)) add(u, 'student');
  }

  // ----- join codes: a class code and a co-teacher invitation, valid or expired
  for (const c of w.classes) {
    for (const role of ['student', 'teacher']) {
      if (!r.chance(role === 'student' ? 0.75 : 0.4)) continue;
      const teachers = membersOf(c.id, 'teacher');
      w.codes.push({
        code: r.token(32), class_id: c.id, created_by: teachers.length ? r.pick(teachers) : null, created_at: now - DAY, role,
        expires_at: r.chance(0.3) ? now - r.between(1, 48) * HOUR : now + r.between(2, 7 * 24) * HOUR,
      });
    }
    // Students a teacher took out of this class - before or after its code was made.
    for (const u of w.users) {
      if (u.role !== 'student' || w.members.some((m) => m.class_id === c.id && m.user_id === u.id) || !r.chance(0.15)) continue;
      w.removals.push({ class_id: c.id, user_id: u.id, removed_at: now - DAY + (r.chance(0.5) ? -HOUR : HOUR) });
    }
  }

  // ----- apps with versions
  for (let i = 0; i < 2 + 2 * size; i++) {
    const a = {
      id: id('a'), owner_id: r.pick(w.users).id, name: `${r.pick(APP_NAMES)} ${i}`, description: r.pick(DESCRIPTIONS), emoji: r.pick(EMOJIS), color: r.int(8),
      origin_key: `a${r.token(20, '0123456789abcdef')}`, category: r.pick(CATEGORIES), shared: r.chance(0.4) ? 1 : 0,
      published_version_id: null, schoolwide_version_id: null, schoolwide_requested_version_id: null, created_at: now - 60 * DAY, updated_at: now - DAY,
    };
    const count = r.pick([0, 1, 1, 2, 3, 4]);
    for (let n = 1; n <= count; n++) {
      w.versions.push({ id: id('v'), app_id: a.id, number: n, status: n === count && r.chance(0.2) ? 'uploading' : 'ready', created_at: now - (count - n + 1) * DAY });
    }
    const ready = w.versions.filter((v) => v.app_id === a.id && v.status === 'ready');
    if (ready.length && r.chance(0.8)) {
      a.published_version_id = (r.chance(0.75) ? ready[ready.length - 1] : r.pick(ready)).id;
      if (r.chance(0.3)) {
        a.schoolwide_version_id = r.chance(0.6) ? a.published_version_id : r.pick(ready).id;
        const other = ready.filter((v) => v.id !== a.schoolwide_version_id);
        if (other.length && r.chance(0.45)) a.schoolwide_requested_version_id = r.pick(other).id;
      }
    }
    w.apps.push(a);
  }

  // ----- apps in classes, in every state the state machine knows
  let order = 0;
  for (const c of w.classes) {
    for (const a of w.apps) {
      if (!a.published_version_id || !r.chance(0.35)) continue;
      const ready = w.versions.filter((v) => v.app_id === a.id && v.status === 'ready').map((v) => v.id);
      const status = r.pick(['approved', 'approved', 'pending', 'rejected', 'removed']);
      const row = { class_id: c.id, app_id: a.id, status, version_id: null, requested_version_id: null, request_state: null, multiplayer: r.chance(0.3) ? 1 : 0, created_at: now - DAY + order++ * 1000 };
      if (status === 'approved') {
        row.version_id = r.pick(ready);
        const state = r.pick([null, null, 'waiting', 'returned']);
        const newer = ready.filter((v) => v !== row.version_id);
        if (state && newer.length) Object.assign(row, { request_state: state, requested_version_id: r.pick(newer) });
      } else if (status === 'removed') {
        row.version_id = r.pick(ready);
      } else {
        row.version_id = r.chance(0.4) ? r.pick(ready) : null; // set if it was approved here before, removed and submitted again
        Object.assign(row, { request_state: status === 'pending' ? 'waiting' : 'returned', requested_version_id: r.pick(ready) });
      }
      w.classApps.push(row);
    }
  }

  // ----- assignments (started or planned) for apps that are or were in use in the class
  for (const c of w.classes) {
    const used = w.classApps.filter((x) => x.class_id === c.id && (x.status === 'approved' || x.status === 'removed'));
    if (!used.length) continue;
    const teachers = membersOf(c.id, 'teacher');
    for (let n = r.pick([0, 1, 1, 2, 3]); n > 0; n--) {
      w.assignments.push({
        id: id('x'), class_id: c.id, app_id: r.pick(used).app_id, title: `Aufgabe ${n}`, note: '', due_at: null, created_at: now - 5 * DAY,
        starts_at: r.chance(0.6) ? now - r.between(1, 96) * HOUR : now + r.between(2, 96) * HOUR,
        created_by: teachers.length && r.chance(0.8) ? r.pick(teachers) : null,
      });
    }
  }

  // ----- feedback: to students of the class (or who have left it since), by its teachers or others
  for (const c of w.classes) {
    const students = membersOf(c.id, 'student');
    const teachers = membersOf(c.id, 'teacher');
    const appsHere = w.classApps.filter((x) => x.class_id === c.id).map((x) => x.app_id);
    const tasksHere = w.assignments.filter((x) => x.class_id === c.id).map((x) => x.id);
    for (let n = r.pick([0, 0, 1, 2, 3]); n > 0; n--) {
      w.feedback.push({
        id: id('f'), class_id: c.id, body: 'Gut gemacht', created_at: now - r.between(1, 100) * HOUR,
        student_id: students.length && r.chance(0.8) ? r.pick(students) : r.pick(w.users).id,
        author_id: r.chance(0.15) ? null : teachers.length && r.chance(0.75) ? r.pick(teachers) : r.pick(w.users.filter((u) => u.role !== 'student')).id,
        app_id: appsHere.length && r.chance(0.5) ? r.pick(appsHere) : null,
        assignment_id: tasksHere.length && r.chance(0.3) ? r.pick(tasksHere) : null,
        read_at: r.chance(0.4) ? now - HOUR : null,
      });
    }
  }

  // ----- announcements: to the whole school and to one class
  const expiry = () => r.pick([null, null, now + 2 * DAY, now - 2 * DAY]);
  for (let n = r.int(3); n > 0; n--) {
    w.announcements.push({ id: id('n'), class_id: null, author_id: r.chance(0.8) ? r.pick(withRole('admin')).id : null, title: 'Schulfest', body: '', created_at: now - r.between(1, 48) * HOUR, expires_at: expiry() });
  }
  for (const c of w.classes) {
    if (!r.chance(0.5)) continue;
    const teachers = membersOf(c.id, 'teacher');
    w.announcements.push({ id: id('n'), class_id: c.id, author_id: teachers.length ? r.pick(teachers) : null, title: 'Ausflug', body: '', created_at: now - r.between(1, 48) * HOUR, expires_at: expiry() });
  }

  // ----- comments of every kind
  for (const a of w.apps) {
    const versions = w.versions.filter((v) => v.app_id === a.id);
    for (let n = r.pick([0, 0, 1, 2, 3]); n > 0; n--) {
      w.comments.push({
        id: id('k'), app_id: a.id, author_id: r.chance(0.15) ? null : r.pick(w.users).id, body: 'Schön', created_at: now - r.between(1, 100) * HOUR,
        kind: r.pick(['comment', 'comment', 'submitted', 'approved', 'returned']),
        version_id: versions.length && r.chance(0.6) ? r.pick(versions).id : null,
        class_id: r.chance(0.5) ? r.pick(w.classes).id : null,
      });
    }
  }
  return w;
}

/** The world as rows of a real database (schema and migrations from src/db.js). */
function insertWorld(db, w) {
  db.tx(() => {
    for (const u of w.users) db.run('INSERT INTO users (id, oid, name, email, role, disabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', u.id, u.oid, u.name, u.email, u.role, u.disabled, u.created_at);
    for (const c of w.classes) db.run('INSERT INTO classes (id, name, created_at, archived_at) VALUES (?, ?, ?, ?)', c.id, c.name, c.created_at, c.archived_at);
    for (const m of w.members) db.run('INSERT INTO class_members (class_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)', m.class_id, m.user_id, m.role, m.joined_at);
    for (const k of w.codes) db.run('INSERT INTO join_codes (code, class_id, created_by, created_at, expires_at, role) VALUES (?, ?, ?, ?, ?, ?)', k.code, k.class_id, k.created_by, k.created_at, k.expires_at, k.role);
    for (const x of w.removals || []) db.run('INSERT INTO class_removals (class_id, user_id, removed_at) VALUES (?, ?, ?)', x.class_id, x.user_id, x.removed_at);
    for (const a of w.apps) {
      db.run(
        `INSERT INTO apps (id, owner_id, name, description, emoji, color, origin_key, published_version_id, schoolwide_version_id, schoolwide_requested_version_id, shared, category, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        a.id, a.owner_id, a.name, a.description, a.emoji, a.color, a.origin_key, a.published_version_id, a.schoolwide_version_id, a.schoolwide_requested_version_id, a.shared, a.category, a.created_at, a.updated_at
      );
    }
    for (const v of w.versions) db.run('INSERT INTO app_versions (id, app_id, number, status, created_at) VALUES (?, ?, ?, ?, ?)', v.id, v.app_id, v.number, v.status, v.created_at);
    for (const x of w.classApps) {
      db.run(
        'INSERT INTO class_apps (class_id, app_id, status, version_id, requested_version_id, request_state, multiplayer, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        x.class_id, x.app_id, x.status, x.version_id, x.requested_version_id, x.request_state, x.multiplayer, x.created_at
      );
    }
    for (const x of w.assignments) {
      db.run('INSERT INTO assignments (id, class_id, app_id, title, note, starts_at, due_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', x.id, x.class_id, x.app_id, x.title, x.note, x.starts_at, x.due_at, x.created_by, x.created_at);
    }
    for (const f of w.feedback) {
      db.run('INSERT INTO feedback (id, class_id, student_id, author_id, app_id, assignment_id, body, created_at, read_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', f.id, f.class_id, f.student_id, f.author_id, f.app_id, f.assignment_id, f.body, f.created_at, f.read_at);
    }
    for (const n of w.announcements) db.run('INSERT INTO announcements (id, class_id, author_id, title, body, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)', n.id, n.class_id, n.author_id, n.title, n.body, n.created_at, n.expires_at);
    for (const k of w.comments) db.run('INSERT INTO comments (id, app_id, author_id, body, created_at, kind, version_id, class_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', k.id, k.app_id, k.author_id, k.body, k.created_at, k.kind, k.version_id, k.class_id);
  });
}

// ========================================================== the reference model
//
// Plain JavaScript over the world's arrays. Each rule is written from the documentation quoted
// above it. Conventions the documents leave implicit, used throughout:
//  - a user is the signed-in account: its role is user.role, its identity user.id. An object
//    without a real id (a string) is nobody: it owns, wrote and belongs to nothing.
//  - ids name rows of one kind; an id of another kind, one that does not exist or a value of
//    another type names nothing.
//  - "given" for an optional argument (a class, a version) means truthy.

function createModel(w) {
  const isId = (v) => typeof v === 'string' && v !== '';
  const index = (rows, key = 'id') => new Map(rows.map((x) => [x[key], x]));
  const users = index(w.users);
  const classes = index(w.classes);
  const versions = index(w.versions);
  const pair = (a, b) => `${a}\u0001${b}`;
  const roles = new Map(w.members.map((m) => [pair(m.class_id, m.user_id), m.role]));
  const placements = new Map(w.classApps.map((x) => [pair(x.class_id, x.app_id), x]));

  const uid = (user) => (user && isId(user.id) ? user.id : null);
  const same = (a, b) => isId(a) && a === b;
  const classOf = (id) => (isId(id) ? classes.get(id) || null : null);
  const roleIn = (classId, userId) => (isId(classId) && isId(userId) ? roles.get(pair(classId, userId)) || null : null);
  const placement = (classId, appId) => (isId(classId) && isId(appId) ? placements.get(pair(classId, appId)) || null : null);
  const ownerOf = (app) => (app && isId(app.owner_id) ? users.get(app.owner_id) || null : null);
  /** A version of exactly this app (any state), or null. */
  const versionOf = (app, versionId) => {
    const v = isId(versionId) ? versions.get(versionId) : null;
    return v && app && v.app_id === app.id ? v : null;
  };
  const readyVersionOf = (app, versionId) => {
    const v = versionOf(app, versionId);
    return v && v.status === 'ready' ? v : null;
  };
  const activeClass = (classId) => Boolean(classOf(classId)) && !classOf(classId).archived_at;
  const asciiLower = (s) => String(s).replace(/[A-Z]/g, (ch) => ch.toLowerCase());
  /** "q: optional search text (matched against name/description)": a part of the text; letters A-Z in any case. */
  const matches = (text, q) => asciiLower(text || '').includes(asciiLower(q));

  const m = {};

  m.isAdmin = (user) => Boolean(user) && user.role === 'admin';
  // "Staff: may create classes, use colleagues' shared apps, accept co-teacher invitations." (teachers and the admin)
  m.isStaff = (user) => Boolean(user) && (user.role === 'teacher' || user.role === 'admin');
  // "'teacher' | 'student' | null - the user's role inside one class."
  m.classRole = (user, classId) => roleIn(classId, uid(user));
  m.isArchived = (classId) => Boolean(classOf(classId) && classOf(classId).archived_at);

  // ----- classes
  m.canCreateClass = (user) => m.isStaff(user);
  // "Members see their class. An archived class (end of the school year) is read-only and only its
  // teachers (and the admin) still see it."
  m.canViewClass = (user, classId) => {
    if (!user || !classOf(classId)) return false;
    if (m.isAdmin(user)) return true;
    const role = m.classRole(user, classId);
    return role === 'teacher' || (role === 'student' && activeClass(classId));
  };
  // "Teachers of the class (and the admin): see everything in it, archive, restore, delete."
  m.canManageClass = (user, classId) => Boolean(user) && Boolean(classOf(classId)) && (m.isAdmin(user) || m.classRole(user, classId) === 'teacher');
  // "Change the class or its content (apps, codes, assignments, feedback, settings): never while archived."
  m.canChangeClass = (user, classId) => m.canManageClass(user, classId) && activeClass(classId);
  // "A normal code ALWAYS makes a student (even for a teacher account). A teacher invitation (co-teachers)
  // only works for staff accounts. Nobody joins an archived class. Expiry and the code itself are checked
  // by the caller." (join_codes.role defaults to 'student')
  // "A teacher removed this person from the code's class after the code was made: it does not let them back in."
  m.removedSince = (user, code) => Boolean(user) && Boolean(code) && (w.removals || []).some((x) => same(x.class_id, code.class_id) && same(x.user_id, uid(user)) && x.removed_at >= code.created_at);
  m.joinRoleFor = (user, code) => {
    if (!user || !code || m.isArchived(code.class_id)) return null;
    const kind = code.role ?? 'student';
    if (kind === 'student') return m.removedSince(user, code) ? null : 'student';
    return kind === 'teacher' && m.isStaff(user) ? 'teacher' : null;
  };

  // ----- apps
  // "Owner (or admin): edit, upload, use the editor, publish, delete, see usage numbers."
  m.canManageApp = (user, app) => Boolean(user) && Boolean(app) && (m.isAdmin(user) || same(app.owner_id, uid(user)));
  // "Only staff may share their own apps with colleagues (students' apps go through review)."
  // SECURITY.md: "rendered and honoured only when access.canShareApp (staff owner)".
  m.canShareApp = (user, app) => m.canManageApp(user, app) && m.isStaff(ownerOf(app));
  // "A colleague's app that its (staff) owner shared, usable by any staff member." Usable means it has a
  // published version - SECURITY.md: "A colleague may preview the shared app's published version".
  m.isSharedWith = (user, app) => Boolean(app) && Boolean(app.shared) && m.isStaff(user) && m.isStaff(ownerOf(app)) && Boolean(app.published_version_id);
  // "Classes in which this user is a teacher and the app was added, submitted or returned."
  m.reviewClasses = (user, app) => {
    if (!uid(user) || !app) return [];
    return w.classApps
      .filter((x) => same(x.app_id, app.id) && roleIn(x.class_id, uid(user)) === 'teacher')
      .map((x) => {
        const c = classes.get(x.class_id);
        return { id: c.id, name: c.name, archived_at: c.archived_at, status: x.status, version_id: x.version_id, requested_version_id: x.requested_version_id, request_state: x.request_state };
      });
  };
  // "May open the app's page: comments, and the versions allowed by canSeeVersion."
  // routes/apps.js: "Owner, admin, or a teacher of a class the app was submitted to".
  m.canReviewApp = (user, app) => m.canManageApp(user, app) || m.reviewClasses(user, app).length > 0;
  // "Preview, source code, diff and download of ONE version. The owner sees all of their versions. A teacher
  // sees versions that were submitted to, returned in or approved in one of their classes - never the
  // owner's private drafts - and the published version of an app a colleague shared."
  m.canSeeVersion = (user, app, versionId) => {
    if (!versionOf(app, versionId)) return false; // ONE version: of this app
    if (m.canManageApp(user, app)) return true;
    if (m.reviewClasses(user, app).some((c) => c.version_id === versionId || c.requested_version_id === versionId)) return true;
    return m.isSharedWith(user, app) && app.published_version_id === versionId;
  };
  // "'approve' - a teacher of the class adds an app they may use: their own, a colleague's shared app, or a
  // school-wide app; 'submit' - the owner (e.g. a student) asks the class's teacher to review it". Only a
  // published version goes into a class (classApps.add, submit), and only into a class the user can see and
  // that is not archived (read-only).
  m.addToClassMode = (user, app, classId) => {
    if (!user || !app || !app.published_version_id || !m.canViewClass(user, classId) || !activeClass(classId)) return null;
    const own = same(app.owner_id, uid(user));
    if (m.canChangeClass(user, classId) && (own || m.isSharedWith(user, app) || Boolean(app.schoolwide_version_id))) return 'approve';
    return own ? 'submit' : null;
  };
  /**
   * "versionId given: private preview of exactly that version (owner / reviewing teacher / admin);
   * classId given: the version approved for that class; neither: owner's published version, school-wide
   * release, or any of the user's classes." The user's classes are active ones (SECURITY.md: archived
   * classes give students no class context). The documents name no order between the three ways of
   * "neither", so the model returns every acceptable answer and access.js must give one of them (or null
   * when there is none).
   */
  m.resolvePlay = (user, app, options) => {
    const { classId = null, versionId = null } = options ?? {};
    if (!user || !app) return [];
    const answer = (v, cid, preview) => ({ version: v.id, versionApp: v.app_id, ready: true, classId: cid, preview });
    if (versionId) {
      const v = m.canSeeVersion(user, app, versionId) ? readyVersionOf(app, versionId) : null;
      if (!v || (classId && !m.canViewClass(user, classId))) return [];
      return [answer(v, classId || null, true)];
    }
    if (classId) {
      if (!m.canViewClass(user, classId)) return [];
      const x = placement(classId, app.id);
      const v = x && x.status === 'approved' ? readyVersionOf(app, x.version_id) : null;
      return v ? [answer(v, classId, false)] : [];
    }
    const mine = w.classApps.filter((x) => same(x.app_id, app.id) && x.status === 'approved' && roleIn(x.class_id, uid(user)) && activeClass(x.class_id) && readyVersionOf(app, x.version_id));
    const out = [];
    const published = m.canManageApp(user, app) ? readyVersionOf(app, app.published_version_id) : null;
    if (published) for (const cid of [null, ...mine.map((x) => x.class_id)]) out.push(answer(published, cid, false));
    for (const x of mine) out.push(answer(readyVersionOf(app, x.version_id), x.class_id, false));
    const schoolwide = readyVersionOf(app, app.schoolwide_version_id);
    if (schoolwide) out.push(answer(schoolwide, null, false));
    // "or, for staff, a colleague's shared app: its published version as a preview (nothing is stored)" -
    // only when none of the above opens it.
    const shared = !out.length && m.isSharedWith(user, app) ? readyVersionOf(app, app.published_version_id) : null;
    if (shared) out.push(answer(shared, null, true));
    return out;
  };

  // ----- other people's data
  m.isStudentOf = (classId, studentId) => roleIn(classId, studentId) === 'student';
  m.appApprovedIn = (classId, appId) => placement(classId, appId)?.status === 'approved';
  m.wasApprovedIn = (classId, appId) => usedIn(classId, appId);
  // "The app is or was approved in this class: its row keeps the version the class had, also after it was
  // removed - and while a new submission of the removed app waits or was given back."
  const usedIn = (classId, appId) => Boolean(placement(classId, appId)?.version_id);
  // "A teacher may look at a student's data in an app only if the student is in one of the teacher's classes
  // AND the app is (or was, before it was removed) in use in that same class."
  m.canSeeStudentData = (user, classId, appId, studentId) => m.canManageClass(user, classId) && m.isStudentOf(classId, studentId) && usedIn(classId, appId);

  // ----- assignments
  // "Create an assignment: a teacher of an active class, for an app approved in that class."
  m.canAssign = (user, classId, appId) => m.canChangeClass(user, classId) && m.appApprovedIn(classId, appId);
  // "The class's teachers (and the admin) see every assignment of it. Students see one only from its start"
  m.canSeeAssignment = (user, a) => Boolean(a) && m.canViewClass(user, a.class_id) && (m.canManageClass(user, a.class_id) || a.starts_at <= Date.now());
  // SECURITY.md: "canManageAssignment for edit/delete" - changing the class's content, never while archived.
  m.canManageAssignment = (user, a) => Boolean(a) && m.canChangeClass(user, a.class_id);
  // "Only the student themself marks an assignment as done." SECURITY.md: "student of the class, class active".
  m.canMarkDone = (user, a) => Boolean(user) && Boolean(a) && m.isStudentOf(a.class_id, uid(user)) && activeClass(a.class_id);

  // ----- feedback
  // SECURITY.md: "Writing: canGiveFeedback (teacher of an active class -> a student of that class)."
  m.canGiveFeedback = (user, classId, studentId) => m.canChangeClass(user, classId) && m.isStudentOf(classId, studentId);
  // "The student it is for, and the teachers of that class." (the admin too: "die Schulverwaltung")
  m.canReadFeedback = (user, f) => Boolean(user) && Boolean(f) && (same(f.student_id, uid(user)) || m.canManageClass(user, f.class_id));
  // "The author, the student (it is their data), the admin."
  // "The author while the class may change (an archived class is read-only), the student (it is their data), the admin."
  m.canDeleteFeedback = (user, f) => Boolean(user) && Boolean(f) && ((same(f.author_id, uid(user)) && m.canChangeClass(user, f.class_id)) || same(f.student_id, uid(user)) || m.isAdmin(user));
  // "Only the student a feedback is for marks it as read."
  m.canMarkFeedbackRead = (user, f) => Boolean(user) && Boolean(f) && same(f.student_id, uid(user));
  // SECURITY.md: "Only canEditAppSettings (teacher of the active class, app approved there)."
  m.canEditAppSettings = (user, classId, appId) => m.canChangeClass(user, classId) && m.appApprovedIn(classId, appId);

  // ----- announcements
  // "Whole school: admin. One class: its teachers." SECURITY.md: "(teacher of an active class)".
  m.canAnnounce = (user, classId) => (classId ? m.canChangeClass(user, classId) : m.isAdmin(user));
  // SECURITY.md: "Shown and dismissable only if access.canSeeAnnouncement (school-wide, or a class the person can see)"
  m.canSeeAnnouncement = (user, an) => Boolean(user) && Boolean(an) && (an.class_id ? m.canViewClass(user, an.class_id) : true);
  // No sentence of its own (see the report): the people who announce there - the class's teachers, also
  // after archiving (like deleting the whole class) - and the admin for the whole school.
  m.canDeleteAnnouncement = (user, an) => Boolean(user) && Boolean(an) && (an.class_id ? m.canManageClass(user, an.class_id) : m.isAdmin(user));

  // ----- multiplayer (prepared)
  // "Only inside an active class, only for an app approved there, only if its teacher switched multiplayer on."
  m.canJoinRoom = (user, app, classId) => {
    if (!user || !app || !classId || !m.canViewClass(user, classId) || !activeClass(classId)) return false;
    const x = placement(classId, app.id);
    return Boolean(x) && x.status === 'approved' && x.multiplayer === 1;
  };

  // ----- lists
  // "Apps this user can open, with how: own (published), approved in one of their active classes, released
  // school-wide, or shared with staff. q: optional search text (matched against name/description),
  // category: exact." Returns every such app; the limit is checked by the comparison.
  m.visibleApps = (user, options) => {
    const { q = '', category = '' } = options ?? {};
    if (!user) return [];
    const out = [];
    for (const a of w.apps) {
      const mine = same(a.owner_id, uid(user));
      const inClass = w.classApps.some((x) => x.app_id === a.id && x.status === 'approved' && roleIn(x.class_id, uid(user)) && activeClass(x.class_id));
      const schoolwide = Boolean(a.schoolwide_version_id);
      if (!((mine && a.published_version_id) || inClass || schoolwide || m.isSharedWith(user, a))) continue;
      if (q && !matches(a.name, q) && !matches(a.description, q)) continue;
      if (category && a.category !== category) continue;
      out.push({ id: a.id, mine, in_class: inClass, schoolwide, shared_staff: Boolean(a.shared) && m.isStaff(user) && m.isStaff(ownerOf(a)) });
    }
    return out;
  };
  // "Classes this user belongs to (admin: all). Archived ones only for their teachers." archived: the archive
  // list instead of the active one; q: a part of the name.
  m.visibleClasses = (user, options) => {
    const { q = '', archived = false } = options ?? {};
    if (!user) return [];
    const out = [];
    for (const c of w.classes) {
      if (Boolean(c.archived_at) !== Boolean(archived) || (q && !matches(c.name, q))) continue;
      if (m.isAdmin(user)) {
        out.push({ id: c.id, my_role: null });
        continue;
      }
      const role = roleIn(c.id, uid(user));
      if (role && (!c.archived_at || role === 'teacher')) out.push({ id: c.id, my_role: role });
    }
    return out;
  };

  // ----- leaving, results, removing
  // "a student may always leave an active class; a teacher only while another teacher remains who can sign
  // in ... a blocked account teaches nobody. Archived classes are read-only."
  m.canLeaveClass = (user, classId) => {
    const role = m.classRole(user, classId);
    if (!role || !activeClass(classId)) return false;
    const canSignIn = (id) => w.users.some((u) => u.id === id && !u.disabled);
    return role === 'student' || w.members.some((x) => x.class_id === classId && x.role === 'teacher' && x.user_id !== uid(user) && canSignIn(x.user_id));
  };
  // "the class's teachers (and the admin), while the app is approved there - or after it was removed."
  m.canSeeClassResults = (user, classId, appId) => m.canManageClass(user, classId) && usedIn(classId, appId);
  // "the class's teachers (and the admin) for any app, the app's owner for their own app if they can see the
  // class. Archived classes are read-only for everybody. row: the class_apps row of this class, with the
  // app's owner_id."
  m.canRemoveFromClass = (user, cls, row) => {
    if (!user || !cls || !row || row.class_id !== cls.id || !activeClass(cls.id)) return false;
    return m.canChangeClass(user, cls.id) || (same(row.owner_id, uid(user)) && m.canViewClass(user, cls.id));
  };
  // "the user may change the class (its teacher or the admin, never while archived) and the app's request
  // there is waiting - or was returned ... Returns the class_apps row or null."
  m.reviewRequest = (user, classId, appId) => {
    if (!m.canChangeClass(user, classId)) return null;
    const x = placement(classId, appId);
    return x && (x.request_state === 'waiting' || x.request_state === 'returned') ? x : null;
  };
  // "Only the owner: the admin manages every app, but never acts as its owner."
  m.isAppOwner = (user, app) => Boolean(user) && Boolean(app) && same(app.owner_id, uid(user));
  // "only a plain comment (decisions stay as the review record), and only by its author or the admin."
  m.canDeleteComment = (user, k) => Boolean(user) && Boolean(k) && k.kind === 'comment' && (same(k.author_id, uid(user)) || m.isAdmin(user));
  // "while the app is approved or waiting in an active class, released school-wide or waiting for a
  // school-wide update ... its owner cannot change it. Staff owners and the admin are not bound by this."
  m.appTextLock = (user, app) => {
    if (!user || !app || m.isAdmin(user) || m.isStaff(ownerOf(app))) return null;
    const here = w.classApps.filter((x) => same(x.app_id, app.id) && activeClass(x.class_id));
    const approved = here.filter((x) => x.status === 'approved').map((x) => classes.get(x.class_id).name);
    const waiting = here.filter((x) => x.request_state === 'waiting').map((x) => classes.get(x.class_id).name);
    const schoolwide = Boolean(app.schoolwide_version_id || app.schoolwide_requested_version_id);
    return approved.length || waiting.length || schoolwide ? { approved, waiting, schoolwide } : null;
  };
  // "Change an app's name and description: whoever manages it, unless appTextLock holds the text."
  m.canEditAppText = (user, app) => m.canManageApp(user, app) && !m.appTextLock(user, app);
  return m;
}

// ================================================================== comparing

const BOOLEAN = new Set([
  'isAdmin', 'isStaff', 'isArchived', 'canCreateClass', 'canViewClass', 'canManageClass', 'canChangeClass', 'canManageApp', 'canShareApp',
  'isSharedWith', 'canReviewApp', 'canSeeVersion', 'canSeeStudentData', 'isStudentOf', 'appApprovedIn', 'wasApprovedIn', 'canAssign', 'canSeeAssignment',
  'canManageAssignment', 'canMarkDone', 'canGiveFeedback', 'canReadFeedback', 'canDeleteFeedback', 'canEditAppSettings', 'canAnnounce',
  'canSeeAnnouncement', 'canDeleteAnnouncement', 'canJoinRoom', 'canLeaveClass', 'canSeeClassResults', 'canMarkFeedbackRead',
  'canRemoveFromClass', 'isAppOwner', 'canDeleteComment', 'canEditAppText', 'removedSince',
]);
const FUNCTIONS = [...BOOLEAN, 'classRole', 'joinRoleFor', 'reviewClasses', 'addToClassMode', 'resolvePlay', 'visibleApps', 'visibleClasses', 'reviewRequest', 'appTextLock'];

const byKey = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const sortNames = (list) => [...list].sort();
const denies = (v) => v === false || v === null || v === undefined || (Array.isArray(v) && v.length === 0);
const playView = (p) => (p ? { version: p.version && p.version.id, versionApp: p.version && p.version.app_id, ready: Boolean(p.version) && p.version.status === 'ready', classId: p.classId, preview: p.preview } : null);
const requestView = (x) => (x ? { class_id: x.class_id, app_id: x.app_id, status: x.status, version_id: x.version_id, requested_version_id: x.requested_version_id, request_state: x.request_state } : null);
const lockView = (l) => (l ? { approved: sortNames(l.approved), waiting: sortNames(l.waiting), schoolwide: l.schoolwide } : null);
const reviewView = (rows) => rows.map((c) => ({ id: c.id, name: c.name, archived_at: c.archived_at, status: c.status, version_id: c.version_id, requested_version_id: c.requested_version_id, request_state: c.request_state })).sort(byKey);
const appView = (a) => ({ id: a.id, mine: Boolean(a.mine), in_class: Boolean(a.in_class), schoolwide: Boolean(a.schoolwide), shared_staff: Boolean(a.shared_staff) });

/**
 * Does access.js's answer agree with the model's? Wrong-typed ids may only make access.js deny.
 * The model gives every acceptable answer for resolvePlay and the whole list for visibleApps.
 */
function agrees(name, args, want, got, wrong) {
  if (wrong && denies(got)) return true;
  if (wrong && name === 'visibleApps') {
    // A nonsense limit may shorten the list; it never adds an app.
    const wanted = new Map(want.map((a) => [a.id, a]));
    return Array.isArray(got) && got.map(appView).every((a) => isDeepStrictEqual(a, wanted.get(a.id)));
  }
  switch (name) {
    case 'resolvePlay': {
      const g = playView(got);
      return want.length ? want.some((o) => isDeepStrictEqual(o, g)) : g === null;
    }
    case 'visibleApps': {
      if (!Array.isArray(got)) return false;
      const options = args[1];
      const limit = options && Number.isInteger(options.limit) ? options.limit : 60;
      const wanted = new Map(want.map((a) => [a.id, a]));
      const rows = got.map(appView);
      return rows.length === Math.min(limit, want.length) && new Set(rows.map((a) => a.id)).size === rows.length && rows.every((a) => isDeepStrictEqual(a, wanted.get(a.id)));
    }
    case 'visibleClasses':
      return Array.isArray(got) && isDeepStrictEqual(got.map((c) => ({ id: c.id, my_role: c.my_role })).sort(byKey), [...want].sort(byKey));
    case 'reviewClasses':
      return Array.isArray(got) && isDeepStrictEqual(reviewView(got), reviewView(want));
    case 'reviewRequest':
      return isDeepStrictEqual(requestView(got), requestView(want));
    case 'appTextLock':
      return isDeepStrictEqual(lockView(got), lockView(want));
    default:
      return BOOLEAN.has(name) ? Boolean(got) === want : (got ?? null) === want;
  }
}

const STOP = Symbol('stop');

/** Runs single checks of access.js against the model; calls onFailure with the first mismatch. */
function createChecker(access, model, { only = null, onFailure }) {
  const counts = { checks: 0, thrown: 0, granted: 0, thrownBy: {} };
  function check(name, args, wrong = false) {
    if (only && name !== only) return;
    counts.checks++;
    let got;
    let threw = null;
    try {
      got = access[name](...args);
    } catch (err) {
      threw = err;
    }
    const want = model[name](...args);
    if (threw && wrong) {
      counts.thrown++;
      counts.thrownBy[name] = (counts.thrownBy[name] || 0) + 1;
      return;
    }
    if (!threw && !denies(got)) counts.granted++;
    if (threw || !agrees(name, args, want, got, wrong)) onFailure({ name, args, wrong, want, got, threw: threw ? String(threw.message || threw) : null });
  }
  return { check, counts };
}

// ===================================================== arguments, sane and not

const ID_KINDS = { u: 'users', c: 'classes', a: 'apps', v: 'versions', x: 'assignments', f: 'feedback', n: 'announcements', k: 'comments' };

function argumentMaker(w, r) {
  const ids = Object.fromEntries(Object.entries(ID_KINDS).map(([kind, table]) => [kind, w[table].map((x) => x.id)]));
  ids.j = w.codes.map((k) => k.code);
  const everything = Object.values(ids).flat();
  const ghost = (kind) => `${kind}9999_${r.token(8)}`;
  const otherThan = (kind) => {
    const pool = everything.filter((id) => !ids[kind].includes(id));
    return pool.length ? r.pick(pool) : ghost('z');
  };
  const ok = (v) => ({ v, wrong: false });
  const bad = (v) => ({ v, wrong: true });
  const real = (kind) => (ids[kind].length ? r.pick(ids[kind]) : ghost(kind));
  const rowOf = (table, id) => w[table].find((x) => x.id === id);
  const members = (u) => (u && typeof u.id === 'string' ? w.members.filter((m) => m.user_id === u.id) : []);

  const g = {
    ok,
    // relations: arguments that belong together are drawn more often
    classesOf: (u) => members(u).map((m) => m.class_id),
    teaching: (u) => members(u).filter((m) => m.role === 'teacher').map((m) => m.class_id),
    appsIn: (c) => w.classApps.filter((x) => x.class_id === c).map((x) => x.app_id),
    studentsIn: (c) => w.members.filter((m) => m.class_id === c && m.role === 'student').map((m) => m.user_id),
    ownApps: (u) => (u && typeof u.id === 'string' ? w.apps.filter((a) => a.owner_id === u.id).map((a) => a.id) : []),

    user() {
      const p = r.next();
      if (p < 0.72) return ok(r.pick(w.users));
      if (p < 0.75) return ok(null);
      if (p < 0.77) return ok(undefined);
      if (p < 0.8) return ok({});
      if (p < 0.83) return ok({ id: null, role: r.pick(ROLES) });
      if (p < 0.87) return ok({ id: ghost('u'), role: r.pick(ROLES) });
      if (p < 0.9) return ok({ id: otherThan('u'), role: r.pick(ROLES) });
      if (p < 0.94) return ok({ ...r.pick(w.users), role: r.pick(ROLES) }); // a row whose role has changed since
      if (p < 0.96) return ok({ role: 'admin' });
      return ok(r.pick(['u0', 7, true])); // not an object: property reads give undefined, judged like any other
    },
    /** An id parameter: mostly a real id of the right kind (related ones first), sometimes nonsense. */
    id(kind, related = []) {
      const p = r.next();
      if (related.length && p < 0.55) return ok(r.pick(related));
      if (p < 0.8) return ok(real(kind));
      if (p < 0.84) return ok(null);
      if (p < 0.86) return ok(undefined);
      if (p < 0.88) return ok('');
      if (p < 0.92) return ok(ghost(kind));
      if (p < 0.96) return ok(otherThan(kind));
      return bad(r.pick([42, 2.5, true, {}, [real(kind)], { id: real(kind) }]));
    },
    app(related = []) {
      const p = r.next();
      if (related.length && p < 0.4) return ok(rowOf('apps', r.pick(related)));
      if (p < 0.82 && w.apps.length) return ok(r.pick(w.apps));
      if (p < 0.86) return ok(null);
      if (p < 0.88) return ok(undefined);
      if (p < 0.91) return ok({});
      if (p < 0.94 && w.apps.length) return ok({ ...r.pick(w.apps), id: ghost('a') }); // a row that is not in the database
      if (p < 0.98 && w.apps.length) return ok({ ...r.pick(w.apps), owner_id: r.pick([null, undefined, ghost('u'), otherThan('u')]) });
      return ok(r.pick(['a0', 7]));
    },
    versionId(app) {
      const own = app && typeof app.id === 'string' ? w.versions.filter((v) => v.app_id === app.id).map((v) => v.id) : [];
      return g.id('v', own);
    },
    row(table, fakes) {
      const p = r.next();
      if (p < 0.8 && w[table].length) return ok(r.pick(w[table]));
      if (p < 0.85) return ok(null);
      if (p < 0.87) return ok(undefined);
      return ok(r.pick(fakes()));
    },
    assignment: () => g.row('assignments', () => [{}, { ...(r.pick(w.assignments) || {}), class_id: r.pick([ghost('c'), otherThan('c'), null]) }, { class_id: real('c'), starts_at: w.now - HOUR }, { class_id: real('c'), starts_at: w.now + DAY }]),
    feedback: () => g.row('feedback', () => [{}, { class_id: real('c'), student_id: null, author_id: null }, { ...(r.pick(w.feedback) || {}), class_id: ghost('c') }, { class_id: real('c'), student_id: real('u'), author_id: undefined }]),
    announcement: () => g.row('announcements', () => [{}, { class_id: null }, { class_id: ghost('c') }, { class_id: otherThan('c') }, { class_id: real('c') }]),
    comment: () => g.row('comments', () => [{}, { kind: 'comment' }, { kind: 'comment', author_id: null }, { kind: 'approved', author_id: real('u') }, { kind: 'comment', author_id: real('u') }]),
    code() {
      // Real codes only: "Expiry and the code itself are checked by the caller."
      const p = r.next();
      if (p < 0.9 && w.codes.length) return ok(r.pick(w.codes));
      return ok(p < 0.95 ? null : undefined);
    },
    /** A class_apps row with the app's owner_id, as routes/classes.js passes it - or a made-up one. */
    placement() {
      const p = r.next();
      const x = r.pick(w.classApps);
      if (x && p < 0.85) return ok({ ...x, owner_id: rowOf('apps', x.app_id).owner_id });
      if (p < 0.9) return ok(null);
      return ok({ class_id: real('c'), app_id: real('a'), status: 'approved', owner_id: r.pick([real('u'), null, undefined]) });
    },
    classRow(classId) {
      const p = r.next();
      if (classId && p < 0.7) return ok(rowOf('classes', classId) || { id: classId });
      if (p < 0.85 && w.classes.length) return ok(r.pick(w.classes));
      if (p < 0.9) return ok(null);
      return ok(r.pick([{}, { id: ghost('c') }, { id: otherThan('c') }]));
    },
    playOptions(u, app) {
      const p = r.next();
      if (p < 0.15) return ok(undefined);
      if (p < 0.2) return ok({});
      if (p < 0.22) return bad(null);
      const parts = [];
      if (r.chance(0.6)) parts.push(['classId', g.id('c', g.classesOf(u))]);
      if (r.chance(0.45)) parts.push(['versionId', g.versionId(app)]);
      return { v: Object.fromEntries(parts.map(([k, x]) => [k, x.v])), wrong: parts.some(([, x]) => x.wrong) };
    },
    query() {
      const p = r.next();
      if (p < 0.5) {
        const texts = [...w.apps.flatMap((a) => [a.name, a.description]), ...w.classes.map((c) => c.name)].filter(Boolean);
        const text = r.pick(texts) || 'Quiz';
        const start = r.int(text.length);
        const part = text.slice(start, start + 1 + r.int(8));
        return [...part].map((ch) => (/[a-z]/i.test(ch) && r.chance(0.3) ? (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()) : ch)).join('');
      }
      if (p < 0.75) return r.pick(['%', '_', '\\', '%_', '50%', 'ä', 'Ä', 'zz', 'quiz', 'QUIZ', ' ', '#1']);
      if (p < 0.85) return '';
      return r.token(1 + r.int(5), 'abcdefgxyz%_\\ äÄ#1');
    },
    appListOptions() {
      const p = r.next();
      if (p < 0.15) return ok(undefined);
      if (p < 0.17) return bad(null);
      const o = {};
      if (r.chance(0.6)) o.q = g.query();
      if (r.chance(0.35)) o.category = r.pick(['', 'Englisch', 'Mathematik', 'Kunst', 'Erdkunde']);
      if (r.chance(0.25)) o.limit = r.pick([1, 2, 3, 5, 60, 200]);
      if (r.chance(0.04)) return bad({ ...o, category: r.pick([null, 7, {}]) });
      if (r.chance(0.03)) return bad({ ...o, limit: r.pick([2.5, Number.NaN, 'viele', null]) });
      return ok(o);
    },
    classListOptions() {
      const p = r.next();
      if (p < 0.15) return ok(undefined);
      if (p < 0.17) return bad(null);
      const o = {};
      if (r.chance(0.5)) o.q = g.query();
      if (r.chance(0.5)) o.archived = r.pick([true, false, 1, 0, 'ja']);
      return ok(o);
    },
  };
  return g;
}

/** One random (user, action, target) triple per call: which function, with which arguments. */
const RANDOM = {
  isAdmin: (g) => [g.user()],
  isStaff: (g) => [g.user()],
  canCreateClass: (g) => [g.user()],
  isArchived: (g) => [g.id('c')],
  classRole: (g) => { const u = g.user(); return [u, g.id('c', g.classesOf(u.v))]; },
  canViewClass: (g) => { const u = g.user(); return [u, g.id('c', g.classesOf(u.v))]; },
  canManageClass: (g) => { const u = g.user(); return [u, g.id('c', g.classesOf(u.v))]; },
  canChangeClass: (g) => { const u = g.user(); return [u, g.id('c', g.classesOf(u.v))]; },
  canLeaveClass: (g) => { const u = g.user(); return [u, g.id('c', g.classesOf(u.v))]; },
  canAnnounce: (g) => { const u = g.user(); return [u, g.id('c', g.teaching(u.v))]; },
  joinRoleFor: (g) => [g.user(), g.code()],
  removedSince: (g) => [g.user(), g.code()],
  canManageApp: (g) => { const u = g.user(); return [u, g.app(g.ownApps(u.v))]; },
  canShareApp: (g) => { const u = g.user(); return [u, g.app(g.ownApps(u.v))]; },
  isSharedWith: (g) => [g.user(), g.app()],
  isAppOwner: (g) => { const u = g.user(); return [u, g.app(g.ownApps(u.v))]; },
  canReviewApp: (g) => { const u = g.user(); return [u, g.app(g.teaching(u.v).flatMap(g.appsIn))]; },
  reviewClasses: (g) => { const u = g.user(); return [u, g.app(g.teaching(u.v).flatMap(g.appsIn))]; },
  appTextLock: (g) => { const u = g.user(); return [u, g.app(g.ownApps(u.v))]; },
  canEditAppText: (g) => { const u = g.user(); return [u, g.app(g.ownApps(u.v))]; },
  canSeeVersion: (g) => { const u = g.user(); const a = g.app(g.teaching(u.v).flatMap(g.appsIn)); return [u, a, g.versionId(a.v)]; },
  addToClassMode: (g) => { const u = g.user(); return [u, g.app(), g.id('c', g.classesOf(u.v))]; },
  resolvePlay: (g) => { const u = g.user(); const a = g.app(g.classesOf(u.v).flatMap(g.appsIn)); return [u, a, g.playOptions(u.v, a.v)]; },
  canJoinRoom: (g) => { const u = g.user(); const c = g.id('c', g.classesOf(u.v)); return [u, g.app(g.appsIn(c.v)), c]; },
  isStudentOf: (g) => { const c = g.id('c'); return [c, g.id('u', g.studentsIn(c.v))]; },
  appApprovedIn: (g) => { const c = g.id('c'); return [c, g.id('a', g.appsIn(c.v))]; },
  wasApprovedIn: (g) => { const c = g.id('c'); return [c, g.id('a', g.appsIn(c.v))]; },
  canSeeStudentData: (g) => { const u = g.user(); const c = g.id('c', g.teaching(u.v)); return [u, c, g.id('a', g.appsIn(c.v)), g.id('u', g.studentsIn(c.v))]; },
  canSeeClassResults: (g) => { const u = g.user(); const c = g.id('c', g.teaching(u.v)); return [u, c, g.id('a', g.appsIn(c.v))]; },
  canAssign: (g) => { const u = g.user(); const c = g.id('c', g.teaching(u.v)); return [u, c, g.id('a', g.appsIn(c.v))]; },
  canEditAppSettings: (g) => { const u = g.user(); const c = g.id('c', g.teaching(u.v)); return [u, c, g.id('a', g.appsIn(c.v))]; },
  reviewRequest: (g) => { const u = g.user(); const c = g.id('c', g.teaching(u.v)); return [u, c, g.id('a', g.appsIn(c.v))]; },
  canGiveFeedback: (g) => { const u = g.user(); const c = g.id('c', g.teaching(u.v)); return [u, c, g.id('u', g.studentsIn(c.v))]; },
  canSeeAssignment: (g) => [g.user(), g.assignment()],
  canManageAssignment: (g) => [g.user(), g.assignment()],
  canMarkDone: (g) => [g.user(), g.assignment()],
  canReadFeedback: (g) => [g.user(), g.feedback()],
  canDeleteFeedback: (g) => [g.user(), g.feedback()],
  canMarkFeedbackRead: (g) => [g.user(), g.feedback()],
  canSeeAnnouncement: (g) => [g.user(), g.announcement()],
  canDeleteAnnouncement: (g) => [g.user(), g.announcement()],
  canDeleteComment: (g) => [g.user(), g.comment()],
  canRemoveFromClass: (g) => { const u = g.user(); const row = g.placement(); return [u, g.classRow(row.v && row.v.class_id), row]; },
  visibleApps: (g) => [g.user(), g.appListOptions()],
  visibleClasses: (g) => [g.user(), g.classListOptions()],
};

/** Every user (and some made-up ones) against every class, app, version and row of the world. */
function runGrid(w, check, r) {
  const g = argumentMaker(w, r);
  const ghost = (kind) => `${kind}9999_grid`;
  const users = [...w.users, null, {}, { id: ghost('u'), role: 'teacher' }, { role: 'admin' }, { id: null, role: 'student' }];
  const classIds = [...w.classes.map((c) => c.id), null, ghost('c'), w.apps.length ? w.apps[0].id : ghost('a')];
  const apps = [...w.apps, null, {}, ...w.apps.slice(0, 1).map((a) => ({ ...a, id: ghost('a') })), ...w.apps.slice(1, 2).map((a) => ({ ...a, owner_id: undefined }))];
  const foreignVersion = (a) => w.versions.find((v) => !a || v.app_id !== a.id);
  const versionIds = (a) => [...w.versions.filter((v) => a && v.app_id === a.id).map((v) => v.id), null, undefined, ghost('v'), foreignVersion(a)?.id].filter((v, i, all) => all.indexOf(v) === i);
  const listOptions = [[], [{}], [{ archived: true }], [{ q: g.query() }], [{ q: g.query(), archived: true }]];
  const appOptions = [[], [{ q: g.query() }], [{ category: 'Englisch' }], [{ q: g.query(), category: 'Mathematik' }], [{ limit: 2 }]];

  for (const u of users) {
    check('isAdmin', [u]);
    check('isStaff', [u]);
    check('canCreateClass', [u]);
    check('canAnnounce', [u, null]);
    for (const o of listOptions) check('visibleClasses', [u, ...o]);
    for (const o of appOptions) check('visibleApps', [u, ...o]);
    for (const c of classIds) for (const fn of ['classRole', 'canViewClass', 'canManageClass', 'canChangeClass', 'canLeaveClass', 'canAnnounce']) check(fn, [u, c]);
    for (const a of apps) {
      for (const fn of ['canManageApp', 'canShareApp', 'isSharedWith', 'canReviewApp', 'reviewClasses', 'isAppOwner', 'appTextLock', 'canEditAppText']) check(fn, [u, a]);
      check('resolvePlay', [u, a]);
      for (const v of versionIds(a)) {
        check('canSeeVersion', [u, a, v]);
        check('resolvePlay', [u, a, { versionId: v }]);
      }
    }
    for (const x of [...w.assignments, null, { class_id: ghost('c'), starts_at: 0 }]) for (const fn of ['canSeeAssignment', 'canManageAssignment', 'canMarkDone']) check(fn, [u, x]);
    for (const f of [...w.feedback, null, {}]) for (const fn of ['canReadFeedback', 'canDeleteFeedback', 'canMarkFeedbackRead']) check(fn, [u, f]);
    for (const n of [...w.announcements, null, { class_id: null }, { class_id: ghost('c') }]) for (const fn of ['canSeeAnnouncement', 'canDeleteAnnouncement']) check(fn, [u, n]);
    for (const k of [...w.comments, null, { kind: 'comment' }, { kind: 'comment', author_id: null }]) check('canDeleteComment', [u, k]);
    for (const code of [...w.codes, null]) for (const fn of ['joinRoleFor', 'removedSince']) check(fn, [u, code]);
  }
  for (const c of classIds) {
    check('isArchived', [c]);
    for (const u of w.users) check('isStudentOf', [c, u.id]);
    for (const a of w.apps) for (const fn of ['appApprovedIn', 'wasApprovedIn']) check(fn, [c, a.id]);
  }
  for (const u of w.users) {
    for (const c of classIds) {
      for (const a of w.apps) {
        check('addToClassMode', [u, a, c]);
        check('resolvePlay', [u, a, { classId: c }]);
        check('canJoinRoom', [u, a, c]);
        check('canAssign', [u, c, a.id]);
        check('canEditAppSettings', [u, c, a.id]);
        check('canSeeClassResults', [u, c, a.id]);
        check('reviewRequest', [u, c, a.id]);
      }
      for (const s of w.users) check('canGiveFeedback', [u, c, s.id]);
    }
  }
  for (const x of w.classApps) {
    const row = { ...x, owner_id: w.apps.find((a) => a.id === x.app_id).owner_id };
    const cls = w.classes.find((c) => c.id === x.class_id);
    const elsewhere = w.classes.find((c) => c.id !== x.class_id) || { id: ghost('c') };
    for (const u of users) {
      check('canRemoveFromClass', [u, cls, row]);
      check('canRemoveFromClass', [u, elsewhere, row]);
    }
  }
}

function runRandom(w, check, r, count) {
  const g = argumentMaker(w, r);
  const names = Object.keys(RANDOM);
  for (let i = 0; i < count; i++) {
    const name = names[r.int(names.length)];
    const parts = RANDOM[name](g);
    check(name, parts.map((p) => p.v), parts.some((p) => p.wrong));
  }
}

/** A fresh database file for one world (src/db.js builds it), removed afterwards. */
function withDatabase(w, fn, file = null) {
  const dir = file ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'schulhub-access-'));
  const db = openDb(file || path.join(dir, 'hub.sqlite'));
  try {
    insertWorld(db, w);
    return fn(createAccess(db), createModel(w));
  } finally {
    db.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}

const RANDOM_CHECKS = 1500;

/**
 * All checks of one world. Returns the counts and the first mismatch of each function that
 * disagrees - by default it stops at the first one (keepGoing: every function's first).
 */
function runWorld(seed, size, { only = null, keepGoing = false } = {}) {
  const w = makeWorld(seed, size);
  return withDatabase(w, (access, model) => {
    const failures = new Map();
    const { check, counts } = createChecker(access, model, {
      only,
      onFailure: (f) => {
        if (!failures.has(f.name)) failures.set(f.name, f);
        if (!keepGoing) throw STOP;
      },
    });
    try {
      runGrid(w, check, randomness(seedOf('grid', seed, size)));
      runRandom(w, check, randomness(seedOf('random', seed, size)), RANDOM_CHECKS);
    } catch (err) {
      if (err !== STOP) throw err;
    }
    return { w, counts, failures };
  });
}

// ================================================================== shrinking

/** Ids a value refers to (deeply): these rows stay while the case is shrunk. */
function idsIn(value, out = new Set()) {
  if (typeof value === 'string') out.add(value);
  else if (Array.isArray(value)) value.forEach((v) => idsIn(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => idsIn(v, out));
  return out;
}

/** Drop rows whose parent is gone, like the database's foreign keys (cascade / set null). */
function prune(w) {
  const has = (rows, key = 'id') => new Set(rows.map((x) => x[key]));
  const U = has(w.users);
  const C = has(w.classes);
  w.members = w.members.filter((m) => C.has(m.class_id) && U.has(m.user_id));
  w.codes = w.codes.filter((k) => C.has(k.class_id));
  w.removals = (w.removals || []).filter((x) => C.has(x.class_id) && U.has(x.user_id));
  w.apps = w.apps.filter((a) => U.has(a.owner_id));
  const A = has(w.apps);
  w.versions = w.versions.filter((v) => A.has(v.app_id));
  w.classApps = w.classApps.filter((x) => C.has(x.class_id) && A.has(x.app_id));
  w.assignments = w.assignments.filter((x) => C.has(x.class_id) && A.has(x.app_id)).map((x) => ({ ...x, created_by: U.has(x.created_by) ? x.created_by : null }));
  const X = has(w.assignments);
  w.feedback = w.feedback
    .filter((f) => C.has(f.class_id) && U.has(f.student_id))
    .map((f) => ({ ...f, author_id: U.has(f.author_id) ? f.author_id : null, app_id: A.has(f.app_id) ? f.app_id : null, assignment_id: X.has(f.assignment_id) ? f.assignment_id : null }));
  w.announcements = w.announcements.filter((n) => n.class_id === null || C.has(n.class_id)).map((n) => ({ ...n, author_id: U.has(n.author_id) ? n.author_id : null }));
  w.comments = w.comments.filter((k) => A.has(k.app_id) && (k.author_id === null || U.has(k.author_id)));
  return w;
}

/** Rows that can go, biggest first (a user takes their apps along). Versions an app or class still uses stay. */
function removable(w, keep) {
  const used = new Set([...w.apps.flatMap((a) => [a.published_version_id, a.schoolwide_version_id, a.schoolwide_requested_version_id]), ...w.classApps.flatMap((x) => [x.version_id, x.requested_version_id])]);
  const out = [];
  for (const table of ['users', 'classes', 'apps', 'versions', 'assignments', 'feedback', 'announcements', 'comments']) {
    for (const x of w[table]) if (!keep.has(x.id) && !(table === 'versions' && used.has(x.id))) out.push([table, (y) => y.id === x.id]);
  }
  for (const x of w.members) out.push(['members', (y) => y === x]);
  for (const x of w.classApps) out.push(['classApps', (y) => y === x]);
  for (const x of w.codes) out.push(['codes', (y) => y === x]);
  return out;
}

function stillFails(w, failure) {
  return withDatabase(w, (access, model) => {
    let failed = false;
    const { check } = createChecker(access, model, { onFailure: () => (failed = true) });
    check(failure.name, failure.args, failure.wrong);
    return failed;
  }, ':memory:');
}

/** Remove rows one by one while the case keeps failing. */
function reduceWorld(w, failure) {
  const keep = idsIn(failure.args);
  let current = w;
  for (let changed = true; changed; ) {
    changed = false;
    for (const [table, match] of removable(current, keep)) {
      if (!current[table].some(match)) continue; // already gone with its parent
      const smaller = prune({ ...current, [table]: current[table].filter((y) => !match(y)) });
      if (stillFails(smaller, failure)) {
        current = smaller;
        changed = true;
      }
    }
  }
  return current;
}

// ================================================================== reporting

const BORING = new Set(['oid', 'email', 'name', 'description', 'emoji', 'color', 'origin_key', 'created_at', 'updated_at', 'joined_at', 'body', 'title', 'note']);
function show(v) {
  if (v === undefined) return 'undefined';
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(show).join(', ')}]`;
  if (typeof v === 'object') {
    const shown = Object.entries(v).filter(([k, x]) => !BORING.has(k) && x !== undefined);
    return `{${shown.map(([k, x]) => `${k}: ${show(x)}`).join(', ')}}`;
  }
  return String(v);
}

function describeWorld(w) {
  const lines = [];
  const at = (t) => (t === null ? '' : t > w.now ? ' (in future)' : ' (past)');
  lines.push(`users: ${w.users.map((u) => `${u.id} ${u.role}${u.disabled ? ' blocked' : ''}`).join(' | ') || '-'}`);
  lines.push(`classes: ${w.classes.map((c) => `${c.id}${c.archived_at ? ' archived' : ''}`).join(' | ') || '-'}`);
  lines.push(`members: ${w.members.map((m) => `${m.class_id}:${m.user_id} ${m.role}`).join(' | ') || '-'}`);
  lines.push(`codes: ${w.codes.map((k) => `${k.class_id} ${k.role}${k.expires_at < w.now ? ' expired' : ''}`).join(' | ') || '-'}`);
  lines.push(`apps: ${w.apps.map((a) => `${a.id} owner ${a.owner_id}${a.published_version_id ? ` published ${a.published_version_id}` : ''}${a.shared ? ' shared' : ''}${a.schoolwide_version_id ? ` school-wide ${a.schoolwide_version_id}` : ''}${a.schoolwide_requested_version_id ? ` school-wide waiting ${a.schoolwide_requested_version_id}` : ''}${a.category ? ` [${a.category}]` : ''}`).join(' | ') || '-'}`);
  lines.push(`versions: ${w.versions.map((v) => `${v.id} of ${v.app_id} ${v.status}`).join(' | ') || '-'}`);
  lines.push(`apps in classes: ${w.classApps.map((x) => `${x.class_id}/${x.app_id} ${x.status}${x.version_id ? ` plays ${x.version_id}` : ''}${x.request_state ? ` ${x.request_state} ${x.requested_version_id}` : ''}${x.multiplayer ? ' multiplayer' : ''}`).join(' | ') || '-'}`);
  lines.push(`assignments: ${w.assignments.map((x) => `${x.id} ${x.class_id}/${x.app_id}${at(x.starts_at)}`).join(' | ') || '-'}`);
  lines.push(`feedback: ${w.feedback.map((f) => `${f.id} ${f.class_id} to ${f.student_id} by ${f.author_id}`).join(' | ') || '-'}`);
  lines.push(`announcements: ${w.announcements.map((n) => `${n.id} ${n.class_id || 'school'} by ${n.author_id}`).join(' | ') || '-'}`);
  lines.push(`comments: ${w.comments.map((k) => `${k.id} ${k.kind} on ${k.app_id} by ${k.author_id}`).join(' | ') || '-'}`);
  return lines;
}

/** Smallest world with the same seed that still fails in the same function, then the rows it needs. */
function shrinkReport(seed, size, w, failure) {
  let best = { size, failure, w };
  for (let s = 1; s < size; s++) {
    const smaller = runWorld(seed, s, { only: failure.name });
    if (smaller.failures.size) {
      best = { size: s, failure: smaller.failures.get(failure.name), w: smaller.w };
      break;
    }
  }
  const f = best.failure;
  const reduced = reduceWorld(best.w, f);
  return [
    `access.${f.name}(${f.args.map(show).join(', ')})`,
    `  access.js: ${f.threw ? `throws ${f.threw}` : show(f.name === 'resolvePlay' ? playView(f.got) : f.got)}`,
    `  model:     ${show(f.want)}${f.wrong ? ' (wrong-typed input: access.js may only deny)' : ''}`,
    `  seed ${seed}, smallest failing size ${best.size} of ${size} - again: ACCESS_SEED=${seed} ACCESS_WORLDS=1 node --test test/access-model.test.js`,
    '  the rows this case needs:',
    ...describeWorld(reduced).map((l) => `    ${l}`),
  ].join('\n');
}

// ======================================================================= tests

/** A small hand-made world (missing tables are empty) in a fresh database. */
function smallWorld(rows, fn) {
  const tables = ['users', 'classes', 'members', 'codes', 'apps', 'versions', 'classApps', 'assignments', 'feedback', 'announcements', 'comments'];
  const now = Date.now();
  const w = { now, ...Object.fromEntries(tables.map((t) => [t, []])), ...rows };
  w.users = w.users.map((u) => ({ oid: `dev-${u.id}`, name: u.id, email: `${u.id}@schule.example`, disabled: 0, created_at: now, ...u }));
  w.classes = w.classes.map((c) => ({ name: c.id, created_at: now, archived_at: null, ...c }));
  w.members = w.members.map((m) => ({ joined_at: now, ...m }));
  w.apps = w.apps.map((a, i) => ({ name: a.id, description: '', emoji: EMOJIS[0], color: 0, origin_key: `a${String(i).padStart(20, '0')}`, category: '', shared: 0, published_version_id: null, schoolwide_version_id: null, schoolwide_requested_version_id: null, created_at: now, updated_at: now, ...a }));
  w.versions = w.versions.map((v) => ({ status: 'ready', created_at: now, ...v }));
  w.classApps = w.classApps.map((x) => ({ version_id: null, requested_version_id: null, request_state: null, multiplayer: 0, created_at: now, ...x }));
  w.feedback = w.feedback.map((f) => ({ author_id: null, app_id: null, assignment_id: null, body: 'Gut', created_at: now, read_at: null, ...f }));
  w.comments = w.comments.map((k) => ({ author_id: null, body: 'Schön', created_at: now, kind: 'comment', version_id: null, class_id: null, ...k }));
  const db = openDb(':memory:');
  try {
    insertWorld(db, w);
    return fn(createAccess(db), w);
  } finally {
    db.close();
  }
}

// ----- regressions found by the model (each failed before its fix)

test('Versionen: canSeeVersion gilt nur für Versionen genau dieser App – nie für null oder die Version einer anderen App', () => {
  smallWorld({
    users: [{ id: 'mia', role: 'student' }, { id: 'lehmann', role: 'teacher' }, { id: 'yilmaz', role: 'teacher' }, { id: 'adler', role: 'admin' }],
    classes: [{ id: '7b' }],
    members: [{ class_id: '7b', user_id: 'lehmann', role: 'teacher' }, { class_id: '7b', user_id: 'mia', role: 'student' }],
    apps: [{ id: 'spiel', owner_id: 'mia', published_version_id: 'spiel-1' }, { id: 'quiz', owner_id: 'yilmaz', published_version_id: 'quiz-1', shared: 1 }],
    versions: [{ id: 'spiel-1', app_id: 'spiel', number: 1 }, { id: 'quiz-1', app_id: 'quiz', number: 1 }],
    // Mia's first submission: nothing approved in the 7b yet, so the class plays no version (version_id NULL).
    classApps: [{ class_id: '7b', app_id: 'spiel', status: 'pending', requested_version_id: 'spiel-1', request_state: 'waiting' }],
  }, (access) => {
    const user = (id) => ({ id, role: { mia: 'student', adler: 'admin' }[id] || 'teacher' });
    const app = (id, extra = {}) => ({ id, owner_id: id === 'spiel' ? 'mia' : 'yilmaz', shared: id === 'quiz' ? 1 : 0, published_version_id: `${id}-1`, ...extra });
    // What each of them may see stays as it was.
    assert.equal(access.canSeeVersion(user('lehmann'), app('spiel'), 'spiel-1'), true, 'the reviewing teacher sees the submitted version');
    assert.equal(access.canSeeVersion(user('mia'), app('spiel'), 'spiel-1'), true, 'the owner sees her version');
    assert.equal(access.canSeeVersion(user('adler'), app('spiel'), 'spiel-1'), true, 'the admin sees every version');
    assert.equal(access.canSeeVersion(user('lehmann'), app('quiz'), 'quiz-1'), true, 'a colleague sees the published version of a shared app');
    // Nothing that is not a version of this app.
    assert.equal(access.canSeeVersion(user('lehmann'), app('spiel'), null), false, 'the teacher: the empty version_id of a pending submission is no version');
    for (const who of ['mia', 'adler']) {
      for (const v of [null, undefined, '', 'quiz-1', 'gibt-es-nicht']) assert.equal(access.canSeeVersion(user(who), app('spiel'), v), false, `${who}: ${show(v)}`);
    }
    assert.equal(access.canSeeVersion(user('mia'), app('spiel', { id: 'quiz' }), 'spiel-1'), false, 'a version is seen only together with its own app');
  });
});

test('Identität: ein Konto ohne echte ID besitzt, schrieb und bekommt nichts – auch wenn der Zeile die ID ebenfalls fehlt', () => {
  smallWorld({
    users: [{ id: 'mia', role: 'student' }, { id: 'lehmann', role: 'teacher' }],
    classes: [{ id: '7b' }],
    members: [{ class_id: '7b', user_id: 'lehmann', role: 'teacher' }, { class_id: '7b', user_id: 'mia', role: 'student' }],
    apps: [{ id: 'spiel', owner_id: 'mia', published_version_id: 'spiel-1' }],
    versions: [{ id: 'spiel-1', app_id: 'spiel', number: 1 }],
    feedback: [{ id: 'f1', class_id: '7b', student_id: 'mia', author_id: null }], // its author's account was deleted
    comments: [{ id: 'k1', app_id: 'spiel', author_id: null }],
  }, (access) => {
    const nobody = [{}, { role: 'student' }, { id: null, role: 'teacher' }, { id: '', role: 'student' }];
    const ownerless = { id: 'spiel', published_version_id: 'spiel-1' }; // an app row without owner_id
    for (const u of nobody) {
      const label = show(u);
      assert.equal(access.canManageApp(u, {}), false, `canManageApp ${label}`);
      assert.equal(access.isAppOwner(u, ownerless), false, `isAppOwner ${label}`);
      assert.equal(access.canReviewApp(u, ownerless), false, `canReviewApp ${label}`);
      assert.equal(access.canEditAppText(u, ownerless), false, `canEditAppText ${label}`);
      assert.equal(access.resolvePlay(u, ownerless), null, `resolvePlay ${label}`);
      assert.equal(access.canSeeVersion(u, ownerless, 'spiel-1'), false, `canSeeVersion ${label}`);
      assert.equal(access.canReadFeedback(u, {}), false, `canReadFeedback ${label}`);
      assert.equal(access.canDeleteFeedback(u, { id: 'f1', class_id: '7b', student_id: 'mia', author_id: null }), false, `canDeleteFeedback ${label}`);
      assert.equal(access.canMarkFeedbackRead(u, {}), false, `canMarkFeedbackRead ${label}`);
      assert.equal(access.canDeleteComment(u, { kind: 'comment', author_id: null }), false, `canDeleteComment ${label}`);
      assert.equal(access.canRemoveFromClass(u, { id: '7b' }, { class_id: '7b', app_id: 'spiel', owner_id: null }), false, `canRemoveFromClass ${label}`);
    }
    // The admin (by role) adds apps they may use - an app without owner is not "their own".
    assert.equal(access.addToClassMode({ role: 'admin' }, ownerless, '7b'), null, 'addToClassMode: no owner, not shared, not school-wide');
    // Real people keep their rights.
    const mia = { id: 'mia', role: 'student' };
    assert.equal(access.canManageApp(mia, { id: 'spiel', owner_id: 'mia' }), true);
    assert.equal(access.canDeleteFeedback(mia, { id: 'f1', class_id: '7b', student_id: 'mia', author_id: null }), true, 'the student deletes feedback to her');
    assert.equal(access.canReadFeedback({ id: 'lehmann', role: 'teacher' }, { class_id: '7b', student_id: 'mia' }), true);
  });
});

test('Entdecken: die geteilte App einer Kollegin öffnet sich als Vorschau – kein toter Link, auch nicht zurück', async () => {
  const h = await startHub();
  try {
    const ahorn = h.addUser('Frau Ahorn', 'teacher');
    const birke = h.addUser('Herr Birke', 'teacher');
    const sina = h.addUser('Sina Sorgsam', 'student');
    const [A, B, S] = await Promise.all([ahorn, birke, sina].map((u) => h.browser().login(u)));
    const app = await h.makeApp(A, 'Geteiltes Quiz', { 'index.html': '<h1>Quiz</h1>' });
    assert.equal((await A.post(`/apps/${app.id}/bearbeiten`, { name: 'Geteiltes Quiz', emoji: EMOJIS[0], color: '0', shared_field: '1', shared: '1' })).status, 303);

    // Herr Birke finds it in "Entdecken" (access.visibleApps: shared with staff) ...
    const catalogue = (await B.get('/katalog?zeige=kollegium')).text;
    const link = new RegExp(`class="row-link row-title" href="(/apps/${app.id}/spielen[^"]*)"`).exec(catalogue);
    assert.ok(link, 'the shared app is listed for a colleague');
    // ... and the link opens it - as a preview of the published version, nothing is stored.
    const player = await B.get(link[1].replaceAll('&amp;', '&'));
    assert.equal(player.status, 200, `${link[1]} opens`);
    assert.match(player.text, /Vorschau/);
    const version = /data-version="([^"]*)"/.exec(player.text)[1];
    assert.equal(version, app.published_version_id, 'the published version');
    const token = await h.token(B, app, null, version);
    assert.equal(token.mode, 'preview');
    // The way back leads to a page he may open.
    const back = /href="([^"]+)" aria-label="Zurück"/.exec(player.text)[1];
    assert.equal((await B.get(back)).status, 200, `back to ${back}`);

    // Students never see a colleague's shared app.
    assert.ok(!(await S.get('/katalog')).text.includes(`/apps/${app.id}/`), 'not in a student\'s catalogue');
    assert.equal((await S.get(`/apps/${app.id}/spielen?version=${version}`)).status, 404);
  } finally {
    await h.stop();
  }
});

test('Rechtemodell: jede Funktion von access.js hat eine Regel im Modell und zufällige Fälle', () => {
  // A new permission rule (hard rule 10: every feature gets its check in access.js) must also get its
  // rule in the model, its place in FUNCTIONS and its random cases - otherwise it would go unchecked here.
  assert.deepEqual(Object.keys(createAccess(null)).sort(), [...FUNCTIONS].sort());
  const model = createModel(makeWorld(1, 1));
  for (const name of FUNCTIONS) {
    assert.equal(typeof model[name], 'function', `the model has no rule for ${name}`);
    assert.equal(typeof RANDOM[name], 'function', `no random cases for ${name}`);
  }
});

test('Rechtemodell: access.js entscheidet in zufälligen Welten wie das Referenzmodell – auch bei Unsinn', (t) => {
  const started = process.hrtime.bigint();
  const total = { worlds: 0, checks: 0, thrown: 0, granted: 0, thrownBy: {} };
  const reports = [];
  const failedFunctions = new Set();
  for (let i = 0; i < WORLDS && (KEEP_GOING || !reports.length); i++) {
    const seed = (BASE_SEED + i) >>> 0;
    const run = runWorld(seed, sizeOf(seed), { keepGoing: KEEP_GOING });
    total.worlds++;
    total.checks += run.counts.checks;
    total.thrown += run.counts.thrown;
    total.granted += run.counts.granted;
    for (const [name, n] of Object.entries(run.counts.thrownBy)) total.thrownBy[name] = (total.thrownBy[name] || 0) + n;
    for (const [name, failure] of run.failures) {
      if (failedFunctions.has(name)) continue;
      failedFunctions.add(name);
      reports.push(shrinkReport(seed, sizeOf(seed), run.w, failure));
    }
  }
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  t.diagnostic(`${total.worlds} worlds, ${total.checks} checks (${total.granted} grants), ${Math.round(ms)} ms`);
  t.diagnostic(`wrong-typed ids that made access.js throw (it denies): ${Object.entries(total.thrownBy).map(([k, n]) => `${k} ×${n}`).join(', ') || 'none'}`);
  assert.equal(reports.length, 0, `access.js and the reference model disagree:\n\n${reports.join('\n\n')}`);
});

// ============================================================ the HTTP slice
//
// Worlds of size 4 in a real Hub; every account that is not blocked signs in. For sampled
// (user, action, target) triples the request goes through the real routes, and the answer must
// be the one access.js gives at that moment (asked right before each request, so that joining,
// leaving, adding and removing along the way are taken into account).

const HTTP_WORLDS = 3;

/** One world in a fresh Hub. Disagreements go to tally.problems. */
async function httpWorld(seed, tally) {
  // Limits are not under test here: a few hundred requests per person must not be slowed down.
  const h = await startHub({ rate: { write: [1e6, 60_000], joinFail: [1e6, 600_000], submit: [1e6, 3_600_000], sdk: [1e6, 60_000] } });
  const { problems, answers } = tally;
  try {
    const w = makeWorld(seed, 4);
    // Every world has a teacher whom the admin made a student and who kept a class entry.
    const student = w.users.find((u) => u.role === 'student' && !u.disabled);
    const demoted = w.members.some((m) => m.role === 'teacher' && w.users.find((u) => u.id === m.user_id).role === 'student');
    const free = w.classes.find((c) => !c.archived_at && !w.members.some((m) => m.class_id === c.id && m.user_id === student.id));
    if (!demoted && free) w.members.push({ class_id: free.id, user_id: student.id, role: 'teacher', joined_at: w.now - DAY });
    insertWorld(h.db, w);
    const { db } = h;
    const { access } = h.hub.ctx;
    const r = randomness(seedOf('http checks', seed));
    const ghost = (kind) => `${kind}9999_${r.token(8)}`;
    const OUTCOMES = new Set(['ok', 'forbidden', 'no_class', 'read_only', 'preview', 'live']);
    const note = (label, got, want) => {
      if (typeof want === 'number' || OUTCOMES.has(want)) answers[want] = (answers[want] || 0) + 1;
      if (!isDeepStrictEqual(got, want)) problems.push(`${label}: got ${show(got)}, access.js says ${show(want)}`);
    };
    const row = {
      user: (id) => db.get('SELECT * FROM users WHERE id = ?', id) || null,
      cls: (id) => db.get('SELECT * FROM classes WHERE id = ?', id) || null,
      app: (id) => db.get('SELECT * FROM apps WHERE id = ?', id) || null,
      version: (id, appId) => db.get('SELECT * FROM app_versions WHERE id = ? AND app_id = ?', id, appId) || null,
    };

    // Sign in. A blocked account is refused at the door.
    const browsers = new Map();
    for (const u of w.users) {
      const b = h.browser();
      if (u.disabled) {
        await b.page('/');
        note(`blocked ${u.id} signs in`, (await b.post('/dev/login', { user: u.id })).status, 403);
      } else {
        browsers.set(u.id, await b.login(u));
      }
      tally.requests += 3;
    }
    const people = w.users.filter((u) => !u.disabled);
    const as = (u) => {
      const b = browsers.get(u.id);
      const count = (p) => {
        tally.requests++;
        return p;
      };
      return {
        get: (url) => count(b.get(url)),
        post: (url, fields) => count(b.post(url, fields)),
        send: (method, url, body) => count(b.send(method, url, body)),
        api: async (app, token, method, params) => (await count(b.api(app, token, method, params))).json(),
      };
    };

    // Targets: mostly ones that belong to the person, sometimes anything, sometimes nonsense.
    const classesOf = (u) => db.all('SELECT class_id FROM class_members WHERE user_id = ?', u.id).map((x) => x.class_id);
    const appsIn = (c) => db.all('SELECT app_id FROM class_apps WHERE class_id = ?', c).map((x) => x.app_id);
    const pickClass = (u) => {
      const mine = classesOf(u);
      if (mine.length && r.chance(0.55)) return r.pick(mine);
      return r.chance(0.85) ? r.pick(w.classes).id : r.pick([ghost('c'), r.pick(w.apps).id]);
    };
    const pickApp = (c) => {
      const here = c ? appsIn(c) : [];
      if (here.length && r.chance(0.6)) return r.pick(here);
      return r.chance(0.9) ? r.pick(w.apps).id : ghost('a');
    };
    const pickVersion = (appId) => {
      const own = w.versions.filter((v) => v.app_id === appId).map((v) => v.id);
      if (own.length && r.chance(0.7)) return r.pick(own);
      return r.pick([r.pick(w.versions)?.id || ghost('v'), ghost('v')]);
    };
    const pickRow = (rows, kind) => (rows.length && r.chance(0.9) ? r.pick(rows).id : ghost(kind));
    const studentOf = (c) => {
      const students = db.all("SELECT user_id FROM class_members WHERE class_id = ? AND role = 'student'", c).map((x) => x.user_id);
      return students.length && r.chance(0.7) ? r.pick(students) : r.chance(0.8) ? r.pick(w.users).id : ghost('u');
    };
    const who = (u) => `${u.id} (${u.role})`;

    /** What the player may run (routes/player.js, SECURITY.md "A stale class in a player link"). */
    const decide = (u, app, klasse, version) => {
      if (!app) return null;
      const play = access.resolvePlay(u, app, { classId: klasse || null, versionId: version || null });
      if (play || !klasse || version || !app.schoolwide_version_id) return play;
      // The fallback opens the app school-wide WITHOUT a class: the link named a class the app is not
      // in, and no other class of the person may stand in for it (test/matrix.test.js, schulweitFremdeKlasse).
      const open = access.resolvePlay(u, app);
      return open && { ...open, classId: null };
    };

    // ----- page views
    for (let i = 0; i < 70; i++) {
      const u = r.pick(people);
      const c = pickClass(u);
      note(`${who(u)} GET /klassen/${c}`, (await as(u).get(`/klassen/${c}`)).status, access.canViewClass(u, c) ? 200 : 404);
      note(`${who(u)} GET /klassen/${c}/mitglieder`, (await as(u).get(`/klassen/${c}/mitglieder`)).status, access.canManageClass(u, c) ? 200 : 404);
    }
    for (let i = 0; i < 60; i++) {
      const u = r.pick(people);
      const a = pickApp(r.chance(0.5) ? pickClass(u) : null);
      const app = row.app(a);
      const want = app && access.canReviewApp(u, app) ? 200 : app && access.resolvePlay(u, app) ? 302 : 404;
      note(`${who(u)} GET /apps/${a}`, (await as(u).get(`/apps/${a}`)).status, want);
    }
    for (let i = 0; i < 50; i++) {
      const u = r.pick(people);
      const x = pickRow(w.assignments, 'x');
      const asg = db.get('SELECT * FROM assignments WHERE id = ?', x);
      note(`${who(u)} GET /aufgaben/${x}`, (await as(u).get(`/aufgaben/${x}`)).status, asg && access.canSeeAssignment(u, asg) ? 200 : 404);
    }
    for (let i = 0; i < 50; i++) {
      const u = r.pick(people);
      const c = pickClass(u);
      const a = pickApp(c);
      const app = row.app(a);
      const request = access.reviewRequest(u, c, a);
      const v = request && row.version(request.requested_version_id, a);
      const want = request && app && v && v.status === 'ready' && access.canSeeVersion(u, app, v.id) ? 200 : 404;
      note(`${who(u)} GET /pruefen/${c}/${a}`, (await as(u).get(`/pruefen/${c}/${a}`)).status, want);
    }
    for (let i = 0; i < 60; i++) {
      const u = r.pick(people);
      const a = pickApp(r.chance(0.5) ? pickClass(u) : null);
      const vid = pickVersion(a);
      const app = row.app(a);
      const v = row.version(vid, a);
      // routes/apps.js: the app page's readers (canReviewApp), and the version for them (canSeeVersion).
      const want = app && access.canReviewApp(u, app) && v && v.status === 'ready' && access.canSeeVersion(u, app, vid) ? 200 : 404;
      note(`${who(u)} GET /apps/${a}/versionen/${vid}/quelltext`, (await as(u).get(`/apps/${a}/versionen/${vid}/quelltext`)).status, want);
      note(`${who(u)} GET /apps/${a}/versionen/${vid}/download`, (await as(u).get(`/apps/${a}/versionen/${vid}/download`)).status, want);
    }

    // ----- results and per-class settings
    for (let i = 0; i < 60; i++) {
      const u = r.pick(people);
      const c = pickClass(u);
      const a = pickApp(c);
      const s = studentOf(c);
      const results = access.canSeeClassResults(u, c, a);
      const base = `/klassen/${c}/apps/${a}`;
      note(`${who(u)} GET ${base}/ergebnisse`, (await as(u).get(`${base}/ergebnisse`)).status, results ? 200 : 404);
      note(`${who(u)} GET ${base}/ergebnisse.csv`, (await as(u).get(`${base}/ergebnisse.csv`)).status, results ? 200 : 404);
      note(`${who(u)} GET ${base}/ergebnisse/${s}`, (await as(u).get(`${base}/ergebnisse/${s}`)).status, results && access.canSeeStudentData(u, c, a, s) && row.user(s) ? 200 : 404);
      note(`${who(u)} GET ${base}/einstellungen`, (await as(u).get(`${base}/einstellungen`)).status, access.canEditAppSettings(u, c, a) ? 200 : 404);
    }

    // ----- player, token and SDK writes
    for (let i = 0; i < 160; i++) {
      const u = r.pick(people);
      let c = '';
      let a;
      let v = '';
      const how = r.next();
      if (how < 0.4) {
        // an app of one of the person's classes, opened from that class
        c = pickClass(u);
        a = pickApp(c);
      } else if (how < 0.6) {
        // something from the person's catalogue, opened without a class
        const visible = access.visibleApps(u, { limit: 200 });
        a = visible.length ? r.pick(visible).id : pickApp(null);
      } else if (how < 0.75) {
        // a preview of one version (the person's own app, or any)
        const own = w.apps.filter((x) => x.owner_id === u.id);
        a = own.length && r.chance(0.6) ? r.pick(own).id : pickApp(null);
        v = pickVersion(a);
        if (r.chance(0.3)) c = pickClass(u);
      } else {
        c = r.chance(0.5) ? pickClass(u) : '';
        a = pickApp(c || null);
        v = r.chance(0.35) ? pickVersion(a) : '';
      }
      const app = row.app(a);
      const play = decide(u, app, c, v);
      const query = new URLSearchParams(Object.entries({ klasse: c, version: v }).filter(([, x]) => x)).toString();
      const url = `/apps/${a}/spielen${query ? `?${query}` : ''}`;
      const page = await as(u).get(url);
      note(`${who(u)} GET ${url}`, page.status, play ? 200 : 404);
      if (page.status === 200 && play) {
        // The page hands the token route exactly the link's class (public/player.js), so both decide alike;
        // the class context itself is checked on the token below.
        note(`${who(u)} GET ${url}: class asked for`, /data-class="([^"]*)"/.exec(page.text)?.[1], c || '');
        note(`${who(u)} GET ${url}: preview of`, /data-version="([^"]*)"/.exec(page.text)?.[1], play.preview ? play.version.id : '');
        const back = /href="([^"]+)" aria-label="Zurück"/.exec(page.text)?.[1];
        note(`${who(u)} GET ${url}: back to ${back}`, (await as(u).get(back)).status, 200);
      }
      if (!play && i % 3) continue; // every page that opens (and some that do not) also asks for an SDK token and writes with it
      const res = await as(u).send('POST', `/apps/${a}/token`, { klasse: c || null, version: v || null, first: true });
      note(`${who(u)} POST /apps/${a}/token ${show({ klasse: c, version: v })}`, res.status, play ? 200 : 404);
      if (res.status !== 200 || !play) continue;
      const tok = res.json();
      const label = `${who(u)} token for ${a} ${show({ klasse: c, version: v })}`;
      note(`${label}: mode`, tok.mode, play.preview ? 'preview' : 'live');
      note(`${label}: class`, Boolean(tok.class), Boolean(play.classId) && !access.isArchived(play.classId));
      note(`${label}: isTeacher`, tok.user.isTeacher, Boolean(play.classId) && access.canManageClass(u, play.classId));
      // SECURITY.md: class context only while the person may view the (active) class; class data only
      // for its teachers; app-wide data only in staff owners' apps, by the owner or the admin.
      const context = typeof play.classId === 'string' && access.canViewClass(u, play.classId) && !access.isArchived(play.classId) ? play.classId : null;
      const outcome = (x) => (x.ok ? 'ok' : x.error.code);
      note(`${label}: save.set`, outcome(await as(u).api(app, tok.token, 'save.set', { key: 'k', value: i })), 'ok');
      note(`${label}: class.set`, outcome(await as(u).api(app, tok.token, 'class.set', { key: 'k', value: i })), !context ? 'no_class' : access.canManageClass(u, context) ? 'ok' : 'forbidden');
      const owner = row.user(app.owner_id);
      note(`${label}: shared.set`, outcome(await as(u).api(app, tok.token, 'shared.set', { key: 'k', value: i })), !access.isStaff(owner) ? 'read_only' : access.canManageApp(u, app) ? 'ok' : 'forbidden');
      const last = db.get('SELECT COALESCE(MAX(id), 0) AS id FROM results').id;
      note(`${label}: results.add`, outcome(await as(u).api(app, tok.token, 'results.add', { title: 'Runde', score: 1, maxScore: 2 })), 'ok');
      const stored = db.get('SELECT class_id FROM results WHERE id > ? AND app_id = ? AND user_id = ?', last, a, u.id);
      note(`${label}: result filed in`, stored ? stored.class_id : 'nothing stored', play.preview ? 'nothing stored' : context);
    }

    // ----- lists: the catalogue shows exactly access.visibleApps ("apps this user can open"), and
    // every link it shows opens; the search shows nothing else, and its links open too
    const appLinks = (text) => [...text.matchAll(/class="row-link row-title" href="(\/apps\/([^"/?]+)\/spielen[^"]*)"/g)].map((m) => ({ href: m[1].replaceAll('&amp;', '&'), id: m[2] }));
    for (const u of people) {
      const visible = new Map(access.visibleApps(u, { limit: 200 }).map((a) => [a.id, a]));
      const how = (id) => show(Object.fromEntries(['mine', 'in_class', 'schoolwide', 'shared_staff'].map((k) => [k, Boolean(visible.get(id)?.[k])])));
      const shown = appLinks((await as(u).get('/katalog')).text);
      note(`${who(u)} GET /katalog`, shown.map((l) => l.id).sort(), [...visible.keys()].sort());
      for (const l of shown) note(`${who(u)} /katalog ${how(l.id)} -> GET ${l.href}`, (await as(u).get(l.href)).status, 200);
      const q = r.pick(['Quiz', 'Lern', 'Pixel', 'Klasse', 'Kopf', 'Sterne', 'Ma']);
      const search = (await as(u).get(`/suche?q=${encodeURIComponent(q)}`)).text;
      const found = new Set(access.visibleApps(u, { q, limit: 200 }).map((a) => a.id));
      for (const l of appLinks(search)) {
        note(`${who(u)} /suche?q=${q} shows app ${l.id}`, found.has(l.id), true);
        note(`${who(u)} /suche?q=${q} ${how(l.id)} -> GET ${l.href}`, (await as(u).get(l.href)).status, 200);
      }
      for (const [, c] of search.matchAll(/href="\/klassen\/([^"/?#]+)"/g)) note(`${who(u)} /suche?q=${q} -> GET /klassen/${c}`, (await as(u).get(`/klassen/${c}`)).status, 200);
    }

    // ----- changes: feedback, announcements, joining, assignments, apps in classes, leaving
    // (Every expectation is taken from access.js BEFORE its request: a request may delete its target.)
    for (let i = 0; i < 40; i++) {
      const u = r.pick(people);
      const f = pickRow(w.feedback, 'f');
      const fb = db.get('SELECT * FROM feedback WHERE id = ?', f);
      // routes/teaching.js: the feedback is loaded for people who may read it, then the step itself is checked.
      const markable = Boolean(fb) && access.canReadFeedback(u, fb) && access.canMarkFeedbackRead(u, fb);
      note(`${who(u)} POST /rueckmeldungen/${f}/gelesen`, (await as(u).post(`/rueckmeldungen/${f}/gelesen`)).status, markable ? 303 : 404);
      if (i % 3) continue;
      const removable = Boolean(fb) && access.canReadFeedback(u, fb) && access.canDeleteFeedback(u, fb);
      note(`${who(u)} POST /rueckmeldungen/${f}/loeschen`, (await as(u).post(`/rueckmeldungen/${f}/loeschen`)).status, removable ? 303 : 404);
    }
    for (let i = 0; i < 40; i++) {
      const u = r.pick(people);
      const n = pickRow(w.announcements, 'n');
      const an = db.get('SELECT * FROM announcements WHERE id = ?', n);
      const visible = Boolean(an) && access.canSeeAnnouncement(u, an);
      note(`${who(u)} POST /mitteilungen/ankuendigung/${n}/ausblenden`, (await as(u).post(`/mitteilungen/ankuendigung/${n}/ausblenden`)).status, visible ? 303 : 404);
      if (i % 4 === 0) {
        const deletable = Boolean(an) && access.canDeleteAnnouncement(u, an);
        note(`${who(u)} POST /ankuendigungen/${n}/loeschen`, (await as(u).post(`/ankuendigungen/${n}/loeschen`)).status, deletable ? 303 : 404);
      }
    }
    // Everybody tries to write to the whole school and to a class they teach (or any class).
    for (const u of people) {
      const teaching = db.all("SELECT class_id FROM class_members WHERE user_id = ? AND role = 'teacher'", u.id).map((x) => x.class_id);
      for (const ziel of ['schule', teaching.length ? r.pick(teaching) : pickClass(u)]) {
        // SECURITY.md: "/ankuendigungen is staff only (404 for students). One class only via access.canAnnounce"
        const want = access.isStaff(u) && (ziel === 'schule' ? access.canAnnounce(u, null) : Boolean(row.cls(ziel)) && access.canAnnounce(u, ziel)) ? 303 : 404;
        note(`${who(u)} POST /ankuendigungen ziel=${ziel}`, (await as(u).post('/ankuendigungen', { ziel, titel: 'Wandertag' })).status, want);
      }
    }
    for (let i = 0; i < 50; i++) {
      const u = r.pick(people);
      const k = w.codes.length && r.chance(0.9) ? r.pick(w.codes).code : r.token(32);
      const code = db.get('SELECT * FROM join_codes WHERE code = ?', k);
      const valid = Boolean(code) && code.expires_at > Date.now() && !access.isArchived(code.class_id);
      const before = code && access.classRole(u, code.class_id);
      const role = valid ? access.joinRoleFor(u, code) : null;
      // An expired link to one's own class leads to it; a teacher invitation turns a student member who is staff into a teacher.
      const backToOwn = Boolean(code) && code.expires_at <= Date.now() && Boolean(before) && access.canViewClass(u, code.class_id);
      const upgrade = before === 'student' && role === 'teacher';
      const view = await as(u).get(`/beitreten/${k}`);
      note(`${who(u)} GET /beitreten/${k}`, view.status, backToOwn ? 302 : !valid ? 400 : before && !upgrade ? 302 : 200);
      if (view.status === 200 && valid && !before) {
        // Someone a code is not for learns nothing about the class.
        note(`${who(u)} GET /beitreten/${k} names the class`, view.text.includes(row.cls(code.class_id).name), Boolean(role));
      }
      if (i % 2) continue;
      note(`${who(u)} POST /beitreten/${k}`, (await as(u).post(`/beitreten/${k}`)).status, backToOwn || (valid && role) ? 303 : 400);
      if (code) note(`${who(u)} role in ${code.class_id} after joining`, access.classRole(u, code.class_id), upgrade ? 'teacher' : before || role || null);
    }
    for (let i = 0; i < 40; i++) {
      const u = r.pick(people);
      const x = pickRow(w.assignments, 'x');
      const asg = db.get('SELECT * FROM assignments WHERE id = ?', x);
      const want = !asg || !access.canSeeAssignment(u, asg) || !access.canMarkDone(u, asg) ? 404 : asg.starts_at > Date.now() ? 400 : 303;
      note(`${who(u)} POST /aufgaben/${x}/erledigt`, (await as(u).post(`/aufgaben/${x}/erledigt`)).status, want);
    }
    const allowedOr404 = (allowed, status) => (allowed ? [303, 400].includes(status) : status === 404);
    for (let i = 0; i < 60; i++) {
      const u = r.pick(people);
      const c = pickClass(u);
      const a = r.chance(0.5) ? pickApp(c) : pickApp(null);
      const app = row.app(a);
      if (i % 2) {
        // Into a class: the person must see the class, then access.addToClassMode decides (the state machine may still refuse with 400).
        const allowed = Boolean(row.cls(c)) && access.canViewClass(u, c) && Boolean(access.addToClassMode(u, app, c));
        const res = await as(u).post(`/klassen/${c}/apps`, { app: a });
        note(`${who(u)} POST /klassen/${c}/apps app=${a}: ${res.status}`, allowedOr404(allowed, res.status), true);
      } else {
        const placed = db.get('SELECT ca.*, a.owner_id FROM class_apps ca JOIN apps a ON a.id = ca.app_id WHERE ca.class_id = ? AND ca.app_id = ?', c, a);
        const allowed = Boolean(row.cls(c)) && access.canViewClass(u, c) && Boolean(placed) && access.canRemoveFromClass(u, row.cls(c), placed);
        const res = await as(u).post(`/klassen/${c}/apps/${a}/entfernen`);
        note(`${who(u)} POST /klassen/${c}/apps/${a}/entfernen: ${res.status}`, allowedOr404(allowed, res.status), true);
      }
    }
    for (let i = 0; i < 20; i++) {
      const u = r.pick(people);
      const c = pickClass(u);
      const want = !row.cls(c) || !access.canViewClass(u, c) || !access.classRole(u, c) ? 404 : access.canLeaveClass(u, c) ? 303 : 400;
      note(`${who(u)} POST /klassen/${c}/verlassen`, (await as(u).post(`/klassen/${c}/verlassen`)).status, want);
    }
  } finally {
    await h.stop();
  }
}

test('Rechtemodell über HTTP: Seiten, Player und Token, SDK-Schreiben, Ergebnisse und Beitreten entscheiden wie access.js', async (t) => {
  const tally = { problems: [], answers: {}, requests: 0 };
  for (let n = 0; n < HTTP_WORLDS; n++) {
    const seed = seedOf('http', BASE_SEED, n);
    const before = tally.problems.length;
    await httpWorld(seed, tally);
    if (tally.problems.length > before) tally.problems.splice(before, 0, `-- world ${n} (seed ${seed}; again: ACCESS_SEED=${BASE_SEED})`);
  }
  t.diagnostic(`${HTTP_WORLDS} worlds, ${tally.requests} requests through the routes; expected answers: ${Object.entries(tally.answers).map(([k, n]) => `${k} ×${n}`).join(', ')}`);
  assert.deepEqual(tally.problems, [], `routes and access.js decide differently:\n${tally.problems.join('\n')}`);
});
