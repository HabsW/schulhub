'use strict';
// Bug hunt: app data, the SDK and what teachers see of it. Each test plays a situation the other
// tests leave out - the token exactly as the player page asks for it, an app taken out of a class
// and submitted again, limits that one person can use up, results pruned elsewhere, values an app
// may send, saved lists shown as tables, the SDK in the browser after a failed call.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startHub } = require('./helpers');

let h;
let adminUser, tom, pia, quinn, rosa;
let AD, T, P, Q, R;
let c1, c2, S, G;

let seq = 0;
const uniq = (p) => `${p}-${++seq}`;
const idFrom = (res) => res.headers.location.split('?')[0].split('/').pop();
const joinCode = (classId) => h.db.get("SELECT code FROM join_codes WHERE class_id = ? AND role = 'student' ORDER BY created_at DESC", classId).code;
const classApp = (classId, appId) => h.db.get('SELECT status, version_id FROM class_apps WHERE class_id = ? AND app_id = ?', classId, appId) || null;

async function newClass(Tb, name = uniq('Klasse')) {
  const res = await Tb.post('/klassen', { name });
  assert.equal(res.status, 303);
  return idFrom(res);
}
async function join(b, classId) {
  assert.equal((await b.post(`/beitreten/${joinCode(classId)}`)).status, 303);
}
async function student(name = uniq('Kind')) {
  const user = h.addUser(name, 'student');
  return { user, b: await h.browser().login(user) };
}
const call = async (b, app, tok, method, params = {}) => (await b.api(app, tok.token, method, params)).json();

/** The data-* attributes of the player's stage (what public/player.js reads). */
function stageOf(text) {
  const tag = /<div class="stage" id="stage"([^>]*)>/.exec(text);
  assert.ok(tag, 'player stage');
  const attr = (name) => (new RegExp(`${name}="([^"]*)"`).exec(tag[1]) || [])[1] ?? null;
  return { tokenUrl: attr('data-token-url'), klasse: attr('data-class'), version: attr('data-version'), draft: attr('data-draft') };
}
/** Ask for the SDK token exactly as public/player.js does (fetchToken). */
async function playerToken(b, page, first = true) {
  const s = stageOf(page.text);
  const res = await b.send('POST', s.tokenUrl, { klasse: s.klasse || null, version: s.version || null, entwurf: s.draft === '1', first });
  return res.status === 200 ? res.json() : { status: res.status };
}

before(async () => {
  h = await startHub();
  adminUser = h.addUser('Anna Admin', 'admin');
  tom = h.addUser('Tom Lehrer', 'teacher');
  pia = h.addUser('Pia Zweiklassen', 'student');
  quinn = h.addUser('Quinn Klasse', 'student');
  rosa = h.addUser('Rosa Bauerin', 'student');
  [AD, T, P, Q, R] = await Promise.all([adminUser, tom, pia, quinn, rosa].map((u) => h.browser().login(u)));

  // Tom teaches 7b (c1) and 8a (c2). Pia is in both, Quinn and Rosa only in 7b.
  c1 = await newClass(T, '7b Mathe');
  c2 = await newClass(T, '8a Mathe');
  for (const b of [P, Q, R]) await join(b, c1);
  await join(P, c2);

  // S: Tom's app, released for the whole school, in 7b only. G: Tom's app in both classes.
  S = await h.makeApp(T, 'Schulspiel', { 'index.html': '<h1>S</h1>' });
  assert.equal((await T.post(`/klassen/${c1}/apps`, { app: S.id })).status, 303);
  await AD.page(`/apps/${S.id}`);
  assert.equal((await AD.post(`/apps/${S.id}/schulweit`, { an: '1' })).status, 303);
  S = h.db.get('SELECT * FROM apps WHERE id = ?', S.id);
  G = await h.makeApp(T, 'Gemeinsam', { 'index.html': '<h1>G</h1>' });
  for (const c of [c1, c2]) assert.equal((await T.post(`/klassen/${c}/apps`, { app: G.id })).status, 303);
});
after(() => h.stop());

// =========================================================================== the player's token

test('Player: eine schulweite App, geöffnet aus einer Klasse ohne diese App – auch das Token des Players borgt keine andere Klasse', async () => {
  // Pia opens S from 8a (the link names 8a, where S is not). The player falls back to the school-wide
  // release without a class: its bar names no class.
  const page = await P.page(`/apps/${S.id}/spielen?klasse=${c2}`);
  assert.equal(page.status, 200);
  assert.ok(!page.text.includes('7b Mathe') && !page.text.includes('8a Mathe'), 'the player names no class');
  // The app asks the player page for its token - exactly as public/player.js does.
  const tok = await playerToken(P, page);
  assert.equal(tok.class, null, `the app is told it has no class, not ${JSON.stringify(tok.class)}`);
  assert.equal((await call(P, S, tok, 'results.add', { title: 'OHNE-KLASSE-GEOEFFNET', score: 1, maxScore: 1 })).ok, true);
  assert.equal(h.db.get("SELECT class_id FROM results WHERE title = 'OHNE-KLASSE-GEOEFFNET'").class_id, null, 'the result is filed into no class');
  assert.ok(!(await T.get(`/klassen/${c1}/apps/${S.id}/ergebnisse/${pia.id}`)).text.includes('OHNE-KLASSE-GEOEFFNET'), "7b's teacher does not get it");
  // The refresh a few minutes later says the same.
  assert.equal((await playerToken(P, page, false)).class, null);
  // Opened from 7b, or without a class, nothing changes: 7b.
  for (const qs of [`?klasse=${c1}`, '']) {
    const p = await P.page(`/apps/${S.id}/spielen${qs}`);
    assert.equal((await playerToken(P, p)).class.name, '7b Mathe', qs || 'no class in the link');
  }
});

test('Player: wer die eigene App ohne Klasse öffnet, bekommt ein Token für genau die Version, die läuft', async () => {
  // Rosa's app: version 1 is approved in 7b; she publishes version 2 with a new achievement (waits in 7b).
  const v1 = { 'index.html': '<h1>v1</h1>', 'schulhub.json': JSON.stringify({ achievements: [{ id: 'alt', title: 'Alter Erfolg' }] }) };
  const app = await h.makeApp(R, uniq('Rosas Spiel'), v1);
  assert.equal((await R.post(`/apps/${app.id}/einreichen`, { klasse: c1 })).status, 303);
  await T.page(`/pruefen/${c1}/${app.id}`);
  assert.equal((await T.post(`/pruefen/${c1}/${app.id}/freigeben`, { version: app.published_version_id })).status, 303);
  const v2 = await h.uploadFolder(R, app.id, { 'index.html': '<h1>v2</h1>', 'schulhub.json': JSON.stringify({ achievements: [{ id: 'alt', title: 'Alter Erfolg' }, { id: 'neu', title: 'Neuer Erfolg' }] }) });
  await R.page(`/apps/${app.id}`);
  assert.equal((await R.post(`/apps/${app.id}/veroeffentlichen`, { version: v2 })).status, 303);
  assert.equal(classApp(c1, app.id).version_id, app.published_version_id, '7b keeps version 1');

  // "Öffnen" on her app page: no class in the link. The page runs version 2 ...
  const page = await R.page(`/apps/${app.id}/spielen`);
  assert.equal(page.status, 200);
  const fileToken = /data-start="[^"]*\/~([^/"]+)\/_hub\/start"/.exec(page.text)[1];
  assert.equal(JSON.parse(Buffer.from(fileToken.split('.')[0], 'base64url').toString()).v, v2, 'the frame loads version 2');
  // ... and the SDK token the player asks for must be for version 2 as well.
  const tok = await playerToken(R, page);
  assert.equal(tok.app.version, 2, 'hub.app.version');
  const unlock = await call(R, app, tok, 'achievements.unlock', { id: 'neu' });
  assert.equal(unlock.ok, true, `an achievement of the running version: ${JSON.stringify(unlock)}`);
});
