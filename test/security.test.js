'use strict';
// Tests that try to BREAK the rules. Each test plays an attacker:
// a curious student, a teacher poking at another class, a hostile app,
// or an outsider without an account.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startHub, makeZip } = require('./helpers');

let h;
let admin, teacher, teacher2, mia, ben, outsider; // accounts
let T, T2, M, B, O, A; // their browsers
let cls; // teacher's class with mia + ben
let teacherApp, miaApp;

const classOf = (userId) => h.db.get("SELECT class_id AS id FROM class_members WHERE user_id = ? AND role = 'teacher'", userId).id;
const joinCode = (classId) => h.db.get("SELECT code FROM join_codes WHERE class_id = ? AND role = 'student'", classId).code;

before(async () => {
  h = await startHub({ limits: { maxFileBytes: 200 * 1024, maxVersionBytes: 400 * 1024, maxFiles: 20 } });
  admin = h.addUser('Admin Adler', 'admin');
  teacher = h.addUser('Herr Lehmann', 'teacher');
  teacher2 = h.addUser('Frau Yilmaz', 'teacher');
  mia = h.addUser('Mia', 'student');
  ben = h.addUser('Ben', 'student');
  outsider = h.addUser('Olaf Fremd', 'student');
  [A, T, T2, M, B, O] = await Promise.all([admin, teacher, teacher2, mia, ben, outsider].map((u) => h.browser().login(u)));

  await T.post('/klassen', { name: '7b' });
  cls = classOf(teacher.id);
  for (const b of [M, B]) await b.post(`/beitreten/${joinCode(cls)}`);
  await T2.post('/klassen', { name: '9a' });

  teacherApp = await h.makeApp(T, 'Lehrer-App', { 'index.html': '<h1>Lehrer</h1>', 'js/app.js': 'console.log(1)' });
  await T.post(`/klassen/${cls}/apps`, { app: teacherApp.id });
  miaApp = await h.makeApp(M, 'Mias App', { 'index.html': '<h1>Mia v1</h1>' });
});
after(() => h.stop());

// ---------------------------------------------------------------- outsiders

test('ohne Anmeldung ist nichts erreichbar', async () => {
  const anon = h.browser();
  for (const url of ['/start', '/klassen', `/klassen/${cls}`, '/apps', `/apps/${teacherApp.id}`, '/admin', '/meine-daten', '/meine-daten/export', `/klassen/${cls}/apps/${teacherApp.id}/ergebnisse`]) {
    const res = await anon.get(url);
    assert.equal(res.status, 302, url);
    assert.equal(res.headers.location, '/');
  }
  await anon.page('/');
  assert.equal((await anon.post('/klassen', { name: 'x' })).status, 401);
  assert.equal((await anon.send('POST', `/apps/${teacherApp.id}/token`, {})).status, 401);
  assert.equal((await anon.api(teacherApp, null, 'save.get', { key: 'a' })).status, 401);
});

test('unbekannte Host-Namen werden abgewiesen', async () => {
  assert.equal((await h.browser().get('/', { host: 'evil.example' })).status, 400);
  assert.equal((await h.browser().get('/', { host: `nichtda${h.config.appsHostSuffix}` })).status, 404);
});

test('Sitzung: neue ID beim Anmelden, HttpOnly + SameSite, komplette Abmeldung', async () => {
  const b = h.browser();
  const first = await b.page('/');
  const cookie = first.headers['set-cookie'][0];
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  const before = b.jar.get('hub_sid');
  await b.login(h.addUser('Sitzungstest', 'student'));
  assert.notEqual(b.jar.get('hub_sid'), before, 'session id must change at login');
  const stolen = b.jar.get('hub_sid');
  assert.equal((await b.post('/auth/logout')).status, 303);
  // the old cookie is worthless after logout
  const thief = h.browser();
  thief.jar.set('hub_sid', stolen);
  assert.equal((await thief.get('/start')).status, 302);
});

test('CSRF: Änderungen ohne Token oder von fremder Herkunft werden abgelehnt', async () => {
  assert.equal((await T.post('/klassen', { name: 'CSRF' }, { withCsrf: false })).status, 403);
  assert.equal((await T.post('/klassen', { name: 'CSRF', _csrf: 'falsch' }, { withCsrf: false })).status, 403);
  assert.equal((await T.post('/klassen', { name: 'CSRF' }, { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal(h.db.get("SELECT COUNT(*) AS n FROM classes WHERE name = 'CSRF'").n, 0);
});

// ---------------------------------------------------- student acting as teacher / admin

test('Schüler kann keine Klasse anlegen und nichts in fremden Klassen', async () => {
  assert.equal((await M.post('/klassen', { name: 'Hack' })).status, 404);
  const other = classOf(teacher2.id);
  assert.equal((await M.get(`/klassen/${other}`)).status, 404);
  // in the own class: member, but not manager
  assert.equal((await M.get(`/klassen/${cls}`)).status, 200);
  for (const url of [`/klassen/${cls}/code`, `/klassen/${cls}/umbenennen`, `/klassen/${cls}/loeschen`, `/klassen/${cls}/mitglieder/${ben.id}/entfernen`, `/klassen/${cls}/apps/${teacherApp.id}/freigeben`]) {
    assert.equal((await M.post(url, { name: 'x', version: 'x' })).status, 404, url);
  }
  assert.equal((await M.get(`/klassen/${cls}/qr`)).status, 404);
  assert.ok(!(await M.get(`/klassen/${cls}`)).text.includes(joinCode(cls)), 'students must not see the join code');
  assert.ok(h.db.get('SELECT 1 AS x FROM class_members WHERE class_id = ? AND user_id = ?', cls, ben.id));
});

test('Rolle kommt nur aus der Datenbank: mitgeschickte Rollen werden ignoriert', async () => {
  const b = await h.browser().login(h.addUser('Rollentest', 'student'));
  const me = h.db.get("SELECT id FROM users WHERE name = 'Rollentest'").id;
  await b.post(`/beitreten/${joinCode(cls)}`, { role: 'teacher', rolle: 'teacher', isTeacher: '1' });
  assert.equal(h.db.get('SELECT role FROM class_members WHERE class_id = ? AND user_id = ?', cls, me).role, 'student');
  await b.post('/meine-daten/anonym', { anonym: '1', role: 'admin', rolle: 'admin' });
  assert.equal(h.db.get('SELECT role FROM users WHERE id = ?', me).role, 'student');
  // admin area and admin actions do not exist for non-admins
  for (const who of [b, M, T]) {
    assert.equal((await who.get('/admin')).status, 404);
    assert.equal((await who.get('/admin/protokoll')).status, 404);
    assert.equal((await who.post(`/admin/nutzer/${me}/rolle`, { rolle: 'admin' })).status, 404);
    assert.equal((await who.post(`/apps/${teacherApp.id}/schulweit`, { an: '1', version: h.db.get('SELECT published_version_id AS v FROM apps WHERE id = ?', teacherApp.id).v })).status, 404);
  }
  assert.equal(h.db.get('SELECT role FROM users WHERE id = ?', me).role, 'student');
});

test('Beitrittscodes: auch eine Lehrkraft wird nur Schüler/in; falsche und abgelaufene Codes scheitern; Raten wird gebremst', async () => {
  await T2.post(`/beitreten/${joinCode(cls)}`);
  assert.equal(h.db.get('SELECT role FROM class_members WHERE class_id = ? AND user_id = ?', cls, teacher2.id).role, 'student');
  assert.equal((await T2.get(`/klassen/${cls}/qr`)).status, 404);
  await T.post(`/klassen/${cls}/mitglieder/${teacher2.id}/entfernen`);

  const guesser = await h.browser().login(h.addUser('Rater', 'student'));
  h.db.run('INSERT INTO join_codes (code, class_id, created_at, expires_at) VALUES (?, ?, ?, ?)', 'x'.repeat(32), classOf(teacher2.id), 1, Date.now() - 1000);
  assert.equal((await guesser.post(`/beitreten/${'x'.repeat(32)}`)).status, 400, 'expired code');
  let last;
  for (let i = 0; i < 12; i++) last = await guesser.post(`/beitreten/${'A'.repeat(31)}${i % 10}`);
  assert.equal(last.status, 429);
  // even the right code is refused while blocked
  assert.equal((await guesser.post(`/beitreten/${joinCode(cls)}`)).status, 429);
  assert.equal(h.db.get("SELECT COUNT(*) AS n FROM class_members m JOIN users u ON u.id = m.user_id WHERE u.name = 'Rater'").n, 0);
});

// ------------------------------------------------- reading other people's data

test('Schüler und fremde Lehrkräfte kommen nicht an Ergebnisse anderer', async () => {
  const t = await h.token(B, teacherApp, cls);
  await B.api(teacherApp, t.token, 'save.set', { key: 'geheim', value: 'Bens Spielstand' });
  await B.api(teacherApp, t.token, 'results.add', { title: 'Bens Ergebnis', score: 3, maxScore: 5 });

  const base = `/klassen/${cls}/apps/${teacherApp.id}/ergebnisse`;
  // the class teacher sees it
  assert.match((await T.get(`${base}/${ben.id}`)).text, /Bens Spielstand/);
  // a classmate, a stranger and a teacher of another class do not
  for (const who of [M, O, T2]) {
    for (const url of [base, `${base}.csv`, `${base}/${ben.id}`]) assert.equal((await who.get(url)).status, 404, url);
    assert.equal((await who.post(`${base}/${ben.id}/loeschen`)).status, 404);
  }
  // a teacher cannot use THEIR class to read a student who is not in it
  const other = classOf(teacher2.id);
  assert.equal((await T2.get(`/klassen/${other}/apps/${teacherApp.id}/ergebnisse/${ben.id}`)).status, 404);
  // "Meine Daten" only ever shows the own rows
  assert.ok(!(await M.get(`/meine-daten/app/${teacherApp.id}`)).text.includes('Bens Spielstand'));
  assert.ok(!(await M.get('/meine-daten/export')).text.includes('Bens Spielstand'));
});

test('Wem eine App gehört, der sieht trotzdem keine Daten anderer darin', async () => {
  // Mia's app is approved for the class, Ben plays it. Mia owns it but is not a teacher.
  await M.post(`/klassen/${cls}/apps`, { app: miaApp.id });
  const pending = h.db.get('SELECT * FROM class_apps WHERE class_id = ? AND app_id = ?', cls, miaApp.id);
  await T.post(`/klassen/${cls}/apps/${miaApp.id}/freigeben`, { version: pending.requested_version_id });
  const t = await h.token(B, miaApp, cls);
  await B.api(miaApp, t.token, 'save.set', { key: 'k', value: 'nur fuer Ben' });
  assert.equal((await M.get(`/klassen/${cls}/apps/${miaApp.id}/ergebnisse/${ben.id}`)).status, 404);
  const mt = await h.token(M, miaApp, cls);
  assert.equal((await M.api(miaApp, mt.token, 'save.get', { key: 'k' })).json().result, null);
  assert.deepEqual((await M.api(miaApp, mt.token, 'save.keys')).json().result, []);
});

test('fremde Apps: weder ansehen noch ändern, hochladen, veröffentlichen oder löschen', async () => {
  const v = miaApp.published_version_id;
  for (const who of [O, T2]) {
    for (const url of [`/apps/${miaApp.id}`, `/apps/${miaApp.id}/spielen`, `/apps/${miaApp.id}/spielen?version=${v}`, `/apps/${miaApp.id}/versionen/${v}/quelltext`, `/apps/${miaApp.id}/versionen/${v}/download`]) {
      assert.equal((await who.get(url)).status, 404, url);
    }
    for (const url of [`/apps/${miaApp.id}/bearbeiten`, `/apps/${miaApp.id}/loeschen`, `/apps/${miaApp.id}/veroeffentlichen`, `/apps/${miaApp.id}/kommentare`, `/apps/${miaApp.id}/versionen/${v}/loeschen`]) {
      assert.equal((await who.post(url, { name: 'Gekapert', version: v, text: 'hi' })).status, 404, url);
    }
    assert.equal((await who.send('POST', `/apps/${miaApp.id}/versionen`)).status, 404);
    assert.equal((await who.send('POST', `/apps/${miaApp.id}/token`, { version: v })).status, 404);
  }
  // Ben may play the approved app, but not manage or inspect it
  assert.equal((await B.get(`/apps/${miaApp.id}/spielen?klasse=${cls}`)).status, 200);
  assert.equal((await B.get(`/apps/${miaApp.id}/versionen/${v}/quelltext`)).status, 404);
  assert.equal((await B.post(`/apps/${miaApp.id}/loeschen`)).status, 404);
  assert.equal(h.db.get('SELECT name FROM apps WHERE id = ?', miaApp.id).name, 'Mias App');
});

// ------------------------------------------------------------ app isolation

test('App-Isolation: Token gilt nur für diese App, diese Person, diese Sitzung', async () => {
  const t = await h.token(B, teacherApp, cls);
  assert.equal((await B.api(teacherApp, t.token, 'save.set', { key: 'x', value: 42 })).json().ok, true);

  // the same token on another app's origin is worthless
  const wrongHost = await B.api(miaApp, t.token, 'save.get', { key: 'x' });
  assert.equal(wrongHost.status, 401);
  // another app (with its own valid token) cannot see the first app's data
  const t2 = await h.token(B, miaApp, cls);
  assert.equal((await B.api(miaApp, t2.token, 'save.get', { key: 'x' })).json().result, null);
  // tampered and wrong-kind tokens
  const [body, sig] = t.token.split('.');
  const payload = JSON.parse(Buffer.from(body, 'base64url'));
  const forged = Buffer.from(JSON.stringify({ ...payload, u: mia.id })).toString('base64url');
  assert.equal((await B.api(teacherApp, `${forged}.${sig}`, 'save.get', { key: 'x' })).status, 401);
  const fileToken = /src="[^"]*\/~([^/"]+)\//.exec((await B.get(`/apps/${teacherApp.id}/spielen?klasse=${cls}`)).text)[1];
  assert.equal((await B.api(teacherApp, fileToken, 'save.get', { key: 'x' })).status, 401);
  // a foreign web page cannot call the API cross-origin
  const cross = await B.raw('POST', '/_hub/api', { host: h.appHost(teacherApp), headers: { 'content-type': 'application/json', authorization: `Bearer ${t.token}`, origin: 'https://evil.example' }, body: '{"method":"save.keys"}' });
  assert.equal(cross.status, 403);
  assert.equal(cross.headers['access-control-allow-origin'], undefined);

  // token dies with the session
  const temp = await h.browser().login(h.addUser('Kurzbesuch', 'student'));
  await temp.post(`/beitreten/${joinCode(cls)}`);
  const tt = await h.token(temp, teacherApp, cls);
  assert.equal((await temp.api(teacherApp, tt.token, 'save.keys')).status, 200);
  await temp.post('/auth/logout');
  assert.equal((await temp.api(teacherApp, tt.token, 'save.keys')).status, 401);
});

test('App-Dateien: eigener Ursprung, strenge Header, nie vom Hub selbst, nie als eigene Seite', async () => {
  const page = await B.get(`/apps/${teacherApp.id}/spielen?klasse=${cls}`);
  const src = /<iframe[^>]* src="([^"]+)"/.exec(page.text)[1];
  assert.match(page.text, /sandbox="allow-scripts allow-same-origin[^"]*"/);
  const url = new URL(src);
  assert.equal(url.host, h.appHost(teacherApp));
  assert.notEqual(url.host, h.config.hubHost);

  const file = await B.get(url.pathname, { host: url.host, headers: { 'sec-fetch-dest': 'iframe' } });
  assert.equal(file.status, 200);
  assert.match(file.text, /Lehrer/);
  assert.equal(file.headers['x-content-type-options'], 'nosniff');
  assert.match(file.headers['content-security-policy'], /sandbox allow-scripts/);
  assert.match(file.headers['content-security-policy'], /connect-src 'self'/);
  assert.ok(file.headers['content-security-policy'].includes(`frame-ancestors ${h.config.hubOrigin}`));
  assert.equal(file.headers['set-cookie'], undefined);

  // not as a top-level page
  assert.equal((await B.get(url.pathname, { host: url.host, headers: { 'sec-fetch-dest': 'document' } })).status, 403);
  // never from the Hub's own origin
  assert.notEqual((await B.get(url.pathname)).status, 200);
  // the file token of one app does not open another app's files, and garbage tokens fail
  assert.equal((await B.get(url.pathname, { host: h.appHost(miaApp) })).status, 403);
  assert.equal((await B.get('/~abc.def/index.html', { host: url.host })).status, 403);
  // path tricks against the static server
  const tokenPart = url.pathname.split('/')[1];
  for (const p of ['../../hub.sqlite', '..%2f..%2fhub.sqlite', '%2e%2e/%2e%2e/dev-secret', 'js/../../x', '%00']) {
    const res = await B.get(`/${tokenPart}/${p}`, { host: url.host });
    assert.ok([400, 404].includes(res.status), `${p} -> ${res.status}`);
  }
  // the Hub serves its own SDK under that name, whatever was uploaded
  assert.match((await B.get(`/${tokenPart}/hub-sdk.js`, { host: url.host })).text, /SchulHub SDK/);
});

test('SDK-Rechte: Klassen-Daten schreibt nur die Lehrkraft, App-Daten nur die Besitzerin; Grenzen gelten', async () => {
  const s = await h.token(B, teacherApp, cls);
  const t = await h.token(T, teacherApp, cls);
  assert.equal(s.user.isTeacher, false);
  assert.equal(t.user.isTeacher, true);
  assert.ok(!JSON.stringify(s.user).includes(ben.email), 'apps never get the e-mail address');
  assert.notEqual(s.user.id, ben.id, 'apps get a per-app pseudonym, not the real id');

  assert.equal((await B.api(teacherApp, s.token, 'class.set', { key: 'woerter', value: ['x'] })).json().error.code, 'forbidden');
  assert.equal((await B.api(teacherApp, s.token, 'shared.set', { key: 'level', value: 1 })).json().error.code, 'forbidden');
  assert.equal((await T.api(teacherApp, t.token, 'class.set', { key: 'woerter', value: ['hund'] })).json().ok, true);
  assert.deepEqual((await B.api(teacherApp, s.token, 'class.get', { key: 'woerter' })).json().result, ['hund']);
  // class data of one class is invisible from another class / without class
  const noClass = await h.token(T, teacherApp);
  const fromOwner = await T.api(teacherApp, noClass.token, 'shared.set', { key: 'level', value: 1 });
  assert.equal(fromOwner.json().ok, true);

  assert.equal((await B.api(teacherApp, s.token, 'save.set', { key: 'big', value: 'x'.repeat(300 * 1024) })).json().ok, false);
  assert.equal((await B.api(teacherApp, s.token, 'save.set', { key: '../../etc', value: 1 })).json().error.code, 'bad_key');
  assert.equal((await B.api(teacherApp, s.token, 'save.set', { key: "a' OR 1=1 --", value: 1 })).json().error.code, 'bad_key');
  assert.equal((await B.api(teacherApp, s.token, 'constructor', {})).json().error.code, 'unknown_method');
  assert.equal((await B.api(teacherApp, s.token, 'scores.submit', { board: 'p', score: 'viel' })).json().ok, false);
  // leaderboard honours the anonymity setting
  await B.api(teacherApp, s.token, 'scores.submit', { board: 'p', score: 10 });
  await B.post('/meine-daten/anonym', { anonym: '1' });
  const top = (await T.api(teacherApp, t.token, 'scores.top', { board: 'p' })).json().result;
  assert.deepEqual(top.entries.map((e) => e.name), ['Anonym']);
  await B.post('/meine-daten/anonym', {});
});

test('SDK-Aufrufe werden gebremst', async () => {
  const x = await startHub({ rate: { sdk: [5, 60_000] } });
  try {
    const u = await x.browser().login(x.addUser('Schnell', 'teacher'));
    const app = await x.makeApp(u, 'Tempo');
    const t = await x.token(u, app);
    let res;
    for (let i = 0; i < 7; i++) res = await u.api(app, t.token, 'save.keys');
    assert.equal(res.status, 429);
  } finally {
    await x.stop();
  }
});

// ---------------------------------------------------------- hostile uploads

test('Upload: Pfad-Tricks, verbotene Dateitypen und reservierte Namen werden abgelehnt', async () => {
  const created = await M.post('/apps', { name: 'Upload-Test', emoji: '🎮', color: '0' });
  const id = created.headers.location.split('/').pop();
  const v = (await M.send('POST', `/apps/${id}/versionen`)).json();
  const put = (p, data = 'x') => M.send('PUT', `/apps/${id}/versionen/${v.id}/datei?pfad=${encodeURIComponent(p)}`, Buffer.from(data), 'application/octet-stream');
  for (const p of ['../evil.js', '../../data/hub.sqlite', '/etc/passwd.txt', 'a/../../b.js', 'a\\b.js', 'C:\\x.js', 'a//b.js', './a.js', 'x\u0000.js', '_hub/api.js', 'a'.repeat(250) + '.js', 'ende./x.js']) {
    assert.equal((await put(p)).status, 400, JSON.stringify(p));
  }
  for (const p of ['shell.php', 'run.exe', 'x.sh', 'page.jsp', 'noext', 'server.cjs', 'evil.html.php']) {
    assert.equal((await put(p)).status, 400, p);
  }
  assert.equal((await put('index.html', '<p>ok</p>')).status, 200);
  assert.equal((await put('INDEX.HTML', 'dup')).status, 400, 'case-insensitive duplicate');
  assert.equal((await put('big.js', 'x'.repeat(250 * 1024))).status, 413, 'file too large');
  assert.equal((await put('.env', 'SECRET=1')).json().skipped, true, 'hidden files are skipped');
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM app_files WHERE version_id = ?', v.id).n, 1);
  // someone else cannot add files to this upload
  assert.equal((await B.send('PUT', `/apps/${id}/versionen/${v.id}/datei?pfad=x.js`, Buffer.from('x'), 'application/octet-stream')).status, 404);
  // a finished version is immutable
  await M.send('POST', `/apps/${id}/versionen/${v.id}/fertig`);
  assert.equal((await put('later.js')).status, 404);
});

test('Upload: bösartige ZIP-Archive (Pfade, Symlinks, Bomben, zu viele Dateien) hinterlassen nichts', async () => {
  const created = await M.post('/apps', { name: 'Zip-Test', emoji: '🎮', color: '0' });
  const id = created.headers.location.split('/').pop();
  const zip = (entries) => M.send('POST', `/apps/${id}/versionen/zip`, makeZip(entries), 'application/zip');
  const index = { name: 'index.html', data: '<p>ok</p>' };
  const bad = {
    traversal: [index, { name: '../../evil.js', data: 'x' }],
    absolute: [index, { name: '/etc/cron.d/evil.txt', data: 'x' }],
    backslash: [index, { name: '..\\..\\evil.js', data: 'x' }],
    symlink: [index, { name: 'link.txt', data: '/etc/passwd', mode: 0o120777 }],
    forbiddenType: [index, { name: 'backdoor.php', data: '<?php' }],
    bomb: [index, { name: 'bomb.txt', data: Buffer.alloc(600 * 1024) }],
    lyingSize: [index, { name: 'bomb.txt', data: Buffer.alloc(300 * 1024), fakeSize: 10 }],
    manyFiles: [index, ...Array.from({ length: 25 }, (_, i) => ({ name: `f${i}.txt`, data: 'x' }))],
    noIndex: [{ name: 'main.js', data: 'x' }],
  };
  for (const [name, entries] of Object.entries(bad)) {
    const res = await zip(entries);
    assert.ok(res.status === 400 || res.status === 413, `${name} -> ${res.status} ${res.text}`);
    assert.ok(!/at .*\.js|node_modules|ENOENT|sqlite/i.test(res.text), 'no internals in error message');
  }
  assert.equal((await M.send('POST', `/apps/${id}/versionen/zip`, Buffer.from('kein zip'), 'application/zip')).status, 400);
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM app_versions WHERE app_id = ?', id).n, 0, 'nothing of a refused upload is kept');

  // a harmless zip (folder inside, junk files) works and is unpacked correctly
  const ok = await zip([{ name: 'spiel/index.html', data: '<p>zip</p>' }, { name: 'spiel/img/a.png', data: 'png' }, { name: '__MACOSX/spiel/._index.html', data: 'junk' }, { name: 'spiel/.DS_Store', data: 'junk' }]);
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(h.db.all('SELECT path FROM app_files WHERE version_id = ? ORDER BY path', ok.json().id).map((r) => r.path), ['img/a.png', 'index.html']);
});

// -------------------------------------------------------- review + approval

test('Schüler-Apps: ohne Freigabe nicht spielbar; neue Version braucht neue Freigabe', async () => {
  const app = await h.makeApp(M, 'Freigabe-Test', { 'index.html': 'v1' });
  const v1 = app.published_version_id;
  await M.post(`/klassen/${cls}/apps`, { app: app.id });
  assert.equal(h.db.get('SELECT status FROM class_apps WHERE class_id = ? AND app_id = ?', cls, app.id).status, 'pending');
  assert.equal((await B.get(`/apps/${app.id}/spielen?klasse=${cls}`)).status, 404, 'not playable before approval');
  // the student cannot approve their own app, and a wrong version id is refused
  assert.equal((await M.post(`/klassen/${cls}/apps/${app.id}/freigeben`, { version: v1 })).status, 404);
  assert.equal((await T.post(`/klassen/${cls}/apps/${app.id}/freigeben`, { version: 'irgendwas' })).status, 400);
  // the reviewing teacher can preview and read the source
  assert.equal((await T.get(`/apps/${app.id}/spielen?version=${v1}&klasse=${cls}`)).status, 200);
  assert.equal((await T.get(`/apps/${app.id}/versionen/${v1}/quelltext`)).status, 200);
  assert.equal((await T.post(`/klassen/${cls}/apps/${app.id}/freigeben`, { version: v1 })).status, 303);
  assert.equal((await B.get(`/apps/${app.id}/spielen?klasse=${cls}`)).status, 200);

  // Mia publishes something new: the class stays on the approved version
  const v2 = await h.uploadFolder(M, app.id, { 'index.html': 'v2 boese' });
  await M.post(`/apps/${app.id}/veroeffentlichen`, { version: v2 });
  const row = h.db.get('SELECT * FROM class_apps WHERE class_id = ? AND app_id = ?', cls, app.id);
  assert.equal(row.version_id, v1);
  assert.equal(row.requested_version_id, v2);
  assert.equal((await h.token(B, app, cls)).app.version, 1);
  assert.equal((await B.send('POST', `/apps/${app.id}/token`, { klasse: cls, version: v2 })).status, 404, 'classmates cannot open the unapproved version');
  // the teacher sees the submitted version, but not Mia's private draft
  const draft = await h.uploadFolder(M, app.id, { 'index.html': 'geheimer Entwurf' });
  assert.equal((await T.get(`/apps/${app.id}/versionen/${v2}/quelltext`)).status, 200);
  for (const url of [`/apps/${app.id}/versionen/${draft}/quelltext`, `/apps/${app.id}/versionen/${draft}/download`, `/apps/${app.id}/spielen?version=${draft}`]) {
    assert.equal((await T.get(url)).status, 404, url);
  }
  assert.ok(!(await T.get(`/apps/${app.id}`)).text.includes(draft));
  // versions in use cannot be deleted
  assert.equal((await M.post(`/apps/${app.id}/versionen/${v1}/loeschen`)).status, 400);
  await T.post(`/klassen/${cls}/apps/${app.id}/freigeben`, { version: v2 });
  assert.equal((await h.token(B, app, cls)).app.version, 2);
});

test('Alles von Nutzern Geschriebene wird als Text gezeigt, nie als HTML ausgeführt', async () => {
  const evil = '<script>alert(1)</script><img src=x onerror=alert(2)>';
  const app = await h.makeApp(M, evil, { 'index.html': `<h1>x</h1>${evil}`, 'a.js': evil });
  await M.post(`/apps/${app.id}/bearbeiten`, { name: evil, description: evil, emoji: evil, color: '"><script>' });
  await M.post(`/apps/${app.id}/kommentare`, { text: evil });
  await M.post(`/klassen/${cls}/apps`, { app: app.id });
  await T.post(`/klassen/${cls}/apps/${app.id}/freigeben`, { version: app.published_version_id });
  const t = await h.token(B, app, cls);
  await B.api(app, t.token, 'results.add', { title: evil, details: [{ wort: evil, [evil]: evil }] });
  await B.api(app, t.token, 'save.set', { key: 'k', value: { text: evil } });
  h.db.run('UPDATE users SET name = ? WHERE id = ?', `Olaf ${evil}`, outsider.id);
  await O.post(`/beitreten/${joinCode(cls)}`);
  await T.post(`/klassen/${cls}/umbenennen`, { name: `7b ${evil}`.slice(0, 60) });

  const pages = [
    [M, `/apps/${app.id}`], [M, '/apps'], [T, `/klassen/${cls}`], [T, '/start'], [B, '/start'],
    [T, `/apps/${app.id}/versionen/${app.published_version_id}/quelltext`],
    [T, `/apps/${app.id}/versionen/${app.published_version_id}/quelltext?datei=a.js`],
    [T, `/klassen/${cls}/apps/${app.id}/ergebnisse`], [T, `/klassen/${cls}/apps/${app.id}/ergebnisse/${ben.id}`],
    [B, `/apps/${app.id}/spielen?klasse=${cls}`], [B, `/meine-daten/app/${app.id}`], [A, '/admin'], [A, '/admin/apps'], [A, '/admin/protokoll'],
  ];
  for (const [who, url] of pages) {
    const res = await who.get(url);
    assert.equal(res.status, 200, url);
    assert.ok(!res.text.includes('<script>alert(1)'), `raw script tag on ${url}`);
    assert.ok(!res.text.includes('<img src=x'), `raw img tag on ${url}`);
    assert.match(res.headers['content-security-policy'], /script-src 'self'/);
  }
  assert.match((await T.get(`/apps/${app.id}/versionen/${app.published_version_id}/quelltext`)).text, /&lt;script&gt;alert\(1\)/);
  // the download is an attachment, never rendered inside the Hub
  const dl = await T.get(`/apps/${app.id}/versionen/${app.published_version_id}/download`);
  assert.match(dl.headers['content-disposition'], /^attachment/);
  assert.equal(dl.headers['content-type'], 'application/zip');
  assert.equal(dl.buffer.readUInt32LE(0), 0x04034b50);
  // CSV export cannot smuggle spreadsheet formulas
  await B.api(app, t.token, 'results.add', { title: '=HYPERLINK("http://evil")' });
  assert.match((await T.get(`/klassen/${cls}/apps/${app.id}/ergebnisse.csv`)).text, /"'=HYPERLINK/);
  await T.post(`/klassen/${cls}/umbenennen`, { name: '7b' });
});

// ------------------------------------------------------- admin, audit, privacy

test('Verwaltung: Rollenwechsel und Sperren wirken sofort und stehen im Protokoll', async () => {
  const victim = h.addUser('Wechsel Kandidat', 'student');
  const v = await h.browser().login(victim);
  assert.equal((await v.post('/klassen', { name: 'darf nicht' })).status, 404);
  await A.post(`/admin/nutzer/${victim.id}/rolle`, { rolle: 'teacher' });
  assert.equal((await v.post('/klassen', { name: 'darf jetzt' })).status, 303, 'new role applies without a new login');
  await A.post(`/admin/nutzer/${victim.id}/sperren`, { an: '1' });
  assert.equal((await v.get('/start')).status, 302, 'blocked account is signed out immediately');
  assert.equal((await h.browser().page('/').then(async () => 0)), 0);
  // the only admin cannot be removed
  assert.equal((await A.post(`/admin/nutzer/${admin.id}/rolle`, { rolle: 'student' })).status, 400);
  assert.equal(h.db.get('SELECT role FROM users WHERE id = ?', admin.id).role, 'admin');

  const log = (await A.get('/admin/protokoll')).text;
  for (const action of ['anmeldung', 'rolle_geaendert', 'konto_gesperrt', 'version_hochgeladen', 'app_freigegeben', 'upload_abgelehnt', 'klasse_beigetreten']) {
    assert.ok(log.includes(action) || h.db.get('SELECT 1 AS x FROM audit_log WHERE action = ?', action), `audit: ${action}`);
  }
});

test('Meine Daten: Export enthält die eigenen Daten, Löschen entfernt wirklich alles', async () => {
  const user = h.addUser('Lösch Mich', 'student');
  const b = await h.browser().login(user);
  await b.post(`/beitreten/${joinCode(cls)}`);
  const own = await h.makeApp(b, 'Wegwerf-App');
  const t = await h.token(b, teacherApp, cls);
  await b.api(teacherApp, t.token, 'save.set', { key: 'k', value: 'mein Geheimnis' });
  await b.api(teacherApp, t.token, 'results.add', { title: 'Runde' });
  await b.api(teacherApp, t.token, 'scores.submit', { board: 'p', score: 5 });
  await b.post(`/apps/${teacherApp.id}/kommentare`, { text: 'x' }); // not a reviewer -> refused
  const exported = (await b.get('/meine-daten/export')).json();
  assert.equal(exported.konto.name, 'Lösch Mich');
  assert.equal(exported.appDaten[0].spielstaende[0].wert, 'mein Geheimnis');

  // delete one app's data
  await b.post(`/meine-daten/app/${teacherApp.id}/loeschen`);
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM saves WHERE user_id = ?', user.id).n, 0);
  // delete the account: needs the typed confirmation
  assert.equal((await b.post('/meine-daten/konto-loeschen', { bestaetigung: 'nein' })).status, 400);
  assert.equal((await b.post('/meine-daten/konto-loeschen', { bestaetigung: 'LÖSCHEN' })).status, 303);
  for (const [table, col] of [['users', 'id'], ['class_members', 'user_id'], ['saves', 'user_id'], ['results', 'user_id'], ['scores', 'user_id'], ['plays', 'user_id'], ['apps', 'owner_id'], ['sessions', 'user_id'], ['comments', 'author_id']]) {
    assert.equal(h.db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`, user.id).n, 0, table);
  }
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM audit_log WHERE actor_id = ?', user.id).n, 0, 'audit entries are anonymised');
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM app_versions WHERE app_id = ?', own.id).n, 0);
  assert.equal((await b.get('/start')).status, 302);
});

test('Fehlerseiten verraten keine Interna', async () => {
  for (const res of [await M.get('/gibt-es-nicht'), await M.get(`/apps/${'x'.repeat(500)}`), await M.post('/apps', { name: '' }), await M.raw('POST', '/apps', { headers: { 'content-type': 'application/json', 'x-csrf-token': 'x' }, body: '{kaputt' })]) {
    assert.ok(res.status >= 400 && res.status < 500, String(res.status));
    assert.ok(!/Error:|at \w+ \(|node:|\.js:\d+|SQLITE|stack/i.test(res.text), res.text.slice(0, 300));
    assert.equal(res.headers['x-powered-by'], undefined);
  }
});

test('Testmodus lässt sich nicht außerhalb von localhost einschalten', () => {
  const { loadConfig } = require('../src/config');
  assert.throws(() => loadConfig({ env: { BASE_URL: 'https://hub.schule.example' }, dev: true }));
  assert.throws(() => loadConfig({ env: { BASE_URL: 'http://localhost:3000', NODE_ENV: 'production' }, dev: true }));
  // real mode refuses to start without secrets and school configuration
  assert.throws(() => loadConfig({ env: { BASE_URL: 'https://hub.schule.example' }, dev: false }));
});

test('Microsoft-Anmeldung: Rolle nur aus der Konfiguration, fremde Adressen und gesperrte Konten werden abgewiesen', async () => {
  const x = await startHub({ studentDomains: ['schueler.schule.example'], staffDomains: ['schule.example'], adminEmails: ['leitung@schule.example'] });
  try {
    const { auth } = x.hub.ctx;
    const login = (email, oid = email) => auth.upsertUser({ oid, name: 'Test <b>Person</b>', email });
    assert.equal(login('mia@schueler.schule.example').role, 'student');
    assert.equal(login('lehmann@schule.example').role, 'teacher');
    assert.equal(login('Leitung@Schule.example').role, 'admin');
    for (const email of ['eve@gmail.com', 'eve@evil-schule.example', 'eve@schule.example.evil.com', 'schule.example', '']) {
      assert.throws(() => login(email), /Schulkonto/, email);
    }
    // a role the admin changed survives the next login; a blocked account stays out
    const mia = login('mia@schueler.schule.example');
    x.db.run("UPDATE users SET role = 'teacher' WHERE id = ?", mia.id);
    assert.equal(login('mia@schueler.schule.example').role, 'teacher');
    x.db.run('UPDATE users SET disabled = 1 WHERE id = ?', mia.id);
    assert.throws(() => login('mia@schueler.schule.example'), /gesperrt/);
    assert.equal(x.db.get('SELECT COUNT(*) AS n FROM users').n, 3);
  } finally {
    await x.stop();
  }
});
