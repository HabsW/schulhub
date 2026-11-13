'use strict';
// Attack tests for the findings of the independent security review that the
// lead fixed in the foundation: deleted accounts leave no names behind,
// archived classes cannot be written through the SDK, limits are per person
// (a school shares one address), submissions cannot flood teachers, files have
// an account cap, personal pages are not cached, results stay in their class,
// archived classes do not reveal names on leaderboards, and nobody at the
// school's shared address can lock the others out of signing in.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { startHub } = require('./helpers');

const teacherClass = (h, userId) => h.db.get("SELECT class_id AS id FROM class_members WHERE user_id = ? AND role = 'teacher' ORDER BY joined_at DESC LIMIT 1", userId).id;
const joinCode = (h, classId) => h.db.get("SELECT code FROM join_codes WHERE class_id = ? AND role = 'student'", classId).code;

/** Every TEXT value in every table, for scanning after a deletion. */
function allText(db) {
  const out = [];
  for (const { name } of db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")) {
    const cols = db.all(`PRAGMA table_info(${name})`).filter((c) => /TEXT/i.test(c.type)).map((c) => c.name);
    for (const col of cols) for (const r of db.all(`SELECT ${col} AS v FROM ${name} WHERE ${col} IS NOT NULL`)) out.push({ table: name, col, v: String(r.v) });
  }
  return out;
}

test('Konto löschen: kein Name bleibt zurück – weder im Protokoll noch in Mitteilungen anderer', async () => {
  const h = await startHub();
  try {
    const admin = h.addUser('Anna Adler', 'admin');
    const lehmann = h.addUser('Herr Lehmann', 'teacher');
    const zwirbel = h.addUser('Herr Zwirbel', 'teacher');
    const ziel = h.addUser('Marlene Zuckerbrot', 'student');
    const paul = h.addUser('Paul Peer', 'student');
    const [A, L, W, Z, P] = await Promise.all([admin, lehmann, zwirbel, ziel, paul].map((u) => h.browser().login(u)));
    await L.post('/klassen', { name: '7b' });
    const cls = teacherClass(h, lehmann.id);
    await Z.post(`/beitreten/${joinCode(h, cls)}`);
    await P.post(`/beitreten/${joinCode(h, cls)}`);
    // Herr Zwirbel teaches the class with Herr Lehmann (invitation link).
    await L.post(`/klassen/${cls}/einladung`, { minuten: '60' });
    assert.equal((await W.post(`/beitreten/${h.db.get("SELECT code FROM join_codes WHERE class_id = ? AND role = 'teacher'", cls).code}`)).status, 303);
    // An older entry without a subject (written before subjects existed).
    h.hub.ctx.services.audit(admin, 'konto_gesperrt', 'Marlene Zuckerbrot');
    // Through the real routes: she comments on the teacher's app (a notice naming her goes to him),
    // and she builds and submits an app with a personal name.
    const teacherApp = await h.makeApp(L, 'Lehrer-Spiel', { 'index.html': 'x' });
    await L.post(`/klassen/${cls}/apps`, { app: teacherApp.id });
    await Z.page(`/apps/${teacherApp.id}/spielen?klasse=${cls}`);
    const own = await h.makeApp(Z, 'Marlenes Spiel', { 'index.html': 'x' });
    await Z.page(`/apps/${own.id}`);
    assert.equal((await Z.post(`/apps/${own.id}/einreichen`, { klasse: cls })).status, 303);
    // The real comment route: her comment on her submitted app notifies her teacher by name.
    assert.equal((await Z.post(`/apps/${own.id}/kommentare`, { text: 'Bitte anschauen!' })).status, 303);
    assert.ok(h.db.get("SELECT 1 AS ok FROM notices WHERE user_id = ? AND kind = 'kommentar' AND text LIKE 'Marlene%'", lehmann.id), 'precondition: a notice names her');
    assert.ok(h.db.get("SELECT 1 AS ok FROM notices WHERE user_id = ? AND text LIKE '%Marlenes Spiel%'", lehmann.id), 'precondition: the teacher was told about her app');
    // Herr Zwirbel decides about her app, makes a new join code, and adds a colleague's shared app.
    assert.equal((await W.post(`/pruefen/${cls}/${own.id}/freigeben`, { version: own.published_version_id })).status, 303);
    assert.equal((await W.post(`/klassen/${cls}/code`, { minuten: '60' })).status, 303);
    const shared = await h.makeApp(L, 'Geteiltes Quiz', { 'index.html': 'x' });
    await L.post(`/apps/${shared.id}/bearbeiten`, { name: 'Geteiltes Quiz', emoji: '🎮', color: '0', shared_field: '1', shared: '1' });
    assert.equal((await W.post(`/klassen/${cls}/apps`, { app: shared.id })).status, 303);
    // Herr Lehmann sets her app as an assignment (its title is the app's name; Paul is told), writes Paul
    // feedback about it, exports the results, and sets it once more without looking at the next page.
    const assign = () => L.post(`/klassen/${cls}/aufgaben`, { app: own.id, titel: '', notiz: '' });
    const first = (await assign()).headers.location.split('/').pop();
    assert.equal((await L.post(`/klassen/${cls}/rueckmeldungen`, { schueler: paul.id, text: 'Gut gespielt.', aufgabe: first })).status, 303);
    assert.equal((await L.get(`/klassen/${cls}/apps/${own.id}/ergebnisse.csv`)).status, 200);
    assert.equal((await assign()).status, 303);
    for (const [what, sql, min] of [
      ['notices of the assignment to Paul', "SELECT COUNT(*) AS n FROM notices WHERE user_id = ? AND kind = 'aufgabe' AND text LIKE '%Marlenes Spiel%'", 2],
      ['a feedback notice to Paul', "SELECT COUNT(*) AS n FROM notices WHERE user_id = ? AND kind = 'rueckmeldung' AND text LIKE '%Marlenes Spiel%'", 1],
    ]) assert.equal(h.db.get(sql, paul.id).n, min, `precondition: ${what}`);
    assert.equal(h.db.get("SELECT COUNT(DISTINCT action) AS n FROM audit_log WHERE action IN ('aufgabe_erstellt','ergebnisse_exportiert') AND target = 'Marlenes Spiel'").n, 2, 'precondition: the assignment and the export are logged with her app');
    assert.ok(h.db.get("SELECT 1 AS ok FROM sessions WHERE user_id = ? AND data LIKE '%Marlenes Spiel%'", lehmann.id), 'precondition: a message about her app waits in his session');
    for (const col of ['class_apps.decided_by', 'class_apps.added_by', 'join_codes.created_by']) {
      const [table, c] = col.split('.');
      assert.ok(h.db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE ${c} = ?`, zwirbel.id).n, `precondition: ${col} names him`);
    }
    // Account actions about her, by the admin (role there and back, block, unblock). The last
    // message about it waits in the admin's session.
    await A.page(`/admin/konten/${ziel.id}`);
    for (const [path, fields] of [['rolle', { rolle: 'teacher' }], ['rolle', { rolle: 'student' }], ['sperren', { an: '1' }], ['sperren', {}]]) {
      assert.equal((await A.post(`/admin/nutzer/${ziel.id}/${path}`, fields)).status, 303, path);
    }
    assert.ok(allText(h.db).some((t) => t.v.includes('Marlene Zuckerbrot')), 'precondition: the name is stored');

    // First the co-teacher goes: his id stays nowhere (who decided, who made a code, who added an app).
    h.hub.ctx.services.deleteUser(admin, h.db.get('SELECT * FROM users WHERE id = ?', zwirbel.id));
    assert.deepEqual(allText(h.db).filter((t) => t.v.includes('Zwirbel') || t.v.includes(zwirbel.email) || t.v.includes(zwirbel.id)), [], 'nothing of the deleted teacher');
    assert.equal(h.db.get("SELECT COUNT(*) AS n FROM class_apps WHERE class_id = ? AND status = 'approved'", cls).n, 3, 'what he decided stays in place');

    h.hub.ctx.services.deleteUser(admin, h.db.get('SELECT * FROM users WHERE id = ?', ziel.id));
    const left = allText(h.db).filter((t) => t.v.includes('Marlene') || t.v.includes(ziel.email) || t.v.includes(ziel.id));
    // (her app's personal name is covered by the 'Marlene' check above)
    assert.deepEqual(left, [], 'no name, e-mail or id of the deleted person anywhere');
    assert.ok(h.db.get("SELECT COUNT(*) AS n FROM audit_log WHERE target = 'Gelöschtes Konto'").n >= 4, 'what happened is kept, who it was is not');
    assert.ok(h.db.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'ergebnisse_exportiert' AND target = 'Gelöschte App' AND detail = '7b'").n, 'the export is still on record');
    assert.equal(h.db.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'aufgabe_erstellt' AND target = 'Gelöschte Aufgabe'").n, 2);
    assert.match((await L.page('/start')).text, /Hallo/, 'a session whose waiting message was dropped still works');
  } finally {
    await h.stop();
  }
});

test('Archivierte Klassen: über das SDK wird nichts mehr in die Klasse geschrieben', async () => {
  const h = await startHub();
  try {
    const lehmann = h.addUser('Herr Lehmann', 'teacher');
    const L = await h.browser().login(lehmann);
    await L.post('/klassen', { name: 'Alt' });
    const cls = teacherClass(h, lehmann.id);
    const app = await h.makeApp(L, 'Spiel', { 'index.html': 'x' });
    await L.post(`/klassen/${cls}/apps`, { app: app.id });
    const t = await h.token(L, app, cls); // issued while the class was active
    h.db.run('UPDATE classes SET archived_at = ? WHERE id = ?', Date.now(), cls);
    assert.equal((await L.api(app, t.token, 'class.set', { key: 'woerter', value: ['x'] })).json().error.code, 'no_class');
    await L.api(app, t.token, 'results.add', { title: 'Runde', score: 1 });
    assert.equal(h.db.get('SELECT class_id FROM results WHERE app_id = ?', app.id).class_id, null, 'no result is filed into the archived class');
  } finally {
    await h.stop();
  }
});

test('Grenzen gelten pro Person: wer flutet, sperrt nicht die ganze Schule (gleiche Adresse)', async () => {
  const h = await startHub({ rate: { appFiles: [5, 60_000] } });
  try {
    const owner = h.addUser('Frau Yilmaz', 'teacher');
    const a = h.addUser('Mia', 'student');
    const b = h.addUser('Ben', 'student');
    const [O, A, B] = await Promise.all([owner, a, b].map((u) => h.browser().login(u)));
    const app = await h.makeApp(O, 'Für alle', { 'index.html': 'x' });
    h.db.run('UPDATE apps SET schoolwide_version_id = published_version_id WHERE id = ?', app.id);
    const fileUrl = async (br) => /src="[^"]*(\/~[^/"]+\/index\.html)"/.exec((await br.page(`/apps/${app.id}/spielen`)).text)[1];
    const mia = await fileUrl(A);
    const ben = await fileUrl(B);
    const get = (br, url) => br.raw('GET', url, { host: h.appHost(app) }).then((r) => r.status);
    for (let i = 0; i < 5; i++) assert.equal(await get(A, mia), 200);
    assert.equal(await get(A, mia), 429, 'Mia hit her own limit');
    assert.equal(await get(B, ben), 200, 'Ben, from the same address, is not affected');
  } finally {
    await h.stop();
  }
});

test('Anmeldung: wer an der Schuladresse flutet, sperrt niemanden aus', async () => {
  const h = await startHub({ studentDomains: ['schueler.schule.example'], rate: { loginAnon: [3, 60_000], loginSession: [2, 60_000], loginFailAudit: [2, 60_000] } });
  try {
    // Stand-ins for Microsoft only (the test server has no Microsoft connection): the start hands out a
    // state, and the token endpoint accepts the code "echt". Which browser may start, and when a callback
    // counts, is the real route code - and every other callback goes through the real check.
    const { auth } = h.hub.ctx;
    auth.loginUrl = async (session) => {
      session.authFlow = { state: randomUUID(), verifier: 'v' };
      return `https://login.microsoftonline.com/schule/oauth2/v2.0/authorize?state=${session.authFlow.state}`;
    };
    const realCallback = auth.handleCallback;
    auth.handleCallback = async (session, query) => {
      const flow = session.authFlow;
      if (!flow || query.code !== 'echt' || query.state !== flow.state) return realCallback(session, query);
      delete session.authFlow;
      return { oid: 'oid-mia', name: 'Mia Schmidt', email: 'mia@schueler.schule.example' };
    };
    const toMicrosoft = (res) => res.status === 302 && String(res.headers.location).startsWith('https://login.microsoftonline.com/');
    const stateOf = (res) => new URL(res.headers.location).searchParams.get('state');
    const rejected = () => h.db.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'anmeldung_abgelehnt'").n;

    // (a) Starts from browsers without a Hub session, past their limit: never refused - sent to the start page.
    const anon = [];
    for (let i = 0; i < 6; i++) anon.push(await h.browser().get('/auth/login'));
    assert.equal(anon.filter(toMicrosoft).length, 3);
    for (const r of anon.slice(3)) assert.deepEqual([r.status, r.headers.location], [302, '/?anmelden=1']);
    assert.match((await h.browser().page('/?anmelden=1')).text, /noch einmal auf/);

    // (b) Callbacks that no sign-in was started for: refused, not counted, not in the audit log.
    for (let i = 0; i < 6; i++) assert.equal((await h.browser().get('/auth/callback?code=x&state=y')).status, 400);
    assert.equal(rejected(), 0);

    // (c) Failures of sign-ins that were really started, each from its own session: logged up to the cap.
    for (let i = 0; i < 4; i++) {
      const E = h.browser();
      await E.page('/');
      assert.ok(toMicrosoft(await E.get('/auth/login')));
      assert.equal((await E.get('/auth/callback?code=x&state=falsch')).status, 403);
    }
    assert.equal(rejected(), 2, 'failures are logged - a flood of them only up to the cap');

    // After all of that, a pupil at the same address signs in normally.
    const M = h.browser();
    await M.page('/');
    const start = await M.get('/auth/login');
    assert.ok(toMicrosoft(start), 'her start is not affected by anybody else');
    const done = await M.get(`/auth/callback?code=echt&state=${stateOf(start)}`);
    assert.deepEqual([done.status, done.headers.location], [302, '/start']);
    assert.equal((await M.page('/start')).status, 200, 'signed in');
    assert.ok(h.db.get("SELECT 1 AS ok FROM users WHERE oid = 'oid-mia' AND role = 'student'"));
    assert.equal((await M.get(`/auth/callback?code=echt&state=${stateOf(start)}`)).headers.location, '/start', 'an old callback just leads home');

    // Starting is limited per browser session - for that browser only.
    const T = h.browser();
    await T.page('/');
    for (let i = 0; i < 2; i++) assert.ok(toMicrosoft(await T.get('/auth/login')));
    assert.equal((await T.get('/auth/login')).status, 429, 'one browser hit its own limit');
    const U = h.browser();
    await U.page('/');
    assert.ok(toMicrosoft(await U.get('/auth/login')), 'another browser at the same address is not affected');
  } finally {
    await h.stop();
  }
});

test('Ohne Anmeldung: eine lange Adresse bläht die gespeicherte Sitzung nicht auf', async () => {
  const h = await startHub();
  try {
    const X = h.browser();
    assert.equal((await X.get(`/klassen?${'x'.repeat(8000)}`)).status, 302);
    assert.ok(!(await X.page('/')).text.includes('danach geht es auf der Seite weiter'), 'a long address is not kept');
    // A broken form or JSON body without an account, with a long Hub address as Referer: an error page, nothing kept.
    const long = `${h.config.hubOrigin}/${'x'.repeat(8000)}`;
    const broken = await h.browser().raw('POST', '/apps', { headers: { 'content-type': 'application/json', referer: long }, body: '{kaputt' });
    assert.equal(broken.status, 400);
    const tooBig = await h.browser().raw('POST', '/apps', { headers: { 'content-type': 'application/x-www-form-urlencoded', referer: long }, body: `a=${'x'.repeat(70 * 1024)}` });
    assert.equal(tooBig.status, 413);
    // Each guard on its own: no return-to-form without an account, even from a short address ...
    const short = await h.browser().raw('POST', '/apps', { headers: { 'content-type': 'application/json', referer: `${h.config.hubOrigin}/apps` }, body: '{kaputt' });
    assert.equal(short.status, 400);
    // ... and for signed-in people only to short addresses.
    const L = await h.browser().login(h.addUser('Herr Lehmann', 'teacher'));
    assert.equal((await L.post('/apps', { name: 'x' }, { headers: { referer: long } })).status, 400);
    assert.equal((await L.post('/apps', { name: 'x' }, { headers: { referer: `${h.config.hubOrigin}/apps` } })).status, 303, 'a normal form error still returns to the form');
    const biggest = h.db.get('SELECT MAX(LENGTH(data)) AS n FROM sessions').n;
    assert.ok(biggest < 1000, `the largest stored session has ${biggest} bytes`);
    // A normal Hub link is still remembered for after the sign-in.
    const P = h.browser();
    await P.get('/klassen');
    assert.ok((await P.page('/')).text.includes('danach geht es auf der Seite weiter'));
  } finally {
    await h.stop();
  }
});

test('Beitreten: falsche Codes anderer an derselben Adresse sperren niemanden aus', async () => {
  // joinFailIp is a trap: should anyone add a per-address limit back under that name, it trips here.
  const h = await startHub({ rate: { joinFail: [2, 60_000], joinFailIp: [5, 60_000] } });
  try {
    const lehmann = h.addUser('Herr Lehmann', 'teacher');
    const L = await h.browser().login(lehmann);
    await L.post('/klassen', { name: '7b' });
    const cls = teacherClass(h, lehmann.id);
    // Five pupils at the school's address try wrong codes until each one of them is stopped.
    for (let i = 0; i < 5; i++) {
      const G = await h.browser().login(h.addUser(`Rater ${i}`, 'student'));
      for (let j = 0; j < 2; j++) assert.equal((await G.post(`/beitreten/${'A'.repeat(31)}${j}`)).status, 400);
      assert.equal((await G.post(`/beitreten/${joinCode(h, cls)}`)).status, 429, 'a guesser is stopped - even with the right code');
    }
    // A classmate at the same address joins with the real code.
    const mia = h.addUser('Mia', 'student');
    const M = await h.browser().login(mia);
    assert.equal((await M.post(`/beitreten/${joinCode(h, cls)}`)).status, 303);
    assert.ok(h.db.get("SELECT 1 AS ok FROM class_members WHERE class_id = ? AND user_id = ? AND role = 'student'", cls, mia.id));
  } finally {
    await h.stop();
  }
});

test('Einreichen lässt sich nicht als Flut gegen die Lehrkraft benutzen', async () => {
  const h = await startHub({ rate: { submit: [3, 60 * 60_000] } });
  try {
    const lehmann = h.addUser('Herr Lehmann', 'teacher');
    const mia = h.addUser('Mia', 'student');
    const [L, M] = await Promise.all([lehmann, mia].map((u) => h.browser().login(u)));
    await L.post('/klassen', { name: '7b' });
    const cls = teacherClass(h, lehmann.id);
    await M.post(`/beitreten/${joinCode(h, cls)}`);
    const app = await h.makeApp(M, 'Mias App', { 'index.html': 'x' });
    const a = h.db.get('SELECT * FROM apps WHERE id = ?', app.id);
    const c = h.db.get('SELECT * FROM classes WHERE id = ?', cls);
    const { classApps } = h.hub.ctx;
    for (let i = 0; i < 3; i++) {
      classApps.submit(mia, c, a);
      classApps.withdraw(mia, c, a);
    }
    assert.throws(() => classApps.submit(mia, c, a), /zu viele/i, 'a bounded number of submissions per hour');
    const notices = h.db.get("SELECT COUNT(*) AS n FROM notices WHERE user_id = ? AND kind = 'pruefen'", lehmann.id).n;
    assert.equal(notices, 1, 'the same unread notice is not repeated');
  } finally {
    await h.stop();
  }
});

test('Dateien aus Apps: Obergrenze pro Konto über alle Apps', async () => {
  const h = await startHub({ limits: { fileAccountBytes: 1500 } });
  try {
    const t = h.addUser('Herr Lehmann', 'teacher');
    const T = await h.browser().login(t);
    const one = await h.makeApp(T, 'Eins');
    const two = await h.makeApp(T, 'Zwei');
    const put = async (app, name, size) => {
      const tok = await h.token(T, app);
      return T.raw('PUT', `/_hub/files/${name}`, { host: h.appHost(app), headers: { authorization: `Bearer ${tok.token}`, 'content-type': 'text/plain' }, body: 'x'.repeat(size) }).then((r) => r.json());
    };
    assert.equal((await put(one, 'a', 1000)).ok, true);
    const refused = await put(two, 'b', 1000);
    assert.equal(refused.error.code, 'quota', 'the second app cannot exceed the account cap');
    assert.equal((await put(one, 'a', 1200)).ok, true, 'replacing a file counts only once');
  } finally {
    await h.stop();
  }
});

test('Persönliche Seiten werden im Browser nicht gespeichert (geteilte Schul-PCs)', async () => {
  const h = await startHub();
  try {
    const m = h.addUser('Mia', 'student');
    const M = await h.browser().login(m);
    for (const url of ['/start', '/meine-daten', '/mitteilungen']) assert.equal((await M.get(url)).headers['cache-control'], 'no-store', url);
    assert.notEqual((await M.get('/static/hub.css')).headers['cache-control'], 'no-store', 'static files may be cached');
  } finally {
    await h.stop();
  }
});

test('Aufgaben zählen nur Ergebnisse aus ihrer Klasse; Bestenlisten ignorieren archivierte Klassen', async () => {
  const h = await startHub();
  try {
    const lehmann = h.addUser('Herr Lehmann', 'teacher');
    const kaya = h.addUser('Herr Kaya', 'teacher');
    const ben = h.addUser('Ben', 'student');
    const mia = h.addUser('Mia', 'student');
    const [L, K, B, M] = await Promise.all([lehmann, kaya, ben, mia].map((u) => h.browser().login(u)));
    await L.post('/klassen', { name: '7b' });
    const cls7b = teacherClass(h, lehmann.id);
    await K.post('/klassen', { name: 'AG' });
    const clsAg = teacherClass(h, kaya.id);
    for (const br of [B, M]) await br.post(`/beitreten/${joinCode(h, cls7b)}`);
    await B.post(`/beitreten/${joinCode(h, clsAg)}`);
    const game = await h.makeApp(L, 'Spiel', { 'index.html': 'x' });
    await L.post(`/klassen/${cls7b}/apps`, { app: game.id });
    await K.post(`/klassen/${clsAg}/apps`, { app: game.id }).catch(() => {});
    h.db.run("INSERT OR REPLACE INTO class_apps (class_id, app_id, status, version_id, created_at) VALUES (?, ?, 'approved', ?, ?)", clsAg, game.id, game.published_version_id, Date.now());
    const now = Date.now();
    h.db.run('INSERT INTO assignments (id, class_id, app_id, title, starts_at, created_at) VALUES (?, ?, ?, ?, ?, ?)', 'asg', cls7b, game.id, 'Üben', now - 1000, now - 1000);
    // Ben plays in the AG, not in 7b: the 7b assignment stays open.
    const agTok = await h.token(B, game, clsAg);
    await B.api(game, agTok.token, 'results.add', { title: 'AG-Runde', score: 3 });
    const { assignments } = h.hub.ctx;
    assert.equal(assignments.stateOf({ id: 'asg' }, ben.id), 'started');
    const tok7b = await h.token(B, game, cls7b);
    await B.api(game, tok7b.token, 'results.add', { title: '7b-Runde', score: 3 });
    assert.equal(assignments.stateOf({ id: 'asg' }, ben.id), 'done');

    // Leaderboards: classmates see names - but an archived class no longer counts as shared.
    const mt = await h.token(M, game, cls7b);
    await M.api(game, mt.token, 'scores.submit', { board: 'p', score: 5 });
    const names = async () => (await B.api(game, agTok.token, 'scores.top', { board: 'p', scope: 'all' })).json().result.entries.map((e) => e.name);
    assert.deepEqual(await names(), ['Mia'], 'Ben shares 7b with Mia');
    h.db.run('UPDATE classes SET archived_at = ? WHERE id = ?', Date.now(), cls7b);
    assert.deepEqual(await names(), ['Anonym'], 'after archiving, 7b no longer counts');
  } finally {
    await h.stop();
  }
});

test('Wiederherstellung: das Referenz-Schema jeder Version entsteht genau wie bei einem echten Upgrade', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { openDb, schemaForVersion, SCHEMA_VERSION } = require('../src/db');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schulhub-schema-'));
  try {
    const sort = (rows) => rows.map((r) => `${r.type}|${r.name}|${r.sql}`).sort();
    for (let v = 1; v <= SCHEMA_VERSION; v++) assert.ok(schemaForVersion(v, path.join(dir, `v${v}.sqlite`)).length > 10, `version ${v}`);
    const real = openDb(path.join(dir, 'real.sqlite'));
    const viaUpgrade = real.all('SELECT type, name, tbl_name, sql FROM sqlite_master');
    real.close();
    assert.deepEqual(sort(schemaForVersion(SCHEMA_VERSION, path.join(dir, 'ref.sqlite'))), sort(viaUpgrade));
    assert.throws(() => schemaForVersion(SCHEMA_VERSION + 1, path.join(dir, 'x.sqlite')), /unknown schema version/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Mitteilung öffnen: nur die eigene, nur per POST mit CSRF; Favorit ohne Inhalt stürzt nicht ab', async () => {
  const h = await startHub();
  try {
    const mia = h.addUser('Mia', 'student');
    const ben = h.addUser('Ben', 'student');
    const t = h.addUser('Frau Yilmaz', 'teacher');
    const [M, B, T] = await Promise.all([mia, ben, t].map((u) => h.browser().login(u)));
    h.hub.ctx.services.notify([ben.id], 'aufgabe', 'Für Ben', '/start');
    const id = h.db.get('SELECT id FROM notices WHERE user_id = ?', ben.id).id;
    await M.page('/start');
    assert.equal((await M.post(`/mitteilungen/${id}/oeffnen`)).status, 404, "Mia cannot open Ben's notice");
    assert.equal(h.db.get('SELECT read_at FROM notices WHERE id = ?', id).read_at, null, 'and it stays unread');
    assert.equal((await B.post(`/mitteilungen/${id}/oeffnen`, {}, { withCsrf: false })).status, 403);
    await B.page('/start');
    const opened = await B.post(`/mitteilungen/${id}/oeffnen`);
    assert.equal(opened.status, 303);
    assert.equal(opened.headers.location, '/start');
    assert.ok(h.db.get('SELECT read_at FROM notices WHERE id = ?', id).read_at);
    // favourite: a hand-made POST with the CSRF header but no body
    const app = await h.makeApp(T, 'Für alle', { 'index.html': 'x' });
    h.db.run('UPDATE apps SET schoolwide_version_id = published_version_id WHERE id = ?', app.id);
    await M.page('/start');
    const res = await M.raw('POST', `/apps/${app.id}/favorit`, { headers: { 'x-csrf-token': /<meta name="csrf" content="([^"]*)"/.exec((await M.page('/start')).text)[1] } });
    assert.notEqual(res.status, 500);
  } finally {
    await h.stop();
  }
});

test('Gefälschte Datei-Links blockieren nur sich selbst – echte App-Dateien laden weiter', async () => {
  const h = await startHub({ rate: { appFilesBad: [5, 60_000] } });
  try {
    const owner = h.addUser('Frau Yilmaz', 'teacher');
    const ben = h.addUser('Ben', 'student');
    const [O, B] = await Promise.all([owner, ben].map((u) => h.browser().login(u)));
    const app = await h.makeApp(O, 'Für alle', { 'index.html': 'x' });
    h.db.run('UPDATE apps SET schoolwide_version_id = published_version_id WHERE id = ?', app.id);
    for (let i = 0; i < 6; i++) await B.raw('GET', `/~falsch${i}/index.html`, { host: h.appHost(app) });
    assert.equal((await B.raw('GET', '/~falsch/index.html', { host: h.appHost(app) })).status, 429, 'fake links are slowed down');
    const url = /src="[^"]*(\/~[^/"]+\/index\.html)"/.exec((await B.page(`/apps/${app.id}/spielen`)).text)[1];
    assert.equal((await B.raw('GET', url, { host: h.appHost(app) })).status, 200, 'a real link from the same address still loads');
  } finally {
    await h.stop();
  }
});

test('Veröffentlichen hin und her flutet die Prüf-Geschichte nicht', async () => {
  const h = await startHub({ rate: { publish: [4, 60 * 60_000] } });
  try {
    const lehmann = h.addUser('Herr Lehmann', 'teacher');
    const mia = h.addUser('Mia', 'student');
    const [L, M] = await Promise.all([lehmann, mia].map((u) => h.browser().login(u)));
    await L.post('/klassen', { name: '7b' });
    const cls = teacherClass(h, lehmann.id);
    await M.post(`/beitreten/${joinCode(h, cls)}`);
    const app = await h.makeApp(M, 'Mias App', { 'index.html': 'v1' }); // publish #1
    await M.page(`/apps/${app.id}`);
    await M.post(`/apps/${app.id}/einreichen`, { klasse: cls });
    const v2 = await h.uploadFolder(M, app.id, { 'index.html': 'v2' });
    const before = () => h.db.get("SELECT COUNT(*) AS n FROM comments WHERE app_id = ? AND kind = 'submitted'", app.id).n;
    assert.equal((await M.post(`/apps/${app.id}/veroeffentlichen`, { version: v2 })).status, 303); // #2: v2 now waits
    const n = before();
    assert.equal((await M.post(`/apps/${app.id}/veroeffentlichen`, { version: v2 })).status, 303); // #3: same version again
    assert.equal(before(), n, 'the same waiting version adds no history row');
    await M.post(`/apps/${app.id}/veroeffentlichen`, { version: app.published_version_id }); // #4
    assert.equal((await M.post(`/apps/${app.id}/veroeffentlichen`, { version: v2 })).status, 429, 'bounded per hour'); // #5
  } finally {
    await h.stop();
  }
});

test('Konto löschen: Mitteilungen anderer, die die Person nennen, verschwinden (auch über fremde Apps)', async () => {
  const h = await startHub();
  try {
    const admin = h.addUser('Anna Adler', 'admin');
    const lehrer = h.addUser('Herr Quastenflosser', 'teacher');
    const mia = h.addUser('Mia', 'student');
    const [L, M] = await Promise.all([lehrer, mia].map((u) => h.browser().login(u)));
    await L.post('/klassen', { name: '7b' });
    const cls = teacherClass(h, lehrer.id);
    await M.post(`/beitreten/${joinCode(h, cls)}`);
    const app = await h.makeApp(M, 'Mias App', { 'index.html': 'x' });
    await M.page(`/apps/${app.id}`);
    await M.post(`/apps/${app.id}/einreichen`, { klasse: cls });
    // Every route that tells her something about him, each checked on its own: his notices name him and
    // point to HER (surviving) app or page. The same unread text is kept only once, so she reads each
    // notice before the next one arrives.
    const naming = () => h.db.get("SELECT COUNT(*) AS n FROM notices WHERE user_id = ? AND text LIKE '%Quastenflosser%'", mia.id).n;
    const steps = [
      ['comment at the review workbench', `/pruefen/${cls}/${app.id}`, `/pruefen/${cls}/${app.id}/kommentar`, { text: 'Schön!' }],
      ['comment on the app page', `/apps/${app.id}`, `/apps/${app.id}/kommentare`, { text: 'Noch schöner!' }],
      ['feedback', `/klassen/${cls}`, `/klassen/${cls}/rueckmeldungen`, { schueler: mia.id, text: 'Gut gemacht.' }],
    ];
    for (const [label, pageUrl, url, fields] of steps) {
      const before = naming();
      await L.page(pageUrl);
      assert.equal((await L.post(url, fields)).status, 303, label);
      assert.equal(naming(), before + 1, `precondition: the ${label} names him`);
      await M.page('/mitteilungen');
      assert.equal((await M.post('/mitteilungen/gelesen')).status, 303);
    }
    h.hub.ctx.services.deleteUser(admin, h.db.get('SELECT * FROM users WHERE id = ?', lehrer.id));
    assert.equal(h.db.get("SELECT COUNT(*) AS n FROM notices WHERE text LIKE '%Quastenflosser%'").n, 0, 'every notice naming him is gone');
  } finally {
    await h.stop();
  }
});

test('Konto löschen: gleichnamige Apps und Klassen anderer behalten ihre Einträge im Protokoll', async () => {
  const h = await startHub();
  try {
    const admin = h.addUser('Anna Adler', 'admin');
    const lehrer = h.addUser('Herr Lehmann', 'teacher');
    const schueler = h.addUser('Paul', 'student');
    const [L, S] = await Promise.all([lehrer, schueler].map((u) => h.browser().login(u)));
    await L.post('/klassen', { name: 'Klasse B' });
    const cls = teacherClass(h, lehrer.id);
    const own = await h.makeApp(L, 'Vokabeltest', { 'index.html': 'x' });
    await L.post(`/klassen/${cls}/apps`, { app: own.id });
    const teacherRows = () => h.db.all('SELECT action, target, detail FROM audit_log WHERE actor_id = ? ORDER BY rowid', lehrer.id);
    const before = teacherRows();
    assert.ok(before.some((r) => r.target === 'Vokabeltest') && before.some((r) => r.target === 'Klasse B' || r.detail === 'Klasse B'), 'precondition');
    // The pupil names his own apps exactly like the teacher's app and class - then his account is deleted.
    for (const name of ['Vokabeltest', 'Klasse B']) await h.makeApp(S, name, { 'index.html': 'x' });
    h.hub.ctx.services.deleteUser(admin, h.db.get('SELECT * FROM users WHERE id = ?', schueler.id));
    assert.deepEqual(teacherRows(), before, "the teacher's own entries stay exactly as they were");
    assert.equal(
      h.db.get("SELECT COUNT(*) AS n FROM audit_log WHERE actor_label = 'Gelöschtes Konto' AND (target IN ('Vokabeltest', 'Klasse B') OR detail IN ('Vokabeltest', 'Klasse B'))").n,
      0, "the pupil's own entries lost his app names"
    );
  } finally {
    await h.stop();
  }
});

test('Konto löschen: eine lange Vorgeschichte hält den Hub nicht auf', async () => {
  const h = await startHub();
  try {
    const admin = h.addUser('Anna Adler', 'admin');
    const schueler = h.addUser('Paul', 'student');
    // 3000 apps, each with its own name, created and deleted before - as his own entries record them.
    const ins = 'INSERT INTO audit_log (at, actor_id, actor_label, action, target, detail, app_id) VALUES (?, ?, ?, ?, ?, ?, ?)';
    h.db.tx(() => {
      for (let i = 0; i < 3000; i++) {
        const id = `alt${String(i).padStart(13, '0')}`;
        h.db.run(ins, Date.now(), schueler.id, 'Paul (student)', 'app_erstellt', `Alte App ${i}`, '', id);
        h.db.run(ins, Date.now(), schueler.id, 'Paul (student)', 'app_geloescht', `Alte App ${i}`, '', id);
      }
    });
    const started = Date.now();
    h.hub.ctx.services.deleteUser(admin, h.db.get('SELECT * FROM users WHERE id = ?', schueler.id));
    const ms = Date.now() - started;
    assert.ok(ms < 1500, `deleting the account took ${ms} ms - the Hub serves nobody meanwhile`);
    assert.equal(h.db.get("SELECT COUNT(*) AS n FROM audit_log WHERE target LIKE 'Alte App %'").n, 0, 'every old name is gone');
  } finally {
    await h.stop();
  }
});

test('Konto löschen: auch Namen, die eine App nur zwischendurch hatte, verschwinden', async () => {
  const h = await startHub();
  try {
    const admin = h.addUser('Anna Adler', 'admin');
    const marlene = h.addUser('Marlene', 'student');
    const M = await h.browser().login(marlene);
    const app = await h.makeApp(M, 'Neue App', { 'index.html': 'x' });
    await M.page(`/apps/${app.id}`);
    const rename = async (name) => assert.equal((await M.post(`/apps/${app.id}/bearbeiten`, { name, emoji: '🎮', color: '0' })).status, 303);
    await rename('Marlenes Geheimnis');
    // Under that name a new version is uploaded and published.
    const v = await h.uploadFolder(M, app.id, { 'index.html': 'y' });
    assert.equal((await M.post(`/apps/${app.id}/veroeffentlichen`, { version: v })).status, 303);
    await rename('Spiel');
    await M.page('/apps');
    assert.equal((await M.post(`/apps/${app.id}/loeschen`)).status, 303);
    assert.ok(h.db.get("SELECT 1 AS ok FROM audit_log WHERE target = 'Marlenes Geheimnis'"), 'precondition: the log knew the name in between');
    h.hub.ctx.services.deleteUser(admin, h.db.get('SELECT * FROM users WHERE id = ?', marlene.id));
    const left = allText(h.db).filter((t) => t.v.includes('Marlene'));
    assert.deepEqual(left, [], 'no name the app ever had, and not hers either');
  } finally {
    await h.stop();
  }
});

test('App löschen: Mitteilungen anderer zu dieser App verschwinden mit ihr', async () => {
  const h = await startHub();
  try {
    const lehrer = h.addUser('Herr Lehmann', 'teacher');
    const mia = h.addUser('Mia', 'student');
    const [L, M] = await Promise.all([lehrer, mia].map((u) => h.browser().login(u)));
    await L.post('/klassen', { name: '7b' });
    const cls = teacherClass(h, lehrer.id);
    await M.post(`/beitreten/${joinCode(h, cls)}`);
    const app = await h.makeApp(M, 'Mias Rätsel', { 'index.html': 'x' });
    await M.page(`/apps/${app.id}`);
    assert.equal((await M.post(`/apps/${app.id}/einreichen`, { klasse: cls })).status, 303);
    const aboutApp = () => h.db.get("SELECT COUNT(*) AS n FROM notices WHERE user_id = ? AND (instr(href, ?) > 0 OR text LIKE '%Mias Rätsel%')", lehrer.id, app.id).n;
    assert.ok(aboutApp() > 0, 'precondition: the teacher was told about the submission');
    await M.page('/apps');
    assert.equal((await M.post(`/apps/${app.id}/loeschen`)).status, 303);
    assert.equal(aboutApp(), 0, 'the notice about the deleted app is gone with it');
  } finally {
    await h.stop();
  }
});

/** A class 7b with Herr Lehmann, Marlene and Ben; Marlene's app approved there through the real submission. */
async function classWithApprovedPupilApp(h) {
  const lehrer = h.addUser('Herr Lehmann', 'teacher');
  const marlene = h.addUser('Marlene', 'student');
  const ben = h.addUser('Ben', 'student');
  const [L, M, B] = await Promise.all([lehrer, marlene, ben].map((u) => h.browser().login(u)));
  await L.post('/klassen', { name: '7b' });
  const cls = teacherClass(h, lehrer.id);
  for (const P of [M, B]) await P.post(`/beitreten/${joinCode(h, cls)}`);
  const app = await h.makeApp(M, 'Marlenes Spiel', { 'index.html': 'x' });
  await M.page(`/apps/${app.id}`);
  assert.equal((await M.post(`/apps/${app.id}/einreichen`, { klasse: cls })).status, 303);
  const row = h.db.get('SELECT requested_version_id AS v FROM class_apps WHERE class_id = ? AND app_id = ?', cls, app.id);
  h.hub.ctx.classApps.approve(lehrer, h.db.get('SELECT * FROM classes WHERE id = ?', cls), h.db.get('SELECT * FROM apps WHERE id = ?', app.id), row.v);
  return { lehrer, marlene, ben, L, M, B, cls, app };
}

test('Konto löschen: Einträge anderer über ihre Apps heißen „Gelöschte App“ und behalten ihre Angaben – ihre eigenen verlieren sie, auch alte', async () => {
  const h = await startHub();
  try {
    const admin = h.addUser('Anna Adler', 'admin');
    const { lehrer, marlene } = await classWithApprovedPupilApp(h);
    // An entry written before entries carried their app (schema version < 4), by her.
    h.db.run("INSERT INTO audit_log (at, actor_id, actor_label, action, target, detail) VALUES (?, ?, 'Marlene (student)', 'app_erstellt', 'Marlenes altes Spiel', '')", Date.now(), marlene.id);
    h.hub.ctx.services.deleteUser(admin, h.db.get('SELECT * FROM users WHERE id = ?', marlene.id));
    const approval = h.db.get("SELECT target, detail FROM audit_log WHERE actor_id = ? AND action = 'app_freigegeben'", lehrer.id);
    assert.equal(approval.target, 'Gelöschte App', "the teacher's approval no longer names her app");
    assert.match(approval.detail, /7b/, '... but keeps where it happened');
    const own = h.db.get("SELECT target, detail FROM audit_log WHERE action = 'app_eingereicht'");
    assert.deepEqual([own.target, own.detail], ['Gelöschte App', ''], 'her own entry keeps neither the name nor the detail');
    assert.equal(h.db.get("SELECT COUNT(*) AS n FROM audit_log WHERE target LIKE '%Marlene%' OR detail LIKE '%Marlene%'").n, 0, 'old entries included');
  } finally {
    await h.stop();
  }
});

test('App löschen: Rückmeldungen, die die App nennen, verschwinden aus den Mitteilungen der Mitschüler/innen', async () => {
  const h = await startHub();
  try {
    const { ben, L, M, cls, app } = await classWithApprovedPupilApp(h);
    await L.page(`/klassen/${cls}`);
    assert.equal((await L.post(`/klassen/${cls}/rueckmeldungen`, { schueler: ben.id, text: 'Schau dir das Spiel an.', app: app.id })).status, 303);
    const quoting = () => h.db.get("SELECT COUNT(*) AS n FROM notices WHERE user_id = ? AND text LIKE '%Marlenes Spiel%'", ben.id).n;
    assert.equal(quoting(), 1, 'precondition: his notice quotes her app');
    await M.page('/apps');
    assert.equal((await M.post(`/apps/${app.id}/loeschen`)).status, 303);
    assert.equal(quoting(), 0, 'the notice that quoted the deleted app is gone');
  } finally {
    await h.stop();
  }
});
