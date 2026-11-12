'use strict';
// The example apps and the demo data (package E).
//
// Every example must pass the real upload validation, ship a manifest without
// errors or warnings, stay inside its own folder (no absolute paths, no
// foreign hosts) and never turn data into code or markup. The demo data that
// `npm run dev` creates must obey the same permission rules as real data.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startHub } = require('./helpers');
const { parseManifest, manifestOf } = require('../src/manifest');
const { seedDemo, WORDS_7B } = require('../src/seed');

const ROOT = path.join(__dirname, '..');
const EXAMPLES = path.join(ROOT, 'examples');
const FOLDERS = fs.readdirSync(EXAMPLES, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
const SDK = fs.readFileSync(path.join(ROOT, 'sdk', 'hub-sdk.js'));
const UI = fs.readFileSync(path.join(ROOT, 'sdk', 'hub-ui.css'));
/** The app's own text files (the SDK copies are checked against sdk/ instead). */
const ownFiles = (folder) =>
  fs.readdirSync(path.join(EXAMPLES, folder)).filter((f) => /\.(html|css|js|json)$/.test(f) && f !== 'hub-sdk.js' && f !== 'hub-ui.css');
const read = (folder, file) => fs.readFileSync(path.join(EXAMPLES, folder, file), 'utf8');

test('Beispiel-Apps: alle sechs da, jede mit Pflichtdateien und den aktuellen Kopien von SDK und UI-Kit', () => {
  assert.deepEqual(FOLDERS, ['kopfrechnen', 'lernkarten', 'pixel-studio', 'quiz-werkstatt', 'sternenfaenger', 'vokabeltrainer']);
  for (const folder of FOLDERS) {
    const files = fs.readdirSync(path.join(EXAMPLES, folder));
    for (const required of ['index.html', 'style.css', 'schulhub.json', 'hub-sdk.js', 'hub-ui.css']) {
      assert.ok(files.includes(required), `${folder}: ${required} fehlt`);
    }
    assert.ok(files.includes('app.js') || files.includes('game.js'), `${folder}: app.js oder game.js fehlt`);
    assert.ok(fs.readFileSync(path.join(EXAMPLES, folder, 'hub-sdk.js')).equals(SDK), `${folder}: hub-sdk.js ist nicht die aktuelle Fassung aus sdk/ – bitte neu kopieren`);
    assert.ok(fs.readFileSync(path.join(EXAMPLES, folder, 'hub-ui.css')).equals(UI), `${folder}: hub-ui.css ist nicht die aktuelle Fassung aus sdk/ – bitte neu kopieren`);
    assert.ok(!files.includes('hub-ui-fonts'), `${folder}: Schriften liefert der Hub selbst aus`);
  }
});

test('Beispiel-Apps: schulhub.json ohne Fehler und ohne Warnungen', () => {
  for (const folder of FOLDERS) {
    const { manifest, errors, warnings } = parseManifest(read(folder, 'schulhub.json'));
    assert.deepEqual(errors, [], `${folder}: ${errors.join(' | ')}`);
    assert.deepEqual(warnings, [], `${folder}: ${warnings.join(' | ')}`);
    assert.ok(manifest.category, `${folder}: Fach fehlt`);
    assert.ok(manifest.achievements.length >= 3, `${folder}: zu wenige Erfolge`);
  }
  // The apps that record per-item results name their columns for the teacher view.
  for (const folder of ['vokabeltrainer', 'quiz-werkstatt', 'kopfrechnen', 'lernkarten', 'sternenfaenger']) {
    assert.ok(Object.keys(parseManifest(read(folder, 'schulhub.json')).manifest.results.labels).length >= 4, `${folder}: results.labels fehlen`);
  }
});

test('Beispiel-Apps: ruhen nur auf sich selbst – keine absoluten Pfade, keine fremden Adressen, kein eval, kein innerHTML', () => {
  for (const folder of FOLDERS) {
    for (const file of ownFiles(folder)) {
      const text = read(folder, file);
      const where = `${folder}/${file}`;
      // No address of another host anywhere, not even in a comment.
      assert.doesNotMatch(text, /\b(?:https?|ftp|wss?):\/\//i, `${where}: enthält eine Internet-Adresse`);
      assert.doesNotMatch(text, /['"`(]\s*\/\/[a-z0-9]/i, `${where}: enthält eine protokoll-relative Adresse`);
      if (file.endsWith('.html')) {
        assert.match(text, /^<!doctype html>\s*<html lang="de">/i, `${where}: <html lang="de"> fehlt`);
        assert.ok(text.includes('<meta name="viewport" content="width=device-width, initial-scale=1">'), `${where}: viewport fehlt`);
        assert.ok(text.includes('<link rel="stylesheet" href="hub-ui.css">'), `${where}: UI-Kit fehlt`);
        assert.ok(text.includes('<body class="hub-ui">'), `${where}: <body class="hub-ui"> fehlt`);
        assert.ok(text.includes('<script src="hub-sdk.js"></script>'), `${where}: SDK fehlt`);
        for (const [, attr, value] of text.matchAll(/\s(src|href|action|poster)\s*=\s*"([^"]*)"/gi)) {
          assert.match(value, /^(?![a-z][a-z0-9+.-]*:)(?!\/)(?!\\)[^\s]+$/i, `${where}: ${attr}="${value}" ist kein relativer Pfad`);
        }
        assert.doesNotMatch(text, /<script(?![^>]*\ssrc=)[^>]*>/i, `${where}: Skript im HTML statt in einer Datei`);
        assert.doesNotMatch(text, /\son[a-z]+\s*=/i, `${where}: on…=-Attribut (Skript im HTML)`);
        assert.doesNotMatch(text, /\sstyle\s*=/i, `${where}: style-Attribut`);
        assert.doesNotMatch(text, /<(iframe|object|embed|base)\b/i, `${where}: verbotenes Element`);
      }
      if (file.endsWith('.css')) {
        assert.doesNotMatch(text, /@import/i, `${where}: @import`);
        for (const [, url] of text.matchAll(/url\(\s*['"]?([^'")]*)/gi)) {
          assert.match(url, /^(?![a-z][a-z0-9+.-]*:)(?!\/)[^\s]+$/i, `${where}: url(${url}) ist kein relativer Pfad`);
        }
      }
      if (file.endsWith('.js')) {
        const code = text.replace(/^\s*\/\/.*$/gm, ''); // comments may explain what is NOT done
        const banned = [
          [/\beval\s*\(/, 'eval'], [/\bnew\s+Function\b|\bFunction\s*\(/, 'Function()'],
          [/\bset(?:Timeout|Interval)\s*\(\s*['"`]/, 'setTimeout mit Text'],
          [/\.(?:inner|outer)HTML\b|insertAdjacentHTML|document\.write|createContextualFragment|DOMParser/, 'HTML aus Text'],
          [/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|\bimport\s*\(/, 'eigene Netzwerkzugriffe (nur über das SDK)'],
          [/\blocalStorage\b|\bsessionStorage\b|indexedDB/, 'eigener Speicher (nur über das SDK)'],
          [/javascript:/i, 'javascript:-Adresse'], [/\b(?:window|top|parent)\.(?:open|location)\b/, 'Navigation aus dem Rahmen'],
          [/setAttribute\(\s*['"](?:style|on[a-z]+|src|href)['"]/i, 'gefährliches Attribut per setAttribute'],
        ];
        for (const [pattern, what] of banned) assert.doesNotMatch(code, pattern, `${where}: ${what}`);
      }
    }
  }
});

test('Beispiel-Apps: laufen durch die echte Upload-Prüfung (createApp, createVersion, addDirectory, finishVersion)', async () => {
  const h = await startHub();
  try {
    const owner = h.addUser('Frau Prüfer', 'teacher');
    const { services, uploads, db } = h.hub.ctx;
    for (const folder of FOLDERS) {
      const id = services.createApp(owner, { name: `Beispiel ${folder}`, emoji: '🎮', color: '0' });
      const app = db.get('SELECT * FROM apps WHERE id = ?', id);
      const version = services.createVersion(app);
      uploads.addDirectory(version, owner.id, path.join(EXAMPLES, folder));
      const report = services.finishVersion(owner, app, version);
      const problems = report.items.filter((i) => i.level === 'error' || i.level === 'warning');
      assert.deepEqual(problems, [], `${folder}: ${JSON.stringify(problems)}`);
      const stored = db.get('SELECT * FROM app_versions WHERE id = ?', version.id);
      assert.equal(stored.status, 'ready');
      const manifest = manifestOf(stored);
      assert.deepEqual(manifest, parseManifest(read(folder, 'schulhub.json')).manifest, `${folder}: gespeichertes Manifest weicht ab`);
      assert.equal(db.get('SELECT category FROM apps WHERE id = ?', id).category, manifest.category, `${folder}: Fach wurde nicht übernommen`);
      const paths = uploads.listFiles(version.id).map((f) => f.path);
      for (const f of ['index.html', 'schulhub.json']) assert.ok(paths.includes(f), `${folder}: ${f} nicht hochgeladen`);
    }
  } finally {
    await h.stop();
  }
});

// ------------------------------------------------------------------ demo data

let h;
let ctx;
let people;
let ids;
const browsers = {};

before(async () => {
  h = await startHub();
  ctx = h.hub.ctx;
  seedDemo(ctx);
  people = Object.fromEntries(h.db.all('SELECT * FROM users').map((u) => [u.oid, u]));
  const app = (name) => h.db.get('SELECT * FROM apps WHERE name = ?', name);
  ids = {
    cls: h.db.get("SELECT id FROM classes WHERE name = '7b Englisch'").id,
    vocab: app('Vokabeltrainer'), stars: app('Sternenfänger'), quiz: app('Quiz-Werkstatt'),
    math: app('Kopfrechnen'), pixel: app('Pixel-Studio'), cards: app('Lernkarten'),
  };
  for (const oid of ['dev-admin', 'dev-lehrer', 'dev-lehrerin', 'dev-mia', 'dev-ben', 'dev-lena']) browsers[oid] = await h.browser().login(people[oid]);
});
after(() => h.stop());

test('Demo-Daten: nur auf leerer Datenbank, alles über die normale Prüfung, Zustände wie beschrieben', () => {
  const users = h.db.get("SELECT COUNT(*) AS n FROM users").n;
  seedDemo(ctx); // second call: nothing happens
  assert.equal(h.db.get("SELECT COUNT(*) AS n FROM users").n, users);
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM apps').n, 6);

  for (const a of h.db.all('SELECT a.name, v.report, v.manifest FROM apps a JOIN app_versions v ON v.id = a.published_version_id')) {
    assert.ok(a.manifest, `${a.name}: kein Manifest`);
    assert.deepEqual(JSON.parse(a.report).items, [], `${a.name}: Prüfbericht nicht leer`);
  }
  const state = (app) => h.db.get('SELECT * FROM class_apps WHERE class_id = ? AND app_id = ?', ids.cls, app.id);
  for (const a of [ids.vocab, ids.stars, ids.quiz, ids.math]) assert.equal(state(a).status, 'approved');
  assert.equal(state(ids.pixel).status, 'pending');
  assert.equal(state(ids.pixel).request_state, 'waiting');
  assert.equal(ids.pixel.owner_id, people['dev-mia'].id);
  assert.equal(ids.cards.owner_id, people['dev-lehrerin'].id);
  assert.equal(ids.cards.schoolwide_version_id, ids.cards.published_version_id);

  // Results belong to the class they were made in; achievements exist in the app's manifest.
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM results WHERE class_id IS NOT ? ', ids.cls).n, 0);
  for (const r of h.db.all('SELECT ach.achievement, a.published_version_id FROM achievements ach JOIN apps a ON a.id = ach.app_id')) {
    const defs = manifestOf(h.db.get('SELECT manifest FROM app_versions WHERE id = ?', r.published_version_id)).achievements.map((d) => d.id);
    assert.ok(defs.includes(r.achievement), `Erfolg ${r.achievement} steht nicht in der schulhub.json`);
  }
  for (const p of h.db.all('SELECT value FROM progress')) assert.ok(p.value >= 0 && p.value <= 1);

  // The assignment: due in three days, Ben is done, Mia has started.
  const x = h.db.get('SELECT * FROM assignments WHERE class_id = ?', ids.cls);
  assert.equal(x.app_id, ids.vocab.id);
  assert.ok(Math.abs(x.due_at - (Date.now() + 3 * 86_400_000)) < 60_000);
  assert.equal(ctx.assignments.stateOf(x, people['dev-ben'].id), 'done');
  assert.equal(ctx.assignments.stateOf(x, people['dev-mia'].id), 'started');

  const fb = h.db.get('SELECT * FROM feedback');
  assert.ok(ctx.access.canReadFeedback(people['dev-mia'], fb));
  assert.ok(!ctx.access.canReadFeedback(people['dev-ben'], fb));
  const an = h.db.get('SELECT * FROM announcements');
  assert.equal(an.class_id, ids.cls);
  assert.ok(ctx.access.canSeeAnnouncement(people['dev-ben'], an));
  assert.ok(!ctx.access.canSeeAnnouncement(people['dev-lena'], an));
});

test('Demo-Daten: Lena (ohne Klasse) kommt weder an die 7b noch an ihre Ergebnisse noch an Mias App', async () => {
  const lena = browsers['dev-lena'];
  const { cls, vocab, pixel, quiz } = ids;
  const x = h.db.get('SELECT id FROM assignments').id;
  for (const url of [`/klassen/${cls}`, `/klassen/${cls}/apps/${vocab.id}/ergebnisse`, `/klassen/${cls}/apps/${vocab.id}/ergebnisse/${people['dev-mia'].id}`,
    `/klassen/${cls}/apps/${quiz.id}/ergebnisse`, `/apps/${pixel.id}/spielen`, `/apps/${vocab.id}/spielen?klasse=${cls}`, `/apps/${vocab.id}`, `/aufgaben/${x}`]) {
    assert.equal((await lena.get(url)).status, 404, url);
  }
  assert.equal(await h.token(lena, pixel), null);
  assert.equal(await h.token(lena, vocab, cls), null);
  assert.equal(await h.token(lena, vocab), null);
  assert.equal(await h.token(lena, pixel, cls, pixel.published_version_id), null);
  const names = ctx.access.visibleApps(people['dev-lena']).map((a) => a.name);
  assert.deepEqual(names, ['Lernkarten']);

  // Frau Yilmaz (teacher, but not of 7b) does not see the class either.
  const yilmaz = browsers['dev-lehrerin'];
  assert.equal((await yilmaz.get(`/klassen/${cls}`)).status, 404);
  assert.equal((await yilmaz.get(`/klassen/${cls}/apps/${vocab.id}/ergebnisse`)).status, 404);
  assert.equal(await h.token(yilmaz, vocab, cls), null);

  // Ben is in 7b, but Mia's app waits for review: not playable for him.
  assert.equal(await h.token(browsers['dev-ben'], pixel), null);
  assert.equal(await h.token(browsers['dev-ben'], pixel, cls), null);
});

test('Demo-Daten: die schulweite Freigabe ist für Lena spielbar – ohne Klasse, mit dem Standardstapel', async () => {
  const lena = browsers['dev-lena'];
  const { cards } = ids;
  assert.equal((await lena.get(`/apps/${cards.id}/spielen`)).status, 200);
  const t = await h.token(lena, cards);
  assert.ok(t);
  assert.equal(t.mode, 'live');
  assert.equal(t.class, null);
  const settings = (await lena.api(cards, t.token, 'settings.all')).json().result;
  assert.equal(settings.titel, 'Hauptstädte Europas');
  assert.equal(settings.karten.length, 20);
  assert.equal((await lena.api(cards, t.token, 'save.set', { key: 'kartei', value: { abc: [2, 1] } })).json().ok, true);
  assert.equal((await lena.api(cards, t.token, 'achievements.unlock', { id: 'erste-runde' })).json().result.new, true);
  // ... and what she stores there stays hers.
  const mia = await h.token(browsers['dev-mia'], cards);
  assert.equal((await browsers['dev-mia'].api(cards, mia.token, 'save.get', { key: 'kartei' })).json().result, null);
});

test('Demo-Daten: die Klasseneinstellungen sind gültig und kommen in der App an, die Daten der Klasse sind sichtbar', async () => {
  const { cls, vocab, quiz, pixel } = ids;
  const ben = browsers['dev-ben'];
  const t = await h.token(ben, vocab, cls);
  assert.equal(t.mode, 'live');
  const s = (await ben.api(vocab, t.token, 'settings.all')).json().result;
  // effectiveSettings falls back to the default for invalid values - so this proves the seeded list is valid.
  assert.deepEqual(s.woerter, WORDS_7B);
  assert.equal(s.runde, 8);
  const qs = (await ben.api(quiz, (await h.token(ben, quiz, cls)).token, 'settings.all')).json().result;
  assert.equal(qs.titel, 'Grammatik-Check Unit 3');
  assert.equal(qs.fragen.length, 8);

  // Leaderboard inside the class: classmates see each other's names.
  const top = (await ben.api(vocab, t.token, 'scores.top', { board: 'richtig' })).json().result;
  assert.deepEqual(top.entries.map((e) => e.name), ['Mia Schmidt', 'Ben Hoffmann']);
  // Students cannot change the teacher's settings or class data.
  assert.equal((await ben.api(vocab, t.token, 'class.set', { key: 'woerter', value: [['a', 'b']] })).json().error.code, 'forbidden');

  // The teacher sees both students' results; Mia's own app opens for her (live) and for the reviewer (preview only).
  const lehmann = browsers['dev-lehrer'];
  const page = await lehmann.get(`/klassen/${cls}/apps/${vocab.id}/ergebnisse`);
  assert.equal(page.status, 200);
  assert.ok(page.text.includes('Mia Schmidt') && page.text.includes('Ben Hoffmann'));
  const own = await h.token(browsers['dev-mia'], pixel);
  assert.equal(own.mode, 'live');
  assert.equal((await browsers['dev-mia'].api(pixel, own.token, 'save.get', { key: 'bild-1' })).json().result.length, 256);
  const review = await h.token(lehmann, pixel, cls, h.db.get('SELECT requested_version_id AS v FROM class_apps WHERE app_id = ?', pixel.id).v);
  assert.equal(review.mode, 'preview');
  assert.equal(await h.token(lehmann, pixel), null);
});
