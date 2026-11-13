'use strict';
// Bug hunt: accounts, sessions, privacy and administration. Each test here
// failed on the code before its fix (see the commit that added it).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { startHub, makeZip } = require('./helpers');
const { restoreBackup, listStore } = require('../src/backup');
const dbJobs = require('../src/dbJobs');

const DAY = 86_400_000;
const PNG = (fill) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, fill)]);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

let h;
let admin, A;

const teacherClass = (userId, name) => h.db.get("SELECT c.id FROM classes c JOIN class_members m ON m.class_id = c.id AND m.user_id = ? AND m.role = 'teacher' WHERE c.name = ?", userId, name).id;
const joinCode = (classId) => h.db.get("SELECT code FROM join_codes WHERE class_id = ? AND role = 'student'", classId).code;
/** Raw request to an app's own origin (files API of the SDK). */
const appRequest = (b, app, method, url, { token, body = null, type } = {}) =>
  b.raw(method, url, { host: h.appHost(app), headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(type ? { 'content-type': type } : {}) }, body });

before(async () => {
  h = await startHub();
  admin = h.addUser('Anna Adler', 'admin');
  A = await h.browser().login(admin);
});
after(() => h.stop());

// ------------------------------------------------------------- announcements

test('Ankündigungen: die eigene Klasse und die ganze Schule stehen auf der Startseite, auch wenn andere Klassen viele neuere haben', async () => {
  const teacher = h.addUser('Herr Roth', 'teacher');
  const other = h.addUser('Frau Weiß', 'teacher');
  const student = h.addUser('Paul Roth', 'student');
  const [T, O, S] = await Promise.all([teacher, other, student].map((u) => h.browser().login(u)));
  await T.post('/klassen', { name: '6c' });
  const own = teacherClass(teacher.id, '6c');
  await S.post(`/beitreten/${joinCode(own)}`);
  await O.post('/klassen', { name: '10a' });
  const foreign = teacherClass(other.id, '10a');

  await A.page('/ankuendigungen');
  assert.equal((await A.post('/ankuendigungen', { ziel: 'schule', titel: 'Schulfest am Samstag' })).status, 303);
  await T.page('/ankuendigungen');
  assert.equal((await T.post('/ankuendigungen', { ziel: own, titel: 'Wandertag der 6c' })).status, 303);
  assert.ok((await S.get('/start')).text.includes('Wandertag der 6c'), 'shown while it is the newest');

  // A busy school: the teachers of other classes write announcements too (newer ones).
  await O.page('/ankuendigungen');
  for (let i = 0; i < 20; i++) assert.equal((await O.post('/ankuendigungen', { ziel: foreign, titel: `Nachricht ${i} an die 10a` })).status, 303);
  h.db.run("UPDATE announcements SET created_at = created_at + 1000 WHERE class_id = ?", foreign); // strictly newer

  const start = (await S.get('/start')).text;
  assert.ok(!start.includes('an die 10a'), 'nothing of a foreign class');
  assert.ok(start.includes('Wandertag der 6c'), 'the announcement of her own class is still shown');
  assert.ok(start.includes('Schulfest am Samstag'), 'the school-wide announcement is still shown');
});

// ----------------------------------------------------------------- accounts

test('Rollen: ein gesperrtes Admin-Konto lässt sich herabstufen, das einzige aktive nie', async () => {
  const blocked = h.addUser('Bernd Gesperrt', 'admin');
  await A.page(`/admin/konten/${blocked.id}`);
  assert.equal((await A.post(`/admin/nutzer/${blocked.id}/sperren`, { an: '1' })).status, 303);
  // Anna is now the only ACTIVE admin. The page offers to change Bernd's role (he does not count) …
  const page = (await A.page(`/admin/konten/${blocked.id}`)).text;
  assert.ok(page.includes(`/admin/nutzer/${blocked.id}/rolle`), 'the page offers the role change');
  // … and the route must allow it: Anna stays the active admin.
  const res = await A.post(`/admin/nutzer/${blocked.id}/rolle`, { rolle: 'teacher' });
  assert.equal(res.status, 303, 'demoting a blocked admin keeps an active admin');
  assert.equal(h.db.get('SELECT role FROM users WHERE id = ?', blocked.id).role, 'teacher');
  // The guard itself still holds for the only active admin.
  assert.equal((await A.post(`/admin/nutzer/${admin.id}/rolle`, { rolle: 'teacher' })).status, 400);
  assert.equal(h.db.get('SELECT role FROM users WHERE id = ?', admin.id).role, 'admin');
});

test('Konto löschen: wer nicht mehr Lehrkraft ist, erfährt trotzdem, welche Klassen mit dem Konto verschwinden', async () => {
  const teacher = h.addUser('Herr Brandt', 'teacher');
  const student = h.addUser('Lina Brandt', 'student');
  const [T, S] = await Promise.all([teacher, student].map((u) => h.browser().login(u)));
  await T.post('/klassen', { name: 'Theater-AG' });
  const cls = teacherClass(teacher.id, 'Theater-AG');
  await S.post(`/beitreten/${joinCode(cls)}`);
  assert.ok((await T.get('/meine-daten')).text.includes('„Theater-AG“, weil du dort die einzige Lehrkraft bist'), 'as a teacher he is told');

  // The admin makes him a student; he stays the only teacher of the class (a known open question).
  await A.page(`/admin/konten/${teacher.id}`);
  assert.equal((await A.post(`/admin/nutzer/${teacher.id}/rolle`, { rolle: 'student' })).status, 303);
  const page = (await T.page('/meine-daten')).text;
  assert.ok(page.includes('„Theater-AG“, weil du dort die einzige Lehrkraft bist'), 'the deletion page names the class that will be deleted');

  // What the page has to warn about really happens: the class goes with the account, and Lina loses it.
  assert.equal((await T.post('/meine-daten/konto-loeschen', { bestaetigung: 'LÖSCHEN' })).status, 303);
  assert.equal(h.db.get('SELECT 1 AS ok FROM classes WHERE id = ?', cls), undefined);
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM class_members WHERE user_id = ?', student.id).n, 0);
});
