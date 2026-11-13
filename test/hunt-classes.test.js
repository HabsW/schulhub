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

// ------------------------------------------------------------- class lists

test('Startseite: eine Lehrkraft mit mehr als 12 Klassen sieht die richtige Zahl und kommt zu allen', async () => {
  const { user, b } = await person('Herr Viele', 'teacher');
  const names = [];
  for (let i = 0; i < 13; i++) names.push((await newClass(b, `Kurs ${String(i).padStart(2, '0')}`)).name);
  await b.get('/klassen'); // the flash of the last "angelegt" is shown here, not on the start page
  const start = (await b.get('/start')).text;
  const stat = /<span class="stat-label">Klassen<\/span><span class="stat-value">(\d+)<\/span>/.exec(start);
  assert.equal(stat && stat[1], '13', 'the number on the start page counts every class');
  const main = start.split('<main')[1];
  const listed = names.filter((n) => main.includes(`>${n}<`));
  // At most 12 rows, but then the way to all of them is on the page.
  assert.ok(listed.length === 13 || /href="\/klassen"[^>]*>(?:<svg[\s\S]*?<\/svg>)?<span>Alle 13 Klassen<\/span>/.test(main), `listed ${listed.length} of 13 and no link to all of them`);
  assert.equal(h.db.get("SELECT COUNT(*) AS n FROM class_members WHERE user_id = ? AND role = 'teacher'", user.id).n, 13);
});

// ------------------------------------------------------------- deleting a class

test('Klasse löschen: Mitteilungen, die in die Klasse führen, verschwinden mit ihr – auf jedem Weg, andere Klassen bleiben', async () => {
  const quiz = await h.makeApp(T, uniq('Quiz'), { 'index.html': '<h1>Quiz</h1>' });
  h.db.run('UPDATE apps SET shared = 1 WHERE id = ?', quiz.id); // colleagues may use it in their classes
  const own = await h.makeApp(M, uniq('Mias Spiel'), { 'index.html': '<h1>Mia</h1>' });

  /** A class of `Tb` with Mia, an assignment (Mia is told) and Mia's app waiting (the teachers are told). */
  async function busyClass(Tb) {
    const c = await newClass(Tb);
    assert.equal((await M.post(`/beitreten/${joinCode(c.id)}`)).status, 303);
    assert.equal((await Tb.post(`/klassen/${c.id}/apps`, { app: quiz.id })).status, 303);
    const x = await Tb.post(`/klassen/${c.id}/aufgaben`, { app: quiz.id, titel: uniq('Aufgabe') });
    assert.equal(x.status, 303);
    assert.equal((await M.post(`/klassen/${c.id}/apps`, { app: own.id })).status, 303);
    return { ...c, x: idFrom(x) };
  }
  const leading = (c) => h.db.all("SELECT user_id, href FROM notices WHERE href = ? OR href LIKE '/pruefen/' || ? || '/%'", `/aufgaben/${c.x}`, c.id);

  const keep = await busyClass(T);
  // (1) The teacher deletes the class.
  const gone = await busyClass(T);
  assert.equal(leading(gone).length, 2, 'Mia was told about the assignment, Tom about the waiting app');
  await T.page(`/klassen/${gone.id}/einstellungen`);
  assert.equal((await T.post(`/klassen/${gone.id}/loeschen`)).status, 303);
  assert.equal((await M.get(`/aufgaben/${gone.x}`)).status, 404, 'the assignment is gone');
  assert.deepEqual(leading(gone), [], 'no notice leads into the deleted class');

  // (2) The retention rule deletes an archived class.
  const old = await busyClass(T);
  await T.page(`/klassen/${old.id}/einstellungen`);
  assert.equal((await T.post(`/klassen/${old.id}/archivieren`)).status, 303);
  h.db.run('UPDATE classes SET archived_at = ? WHERE id = ?', Date.now() - 400 * 86_400_000, old.id);
  h.hub.ctx.services.maintenance();
  assert.equal(h.db.get('SELECT 1 AS ok FROM classes WHERE id = ?', old.id), undefined);
  assert.deepEqual(leading(old), []);

  // (3) The only teacher deletes their account: the class goes with it.
  const solo = await person('Frau Solo', 'teacher');
  const orphan = await busyClass(solo.b);
  await solo.b.page('/meine-daten');
  assert.equal((await solo.b.post('/meine-daten/konto-loeschen', { bestaetigung: 'LÖSCHEN' })).status, 303);
  assert.equal(h.db.get('SELECT 1 AS ok FROM classes WHERE id = ?', orphan.id), undefined);
  assert.deepEqual(leading(orphan), []);

  // The other class keeps its notices.
  assert.equal(leading(keep).length, 2, 'notices of another class stay');
});
