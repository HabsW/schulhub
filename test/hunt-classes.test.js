'use strict';
// Bug hunt: classes and membership. Each test plays one situation a student, a teacher or the
// admin really runs into (a colleague who tried the class QR code first, a teacher with many
// classes, a deleted class, a hand-made request) and checks what they see and what is stored.
// Tests marked `todo` show a confirmed problem whose fix is a product decision: they run and
// report, but do not fail the suite.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startHub } = require('./helpers');

let h;
let tom, beta, mia;
let T, BT, M;

let seq = 0;
const uniq = (prefix) => `${prefix} ${++seq}`;
const idFrom = (res) => res.headers.location.split('?')[0].split('/').pop();
const joinCode = (classId, role = 'student') => h.db.get('SELECT code FROM join_codes WHERE class_id = ? AND role = ? ORDER BY created_at DESC', classId, role)?.code;
const classRole = (userId, classId) => h.db.get('SELECT role FROM class_members WHERE class_id = ? AND user_id = ?', classId, userId)?.role ?? null;
const csrfOf = (res) => /<meta name="csrf" content="([^"]*)"/.exec(res.text)[1];
const flashOf = (res) => /<div class="notice[^"]*\bflash\b[^>]*>([\s\S]*?)<\/div>/.exec(res.text)?.[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() ?? '';

async function newClass(Tb, name = uniq('Klasse')) {
  const res = await Tb.post('/klassen', { name });
  assert.equal(res.status, 303);
  return { id: idFrom(res), name };
}
async function person(name, role) {
  const user = h.addUser(name, role);
  return { user, b: await h.browser().login(user) };
}

before(async () => {
  h = await startHub();
  tom = h.addUser('Tom Lehrer', 'teacher');
  beta = h.addUser('Frau Beta', 'teacher');
  mia = h.addUser('Mia Kind', 'student');
  [T, BT, M] = await Promise.all([tom, beta, mia].map((u) => h.browser().login(u)));
});
after(() => h.stop());

// ------------------------------------------------------------ co-teacher invitation

test('Einladung: eine Lehrkraft, die die Klasse vorher per QR-Code als Schüler/in betreten hat, wird mit der Einladung Lehrkraft – nicht still übergangen', async () => {
  const c = await newClass(T);
  // Frau Beta tries the class QR code on her phone first (as teachers do): she becomes a student - by design.
  assert.equal((await BT.post(`/beitreten/${joinCode(c.id)}`)).status, 303);
  assert.equal(classRole(beta.id, c.id), 'student');
  // Then Tom invites her to teach the class with him.
  await T.page(`/klassen/${c.id}/mitglieder`);
  assert.equal((await T.post(`/klassen/${c.id}/einladung`, { minuten: '60' })).status, 303);
  const invite = joinCode(c.id, 'teacher');

  // The invitation shows what it is for - not a silent jump to her student view of the class.
  const look = await BT.get(`/beitreten/${invite}`);
  assert.equal(look.status, 200, 'the invitation page is shown');
  assert.ok(look.text.includes('Als Lehrkraft beitreten'));
  assert.equal(classRole(beta.id, c.id), 'student', 'looking alone changes nothing');

  await BT.page('/start');
  const done = await BT.post(`/beitreten/${invite}`);
  assert.equal(done.status, 303);
  assert.equal(classRole(beta.id, c.id), 'teacher', 'the invitation made her a teacher of the class');
  assert.match(flashOf(await BT.get(done.headers.location)), /führst „.*“ jetzt mit/);
  assert.equal((await BT.get(`/klassen/${c.id}/mitglieder`)).status, 200, 'she sees the teacher tabs');
  assert.equal(h.db.get("SELECT COUNT(*) AS n FROM audit_log WHERE actor_id = ? AND action = 'klasse_beigetreten' AND detail = 'als Lehrkraft'", beta.id).n, 1);

  // Nothing else moves: a student account in the class gets nothing from the invitation ...
  assert.equal((await M.post(`/beitreten/${joinCode(c.id)}`)).status, 303);
  await M.page('/start');
  assert.equal((await M.post(`/beitreten/${invite}`)).status, 400);
  assert.equal(classRole(mia.id, c.id), 'student');
  // ... and a teacher of the class who opens the class code stays its teacher.
  await T.page('/start');
  assert.equal((await T.post(`/beitreten/${joinCode(c.id)}`)).status, 303);
  assert.equal(classRole(tom.id, c.id), 'teacher');
  assert.equal((await BT.post(`/beitreten/${joinCode(c.id)}`)).status, 303);
  assert.equal(classRole(beta.id, c.id), 'teacher', 'the class code never turns a teacher back into a student');
});
