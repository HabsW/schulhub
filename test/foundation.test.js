'use strict';
// Attack tests for the foundation of version 2: new SDK features (progress,
// achievements, per-class settings, files, the disabled multiplayer hook),
// editor drafts, the review state machine, co-teacher invitations, archived
// classes, retention and the database migration.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { startHub } = require('./helpers');
const { openDb, SCHEMA_V1 } = require('../src/db');
const { parseManifest, validateSettings, effectiveSettings } = require('../src/manifest');

let h;
let admin, lehmann, yilmaz, mia, ben, lena;
let A, L, Y, M, B, LE;
let cls7b, quiz;

const teacherClass = (userId) => h.db.get("SELECT class_id AS id FROM class_members WHERE user_id = ? AND role = 'teacher' ORDER BY joined_at LIMIT 1", userId).id;
const joinCode = (classId, role = 'student') => h.db.get('SELECT code FROM join_codes WHERE class_id = ? AND role = ?', classId, role).code;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);

const MANIFEST = JSON.stringify({
  category: 'Englisch',
  grades: [5, 7],
  achievements: [
    { id: 'erste-runde', title: 'Erste Runde', description: 'Ein Quiz beendet', emoji: '⭐' },
    { id: 'geheim', title: 'Geheimtipp', secret: true },
  ],
  settings: [
    { key: 'woerter', label: 'Wörter', type: 'pairs', columns: ['Deutsch', 'Englisch'], default: [['Hund', 'dog']] },
    { key: 'zeit', label: 'Sekunden pro Frage', type: 'number', min: 5, max: 120, default: 30 },
  ],
  results: { labels: { richtig: 'Richtig beantwortet' } },
});

/** Raw request to an app origin (files API). */
function appRequest(b, app, method, url, { token, body = null, type, origin } = {}) {
  return b.raw(method, url, {
    host: h.appHost(app),
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(type ? { 'content-type': type } : {}), ...(origin ? { origin } : {}) },
    body,
  });
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
  cls7b = teacherClass(lehmann.id);
  for (const b of [M, B]) await b.post(`/beitreten/${joinCode(cls7b)}`);
  quiz = await h.makeApp(L, 'Quiz', { 'index.html': '<h1>Quiz</h1>', 'schulhub.json': MANIFEST });
  await L.post(`/klassen/${cls7b}/apps`, { app: quiz.id });
});
after(() => h.stop());

// ------------------------------------------------------------------- manifest

test('schulhub.json: wird streng geprüft, nur gültige Teile werden übernommen', () => {
  assert.equal(parseManifest('{nope').manifest, null);
  assert.equal(parseManifest('[]').manifest, null);
  assert.ok(parseManifest('x'.repeat(70 * 1024)).errors.length);
  const r = parseManifest(JSON.stringify({
    category: 'Zauberei',
    achievements: [{ id: '../x', title: 'a' }, { id: 'ok', title: '<script>alert(1)</script>', emoji: '💣' }, { id: 'ok', title: 'doppelt' }],
    settings: [{ key: 'z', type: 'number', min: 5, max: 1, default: 3 }, { key: 'w', type: 'pairs', default: 'kein = paar = zuviel' }, { key: 'eval', type: 'script' }],
    evil: true,
  }));
  assert.equal(r.manifest.category, undefined, 'unknown subject dropped');
  assert.deepEqual(r.manifest.achievements.map((a) => a.id), ['ok'], 'bad and duplicate ids dropped');
  assert.equal(r.manifest.achievements[0].emoji, '🏅', 'emoji outside the fixed list replaced');
  assert.equal(r.manifest.achievements[0].title, '<script>alert(1)</script>', 'kept as text (escaped wherever shown)');
  assert.equal(r.manifest.settings.length, 1, 'only valid setting fields survive');
  assert.ok(r.errors.length >= 4 && r.warnings.some((w) => w.includes('evil')));
  // Values a teacher submits are checked against the fields.
  const m = parseManifest(MANIFEST).manifest;
  assert.deepEqual(validateSettings(m, { woerter: 'Katze = cat\nMaus = mouse', zeit: '200' }).errors, { zeit: 'höchstens 120' });
  assert.deepEqual(validateSettings(m, { woerter: 'Katze = cat\nMaus = mouse', zeit: '10' }).values, { woerter: [['Katze', 'cat'], ['Maus', 'mouse']], zeit: 10 });
  assert.equal(validateSettings(m, { woerter: 'nur links' }).errors.woerter.includes('='), true);
  assert.deepEqual(effectiveSettings(m, { zeit: 999, fremd: 1 }), { woerter: [['Hund', 'dog']], zeit: 30 }, 'stored values that no longer fit fall back');
});

test('Upload: schulhub.json wird geprüft, gespeichert und im Bericht vermerkt', () => {
  const v = h.db.get('SELECT manifest, report FROM app_versions WHERE id = ?', quiz.published_version_id);
  assert.equal(JSON.parse(v.manifest).achievements.length, 2);
  assert.deepEqual(JSON.parse(v.report).manifest, { achievements: 2, settings: 2 });
  const a = h.db.get('SELECT category, grade_min, grade_max FROM apps WHERE id = ?', quiz.id);
  assert.deepEqual({ ...a }, { category: 'Englisch', grade_min: 5, grade_max: 7 }, 'catalogue data filled from the manifest');
});

// ------------------------------------------------------------------------ SDK

test('SDK-Fortschritt: nur Zahlen, auf 0..1 begrenzt, pro Person', async () => {
  const t = await h.token(M, quiz, cls7b);
  const call = (m, p) => M.api(quiz, t.token, m, p).then((r) => r.json());
  assert.equal((await call('progress.set', { value: 'viel' })).error.code, 'bad_value');
  assert.equal((await call('progress.set', { value: 7, label: 'x'.repeat(500) })).ok, true);
  const got = (await call('progress.get', {})).result;
  assert.equal(got.value, 1, 'clamped');
  assert.equal(got.label.length, 60, 'label capped');
  const bt = await h.token(B, quiz, cls7b);
  assert.equal((await B.api(quiz, bt.token, 'progress.get', {})).json().result, null, 'one person cannot read another');
});

test('SDK-Erfolge: nur in schulhub.json erklärte, geheime bleiben geheim, Vorschau speichert nichts', async () => {
  const t = await h.token(M, quiz, cls7b);
  const call = (m, p) => M.api(quiz, t.token, m, p).then((r) => r.json());
  assert.equal((await call('achievements.unlock', { id: 'erfunden' })).error.code, 'unknown_achievement');
  assert.equal((await call('achievements.unlock', { id: "x' OR 1=1" })).error.code, 'unknown_achievement');
  const list = (await call('achievements.list', {})).result;
  assert.deepEqual(list.map((a) => [a.id, a.unlocked, a.title]), [['erste-runde', false, 'Erste Runde'], ['geheim', false, 'Geheimer Erfolg']]);
  assert.equal((await call('achievements.unlock', { id: 'erste-runde' })).result.new, true);
  assert.equal((await call('achievements.unlock', { id: 'erste-runde' })).result.new, false, 'only once');
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM achievements WHERE user_id = ?', mia.id).n, 1);

  const p = await h.token(L, quiz, cls7b, quiz.published_version_id);
  assert.equal((await L.api(quiz, p.token, 'achievements.unlock', { id: 'geheim' })).json().result.new, true);
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM achievements WHERE user_id = ?', lehmann.id).n, 0, 'preview keeps it in memory');
});

test('SDK-Einstellungen: Apps lesen nur, und nur die ihrer Klasse', async () => {
  h.db.run('INSERT INTO class_app_settings (class_id, app_id, value, updated_at) VALUES (?, ?, ?, ?)', cls7b, quiz.id, JSON.stringify({ zeit: 15, woerter: [['Katze', 'cat']] }), Date.now());
  const t = await h.token(B, quiz, cls7b);
  assert.deepEqual((await B.api(quiz, t.token, 'settings.all', {})).json().result, { woerter: [['Katze', 'cat']], zeit: 15 });
  assert.equal((await B.api(quiz, t.token, 'settings.set', { key: 'zeit', value: 1 })).json().error.code, 'unknown_method', 'no write path from apps');
  const noClass = await h.token(L, quiz, null, quiz.published_version_id); // preview without class context
  assert.equal(noClass.class, null);
  assert.deepEqual((await L.api(quiz, noClass.token, 'settings.all', {})).json().result, { woerter: [['Hund', 'dog']], zeit: 30 }, 'defaults outside the class');
});

test('SDK-Dateien: nur erlaubte Typen mit passendem Inhalt, pro Person, mit festen Headern', async () => {
  const t = await h.token(M, quiz, cls7b);
  const put = (name, body, type, token = t.token) => appRequest(M, quiz, 'PUT', `/_hub/files/${encodeURIComponent(name)}`, { token, body, type });
  let r = await put('bild-1', PNG, 'image/png');
  assert.equal(r.json().ok, true);
  assert.equal(r.json().result.type, 'image/png');
  assert.equal((await put('seite', '<script>alert(1)</script>', 'text/html')).json().error.code, 'bad_type', 'no HTML');
  assert.equal((await put('fake', '<html><script>x</script>', 'image/png')).json().error.code, 'bad_type', 'content must match the type');
  assert.equal((await put('bild.svg', '<svg onload=alert(1)>', 'image/svg+xml')).json().error.code, 'bad_type', 'no SVG');
  assert.equal((await put('../../etc/passwd', 'x', 'text/plain')).json().error.code, 'bad_key');
  assert.equal((await put('gross', Buffer.alloc(1024 * 1024 + 10, 1), 'text/plain')).status, 413);
  assert.equal((await put('x', 'x', 'text/plain', 'falsch')).status, 401);
  assert.equal((await appRequest(M, quiz, 'PUT', '/_hub/files/x', { token: t.token, body: 'x', type: 'text/plain', origin: 'https://evil.example' })).status, 403, 'foreign origin');

  r = await appRequest(M, quiz, 'GET', '/_hub/files/bild-1', { token: t.token });
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'image/png');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.match(r.headers['content-disposition'], /attachment/);
  assert.ok(r.headers['content-security-policy'].includes('sandbox'));
  assert.deepEqual(r.buffer, PNG);

  const bt = await h.token(B, quiz, cls7b);
  assert.equal((await appRequest(B, quiz, 'GET', '/_hub/files/bild-1', { token: bt.token })).status, 404, "Ben cannot read Mia's file");
  const other = await h.makeApp(M, 'Andere App');
  assert.equal((await appRequest(M, other, 'GET', '/_hub/files/bild-1', { token: t.token })).status, 401, 'token of another app');
  assert.deepEqual((await M.api(quiz, t.token, 'files.list', {})).json().result.map((f) => f.name), ['bild-1']);

  // Quota: number of files per person and app.
  const many = await startHub({ limits: { filesPerApp: 2 } });
  try {
    const u = many.addUser('X', 'teacher');
    const ub = await many.browser().login(u);
    const app = await many.makeApp(ub, 'App');
    const tok = await many.token(ub, app);
    const p = (n) => ub.raw('PUT', `/_hub/files/${n}`, { host: many.appHost(app), headers: { authorization: `Bearer ${tok.token}`, 'content-type': 'text/plain' }, body: 'x' });
    assert.equal((await p('a')).json().ok, true);
    assert.equal((await p('b')).json().ok, true);
    assert.equal((await p('c')).json().error.code, 'quota');
    assert.equal((await p('a')).json().ok, true, 'replacing does not count twice');
  } finally {
    await many.stop();
  }
});

test('SDK-Dateien: Löschen in „Meine Daten“ entfernt auch den Inhalt auf der Platte', async () => {
  const t = await h.token(B, quiz, cls7b);
  const body = Buffer.concat([PNG, Buffer.from('ben-unique')]);
  await appRequest(B, quiz, 'PUT', '/_hub/files/ben-bild', { token: t.token, body, type: 'image/png' });
  const row = h.db.get('SELECT sha256 FROM user_files WHERE user_id = ? AND name = ?', ben.id, 'ben-bild');
  const file = path.join(h.config.dataDir, 'userfiles', row.sha256.slice(0, 2), row.sha256);
  assert.ok(fs.existsSync(file));
  await B.page('/meine-daten');
  await B.post(`/meine-daten/app/${quiz.id}/loeschen`);
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM user_files WHERE user_id = ?', ben.id).n, 0);
  assert.equal(fs.existsSync(file), false, 'blob garbage-collected');
});

test('Mehrspieler ist vorbereitet, aber ausgeschaltet', async () => {
  const t = await h.token(M, quiz, cls7b);
  assert.equal((await M.api(quiz, t.token, 'room.join', { name: 'r1' })).json().error.code, 'not_available');
  // Even with the teacher's switch set, there is no transport yet.
  h.db.run('UPDATE class_apps SET multiplayer = 1 WHERE class_id = ? AND app_id = ?', cls7b, quiz.id);
  assert.equal(h.hub.ctx.access.canJoinRoom(mia, quiz, cls7b), true, 'rule exists');
  assert.equal(h.hub.ctx.access.canJoinRoom(lena, quiz, cls7b), false, 'not for outsiders');
  assert.equal((await M.api(quiz, t.token, 'room.join', { name: 'r1' })).json().error.code, 'not_available');
  h.db.run('UPDATE class_apps SET multiplayer = 0 WHERE class_id = ? AND app_id = ?', cls7b, quiz.id);
});

test('Die Hub-eigenen Dateien (SDK, UI-Kit) lassen sich nicht durch hochgeladene ersetzen', async () => {
  const evil = await h.makeApp(M, 'Evil', { 'index.html': 'x', 'hub-sdk.js': 'alert("fake sdk")', 'lib/hub-ui.css': 'body{display:none}' });
  const play = await M.page(`/apps/${evil.id}/spielen`);
  const src = /src="[^"]*\/~([^/"]+)\/index\.html"/.exec(play.text)[1];
  const sdk = await M.raw('GET', `/~${src}/hub-sdk.js`, { host: h.appHost(evil) });
  assert.ok(sdk.text.includes('SchulHub SDK') && !sdk.text.includes('fake sdk'));
  const ui = await M.raw('GET', `/~${src}/lib/hub-ui.css`, { host: h.appHost(evil) });
  assert.ok(!ui.text.includes('display:none'), 'uploaded hub-ui.css is never served');
});

// --------------------------------------------------------------------- drafts

test('Editor-Entwurf: privat, streng geprüft, Versionen bleiben unveränderlich', async () => {
  const { uploads, services, tokens } = h.hub.ctx;
  const app = h.db.get('SELECT * FROM apps WHERE id = ?', (await h.makeApp(M, 'Entwurf-App')).id);
  uploads.draftFromVersion(app, h.db.get('SELECT * FROM app_versions WHERE id = ?', app.published_version_id));
  for (const bad of ['../x.html', '/abs.html', '_hub/x.js', 'a\\b.js', 'x.exe', '.git/config']) {
    assert.throws(() => uploads.putDraftFile(app, bad, Buffer.from('x')), /nicht|reserviert|Dateityp|Versteckte|unerlaubte/, bad);
  }
  uploads.putDraftFile(app, 'index.html', Buffer.from('<h1>Entwurf</h1>'));
  uploads.putDraftFile(app, 'INDEX.HTML', Buffer.from('<h1>gross</h1>'));
  assert.deepEqual(uploads.listDraftFiles(app.id).map((f) => f.path), ['INDEX.HTML'], 'same name in other case replaces');
  assert.throws(() => services.versionFromDraft(mia, app), /index\.html/, 'the start file must be exactly index.html');
  uploads.putDraftFile(app, 'index.html', Buffer.from('<h1>ersetzt</h1>'));

  // The published version did not change.
  const live = uploads.findFile(app.published_version_id, 'index.html');
  assert.equal(uploads.readBlob(live.sha256).toString(), '<h1>hi</h1>');

  // A draft file token serves the draft; a version token never does; another app's draft token is refused.
  const draftToken = tokens.sign('files', { a: app.id, d: 1 }, 600);
  const r = await M.raw('GET', `/~${draftToken}/index.html`, { host: h.appHost(app) });
  assert.equal(r.text, '<h1>ersetzt</h1>');
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal((await M.raw('GET', `/~${draftToken}/index.html`, { host: h.appHost(quiz) })).status, 403);

  // Saving the draft as a version copies it; the new version is immutable afterwards.
  const v = services.versionFromDraft(mia, app, 'Neue Überschrift');
  assert.equal(v.status, 'ready');
  assert.equal(v.note, 'Neue Überschrift');
  uploads.putDraftFile(app, 'index.html', Buffer.from('<h1>weiter</h1>'));
  assert.equal(uploads.readBlob(uploads.findFile(v.id, 'index.html').sha256).toString(), '<h1>ersetzt</h1>');
  uploads.deleteDraft(app);
  assert.ok(fs.existsSync(uploads.blobPath(uploads.findFile(v.id, 'index.html').sha256)), 'blob still used by the version');
});

// --------------------------------------------------------------- class apps

test('Prüfen: Zurückgeben braucht eine Begründung, die Lehrkraft sieht die Version weiter, Erneut-Einreichen geht', async () => {
  const app = await h.makeApp(M, 'Mias Spiel', { 'index.html': 'v1' });
  await M.page(`/apps/${app.id}`);
  await M.post(`/apps/${app.id}/einreichen`, { klasse: cls7b });
  const v1 = app.published_version_id;
  await L.page(`/apps/${app.id}`);
  assert.equal((await L.post(`/klassen/${cls7b}/apps/${app.id}/ablehnen`, { version: v1, grund: '' })).status, 400, 'reason required');
  assert.equal((await L.post(`/klassen/${cls7b}/apps/${app.id}/ablehnen`, { version: 'falsch', grund: 'Bitte Anleitung ergänzen' })).status, 400, 'bound to the version');
  assert.equal((await L.post(`/klassen/${cls7b}/apps/${app.id}/ablehnen`, { version: v1, grund: 'Bitte Anleitung ergänzen' })).status, 303);

  const row = h.db.get('SELECT * FROM class_apps WHERE class_id = ? AND app_id = ?', cls7b, app.id);
  assert.deepEqual([row.status, row.request_state, row.requested_version_id], ['rejected', 'returned', v1]);
  assert.equal((await L.get(`/apps/${app.id}/versionen/${v1}/quelltext`)).status, 200, 'the teacher keeps seeing what they returned');
  assert.equal((await B.get(`/apps/${app.id}/spielen?klasse=${cls7b}`)).status, 404, 'not playable in the class');
  const reason = h.db.get("SELECT body FROM comments WHERE app_id = ? AND kind = 'returned'", app.id);
  assert.equal(reason.body, 'Bitte Anleitung ergänzen');
  assert.ok(h.db.get("SELECT 1 AS ok FROM notices WHERE user_id = ? AND kind = 'zurueckgegeben'", mia.id), 'the student is told');

  // Resubmitting the same version works after a return; approving needs the exact waiting version.
  await M.page(`/apps/${app.id}`);
  assert.equal((await M.post(`/apps/${app.id}/einreichen`, { klasse: cls7b })).status, 303);
  assert.equal(h.db.get('SELECT request_state FROM class_apps WHERE class_id = ? AND app_id = ?', cls7b, app.id).request_state, 'waiting');
  assert.equal((await M.post(`/apps/${app.id}/einreichen`, { klasse: cls7b })).status, 400, 'no double request');
  await L.page(`/apps/${app.id}`);
  assert.equal((await L.post(`/klassen/${cls7b}/apps/${app.id}/freigeben`, { version: v1 })).status, 303);
  assert.equal((await B.get(`/apps/${app.id}/spielen?klasse=${cls7b}`)).status, 200);
});

test('Entfernte Apps: nicht mehr spielbar, Ergebnisse bleiben für die Lehrkraft lesbar, neue Versionen holen sie nicht zurück', async () => {
  const app = await h.makeApp(L, 'Lesen', { 'index.html': 'x' });
  await L.post(`/klassen/${cls7b}/apps`, { app: app.id });
  const t = await h.token(B, app, cls7b);
  await B.api(app, t.token, 'results.add', { title: 'Runde', score: 3, maxScore: 5 });
  assert.equal(h.db.get('SELECT class_id FROM results WHERE app_id = ? AND user_id = ?', app.id, ben.id).class_id, cls7b, 'class context recorded');

  await L.page(`/klassen/${cls7b}`);
  assert.equal((await L.post(`/klassen/${cls7b}/apps/${app.id}/entfernen`)).status, 303);
  assert.equal(h.db.get('SELECT status FROM class_apps WHERE class_id = ? AND app_id = ?', cls7b, app.id).status, 'removed');
  assert.equal((await B.get(`/apps/${app.id}/spielen?klasse=${cls7b}`)).status, 404);
  assert.equal(h.hub.ctx.access.canSeeStudentData(lehmann, cls7b, app.id, ben.id), true);
  assert.equal(h.hub.ctx.access.canSeeStudentData(yilmaz, cls7b, app.id, ben.id), false);

  const v2 = await h.uploadFolder(L, app.id, { 'index.html': 'v2' });
  await L.post(`/apps/${app.id}/veroeffentlichen`, { version: v2 });
  assert.equal(h.db.get('SELECT status FROM class_apps WHERE class_id = ? AND app_id = ?', cls7b, app.id).status, 'removed', 'publishing does not bring it back');
});

test('Kolleg/innen teilen Apps: nur Lehrkräfte, nur veröffentlichte Version, Schüler-Apps nie', async () => {
  const { access } = h.hub.ctx;
  const shared = await h.makeApp(L, 'Geteilt', { 'index.html': 'x' });
  h.db.run('UPDATE apps SET shared = 1 WHERE id = ?', shared.id);
  const s = h.db.get('SELECT * FROM apps WHERE id = ?', shared.id);
  await Y.post('/klassen', { name: '9c' });
  const cls9c = teacherClass(yilmaz.id);
  assert.equal(access.addToClassMode(yilmaz, s, cls9c), 'approve', 'a colleague may add it');
  assert.equal(access.canSeeVersion(yilmaz, s, s.published_version_id), true, '… and preview it first');
  assert.equal(access.addToClassMode(mia, s, cls7b), null, 'students may not');

  const studentApp = await h.makeApp(M, 'Schüler-geteilt', { 'index.html': 'x' });
  h.db.run('UPDATE apps SET shared = 1 WHERE id = ?', studentApp.id);
  const sa = h.db.get('SELECT * FROM apps WHERE id = ?', studentApp.id);
  assert.equal(access.isSharedWith(yilmaz, sa), false, 'a student cannot bypass review by sharing');
  assert.equal(access.canShareApp(mia, sa), false);
  assert.equal(access.addToClassMode(yilmaz, sa, cls9c), null);
});

// ------------------------------------------------- co-teachers and archive

test('Lehrkraft-Einladung: nur für Lehrkräfte; Schüler-Code macht immer Schüler/in', async () => {
  const { services } = h.hub.ctx;
  services.createJoinCode(lehmann, cls7b, 60, 'teacher');
  const invite = joinCode(cls7b, 'teacher');
  assert.ok(joinCode(cls7b, 'student'), 'the student code survives creating an invitation');
  await LE.page('/start');
  assert.equal((await LE.post(`/beitreten/${invite}`)).status, 400, 'a student cannot use a teacher invitation');
  assert.equal(h.hub.ctx.access.classRole(lena, cls7b), null);
  await Y.page('/start');
  assert.equal((await Y.post(`/beitreten/${invite}`)).status, 303);
  assert.equal(h.hub.ctx.access.classRole(yilmaz, cls7b), 'teacher');
});

test('Archivierte Klassen: Schüler sehen sie nicht mehr, niemand tritt bei, nichts wird geändert', async () => {
  const { access } = h.hub.ctx;
  await L.post('/klassen', { name: 'Alt' });
  const old = h.db.get("SELECT id FROM classes WHERE name = 'Alt'").id;
  const code = joinCode(old);
  await LE.post(`/beitreten/${code}`);
  h.db.run('UPDATE classes SET archived_at = ? WHERE id = ?', Date.now(), old);
  assert.equal(access.canViewClass(lena, old), false);
  assert.equal(access.canViewClass(lehmann, old), true, 'teachers keep read access');
  assert.equal(access.canChangeClass(lehmann, old), false);
  assert.equal((await LE.get(`/klassen/${old}`)).status, 404);
  await B.page('/start');
  assert.equal((await B.post(`/beitreten/${code}`)).status, 400, 'nobody joins an archived class');
});

// ------------------------------------------------------------------ retention

test('Aufbewahrung: Konten werden nur markiert, archivierte Klassen nach Frist gelöscht, Einstellungen geprüft', () => {
  const { services, settings } = h.hub.ctx;
  assert.throws(() => settings.set('retention.inactiveFlagDays', 5), /zwischen/);
  assert.throws(() => settings.set('retention.unbekannt', 5), /gibt es nicht/);
  assert.equal(settings.get('retention.archivedClassDays'), 365);
  const ghost = h.addUser('Lange Weg', 'student');
  h.db.run('UPDATE users SET last_login_at = ?, created_at = ? WHERE id = ?', Date.now() - 500 * 86_400_000, Date.now() - 600 * 86_400_000, ghost.id);
  h.db.run("INSERT INTO classes (id, name, created_at, archived_at) VALUES ('alt-archiv', 'Uralt', 1, ?)", Date.now() - 400 * 86_400_000);
  services.maintenance();
  assert.ok(h.db.get('SELECT flagged_inactive_at FROM users WHERE id = ?', ghost.id).flagged_inactive_at, 'flagged');
  assert.ok(h.db.get('SELECT 1 AS ok FROM users WHERE id = ?', ghost.id), 'never deleted automatically');
  assert.equal(h.db.get("SELECT 1 AS ok FROM classes WHERE id = 'alt-archiv'"), undefined, 'old archived class removed');
  assert.ok(h.db.get("SELECT 1 AS ok FROM audit_log WHERE action = 'klasse_geloescht' AND target = 'Uralt'"), 'and logged');
});

test('Datenbank: Version 1 wird ohne Datenverlust auf die aktuelle Version gehoben', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schulhub-mig-'));
  const file = path.join(dir, 'hub.sqlite');
  const raw = new DatabaseSync(file);
  raw.exec(SCHEMA_V1);
  raw.exec('PRAGMA user_version = 1;');
  raw.exec(`INSERT INTO users (id, oid, name, email, role, created_at) VALUES ('u1', 'o1', 'L', 'l@x', 'teacher', 1);
            INSERT INTO classes (id, name, created_at) VALUES ('c1', 'K', 1);
            INSERT INTO apps (id, owner_id, name, emoji, origin_key, created_at, updated_at) VALUES ('a1', 'u1', 'A', '🎮', 'a00000000000000000001', 1, 1);
            INSERT INTO class_apps (class_id, app_id, status, version_id, requested_version_id, created_at) VALUES ('c1', 'a1', 'approved', 'v1', 'v2', 1);
            INSERT INTO results (app_id, user_id, title, created_at) VALUES ('a1', 'u1', 'alt', 1);`);
  raw.close();
  const db = openDb(file);
  try {
    assert.equal(db.get('PRAGMA user_version').user_version, require('../src/db').SCHEMA_VERSION);
    assert.equal(db.get('SELECT class_id FROM results').class_id, '', 'results from before classes were recorded are marked as such');
    const row = db.get('SELECT * FROM class_apps');
    assert.deepEqual([row.status, row.version_id, row.requested_version_id, row.request_state], ['approved', 'v1', 'v2', 'waiting']);
    assert.equal(db.get('SELECT pref_theme FROM users').pref_theme, 'dark');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
