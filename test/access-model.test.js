'use strict';
// Focused regression tests for the permission module (src/access.js) and the routes that use it:
// disagreements found by comparing access.js with a reference model of its documented rules.
// Each test failed before its fix.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createAccess } = require('../src/access');
const { EMOJIS } = require('../src/html');
const { startHub } = require('./helpers');

/** The world as rows of a real database (schema and migrations from src/db.js). */
function insertWorld(db, w) {
  db.tx(() => {
    for (const u of w.users) db.run('INSERT INTO users (id, oid, name, email, role, disabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', u.id, u.oid, u.name, u.email, u.role, u.disabled, u.created_at);
    for (const c of w.classes) db.run('INSERT INTO classes (id, name, created_at, archived_at) VALUES (?, ?, ?, ?)', c.id, c.name, c.created_at, c.archived_at);
    for (const m of w.members) db.run('INSERT INTO class_members (class_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)', m.class_id, m.user_id, m.role, m.joined_at);
    for (const k of w.codes) db.run('INSERT INTO join_codes (code, class_id, created_by, created_at, expires_at, role) VALUES (?, ?, ?, ?, ?, ?)', k.code, k.class_id, k.created_by, k.created_at, k.expires_at, k.role);
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
