'use strict';
// Attack tests for the findings of the independent security review that the
// lead fixed in the foundation: deleted accounts leave no names behind,
// archived classes cannot be written through the SDK, limits are per person
// (a school shares one address), submissions cannot flood teachers, files have
// an account cap, personal pages are not cached, results stay in their class,
// and archived classes do not reveal names on leaderboards.

const { test } = require('node:test');
const assert = require('node:assert/strict');
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
    const ziel = h.addUser('Marlene Zuckerbrot', 'student');
    const [A, L, Z] = await Promise.all([admin, lehmann, ziel].map((u) => h.browser().login(u)));
    await L.post('/klassen', { name: '7b' });
    const cls = teacherClass(h, lehmann.id);
    await Z.post(`/beitreten/${joinCode(h, cls)}`);
    // Account actions about her, by the admin (role there and back, block, unblock).
    await A.page(`/admin/konten/${ziel.id}`);
    for (const [path, fields] of [['rolle', { rolle: 'teacher' }], ['rolle', { rolle: 'student' }], ['sperren', { an: '1' }], ['sperren', {}]]) {
      assert.equal((await A.post(`/admin/nutzer/${ziel.id}/${path}`, fields)).status, 303, path);
    }
    // An older entry without a subject (written before subjects existed) and a notice naming her.
    h.hub.ctx.services.audit(admin, 'konto_gesperrt', 'Marlene Zuckerbrot');
    h.hub.ctx.services.notify([lehmann.id], 'kommentar', 'Marlene Zuckerbrot hat „Spiel“ kommentiert.', '/start', { subjectId: ziel.id });
    assert.ok(allText(h.db).some((t) => t.v.includes('Marlene Zuckerbrot')), 'precondition: the name is stored');

    await A.page('/admin'); // the admin sees the last message (a pending flash lives in the admin's own session)
    h.hub.ctx.services.deleteUser(admin, h.db.get('SELECT * FROM users WHERE id = ?', ziel.id));
    const left = allText(h.db).filter((t) => t.v.includes('Marlene') || t.v.includes(ziel.email) || t.v.includes(ziel.id));
    assert.deepEqual(left, [], 'no name, e-mail or id of the deleted person anywhere');
    assert.ok(h.db.get("SELECT COUNT(*) AS n FROM audit_log WHERE target = 'Gelöschtes Konto'").n >= 4, 'what happened is kept, who it was is not');
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
