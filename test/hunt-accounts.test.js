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
