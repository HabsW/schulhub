'use strict';
// Attack tests for package C ("Bauen"): the in-browser editor on an app's
// draft, its JSON file API, templates (new app, ZIP download), the SDK
// playground and the SDK reference. Each test plays someone who should not
// get through: a teacher who reviews the app, another student, a forged
// request, a hostile file name, a full account.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { startHub } = require('./helpers');
const { parseManifest } = require('../src/manifest');
const { TEMPLATES, templateById, UI_FONTS } = require('../src/bauen');
const { sdkReference, memberNames } = require('../src/sdkReference');

const ROOT = path.join(__dirname, '..');
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

let h;
let admin, lehmann, yilmaz, mia, ben;
let A, L, Y, M, B;
let cls7b, werkstatt;

const teacherClass = (userId) => h.db.get("SELECT class_id AS id FROM class_members WHERE user_id = ? AND role = 'teacher' ORDER BY joined_at LIMIT 1", userId).id;
const joinCode = (classId) => h.db.get("SELECT code FROM join_codes WHERE class_id = ? AND role = 'student'", classId).code;
const draftFiles = (appId) => h.db.all('SELECT path FROM draft_files WHERE app_id = ? ORDER BY path', appId).map((r) => r.path);
const readDraft = (appId, p) => {
  const f = h.hub.ctx.uploads.findDraftFile(appId, p);
  return f ? h.hub.ctx.uploads.readBlob(f.sha256).toString('utf8') : null;
};
const put = (b, appId, p, body, extra = '') => b.send('PUT', `/studio/${appId}/datei?pfad=${encodeURIComponent(p)}${extra}`, Buffer.from(body), 'application/octet-stream');

/** The entries of a zip download: { name: Buffer } (stored or deflated), read from the central directory. */
function unzip(buf) {
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  assert.ok(end >= 0, 'zip end record');
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(at), 0x02014b50, 'central directory entry');
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extra = buf.readUInt16LE(at + 30);
    const comment = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(dataAt, dataAt + size);
    out[name] = method === 8 ? zlib.inflateRawSync(data) : data;
    at += 46 + nameLen + extra + comment;
  }
  return out;
}

before(async () => {
  h = await startHub();
  admin = h.addUser('Anna Adler', 'admin');
  lehmann = h.addUser('Herr Lehmann', 'teacher');
  yilmaz = h.addUser('Frau Yilmaz', 'teacher');
  mia = h.addUser('Mia Schmidt', 'student');
  ben = h.addUser('Ben Hoffmann', 'student');
  [A, L, Y, M, B] = await Promise.all([admin, lehmann, yilmaz, mia, ben].map((u) => h.browser().login(u)));
  await L.post('/klassen', { name: '7b' });
  cls7b = teacherClass(lehmann.id);
  for (const b of [M, B]) await b.post(`/beitreten/${joinCode(cls7b)}`);
  // Mia's app, submitted to and approved in 7b: Herr Lehmann reviews it, Ben plays it.
  werkstatt = await h.makeApp(M, 'Mias Werkstatt', { 'index.html': '<h1>Version 1</h1>', 'js/spiel.js': 'console.log("v1")' });
  await M.page(`/apps/${werkstatt.id}`);
  await M.post(`/apps/${werkstatt.id}/einreichen`, { klasse: cls7b });
  await L.page(`/apps/${werkstatt.id}`);
  await L.post(`/klassen/${cls7b}/apps/${werkstatt.id}/freigeben`, { version: werkstatt.published_version_id });
  await M.page('/start');
  const started = await M.post(`/studio/${werkstatt.id}/entwurf`, { version: werkstatt.published_version_id });
  assert.equal(started.status, 303);
});
after(() => h.stop());

// ------------------------------------------------------------- permissions

test('Editor und Datei-API: nur die Besitzerin – prüfende Lehrkraft, fremde Lehrkraft und Mitschüler bekommen 404', async () => {
  const id = werkstatt.id;
  assert.equal(h.hub.ctx.access.canReviewApp(lehmann, werkstatt), true, 'Herr Lehmann reviews this app');
  const before = draftFiles(id);
  for (const [who, b] of [['prüfende Lehrkraft', L], ['fremde Lehrkraft', Y], ['Mitschüler', B]]) {
    await b.page('/start');
    const tries = [
      ['GET', `/studio/${id}`, await b.get(`/studio/${id}`)],
      ['GET datei', '', await b.get(`/studio/${id}/datei?pfad=index.html`, { headers: { accept: 'application/json' } })],
      ['GET vorschau', '', await b.get(`/studio/${id}/vorschau`, { headers: { accept: 'application/json' } })],
      ['PUT datei', '', await put(b, id, 'index.html', '<h1>übernommen</h1>')],
      ['POST loeschen', '', await b.send('POST', `/studio/${id}/datei/loeschen`, { pfad: 'index.html' })],
      ['POST umbenennen', '', await b.send('POST', `/studio/${id}/datei/umbenennen`, { von: 'index.html', nach: 'weg.html' })],
      ['POST version', '', await b.post(`/studio/${id}/version`, { notiz: 'fremd' })],
      ['POST entwurf', '', await b.post(`/studio/${id}/entwurf`, { version: werkstatt.published_version_id, ersetzen: '1' })],
      ['POST vorlage', '', await b.post(`/studio/${id}/vorlage`, { vorlage: 'leer' })],
      ['POST verwerfen', '', await b.post(`/studio/${id}/verwerfen`)],
    ];
    for (const [what, , res] of tries) assert.equal(res.status, 404, `${who}: ${what}`);
  }
  assert.deepEqual(draftFiles(id), before, 'the draft is untouched');
  assert.equal(readDraft(id, 'index.html'), '<h1>Version 1</h1>');
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM app_versions WHERE app_id = ?', id).n, 1, 'no version was made');
  assert.equal((await M.get('/studio/gibt-es-nicht')).status, 404);
  // The owner, and the admin (access.canManageApp), may open it.
  assert.equal((await M.get(`/studio/${id}`)).status, 200);
  assert.equal((await A.get(`/studio/${id}`)).status, 200);
});

test('Datei-API: Pfad-Tricks, reservierte Namen und verbotene Dateitypen werden abgelehnt, nichts wird geschrieben', async () => {
  const id = werkstatt.id;
  await M.page(`/studio/${id}`);
  const before = draftFiles(id);
  for (const bad of ['../x.html', '/abs.html', 'ok/../../x.html', '_hub/api.js', '_HUB/x.js', 'a\\b.js', 'x.exe', 'virus.php', '.git/config', 'bilder/.versteckt.png', 'x<script>.html', 'datei:mit.js', ' leer.js', 'punkt.', 'a/'.repeat(13) + 'x.js']) {
    const res = await put(M, id, bad, 'x');
    assert.equal(res.status, 400, bad);
    assert.ok(res.json().error, `German message for ${bad}`);
  }
  assert.equal((await M.send('PUT', `/studio/${id}/datei?pfad=a.js&pfad=b.js`, Buffer.from('x'), 'application/octet-stream')).status, 400, 'a list is no file name');
  assert.equal((await M.send('PUT', `/studio/${id}/datei?pfad=x.js`, Buffer.from('x'), 'text/plain')).status, 415, 'raw bytes only');
  // Reading looks names up in the draft's rows only - never on disk.
  for (const p of ['../../src/config.js', '../../../etc/passwd', 'hub-sdk.js', '%2e%2e/x']) {
    assert.equal((await M.get(`/studio/${id}/datei?pfad=${encodeURIComponent(p)}`, { headers: { accept: 'application/json' } })).status, 404, p);
  }
  // Renaming and deleting validate the same way.
  assert.equal((await M.send('POST', `/studio/${id}/datei/umbenennen`, { von: 'index.html', nach: '../index.html' })).status, 400);
  assert.equal((await M.send('POST', `/studio/${id}/datei/umbenennen`, { von: 'index.html', nach: 'index.exe' })).status, 400);
  assert.equal((await M.send('POST', `/studio/${id}/datei/umbenennen`, { von: 'index.html', nach: 'js/spiel.js' })).status, 409, 'never overwrites another file');
  assert.equal((await M.send('POST', `/studio/${id}/datei/loeschen`, { pfad: '../index.html' })).status, 400);
  assert.equal((await M.send('POST', `/studio/${id}/datei/loeschen`, { pfad: 'gibts-nicht.js' })).status, 404);
  assert.equal((await put(M, id, 'index.html', 'x', '&neu=1')).status, 409, '"neu" never replaces');
  assert.deepEqual(draftFiles(id), before, 'nothing was written');
  assert.equal(readDraft(id, 'index.html'), '<h1>Version 1</h1>');
  // Binary files are not sent to the editor.
  assert.equal((await M.send('PUT', `/studio/${id}/datei?pfad=bild.png`, PNG, 'application/octet-stream')).status, 200);
  assert.equal((await M.get(`/studio/${id}/datei?pfad=bild.png`, { headers: { accept: 'application/json' } })).status, 415);
  assert.equal((await M.send('POST', `/studio/${id}/datei/loeschen`, { pfad: 'bild.png' })).status, 200);
});

test('Datei-API: ohne CSRF-Token oder von fremder Herkunft geht nichts', async () => {
  const id = werkstatt.id;
  await M.page(`/studio/${id}`);
  const noToken = await M.raw('PUT', `/studio/${id}/datei?pfad=index.html`, { headers: { 'content-type': 'application/octet-stream', accept: 'application/json' }, body: 'weg' });
  assert.equal(noToken.status, 403);
  const wrong = await M.raw('PUT', `/studio/${id}/datei?pfad=index.html`, { headers: { 'content-type': 'application/octet-stream', 'x-csrf-token': 'falsch' }, body: 'weg' });
  assert.equal(wrong.status, 403);
  const json = { 'content-type': 'application/json', accept: 'application/json' };
  assert.equal((await M.raw('POST', `/studio/${id}/datei/loeschen`, { headers: json, body: JSON.stringify({ pfad: 'index.html' }) })).status, 403);
  assert.equal((await M.raw('POST', `/studio/${id}/datei/umbenennen`, { headers: json, body: JSON.stringify({ von: 'index.html', nach: 'x.html' }) })).status, 403);
  assert.equal((await M.post(`/studio/${id}/version`, { notiz: 'x' }, { withCsrf: false })).status, 403);
  assert.equal((await M.post(`/studio/${id}/verwerfen`, {}, { withCsrf: false })).status, 403);
  assert.equal((await M.post(`/entwickeln/vorlagen/leer/anlegen`, {}, { withCsrf: false })).status, 403);
  assert.equal((await M.post('/entwickeln/spielwiese', {}, { withCsrf: false })).status, 403);
  assert.equal((await M.post(`/studio/${id}/verwerfen`, {}, { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal(readDraft(id, 'index.html'), '<h1>Version 1</h1>');
  assert.ok(h.db.get('SELECT 1 AS ok FROM app_drafts WHERE app_id = ?', id), 'the draft still exists');
});

test('Datei-API: Schreiben ist gebremst', async () => {
  const small = await startHub({ rate: { draftWrites: [3, 60_000] } });
  try {
    const u = small.addUser('Schnell', 'student');
    const b = await small.browser().login(u);
    const app = await small.makeApp(b, 'Schnell', { 'index.html': 'x' });
    await b.post(`/studio/${app.id}/entwurf`, { version: app.published_version_id });
    await b.page(`/studio/${app.id}`);
    for (let i = 0; i < 3; i++) assert.equal((await put(b, app.id, `d${i}.js`, 'x')).status, 200);
    assert.equal((await put(b, app.id, 'd3.js', 'x')).status, 429);
    assert.equal((await b.send('POST', `/studio/${app.id}/datei/loeschen`, { pfad: 'd0.js' })).status, 429, 'deleting counts too');
    assert.equal(small.db.get('SELECT COUNT(*) AS n FROM draft_files WHERE app_id = ?', app.id).n, 4, 'index.html + three files');
  } finally {
    await small.stop();
  }
});

// ----------------------------------------------------------- draft vs version

test('Der Entwurf ist über keinen Versions-Link lesbar – auch nicht für Mitschüler, die die App spielen', async () => {
  const id = werkstatt.id;
  await M.page(`/studio/${id}`);
  assert.equal((await put(M, id, 'index.html', '<h1>Geheimer Entwurf</h1>')).status, 200);
  assert.equal((await put(M, id, 'geheim.js', 'const geheim = 1;')).status, 200);
  for (const b of [M, B]) {
    const play = await b.page(`/apps/${id}/spielen?klasse=${cls7b}`);
    assert.equal(play.status, 200);
    const token = /src="[^"]*\/~([^/"]+)\/index\.html"/.exec(play.text)[1];
    const index = await b.raw('GET', `/~${token}/index.html`, { host: h.appHost(werkstatt) });
    assert.equal(index.text, '<h1>Version 1</h1>', 'the version, never the draft');
    assert.equal((await b.raw('GET', `/~${token}/geheim.js`, { host: h.appHost(werkstatt) })).status, 404);
  }
  // A version-kind token that names "draft" as its version reads nothing.
  const forged = h.hub.ctx.tokens.sign('files', { a: id, v: 'draft' }, 600);
  assert.equal((await B.raw('GET', `/~${forged}/index.html`, { host: h.appHost(werkstatt) })).status, 404);
  // Ben cannot get a draft preview token either.
  await B.page('/start');
  assert.equal((await B.send('POST', `/apps/${id}/token`, { entwurf: true })).status, 404);
  // The owner's editor preview does show the draft.
  const editor = await M.page(`/studio/${id}`);
  const draftToken = /id="appframe"[^>]*src="[^"]*\/~([^/"]+)\/index\.html"/.exec(editor.text)[1];
  assert.equal((await M.raw('GET', `/~${draftToken}/index.html`, { host: h.appHost(werkstatt) })).text, '<h1>Geheimer Entwurf</h1>');
});

test('„Als Version speichern“: braucht index.html, macht eine unveränderliche Version, die Klasse behält die freigegebene', async () => {
  const id = werkstatt.id;
  await M.page(`/studio/${id}`);
  await put(M, id, 'index.html', '<h1>Version 2</h1>');
  // Without index.html there is no version (and the person is sent back with the reason).
  assert.equal((await M.send('POST', `/studio/${id}/datei/umbenennen`, { von: 'index.html', nach: 'start.html' })).status, 200);
  const refused = await M.post(`/studio/${id}/version`, { notiz: 'ohne Start' }, { headers: { referer: `${h.config.hubOrigin}/studio/${id}` } });
  assert.equal(refused.status, 303);
  assert.equal(refused.headers.location, `/studio/${id}`);
  assert.ok((await M.page(`/studio/${id}`)).text.includes('fehlt die Startdatei'), 'the reason is shown in the editor');
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM app_versions WHERE app_id = ?', id).n, 1);
  assert.equal((await M.send('POST', `/studio/${id}/datei/umbenennen`, { von: 'start.html', nach: 'index.html' })).status, 200);

  const saved = await M.post(`/studio/${id}/version`, { notiz: 'Neue Überschrift' });
  assert.equal(saved.status, 303);
  assert.equal(saved.headers.location, `/apps/${id}`);
  const v2 = h.db.get('SELECT * FROM app_versions WHERE app_id = ? AND number = 2', id);
  assert.equal(v2.status, 'ready');
  assert.equal(v2.note, 'Neue Überschrift');
  const files = h.hub.ctx.uploads.listFiles(v2.id).map((f) => f.path).sort();
  assert.deepEqual(files, draftFiles(id).sort(), 'exactly the draft');
  assert.ok((await M.page(`/apps/${id}`)).text.includes('Version 2 gespeichert'), 'result message');

  // Editing on does not change version 2, and the class still plays the approved version 1.
  await M.page(`/studio/${id}`);
  await put(M, id, 'index.html', '<h1>Version 3 in Arbeit</h1>');
  const v2index = h.hub.ctx.uploads.findFile(v2.id, 'index.html');
  assert.equal(h.hub.ctx.uploads.readBlob(v2index.sha256).toString(), '<h1>Version 2</h1>');
  assert.equal(h.db.get('SELECT version_id FROM class_apps WHERE class_id = ? AND app_id = ?', cls7b, id).version_id, werkstatt.published_version_id);
});

test('Entwurf starten, ersetzen, verwerfen: nur mit Absicht und nur aus eigenen Versionen', async () => {
  const id = werkstatt.id;
  const other = await h.makeApp(B, 'Bens App', { 'index.html': '<h1>Ben</h1>' });
  await M.page(`/studio/${id}`);
  assert.equal((await M.post(`/studio/${id}/entwurf`, { version: other.published_version_id, ersetzen: '1' })).status, 404, "Ben's version is not Mia's");
  // An existing draft is not replaced by accident.
  assert.equal((await M.post(`/studio/${id}/entwurf`, { version: werkstatt.published_version_id })).status, 303);
  assert.equal(readDraft(id, 'index.html'), '<h1>Version 3 in Arbeit</h1>');
  assert.equal((await M.post(`/studio/${id}/vorlage`, { vorlage: 'quiz' })).status, 303);
  assert.equal(readDraft(id, 'index.html'), '<h1>Version 3 in Arbeit</h1>', 'a template never overwrites a draft');
  // Discarding removes the draft; the start page offers the versions again.
  assert.equal((await M.post(`/studio/${id}/verwerfen`)).status, 303);
  assert.equal(h.db.get('SELECT 1 AS ok FROM app_drafts WHERE app_id = ?', id), undefined);
  const start = await M.page(`/studio/${id}`);
  assert.ok(start.text.includes('Entwurf aus Version 1 starten'), 'starts from the published version');
  assert.equal((await put(M, id, 'index.html', 'x')).status, 409, 'the file API never creates a draft by itself');
  assert.equal((await M.post(`/studio/${id}/entwurf`, { version: werkstatt.published_version_id })).status, 303);
  assert.equal(readDraft(id, 'index.html'), '<h1>Version 1</h1>');
});

test('Dateinamen erscheinen im Editor nur als Text', async () => {
  const id = werkstatt.id;
  await M.page(`/studio/${id}`);
  assert.equal((await put(M, id, "Tom & Jerry's Spiel.js", 'x')).status, 200);
  assert.equal((await put(M, id, '<img src=x onerror=alert(1)>.html', 'x')).status, 400, 'markup characters are refused');
  const created = await M.post('/apps', { name: '<b>Fett</b> & "Co"', emoji: '🎮', color: '0' });
  const appId = created.headers.location.split('/').pop();
  await M.post(`/studio/${appId}/vorlage`, { vorlage: 'leer' });
  const page = await M.page(`/studio/${appId}`);
  assert.ok(page.text.includes('&lt;b&gt;Fett&lt;/b&gt; &amp; &quot;Co&quot;'), 'app name escaped');
  assert.ok(!page.text.includes('<b>Fett</b>'));
  const editor = await M.page(`/studio/${id}`);
  assert.ok(editor.text.includes('data-path="Tom &amp; Jerry&#39;s Spiel.js"'));
  assert.ok(editor.text.includes('>Tom &amp; Jerry&#39;s Spiel.js<'));
  assert.ok(!editor.text.includes("Tom & Jerry's"));
  // Code is never put into the editor page itself; it is fetched as JSON text.
  await put(M, id, 'js/spiel.js', '</script><script>alert(1)</script>');
  assert.ok(!(await M.page(`/studio/${id}`)).text.includes('alert(1)'));
  const res = await M.get(`/studio/${id}/datei?pfad=js%2Fspiel.js`, { headers: { accept: 'application/json' } });
  assert.match(res.headers['content-type'], /application\/json/);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.json().text, '</script><script>alert(1)</script>');
});

// --------------------------------------------------------------- templates

test('Vorlagen: jede ist vollständig, gültig und bringt keine eigenen Hub-Dateien mit', () => {
  assert.deepEqual(TEMPLATES.map((t) => t.id).slice(0, 5), ['leer', 'quiz', 'lernkarten', 'spiel', 'spielwiese']);
  for (const t of TEMPLATES) {
    const names = t.files.map((f) => f.path);
    for (const needed of ['index.html', 'style.css', 'app.js', 'schulhub.json']) assert.ok(names.includes(needed), `${t.id}: ${needed}`);
    assert.ok(!names.some((n) => /(^|\/)hub-(sdk\.js|ui\.css)$/.test(n) || n.startsWith('hub-ui-fonts/')), `${t.id} ships no Hub files`);
    const parsed = parseManifest(fs.readFileSync(path.join(ROOT, 'templates', t.id, 'schulhub.json'), 'utf8'));
    assert.deepEqual(parsed.errors, [], `${t.id}: schulhub.json`);
    const index = fs.readFileSync(path.join(ROOT, 'templates', t.id, 'index.html'), 'utf8');
    assert.match(index, /<html lang="de">/);
    assert.match(index, /<meta name="viewport"/);
    assert.match(index, /src="hub-sdk\.js"/);
    assert.match(index, /href="hub-ui\.css"/);
    assert.ok(!/(src|href)="(https?:)?\/\//.test(index), `${t.id}: nothing from the internet`);
  }
});

test('Neue App aus Vorlage: geht durch die Prüfung, legt genau die Dateien der Vorlage an, eine volle Platte lässt nichts zurück', async () => {
  await Y.page('/entwickeln/vorlagen');
  const uploads = h.hub.ctx.uploads;
  const original = uploads.putDraftFile;
  const seen = [];
  uploads.putDraftFile = (app, p, buf) => {
    seen.push(p);
    return original(app, p, buf);
  };
  let res;
  try {
    res = await Y.post('/entwickeln/vorlagen/quiz/anlegen');
  } finally {
    uploads.putDraftFile = original;
  }
  assert.equal(res.status, 303);
  const id = res.headers.location.split('/').pop();
  assert.equal(res.headers.location, `/studio/${id}`);
  const tpl = templateById('quiz');
  assert.deepEqual(seen.sort(), tpl.files.map((f) => f.path).sort(), 'every file through putDraftFile');
  assert.deepEqual(draftFiles(id), tpl.files.map((f) => f.path).sort());
  for (const f of tpl.files) assert.equal(readDraft(id, f.path), fs.readFileSync(f.file, 'utf8'), f.path);
  const app = h.db.get('SELECT * FROM apps WHERE id = ?', id);
  assert.deepEqual([app.owner_id, app.name, app.emoji, app.color, app.category], [yilmaz.id, 'Quiz', tpl.emoji, tpl.color, tpl.category]);
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM app_versions WHERE app_id = ?', id).n, 0, 'a draft, no version yet');
  assert.equal((await Y.post('/entwickeln/vorlagen/quiz/anlegen')).status, 303);
  assert.ok(h.db.get("SELECT 1 AS ok FROM apps WHERE owner_id = ? AND name = 'Quiz 2'", yilmaz.id), 'second one gets a free name');
  for (const bad of ['gibt-es-nicht', '..%2F..%2Fsrc', 'leer%00']) assert.equal((await Y.post(`/entwickeln/vorlagen/${bad}/anlegen`)).status, 404, bad);

  // The account quota applies to templates like to any upload: the first file fits, the second does
  // not - and nothing is left behind, not even the first file's content on disk.
  const [first] = templateById('spielwiese').files;
  const tiny = await startHub({ limits: { maxUserBytes: fs.statSync(first.file).size + 10 } });
  try {
    const u = tiny.addUser('Voll', 'student');
    const b = await tiny.browser().login(u);
    await b.page('/entwickeln/vorlagen');
    const full = await b.post('/entwickeln/vorlagen/spielwiese/anlegen');
    assert.equal(full.status, 400);
    assert.equal(tiny.db.get('SELECT COUNT(*) AS n FROM apps').n, 0, 'no app');
    assert.equal(tiny.db.get('SELECT COUNT(*) AS n FROM app_drafts').n, 0, 'no draft');
    const blobs = path.join(tiny.config.dataDir, 'blobs');
    const left = fs.readdirSync(blobs).flatMap((d) => fs.readdirSync(path.join(blobs, d)));
    assert.deepEqual(left, [], 'no orphaned file contents');
  } finally {
    await tiny.stop();
  }
});

test('ZIP-Download: genau die Dateien der Vorlage plus SDK, UI-Kit und Schrift – sonst nichts', async () => {
  for (const [url, id, name] of [['/entwickeln/vorlagen/spiel.zip', 'spiel', 'spiel.zip'], ['/entwickeln/starter.zip', 'leer', 'starter.zip']]) {
    const res = await M.get(url);
    assert.equal(res.status, 200, url);
    assert.equal(res.headers['content-type'], 'application/zip');
    assert.equal(res.headers['content-disposition'], `attachment; filename="${name}"`);
    const entries = unzip(res.buffer);
    const tpl = templateById(id);
    const expected = [...tpl.files.map((f) => f.path), 'hub-sdk.js', 'hub-ui.css', ...UI_FONTS.map((f) => `hub-ui-fonts/${f}`)].sort();
    assert.deepEqual(Object.keys(entries).sort(), expected, url);
    for (const f of tpl.files) assert.deepEqual(entries[f.path], fs.readFileSync(f.file), f.path);
    assert.deepEqual(entries['hub-sdk.js'], fs.readFileSync(path.join(ROOT, 'sdk', 'hub-sdk.js')));
    assert.deepEqual(entries['hub-ui.css'], fs.readFileSync(path.join(ROOT, 'sdk', 'hub-ui.css')));
    for (const font of UI_FONTS) assert.deepEqual(entries[`hub-ui-fonts/${font}`], fs.readFileSync(path.join(ROOT, 'public', 'fonts', font)));
  }
  for (const bad of ['gibt-es-nicht.zip', '..%2F..%2Fsrc.zip', '..%2Fquiz.zip', 'quiz%2F..%2F..%2Fpackage.json.zip']) {
    assert.equal((await M.get(`/entwickeln/vorlagen/${bad}`)).status, 404, bad);
  }
  assert.equal((await h.browser().get('/entwickeln/starter.zip')).status, 302, 'only for signed-in people');
});

test('Spielwiese: wird einmal angelegt und danach wiederverwendet; jede Person hat ihre eigene', async () => {
  await M.page('/entwickeln/spielwiese');
  const first = await M.post('/entwickeln/spielwiese');
  assert.equal(first.status, 303);
  const again = await M.post('/entwickeln/spielwiese');
  assert.equal(again.headers.location, first.headers.location, 'the same app again');
  const id = first.headers.location.split('/').pop();
  assert.equal(h.db.get("SELECT COUNT(*) AS n FROM apps WHERE owner_id = ? AND name = 'Spielwiese'", mia.id).n, 1);
  assert.deepEqual(draftFiles(id), templateById('spielwiese').files.map((f) => f.path).sort());
  assert.ok((await M.page('/entwickeln/spielwiese')).text.includes('Deine Spielwiese öffnen'));
  await B.page('/entwickeln/spielwiese');
  const bens = await B.post('/entwickeln/spielwiese');
  assert.notEqual(bens.headers.location, first.headers.location, 'Ben gets his own');
  assert.equal((await B.get(first.headers.location)).status, 404, "and never Mia's");
});

// ------------------------------------------------------------------- docs

test('SDK-Referenz: beschreibt jede Funktion und jeden Wert, den hub-sdk.js anbietet, und jede Klasse von hub-ui.css', async () => {
  // Run the real SDK (local mode, no Hub around it) and list what it offers.
  const win = {
    location: { search: '', pathname: '/app/index.html', protocol: 'file:' },
    console: { info() {}, log() {}, warn() {}, error() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  };
  win.parent = win;
  win.window = win;
  vm.createContext(win);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'sdk', 'hub-sdk.js'), 'utf8'), win);
  const hub = await win.Hub.connect();
  const offered = ['Hub.connect', 'Hub.version'];
  for (const [k, v] of Object.entries(hub)) {
    const fns = v && typeof v === 'object' ? Object.entries(v).filter(([, f]) => typeof f === 'function') : [];
    if (typeof v === 'function') offered.push(`hub.${k}`);
    else if (fns.length) for (const [m] of fns) offered.push(`hub.${k}.${m}`);
    else offered.push(`hub.${k}`);
  }
  assert.ok(offered.length >= 30, 'the SDK was really enumerated');
  const ref = sdkReference(h.config);
  const documented = memberNames(ref);
  assert.deepEqual(offered.filter((n) => !documented.includes(n)), [], 'undocumented');
  assert.deepEqual(documented.filter((n) => !offered.includes(n)), [], 'documented but not in the SDK');
  for (const g of ref.groups) {
    for (const m of g.members) {
      for (const field of ['sig', 'text', 'returns', 'example']) assert.ok(m[field], `${m.name}: ${field}`);
    }
  }
  const page = await M.page('/entwickeln/sdk');
  assert.equal(page.status, 200);
  for (const name of documented) assert.ok(page.text.includes(`id="${name.replace(/[^A-Za-z0-9]+/g, '-')}"`), `anchor for ${name}`);
  // Inline code never widens the page: names stay whole, code with spaces may wrap, long examples are <pre> blocks.
  for (const [, cls = '', text] of page.text.matchAll(/<code(?: class="([^"]*)")?>([^<]*)<\/code>/g)) {
    if (/\s/.test(text)) assert.ok(cls.split(' ').includes('wrap'), `inline code with spaces must wrap: ${text}`);
    assert.ok(text.length <= 64, `too long for inline code, use a block: ${text}`);
  }
  const classes = [...new Set(fs.readFileSync(path.join(ROOT, 'sdk', 'hub-ui.css'), 'utf8').match(/\.hub-[a-z-]+/g).map((c) => c.slice(1)))];
  for (const c of classes) assert.ok(ref.ui.classes.some(([k]) => k === c), `hub-ui.css class ${c}`);
  for (const type of ['text', 'number', 'boolean', 'choice', 'list', 'pairs']) assert.ok(ref.manifest.settingTypes.some(([k]) => k === type), `setting type ${type}`);
});

test('Anleitung, Referenz und Vorlagen: für alle Angemeldeten, die SDK-Datei lässt sich weiter laden', async () => {
  for (const b of [M, L, A]) {
    for (const url of ['/entwickeln', '/entwickeln/sdk', '/entwickeln/vorlagen', '/entwickeln/spielwiese']) {
      const res = await b.page(url);
      assert.equal(res.status, 200, url);
      assert.ok(res.text.includes('href="/entwickeln/vorlagen" aria-current="page"') || url !== '/entwickeln/vorlagen', 'tab marked');
    }
  }
  const anon = h.browser();
  assert.equal((await anon.get('/entwickeln')).status, 302);
  const sdk = await M.get('/sdk/hub-sdk.js');
  assert.equal(sdk.status, 200);
  assert.match(sdk.headers['content-disposition'], /attachment; filename="hub-sdk.js"/);
  const guide = await M.page('/entwickeln');
  for (const words of ['?lehrkraft', 'Relative Pfade', 'nichts gespeichert', 'Veröffentlichen', 'Datenschutz']) assert.ok(guide.text.includes(words), words);
});
