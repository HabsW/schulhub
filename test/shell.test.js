'use strict';
// Attack tests for the page shell and the routes that came with it: form
// errors that return to the form, favourites, in-Hub messages, announcements,
// the owner's editor draft in the player, and the UI kit on app origins.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startHub } = require('./helpers');

let h;
let lehmann, yilmaz, mia, ben;
let L, Y, M, B;
let cls7b, game, hidden;

const teacherClass = (userId) => h.db.get("SELECT class_id AS id FROM class_members WHERE user_id = ? AND role = 'teacher' ORDER BY joined_at LIMIT 1", userId).id;
const joinCode = (classId) => h.db.get("SELECT code FROM join_codes WHERE class_id = ? AND role = 'student'", classId).code;

before(async () => {
  h = await startHub();
  lehmann = h.addUser('Herr Lehmann', 'teacher');
  yilmaz = h.addUser('Frau Yilmaz', 'teacher');
  mia = h.addUser('Mia Schmidt', 'student');
  ben = h.addUser('Ben Hoffmann', 'student');
  [L, Y, M, B] = await Promise.all([lehmann, yilmaz, mia, ben].map((u) => h.browser().login(u)));
  await L.post('/klassen', { name: '7b' });
  cls7b = teacherClass(lehmann.id);
  await M.post(`/beitreten/${joinCode(cls7b)}`);
  game = await h.makeApp(L, 'Spiel', { 'index.html': 'x' });
  await L.post(`/klassen/${cls7b}/apps`, { app: game.id });
  hidden = await h.makeApp(Y, 'Privat', { 'index.html': 'x' }); // in no class Mia is in
});
after(() => h.stop());

test('Formularfehler führen zurück zum Formular – aber nur auf eigene Seiten', async () => {
  const hub = h.config.hubOrigin;
  await M.page('/apps');
  const res = await M.post('/apps', { name: 'x', beschreibung: 'Meine <b>Idee</b>' }, { headers: { referer: `${hub}/apps` } });
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/apps');
  const back = await M.page('/apps');
  assert.ok(back.text.includes('mindestens 2 Zeichen'), 'the message is shown on the form page');
  assert.ok(!back.text.includes('<b>Idee</b>'), 'kept input is escaped');

  const foreign = await M.post('/apps', { name: 'x' }, { headers: { referer: 'https://evil.example/phish' } });
  assert.equal(foreign.status, 400, 'never redirects to another host');
  const sneaky = await M.post('/apps', { name: 'x' }, { headers: { referer: `${hub}//evil.example/x` } });
  assert.notEqual(sneaky.headers.location, '//evil.example/x');
  const denied = await M.post(`/klassen/${cls7b}/code`, { minuten: '60' }, { headers: { referer: `${hub}/start` } });
  assert.equal(denied.status, 404, 'permission errors are not turned into redirects');
});

test('Favoriten: nur für Apps, die man öffnen darf; Rücksprung nur auf eigene Seiten', async () => {
  await M.page('/start');
  assert.equal((await M.post(`/apps/${hidden.id}/favorit`)).status, 404);
  const ok = await M.post(`/apps/${game.id}/favorit`, { zurueck: 'https://evil.example/' });
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.location, `/apps/${game.id}/spielen`);
  assert.ok(h.db.get('SELECT 1 AS ok FROM favorites WHERE user_id = ? AND app_id = ?', mia.id, game.id));
  await M.post(`/apps/${game.id}/favorit`, { zurueck: '/start' });
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM favorites WHERE user_id = ?', mia.id).n, 0, 'toggles off');
});

test('Mitteilungen: jede Person sieht und markiert nur ihre eigenen', async () => {
  h.hub.ctx.services.notify([mia.id], 'freigegeben', 'Für Mia <script>alert(1)</script>', '/start');
  h.hub.ctx.services.notify([ben.id], 'freigegeben', 'Für Ben', '//evil.example');
  const page = await M.page('/mitteilungen');
  assert.ok(page.text.includes('Für Mia &lt;script&gt;'), 'escaped');
  assert.ok(!page.text.includes('Für Ben'));
  await M.post('/mitteilungen/gelesen');
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM notices WHERE user_id = ? AND read_at IS NULL', mia.id).n, 0);
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM notices WHERE user_id = ? AND read_at IS NULL', ben.id).n, 1, "Ben's are untouched");
  assert.equal(h.db.get('SELECT href FROM notices WHERE user_id = ?', ben.id).href, '', 'links must be local paths');
});

test('Ankündigungen: nur sichtbare lassen sich ausblenden; fremde Klassen bleiben verborgen', async () => {
  await Y.post('/klassen', { name: '9c' });
  const cls9c = teacherClass(yilmaz.id);
  h.db.run("INSERT INTO announcements (id, class_id, author_id, title, created_at) VALUES ('an-9c', ?, ?, 'Nur 9c', ?)", cls9c, yilmaz.id, Date.now());
  h.db.run("INSERT INTO announcements (id, class_id, author_id, title, created_at) VALUES ('an-7b', ?, ?, 'Hallo 7b', ?)", cls7b, lehmann.id, Date.now());
  const start = await M.page('/start');
  assert.ok(start.text.includes('Hallo 7b') && !start.text.includes('Nur 9c'));
  assert.equal((await M.post('/mitteilungen/ankuendigung/an-9c/ausblenden')).status, 404);
  assert.equal((await M.post('/mitteilungen/ankuendigung/an-7b/ausblenden')).status, 303);
  assert.ok(!(await M.page('/start')).text.includes('Hallo 7b'));
});

test('Editor-Entwurf im Player: nur die Besitzerin, immer als Vorschau', async () => {
  const own = await h.makeApp(M, 'Mias Entwurf', { 'index.html': 'v1' });
  const a = h.db.get('SELECT * FROM apps WHERE id = ?', own.id);
  assert.equal((await M.get(`/apps/${own.id}/spielen?entwurf=1`)).status, 404, 'no draft yet');
  h.hub.ctx.uploads.draftFromVersion(a, h.db.get('SELECT * FROM app_versions WHERE id = ?', a.published_version_id));
  const page = await M.page(`/apps/${own.id}/spielen?entwurf=1`);
  assert.equal(page.status, 200);
  assert.ok(page.text.includes('Entwurf'));
  assert.equal((await L.get(`/apps/${own.id}/spielen?entwurf=1`)).status, 404, 'not even a teacher');
  const t = await M.send('POST', `/apps/${own.id}/token`, { entwurf: true, first: true });
  assert.equal(t.json().mode, 'preview');
  const payload = JSON.parse(Buffer.from(t.json().token.split('.')[0], 'base64url').toString());
  assert.deepEqual([payload.v, payload.p], ['draft', 1]);
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM plays WHERE app_id = ?', own.id).n, 0, 'a draft preview is not a play');
  assert.equal((await L.send('POST', `/apps/${own.id}/token`, { entwurf: true })).status, 404);
});

test('UI-Kit und Seite: Darstellung kommt nur aus der Datenbank', async () => {
  const r = await M.page('/start');
  assert.match(r.text, /<html lang="de" data-theme="dark" data-text="normal" data-motion="auto" data-contrast="normal">/);
  h.db.run("UPDATE users SET pref_theme = 'light', pref_text = 'larger' WHERE id = ?", mia.id);
  assert.match((await M.page('/start')).text, /data-theme="light" data-text="larger"/);
  assert.throws(() => h.db.run("UPDATE users SET pref_theme = '\"><script>' WHERE id = ?", mia.id), /CHECK/);
  // The UI kit is served from the Hub's own file on every app origin.
  const play = await M.page(`/apps/${game.id}/spielen?klasse=${cls7b}`);
  const tok = /src="[^"]*\/~([^/"]+)\/index\.html"/.exec(play.text)[1];
  const css = await M.raw('GET', `/~${tok}/hub-ui.css`, { host: h.appHost(game) });
  assert.equal(css.status, 200);
  assert.match(css.headers['content-type'], /text\/css/);
  assert.ok(css.text.includes('SchulHub UI-Kit'));
  const font = await M.raw('GET', `/~${tok}/hub-ui-fonts/atkinson-next-latin.woff2`, { host: h.appHost(game) });
  assert.equal(font.status, 200);
  assert.equal((await M.raw('GET', `/~${tok}/hub-ui-fonts/../../src/config.js`, { host: h.appHost(game) })).status, 404);
});
