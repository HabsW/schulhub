'use strict';
// Bug hunt: app data, the SDK and what teachers see of it. Each test plays a situation the other
// tests leave out - the token exactly as the player page asks for it, an app taken out of a class
// and submitted again, limits that one person can use up, results pruned elsewhere, values an app
// may send, saved lists shown as tables, the SDK in the browser after a failed call.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
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
  assert.equal((await AD.post(`/apps/${S.id}/schulweit`, { an: '1', version: h.db.get('SELECT published_version_id AS v FROM apps WHERE id = ?', S.id).v })).status, 303);
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

// =========================================================== results of a removed app, submitted again

test('Ergebnisse: eine entfernte App bleibt für die Lehrkraft lesbar – auch wenn die Besitzerin sie neu einreicht oder sie zurückgegeben wird', async () => {
  const app = await h.makeApp(R, uniq('Rosas Quiz'), { 'index.html': '<h1>Quiz</h1>' });
  assert.equal((await R.post(`/apps/${app.id}/einreichen`, { klasse: c1 })).status, 303);
  await T.page(`/pruefen/${c1}/${app.id}`);
  assert.equal((await T.post(`/pruefen/${c1}/${app.id}/freigeben`, { version: app.published_version_id })).status, 303);
  const qt = await h.token(Q, app, c1);
  assert.equal((await call(Q, app, qt, 'results.add', { title: 'VOR-DEM-ENTFERNEN', score: 2, maxScore: 3 })).ok, true);

  const base = `/klassen/${c1}/apps/${app.id}/ergebnisse`;
  const readable = async (label) => {
    for (const url of [base, `${base}/${quinn.id}`, `${base}.csv`]) assert.equal((await T.get(url)).status, 200, `${label}: ${url}`);
    assert.ok((await T.get(`${base}/${quinn.id}`)).text.includes('VOR-DEM-ENTFERNEN'), label);
    assert.ok((await T.get(`${base}.csv`)).text.includes('VOR-DEM-ENTFERNEN'), label);
  };
  /** The "Entfernte Apps" entry of this app on the class's Apps tab (its links), or null. */
  const removedEntry = async () => {
    const tab = (await T.get(`/klassen/${c1}/apps`)).text;
    const part = tab.split('Entfernte Apps')[1] || '';
    return part.includes(`/apps/${app.id}/ergebnisse`) ? { restore: part.includes(`/apps/${app.id}/zurueckholen`) } : null;
  };
  // The teacher takes it out of the class: the results stay readable (SECURITY.md: "ever approved").
  await T.page(`/klassen/${c1}/apps`);
  assert.equal((await T.post(`/klassen/${c1}/apps/${app.id}/entfernen`)).status, 303);
  await readable('removed');
  assert.ok((await T.get(base)).text.includes(`/apps/${app.id}/zurueckholen`), 'a removed app can be brought back from its results');
  assert.deepEqual(await removedEntry(), { restore: true });

  // Rosa improves her app and submits it again: it waits for the teacher.
  assert.equal((await R.post(`/apps/${app.id}/einreichen`, { klasse: c1 })).status, 303);
  assert.equal(classApp(c1, app.id).status, 'pending');
  await readable('submitted again');
  // The teacher still finds them, and nothing is offered that cannot work for a waiting app.
  assert.deepEqual(await removedEntry(), { restore: false }, 'listed with its results, without "Zurückholen"');
  assert.ok(!(await T.get(base)).text.includes('/zurueckholen'), 'no "Zurückholen" while it waits for review');
  // The feedback form on the student's page works for this app, too.
  await T.page(`${base}/${quinn.id}`);
  assert.equal((await T.post(`/klassen/${c1}/rueckmeldungen`, { schueler: quinn.id, app: app.id, text: 'Gut gemacht!', zurueck: `${base}/${quinn.id}` })).status, 303);

  // The teacher gives it back: still the class's results.
  await T.page(`/pruefen/${c1}/${app.id}`);
  assert.equal((await T.post(`/pruefen/${c1}/${app.id}/zurueckgeben`, { version: app.published_version_id, grund: 'Bitte noch den Ton aus' })).status, 303);
  assert.equal(classApp(c1, app.id).status, 'rejected');
  await readable('given back');
  assert.deepEqual(await removedEntry(), { restore: false });
  // Classmates still get nothing.
  assert.equal((await Q.get(base)).status, 404);
});

// ============================================================================== what teachers see of results

test('Ergebnisse: „Bestes im Schnitt“ rechnet mit denselben begrenzten Werten, die die Tabelle zeigt', async () => {
  const cls = await newClass(T);
  const app = await h.makeApp(T, uniq('Punkte'), { 'index.html': '<h1>Punkte</h1>' });
  assert.equal((await T.post(`/klassen/${cls}/apps`, { app: app.id })).status, 303);
  const a = await student();
  const b = await student();
  for (const s of [a, b]) await join(s.b, cls);
  // One app counts a bonus above the maximum (8 of 4), the other result is 1 of 4.
  await call(a.b, app, await h.token(a.b, app, cls), 'results.add', { title: 'MIT-BONUS', score: 8, maxScore: 4 });
  await call(b.b, app, await h.token(b.b, app, cls), 'results.add', { title: 'NORMAL', score: 1, maxScore: 4 });
  const page = (await T.get(`/klassen/${cls}/apps/${app.id}/ergebnisse`)).text;
  const shown = [...page.matchAll(/<td class="num"[^>]*data-label="Bestes"><span class="cell">(\d+) %<\/span>/g)].map((m) => Number(m[1])).sort((x, y) => x - y);
  assert.deepEqual(shown, [25, 100], 'the table shows each best clamped to 0..100 %');
  const average = /<span class="stat-label">Bestes im Schnitt<\/span><span class="stat-value">(\d+) %/.exec(page);
  assert.ok(average, 'the average is shown');
  assert.equal(Number(average[1]), 63, 'the average of the 100 % and 25 % the table shows');
});

test('Ergebnisse: die Einzelansicht zählt alle Ergebnisse der Klasse und kennt das beste – auch bei mehr als 200', async () => {
  const cls = await newClass(T);
  const app = await h.makeApp(T, uniq('Vokabeln'), { 'index.html': '<h1>Vokabeln</h1>' });
  assert.equal((await T.post(`/klassen/${cls}/apps`, { app: app.id })).status, 303);
  const s = await student();
  await join(s.b, cls);
  const tok = await h.token(s.b, app, cls);
  // One perfect round early on, then 200 short practice rounds (one result per word).
  assert.equal((await call(s.b, app, tok, 'results.add', { title: 'ERSTE-RUNDE', score: 4, maxScore: 4 })).ok, true);
  for (let i = 0; i < 200; i++) await call(s.b, app, tok, 'results.add', { title: `WORT-${i}`, score: 1, maxScore: 10 });
  const base = `/klassen/${cls}/apps/${app.id}/ergebnisse`;
  const list = (await T.get(base)).text;
  assert.match(list, /data-label="Bestes"><span class="cell">100 %/, 'the list: best 100 %');
  assert.match(list, /data-label="Ergebnisse"><span class="cell">201</, 'the list: 201 results');
  const detail = (await T.get(`${base}/${s.user.id}`)).text;
  const stat = (label) => (new RegExp(`<span class="stat-label">${label}</span><span class="stat-value">([^<]*)</span>`).exec(detail) || [])[1];
  assert.equal(stat('Ergebnisse'), '201', 'the detail counts the same results');
  assert.equal(stat('Bestes Ergebnis'), '100 %', 'and knows the same best result');
});

test('CSV: negative Punkte bleiben Zahlen – der Formelschutz gilt für Text', async () => {
  const qt = await h.token(Q, G, c1);
  await call(Q, G, qt, 'results.add', { title: 'STRAFPUNKTE', score: -3.5, maxScore: 10 });
  await call(Q, G, qt, 'results.add', { title: '=HYPERLINK("x")', score: 1, maxScore: 10 });
  await call(Q, G, qt, 'results.add', { title: "-2+3+cmd|' /C calc'!A0", score: -1e-7, maxScore: 10 });
  const csv = (await T.get(`/klassen/${c1}/apps/${G.id}/ergebnisse.csv`)).text;
  const line = csv.split('\r\n').find((l) => l.includes('STRAFPUNKTE'));
  assert.ok(line, 'the row is there');
  assert.equal(line.split(';')[2], '"-3,5"', 'a negative score is a number in the spreadsheet');
  assert.ok(csv.includes('"\'=HYPERLINK(""x"")"'), 'a formula in text is still guarded');
  assert.ok(csv.includes(`"'-2+3+cmd|' /C calc'!A0";"-1e-7"`), 'text that starts like a negative number is guarded; a tiny score stays a number');
});

// ===================================================================== saved lists as tables

test('Gespeicherte Listen als Tabelle zeigen nie etwas aus dem JavaScript-Prototyp – bei der Person selbst und bei der Lehrkraft', async () => {
  const rows = [{ constructor: 'eigener Wert', wort: 'Hund' }, { wort: 'Katze', toString: 'auch eigen' }];
  const qt = await h.token(Q, G, c1);
  assert.equal((await call(Q, G, qt, 'save.set', { key: 'liste', value: rows })).ok, true);
  assert.equal((await call(Q, G, qt, 'results.add', { title: 'LISTE', details: rows })).ok, true);
  const mine = (await Q.get(`/meine-daten/app/${G.id}`)).text;
  const teacher = (await T.get(`/klassen/${c1}/apps/${G.id}/ergebnisse/${quinn.id}`)).text;
  for (const [who, text] of [['Meine Daten', mine], ['Lehrkraft', teacher]]) {
    assert.ok(text.includes('eigener Wert') && text.includes('auch eigen'), `${who}: the saved values`);
    assert.ok(!/native code|\[object Object\]/.test(text), `${who}: nothing from Object.prototype in an empty cell`);
  }
});

// ======================================================================== the token route

test('Anfragen ohne Inhalt (Token, „Meine Daten“): eine normale Antwort, nie 500', async () => {
  const csrf = /<meta name="csrf" content="([^"]*)"/.exec((await P.get('/start')).text)[1];
  const bare = (url) => P.raw('POST', url, { headers: { 'x-csrf-token': csrf, accept: 'application/json' } });
  // The token route asks without a class: like the start page's link.
  const tok = await bare(`/apps/${G.id}/token`);
  assert.equal(tok.status, 200, tok.text);
  assert.equal(tok.json().class.name, '7b Mathe');
  assert.equal(h.db.get('SELECT anonymous_scores FROM users WHERE id = ?', pia.id).anonymous_scores, 0);
  const anon = await bare('/meine-daten/anonym');
  assert.equal(anon.status, 303, anon.text);
  assert.equal(h.db.get('SELECT anonymous_scores FROM users WHERE id = ?', pia.id).anonymous_scores, 0, 'nothing switched on');
  // Without the CSRF token it is still refused.
  assert.equal((await P.raw('POST', `/apps/${G.id}/token`, { headers: { accept: 'application/json' } })).status, 403);
});

// =============================================================== the SDK in the browser (hub-sdk.js)

/**
 * Runs sdk/hub-sdk.js in a frame-like sandbox: the Hub page answers the handshake (with `token`),
 * and `api` answers every POST /_hub/api ({ method, params } -> { status, body }) - or `fetch`
 * answers every request of the SDK.
 */
function sdkInFrame(api, { token = 'T', fetch = null } = {}) {
  const HUB = 'http://hub.example';
  const listeners = [];
  const quiet = () => {};
  const win = {
    console: { log: quiet, info: quiet, warn: quiet, error: quiet },
    location: { protocol: 'http:', search: '', pathname: '/~t/index.html' },
    addEventListener: (type, fn) => type === 'message' && listeners.push(fn),
    removeEventListener: quiet,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: quiet,
    fetch: async (url, init = {}) => {
      if (url === '/_hub/info') return { ok: true, status: 200, json: async () => ({ hub: true, hubOrigin: HUB }) };
      if (fetch) return fetch(url, init);
      const { status, body } = await api(JSON.parse(init.body));
      return { ok: status === 200, status, json: async () => body };
    },
  };
  win.parent = {
    postMessage(msg) {
      const answer = msg.hub === 'hello'
        ? { hub: 'welcome', id: msg.id, token, expiresIn: 600, mode: 'live', user: { id: 'u', name: 'Pia' }, class: null, app: { name: 'A', version: 1 }, theme: 'auto' }
        : { hub: 'token', id: msg.id, token, expiresIn: 600 };
      setImmediate(() => listeners.forEach((fn) => fn({ origin: HUB, source: win.parent, data: answer })));
    },
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'sdk', 'hub-sdk.js'), 'utf8'), win);
  return win.Hub.connect();
}

/** sdk/hub-sdk.js in a frame of `app`, talking to the real Hub with the SDK token `tok` of browser b. */
function sdkAgainstHub(b, app, tok) {
  const host = h.appHost(app);
  const adapt = (r) => ({ status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => JSON.parse(r.text), blob: async () => r.buffer });
  return sdkInFrame(null, {
    token: tok.token,
    fetch: async (url, init = {}) => {
      const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
      return adapt(await b.raw(init.method || 'GET', url, { host, headers, body: init.body === undefined ? null : init.body }));
    },
  });
}

test('SDK: hub.files.get mit ungültigem Namen endet mit bad_key – nie mit der Fehlermeldung als Dateiinhalt', async () => {
  const tok = await h.token(Q, G, c1);
  const hub = await sdkAgainstHub(Q, G, tok);
  assert.deepEqual(await hub.files.put('notiz.txt', 'Hallo'), { name: 'notiz.txt', type: 'text/plain', size: 5 });
  assert.equal(String(await hub.files.get('notiz.txt')), 'Hallo');
  assert.equal(await hub.files.get('gibt-es-nicht'), null);
  await assert.rejects(hub.files.put('kein gültiger name', 'x'), (e) => e.code === 'bad_key');
  await assert.rejects(
    hub.files.get('kein gültiger name').then((got) => {
      throw new Error(`resolved with ${String(got)}`);
    }),
    (e) => e.code === 'bad_key'
  );
});

test('SDK: nach einem gescheiterten Laden der Klasseneinstellungen fragt hub.settings beim nächsten Mal neu', async () => {
  let calls = 0;
  const hub = await sdkInFrame(async ({ method }) => {
    assert.equal(method, 'settings.all');
    calls++;
    // The first call meets a busy moment (too many requests at once); later ones work.
    return calls === 1
      ? { status: 429, body: { ok: false, error: { code: 'rate_limited', message: 'Zu viele gleichzeitige Anfragen.' } } }
      : { status: 200, body: { ok: true, result: { woerter: [['Hund', 'dog']] } } };
  });
  await assert.rejects(hub.settings.get('woerter'), (e) => e.code === 'rate_limited');
  assert.deepEqual(await hub.settings.get('woerter'), [['Hund', 'dog']], "the class's words, not the error again");
  assert.equal(calls, 2);
  assert.deepEqual(await hub.settings.all(), { woerter: [['Hund', 'dog']] }, 'and then from the cache');
  assert.equal(calls, 2);
});

// ================================================== limits one person can use up for others (decision open)

// The limit "20 leaderboards per app" counts every board anybody ever used in the app, and nobody can
// remove a board (no SDK call, no Hub page). A fix changes that documented limit (e.g. 20 boards per
// person and app): a product decision - so this test is a todo until it is taken.
test('Bestenlisten: eine einzelne Person kann die Bestenlisten einer App nicht für alle anderen aufbrauchen', { todo: 'Grenze „Bestenlisten pro App“ – Entscheidung offen (Vorschlag: pro Person und App)' }, async () => {
  const app = await h.makeApp(T, uniq('Rennen'), { 'index.html': '<h1>Rennen</h1>' });
  assert.equal((await T.post(`/klassen/${c1}/apps`, { app: app.id })).status, 303);
  // Quinn holds her own SDK token (developer tools) and fills every board the app may have.
  const qt = await h.token(Q, app, c1);
  for (let i = 0; i < h.config.limits.boardsPerApp; i++) {
    assert.equal((await call(Q, app, qt, 'scores.submit', { board: `quinn-${i}`, score: 1 })).ok, true);
  }
  // The app's real board, first used by Pia: refused for her - and for everybody, for good.
  const pt = await h.token(P, app, c1);
  const r = await call(P, app, pt, 'scores.submit', { board: 'punkte', score: 10 });
  assert.equal(r.ok, true, `Pia's own score: ${JSON.stringify(r)}`);
});

// "The newest 500 results per person and app" are counted over all classes and over results without a
// class: practice elsewhere deletes the results a class's teacher sees (and the assignment's "done").
// A fix changes that documented limit (e.g. the newest 500 per person, app and class): a product
// decision - so this test is a todo until it is taken.
test('Ergebnisse: was in einer anderen Klasse oder ohne Klasse entsteht, verdrängt nie die Ergebnisse dieser Klasse', { todo: 'Grenze „Ergebnisse pro Person und App“ – Entscheidung offen (Vorschlag: pro Person, App und Klasse)' }, async () => {
  const keep = h.config.limits.resultsPerUser;
  h.config.limits.resultsPerUser = 5;
  try {
    const { assignments } = h.hub.ctx;
    await T.page(`/klassen/${c1}/aufgaben/neu`);
    const made = await T.post(`/klassen/${c1}/aufgaben`, { app: G.id, titel: uniq('Hausaufgabe') });
    assert.equal(made.status, 303);
    const x = h.db.get('SELECT * FROM assignments WHERE id = ?', idFrom(made));
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Pia does the assignment in 7b ...
    const t7 = await h.token(P, G, c1);
    assert.equal((await call(P, G, t7, 'results.add', { title: 'HAUSAUFGABE-7B', score: 4, maxScore: 4 })).ok, true);
    assert.equal(assignments.stateOf(x, pia.id), 'done');
    // ... and then practises a lot in 8a.
    const t8 = await h.token(P, G, c2);
    for (let i = 0; i < 5; i++) assert.equal((await call(P, G, t8, 'results.add', { title: `UEBUNG-8A-${i}`, score: 1, maxScore: 4 })).ok, true);
    const detail = (await T.get(`/klassen/${c1}/apps/${G.id}/ergebnisse/${pia.id}`)).text;
    assert.ok(detail.includes('HAUSAUFGABE-7B'), "7b's teacher still sees the result made in 7b");
    assert.equal(assignments.stateOf(x, pia.id), 'done', 'the assignment stays done');
  } finally {
    h.config.limits.resultsPerUser = keep;
  }
});
