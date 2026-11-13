'use strict';
// App isolation after the final security review (package P1):
//   - addresses: the Hub refuses to start when apps could set cookies for it
//   - the start page: before an app runs, what an earlier person left in that app's
//     browser storage is removed (shared school PCs)
//   - app-wide shared data: only in apps of teachers, never unreviewed text from students

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { startHub } = require('./helpers');
const { loadConfig } = require('../src/config');

const ROOT = path.join(__dirname, '..');

// ------------------------------------------------------------------ addresses

/** loadConfig in real mode with complete secrets; returns the refusal text or null. */
function refusal(env) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schulhub-cfg-'));
  try {
    loadConfig({
      env: { SESSION_SECRET: 'k'.repeat(48), TENANT_ID: 'tenant-1', CLIENT_ID: 'client-1', CLIENT_SECRET: 'secret-1', STUDENT_EMAIL_DOMAINS: 'schueler.meine-schule.de', ...env },
      dev: false,
      overrides: { dataDir },
    });
    return null;
  } catch (err) {
    return err.message;
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test('Adressen: Hub und Apps unter derselben Domain – der Hub startet nicht und sagt, was zu ändern ist', () => {
  const msg = refusal({ BASE_URL: 'https://hub.meine-schule.de', APPS_DOMAIN: 'apps.meine-schule.de' });
  assert.ok(msg, 'the address pair from the old .env.example is refused');
  assert.match(msg, /derselben Domain „meine-schule\.de“/);
  assert.match(msg, /APPS_DOMAIN=meine-schule-apps\.de/, 'it names a separate domain to use instead');
  assert.match(msg, /APPS_PUBLIC_SUFFIX=meine-schule\.de/, 'and the only override');
  assert.ok(refusal({ BASE_URL: 'https://meine-schule.de', APPS_DOMAIN: 'apps.meine-schule.de' }), 'apps below the Hub itself');
  assert.ok(refusal({ BASE_URL: 'https://hub.meine-schule.de', APPS_DOMAIN: 'meine-schule.de' }), 'the Hub below the apps domain');
  assert.ok(refusal({ BASE_URL: 'https://HUB.Meine-Schule.DE', APPS_DOMAIN: 'Apps.MEINE-schule.de' }), 'letter case does not matter');
  assert.ok(refusal({ BASE_URL: 'https://hub.meine-schule.de.', APPS_DOMAIN: 'apps.meine-schule.de' }), 'nor a final dot');
  assert.ok(refusal({ BASE_URL: 'https://school.localhost', APPS_DOMAIN: 'apps.school.localhost' }), "the security review's same-site simulation");
  // Separate registrable domains are fine (sharing only "de" is sharing nothing).
  assert.equal(refusal({ BASE_URL: 'https://hub.meine-schule.de', APPS_DOMAIN: 'meine-schule-apps.de' }), null);
  assert.equal(refusal({ BASE_URL: 'https://hub.meine-schule.de', APPS_DOMAIN: 'apps.andere-schule.de' }), null);
});

test('Adressen: APPS_PUBLIC_SUFFIX erlaubt nur genau die gemeinsame öffentliche Endung', () => {
  const env = { BASE_URL: 'https://hub.schule-a.co.uk', APPS_DOMAIN: 'schule-a-apps.co.uk' };
  assert.match(refusal(env), /derselben Domain „co\.uk“/);
  assert.equal(refusal({ ...env, APPS_PUBLIC_SUFFIX: 'co.uk' }), null, 'the operator confirms co.uk is a public suffix');
  assert.equal(refusal({ ...env, APPS_PUBLIC_SUFFIX: ' .CO.UK ' }), null, 'written loosely');
  assert.ok(refusal({ ...env, APPS_PUBLIC_SUFFIX: 'uk' }), 'a different suffix does not count');
  assert.ok(refusal({ BASE_URL: 'https://hub.meine-schule.de', APPS_DOMAIN: 'apps.meine-schule.de', APPS_PUBLIC_SUFFIX: 'de' }));
});

test('Adressen: echter Betrieb nur mit https (außer localhost); APPS_DOMAIN ist ein reiner Domainname', () => {
  assert.match(refusal({ BASE_URL: 'http://hub.meine-schule.de', APPS_DOMAIN: 'meine-schule-apps.de' }), /BASE_URL muss mit https:\/\/ beginnen/);
  assert.equal(refusal({ BASE_URL: 'http://localhost:3000', APPS_DOMAIN: 'apps.localhost' }), null);
  assert.equal(refusal({ BASE_URL: 'http://127.0.0.1:3000', APPS_DOMAIN: 'apps.localhost' }), null);
  for (const bad of ['*.meine-schule-apps.de', 'https://meine-schule-apps.de', 'meine-schule-apps.de:8443', 'meine-schule-apps.de/apps', 'meine schule.de', '-apps.de']) {
    assert.match(refusal({ BASE_URL: 'https://hub.meine-schule.de', APPS_DOMAIN: bad }) || '', /reiner Domainname/, bad);
  }
  // The local test mode is untouched.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schulhub-cfg-'));
  try {
    assert.doesNotThrow(() => loadConfig({ env: { BASE_URL: 'http://localhost:3000' }, dev: true, overrides: { dataDir } }));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Adressen: die Beispielwerte in .env.example halten die Regeln ein', () => {
  const env = {};
  for (const line of fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2];
  }
  assert.match(env.BASE_URL, /^https:\/\//);
  assert.equal(refusal({ BASE_URL: env.BASE_URL, APPS_DOMAIN: env.APPS_DOMAIN }), null, `${env.BASE_URL} + ${env.APPS_DOMAIN}`);
});

// ---------------------------------------------------------------- the Hub

let h;
let admin, teacher, mia, ben;
let A, T, M, B;
let cls, teacherApp, miaApp, benApp;

before(async () => {
  h = await startHub();
  admin = h.addUser('Anna Adler', 'admin');
  teacher = h.addUser('Herr Lehmann', 'teacher');
  mia = h.addUser('Mia Muster', 'student');
  ben = h.addUser('Ben Beispiel', 'student');
  [A, T, M, B] = await Promise.all([admin, teacher, mia, ben].map((u) => h.browser().login(u)));
  await T.post('/klassen', { name: '7b' });
  cls = h.db.get("SELECT class_id AS id FROM class_members WHERE user_id = ? AND role = 'teacher'", teacher.id).id;
  const code = h.db.get("SELECT code FROM join_codes WHERE class_id = ? AND role = 'student'", cls).code;
  for (const b of [M, B]) await b.post(`/beitreten/${code}`);

  teacherApp = await h.makeApp(T, 'Wortliste', { 'index.html': '<h1>Lehrer-App</h1>' });
  await T.post(`/klassen/${cls}/apps`, { app: teacherApp.id });
  // Mia's app is reviewed and approved in the 7b; Ben's waits for review.
  miaApp = await h.makeApp(M, 'Mias Spiel', { 'index.html': '<h1>Mias Spiel</h1>', 'level/zwei.html': '<h1>Level 2</h1>' });
  await M.post(`/apps/${miaApp.id}/einreichen`, { klasse: cls });
  await T.page(`/pruefen/${cls}/${miaApp.id}`);
  assert.equal((await T.post(`/pruefen/${cls}/${miaApp.id}/freigeben`, { version: miaApp.published_version_id })).status, 303);
  benApp = await h.makeApp(B, 'Bens Quiz', { 'index.html': '<h1>Bens Quiz</h1>' });
  await B.post(`/apps/${benApp.id}/einreichen`, { klasse: cls });
});
after(() => h.stop());

const iframeSrc = (text) => /<iframe[^>]* src="([^"]+)"/.exec(text)[1];
const dataOf = (text, name) => (new RegExp(`data-${name}="([^"]*)"`).exec(text) || [])[1];
/** GET an address on an app origin the way a browser loads a frame. */
function frameGet(b, url, dest = 'iframe') {
  const u = new URL(url, 'http://x');
  return b.raw('GET', u.pathname + u.search, { host: u.host, headers: dest ? { 'sec-fetch-dest': dest } : {} });
}
const appUrl = (app, p) => `http://${h.appHost(app)}${p}`;
const tokenIn = (url) => /\/~([^/]+)\//.exec(new URL(url, 'http://x').pathname)[1];
const payloadOf = (token) => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());

/** The player page of an app and its start page (fetched as the frame would). */
async function playerStart(b, app, qs = '') {
  const page = await b.page(`/apps/${app.id}/spielen${qs}`);
  assert.equal(page.status, 200);
  const start = dataOf(page.text, 'start');
  return { page, start, res: await frameGet(b, start) };
}

test('Startseite: nur mit gültigem Datei-Link genau dieser App – fremde, abgelaufene und gefälschte Links werden abgewiesen', async () => {
  const { start, res } = await playerStart(M, teacherApp, `?klasse=${cls}`);
  assert.equal(res.status, 200);
  assert.equal(dataOf(res.text, 'hub'), h.config.hubOrigin);
  assert.match(dataOf(res.text, 'person'), /^[A-Za-z0-9_-]{20}$/);
  // Headers: a strict policy of its own (only its own script, only inside the Hub), nosniff, never stored.
  assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  const csp = res.headers['content-security-policy'];
  for (const part of ["default-src 'none'", "script-src 'self'", `frame-ancestors ${h.config.hubOrigin}`, 'sandbox allow-scripts allow-same-origin']) assert.ok(csp.includes(part), part);
  assert.ok(!csp.includes('unsafe'), 'no inline script, no eval');
  assert.equal(res.headers['set-cookie'], undefined);
  // No inline script or style: one external script of the Hub, nothing else.
  assert.deepEqual([...res.text.matchAll(/<script[^>]*>/g)].map((m) => m[0]), [`<script src="/_hub/start.js?v=${/\?v=([0-9a-f]{16})/.exec(res.text)[1]}">`]);
  assert.ok(!/<style|\sstyle=|\son[a-z]+=/i.test(res.text), 'no inline style or event handler');

  const token = tokenIn(start);
  const other = await frameGet(M, appUrl(miaApp, `/~${token}/_hub/start`));
  assert.equal(other.status, 403, "another app's origin");
  assert.equal((await frameGet(M, start, 'document')).status, 403, 'never as a page of its own');
  const { tokens } = h.hub.ctx;
  const expired = tokens.sign('files', { a: teacherApp.id, v: teacherApp.published_version_id, u: mia.id, r: 1 }, -1);
  assert.equal((await frameGet(M, appUrl(teacherApp, `/~${expired}/_hub/start`))).status, 403, 'expired');
  const forged = Buffer.from(JSON.stringify({ ...payloadOf(token), u: ben.id })).toString('base64url');
  assert.equal((await frameGet(M, appUrl(teacherApp, `/~${forged}.${token.split('.')[1]}/_hub/start`))).status, 403, 'forged person');
  const sdk = await h.token(M, teacherApp, cls);
  assert.equal((await frameGet(M, appUrl(teacherApp, `/~${sdk.token}/_hub/start`))).status, 403, 'an SDK token is not a file token');
  assert.equal((await frameGet(M, appUrl(teacherApp, '/~abc.def/_hub/start'))).status, 403, 'garbage');
  // Other names in the reserved folder do not exist.
  assert.equal((await frameGet(M, appUrl(teacherApp, `/~${token}/_hub/info`))).status, 404);

  // The script: the Hub's own file, served with the app origin's headers.
  const v = /\?v=([0-9a-f]{16})/.exec(res.text)[1];
  const js = await frameGet(M, appUrl(teacherApp, `/_hub/start.js?v=${v}`), 'script');
  assert.equal(js.status, 200);
  assert.equal(js.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(js.headers['x-content-type-options'], 'nosniff');
  assert.match(js.headers['content-security-policy'], /sandbox allow-scripts allow-same-origin/);
  assert.match(js.headers['cache-control'], /immutable/);
  assert.equal(js.text, fs.readFileSync(path.join(ROOT, 'sdk', 'hub-start.js'), 'utf8'));
  assert.equal((await frameGet(M, appUrl(teacherApp, '/_hub/start.js'), 'document')).status, 403);
});

test('Startseite: die Markierung ist je Person und je App verschieden, für dieselbe Person immer gleich – und nichts Persönliches', async () => {
  const marker = async (b, app, qs) => {
    const { res } = await playerStart(b, app, qs);
    assert.equal(res.status, 200);
    for (const u of [mia, ben, teacher]) {
      for (const secret of [u.name, u.email, u.id, u.oid]) assert.ok(!res.text.includes(secret), `no ${secret} in the start page`);
    }
    return dataOf(res.text, 'person');
  };
  const miaTeacherApp = await marker(M, teacherApp, `?klasse=${cls}`);
  assert.equal(await marker(M, teacherApp, `?klasse=${cls}`), miaTeacherApp, 'the same person again: same marker (a new link each time)');
  assert.equal(await marker(M, teacherApp, ''), miaTeacherApp, 'also without the class');
  const benTeacherApp = await marker(B, teacherApp, `?klasse=${cls}`);
  const miaOwnApp = await marker(M, miaApp, '');
  assert.equal(new Set([miaTeacherApp, benTeacherApp, miaOwnApp]).size, 3, 'other person, other app: other marker');
  // A new session of the same person keeps the marker (a pupil's own device keeps its saves).
  const again = await h.browser().login(mia);
  assert.equal(await marker(again, teacherApp, `?klasse=${cls}`), miaTeacherApp);
  // It is not the pseudonym the SDK gives the app either.
  assert.notEqual(miaTeacherApp, (await h.token(M, teacherApp, cls)).user.id);
});

test('Startseite: Rahmen mit einfachem Link (Prüfplatz, Editor) gehen erst über sie; der Player hält sein Fenster bis dahin zurück', async () => {
  // The player: the frame waits in a <template>; the page opens the start page first.
  const { page, start, res } = await playerStart(M, teacherApp, `?klasse=${cls}`);
  assert.match(page.text, /<template id="appframe-hold" data-start="[^"]+"><iframe id="appframe" [^>]*><\/iframe><\/template>/);
  assert.equal(tokenIn(iframeSrc(page.text)), tokenIn(start));
  assert.equal(payloadOf(tokenIn(start)).r, 1, "the player's link is marked: it shows the start page itself");
  assert.equal(new URL(start).pathname.split('/').slice(2).join('/'), '_hub/start');
  const next = dataOf(res.text, 'next');
  assert.equal(next, new URL(iframeSrc(page.text)).pathname, 'the start page leads to exactly the app the player holds');
  assert.equal((await frameGet(M, appUrl(teacherApp, next))).text, '<h1>Lehrer-App</h1>');

  // The review workbench embeds a plain frame: the app origin sends it through the start page.
  const review = await T.page(`/pruefen/${cls}/${benApp.id}`);
  assert.equal(review.status, 200);
  const plain = iframeSrc(review.text);
  const hop = await frameGet(T, plain);
  assert.equal(hop.status, 303, 'a plain link never shows the app in a frame directly');
  assert.equal(hop.headers.location, `/~${tokenIn(plain)}/_hub/start?n=index.html`);
  const viaStart = await frameGet(T, appUrl(benApp, hop.headers.location));
  assert.equal(viaStart.status, 200);
  const reviewNext = dataOf(viaStart.text, 'next');
  assert.notEqual(tokenIn(appUrl(benApp, reviewNext)), tokenIn(plain), 'the app gets a marked copy of the link');
  assert.deepEqual({ ...payloadOf(tokenIn(appUrl(benApp, reviewNext))), exp: 0 }, { ...payloadOf(tokenIn(plain)), r: 1, exp: 0 });
  assert.equal((await frameGet(T, appUrl(benApp, reviewNext))).text, '<h1>Bens Quiz</h1>');

  // The editor's preview (a draft link) works the same way.
  const app = h.db.get('SELECT * FROM apps WHERE id = ?', miaApp.id);
  h.hub.ctx.uploads.draftFromVersion(app, h.db.get('SELECT * FROM app_versions WHERE id = ?', app.published_version_id));
  h.hub.ctx.uploads.putDraftFile(app, 'index.html', Buffer.from('<h1>Entwurf</h1>'));
  const editor = await M.page(`/studio/${miaApp.id}`);
  const draftSrc = /id="appframe"[^>]* src="([^"]+)"/.exec(editor.text)[1];
  const draftHop = await frameGet(M, draftSrc);
  assert.equal(draftHop.status, 303);
  const draftStart = await frameGet(M, appUrl(miaApp, draftHop.headers.location));
  const draftNext = dataOf(draftStart.text, 'next');
  assert.equal(payloadOf(tokenIn(appUrl(miaApp, draftNext))).d, 1, 'still the draft');
  assert.equal((await frameGet(M, appUrl(miaApp, draftNext))).text, '<h1>Entwurf</h1>');
  assert.equal((await M.page(`/apps/${miaApp.id}/spielen?entwurf=1`)).status, 200);

  // Scripts, images and fetches of a running app are not frames: unchanged.
  assert.equal((await frameGet(T, plain, null)).text, '<h1>Bens Quiz</h1>');
  assert.equal((await frameGet(T, plain, 'script')).status, 200);

  // The way on is always a plain path on this origin under the same link - whatever "n" says.
  const base = hop.headers.location.split('?')[0];
  for (const [n, end] of [['level/zwei.html', 'level/zwei.html'], ['../../x', 'index.html'], ['_hub/start', 'index.html'], ['//evil.example/x', 'index.html'], ['a\\b', 'index.html'], ['', 'index.html']]) {
    const r = await frameGet(T, appUrl(benApp, `${base}?n=${encodeURIComponent(n)}`));
    const to = dataOf(r.text, 'next');
    assert.ok(to.startsWith('/~') && to.endsWith(`/${end}`) && !to.includes('//'), `${n} -> ${to}`);
  }
});

test('Uploads können nie einen Pfad unter _hub/ anlegen', async () => {
  const app = await h.makeApp(M, 'Reserviert');
  const v = (await M.send('POST', `/apps/${app.id}/versionen`)).json();
  for (const p of ['_hub/start', '_hub/start.html', '_HUB/start.html', '_Hub/x/start.js']) {
    const res = await M.send('PUT', `/apps/${app.id}/versionen/${v.id}/datei?pfad=${encodeURIComponent(p)}`, Buffer.from('<h1>fake</h1>'), 'application/octet-stream');
    assert.equal(res.status, 400, p);
    assert.match(res.text, /reserviert/, p);
  }
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM app_files WHERE version_id = ?', v.id).n, 0);
  const row = h.db.get('SELECT * FROM apps WHERE id = ?', app.id);
  h.hub.ctx.uploads.draftFromVersion(row, h.db.get('SELECT * FROM app_versions WHERE id = ?', row.published_version_id));
  assert.throws(() => h.hub.ctx.uploads.putDraftFile(row, '_hub/start.html', Buffer.from('x')), /reserviert/);
});

// ------------------------------------------------- the start page in a browser-like sandbox

/**
 * Runs sdk/hub-start.js against fake browser storage. `before` describes what an earlier person
 * left; returns what is left afterwards, the cookie writes and the messages to the Hub page.
 */
async function runStartScript({ person, known, hang = false, blocked = false }) {
  const local = new Map([['spielstand', 'Sinas Geheimnis']]);
  if (known) local.set('schulhub:person', known);
  const session = new Map([['runde', '3']]);
  const databases = new Set(['/userfs', 'spiel']);
  const cacheNames = new Set(['bilder']);
  const files = new Set(['save.sqlite']);
  let workers = 1;
  const cookieWrites = [];
  const posted = [];
  const storage = (map) => ({
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
    get length() { return map.size; },
  });
  const win = {
    document: {
      readyState: 'complete',
      documentElement: { getAttribute: (n) => ({ 'data-hub': 'http://hub.example', 'data-person': person, 'data-next': '/~T/index.html' })[n] ?? null },
      get cookie() { return 'tagebuch=geheim; xapp=1'; },
      set cookie(v) { cookieWrites.push(v); },
    },
    location: { hostname: 'a0123456789abcdef0123.apps.localhost' },
    localStorage: storage(local),
    sessionStorage: storage(session),
    indexedDB: {
      databases: () => (hang ? new Promise(() => {}) : Promise.resolve([...databases].map((name) => ({ name, version: 1 })))),
      deleteDatabase(name) {
        const request = {};
        setImmediate(() => {
          if (blocked) return request.onblocked && request.onblocked();
          databases.delete(name);
          request.onsuccess();
        });
        return request;
      },
    },
    caches: { keys: async () => [...cacheNames], delete: async (k) => cacheNames.delete(k) },
    navigator: {
      serviceWorker: { getRegistrations: async () => Array.from({ length: workers }, () => ({ unregister: async () => { workers--; return true; } })) },
      storage: {
        getDirectory: async () => ({
          keys() { const list = [...files]; let i = 0; return { next: async () => (i < list.length ? { done: false, value: list[i++] } : { done: true }) }; },
          removeEntry: async (name) => files.delete(name),
        }),
      },
    },
    parent: { postMessage: (msg, origin) => posted.push({ msg, origin }) },
    addEventListener() {},
    // The time limit fires at once when asked to; the repeats of the message are left out.
    setTimeout: (fn, ms) => (ms === 3000 ? (hang ? setImmediate(fn) : 0) : ms >= 250 ? 0 : setTimeout(fn, ms)),
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'sdk', 'hub-start.js'), 'utf8'), win);
  for (let i = 0; i < 100 && !posted.length; i++) await new Promise((r) => setTimeout(r, 5));
  return { local, session, databases, cacheNames, files, workers, cookieWrites, posted };
}

test('Startseite (Skript): für eine andere Person wird alles gelöscht, für dieselbe nichts; die Meldung geht nur an den Hub', async () => {
  // A different person (or none known): everything goes, then the new marker is kept.
  for (const known of ['marker-von-sina', null]) {
    const r = await runStartScript({ person: 'marker-von-pia', known });
    assert.deepEqual([...r.local], [['schulhub:person', 'marker-von-pia']], 'localStorage: only the new marker');
    assert.equal(r.session.size, 0, 'sessionStorage');
    assert.equal(r.databases.size, 0, 'IndexedDB');
    assert.equal(r.cacheNames.size, 0, 'Cache Storage');
    assert.equal(r.workers, 0, 'service workers');
    assert.equal(r.files.size, 0, 'origin private files');
    for (const name of ['tagebuch', 'xapp']) {
      for (const domain of ['', '; domain=a0123456789abcdef0123.apps.localhost', '; domain=apps.localhost']) {
        assert.ok(r.cookieWrites.some((w) => w.startsWith(`${name}=;`) && w.includes('path=/') && w.includes('expires=Thu, 01 Jan 1970') && (domain ? w.includes(domain) : !w.includes('domain='))), `${name}${domain}`);
      }
      assert.ok(!r.cookieWrites.some((w) => w.includes('domain=localhost')), 'never a bare top-level domain');
    }
    assert.equal(r.posted.length, 1);
    assert.deepEqual(r.posted[0].origin, 'http://hub.example', 'only to the Hub origin');
    assert.equal(r.posted[0].msg.hub, 'storage');
    assert.equal(r.posted[0].msg.next, '/~T/index.html');
    assert.equal(r.posted[0].msg.cleared, true);
  }

  // The same person again: nothing is touched (a pupil's own device keeps its saves).
  const same = await runStartScript({ person: 'marker-von-pia', known: 'marker-von-pia' });
  assert.equal(same.local.get('spielstand'), 'Sinas Geheimnis');
  assert.equal(same.session.size + same.databases.size + same.cacheNames.size + same.files.size + same.workers, 1 + 2 + 1 + 1 + 1);
  assert.deepEqual(same.cookieWrites, []);
  assert.equal(same.posted[0].msg.cleared, false);

  // Something that cannot finish (a database still open elsewhere, an API that never answers):
  // the app may still start, but nothing is remembered - the next start clears again.
  for (const trouble of [{ blocked: true }, { hang: true }]) {
    const r = await runStartScript({ person: 'marker-von-pia', known: 'marker-von-sina', ...trouble });
    assert.equal(r.local.size, 0, `${JSON.stringify(trouble)}: cleared, but no marker kept`);
    assert.equal(r.posted.length, 1, `${JSON.stringify(trouble)}: the app still starts`);
  }
});

// ------------------------------------------------------------ app-wide shared data

test('Daten für alle: in Apps von Schüler/innen schreibt niemand – auch nicht die Besitzerin nach der Freigabe', async () => {
  const call = async (b, tok, method, params) => (await b.api(miaApp, tok.token, method, params)).json();
  const owner = await h.token(M, miaApp, cls);
  const ownerAlone = await h.token(M, miaApp);
  const mate = await h.token(B, miaApp, cls);
  const classTeacher = await h.token(T, miaApp, cls);
  const boss = await h.token(A, miaApp);
  const preview = await h.token(M, miaApp, null, miaApp.published_version_id);
  assert.equal(preview.mode, 'preview');
  for (const [who, b, tok] of [['owner', M, owner], ['owner, no class in the link', M, ownerAlone], ['classmate', B, mate], ['teacher of the class', T, classTeacher], ['admin', A, boss], ["owner's preview", M, preview]]) {
    for (const [method, params] of [['shared.set', { key: 'news', value: 'BELEIDIGUNG ÜBER LEA' }], ['shared.remove', { key: 'news' }]]) {
      const r = await call(b, tok, method, params);
      assert.equal(r.ok, false, `${who}: ${method}`);
      assert.equal(r.error.code, 'read_only', `${who}: ${method}`);
      assert.match(r.error.message, /nur Apps von Lehrkräften/);
    }
  }
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM shared_data WHERE app_id = ?', miaApp.id).n, 0);
  // Classmates never get it; reading itself is unchanged.
  assert.equal((await call(B, mate, 'shared.get', { key: 'news' })).result, null);
  assert.deepEqual((await call(B, mate, 'shared.keys', {})).result, []);
  h.db.run("INSERT INTO shared_data (app_id, class_id, key, value, size, updated_at) VALUES (?, '', 'alt', '\"von früher\"', 12, ?)", miaApp.id, Date.now());
  assert.equal((await call(B, mate, 'shared.get', { key: 'alt' })).result, 'von früher', 'data from before stays readable');
  assert.equal((await call(M, owner, 'shared.set', { key: 'alt', value: 'neu' })).error.code, 'read_only');
  // Class data stays with the class's teacher, in any app.
  assert.equal((await call(T, classTeacher, 'class.set', { key: 'woerter', value: ['hund'] })).ok, true);
  assert.equal((await call(M, owner, 'class.set', { key: 'woerter', value: ['x'] })).error.code, 'forbidden');
});

test('Daten für alle: in Apps von Lehrkräften wie bisher – Besitzer/in und Admin schreiben, alle lesen', async () => {
  const call = async (b, tok, method, params) => (await b.api(teacherApp, tok.token, method, params)).json();
  const owner = await h.token(T, teacherApp, cls);
  assert.equal((await call(T, owner, 'shared.set', { key: 'level', value: { ziel: 10 } })).ok, true);
  assert.equal((await call(A, await h.token(A, teacherApp), 'shared.set', { key: 'admin', value: 1 })).ok, true);
  const mate = await h.token(B, teacherApp, cls);
  assert.deepEqual((await call(B, mate, 'shared.get', { key: 'level' })).result, { ziel: 10 });
  assert.equal((await call(B, mate, 'shared.set', { key: 'level', value: 'x' })).error.code, 'forbidden');
  // A preview of the teacher's own app still writes to memory only.
  const preview = await h.token(T, teacherApp, null, teacherApp.published_version_id);
  assert.equal((await call(T, preview, 'shared.set', { key: 'level', value: 'probe' })).ok, true);
  assert.deepEqual((await call(B, mate, 'shared.get', { key: 'level' })).result, { ziel: 10 }, 'the preview wrote nothing real');
});
