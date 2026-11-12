'use strict';
// Privacy rules for minors that go beyond "who may open what":
//  - leaderboards never show a student's name to people outside their classes
//  - a preview (owner trying a version, teacher reviewing a submission) never
//    writes real data and never counts as a use of the app

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startHub } = require('./helpers');

let h;
let admin, lehmann, yilmaz, kaya, mia, ben, lena;
let A, L, Y, K, M, B, LE;
let cls7b, cls9a, game, miaApp;

const teacherClass = (userId) => h.db.get("SELECT class_id AS id FROM class_members WHERE user_id = ? AND role = 'teacher'", userId).id;
const joinCode = (classId) => h.db.get("SELECT code FROM join_codes WHERE class_id = ? AND role = 'student'", classId).code;
const names = (res) => res.json().result.entries.map((e) => e.name);

before(async () => {
  h = await startHub();
  admin = h.addUser('Anna Adler', 'admin');
  lehmann = h.addUser('Herr Lehmann', 'teacher');
  yilmaz = h.addUser('Frau Yilmaz', 'teacher'); // teaches no class
  kaya = h.addUser('Herr Kaya', 'teacher'); // teaches 9a
  mia = h.addUser('Mia Schmidt', 'student');
  ben = h.addUser('Ben Hoffmann', 'student');
  lena = h.addUser('Lena Wagner', 'student');
  [A, L, Y, K, M, B, LE] = await Promise.all([admin, lehmann, yilmaz, kaya, mia, ben, lena].map((u) => h.browser().login(u)));

  await L.post('/klassen', { name: '7b' });
  cls7b = teacherClass(lehmann.id);
  for (const b of [M, B]) await b.post(`/beitreten/${joinCode(cls7b)}`);
  await K.post('/klassen', { name: '9a' });
  cls9a = teacherClass(kaya.id);
  await LE.post(`/beitreten/${joinCode(cls9a)}`);

  game = await h.makeApp(L, 'Sternenspiel', { 'index.html': '<h1>Spiel</h1>' });
  await L.post(`/klassen/${cls7b}/apps`, { app: game.id });
  await A.page(`/apps/${game.id}`);
  assert.equal((await A.post(`/apps/${game.id}/schulweit`, { an: '1' })).status, 303);

  miaApp = await h.makeApp(M, 'Mias Malprogramm', { 'index.html': '<h1>Mia</h1>' });
  await M.page(`/apps/${miaApp.id}`);
  await M.post(`/apps/${miaApp.id}/einreichen`, { klasse: cls7b });
});
after(() => h.stop());

test('Bestenliste: Namen sehen nur Personen aus derselben Klasse – alle anderen sehen „Anonym“', async () => {
  const miaT = await h.token(M, game, cls7b);
  const benT = await h.token(B, game, cls7b);
  const lenaT = await h.token(LE, game); // school-wide release, no class context
  const yilmazT = await h.token(Y, game);
  const lehmannT = await h.token(L, game, cls7b);
  assert.ok(lenaT && yilmazT, 'school-wide app is playable for everyone');

  await M.api(game, miaT.token, 'scores.submit', { board: 'p', score: 30 });
  await B.api(game, benT.token, 'scores.submit', { board: 'p', score: 20 });
  await LE.api(game, lenaT.token, 'scores.submit', { board: 'p', score: 10 });

  // A teacher without a class and a student of another class: nobody's name.
  assert.deepEqual(names(await Y.api(game, yilmazT.token, 'scores.top', { board: 'p' })), ['Anonym', 'Anonym', 'Anonym']);
  assert.deepEqual(names(await LE.api(game, lenaT.token, 'scores.top', { board: 'p' })), ['Anonym', 'Anonym', 'Lena Wagner'], 'only her own name');

  // Classmates see each other's names, but not the student from 9a – even in the school-wide list.
  assert.deepEqual(names(await B.api(game, benT.token, 'scores.top', { board: 'p' })), ['Mia Schmidt', 'Ben Hoffmann'], 'class list');
  assert.deepEqual(names(await B.api(game, benT.token, 'scores.top', { board: 'p', scope: 'all' })), ['Mia Schmidt', 'Ben Hoffmann', 'Anonym']);
  // The class's own teacher sees the names of the class, not the 9a student.
  assert.deepEqual(names(await L.api(game, lehmannT.token, 'scores.top', { board: 'p', scope: 'all' })), ['Mia Schmidt', 'Ben Hoffmann', 'Anonym']);

  // Choosing anonymity hides the name even from classmates, but never from yourself.
  await M.page('/meine-daten');
  await M.post('/meine-daten/anonym', { anonym: '1' });
  assert.deepEqual(names(await B.api(game, benT.token, 'scores.top', { board: 'p' })), ['Anonym', 'Ben Hoffmann']);
  assert.deepEqual(names(await M.api(game, miaT.token, 'scores.top', { board: 'p' })), ['Mia Schmidt', 'Ben Hoffmann']);
  await M.post('/meine-daten/anonym', {});

  // No e-mail address or real id ever reaches the app in a leaderboard.
  const raw = (await Y.api(game, yilmazT.token, 'scores.top', { board: 'p', scope: 'all' })).text;
  for (const u of [mia, ben, lena]) {
    assert.ok(!raw.includes(u.email) && !raw.includes(u.id), 'no e-mail or user id in leaderboards');
  }
});

test('Vorschau: eine Lehrkraft, die eine eingereichte App prüft, schreibt keine echten Daten', async () => {
  const version = miaApp.published_version_id;
  const t = await h.token(L, miaApp, cls7b, version);
  assert.equal(t.mode, 'preview');

  const call = (method, params) => L.api(miaApp, t.token, method, params).then((r) => r.json());
  assert.equal((await call('save.set', { key: 'bild-1', value: [1, 2, 3] })).ok, true);
  assert.deepEqual((await call('save.get', { key: 'bild-1' })).result, [1, 2, 3], 'the preview can read its own writes');
  assert.equal((await call('results.add', { title: 'Probe', score: 3, maxScore: 5, details: { a: 1 } })).ok, true);
  assert.equal((await call('results.mine', {})).result.length, 1);
  assert.equal((await call('scores.submit', { board: 'b', score: 99 })).ok, true);
  assert.equal((await call('class.set', { key: 'woerter', value: ['hund'] })).ok, true, 'teacher may write class data …');

  const count = (sql, ...p) => h.db.get(sql, ...p).n;
  assert.equal(count('SELECT COUNT(*) AS n FROM saves WHERE app_id = ?', miaApp.id), 0, 'no real save');
  assert.equal(count('SELECT COUNT(*) AS n FROM results WHERE app_id = ?', miaApp.id), 0, 'no real result');
  assert.equal(count('SELECT COUNT(*) AS n FROM scores WHERE app_id = ?', miaApp.id), 0, 'no real score');
  assert.equal(count('SELECT COUNT(*) AS n FROM shared_data WHERE app_id = ?', miaApp.id), 0, '… but only in memory');
  assert.equal(count('SELECT COUNT(*) AS n FROM plays WHERE app_id = ? AND user_id = ?', miaApp.id, lehmann.id), 0, 'a preview is not a play');

  // A live token of the same person sees none of it.
  const ownerLive = await h.token(M, miaApp); // Mia plays her own published app for real
  assert.equal(ownerLive.mode, 'live');
  assert.equal((await M.api(miaApp, ownerLive.token, 'save.get', { key: 'bild-1' })).json().result, null);
  assert.equal(count('SELECT COUNT(*) AS n FROM plays WHERE app_id = ? AND user_id = ?', miaApp.id, mia.id), 1, 'real use is counted');
});

test('Vorschau: echte Klassen-Daten werden gelesen, aber nie überschrieben; die Bestenliste zeigt keine echten Spieler', async () => {
  // Live: the teacher sets the class word list, Ben plays for real.
  const live = await h.token(L, game, cls7b);
  await L.api(game, live.token, 'class.set', { key: 'woerter', value: ['hund'] });
  const ben7b = await h.token(B, game, cls7b);
  await B.api(game, ben7b.token, 'scores.submit', { board: 'zeit', score: 12 });

  const p = await h.token(L, game, cls7b, game.published_version_id);
  assert.equal(p.mode, 'preview');
  const call = (method, params) => L.api(game, p.token, method, params).then((r) => r.json());
  assert.deepEqual((await call('class.get', { key: 'woerter' })).result, ['hund'], 'reads the real list');
  await call('class.set', { key: 'woerter', value: ['katze'] });
  await call('class.remove', { key: 'woerter' });
  assert.equal((await call('class.get', { key: 'woerter' })).result, null, 'deleted inside the preview');
  assert.deepEqual((await B.api(game, ben7b.token, 'class.get', { key: 'woerter' })).json().result, ['hund'], 'the real list is untouched');

  const top = (await call('scores.top', { board: 'zeit' })).result;
  assert.deepEqual(top.entries, [], 'no real players in a preview leaderboard');

  // Still no way around the rules inside a preview.
  const s = await h.token(M, miaApp, cls7b, miaApp.published_version_id);
  assert.equal((await M.api(miaApp, s.token, 'class.set', { key: 'x', value: 1 })).json().error.code, 'forbidden', 'a student cannot write class data, not even in a preview');
});

test('Vorschau: das Vorschau-Kennzeichen im Token lässt sich nicht entfernen', async () => {
  const p = await h.token(L, game, cls7b, game.published_version_id);
  const [body, sig] = p.token.split('.');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  assert.equal(payload.p, 1);
  const forged = `${Buffer.from(JSON.stringify({ ...payload, p: 0 })).toString('base64url')}.${sig}`;
  const res = await L.api(game, forged, 'save.set', { key: 'x', value: 1 });
  assert.equal(res.status, 401);
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM saves WHERE app_id = ?', game.id).n, 0);
});

test('Vorschau: der Speicher im Arbeitsspeicher ist begrenzt', async () => {
  const { createPreviewStores } = require('../src/sdkStore');
  const stores = createPreviewStores({ maxBytes: 1000, maxStores: 2, maxTotalBytes: 1500 });
  const fakeDb = { get: () => null, all: () => [] };
  const user = { id: 'u1', name: 'X' };
  const s1 = stores.previewStore(fakeDb, { id: 'a1' }, user, 'k1');
  s1.savePut('a', '"x"', 900);
  assert.throws(() => s1.savePut('b', '"y"', 200), /voll/, 'per-store limit');
  stores.previewStore(fakeDb, { id: 'a1' }, user, 'k2').savePut('a', '"x"', 800);
  assert.ok(stores.size().bytes <= 1500, 'overall limit evicts the oldest preview');
  stores.previewStore(fakeDb, { id: 'a1' }, user, 'k3');
  assert.ok(stores.size().stores <= 2, 'number of previews is limited');
});
