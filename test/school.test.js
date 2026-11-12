'use strict';
// Attack tests for package D: display settings, search, the catalogue,
// announcements, "Meine Daten" (files, per-app page, export, deletion), the
// admin area, backups and the restore tool.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const yauzl = require('yauzl');
const { startHub, makeZip } = require('./helpers');
const { openDb } = require('../src/db');
const { dayKey } = require('../src/util');
const { AUDIT_LABELS } = require('../src/auditLabels');
const { restoreBackup, RestoreError, isEntryName, lastBackupAt } = require('../src/backup');

const DAY = 86_400_000;
const ROOT = path.join(__dirname, '..');
const PNG = (fill) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, fill)]);
const MANIFEST = JSON.stringify({
  category: 'Englisch',
  grades: [5, 7],
  achievements: [{ id: 'erste-runde', title: 'Erste Runde', description: 'Ein Quiz beendet', emoji: '⭐' }],
  results: { labels: { richtig: 'Richtig beantwortet' } },
});

let h;
let admin, lehmann, kaya, yilmaz, mia, ben, lena;
let A, L, K, Y, M, B, LE;
let cls7b, cls9a, quiz, game, kayaPrivate, kayaShared, miaApp;

const teacherClass = (userId, name) => h.db.get("SELECT c.id FROM classes c JOIN class_members m ON m.class_id = c.id AND m.user_id = ? AND m.role = 'teacher' WHERE c.name = ?", userId, name).id;
const joinCode = (classId) => h.db.get("SELECT code FROM join_codes WHERE class_id = ? AND role = 'student'", classId).code;
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const tmpDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/** Raw request to an app's own origin (files API of the SDK). */
const appRequest = (b, app, method, url, { token, body = null, type } = {}) =>
  b.raw(method, url, { host: h.appHost(app), headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(type ? { 'content-type': type } : {}) }, body });

/** All entries of a zip as { name, data, mode }. */
function readZip(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const out = [];
      zip.on('error', reject);
      zip.on('end', () => resolve(out));
      zip.on('entry', (e) => {
        zip.openReadStream(e, (err2, stream) => {
          if (err2) return reject(err2);
          const chunks = [];
          stream.on('data', (c) => chunks.push(c));
          stream.on('end', () => {
            out.push({ name: e.fileName, data: Buffer.concat(chunks), mode: (e.externalFileAttributes >>> 16) & 0o170000 });
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

/** Every action code passed to audit() anywhere in src/ (second argument, all string literals in it). */
function auditCodesInSource() {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) files.push(p);
    }
  };
  walk(path.join(ROOT, 'src'));
  const splitArgs = (text, start) => {
    const args = [''];
    let depth = 0;
    let quote = null;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (quote) {
        args[args.length - 1] += c;
        if (c === '\\') args[args.length - 1] += text[++i];
        else if (c === quote) quote = null;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') quote = c;
      else if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) {
        if (depth === 0) break;
        depth--;
      } else if (c === ',' && depth === 0) {
        args.push('');
        continue;
      }
      args[args.length - 1] += c;
    }
    return args;
  };
  const codes = new Set();
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\baudit\(/g)) {
      if (/function\s+$/.test(text.slice(Math.max(0, m.index - 12), m.index))) continue;
      const second = splitArgs(text, m.index + m[0].length)[1] || '';
      for (const lit of second.matchAll(/'([a-z][a-z0-9_]*)'/g)) codes.add(lit[1]);
    }
  }
  return codes;
}

before(async () => {
  h = await startHub();
  admin = h.addUser('Anna Adler', 'admin');
  lehmann = h.addUser('Herr Lehmann', 'teacher');
  kaya = h.addUser('Herr Kaya', 'teacher');
  yilmaz = h.addUser('Frau Yilmaz', 'teacher'); // teaches no class
  mia = h.addUser('Mia Schmidt', 'student');
  ben = h.addUser('Ben Hoffmann', 'student');
  lena = h.addUser('Lena Wagner', 'student');
  [A, L, K, Y, M, B, LE] = await Promise.all([admin, lehmann, kaya, yilmaz, mia, ben, lena].map((u) => h.browser().login(u)));

  await L.post('/klassen', { name: '7b Englisch' });
  cls7b = teacherClass(lehmann.id, '7b Englisch');
  for (const b of [M, B]) await b.post(`/beitreten/${joinCode(cls7b)}`);
  await K.post('/klassen', { name: '9a Mathe' });
  cls9a = teacherClass(kaya.id, '9a Mathe');
  await LE.post(`/beitreten/${joinCode(cls9a)}`);

  quiz = await h.makeApp(L, 'Quiz', { 'index.html': '<h1>Quiz</h1>', 'schulhub.json': MANIFEST });
  game = await h.makeApp(L, 'Sternenspiel');
  for (const a of [quiz, game]) await L.post(`/klassen/${cls7b}/apps`, { app: a.id });
  kayaPrivate = await h.makeApp(K, 'Geheimes Quiz');
  await K.post(`/klassen/${cls9a}/apps`, { app: kayaPrivate.id });
  kayaShared = await h.makeApp(K, 'Geteiltes Quiz');
  h.db.run('UPDATE apps SET shared = 1 WHERE id = ?', kayaShared.id);
  kayaShared = h.db.get('SELECT * FROM apps WHERE id = ?', kayaShared.id);
  miaApp = await h.makeApp(M, 'Mias Malprogramm');
  await M.page(`/apps/${miaApp.id}`);
  await M.post(`/apps/${miaApp.id}/einreichen`, { klasse: cls7b });
});
after(() => h.stop());

// ------------------------------------------------------------------ settings

test('Darstellung: nur die eigenen Einstellungen, nur erlaubte Werte', async () => {
  const prefs = (u) => ({ ...h.db.get('SELECT pref_theme, pref_text, pref_motion, pref_contrast FROM users WHERE id = ?', u.id) });
  await M.page('/einstellungen');
  const res = await M.post('/einstellungen', { farbschema: 'light', schriftgroesse: 'larger', bewegung: 'reduce', kontrast: 'high', user: ben.id, id: ben.id, user_id: ben.id });
  assert.equal(res.status, 303);
  assert.deepEqual(prefs(mia), { pref_theme: 'light', pref_text: 'larger', pref_motion: 'reduce', pref_contrast: 'high' });
  assert.deepEqual(prefs(ben), { pref_theme: 'dark', pref_text: 'normal', pref_motion: 'auto', pref_contrast: 'normal' }, 'ids in the form are ignored');
  assert.match((await M.page('/einstellungen')).text, /data-theme="light" data-text="larger" data-motion="reduce" data-contrast="high"/);

  for (const bad of [{ farbschema: '"><script>alert(1)</script>' }, { schriftgroesse: 'riesig' }, { bewegung: 'full' }, { kontrast: '' }, { farbschema: 'dark', kontrast: 'extrem' }, {}]) {
    assert.equal((await M.post('/einstellungen', bad)).status, 400, JSON.stringify(bad));
  }
  assert.deepEqual(prefs(mia), { pref_theme: 'light', pref_text: 'larger', pref_motion: 'reduce', pref_contrast: 'high' }, 'nothing changed by a refused form');
  assert.equal((await M.post('/einstellungen', { farbschema: 'auto' })).status, 303, 'one value alone is fine');
  assert.equal(prefs(mia).pref_theme, 'auto');
  assert.equal(prefs(mia).pref_text, 'larger');
  assert.equal((await M.post('/einstellungen', { farbschema: 'dark' }, { withCsrf: false })).status, 403);
  await M.post('/einstellungen', { farbschema: 'dark', schriftgroesse: 'normal', bewegung: 'auto', kontrast: 'normal' });

  // The leaderboard switch on the same page: one column, back to the page it came from, never elsewhere.
  let r = await M.post('/meine-daten/anonym', { anonym: '1', zurueck: '/einstellungen' });
  assert.equal(r.headers.location, '/einstellungen');
  assert.equal(h.db.get('SELECT anonymous_scores AS a FROM users WHERE id = ?', mia.id).a, 1);
  r = await M.post('/meine-daten/anonym', { zurueck: 'https://evil.example/' });
  assert.equal(r.headers.location, '/meine-daten');
  assert.equal(h.db.get('SELECT anonymous_scores AS a FROM users WHERE id = ?', mia.id).a, 0);
});

// -------------------------------------------------------------------- search

test('Suche: nur Apps, Klassen und Personen, die man sehen darf; Schüler/innen finden keine Personen', async () => {
  const search = (b, q) => b.get(`/suche?q=${encodeURIComponent(q)}`).then((r) => r.text);

  let text = await search(M, 'Quiz');
  assert.ok(text.includes(`/apps/${quiz.id}/spielen`), 'an app of her class');
  assert.ok(!text.includes(kayaPrivate.id) && !text.includes(kayaShared.id), 'never apps of other classes or shared with staff');
  text = await search(M, 'Mathe');
  assert.ok(!text.includes(cls9a), 'no other classes');
  assert.ok((await search(M, '7b')).includes(`/klassen/${cls7b}`));
  text = await search(M, 'Ben');
  assert.ok(!text.includes('Ben Hoffmann') && !text.includes('s-personen'), 'students never search people');

  assert.ok((await search(L, 'Mia')).includes('Mia Schmidt'), 'a teacher finds the students of his class');
  assert.ok(!(await search(L, 'Lena')).includes('Lena Wagner'), '… but not the students of other teachers');
  assert.ok((await search(K, 'Lena')).includes('Lena Wagner'));
  assert.ok(!(await search(K, 'Mia')).includes('Mia Schmidt'));
  text = await search(Y, 'Quiz');
  assert.ok(text.includes(`/apps/${kayaShared.id}/spielen`), 'staff see apps colleagues shared');
  assert.ok(!text.includes(kayaPrivate.id) && !text.includes(quiz.id), '… but nothing else of theirs');
  assert.ok(!(await search(Y, 'Mia')).includes('Mia Schmidt'), 'a teacher without classes finds nobody');

  for (const q of ['%%', '__', 'M']) assert.ok(!(await search(L, q)).includes('Mia Schmidt'), `no wildcard or one-letter search: ${q}`);
  text = await search(M, '<script>alert(1)</script>');
  assert.ok(!text.includes('<script>alert(1)') && text.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'the query is shown escaped');
  assert.equal((await M.get('/suche?q=a&q=b')).status, 200, 'repeated parameters are harmless');
});

// ------------------------------------------------------------------ catalogue

test('Entdecken: nur sichtbare Apps; „Zur Klasse hinzufügen“ nur, wo die Lehrkraft sofort freigeben darf', async () => {
  const { access } = h.hub.ctx;
  const addForms = (text) => [...text.matchAll(/action="\/klassen\/([^"/]+)\/apps"[^>]*>[\s\S]*?name="app" value="([^"]+)"/g)].map((m) => [m[1], m[2]]);

  let text = (await M.get('/katalog')).text;
  for (const a of [quiz, game, miaApp]) assert.ok(text.includes(`/apps/${a.id}/spielen`), a.name);
  assert.ok(!text.includes(kayaPrivate.id) && !text.includes(kayaShared.id));
  assert.deepEqual(addForms(text), [], 'students can never add apps to a class here');

  text = (await Y.get('/katalog')).text;
  assert.ok(text.includes(`/apps/${kayaShared.id}/spielen`) && !text.includes(kayaPrivate.id));
  assert.deepEqual(addForms(text), [], 'no own class, nothing to add');

  text = (await L.get('/katalog')).text;
  assert.ok(text.includes(`/apps/${kayaShared.id}/spielen`), 'a colleague’s shared app');
  assert.ok(!text.includes(kayaPrivate.id) && !text.includes(miaApp.id), 'not a colleague’s private app, not a student app waiting for review');
  assert.deepEqual(addForms(text), [[cls7b, kayaShared.id]], 'only where addToClassMode is approve, and not twice');
  assert.equal(access.addToClassMode(lehmann, kayaShared, cls7b), 'approve');
  assert.equal(access.addToClassMode(lehmann, kayaShared, cls9a), null);

  // Filters: subject, grade, source - and hostile values are ignored.
  const names = async (b, qs) => [...(await b.get(`/katalog?${qs}`)).text.matchAll(/class="row-link row-title" href="\/apps\/([^/]+)\/spielen"/g)].map((m) => m[1]);
  assert.deepEqual(await names(M, 'fach=Englisch'), [quiz.id]);
  assert.deepEqual(await names(M, 'stufe=6'), [quiz.id]);
  assert.deepEqual(await names(M, 'stufe=9'), []);
  assert.deepEqual(await names(M, 'zeige=schule'), []);
  assert.deepEqual((await names(M, 'zeige=schueler')).sort(), [miaApp.id].sort());
  await M.post(`/apps/${game.id}/favorit`, { zurueck: '/katalog' });
  assert.deepEqual(await names(M, 'zeige=favoriten'), [game.id]);
  const odd = await M.get(`/katalog?fach=${encodeURIComponent('<script>')}&stufe=99&zeige=alles&seite=-4`);
  assert.equal(odd.status, 200);
  assert.ok(!odd.text.includes('<script>'));
  assert.equal((await M.get('/katalog?seite=999')).status, 200);

  // The button posts to the class route, which applies the same rule again.
  assert.equal((await M.post(`/klassen/${cls7b}/apps`, { app: kayaShared.id })).status, 404);
  await L.page('/katalog');
  assert.equal((await L.post(`/klassen/${cls7b}/apps`, { app: kayaShared.id })).status, 303);
  assert.equal(h.db.get('SELECT status FROM class_apps WHERE class_id = ? AND app_id = ?', cls7b, kayaShared.id).status, 'approved');
  assert.deepEqual(addForms((await L.get('/katalog')).text), [], 'once in the class, it is not offered again');
});

// -------------------------------------------------------------- announcements

test('Ankündigungen: Schüler/innen nie, Lehrkräfte nur für eigene Klassen, die ganze Schule nur der Admin', async () => {
  const count = () => h.db.get('SELECT COUNT(*) AS n FROM announcements').n;
  await M.page('/start');
  assert.equal((await M.get('/ankuendigungen')).status, 404);
  for (const ziel of [cls7b, 'schule']) assert.equal((await M.post('/ankuendigungen', { ziel, titel: 'Hack' })).status, 404);

  await L.page('/ankuendigungen');
  assert.equal((await L.post('/ankuendigungen', { ziel: cls9a, titel: 'Fremde Klasse' })).status, 404, 'not for a class of another teacher');
  assert.equal((await L.post('/ankuendigungen', { ziel: 'schule', titel: 'An alle' })).status, 404, 'the whole school only for the admin');
  assert.equal((await L.post('/ankuendigungen', { ziel: 'gibt-es-nicht', titel: 'x' })).status, 404);
  for (const fields of [
    { ziel: cls7b, titel: 'x'.repeat(121) }, { ziel: cls7b, titel: '' }, { ziel: cls7b, titel: 'Hallo', text: 'y'.repeat(1001) },
    { ziel: cls7b, titel: 'Hallo', bis: '2020-01-01' }, { ziel: cls7b, titel: 'Hallo', bis: '2026-02-31' }, { ziel: cls7b, titel: 'Hallo', bis: dayKey(Date.now() + 400 * DAY) },
    { titel: 'ohne Ziel' },
  ]) {
    assert.equal((await L.post('/ankuendigungen', fields)).status, 400, JSON.stringify(fields).slice(0, 80));
  }
  assert.equal(count(), 0, 'nothing was stored');

  // An archived class takes no announcements.
  await L.post('/klassen', { name: 'Alte Klasse' });
  const old = teacherClass(lehmann.id, 'Alte Klasse');
  h.db.run('UPDATE classes SET archived_at = ? WHERE id = ?', Date.now(), old);
  assert.equal((await L.post('/ankuendigungen', { ziel: old, titel: 'Zu spät' })).status, 404);
  assert.ok(!(await L.get('/ankuendigungen')).text.includes(`value="${old}"`));

  const until = dayKey(Date.now() + 3 * DAY);
  assert.equal((await L.post('/ankuendigungen', { ziel: cls7b, titel: 'Ausflug am Freitag', text: '<b>Bitte</b> Jacke mitbringen', bis: until })).status, 303);
  const an = h.db.get("SELECT * FROM announcements WHERE title = 'Ausflug am Freitag'");
  assert.equal(an.class_id, cls7b);
  assert.equal(an.author_id, lehmann.id);
  assert.ok(an.expires_at > Date.now() + 3 * DAY - DAY && an.expires_at <= Date.now() + 4 * DAY + DAY, 'visible until the end of that day');
  const start = (await M.get('/start')).text;
  assert.ok(start.includes('Ausflug am Freitag') && !start.includes('<b>Bitte</b>'), 'shown, escaped');
  assert.ok(!(await LE.get('/start')).text.includes('Ausflug am Freitag'), 'not in other classes');
  assert.ok(h.db.get("SELECT 1 AS ok FROM notices WHERE user_id = ? AND kind = 'ankuendigung'", mia.id), 'class members get a notice');

  await A.page('/ankuendigungen');
  assert.equal((await A.post('/ankuendigungen', { ziel: 'schule', titel: 'Schulfest' })).status, 303);
  const sw = h.db.get("SELECT * FROM announcements WHERE title = 'Schulfest'");
  assert.equal(sw.class_id, null);
  assert.ok((await LE.get('/start')).text.includes('Schulfest'));

  // ?klasse= preselects only a class the person may write to.
  assert.ok((await L.get(`/ankuendigungen?klasse=${cls7b}`)).text.includes(`<option value="${cls7b}" selected>`));
  assert.ok(!(await L.get(`/ankuendigungen?klasse=${cls9a}`)).text.includes(cls9a));

  // Lists and deleting.
  assert.ok(!(await K.get('/ankuendigungen')).text.includes('Ausflug am Freitag'));
  assert.ok(!(await L.get('/ankuendigungen')).text.includes('Schulfest'), 'teachers manage only their classes');
  for (const [who, id] of [[K, an.id], [M, an.id], [L, sw.id], [Y, sw.id]]) assert.equal((await who.post(`/ankuendigungen/${id}/loeschen`)).status, 404);
  assert.equal(count(), 2);
  assert.equal((await L.post(`/ankuendigungen/${an.id}/loeschen`)).status, 303);
  assert.equal((await A.post(`/ankuendigungen/${sw.id}/loeschen`)).status, 303);
  assert.equal(count(), 0);
  for (const [action, title] of [['ankuendigung_erstellt', 'Ausflug am Freitag'], ['ankuendigung_erstellt', 'Schulfest'], ['ankuendigung_geloescht', 'Ausflug am Freitag'], ['ankuendigung_geloescht', 'Schulfest']]) {
    assert.ok(h.db.get('SELECT 1 AS ok FROM audit_log WHERE action = ? AND target = ?', action, title), `${action} ${title}`);
  }
});

// ---------------------------------------------------------------- Meine Daten

test('Meine Daten: Dateien nur die eigenen, immer als Download mit festen Headern', async () => {
  const mt = await h.token(M, quiz, cls7b);
  const bt = await h.token(B, quiz, cls7b);
  assert.equal((await appRequest(M, quiz, 'PUT', '/_hub/files/bild-1', { token: mt.token, body: PNG(1), type: 'image/png' })).json().ok, true);
  assert.equal((await appRequest(B, quiz, 'PUT', '/_hub/files/bild-1', { token: bt.token, body: PNG(2), type: 'image/png' })).json().ok, true);
  await appRequest(M, quiz, 'PUT', '/_hub/files/notiz', { token: mt.token, body: '<script>alert(1)</script>', type: 'text/plain' });

  const url = `/meine-daten/app/${quiz.id}/datei/bild-1`;
  const r = await M.get(url);
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'application/octet-stream');
  assert.equal(r.headers['content-disposition'], 'attachment; filename="bild-1.png"');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.deepEqual(r.buffer, PNG(1));
  assert.deepEqual((await B.get(url)).buffer, PNG(2), 'the same name gives everybody only their own file');
  assert.equal((await LE.get(url)).status, 404);
  const txt = await M.get(`/meine-daten/app/${quiz.id}/datei/notiz`);
  assert.equal(txt.headers['content-type'], 'application/octet-stream', 'text is never rendered either');
  assert.equal(txt.headers['content-disposition'], 'attachment; filename="notiz.txt"');
  for (const bad of [`/meine-daten/app/${quiz.id}/datei/..%2F..%2Fhub.sqlite`, `/meine-daten/app/${quiz.id}/datei/bild-2`, `/meine-daten/app/${game.id}/datei/bild-1`, '/meine-daten/app/gibt-es-nicht/datei/bild-1']) {
    assert.equal((await M.get(bad)).status, 404, bad);
  }
});

test('Meine Daten: die Seite einer App nur mit eigenen Daten oder wenn man sie öffnen darf', async () => {
  assert.equal((await LE.get(`/meine-daten/app/${quiz.id}`)).status, 404, 'no data, cannot open it');
  assert.equal((await LE.get(`/meine-daten/app/${kayaPrivate.id}`)).status, 200, 'an app of her own class');
  assert.equal((await M.get(`/meine-daten/app/${kayaPrivate.id}`)).status, 404);
  assert.equal((await M.get('/meine-daten/app/gibt-es-nicht')).status, 404);

  // Data stays visible (and deletable) after the app left the class.
  const read = await h.makeApp(L, 'Lesen');
  await L.post(`/klassen/${cls7b}/apps`, { app: read.id });
  const t = await h.token(B, read, cls7b);
  await B.api(read, t.token, 'save.set', { key: 'seite', value: 12 });
  await L.page(`/klassen/${cls7b}`);
  await L.post(`/klassen/${cls7b}/apps/${read.id}/entfernen`);
  assert.equal((await B.get(`/meine-daten/app/${read.id}`)).status, 200);
  assert.equal((await M.get(`/meine-daten/app/${read.id}`)).status, 404, 'a classmate without data cannot open it any more');

  // Readable labels from schulhub.json, achievement titles, progress.
  const mt = await h.token(M, quiz, cls7b);
  await M.api(quiz, mt.token, 'results.add', { title: 'Runde 1', score: 3, maxScore: 4, details: { richtig: 3, falsch: 1 } });
  await M.api(quiz, mt.token, 'achievements.unlock', { id: 'erste-runde' });
  await M.api(quiz, mt.token, 'progress.set', { value: 0.4, label: 'Wörter' });
  await M.api(quiz, mt.token, 'save.set', { key: 'stand', value: { constructor: 1, toString: 2 } });
  const page = (await M.get(`/meine-daten/app/${quiz.id}`)).text;
  for (const s of ['Richtig beantwortet', 'Erste Runde', '40 %', 'Runde 1', 'bild-1']) assert.ok(page.includes(s), s);
  assert.ok(!page.includes('native code'), 'keys like "constructor" stay plain keys');
  assert.ok(!page.includes('Ben Hoffmann'));

  // Deleting there removes only the person's own rows.
  await M.page(`/meine-daten/app/${quiz.id}`);
  const benBefore = h.db.get('SELECT COUNT(*) AS n FROM user_files WHERE user_id = ?', ben.id).n;
  assert.equal((await M.post('/meine-daten/app/gibt-es-nicht/loeschen')).status, 404);
  assert.equal((await M.post(`/meine-daten/app/${quiz.id}/loeschen`)).status, 303);
  for (const table of ['saves', 'results', 'progress', 'achievements', 'user_files', 'plays']) {
    assert.equal(h.db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE app_id = ? AND user_id = ?`, quiz.id, mia.id).n, 0, table);
  }
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM user_files WHERE user_id = ?', ben.id).n, benBefore, "Ben's file is untouched");
});

test('Meine Daten: der Export enthält alles Neue und keine fremden E-Mail-Adressen', async () => {
  const mt = await h.token(M, quiz, cls7b);
  await M.api(quiz, mt.token, 'progress.set', { value: 0.5 });
  await M.api(quiz, mt.token, 'achievements.unlock', { id: 'erste-runde' });
  await M.api(quiz, mt.token, 'save.set', { key: 'k', value: 'mein Stand' });
  await appRequest(M, quiz, 'PUT', '/_hub/files/zeichnung', { token: mt.token, body: PNG(3), type: 'image/png' });
  const bt = await h.token(B, quiz, cls7b);
  await B.api(quiz, bt.token, 'save.set', { key: 'k', value: 'Bens geheimer Stand' });
  const now = Date.now();
  h.db.run("INSERT INTO assignments (id, class_id, app_id, title, starts_at, created_by, created_at) VALUES ('as-1', ?, ?, 'Vokabeln üben', ?, ?, ?)", cls7b, quiz.id, now, lehmann.id, now);
  h.db.run("INSERT INTO assignment_done (assignment_id, user_id, done_at) VALUES ('as-1', ?, ?)", mia.id, now);
  h.db.run("INSERT INTO feedback (id, class_id, student_id, author_id, app_id, body, created_at) VALUES ('fb-1', ?, ?, ?, ?, 'Gut gemacht, Mia!', ?)", cls7b, mia.id, lehmann.id, quiz.id, now);
  h.db.run("INSERT INTO feedback (id, class_id, student_id, author_id, body, created_at) VALUES ('fb-2', ?, ?, ?, 'Nur für Ben', ?)", cls7b, ben.id, lehmann.id, now);
  h.hub.ctx.services.notify([mia.id], 'aufgabe', 'Neue Aufgabe: Vokabeln üben', '/start');
  await M.page('/start');
  await M.post(`/apps/${quiz.id}/favorit`, { zurueck: '/start' });
  await M.post(`/apps/${miaApp.id}/kommentare`, { text: 'Mein Kommentar' });

  const res = await M.get('/meine-daten/export');
  assert.match(res.headers['content-disposition'], /^attachment/);
  const ex = res.json();
  assert.equal(ex.konto.name, 'Mia Schmidt');
  const q = ex.appDaten.find((a) => a.app === 'Quiz');
  assert.equal(q.fortschritt.wert, 0.5);
  assert.deepEqual(q.erfolge.map((e) => e.titel), ['Erste Runde'], 'achievement titles from schulhub.json');
  assert.ok(q.dateien.some((f) => f.name === 'zeichnung' && f.art === 'image/png' && f.groesse === PNG(3).length && f.herunterladen.endsWith(`/meine-daten/app/${quiz.id}/datei/zeichnung`)));
  assert.equal(q.spielstaende.find((s) => s.schluessel === 'k').wert, 'mein Stand');
  assert.deepEqual(ex.rueckmeldungen.map((f) => [f.text, f.von]), [['Gut gemacht, Mia!', 'Herr Lehmann']], 'feedback author by name only');
  assert.deepEqual(ex.erledigteAufgaben.map((d) => d.aufgabe), ['Vokabeln üben']);
  assert.ok(ex.favoriten.some((f) => f.app === 'Quiz'));
  assert.ok(ex.mitteilungen.some((m) => m.text === 'Neue Aufgabe: Vokabeln üben'));
  assert.ok(ex.kommentare.some((c) => c.text === 'Mein Kommentar'));
  assert.ok(ex.protokoll.length && ex.protokoll.every((p) => Object.keys(p).join() === 'vorgang,zeitpunkt'), 'audit entries without details about others');
  for (const other of [admin, lehmann, kaya, yilmaz, ben, lena]) {
    assert.ok(!res.text.includes(other.email), `no e-mail address of ${other.name}`);
    assert.ok(!res.text.includes(other.id), `no id of ${other.name}`);
  }
  assert.ok(!res.text.includes('Bens geheimer Stand') && !res.text.includes('Nur für Ben'));
  assert.ok(res.text.includes(mia.email), 'her own address is in it');
});

test('Konto löschen: nur mit genau dem Wort LÖSCHEN, danach zurück zur Startseite', async () => {
  const user = h.addUser('Wort Test', 'student');
  const b = await h.browser().login(user);
  await b.page('/meine-daten');
  for (const word of ['löschen', 'Löschen', 'LOESCHEN', 'LÖSCHEN!', 'LÖSCHEN JETZT', '']) {
    assert.equal((await b.post('/meine-daten/konto-loeschen', { bestaetigung: word })).status, 400, word);
  }
  assert.ok(h.db.get('SELECT 1 AS ok FROM users WHERE id = ?', user.id));
  const res = await b.post('/meine-daten/konto-loeschen', { bestaetigung: ' LÖSCHEN ' }); // decomposed Ö, spaces around
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/?geloescht=1');
  assert.equal(h.db.get('SELECT 1 AS ok FROM users WHERE id = ?', user.id), undefined);
});

// ---------------------------------------------------------------------- admin

test('Verwaltung: jede Seite und jede Aktion gibt es für andere nicht', async () => {
  const gets = ['/admin', '/admin?q=Mia', '/admin/konten', `/admin/konten/${ben.id}`, '/admin/klassen', '/admin/klassen?archiv=1', '/admin/apps', '/admin/apps?filter=update', '/admin/protokoll', '/admin/aufbewahrung', '/admin/sicherung'];
  const posts = [
    [`/admin/nutzer/${ben.id}/rolle`, { rolle: 'admin' }], [`/admin/nutzer/${ben.id}/sperren`, { an: '1' }], [`/admin/nutzer/${ben.id}/loeschen`, {}],
    [`/admin/klassen/${cls7b}/archivieren`, {}], [`/admin/klassen/${cls7b}/wiederherstellen`, {}], [`/admin/klassen/${cls7b}/loeschen`, {}],
    ['/admin/aufbewahrung', { 'retention.auditDays': '30' }], ['/admin/sicherung', {}], ['/admin/datenbank-pruefen', {}],
  ];
  for (const who of [M, L, Y]) {
    for (const url of gets) assert.equal((await who.get(url)).status, 404, url);
    for (const [url, fields] of posts) assert.equal((await who.post(url, fields)).status, 404, url);
  }
  assert.equal(h.db.get('SELECT role FROM users WHERE id = ?', ben.id).role, 'student');
  assert.equal(h.db.get('SELECT disabled FROM users WHERE id = ?', ben.id).disabled, 0);
  assert.equal(h.db.get('SELECT archived_at FROM classes WHERE id = ?', cls7b).archived_at, null);
  assert.equal(h.hub.ctx.settings.get('retention.auditDays'), 365);
  for (const url of gets) assert.equal((await A.get(url.replace('?q=Mia', ''))).status, 200, url);
  assert.equal((await A.get('/admin?q=Mia')).headers.location, '/admin/konten?q=Mia', 'the old account search moved');
});

test('Verwaltung: Konten mit Filtern und Seiten, Rollen mit klaren Folgen, Klassen archivieren', async () => {
  for (let i = 0; i < 55; i++) h.addUser(`Zz Testkonto ${String(i).padStart(2, '0')}`, 'student');
  const rows = (text) => (text.match(/class="admin-name"/g) || []).length;
  let text = (await A.get('/admin/konten?q=Zz+Testkonto')).text;
  assert.equal(rows(text), 50, '50 per page');
  assert.ok(text.includes('Seite 1 von 2'));
  text = (await A.get('/admin/konten?q=Zz+Testkonto&seite=2')).text;
  assert.equal(rows(text), 5);
  text = (await A.get('/admin/konten?rolle=teacher')).text;
  assert.ok(text.includes('Herr Lehmann') && !text.includes('Mia Schmidt'));
  h.db.run('UPDATE users SET flagged_inactive_at = ? WHERE id = ?', Date.now() - 3 * DAY, lena.id);
  text = (await A.get('/admin/konten?status=inaktiv')).text;
  assert.equal(rows(text), 1);
  assert.ok(text.includes('Lena Wagner') && text.includes('inaktiv markiert'));
  assert.ok((await A.get('/admin/aufbewahrung')).text.includes(`/admin/nutzer/${lena.id}/loeschen`), 'flagged accounts can be deleted there');
  assert.ok(h.db.get('SELECT 1 AS ok FROM users WHERE id = ?', lena.id), '… but are never deleted automatically');
  h.db.run('UPDATE users SET flagged_inactive_at = NULL WHERE id = ?', lena.id);
  assert.equal((await A.get('/admin/konten?q=%25')).status, 200);

  // The account page states the consequences before anything happens.
  text = (await A.get(`/admin/konten/${ben.id}`)).text;
  assert.ok(text.includes('zum Admin machen?') && text.includes('alles ändern und löschen'), 'promotion to admin says what it means');
  assert.ok(text.includes('wird sofort abgemeldet'), 'blocking says what happens');
  assert.match(text, /data-danger="1"[^>]*>[\s\S]*?Konto endgültig löschen/, 'deleting is a danger action');
  text = (await A.get(`/admin/konten/${admin.id}`)).text;
  assert.ok(text.includes('einzige aktive Admin-Konto') && !text.includes(`/admin/nutzer/${admin.id}/rolle`), 'the last admin cannot be demoted here');
  await A.page(`/admin/konten/${ben.id}`);
  assert.equal((await A.post(`/admin/nutzer/${admin.id}/rolle`, { rolle: 'teacher' })).status, 400);
  assert.equal((await A.post(`/admin/nutzer/${admin.id}/sperren`, { an: '1' })).status, 400);
  const r = await A.post(`/admin/nutzer/${ben.id}/sperren`, { an: '1', zurueck: 'https://evil.example/' });
  assert.equal(r.headers.location, `/admin/konten/${ben.id}`, 'only admin pages as return target');
  assert.equal((await B.get('/start')).status, 302, 'blocked: signed out at once');
  await A.post(`/admin/nutzer/${ben.id}/sperren`, { an: '0' });
  B = await h.browser().login(ben);

  // Classes: archive and restore (admin passes canManageClass), each step in the log.
  await L.post('/klassen', { name: 'Archiv-Test' });
  const c = teacherClass(lehmann.id, 'Archiv-Test');
  await A.page('/admin/klassen');
  assert.equal((await A.post(`/admin/klassen/${c}/archivieren`)).status, 303);
  assert.ok(h.db.get('SELECT archived_at FROM classes WHERE id = ?', c).archived_at);
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM join_codes WHERE class_id = ?', c).n, 0, 'nobody can join any more');
  assert.equal((await A.post(`/admin/klassen/${c}/archivieren`)).status, 400, 'twice is refused');
  assert.ok((await A.get('/admin/klassen?archiv=1')).text.includes('Archiv-Test'));
  assert.ok(!(await A.get('/admin/klassen')).text.includes('Archiv-Test'));
  assert.equal((await A.post(`/admin/klassen/${c}/wiederherstellen`)).status, 303);
  assert.equal(h.db.get('SELECT archived_at FROM classes WHERE id = ?', c).archived_at, null);
  assert.equal((await A.post(`/admin/klassen/${c}/loeschen`)).status, 303);
  assert.equal(h.db.get('SELECT 1 AS ok FROM classes WHERE id = ?', c), undefined);
  assert.equal((await A.post('/admin/klassen/gibt-es-nicht/archivieren')).status, 404);
  for (const action of ['klasse_archiviert', 'klasse_wiederhergestellt', 'klasse_geloescht']) {
    assert.ok(h.db.get("SELECT 1 AS ok FROM audit_log WHERE action = ? AND target = 'Archiv-Test'", action), action);
  }
});

test('Verwaltung: Aufbewahrung nur mit gültigen Fristen, alles oder nichts; Datenbank prüfen', async () => {
  const { settings } = h.hub.ctx;
  await A.page('/admin/aufbewahrung');
  let r = await A.post('/admin/aufbewahrung', { 'retention.auditDays': '400', 'retention.archivedClassDays': '10', 'retention.inactiveFlagDays': '500' });
  assert.equal(r.status, 400);
  assert.equal(settings.get('retention.auditDays'), 365, 'one bad value: nothing is saved');
  r = await A.post('/admin/aufbewahrung', { 'retention.auditDays': '400', 'retention.archivedClassDays': '200', 'retention.inactiveFlagDays': '500', 'retention.unbekannt': '1' });
  assert.equal(r.status, 303);
  assert.deepEqual(['retention.auditDays', 'retention.archivedClassDays', 'retention.inactiveFlagDays'].map((k) => settings.get(k)), [400, 200, 500]);
  assert.ok(h.db.get("SELECT 1 AS ok FROM audit_log WHERE action = 'aufbewahrung_geaendert'"));
  await A.post('/admin/aufbewahrung', { 'retention.auditDays': '365', 'retention.archivedClassDays': '365', 'retention.inactiveFlagDays': '456' });

  r = await A.post('/admin/datenbank-pruefen');
  assert.equal(r.status, 303);
  assert.ok((await A.page('/admin')).text.includes('Die Datenbank ist in Ordnung.'));
  assert.ok(h.db.get("SELECT 1 AS ok FROM audit_log WHERE action = 'datenbank_geprueft'"));
});

test('Protokoll: jeder Vorgang auf Deutsch, Rollen auf Deutsch, Filter nach Vorgang, Person und Zeitraum', async () => {
  const codes = auditCodesInSource();
  assert.ok(codes.size >= 25, `found ${codes.size} codes`);
  const missing = [...codes].filter((c) => !Object.hasOwn(AUDIT_LABELS, c));
  assert.deepEqual(missing, [], `Audit-Codes ohne deutsche Beschriftung (in src/auditLabels.js ergänzen): ${missing.join(', ')}`);
  assert.ok(Object.values(AUDIT_LABELS).every((l) => typeof l === 'string' && l.length > 3));

  const cells = (text, label) => [...text.matchAll(new RegExp(`data-label="${label}"><span class="cell">([^<]*)<`, 'g'))].map((m) => m[1]);
  let text = (await A.get('/admin/protokoll')).text;
  assert.ok(cells(text, 'Vorgang').includes('Klasse angelegt'));
  assert.ok(cells(text, 'Wer').includes('Herr Lehmann (Lehrkraft)'));
  assert.ok(!text.includes('(teacher)') && !text.includes('(student)'));

  text = (await A.get('/admin/protokoll?aktion=klasse_erstellt')).text;
  assert.ok(cells(text, 'Vorgang').length >= 2);
  assert.ok(cells(text, 'Vorgang').every((v) => v === 'Klasse angelegt'));
  text = (await A.get('/admin/protokoll?person=Kaya')).text;
  const who = cells(text, 'Wer');
  assert.ok(who.length && who.every((w) => w.includes('Kaya')), 'only entries by (or about) that person');
  text = (await A.get('/admin/protokoll?von=2000-01-01&bis=2000-01-02')).text;
  assert.equal(cells(text, 'Vorgang').length, 0);
  text = (await A.get(`/admin/protokoll?von=${dayKey(Date.now())}&bis=${dayKey(Date.now())}`)).text;
  assert.ok(cells(text, 'Vorgang').length > 0, 'today');
  assert.equal((await A.get(`/admin/protokoll?aktion=${encodeURIComponent('<script>')}&von=gestern&vor=abc`)).status, 200);

  h.hub.ctx.services.audit(admin, 'zauberei', 'Test');
  assert.ok(cells((await A.get('/admin/protokoll')).text, 'Vorgang').includes('zauberei'), 'unknown codes are shown as they are');
  for (let i = 0; i < 60; i++) h.hub.ctx.services.audit(null, 'zauberei', `Nr. ${i}`);
  text = (await A.get('/admin/protokoll?aktion=zauberei')).text;
  assert.equal(cells(text, 'Vorgang').length, 50);
  const older = /href="(\/admin\/protokoll\?[^"]*vor=\d+[^"]*)"/.exec(text);
  assert.ok(older, 'a link to older entries');
  assert.equal(cells((await A.get(older[1].replace(/&amp;/g, '&'))).text, 'Vorgang').length, 11);
});

// -------------------------------------------------------------------- backups

let backupZip;

test('Sicherung: nur der Admin, nur per POST mit CSRF; das Archiv enthält nur erlaubte Pfade und eine gültige Datenbank', async () => {
  const mt = await h.token(M, quiz, cls7b);
  await appRequest(M, quiz, 'PUT', '/_hub/files/fuer-sicherung', { token: mt.token, body: PNG(9), type: 'image/png' });
  assert.equal((await M.post('/admin/sicherung')).status, 404);
  const page = await A.page('/admin/sicherung');
  assert.match(page.headers['content-type'], /text\/html/, 'GET only shows the page');
  assert.equal((await A.post('/admin/sicherung', {}, { withCsrf: false })).status, 403);
  assert.equal((await A.post('/admin/sicherung', {}, { headers: { origin: 'https://evil.example' } })).status, 403);

  const res = await A.post('/admin/sicherung');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/zip');
  assert.match(res.headers['content-disposition'], /^attachment; filename="schulhub-sicherung-\d{4}-\d{2}-\d{2}-\d{4}\.zip"$/);
  backupZip = res.buffer;
  const entries = await readZip(res.buffer);
  const names = entries.map((e) => e.name);
  assert.ok(names.every(isEntryName), `only allowed paths: ${names.filter((n) => !isEntryName(n))}`);
  assert.equal(names.filter((n) => n === 'hub.sqlite').length, 1);
  assert.ok(!names.some((n) => /secret|tmp|wal|shm|\.\./.test(n)), 'no secrets, no temporary files');
  const blobs = entries.filter((e) => e.name.startsWith('blobs/'));
  const files = entries.filter((e) => e.name.startsWith('userfiles/'));
  assert.ok(blobs.length >= 3 && files.length >= 1);
  for (const e of [...blobs, ...files]) assert.equal(sha256(e.data), e.name.split('/')[2], e.name);
  assert.ok(files.some((e) => e.data.equals(PNG(9))));

  const dir = tmpDir('schulhub-backup-check-');
  try {
    const file = path.join(dir, 'hub.sqlite');
    fs.writeFileSync(file, entries.find((e) => e.name === 'hub.sqlite').data);
    const copy = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM users').get().n, h.db.get('SELECT COUNT(*) AS n FROM users').n);
    } finally {
      copy.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(lastBackupAt(h.db) > Date.now() - 60_000, 'time of the last backup is kept');
  assert.ok(h.db.get("SELECT 1 AS ok FROM audit_log WHERE action = 'sicherung_heruntergeladen' AND actor_id = ?", admin.id));
  assert.deepEqual(fs.readdirSync(path.join(h.config.dataDir, 'tmp')).filter((n) => n.startsWith('sicherung-')), [], 'temporary copies are removed');
});

test('Wiederherstellung: feindliche Archive werden abgelehnt, ohne dass etwas geschrieben wird', async () => {
  assert.ok(backupZip, 'needs the backup from the previous test');
  const work = tmpDir('schulhub-restore-');
  try {
    const goodDb = (await readZip(backupZip)).find((e) => e.name === 'hub.sqlite').data;
    const dbVariant = (name, sql) => {
      const db = openDb(path.join(work, `${name}.sqlite`));
      db.run(sql);
      const out = path.join(work, `${name}-copy.sqlite`);
      db.snapshot(out);
      db.close();
      return fs.readFileSync(out);
    };
    const withTrigger = dbVariant('trigger', "CREATE TRIGGER evil AFTER INSERT ON users BEGIN UPDATE users SET role = 'admin'; END");
    const tooNew = dbVariant('neu', 'PRAGMA user_version = 99');
    const blob = Buffer.from('Inhalt einer App-Datei');
    const sha = sha256(blob);
    const ok = (name = 'blobs') => ({ name: `${name}/${sha.slice(0, 2)}/${sha}`, data: blob });
    const big = Buffer.alloc(4000, 7);
    const db = { name: 'hub.sqlite', data: goodDb };
    const hostile = {
      traversal: [db, { name: '../evil.txt', data: 'x' }],
      traversalInside: [db, { name: `blobs/../../${sha}`, data: blob }],
      absolute: [db, { name: '/tmp/evil.txt', data: 'x' }],
      backslash: [db, { name: `blobs\\${sha.slice(0, 2)}\\${sha}`, data: blob }],
      otherName: [db, { name: 'notizen.txt', data: 'x' }],
      databaseCopy: [db, { name: 'hub.sqlite-wal', data: 'x' }],
      notHex: [db, { name: `blobs/zz/${'z'.repeat(64)}`, data: blob }],
      wrongFolder: [db, { name: `blobs/${sha.startsWith('00') ? '11' : '00'}/${sha}`, data: blob }],
      otherStore: [db, { name: `secrets/${sha.slice(0, 2)}/${sha}`, data: blob }],
      directory: [db, { name: 'blobs/', data: '' }],
      symlink: [db, { ...ok(), data: '/etc/passwd', mode: 0o120777 }],
      wrongHash: [db, { ...ok('userfiles'), data: 'verändert' }],
      lyingSize: [db, { name: `userfiles/${sha256(big).slice(0, 2)}/${sha256(big)}`, data: big, fakeSize: 10 }],
      duplicate: [db, db],
      noDatabase: [ok()],
      notSqlite: [{ name: 'hub.sqlite', data: 'kein SQLite' }],
      trigger: [{ name: 'hub.sqlite', data: withTrigger }],
      newerVersion: [{ name: 'hub.sqlite', data: tooNew }],
    };
    for (const [name, entries] of Object.entries(hostile)) {
      const zipFile = path.join(work, `${name}.zip`);
      fs.writeFileSync(zipFile, makeZip(entries));
      const target = fs.mkdtempSync(path.join(work, 'ziel-'));
      await assert.rejects(restoreBackup({ zipFile, dataDir: target }), RestoreError, name);
      assert.deepEqual(fs.readdirSync(target), [], `${name}: nothing written`);
    }
    assert.ok(!fs.existsSync(path.join(work, 'evil.txt')) && !fs.existsSync('/tmp/evil.txt'), 'nothing outside the data folder');
    const notZip = path.join(work, 'kein.zip');
    fs.writeFileSync(notZip, 'das ist kein zip');
    await assert.rejects(restoreBackup({ zipFile: notZip, dataDir: fs.mkdtempSync(path.join(work, 'ziel-')) }), /kein gültiges ZIP/);

    // The real backup: restores into an empty folder; a full folder needs --force and keeps the old data.
    const zipFile = path.join(work, 'echt.zip');
    fs.writeFileSync(zipFile, backupZip);
    const target = fs.mkdtempSync(path.join(work, 'echt-'));
    const result = await restoreBackup({ zipFile, dataDir: target });
    assert.equal(result.users, h.db.get('SELECT COUNT(*) AS n FROM users').n);
    assert.deepEqual(result.missing, { blobs: 0, userfiles: 0 }, 'every referenced file is in the backup');
    const restored = openDb(path.join(target, 'hub.sqlite'));
    try {
      assert.equal(restored.get('SELECT COUNT(*) AS n FROM apps').n, h.db.get('SELECT COUNT(*) AS n FROM apps').n);
      assert.equal(restored.get('SELECT COUNT(*) AS n FROM sessions').n, 0, 'old sessions do not come back');
      const f = restored.get('SELECT sha256 FROM app_files LIMIT 1');
      assert.equal(sha256(fs.readFileSync(path.join(target, 'blobs', f.sha256.slice(0, 2), f.sha256))), f.sha256);
    } finally {
      restored.close();
    }
    await assert.rejects(restoreBackup({ zipFile, dataDir: target }), /nicht leer/);
    const again = await restoreBackup({ zipFile, dataDir: target, force: true });
    assert.ok(again.aside && fs.existsSync(path.join(again.aside, 'hub.sqlite')), 'the previous data is moved aside, not deleted');

    // The command line tool says what went wrong and exits with an error.
    const cli = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'restore.js'), path.join(work, 'traversal.zip'), '--data', fs.mkdtempSync(path.join(work, 'cli-'))], { encoding: 'utf8' });
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /Abgebrochen/);
    const usage = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'restore.js')], { encoding: 'utf8' });
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /Verwendung/);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});
