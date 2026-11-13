'use strict';
// Regression tests for checks that the final security review could weaken
// (mutation testing) without any test noticing. Each test below fails when its
// check is removed or loosened; docs/notes/fix-P4.md lists the mutation each
// one was proven against.
//
// Covered: archived classes (player without ?klasse=, search), expired tokens,
// the return target after signing in, the absolute session lifetime, test mode
// on loopback only, the account upload quota, the Microsoft callback
// (src/auth.js with a stand-in for MSAL), the Hub's CSP, the write and
// upload-start limits, token kinds, and hashed session ids in the store.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { randomUUID } = require('node:crypto');
const { startHub, makeZip } = require('./helpers');
const { loadConfig } = require('../src/config');
const { createAuth } = require('../src/auth');
const { sidHash, createSessionStore } = require('../src/sessions');

const teacherClass = (h, userId) => h.db.get("SELECT class_id AS id FROM class_members WHERE user_id = ? AND role = 'teacher' ORDER BY joined_at DESC LIMIT 1", userId).id;
const joinCode = (h, classId) => h.db.get("SELECT code FROM join_codes WHERE class_id = ? AND role = 'student'", classId).code;
/** The file token from the player page's iframe address. */
const fileTokenOf = (playerHtml) => /src="[^"]*\/~([^/"]+)\/index\.html"/.exec(playerHtml)[1];
/** A token's signed payload without its expiry (to sign it again, e.g. as another kind or already expired). */
const payloadOf = (token) => {
  const p = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
  delete p.exp;
  return p;
};
const newAppId = (res) => res.headers.location.split('/').pop();

/** Every TEXT value in every table. */
function allText(db) {
  const out = [];
  for (const { name } of db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")) {
    const cols = db.all(`PRAGMA table_info(${name})`).filter((c) => /TEXT/i.test(c.type)).map((c) => c.name);
    for (const col of cols) for (const r of db.all(`SELECT ${col} AS v FROM ${name} WHERE ${col} IS NOT NULL`)) out.push({ table: name, col, v: String(r.v) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// A stand-in for '@azure/msal-node' (the tests have no Microsoft connection).
// It is put into require.cache only while createAuth runs, so src/auth.js runs
// unchanged: state, PKCE, tenant and one-time-use checks are the real code.
// The token endpoint answers every code with the claims the test chooses.
const TENANT = '7f3c2a10-5b8e-4d21-9c66-0e4a1b2c3d4e';

function withFakeMsal(build) {
  const id = require.resolve('@azure/msal-node');
  const saved = require.cache[id];
  const ms = { claims: {}, exchanges: [], options: null };
  let n = 0;
  const fake = {
    ConfidentialClientApplication: class {
      constructor(options) {
        ms.options = options;
      }
      async getAuthCodeUrl(request) {
        return `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize?state=${encodeURIComponent(request.state)}`;
      }
      async acquireTokenByCode(request) {
        ms.exchanges.push(request);
        return { idTokenClaims: { ...ms.claims } };
      }
    },
    CryptoProvider: class {
      async generatePkceCodes() {
        n += 1;
        return { verifier: `verifier-${n}`, challenge: `challenge-${n}` };
      }
      createNewGuid() {
        return randomUUID();
      }
    },
  };
  const m = new Module(id);
  m.filename = id;
  m.loaded = true;
  m.exports = fake;
  require.cache[id] = m;
  try {
    return { ms, auth: build() };
  } finally {
    if (saved) require.cache[id] = saved;
    else delete require.cache[id];
  }
}

/** Switch a running test Hub to the real Microsoft code path (with the stand-in for MSAL). */
function useMicrosoft(h) {
  h.config.microsoft = { tenantId: TENANT, clientId: 'client-schulhub', clientSecret: 'geheim' };
  const { ms, auth } = withFakeMsal(() => createAuth(h.hub.ctx));
  Object.assign(h.hub.ctx.auth, auth); // the routes call the methods of this object
  return ms;
}

// ---------------------------------------------------------------------------

test('Archivierte Klassen: Schüler/innen öffnen deren Apps auch ohne ?klasse= nicht mehr, und die Suche nennt sie nicht', async () => {
  const h = await startHub();
  try {
    const lehmann = h.addUser('Herr Lehmann', 'teacher');
    const mia = h.addUser('Mia', 'student');
    const [L, M] = await Promise.all([lehmann, mia].map((u) => h.browser().login(u)));
    await L.post('/klassen', { name: 'Zebraklasse 7b' });
    const cls = teacherClass(h, lehmann.id);
    await M.post(`/beitreten/${joinCode(h, cls)}`);
    const app = await h.makeApp(L, 'Klassenspiel', { 'index.html': 'x' });
    await L.post(`/klassen/${cls}/apps`, { app: app.id });

    // While the class is active: Mia opens the app without ?klasse= (through her class) and finds the class.
    assert.equal((await M.page(`/apps/${app.id}/spielen`)).status, 200, 'precondition: the class gives her the app');
    assert.ok((await h.token(M, app)).class, 'precondition: with the class as context');
    assert.ok((await M.page('/suche?q=Zebraklasse')).text.includes('Zebraklasse 7b'), 'precondition: her search finds the class');

    await L.page(`/klassen/${cls}`);
    assert.equal((await L.post(`/klassen/${cls}/archivieren`)).status, 303);

    assert.equal((await M.get(`/apps/${app.id}/spielen`)).status, 404, 'no app through an archived class');
    assert.equal((await M.page('/start')).status, 200);
    assert.equal((await M.send('POST', `/apps/${app.id}/token`, { first: true })).status, 404, 'and no SDK token either');
    const search = await M.page('/suche?q=Zebraklasse');
    assert.equal(search.status, 200);
    assert.ok(!search.text.includes('Zebraklasse 7b'), 'the name of the archived class is not shown to her');
    assert.ok(!search.text.includes(`/klassen/${cls}`), 'nor a link to it');
    assert.ok((await L.page('/suche?q=Zebraklasse')).text.includes('Zebraklasse 7b'), 'its teacher still finds it');
  } finally {
    await h.stop();
  }
});

test('Abgelaufene Tokens: ein alter Datei-Link und ein altes SDK-Token werden abgelehnt', async () => {
  const h = await startHub();
  try {
    const T = await h.browser().login(h.addUser('Frau Yilmaz', 'teacher'));
    const app = await h.makeApp(T, 'Spiel', { 'index.html': 'x' });
    const { tokens } = h.hub.ctx;
    const file = (token) => T.raw('GET', `/~${token}/index.html`, { host: h.appHost(app) });
    const api = (token) => T.api(app, token, 'save.keys');

    // The player's own tokens, signed again with the same content: valid now, expired a second ago.
    const filePayload = payloadOf(fileTokenOf((await T.page(`/apps/${app.id}/spielen`)).text));
    const sdkPayload = payloadOf((await h.token(T, app)).token);
    assert.equal((await file(tokens.sign('files', filePayload, 60))).status, 200, 'precondition: the file link works while valid');
    assert.equal((await api(tokens.sign('sdk', sdkPayload, 60))).status, 200, 'precondition: the SDK token works while valid');

    const oldFile = await file(tokens.sign('files', filePayload, -1));
    assert.equal(oldFile.status, 403, 'an expired file link is refused');
    assert.match(oldFile.text, /abgelaufen/);
    const oldSdk = await api(tokens.sign('sdk', sdkPayload, -1));
    assert.equal(oldSdk.status, 401, 'an expired SDK token is refused');
    assert.equal(oldSdk.json().error.code, 'unauthorized');
  } finally {
    await h.stop();
  }
});

test('Rückkehr nach der Anmeldung: //fremd und /\\fremd führen auf /start – bei Test- und Microsoft-Anmeldung', async () => {
  const h = await startHub({ studentDomains: ['schueler.schule.example'] });
  try {
    const mia = h.addUser('Mia', 'student');
    const ms = useMicrosoft(h);
    ms.claims = { tid: TENANT, oid: 'oid-ben', name: 'Ben Berg', email: 'ben@schueler.schule.example' };

    for (const foreign of ['//evil.example/x', '/\\evil.example/x']) {
      // Test login.
      const D = h.browser();
      const asked = await D.get(foreign);
      assert.deepEqual([asked.status, asked.headers.location], [302, '/']);
      assert.match((await D.page('/')).text, /danach geht es auf der Seite weiter/, `precondition: ${foreign} was stored as the return target`);
      const viaTest = await D.post('/dev/login', { user: mia.id });
      assert.deepEqual([viaTest.status, viaTest.headers.location], [303, '/start'], `${foreign} after the test login`);

      // Microsoft sign-in (real routes, real src/auth.js).
      const X = h.browser();
      await X.get(foreign);
      assert.match((await X.page('/')).text, /danach geht es auf der Seite weiter/, `precondition: ${foreign} was stored as the return target`);
      const start = await X.get('/auth/login');
      assert.equal(start.status, 302);
      const state = new URL(start.headers.location).searchParams.get('state');
      const viaMicrosoft = await X.get(`/auth/callback?code=echt&state=${encodeURIComponent(state)}`);
      assert.deepEqual([viaMicrosoft.status, viaMicrosoft.headers.location], [302, '/start'], `${foreign} after the Microsoft sign-in`);
      assert.equal((await X.page('/start')).status, 200, 'signed in');
    }

    // A normal Hub path is still honoured (the check is not just "always /start").
    const P = h.browser();
    await P.get('/klassen');
    await P.page('/');
    assert.equal((await P.post('/dev/login', { user: mia.id })).headers.location, '/klassen');
  } finally {
    await h.stop();
  }
});

test('Sitzungsspeicher: eine Anmeldung wird nie über die feste Höchstdauer hinaus gespeichert – das SDK-Token endet mit ihr', async () => {
  const h = await startHub();
  try {
    const mia = h.addUser('Mia', 'student');
    const M = await h.browser().login(mia);
    const app = await h.makeApp(await h.browser().login(h.addUser('Frau Yilmaz', 'teacher')), 'Für alle', { 'index.html': 'x' });
    h.db.run('UPDATE apps SET schoolwide_version_id = published_version_id WHERE id = ?', app.id);
    await M.page('/start');
    const sdk = (await h.token(M, app)).token;
    assert.equal((await M.api(app, sdk, 'save.keys')).status, 200, 'precondition: her app works');
    // Her session is saved once more (as after any change), when her sign-in lies longer ago than sessionMs
    // and the cookie would still last an hour. No Hub request follows: only the SDK asks.
    const sid = decodeURIComponent([...M.jar.values()][0]).replace(/^s:/, '').replace(/\.[^.]*$/, '');
    const row = h.db.get('SELECT data FROM sessions WHERE sid_hash = ?', sidHash(sid));
    assert.ok(row, 'precondition: the cookie names the stored session');
    const data = JSON.parse(row.data);
    data.createdAt = Date.now() - h.config.sessionMs - 60_000;
    data.cookie.expires = new Date(Date.now() + 60 * 60_000).toISOString();
    const store = createSessionStore(h.db, h.config.sessionMs);
    await new Promise((resolve, reject) => store.set(sid, data, (err) => (err ? reject(err) : resolve())));
    assert.ok(h.db.get('SELECT expires_at FROM sessions WHERE sid_hash = ?', sidHash(sid)).expires_at <= Date.now(), 'stored end = sign-in + sessionMs, not the cookie end');
    assert.equal((await M.api(app, sdk, 'save.keys')).status, 401, 'the SDK token ends with the session');
  } finally {
    await h.stop();
  }
});

test('Sitzungen enden nach der festen Höchstdauer – auch wenn der Speicher sie noch länger hielte', async () => {
  const h = await startHub();
  try {
    const mia = h.addUser('Mia', 'student');
    const M = await h.browser().login(mia);
    const app = await h.makeApp(await h.browser().login(h.addUser('Frau Yilmaz', 'teacher')), 'Für alle', { 'index.html': 'x' });
    h.db.run('UPDATE apps SET schoolwide_version_id = published_version_id WHERE id = ?', app.id);
    await M.page('/start');
    const sdk = (await h.token(M, app)).token;
    assert.equal((await M.api(app, sdk, 'save.keys')).status, 200, 'precondition: her app works');

    // Her session started longer ago than sessionMs, but the store would keep it for another hour.
    const row = h.db.get('SELECT sid_hash, data FROM sessions WHERE user_id = ?', mia.id);
    const data = JSON.parse(row.data);
    assert.equal(typeof data.createdAt, 'number', 'precondition: the session knows when it started');
    data.createdAt = Date.now() - h.config.sessionMs - 60_000;
    h.db.run('UPDATE sessions SET data = ?, expires_at = ? WHERE sid_hash = ?', JSON.stringify(data), Date.now() + 60 * 60_000, row.sid_hash);

    const res = await M.get('/start');
    assert.deepEqual([res.status, res.headers.location], [302, '/'], 'signed out');
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM sessions WHERE sid_hash = ?', row.sid_hash).n, 0, 'the old session is gone from the store');
    assert.equal((await M.api(app, sdk, 'save.keys')).status, 401, 'and the SDK token of that session ends with it');

    // A signed-in session without a start time (e.g. written by an older version) does not count as fresh.
    const again = await h.browser().login(mia);
    const row2 = h.db.get('SELECT sid_hash, data FROM sessions WHERE user_id = ?', mia.id);
    const data2 = JSON.parse(row2.data);
    delete data2.createdAt;
    h.db.run('UPDATE sessions SET data = ? WHERE sid_hash = ?', JSON.stringify(data2), row2.sid_hash);
    assert.deepEqual([(await again.get('/start')).status, h.db.get('SELECT COUNT(*) AS n FROM sessions WHERE sid_hash = ?', row2.sid_hash).n], [302, 0]);
  } finally {
    await h.stop();
  }
});

test('Testmodus hört nur auf dem eigenen Rechner (127.0.0.1, ::1) – auch wenn LISTEN_HOST gesetzt ist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schulhub-listen-'));
  try {
    const hosts = (env, dev) => loadConfig({ env, dev, overrides: { dataDir: dir } }).listenHosts;
    const local = { BASE_URL: 'http://localhost:3000' };
    assert.deepEqual(hosts(local, true), ['127.0.0.1', '::1']);
    for (const LISTEN_HOST of ['0.0.0.0', '::', '192.168.1.20']) {
      assert.deepEqual(hosts({ ...local, LISTEN_HOST }, true), ['127.0.0.1', '::1'], `LISTEN_HOST=${LISTEN_HOST} is ignored in test mode`);
    }
    // In real mode LISTEN_HOST decides (shows the variable is read at all).
    const real = {
      BASE_URL: 'https://hub.schule.example', SESSION_SECRET: 'k'.repeat(48), TENANT_ID: TENANT, CLIENT_ID: 'client-schulhub', CLIENT_SECRET: 'geheim',
      STUDENT_EMAIL_DOMAINS: 'schueler.schule.example', APPS_DOMAIN: 'schule-apps.example',
    };
    assert.deepEqual(hosts(real, false), ['0.0.0.0']);
    assert.deepEqual(hosts({ ...real, LISTEN_HOST: '10.0.0.5' }, false), ['10.0.0.5']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Speicherplatz pro Konto (maxUserBytes) gilt für Uploads – Datei für Datei und als ZIP, über alle Apps', async () => {
  const h = await startHub({ limits: { maxUserBytes: 1000 } });
  try {
    const t = h.addUser('Herr Lehmann', 'teacher');
    const [T, U] = await Promise.all([t, h.addUser('Frau Yilmaz', 'teacher')].map((u) => h.browser().login(u)));
    await h.makeApp(T, 'Eins', { 'index.html': 'a'.repeat(600) }); // 600 of 1000 bytes used

    const two = newAppId(await T.post('/apps', { name: 'Zwei', emoji: '🎮', color: '0' }));
    const v = (await T.send('POST', `/apps/${two}/versionen`)).json();
    const put = (p, size) => T.send('PUT', `/apps/${two}/versionen/${v.id}/datei?pfad=${p}`, Buffer.from('b'.repeat(size)), 'application/octet-stream');
    const over = await put('index.html', 500);
    assert.equal(over.status, 413, 'a second app cannot go past the account cap (refused before the body is read)');
    assert.match(over.text, /Speicherplatz dieses Kontos ist voll/);
    assert.equal((await put('index.html', 300)).status, 200, 'below the cap the upload works'); // 900 used
    const zip = await T.send('POST', `/apps/${two}/versionen/zip`, makeZip([{ name: 'index.html', data: 'c'.repeat(200) }]), 'application/zip');
    assert.equal(zip.status, 400, 'a zip cannot go past it either');
    assert.match(zip.text, /Speicherplatz dieses Kontos ist voll/);
    assert.ok(h.hub.ctx.uploads.userBytes(t.id) <= 1000, 'the account holds no more than its cap');

    await h.makeApp(U, 'Eigene', { 'index.html': 'd'.repeat(600) }); // throws if refused
  } finally {
    await h.stop();
  }
});

test('Microsoft-Rückmeldung (src/auth.js): Zustand, Code, Mandant und Einmal-Gebrauch werden geprüft', async () => {
  const { ms, auth } = withFakeMsal(() => createAuth({ config: { microsoft: { tenantId: TENANT, clientId: 'client-schulhub', clientSecret: 'geheim' }, hubOrigin: 'http://localhost:3000' }, db: null }));
  assert.ok(auth.enabled, 'precondition: the stand-in replaced MSAL');
  assert.equal(ms.options.auth.authority, `https://login.microsoftonline.com/${TENANT}`, 'only our tenant is asked');
  const mia = { tid: TENANT, oid: 'oid-mia', name: 'Mia Schmidt', email: 'mia@schueler.schule.example' };
  ms.claims = mia;
  const begin = async () => {
    const session = {};
    await auth.loginUrl(session);
    return { session, state: session.authFlow.state };
  };
  const refused = (promise, why, re = /nicht geklappt/) => assert.rejects(promise, (e) => e.status === 403 && re.test(e.message), why);

  // A valid callback returns exactly who signed in - and redeems the code with this flow's PKCE verifier.
  let f = await begin();
  const verifier = f.session.authFlow.verifier;
  assert.deepEqual(await auth.handleCallback(f.session, { code: 'echt', state: f.state }), { oid: 'oid-mia', name: 'Mia Schmidt', email: 'mia@schueler.schule.example' });
  assert.equal(ms.exchanges.at(-1).codeVerifier, verifier);
  await refused(auth.handleCallback(f.session, { code: 'echt', state: f.state }), 'single use: the same callback a second time');

  // A wrong state is refused although the code exchange would succeed - and the code is never redeemed.
  f = await begin();
  const redeemed = ms.exchanges.length;
  await refused(auth.handleCallback(f.session, { code: 'echt', state: 'falsch' }), 'wrong state');
  await refused(auth.handleCallback(f.session, { code: 'echt', state: f.state }), 'single use: a failed try used the flow up');
  f = await begin();
  await refused(auth.handleCallback(f.session, { code: 'echt' }), 'no state');
  assert.equal(ms.exchanges.length, redeemed, 'the code of a forged callback is not sent to Microsoft');

  // No code (or not a single one), or an error from Microsoft.
  f = await begin();
  await refused(auth.handleCallback(f.session, { state: f.state }), 'no code');
  f = await begin();
  await refused(auth.handleCallback(f.session, { code: ['a', 'b'], state: f.state }), 'two codes');
  f = await begin();
  await refused(auth.handleCallback(f.session, { code: 'echt', state: f.state, error: 'access_denied' }), 'error from Microsoft');
  await refused(auth.handleCallback({}, { code: 'echt', state: f.state }), 'no sign-in was started in this session');

  // A token of another tenant (or without an object id) is refused.
  f = await begin();
  ms.claims = { ...mia, tid: '00000000-aaaa-bbbb-cccc-000000000000' };
  await refused(auth.handleCallback(f.session, { code: 'echt', state: f.state }), 'other tenant', /nicht zu unserer Schule/);
  f = await begin();
  ms.claims = { ...mia, tid: undefined };
  await refused(auth.handleCallback(f.session, { code: 'echt', state: f.state }), 'no tenant', /nicht zu unserer Schule/);
  f = await begin();
  ms.claims = { ...mia, oid: undefined };
  await refused(auth.handleCallback(f.session, { code: 'echt', state: f.state }), 'no oid', /nicht zu unserer Schule/);
});

test('Microsoft-Anmeldung über die echten Routen: falscher Zustand und fremder Mandant scheitern, der Ablauf gilt einmal', async () => {
  const h = await startHub({ studentDomains: ['schueler.schule.example'] });
  try {
    const ms = useMicrosoft(h);
    const mia = { tid: TENANT, oid: 'oid-mia', name: 'Mia Schmidt', email: 'mia@schueler.schule.example' };
    const begin = async () => {
      const B = h.browser();
      await B.page('/');
      const start = await B.get('/auth/login');
      assert.equal(start.status, 302);
      return { B, state: new URL(start.headers.location).searchParams.get('state') };
    };
    const signedIn = () => h.db.get("SELECT COUNT(*) AS n FROM users WHERE oid = 'oid-mia'").n;

    ms.claims = mia;
    let { B, state } = await begin();
    assert.equal((await B.get(`/auth/callback?code=echt&state=falsch`)).status, 403, 'wrong state');
    assert.equal((await B.get(`/auth/callback?code=echt&state=${state}`)).status, 400, 'the flow was used up by the failed try');
    ({ B, state } = await begin());
    assert.equal((await B.get(`/auth/callback?state=${state}`)).status, 403, 'no code');
    ({ B, state } = await begin());
    ms.claims = { ...mia, tid: '00000000-aaaa-bbbb-cccc-000000000000' };
    assert.equal((await B.get(`/auth/callback?code=echt&state=${state}`)).status, 403, 'other tenant');
    assert.equal(signedIn(), 0, 'nobody was signed in so far');

    ms.claims = mia;
    ({ B, state } = await begin());
    const done = await B.get(`/auth/callback?code=echt&state=${state}`);
    assert.deepEqual([done.status, done.headers.location], [302, '/start']);
    assert.equal((await B.page('/start')).status, 200);
    assert.ok(h.db.get("SELECT 1 AS ok FROM users WHERE oid = 'oid-mia' AND name = 'Mia Schmidt' AND email = 'mia@schueler.schule.example' AND role = 'student'"));
  } finally {
    await h.stop();
  }
});

test("Hub-CSP: default-src 'none', Skripte und Stile nur von 'self' – auf jeder Art von Seite", async () => {
  const h = await startHub();
  try {
    const lehmann = h.addUser('Herr Lehmann', 'teacher');
    const L = await h.browser().login(lehmann);
    await L.post('/klassen', { name: '7b' });
    const cls = teacherClass(h, lehmann.id);
    const app = await h.makeApp(L, 'Spiel', { 'index.html': 'x' });
    const anon = h.browser();
    const pages = [
      ['landing', await anon.get('/'), 200],
      ['start', await L.get('/start'), 200],
      ['class', await L.get(`/klassen/${cls}`), 200],
      ['app page', await L.get(`/apps/${app.id}`), 200],
      ['player', await L.get(`/apps/${app.id}/spielen`), 200],
      ['error 404', await L.get('/gibt-es-nicht'), 404],
      ['error 400 (no account)', await anon.get('/auth/callback?code=x&state=y'), 400],
      ['redirect (no account)', await h.browser().get('/start'), 302],
    ];
    for (const [label, res, status] of pages) {
      assert.equal(res.status, status, `precondition: ${label}`);
      const header = res.headers['content-security-policy'];
      assert.equal(typeof header, 'string', `${label}: has a CSP`);
      const csp = new Map();
      for (const part of header.split(';')) {
        const [name, ...values] = part.trim().split(/\s+/);
        if (name) {
          assert.ok(!csp.has(name.toLowerCase()), `${label}: ${name} only once`);
          csp.set(name.toLowerCase(), values);
        }
      }
      assert.deepEqual(csp.get('default-src'), ["'none'"], `${label}: default-src`);
      assert.deepEqual(csp.get('script-src'), ["'self'"], `${label}: script-src is 'self' only (no 'unsafe-inline', 'unsafe-eval', * or hosts)`);
      assert.deepEqual(csp.get('style-src'), ["'self'"], `${label}: style-src is 'self' only`);
      for (const loosening of ['script-src-elem', 'script-src-attr', 'style-src-elem', 'style-src-attr']) assert.ok(!csp.has(loosening), `${label}: no ${loosening}`);
      assert.doesNotMatch(header, /'unsafe-inline'|'unsafe-eval'|'unsafe-hashes'|'strict-dynamic'/, `${label}: nothing unsafe anywhere`);
    }
  } finally {
    await h.stop();
  }
});

test('Allgemeine Schreibgrenze (rate.write): 429 über der Grenze – nur für diese Person', async () => {
  const h = await startHub({ rate: { write: [3, 60_000] } });
  try {
    const [M, B] = await Promise.all([h.addUser('Mia', 'student'), h.addUser('Ben', 'student')].map((u) => h.browser().login(u)));
    for (let i = 0; i < 3; i++) assert.equal((await M.post('/mitteilungen/gelesen')).status, 303, `write ${i + 1}`);
    assert.equal((await M.post('/mitteilungen/gelesen')).status, 429, 'over the limit');
    assert.equal((await M.send('POST', '/mitteilungen/gelesen')).status, 429, 'JSON requests count too');
    assert.equal((await B.post('/mitteilungen/gelesen')).status, 303, 'Ben, from the same address, is not affected');
  } finally {
    await h.stop();
  }
});

test('Upload-Start-Grenze (rate.uploadVersions): 429 über der Grenze – nur für diese Person', async () => {
  const h = await startHub({ rate: { uploadVersions: [2, 60 * 60_000] } });
  try {
    const [T, U] = await Promise.all([h.addUser('Herr Lehmann', 'teacher'), h.addUser('Frau Yilmaz', 'teacher')].map((u) => h.browser().login(u)));
    const mine = newAppId(await T.post('/apps', { name: 'Eins', emoji: '🎮', color: '0' }));
    const theirs = newAppId(await U.post('/apps', { name: 'Zwei', emoji: '🎮', color: '0' }));
    for (let i = 0; i < 2; i++) assert.equal((await T.send('POST', `/apps/${mine}/versionen`)).status, 200, `upload ${i + 1}`);
    assert.equal((await T.send('POST', `/apps/${mine}/versionen`)).status, 429, 'over the limit');
    assert.equal((await U.send('POST', `/apps/${theirs}/versionen`)).status, 200, 'another person is not affected');
  } finally {
    await h.stop();
  }
});

test('Token-Arten sind getrennt: Datei-Link und SDK-Token gelten nie füreinander', async () => {
  const h = await startHub();
  try {
    const T = await h.browser().login(h.addUser('Frau Yilmaz', 'teacher'));
    const app = await h.makeApp(T, 'Spiel', { 'index.html': 'x' });
    const { tokens } = h.hub.ctx;
    const file = (token) => T.raw('GET', `/~${token}/index.html`, { host: h.appHost(app) }).then((r) => r.status);
    const api = (token) => T.api(app, token, 'save.keys').then((r) => r.status);
    const fileToken = fileTokenOf((await T.page(`/apps/${app.id}/spielen`)).text);
    const sdkToken = (await h.token(T, app)).token;
    assert.equal(await file(fileToken), 200, 'precondition: the file link works');
    assert.equal(await api(sdkToken), 200, 'precondition: the SDK token works');

    // The real tokens, swapped.
    assert.equal(await api(fileToken), 401, 'a file link is no SDK token');
    assert.equal(await file(sdkToken), 403, 'an SDK token opens no files');
    // Whatever a token contains: signed as one kind, it never counts as the other.
    const sdkPayload = payloadOf(sdkToken);
    const filePayload = payloadOf(fileToken);
    assert.equal(await api(tokens.sign('files', sdkPayload, 600)), 401, 'SDK content signed as a file token');
    assert.equal(await file(tokens.sign('sdk', filePayload, 600)), 403, 'file content signed as an SDK token');
    assert.equal(await api(tokens.sign('sdk', sdkPayload, 600)), 200, 'control: the same content as the right kind works');
    assert.equal(await file(tokens.sign('files', filePayload, 600)), 200, 'control: the same content as the right kind works');
  } finally {
    await h.stop();
  }
});

test('Sitzungsspeicher: die Sitzungs-ID aus dem Cookie steht nirgends in der Datenbank – und kein App-Token verrät sie', async () => {
  const h = await startHub();
  try {
    const mia = h.addUser('Mia', 'student');
    const M = await h.browser().login(mia);
    const app = await h.makeApp(await h.browser().login(h.addUser('Frau Yilmaz', 'teacher')), 'Für alle', { 'index.html': 'x' });
    h.db.run('UPDATE apps SET schoolwide_version_id = published_version_id WHERE id = ?', app.id);
    const sdk = (await h.token(M, app)).token;
    await M.post('/mitteilungen/gelesen'); // one more write to the session

    const signed = decodeURIComponent(M.jar.get('hub_sid'));
    assert.match(signed, /^s:[^.]+\./, 'precondition: a signed session cookie');
    const sid = signed.slice(2, signed.indexOf('.'));
    assert.ok(sid.length >= 20, 'precondition: a real session id');
    assert.equal(h.db.get('SELECT user_id FROM sessions WHERE sid_hash = ?', sidHash(sid)).user_id, mia.id, 'precondition: her session is stored under the hash');

    assert.deepEqual(allText(h.db).filter((t) => t.v.includes(sid)), [], 'the raw session id is stored nowhere');
    assert.ok(!Buffer.from(sdk.split('.')[0], 'base64url').toString('utf8').includes(sid), 'the token an app gets does not carry it');
  } finally {
    await h.stop();
  }
});
