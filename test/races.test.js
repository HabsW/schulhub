'use strict';
// Concurrency: real interleavings through HTTP. Requests fired together (Promise.all), or steps
// put in a fixed order - including an SDK call whose body is still on its way while something else
// happens: the Hub has checked the token and admitted the request, then waits for the body. After
// each race the database must tell one consistent story.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startHub, makeZip } = require('./helpers');

let h;
let adminUser, tom, kai, pia, quinn;
let AD, T, K, P, Q;
let cls, G;

const joinCode = (classId, role = 'student') => h.db.get('SELECT code FROM join_codes WHERE class_id = ? AND role = ? ORDER BY created_at DESC', classId, role)?.code;
const classRole = (userId, classId) => h.db.get('SELECT role FROM class_members WHERE class_id = ? AND user_id = ?', classId, userId)?.role ?? null;
const count = (sql, ...p) => h.db.get(sql, ...p).n;
const idFrom = (res) => res.headers.location.split('?')[0].split('/').pop();
let seq = 0;
const uniq = (p) => `${p}-${++seq}`;

async function newClass(Tb, name = uniq('Klasse')) {
  const res = await Tb.post('/klassen', { name });
  assert.equal(res.status, 303);
  return { id: idFrom(res), name };
}
async function student(name = uniq('Kind')) {
  const user = h.addUser(name, 'student');
  return { user, b: await h.browser().login(user) };
}
async function joinAs(b, classId) {
  assert.equal((await b.post(`/beitreten/${joinCode(classId)}`)).status, 303);
}
const sdk = async (b, app, token, method, params) => {
  const res = await b.api(app, token, method, params);
  return { status: res.status, ...(res.headers['content-type']?.includes('json') ? res.json() : { text: res.text }) };
};

// ---- an SDK request whose body is held back ----
// The Hub checks the token and admits the request (uploads.admitBody) before it reads the body.
// Wrapping admitBody tells the test exactly when that has happened.
const admittedWaiters = [];
function watchAdmissions() {
  const { uploads } = h.hub.ctx;
  // The SDK API, hub.files and ZIP uploads call admitBody; folder and editor uploads their own two.
  for (const name of ['admitBody', 'admitVersionFile', 'admitDraftFile']) {
    const original = uploads[name];
    uploads[name] = function admit(...args) {
      const out = original.apply(this, args);
      const next = admittedWaiters.shift(); // one admission answers one waiting request
      if (next) next();
      return out;
    };
  }
}
/**
 * Start a request to an app origin with its headers only. `admitted` resolves once the Hub has
 * checked and admitted it; `send()` sends the body and resolves with the answer.
 */
function held(app, { method = 'POST', url = '/_hub/api', token, body, type = 'application/json', host = h.appHost(app), headers = { authorization: `Bearer ${token}` } }) {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  let release;
  const admitted = new Promise((resolve) => admittedWaiters.push(resolve));
  const answer = new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: h.config.publicPort, method, path: url, headers: { host, 'content-type': type, ...headers, 'content-length': data.length } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, text, json: () => JSON.parse(text) });
        });
      }
    );
    req.on('error', reject);
    req.flushHeaders();
    release = () => req.end(data);
  });
  return {
    // If the Hub answers before admitting (a refused token), say so instead of waiting forever.
    admitted: Promise.race([admitted, answer.then((r) => { throw new Error(`answered before the body was sent: ${r.status} ${r.text}`); })]),
    send() {
      release();
      return answer;
    },
  };
}
const heldCall = (app, token, method, params) => held(app, { token, body: { method, params } });
/** The same for an upload to the Hub itself, from browser b (its cookie and CSRF token, as the Hub's own scripts send them). */
async function heldUpload(b, method, url, body, type = 'application/octet-stream') {
  const csrf = /<meta name="csrf" content="([^"]*)"/.exec((await b.get('/apps')).text)[1];
  const cookie = [...b.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  return held(null, { method, url, body, type, host: h.config.hubHost, headers: { cookie, 'x-csrf-token': csrf, accept: 'application/json' } });
}

before(async () => {
  h = await startHub({ limits: { resultsPerUser: 30, saveKeys: 25 } });
  watchAdmissions();
  adminUser = h.addUser('Anna Admin', 'admin');
  tom = h.addUser('Tom Lehrer', 'teacher');
  kai = h.addUser('Kai Kollege', 'teacher');
  pia = h.addUser('Pia Spielerin', 'student');
  quinn = h.addUser('Quinn Klasse', 'student');
  [AD, T, K, P, Q] = await Promise.all([adminUser, tom, kai, pia, quinn].map((u) => h.browser().login(u)));
  cls = await newClass(T, '7b Englisch');
  await T.post(`/klassen/${cls.id}/einladung`, { minuten: '60' });
  assert.equal((await K.post(`/beitreten/${joinCode(cls.id, 'teacher')}`)).status, 303);
  for (const b of [P, Q]) await joinAs(b, cls.id);
  G = await h.makeApp(T, 'Vokabeln', { 'index.html': '<h1>Vokabeln</h1>' });
  assert.equal((await T.post(`/klassen/${cls.id}/apps`, { app: G.id })).status, 303);
});
after(() => h.stop());

// ======================================================================= 1

test('Zwei Tabs: Spielstände, Bestwerte und Ergebnisse gehen nicht verloren und mischen sich nicht; Grenzen halten', async () => {
  const [t1, t2] = [await h.token(P, G, cls.id), await h.token(P, G, cls.id)];
  const tq = await h.token(Q, G, cls.id);
  const tab1 = (m, p) => sdk(P, G, t1.token, m, p);
  const tab2 = (m, p) => sdk(P, G, t2.token, m, p);

  // Different keys from both tabs, and Quinn's tab writing the same keys at the same time.
  const writes = [];
  for (let i = 0; i < 10; i++) {
    writes.push(tab1('save.set', { key: `k${i}`, value: `pia-1-${i}` }), tab2('save.set', { key: `k${i + 10}`, value: `pia-2-${i}` }));
    writes.push(sdk(Q, G, tq.token, 'save.set', { key: `k${i}`, value: `quinn-${i}` }));
  }
  for (const r of await Promise.all(writes)) assert.deepEqual([r.status, r.ok], [200, true]);
  const saves = (uid) => Object.fromEntries(h.db.all('SELECT key, value FROM saves WHERE app_id = ? AND user_id = ?', G.id, uid).map((r) => [r.key, JSON.parse(r.value)]));
  const piaSaves = saves(pia.id);
  for (let i = 0; i < 10; i++) {
    assert.equal(piaSaves[`k${i}`], `pia-1-${i}`);
    assert.equal(piaSaves[`k${i + 10}`], `pia-2-${i}`);
  }
  assert.deepEqual(Object.values(saves(quinn.id)).sort(), Array.from({ length: 10 }, (_, i) => `quinn-${i}`).sort(), "Quinn's saves are Quinn's only");

  // The same key from both tabs, interleaved: one of the values wins, whole, with its own size.
  await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? tab1 : tab2)('save.set', { key: 'stand', value: { tab: i % 2 ? 1 : 2, n: i, text: 'x'.repeat(i * 10) } })));
  const stand = h.db.get("SELECT value, size FROM saves WHERE app_id = ? AND user_id = ? AND key = 'stand'", G.id, pia.id);
  const v = JSON.parse(stand.value);
  assert.equal(v.text.length, v.n * 10);
  assert.equal(stand.size, Buffer.byteLength(stand.value));
  assert.deepEqual((await tab1('save.get', { key: 'stand' })).result, v, 'both tabs read the same');

  // Quota: 25 keys per person and app. 21 are used; 12 more at once from both tabs -> exactly 4 fit.
  const more = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? tab1 : tab2)('save.set', { key: `mehr${i}`, value: i })));
  assert.equal(more.filter((r) => r.ok).length, 4);
  assert.ok(more.filter((r) => !r.ok).every((r) => r.error.code === 'quota'));
  assert.equal(count('SELECT COUNT(*) AS n FROM saves WHERE app_id = ? AND user_id = ?', G.id, pia.id), 25);

  // Best scores: the best of both tabs wins, for "higher" and for "lower is better".
  const scores = [[tab1, 5], [tab2, 9], [tab1, 2], [tab2, 7], [tab1, 8], [tab2, 1]];
  await Promise.all(scores.map(([tab, s]) => tab('scores.submit', { board: 'punkte', score: s })));
  await Promise.all(scores.map(([tab, s]) => tab('scores.submit', { board: 'zeit', score: s, lowerIsBetter: true })));
  const best = (board) => h.db.get('SELECT score FROM scores WHERE app_id = ? AND board = ? AND user_id = ?', G.id, board, pia.id).score;
  assert.deepEqual([best('punkte'), best('zeit')], [9, 1]);
  assert.equal(count('SELECT COUNT(*) AS n FROM scores WHERE app_id = ? AND user_id = ?', G.id, pia.id), 2, 'one row per board');

  // Results: 2 × 20 at once. 30 per person and app are kept - exactly the 30 newest, all in the class.
  await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? tab1 : tab2)('results.add', { title: `R${String(i).padStart(2, '0')}`, score: i })));
  const kept = h.db.all('SELECT id, class_id FROM results WHERE app_id = ? AND user_id = ? ORDER BY id', G.id, pia.id);
  assert.equal(kept.length, 30);
  assert.ok(kept.every((r) => r.class_id === cls.id));
  assert.equal(count("SELECT COUNT(*) AS n FROM results WHERE app_id = ? AND user_id = ? AND title LIKE 'R%'", G.id, quinn.id), 0, 'nothing went to Quinn');
});

// ======================================================================= 2

test('Freigeben und Zurückgeben im selben Moment: genau eine Entscheidung gewinnt – Klasse, Verlauf, Mitteilungen und Protokoll stimmen überein', async () => {
  const owner = await student('Ole Owner');
  await joinAs(owner.b, cls.id);
  const rounds = [
    ['Freigeben (Tom) gegen Zurückgeben (Kai)', [[T, 'freigeben'], [K, 'zurueckgeben']]],
    ['Zurückgeben (Tom) gegen Freigeben (Kai)', [[T, 'zurueckgeben'], [K, 'freigeben']]],
    ['Doppelklick auf Freigeben', [[T, 'freigeben'], [T, 'freigeben']]],
    ['Doppelklick auf Zurückgeben', [[K, 'zurueckgeben'], [K, 'zurueckgeben']]],
  ];
  for (const [label, moves] of rounds) {
    const app = await h.makeApp(owner.b, uniq('Oles App'), { 'index.html': '<h1>Ole</h1>' });
    const version = app.published_version_id;
    assert.equal((await owner.b.post(`/apps/${app.id}/einreichen`, { klasse: cls.id })).status, 303);
    for (const [b] of moves) await b.page(`/pruefen/${cls.id}/${app.id}`);
    const answers = await Promise.all(moves.map(([b, what]) => b.post(`/pruefen/${cls.id}/${app.id}/${what}`, { version, grund: 'Bitte noch eine Anleitung.' })));
    const won = answers.map((r, i) => (r.status === 303 ? moves[i][1] : null)).filter(Boolean);
    assert.equal(won.length, 1, `${label}: exactly one decision (${answers.map((r) => r.status)})`);
    // The loser is refused, never an error: 400 (the request was returned, the form is stale) or
    // 404 (it was approved: there is no request to review any more).
    assert.ok(answers.every((r) => [303, 400, 404].includes(r.status)), `${label}: ${answers.map((r) => r.status)}`);
    const decision = won[0];
    const loser = answers.find((r) => r.status !== 303).status;
    assert.equal(loser, decision === 'freigeben' ? 404 : 400, `${label}: the refusal fits the decision`);

    const row = h.db.get('SELECT * FROM class_apps WHERE class_id = ? AND app_id = ?', cls.id, app.id);
    if (decision === 'freigeben') assert.deepEqual([row.status, row.version_id, row.request_state], ['approved', version, null], label);
    else assert.deepEqual([row.status, row.version_id, row.request_state, row.requested_version_id], ['rejected', null, 'returned', version], label);
    const kinds = h.db.all("SELECT kind FROM comments WHERE app_id = ? AND kind <> 'submitted'", app.id).map((r) => r.kind);
    assert.deepEqual(kinds, [decision === 'freigeben' ? 'approved' : 'returned'], `${label}: one decision in the history`);
    const notices = h.db.all("SELECT kind FROM notices WHERE user_id = ? AND href = ? AND kind IN ('freigegeben', 'zurueckgegeben')", owner.user.id, `/apps/${app.id}`).map((r) => r.kind);
    assert.deepEqual(notices, [decision === 'freigeben' ? 'freigegeben' : 'zurueckgegeben'], `${label}: one notice for the owner`);
    const audit = h.db.all("SELECT action FROM audit_log WHERE app_id = ? AND action IN ('app_freigegeben', 'app_zurueckgegeben')", app.id).map((r) => r.action);
    assert.deepEqual(audit, [decision === 'freigeben' ? 'app_freigegeben' : 'app_zurueckgegeben'], `${label}: one audit entry`);
  }
});

// ======================================================================= 3

test('Beitreten, während der Code erneuert wird: der alte Code gilt sofort nicht mehr – nie ein halber Zustand', async () => {
  const c = await newClass(T);
  const old = joinCode(c.id);

  // Fixed order: the confirmation page with the old code, then the renewal, then "Ja, beitreten".
  const late = await student();
  assert.equal((await late.b.get(`/beitreten/${old}`)).status, 200);
  await T.page(`/klassen/${c.id}/einstellungen`);
  assert.equal((await T.post(`/klassen/${c.id}/code`, { minuten: '60' })).status, 303);
  assert.equal((await late.b.post(`/beitreten/${old}`)).status, 400, 'the old code stopped working at once');
  assert.equal(classRole(late.user.id, c.id), null);
  assert.equal((await late.b.get(`/beitreten/${old}`)).status, 400);

  // At the same time: eight students with the code on the board, the teacher renews it once, then deletes it.
  for (const renew of [() => T.post(`/klassen/${c.id}/code`, { minuten: '60' }), () => T.post(`/klassen/${c.id}/code/loeschen`)]) {
    const code = joinCode(c.id);
    const kids = await Promise.all(Array.from({ length: 8 }, () => student()));
    const answers = await Promise.all([...kids.map((k) => k.b.post(`/beitreten/${code}`)), renew()]);
    assert.equal(answers.pop().status, 303, 'the renewal itself works');
    for (const [i, k] of kids.entries()) {
      const member = classRole(k.user.id, c.id);
      const joined = count("SELECT COUNT(*) AS n FROM audit_log WHERE actor_id = ? AND action = 'klasse_beigetreten'", k.user.id);
      if (answers[i].status === 303) assert.deepEqual([member, joined], ['student', 1], 'joined: a member, recorded once');
      else assert.deepEqual([answers[i].status, member, joined], [400, null, 0], 'refused: nothing at all');
    }
    const after = await student();
    assert.equal((await after.b.post(`/beitreten/${code}`)).status, 400, 'afterwards the old code never works');
    assert.ok(count("SELECT COUNT(*) AS n FROM join_codes WHERE class_id = ? AND role = 'student'", c.id) <= 1, 'at most one code');
  }
  const fresh = joinCode(c.id);
  assert.equal(fresh, undefined, 'deleted means deleted');
  await T.post(`/klassen/${c.id}/code`, { minuten: '60' });
  const last = await student();
  assert.equal((await last.b.post(`/beitreten/${joinCode(c.id)}`)).status, 303, 'the new code works');
});

// ======================================================================= 4

/** Every table that holds something of a person, by the column naming them. */
function traces(userId) {
  const out = {};
  for (const [table, col] of [['saves', 'user_id'], ['results', 'user_id'], ['scores', 'user_id'], ['progress', 'user_id'], ['achievements', 'user_id'], ['plays', 'user_id'], ['user_files', 'user_id'], ['class_members', 'user_id'], ['sessions', 'user_id'], ['users', 'id']]) {
    const n = count(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`, userId);
    if (n) out[table] = n;
  }
  return out;
}
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(64)]);
const blobOnDisk = (buffer) => {
  const sha = crypto.createHash('sha256').update(buffer).digest('hex');
  return fs.existsSync(path.join(h.config.dataDir, 'userfiles', sha.slice(0, 2), sha));
};

test('Konto löschen, während die App läuft: das alte Token scheitert sauber (401, nie 500) und legt nichts wieder an', async () => {
  // (a) one after the other: every kind of SDK call after the deletion
  const a = await student();
  await joinAs(a.b, cls.id);
  const ta = await h.token(a.b, G, cls.id);
  assert.equal((await sdk(a.b, G, ta.token, 'save.set', { key: 'stand', value: 1 })).ok, true);
  await a.b.page('/meine-daten');
  assert.equal((await a.b.post('/meine-daten/konto-loeschen', { bestaetigung: 'LÖSCHEN' })).status, 303);
  for (const [method, params] of [['save.set', { key: 'stand', value: 2 }], ['save.get', { key: 'stand' }], ['scores.submit', { board: 'b', score: 1 }], ['results.add', { title: 'nachher' }], ['progress.set', { value: 1 }], ['class.get', { key: 'x' }], ['files.list', {}]]) {
    const r = await sdk(a.b, G, ta.token, method, params);
    assert.deepEqual([r.status, r.error && r.error.code], [401, 'unauthorized'], method);
  }
  const put = await a.b.raw('PUT', '/_hub/files/bild.png', { host: h.appHost(G), headers: { authorization: `Bearer ${ta.token}`, 'content-type': 'image/png' }, body: PNG });
  assert.equal(put.status, 401);
  assert.deepEqual(traces(a.user.id), {});

  // (b) all at once: calls and the deletion fired together - every answer is a success or 401
  const b = await student();
  await joinAs(b.b, cls.id);
  const tb = await h.token(b.b, G, cls.id);
  await b.b.page('/meine-daten');
  const calls = Array.from({ length: 24 }, (_, i) => sdk(b.b, G, tb.token, ['save.set', 'results.add', 'scores.submit', 'progress.set'][i % 4], { key: `k${i}`, value: i, title: `t${i}`, board: 'b', score: i }));
  const [deleted, ...answers] = await Promise.all([b.b.post('/meine-daten/konto-loeschen', { bestaetigung: 'LÖSCHEN' }), ...calls]);
  assert.equal(deleted.status, 303);
  for (const r of answers) assert.ok((r.status === 200 && r.ok) || r.status === 401, `${r.status} ${JSON.stringify(r.error)}`);
  assert.deepEqual(traces(b.user.id), {});
});

test('Konto löschen, während der Inhalt eines Aufrufs noch unterwegs ist: 401 bzw. 404, nie 500, keine Datei bleibt liegen', async () => {
  // The Hub has checked the token and admitted the call; then the account goes; then the body arrives.
  // Each case is recorded and compared at the end, so a failure shows all of them.
  const seen = {};
  for (const [label, start] of [
    ['save.set', (t) => heldCall(G, t, 'save.set', { key: 'spaet', value: 'SPAETER-WERT' })],
    ['results.add', (t) => heldCall(G, t, 'results.add', { title: 'SPAETES-ERGEBNIS' })],
    ['hub.files', (t) => held(G, { method: 'PUT', url: '/_hub/files/bild.png', token: t, body: PNG, type: 'image/png' })],
  ]) {
    const c = await student();
    await joinAs(c.b, cls.id);
    const tc = await h.token(c.b, G, cls.id);
    const req = start(tc.token);
    await req.admitted;
    await c.b.page('/meine-daten');
    assert.equal((await c.b.post('/meine-daten/konto-loeschen', { bestaetigung: 'LÖSCHEN' })).status, 303);
    const r = await req.send();
    seen[label] = { status: r.status, code: JSON.parse(r.text).error?.code, left: traces(c.user.id) };
  }
  seen.fileOnDisk = blobOnDisk(PNG);

  // Blocked instead of deleted: the call that was admitted before does not write any more either.
  const blocked = await student();
  await joinAs(blocked.b, cls.id);
  const tbl = await h.token(blocked.b, G, cls.id);
  const pending = heldCall(G, tbl.token, 'save.set', { key: 'spaet', value: 'NACH-DER-SPERRE' });
  await pending.admitted;
  await AD.page(`/admin/konten/${blocked.user.id}`);
  assert.equal((await AD.post(`/admin/nutzer/${blocked.user.id}/sperren`, { an: '1' })).status, 303);
  const rb = await pending.send();
  seen.blocked = { status: rb.status, saved: count("SELECT COUNT(*) AS n FROM saves WHERE user_id = ? AND key = 'spaet'", blocked.user.id) };

  // The app's owner deletes their account (and with it the app) while a classmate's call is on its way.
  const owner = await student('Emil Eigner');
  await joinAs(owner.b, cls.id);
  const own = await h.makeApp(owner.b, 'Emils Spiel', { 'index.html': '<h1>Emil</h1>' });
  await owner.b.post(`/apps/${own.id}/einreichen`, { klasse: cls.id });
  await T.page(`/pruefen/${cls.id}/${own.id}`);
  assert.equal((await T.post(`/pruefen/${cls.id}/${own.id}/freigeben`, { version: own.published_version_id })).status, 303);
  const tp = await h.token(P, own, cls.id);
  const late = heldCall(own, tp.token, 'save.set', { key: 'x', value: 'NACH-DEM-LOESCHEN' });
  await late.admitted;
  await owner.b.page('/meine-daten');
  assert.equal((await owner.b.post('/meine-daten/konto-loeschen', { bestaetigung: 'LÖSCHEN' })).status, 303);
  const r = await late.send();
  seen.appOfDeletedOwner = { status: r.status, code: JSON.parse(r.text).error?.code, left: count('SELECT COUNT(*) AS n FROM saves WHERE app_id = ?', own.id) };

  assert.deepEqual(seen, {
    'save.set': { status: 401, code: 'unauthorized', left: {} },
    'results.add': { status: 401, code: 'unauthorized', left: {} },
    'hub.files': { status: 401, code: 'unauthorized', left: {} },
    fileOnDisk: false,
    blocked: { status: 401, saved: 0 },
    appOfDeletedOwner: { status: 404, code: 'not_found', left: 0 },
  });
  // Later calls of the classmate: the app's origin is gone.
  assert.equal((await sdk(P, own, tp.token, 'save.set', { key: 'x', value: 1 })).status, 404);
});

test('Konto löschen, während eine App hochgeladen wird: sauber abgelehnt, nie 500 – und keine Datei bleibt auf der Platte', async () => {
  // Folder upload (one file), editor save, ZIP: each admitted, then the account goes, then the body arrives.
  const seen = {};
  const onDisk = [];
  for (const kind of ['Ordner', 'Editor', 'ZIP']) {
    const s = await student();
    const app = await h.makeApp(s.b, uniq('Upload-App'), { 'index.html': '<h1>alt</h1>' });
    const code = Buffer.from(`console.log(${JSON.stringify(crypto.randomBytes(16).toString('hex'))});`);
    onDisk.push(crypto.createHash('sha256').update(code).digest('hex'));
    let req;
    if (kind === 'Ordner') {
      const v = (await s.b.send('POST', `/apps/${app.id}/versionen`)).json();
      req = await heldUpload(s.b, 'PUT', `/apps/${app.id}/versionen/${v.id}/datei?pfad=spiel.js`, code);
    } else if (kind === 'Editor') {
      const row = h.db.get('SELECT * FROM apps WHERE id = ?', app.id);
      h.hub.ctx.uploads.draftFromVersion(row, h.db.get('SELECT * FROM app_versions WHERE id = ?', row.published_version_id));
      req = await heldUpload(s.b, 'PUT', `/studio/${app.id}/datei?pfad=spiel.js`, code);
    } else {
      req = await heldUpload(s.b, 'POST', `/apps/${app.id}/versionen/zip`, makeZip([{ name: 'index.html', data: '<h1>neu</h1>' }, { name: 'spiel.js', data: code }]), 'application/zip');
    }
    await req.admitted;
    await AD.page(`/admin/konten/${s.user.id}`);
    assert.equal((await AD.post(`/admin/nutzer/${s.user.id}/loeschen`, {})).status, 303);
    const r = await req.send();
    seen[kind] = { status: r.status, app: count('SELECT COUNT(*) AS n FROM apps WHERE id = ?', app.id), files: count('SELECT COUNT(*) AS n FROM app_files f JOIN app_versions v ON v.id = f.version_id WHERE v.app_id = ?', app.id) };
  }
  seen.codeOnDisk = onDisk.filter((sha) => fs.existsSync(h.hub.ctx.uploads.blobPath(sha))).length;
  assert.deepEqual(seen, {
    Ordner: { status: 404, app: 0, files: 0 },
    Editor: { status: 404, app: 0, files: 0 },
    ZIP: { status: 404, app: 0, files: 0 },
    codeOnDisk: 0,
  });
});

// ======================================================================= 5

test('Aus der Klasse entfernt, während gespeichert wird: Spielstände bleiben, Ergebnisse danach zählen nicht für die Klasse, nichts geht schief', async () => {
  const s = await student();
  await joinAs(s.b, cls.id);
  const t = await h.token(s.b, G, cls.id);
  assert.equal((await sdk(s.b, G, t.token, 'results.add', { title: 'VORHER' })).ok, true);
  await T.page(`/klassen/${cls.id}/mitglieder`);

  // All at once.
  const calls = Array.from({ length: 20 }, (_, i) => (i % 2 ? sdk(s.b, G, t.token, 'save.set', { key: `s${i}`, value: i }) : sdk(s.b, G, t.token, 'results.add', { title: `GLEICHZEITIG-${i}` })));
  const [removed, ...answers] = await Promise.all([T.post(`/klassen/${cls.id}/mitglieder/${s.user.id}/entfernen`), ...calls]);
  assert.equal(removed.status, 303);
  assert.ok(answers.every((r) => r.status === 200 && r.ok), 'nothing errors');
  assert.equal(classRole(s.user.id, cls.id), null);
  assert.equal(count('SELECT COUNT(*) AS n FROM saves WHERE app_id = ? AND user_id = ?', G.id, s.user.id), 10, 'all saves stay theirs');
  const at = h.db.get("SELECT MAX(at) AS at FROM audit_log WHERE action = 'mitglied_entfernt'").at;
  for (const r of h.db.all("SELECT created_at, class_id FROM results WHERE user_id = ? AND title LIKE 'GLEICHZEITIG-%'", s.user.id)) {
    if (r.created_at > at) assert.equal(r.class_id, null, 'after the removal: not filed into the class');
  }

  // In a fixed order: the call was admitted while still a member, its body arrives after the removal.
  const s2 = await student('Rita Rausgenommen');
  await joinAs(s2.b, cls.id);
  const t2 = await h.token(s2.b, G, cls.id);
  const late = heldCall(G, t2.token, 'results.add', { title: 'NACH-DEM-ENTFERNEN' });
  const lateSave = heldCall(G, t2.token, 'save.set', { key: 'spaet', value: 'BLEIBT' });
  await Promise.all([late.admitted, lateSave.admitted]);
  const removed2 = await T.post(`/klassen/${cls.id}/mitglieder/${s2.user.id}/entfernen`);
  assert.equal(removed2.status, 303);
  await T.get(removed2.headers.location); // the confirmation names her once
  assert.equal((await late.send()).json().ok, true);
  assert.equal((await lateSave.send()).json().ok, true);
  assert.equal(h.db.get("SELECT class_id FROM results WHERE title = 'NACH-DEM-ENTFERNEN'").class_id, null, 'a result recorded after the removal is not the class\'s');
  assert.equal(JSON.parse(h.db.get("SELECT value FROM saves WHERE user_id = ? AND key = 'spaet'", s2.user.id).value), 'BLEIBT');
  // Later calls with the same token: personal data works, the class is gone.
  assert.equal((await sdk(s2.b, G, t2.token, 'class.get', { key: 'x' })).error.code, 'no_class');
  assert.equal((await sdk(s2.b, G, t2.token, 'save.get', { key: 'spaet' })).result, 'BLEIBT');
  // The teacher's views of the class do not show them any more.
  assert.ok(!(await T.get(`/klassen/${cls.id}/apps/${G.id}/ergebnisse`)).text.includes(s2.user.name));
});

// ======================================================================= 6

test('Klasse archivieren während gespielt wird: Klassendaten nicht mehr schreibbar, Ergebnisse zählen nicht mehr, Player und Token wie beschrieben', async () => {
  const c = await newClass(T);
  await T.post(`/klassen/${c.id}/apps`, { app: G.id });
  const s = await student();
  await joinAs(s.b, c.id);
  const ts = await h.token(s.b, G, c.id);
  const tt = await h.token(T, G, c.id);
  assert.equal(ts.class.name, c.name);
  assert.equal((await sdk(T, G, tt.token, 'class.set', { key: 'woerter', value: ['vorher'] })).ok, true);
  const late = heldCall(G, ts.token, 'results.add', { title: 'SPAET-IM-ARCHIV' });
  const lateClass = heldCall(G, tt.token, 'class.set', { key: 'woerter', value: ['spaet'] });
  await Promise.all([late.admitted, lateClass.admitted]);

  // At the same time: the archiving and a burst of calls.
  await T.page(`/klassen/${c.id}/einstellungen`);
  const burst = Array.from({ length: 10 }, (_, i) => sdk(s.b, G, ts.token, 'results.add', { title: `BURST-${i}` }));
  const [archived, ...answers] = await Promise.all([T.post(`/klassen/${c.id}/archivieren`), ...burst]);
  assert.equal(archived.status, 303);
  assert.ok(answers.every((r) => r.status === 200 && r.ok));
  const at = h.db.get('SELECT archived_at FROM classes WHERE id = ?', c.id).archived_at;
  for (const r of h.db.all("SELECT created_at, class_id FROM results WHERE user_id = ? AND title LIKE 'BURST-%'", s.user.id)) {
    if (r.created_at > at) assert.equal(r.class_id, null);
  }

  // Bodies that arrive after the archiving.
  assert.equal((await late.send()).json().ok, true);
  assert.equal(h.db.get("SELECT class_id FROM results WHERE title = 'SPAET-IM-ARCHIV'").class_id, null, 'not filed into the archived class');
  assert.equal((await lateClass.send()).json().error.code, 'no_class', 'class data of an archived class cannot be written');
  assert.deepEqual(JSON.parse(h.db.get("SELECT value FROM shared_data WHERE app_id = ? AND class_id = ? AND key = 'woerter'", G.id, c.id).value), ['vorher']);

  // Afterwards, with the old tokens: no class context, personal data still works.
  assert.equal((await sdk(T, G, tt.token, 'class.set', { key: 'woerter', value: ['neu'] })).error.code, 'no_class');
  assert.equal((await sdk(s.b, G, ts.token, 'save.set', { key: 'privat', value: 1 })).ok, true);
  assert.equal((await sdk(s.b, G, ts.token, 'results.add', { title: 'NACH-ARCHIV' })).ok, true);
  assert.equal(h.db.get("SELECT class_id FROM results WHERE title = 'NACH-ARCHIV'").class_id, null);
  // The player and new tokens: closed for the student, without class for the teacher.
  assert.equal((await s.b.get(`/apps/${G.id}/spielen?klasse=${c.id}`)).status, 404);
  assert.equal(await h.token(s.b, G, c.id), null);
  const teacherPage = await T.get(`/apps/${G.id}/spielen?klasse=${c.id}`);
  assert.equal(teacherPage.status, 200);
  assert.ok(!teacherPage.text.split('class="playerbar')[1].split('</div>')[0].includes(c.name), 'no class shown in the player');
  assert.equal((await h.token(T, G, c.id)).class, null);
  // The archived class's results: only what was made before it was archived.
  const list = (await T.get(`/klassen/${c.id}/apps/${G.id}/ergebnisse/${s.user.id}`)).text;
  assert.ok(!list.includes('SPAET-IM-ARCHIV') && !list.includes('NACH-ARCHIV'));
});

// ======================================================================= 7

test('Neue Version, während die Lehrkraft die alte prüft: die Freigabe gilt nur für die geprüfte Version', async () => {
  const owner = await student('Vera Version');
  await joinAs(owner.b, cls.id);
  const app = await h.makeApp(owner.b, 'Veras Quiz', { 'index.html': '<h1>v1</h1>' });
  const v1 = app.published_version_id;
  assert.equal((await owner.b.post(`/apps/${app.id}/einreichen`, { klasse: cls.id })).status, 303);
  const publish = async (html) => {
    const v = await h.uploadFolder(owner.b, app.id, { 'index.html': html });
    return { v, res: owner.b.post(`/apps/${app.id}/veroeffentlichen`, { version: v }) };
  };

  // Fixed order: the teacher opens v1, Vera publishes v2, the teacher approves the page she saw.
  assert.ok((await T.page(`/pruefen/${cls.id}/${app.id}`)).text.includes(`name="version" value="${v1}"`));
  const v2 = await publish('<h1>v2 – anders</h1>');
  assert.equal((await v2.res).status, 303);
  assert.equal((await T.post(`/pruefen/${cls.id}/${app.id}/freigeben`, { version: v1 })).status, 400, 'the old form fails');
  let row = h.db.get('SELECT * FROM class_apps WHERE class_id = ? AND app_id = ?', cls.id, app.id);
  assert.deepEqual([row.status, row.version_id, row.requested_version_id, row.request_state], ['pending', null, v2.v, 'waiting']);
  assert.equal(await h.token(P, app, cls.id), null, 'nothing is playable in the class');
  assert.equal(count("SELECT COUNT(*) AS n FROM comments WHERE app_id = ? AND kind = 'approved'", app.id), 0);

  // The teacher now approves v2 (which she saw), and at the same moment Vera publishes v3.
  await T.page(`/pruefen/${cls.id}/${app.id}`);
  const v3 = await publish('<h1>v3 – noch anders</h1>');
  const [approve, published] = await Promise.all([T.post(`/pruefen/${cls.id}/${app.id}/freigeben`, { version: v2.v }), v3.res]);
  assert.equal(published.status, 303);
  row = h.db.get('SELECT * FROM class_apps WHERE class_id = ? AND app_id = ?', cls.id, app.id);
  if (approve.status === 303) {
    assert.deepEqual([row.status, row.version_id, row.requested_version_id, row.request_state], ['approved', v2.v, v3.v, 'waiting'], 'v2 is approved, v3 waits');
  } else {
    assert.equal(approve.status, 400);
    assert.deepEqual([row.status, row.version_id, row.requested_version_id, row.request_state], ['pending', null, v3.v, 'waiting'], 'nothing approved, v3 waits');
  }
  assert.notEqual(row.version_id, v3.v, 'never a version nobody reviewed');
  const approved = h.db.all("SELECT version_id FROM comments WHERE app_id = ? AND kind = 'approved'", app.id).map((r) => r.version_id);
  assert.deepEqual(approved, approve.status === 303 ? [v2.v] : []);
  // The class plays exactly the approved version.
  const tp = await h.token(P, app, cls.id);
  if (approve.status === 303) assert.equal(tp.app.version, 2);
  else assert.equal(tp, null);
});
