'use strict';
// Bug hunt in apps, versions, review and publishing: each test shows one bug that a student or a
// teacher would meet - through the real HTTP routes, the way the Hub's own pages and scripts send
// them. Every test failed before its fix.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startHub, makeZip } = require('./helpers');

let h;
let admin, lehmann, kaya, yilmaz, mia, ben;
let A, L, K, Y, M, B;
let cls; // Herr Lehmann's 7b: Mia and Ben

const joinCode = (classId) => h.db.get("SELECT code FROM join_codes WHERE class_id = ? AND role = 'student'", classId).code;
const appRow = (id) => h.db.get('SELECT * FROM apps WHERE id = ?', id);
const classApp = (classId, appId) => h.db.get('SELECT * FROM class_apps WHERE class_id = ? AND app_id = ?', classId, appId);
let seq = 0;
const uniq = (p) => `${p} ${++seq}`;

/** The hidden fields of every form on a page that posts to `action` (without the CSRF token). */
function formsTo(text, action) {
  const out = [];
  for (const m of text.matchAll(/<form method="post" action="([^"]*)"[^>]*>([\s\S]*?)<\/form>/g)) {
    if (m[1] !== action) continue;
    const fields = {};
    for (const f of m[2].matchAll(/<input type="hidden" name="([^"]*)" value="([^"]*)">/g)) if (f[1] !== '_csrf') fields[f[1]] = f[2];
    out.push(fields);
  }
  return out;
}

/** A student's app, published, submitted to the class and approved by its teacher. */
async function approved(owner, name, files) {
  const a = await h.makeApp(owner, name, files);
  assert.equal((await owner.post(`/apps/${a.id}/einreichen`, { klasse: cls })).status, 303);
  assert.equal((await L.post(`/pruefen/${cls}/${a.id}/freigeben`, { version: a.published_version_id })).status, 303);
  assert.equal(classApp(cls, a.id).status, 'approved');
  return appRow(a.id);
}
async function publish(owner, appId, files) {
  const v = await h.uploadFolder(owner, appId, files);
  assert.equal((await owner.post(`/apps/${appId}/veroeffentlichen`, { version: v })).status, 303);
  return v;
}

before(async () => {
  const many = [1e6, 60_000];
  h = await startHub({ rate: { write: many, submit: many, publish: many, uploadVersions: many, uploadFiles: many, sdk: many } });
  admin = h.addUser('Anna Adler', 'admin');
  lehmann = h.addUser('Herr Lehmann', 'teacher');
  kaya = h.addUser('Herr Kaya', 'teacher');
  yilmaz = h.addUser('Frau Yilmaz', 'teacher'); // teaches no class
  mia = h.addUser('Mia Schmidt', 'student');
  ben = h.addUser('Ben Hoffmann', 'student');
  [A, L, K, Y, M, B] = await Promise.all([admin, lehmann, kaya, yilmaz, mia, ben].map((u) => h.browser().login(u)));
  const created = await L.post('/klassen', { name: '7b' });
  cls = created.headers.location.split('/').pop();
  for (const b of [M, B]) assert.equal((await b.post(`/beitreten/${joinCode(cls)}`)).status, 303);
});
after(() => h.stop());

// ----------------------------------------------------------------------------------------------

test('Erfolge: Titel aus einer neuen, noch nicht geprüften Version erscheinen nicht bei Mitschüler/innen', async () => {
  const manifest = (title) => JSON.stringify({ achievements: [{ id: 'erste-runde', title, emoji: '⭐' }] });
  const app = await approved(M, uniq('Erfolgs-Spiel'), { 'index.html': '<h1>v1</h1>', 'schulhub.json': manifest('Erste Runde') });
  const t = await h.token(B, app, cls);
  assert.equal((await B.api(app, t.token, 'achievements.unlock', { id: 'erste-runde' })).json().ok, true);
  assert.ok((await B.get('/start')).text.includes('Erste Runde'));

  // Mia publishes a new version with another title for the same achievement. It waits for Herr Lehmann.
  await publish(M, app.id, { 'index.html': '<h1>v2</h1>', 'schulhub.json': manifest('BEN IST DOOF') });
  assert.equal(classApp(cls, app.id).request_state, 'waiting');
  const start = (await B.get('/start')).text;
  assert.ok(!start.includes('BEN IST DOOF'), 'Ben’s start page shows a title nobody has reviewed');
  assert.ok(start.includes('Erste Runde'), 'the title of the version Ben plays');
  const mine = (await B.get(`/meine-daten/app/${app.id}`)).text;
  assert.ok(!mine.includes('BEN IST DOOF'), '„Meine Daten“ shows a title nobody has reviewed');
  assert.ok(mine.includes('Erste Runde'));

  // Once the teacher approves the new version, the class sees the new title.
  const v2 = classApp(cls, app.id).requested_version_id;
  assert.equal((await L.post(`/pruefen/${cls}/${app.id}/freigeben`, { version: v2 })).status, 303);
  assert.ok((await B.get('/start')).text.includes('BEN IST DOOF'));
});
