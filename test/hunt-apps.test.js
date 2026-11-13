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

test('Schulweit freigeben: gilt nur für die Version, die die Verwaltung vor sich hatte', async () => {
  const app = await h.makeApp(M, uniq('Schulweit-Bindung'), { 'index.html': '<h1>v1</h1>' });
  const v1 = app.published_version_id;
  // The admin looks at Version 1 and is about to release it - on the app page or in the list of all apps.
  for (const page of [`/apps/${app.id}`, '/admin/apps']) {
    const forms = formsTo((await A.page(page)).text, `/apps/${app.id}/schulweit`).filter((f) => f.an === '1');
    assert.equal(forms.length, 1, page);
    // Meanwhile Mia publishes a version that nobody has looked at.
    const v = await publish(M, app.id, { 'index.html': `<h1>ungeprüft ${page}</h1>` });
    const res = await A.post(`/apps/${app.id}/schulweit`, forms[0]);
    assert.notEqual(appRow(app.id).schoolwide_version_id, v, `${page}: the whole school got a version the admin never saw`);
    assert.ok([303, 400].includes(res.status), `${page}: ${res.status}`);
    h.db.run('UPDATE apps SET schoolwide_version_id = NULL, schoolwide_requested_version_id = NULL WHERE id = ?', app.id);
  }
  // Released from a fresh page, it is exactly the published version.
  const fresh = formsTo((await A.page(`/apps/${app.id}`)).text, `/apps/${app.id}/schulweit`).find((f) => f.an === '1');
  assert.equal((await A.post(`/apps/${app.id}/schulweit`, fresh)).status, 303);
  assert.equal(appRow(app.id).schoolwide_version_id, appRow(app.id).published_version_id);
  assert.notEqual(appRow(app.id).schoolwide_version_id, v1);
});

test('Zurück zur alten Version: die neuere wartet danach nirgends mehr auf eine Freigabe', async () => {
  const app = await approved(M, uniq('Rückkehr'), { 'index.html': '<h1>v1</h1>' });
  const v1 = app.published_version_id;
  h.db.run('UPDATE apps SET schoolwide_version_id = ? WHERE id = ?', v1, app.id); // also released school-wide
  const v2 = await publish(M, app.id, { 'index.html': '<h1>v2 kaputt</h1>' });
  assert.deepEqual([classApp(cls, app.id).requested_version_id, appRow(app.id).schoolwide_requested_version_id], [v2, v2]);

  // Version 2 is broken: Mia publishes Version 1 again ("Ältere Version 1 veröffentlichen").
  const page = (await M.page(`/apps/${app.id}`)).text;
  const back = formsTo(page, `/apps/${app.id}/veroeffentlichen`).find((f) => f.version === v1);
  assert.ok(back, 'the page offers to publish Version 1 again');
  // The question before it says what happens - not that only Mia could open it.
  const ask = new RegExp(`<form method="post" action="/apps/${app.id}/veroeffentlichen" class="inline" data-confirm="([^"]*)"[^>]*>[^]*?name="version" value="${v1}"`).exec(page);
  assert.ok(ask && !ask[1].includes('Öffnen kann sie dann nur du'), `the confirmation says: ${ask && ask[1]}`);
  assert.ok(ask[1].includes('In 7b läuft sie schon') && ask[1].includes('Für die ganze Schule gilt sie schon'), ask[1]);
  assert.equal((await M.post(`/apps/${app.id}/veroeffentlichen`, back)).status, 303);
  assert.equal(appRow(app.id).published_version_id, v1);

  // Nothing waits any more: not in the class, not for the school.
  const row = classApp(cls, app.id);
  assert.deepEqual([row.status, row.version_id, row.request_state, row.requested_version_id], ['approved', v1, null, null], 'Version 2 still waits in the class');
  assert.equal(appRow(app.id).schoolwide_requested_version_id, null, 'Version 2 still waits for the school');
  assert.ok(!(await L.get('/pruefen')).text.includes(`href="/pruefen/${cls}/${app.id}"`), 'the teacher is still asked to review Version 2');
  assert.equal((await L.post(`/pruefen/${cls}/${app.id}/freigeben`, { version: v2 })).status, 404, 'the teacher could still approve Version 2');
  assert.equal(classApp(cls, app.id).version_id, v1, 'the class plays Version 1, which Mia publishes');
});

test('Von Kolleg/innen geteilt: der Link im Katalog öffnet die App (als Vorschau) statt einer 404', async () => {
  const shared = await h.makeApp(K, uniq('Geteiltes Quiz'));
  assert.equal((await K.post(`/apps/${shared.id}/bearbeiten`, { name: shared.name, emoji: '🎮', color: '0', shared_field: '1', shared: '1' })).status, 303);
  for (const [who, b] of [['Frau Yilmaz (ohne Klasse)', Y], ['Herr Lehmann', L]]) {
    const catalogue = (await b.get('/katalog?zeige=kollegium')).text;
    assert.ok(catalogue.includes(`href="/apps/${shared.id}/spielen"`), `${who}: the catalogue offers the app`);
    const res = await b.get(`/apps/${shared.id}/spielen`);
    assert.equal(res.status, 200, `${who}: the catalogue link leads to a 404`);
    assert.match(res.text, /Vorschau/, `${who}: a preview - nothing is stored`);
    const t = await h.token(b, shared);
    assert.equal(t && t.mode, 'preview');
  }
  // Students never: the app is shared with staff only.
  assert.equal((await B.get(`/apps/${shared.id}/spielen`)).status, 404);
  assert.equal(await h.token(B, shared), null);
});

test('Entfernt und wieder eingereicht: die Ergebnisse der Klasse bleiben für die Lehrkraft lesbar', async () => {
  const app = await approved(M, uniq('Ergebnis-Spiel'), { 'index.html': '<h1>v1</h1>' });
  const t = await h.token(B, app, cls);
  assert.equal((await B.api(app, t.token, 'results.add', { title: 'BENS-RUNDE', score: 3, maxScore: 4 })).json().ok, true);
  const results = `/klassen/${cls}/apps/${app.id}/ergebnisse`;
  // Herr Lehmann takes the app out of the class: the results stay readable (SECURITY.md).
  await L.page(`/klassen/${cls}/apps`);
  assert.equal((await L.post(`/klassen/${cls}/apps/${app.id}/entfernen`)).status, 303);
  assert.ok((await L.get(results)).text.includes('BENS-RUNDE'));

  // Mia submits her app again. While it waits - and after the teacher gives it back - the results stay his.
  assert.equal((await M.post(`/apps/${app.id}/einreichen`, { klasse: cls })).status, 303);
  assert.equal(classApp(cls, app.id).request_state, 'waiting');
  let res = await L.get(results);
  assert.equal(res.status, 200, 'the results disappear while the new submission waits');
  assert.ok(res.text.includes('BENS-RUNDE'));
  assert.equal((await L.get(`${results}/${ben.id}`)).status, 200, 'Ben’s detail page too');
  // ... and its feedback form, which links the app, works.
  const fb = formsTo((await L.page(`${results}/${ben.id}`)).text, `/klassen/${cls}/rueckmeldungen`)[0];
  assert.equal(fb && fb.app, app.id);
  assert.equal((await L.post(`/klassen/${cls}/rueckmeldungen`, { ...fb, text: 'Gute Runde!' })).status, 303, 'feedback about the app is refused');
  assert.equal((await L.post(`/pruefen/${cls}/${app.id}/zurueckgeben`, { version: app.published_version_id, grund: 'Noch nicht.' })).status, 303);
  res = await L.get(results);
  assert.equal(res.status, 200, 'after giving it back the results stay hidden - and nothing in the UI brings them back');
  // The class's page lists the app where its results are.
  assert.ok((await L.get(`/klassen/${cls}/apps`)).text.includes(`href="${results}"`), 'no link to the results on the class page');
  // Classmates still cannot open it.
  assert.equal(await h.token(B, app, cls), null);
});

test('Konto gelöscht, während ein ZIP entpackt wird: kein Eintrag nennt danach die Person oder ihre App', async () => {
  const name = 'Zoe Zipfel';
  const zoe = h.addUser(name, 'student');
  const Z = await h.browser().login(zoe);
  const app = await h.makeApp(Z, 'Zoes Zipspiel', { 'index.html': '<h1>alt</h1>' });
  const { uploads } = h.hub.ctx;
  const original = uploads.addZip;
  // The archive has arrived and its version exists; while it is unpacked, the account is deleted.
  uploads.addZip = async (...args) => {
    uploads.addZip = original;
    await A.page(`/admin/konten/${zoe.id}`);
    assert.equal((await A.post(`/admin/nutzer/${zoe.id}/loeschen`, {})).status, 303);
    return original(...args);
  };
  try {
    const res = await Z.send('POST', `/apps/${app.id}/versionen/zip`, makeZip([{ name: 'index.html', data: '<h1>neu</h1>' }]), 'application/zip');
    assert.equal(res.status, 404);
  } finally {
    uploads.addZip = original;
  }
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM users WHERE id = ?', zoe.id).n, 0);
  const left = h.db.all('SELECT action, actor_label, target FROM audit_log WHERE actor_id = ? OR actor_label LIKE ? OR target LIKE ?', zoe.id, `%${name}%`, '%Zoes Zipspiel%');
  assert.deepEqual(left, [], 'the audit log names the deleted person and her app');
});
