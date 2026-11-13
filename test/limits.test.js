'use strict';
// Attack tests for package P3 of the final security review: limits and text safety.
//  - Invisible characters ("Trojan Source"): refused in every file name; bidi
//    controls in text files are errors in the check report (with file and line);
//    the source viewer, the diff and the file lists show them as marked
//    placeholders and never output the raw character.
//  - File bodies (folder upload and editor): the declared size is checked against
//    the file limit, the version's (draft's) budget and the account's quota
//    BEFORE the body is read; one person sends at most 4 bodies at a time.
//  - "Meine Daten": the export is written piece by piece, one at a time per person.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Writable } = require('node:stream');
const { startHub, makeZip } = require('./helpers');
const { writeJson, lazy } = require('../src/jsonStream');

const RLO = '\u202E';
const LRI = '\u2066';
const PDI = '\u2069';
const RLM = '\u200F';
const LS = '\u2028';
const SHALOM = 'שלום';
/** Every character the code views must never output raw. */
const RAW = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\u2028\u2029]/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let h;
let lehmann, mia, ben;
let L, M, B;
let cls;

const joinCode = (classId) => h.db.get("SELECT code FROM join_codes WHERE class_id = ? AND role = 'student'", classId).code;
const newApp = async (b, name) => (await b.post('/apps', { name, emoji: '🎮', color: '0' })).headers.location.split('/').pop();
const csrfOf = async (b) => /<meta name="csrf" content="([^"]*)"/.exec((await b.page('/start')).text)[1];
const cookieOf = (b) => [...b.jar].map(([k, v]) => `${k}=${v}`).join('; ');
const putFile = (b, appId, vid, p, body) => b.send('PUT', `/apps/${appId}/versionen/${vid}/datei?pfad=${encodeURIComponent(p)}`, Buffer.from(body), 'application/octet-stream');
const putDraft = (b, appId, p, body, extra = '') => b.send('PUT', `/studio/${appId}/datei?pfad=${encodeURIComponent(p)}${extra}`, Buffer.from(body), 'application/octet-stream');
async function newDraft(b, name) {
  const id = await newApp(b, name);
  await b.page(`/studio/${id}`);
  assert.equal((await b.post(`/studio/${id}/vorlage`, { vorlage: 'leer' })).status, 303);
  return id;
}

/**
 * A PUT that announces `declared` bytes (or none: chunked) and sends only 16 KB,
 * never the rest: only a check BEFORE reading the body can answer it.
 */
function partialPut(hub, b, csrf, url, declared, { chunked = false } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { host: hub.config.hubHost, cookie: cookieOf(b), 'content-type': 'application/octet-stream', 'x-csrf-token': csrf, accept: 'application/json' };
    if (!chunked) headers['content-length'] = declared; // without it Node sends the body chunked
    const req = http.request({ host: '127.0.0.1', port: hub.config.publicPort, method: 'PUT', path: url, headers });
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error('no answer: the server waited for the body'));
    }, 3000);
    req.on('response', (res) => {
      clearTimeout(timer);
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, connection: res.headers.connection, error: (JSON.parse(text || '{}').error) || '' });
        req.destroy();
      });
    });
    req.on('error', () => {}); // the server closes the connection while we would still be sending
    req.write(Buffer.alloc(16 * 1024, 0x41));
  });
}

/** A PUT whose body is still being sent: 1 KB of `declared` now; finish() sends the rest, abort() gives up. */
function slowPut(b, csrf, url, declared = 64 * 1024) {
  const req = http.request({
    host: '127.0.0.1', port: h.config.publicPort, method: 'PUT', path: url,
    headers: { host: h.config.hubHost, cookie: cookieOf(b), 'content-type': 'application/octet-stream', 'content-length': declared, 'x-csrf-token': csrf, accept: 'application/json' },
  });
  const response = new Promise((resolve) => {
    req.on('response', (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', () => resolve(0));
  });
  req.write(Buffer.alloc(1024, 0x41));
  return { finish: () => (req.end(Buffer.alloc(declared - 1024, 0x41)), response), abort: () => req.destroy() };
}

before(async () => {
  h = await startHub();
  lehmann = h.addUser('Herr Lehmann', 'teacher');
  mia = h.addUser('Mia Schmidt', 'student');
  ben = h.addUser('Ben Hoffmann', 'student');
  [L, M, B] = await Promise.all([lehmann, mia, ben].map((u) => h.browser().login(u)));
  await L.post('/klassen', { name: '7b' });
  cls = h.db.get("SELECT class_id FROM class_members WHERE user_id = ? AND role = 'teacher'", lehmann.id).class_id;
  await M.post(`/beitreten/${joinCode(cls)}`);
});
after(() => h.stop());

// ======================================================= invisible characters

test('Dateinamen mit unsichtbaren Zeichen werden überall abgelehnt – die Meldung zeigt sie als ⟨U+…⟩', async () => {
  const id = await newApp(M, 'Namen');
  const v = (await M.send('POST', `/apps/${id}/versionen`)).json();
  // RLO makes "bild<RLO>gnp.js" look like "bildsj.png"; the others are format characters (Cf) or separators.
  for (const name of [`bild${RLO}gnp.js`, `a${LRI}b${PDI}.js`, 'a\u200Eb.js', 'a\u200Db.png', 'a\u00ADb.css', '\uFEFFindex.html', `a${LS}b.js`, 'ordner\u2067/x.js']) {
    const res = await putFile(M, id, v.id, name, 'x');
    assert.equal(res.status, 400, JSON.stringify(name));
    assert.match(res.json().error, /unsichtbares Zeichen/, JSON.stringify(name));
    assert.ok(!/[\p{Cf}\u2028\u2029]/u.test(res.text), `the message never contains the raw character: ${JSON.stringify(name)}`);
  }
  assert.ok((await putFile(M, id, v.id, `bild${RLO}gnp.js`, 'x')).json().error.includes('"bild⟨U+202E⟩gnp.js"'));
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM app_files WHERE version_id = ?', v.id).n, 0);
  // right-to-left letters and emoji without joiners are fine
  for (const ok of ['index.html', `${SHALOM}.js`, 'bilder/🦊.png']) assert.equal((await putFile(M, id, v.id, ok, 'x')).status, 200, ok);
  await M.send('POST', `/apps/${id}/versionen/${v.id}/abbrechen`);

  // a ZIP with such a name is refused as a whole; nothing is kept
  const zip = await M.send('POST', `/apps/${id}/versionen/zip`, makeZip([{ name: 'index.html', data: '<p>x</p>' }, { name: `spiel/bild${RLO}gnp.js`, data: 'x' }]), 'application/zip');
  assert.equal(zip.status, 400);
  assert.ok(zip.json().error.includes('⟨U+202E⟩'));
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM app_versions WHERE app_id = ?', id).n, 0);

  // the editor: new file, upload, rename
  const d = await newDraft(M, 'Namen im Editor');
  for (const extra of ['&neu=1', '']) assert.equal((await putDraft(M, d, `bild${RLO}gnp.js`, 'x', extra)).status, 400, `PUT${extra}`);
  assert.equal((await M.send('POST', `/studio/${d}/datei/umbenennen`, { von: 'app.js', nach: `app${RLO}.js` })).status, 400);
  const names = () => h.db.all('SELECT path FROM draft_files WHERE app_id = ? ORDER BY path', d).map((f) => f.path);
  assert.deepEqual(names(), ['app.js', 'index.html', 'schulhub.json', 'style.css']);

  // A name stored before the rule existed can still be renamed and deleted (it is only looked up).
  const sha = h.db.get("SELECT sha256 FROM draft_files WHERE app_id = ? AND path = 'app.js'", d).sha256;
  for (const old of [`alt${RLO}1.js`, `alt${RLO}2.js`]) h.db.run('INSERT INTO draft_files (app_id, path, path_lower, size, sha256) VALUES (?, ?, ?, 1, ?)', d, old, old.toLowerCase(), sha);
  assert.equal((await M.send('POST', `/studio/${d}/datei/umbenennen`, { von: `alt${RLO}1.js`, nach: 'neu.js' })).status, 200);
  assert.equal((await M.send('POST', `/studio/${d}/datei/loeschen`, { pfad: `alt${RLO}2.js` })).status, 200);
  assert.deepEqual(names(), ['app.js', 'index.html', 'neu.js', 'schulhub.json', 'style.css']);
});

test('Prüfbericht: Steuerzeichen für die Schreibrichtung sind Fehler – mit Datei und Zeile, in jeder Textdatei', async () => {
  const id = await newApp(M, 'Bericht');
  // The classic Trojan Source trick: shown as a comment, run as code.
  const trojan = `const isAdmin = false;\n/*${RLO} } ${LRI}if (isAdmin)${PDI} ${LRI} begin admins only */\n  console.log("only for admins");\n/* end admins only ${RLO} { ${LRI}*/\n`;
  const v = await h.uploadFolder(M, id, {
    'index.html': '<!doctype html><title>x</title><meta name="viewport" content="width=device-width"><script src="spiel.js"></script><script src="https://cdn.example/x.js"></script>',
    'spiel.js': trojan,
    'daten.json': `{"a": 1,\n "b": "${RLO}"}`,
    'gruss.js': `const gruss = "${SHALOM}${RLM}";\n// Kommentar${LS}alert(1)\n`,
    'binaer.js': `\u0000${RLO}`,
  });
  const report = JSON.parse(h.db.get('SELECT report FROM app_versions WHERE id = ?', v).report);
  const find = (level, file, line) => report.items.filter((i) => i.level === level && i.file === file && i.line === line);
  assert.equal(find('error', 'spiel.js', 2).length, 1, 'one finding per line');
  assert.match(find('error', 'spiel.js', 2)[0].text, /Steuerzeichen ⟨U\+202E⟩ ⟨U\+2066⟩ ⟨U\+2069⟩/);
  assert.equal(find('error', 'spiel.js', 4).length, 1);
  assert.equal(find('error', 'daten.json', 2).length, 1, 'JSON is a text file too');
  assert.equal(find('error', 'binaer.js', 1).length, 1, 'a NUL byte does not hide a control');
  assert.match(find('warning', 'gruss.js', 1)[0].text, /Richtungszeichen ⟨U\+200F⟩/, 'a mark in Hebrew text: a warning');
  assert.match(find('warning', 'gruss.js', 2)[0].text, /Zeilenumbruch ⟨U\+2028⟩/, 'a line separator: a warning');
  assert.ok(!report.items.some((i) => i.level === 'error' && i.file === 'gruss.js'));
  assert.ok(report.items.some((i) => i.level === 'error' && /cdn\.example/.test(i.text)), 'the code checks still run');
  for (const it of report.items) assert.ok(!RAW.test(it.text), `no raw character in: ${it.text}`);

  // A name stored before the naming rule: a version made from such a draft reports it.
  await M.page(`/studio/${id}`);
  assert.equal((await M.post(`/studio/${id}/entwurf`, { version: v })).status, 303);
  const sha = h.db.get("SELECT sha256 FROM draft_files WHERE app_id = ? AND path = 'spiel.js'", id).sha256;
  h.db.run('INSERT INTO draft_files (app_id, path, path_lower, size, sha256) VALUES (?, ?, ?, 10, ?)', id, `bild${RLO}gnp.js`, `bild${RLO}gnp.js`, sha);
  assert.equal((await M.post(`/studio/${id}/version`, { notiz: '' })).status, 303);
  const r2 = JSON.parse(h.db.get('SELECT report FROM app_versions WHERE app_id = ? ORDER BY number DESC LIMIT 1', id).report);
  assert.ok(r2.items.some((i) => i.level === 'error' && i.file === `bild${RLO}gnp.js` && i.text.includes('„bild⟨U+202E⟩gnp.js“')));
});

test('Quelltext und Änderungen zeigen unsichtbare Zeichen als Platzhalter – nie das Zeichen selbst, richtig escaped', async () => {
  const id = await newApp(M, 'Ansicht');
  const v1 = await h.uploadFolder(M, id, { 'index.html': '<p>v1</p>', 'spiel.js': 'const isAdmin = false;\n' });
  await M.post(`/apps/${id}/veroeffentlichen`, { version: v1 });
  await M.post(`/apps/${id}/einreichen`, { klasse: cls });
  await L.page(`/pruefen/${cls}/${id}`);
  assert.equal((await L.post(`/pruefen/${cls}/${id}/freigeben`, { version: v1 })).status, 303);
  const code = `const isAdmin = false;\n/*${RLO} } ${LRI}if (isAdmin)${PDI} ${LRI} begin admins only */\n<b>&amp;${RLO}</b> "${SHALOM}${RLM}" // x${LS}alert(1)\n`;
  const v2 = await h.uploadFolder(M, id, { 'index.html': '<p>v2</p>', 'spiel.js': code });
  await M.post(`/apps/${id}/veroeffentlichen`, { version: v2 }); // waits for Herr Lehmann in 7b
  // a file name stored before the naming rule (as an old upload would have it)
  const sha = h.db.get("SELECT sha256 FROM app_files WHERE version_id = ? AND path = 'spiel.js'", v2).sha256;
  h.db.run('INSERT INTO app_files (version_id, path, path_lower, size, sha256) VALUES (?, ?, ?, 1, ?)', v2, `bild${RLO}gnp.js`, `bild${RLO}gnp.js`, sha);

  const rlo = '<span class="review-ctl" title="Unsichtbares Zeichen U+202E: Überschreibung rechts nach links (RLO)">⟨U+202E⟩</span>';
  const rlm = '<span class="review-ctl review-ctl-mark" title="Unsichtbares Zeichen U+200F: Richtungsmarke rechts nach links (RLM)">⟨U+200F⟩</span>';
  const src = await L.get(`/apps/${id}/versionen/${v2}/quelltext?datei=spiel.js`);
  const bench = await L.get(`/pruefen/${cls}/${id}`);
  assert.equal(src.status, 200);
  assert.equal(bench.status, 200);
  for (const [what, page] of [['source viewer', src.text], ['workbench diff', bench.text]]) {
    assert.ok(!RAW.test(page), `${what}: no raw invisible character anywhere on the page`);
    assert.ok(page.includes(`/*${rlo} } <span class="review-ctl" title="Unsichtbares Zeichen U+2066: Isolierung links nach rechts (LRI)">⟨U+2066⟩</span>if (isAdmin)`), `${what}: the controls`);
    // escaped first, then marked: the code's markup stays text, only the placeholder is markup
    assert.ok(page.includes(`&lt;b&gt;&amp;amp;${rlo}&lt;/b&gt;`), `${what}: escaping order`);
    assert.ok(page.includes(`${SHALOM}${rlm}`), `${what}: a direction mark (amber)`);
    assert.ok(page.includes('⟨U+2028⟩</span>alert(1)'), `${what}: a line separator`);
    assert.ok(page.includes(`bild${rlo}gnp.js`), `${what}: an old file name`);
  }
  assert.ok(src.text.includes('href="/static/css/review.css'), 'the source viewer loads the placeholder style');
  assert.ok(src.text.includes(`aria-label="Inhalt von spiel.js"`));

  // the file list of a first submission shows an old name the same way
  const first = await newApp(M, 'Erstes Mal');
  const f1 = await h.uploadFolder(M, first, { 'index.html': '<p>x</p>' });
  h.db.run('INSERT INTO app_files (version_id, path, path_lower, size, sha256) VALUES (?, ?, ?, 1, ?)', f1, `bild${RLO}gnp.js`, `bild${RLO}gnp.js`, sha);
  await M.post(`/apps/${first}/veroeffentlichen`, { version: f1 });
  await M.post(`/apps/${first}/einreichen`, { klasse: cls });
  const list = (await L.get(`/pruefen/${cls}/${first}`)).text;
  assert.ok(!RAW.test(list) && list.includes(`<code class="review-path">bild${rlo}gnp.js</code>`));
  // and a link to a file that does not exist does not echo a raw character either
  const missing = (await L.get(`/apps/${first}/versionen/${f1}/quelltext?datei=${encodeURIComponent(`x${RLO}y.js`)}`)).text;
  assert.ok(!RAW.test(missing) && missing.includes(`x${rlo}y.js`));
});

test('Der Code des Hubs selbst enthält keine unsichtbaren Steuerzeichen', () => {
  const root = path.join(__dirname, '..');
  const found = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs|css|html|json|md)$/.test(e.name) && RAW.test(fs.readFileSync(p, 'utf8'))) found.push(path.relative(root, p));
    }
  };
  for (const dir of ['src', 'public', 'sdk', 'templates', 'examples', 'scripts']) walk(path.join(root, dir));
  assert.deepEqual(found, [], 'write such characters as \\u escapes');
});

// ============================================================ file bodies

test('Upload: zu große Angaben werden abgelehnt, bevor der Inhalt gelesen wird – Datei, Version, Konto, ohne Größe', async () => {
  const KB = 1024;
  const x = await startHub({ limits: { maxFileBytes: 300 * KB, maxVersionBytes: 500 * KB, maxUserBytes: 700 * KB } });
  try {
    const login = async (name) => x.browser().login(x.addUser(name, 'student'));
    const refusedEarly = (r, status, text) => {
      assert.equal(r.status, status);
      assert.equal(r.connection, 'close', 'the connection is closed instead of reading the rest');
      assert.match(r.error, text);
    };
    const filled = (n) => 'x'.repeat(n);

    // Folder upload: the file limit, the version's budget, a body without a size
    const a = await login('Anna');
    const appA = await newApp(a, 'Gross');
    const vA = (await a.send('POST', `/apps/${appA}/versionen`)).json();
    const csrfA = await csrfOf(a);
    const urlA = (p) => `/apps/${appA}/versionen/${vA.id}/datei?pfad=${p}`;
    refusedEarly(await partialPut(x, a, csrfA, urlA('a.bin'), 300 * KB + 1), 413, /ist zu groß/);
    assert.equal((await putFile(a, appA, vA.id, 'index.html', filled(250 * KB))).status, 200);
    assert.equal((await putFile(a, appA, vA.id, 'b.bin', filled(150 * KB))).status, 200); // 400 of 500 KB
    refusedEarly(await partialPut(x, a, csrfA, urlA('c.bin'), 150 * KB), 413, /Die App ist zu groß/);
    refusedEarly(await partialPut(x, a, csrfA, urlA('c.bin'), 0, { chunked: true }), 411, /fehlt die Größe der Datei/);
    assert.equal((await putFile(a, appA, vA.id, 'c.bin', filled(90 * KB))).status, 200, 'what fits is still accepted');
    assert.equal(x.db.get('SELECT COUNT(*) AS n FROM app_files WHERE version_id = ?', vA.id).n, 3, 'nothing of the refused bodies was stored');

    // Folder upload: the account's quota (500 KB in a finished version, 150 KB in the next)
    const b = await login('Bert');
    const appB = await newApp(b, 'Voll');
    await x.uploadFolder(b, appB, { 'index.html': filled(300 * KB), 'd.bin': filled(200 * KB) });
    const vB = (await b.send('POST', `/apps/${appB}/versionen`)).json();
    assert.equal((await putFile(b, appB, vB.id, 'index.html', filled(150 * KB))).status, 200);
    refusedEarly(await partialPut(x, b, await csrfOf(b), `/apps/${appB}/versionen/${vB.id}/datei?pfad=e.bin`, 100 * KB), 413, /Speicherplatz dieses Kontos ist voll/);

    // Editor: the file limit, the draft's budget, the account's quota, a body without a size
    const c = await login('Cleo');
    const d1 = await newDraft(c, 'Entwurf');
    const csrfC = await csrfOf(c);
    const urlC = (id, p) => `/studio/${id}/datei?pfad=${p}`;
    refusedEarly(await partialPut(x, c, csrfC, urlC(d1, 'a.bin'), 300 * KB + 1), 413, /zu groß/);
    assert.equal((await putDraft(c, d1, 'a.bin', filled(290 * KB))).status, 200);
    refusedEarly(await partialPut(x, c, csrfC, urlC(d1, 'b.bin'), 250 * KB), 413, /Die App ist zu groß/);
    assert.equal((await putDraft(c, d1, 'a.bin', filled(295 * KB))).status, 200, 'replacing a file counts the space it frees');
    refusedEarly(await partialPut(x, c, csrfC, urlC(d1, 'b.bin'), 0, { chunked: true }), 411, /fehlt die Größe der Datei/);
    const d2 = await newDraft(c, 'Zweiter Entwurf');
    assert.equal((await putDraft(c, d2, 'a.bin', filled(290 * KB))).status, 200);
    refusedEarly(await partialPut(x, c, csrfC, urlC(d2, 'b.bin'), 200 * KB), 413, /Speicherplatz dieses Kontos ist voll/);
    assert.equal(x.db.get("SELECT COUNT(*) AS n FROM draft_files WHERE path = 'b.bin'").n, 0);
  } finally {
    await x.stop();
  }
});

test('Upload: höchstens 4 Dateien gleichzeitig pro Person – über Ordner-Upload und Editor, frei nach Ende oder Abbruch', async () => {
  const id = await newApp(B, 'Parallel');
  const v = (await B.send('POST', `/apps/${id}/versionen`)).json();
  const d = await newDraft(B, 'Parallel im Editor');
  const csrf = await csrfOf(B);
  const fileUrl = (p) => `/apps/${id}/versionen/${v.id}/datei?pfad=${p}`;
  const draftUrl = (p) => `/studio/${d}/datei?pfad=${p}`;
  let n = 0;
  const small = () => putFile(B, id, v.id, `klein${n++}.js`, 'x');
  /** A small, complete upload again and again until it gets `status` (it gets 200 while a place is free). */
  async function until(status) {
    for (let i = 0; i < 80; i++) {
      const r = await small();
      if (r.status === status) return r;
      await sleep(25);
    }
    return assert.fail(`never got ${status}`);
  }
  // four bodies that are still being sent: two folder files, two editor files
  const open = [slowPut(B, csrf, fileUrl('p1.bin')), slowPut(B, csrf, fileUrl('p2.bin')), slowPut(B, csrf, draftUrl('p3.bin')), slowPut(B, csrf, draftUrl('p4.bin'))];
  try {
    const busy = await until(429);
    assert.match(busy.json().error, /gleichzeitig/);
    assert.equal(busy.headers.connection, 'close', 'refused without reading');
    assert.equal((await putDraft(B, d, 'e.js', 'x')).status, 429, 'the editor shares the four places');
    // another person is not affected
    const own = await newApp(M, 'Daneben');
    const mv = (await M.send('POST', `/apps/${own}/versionen`)).json();
    assert.equal((await putFile(M, own, mv.id, 'index.html', 'x')).status, 200);
    // a cancelled upload frees its place
    open[0].abort();
    await until(200);
    // ... and so does a finished one: all four places are taken again, one finishes
    const more = slowPut(B, csrf, fileUrl('p5.bin'));
    open.push(more);
    await until(429);
    assert.equal(await open[1].finish(), 200);
    await until(200);
    assert.ok(h.db.get("SELECT 1 AS ok FROM app_files WHERE version_id = ? AND path = 'p2.bin' AND size = 65536", v.id), 'the finished body was stored');
  } finally {
    for (const o of open) o.abort();
  }
});

// ================================================================ export

test('JSON-Download: Stück für Stück geschrieben, genau wie JSON.stringify(…, null, 2)', async () => {
  const make = () => ({
    a: 1, text: 'Zeile\n"zwei"\u2028', weg: undefined, fn: () => 1, nichts: null, liste: [1, [], {}, [{ x: [] }]], leer: {},
    keine: lazy(() => []),
    viele: lazy(function* () {
      for (let i = 0; i < 300; i++) yield { i, tief: lazy(() => [i, { j: i }]), weg: undefined, s: 'x'.repeat(i * 7) };
      yield undefined;
      yield lazy(() => [lazy(() => []), 'innen']);
    }),
    zuletzt: { b: [true, false] },
  });
  const materialize = (v) => {
    if (v && typeof v.items === 'function' && typeof v.toJSON === 'function') return [...v.items()].map(materialize);
    if (Array.isArray(v)) return v.map(materialize);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, materialize(x)]));
    return v;
  };
  const parts = [];
  // a slow receiver: back-pressure is respected (writes wait for "drain")
  const res = new Writable({ highWaterMark: 1024, write(chunk, enc, cb) { parts.push(chunk); setImmediate(cb); } });
  await writeJson(res, make(), { chunk: 512 });
  await new Promise((resolve) => (res.writableFinished ? resolve() : res.on('finish', resolve)));
  assert.ok(parts.length > 50, 'many pieces');
  assert.equal(Buffer.concat(parts).toString('utf8'), JSON.stringify(materialize(make()), null, 2));
});

test('Meine Daten: der Export wird gestreamt – vollständig, gültig, im gewohnten Format und mit denselben Kopfzeilen', async () => {
  const u = h.addUser('Viele Daten', 'student');
  const b = await h.browser().login(u);
  const now = Date.now();
  for (let i = 0; i < 2; i++) {
    const app = `export-app-${i}`;
    h.db.run('INSERT INTO apps (id, owner_id, name, description, emoji, color, origin_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)', app, u.id, `Export ${i}`, '', '🎮', `export${i}`, now, now);
    for (let k = 0; k < 150; k++) h.db.run('INSERT INTO results (app_id, user_id, title, score, max_score, details, created_at) VALUES (?, ?, ?, ?, 10, ?, ?)', app, u.id, `R${k}`, k % 3 ? k : null, k % 5 ? JSON.stringify({ k, text: `Antwort ${k}`, list: [k, { tief: [] }] }) : null, now + k);
    for (let k = 0; k < 45; k++) h.db.run('INSERT INTO saves (app_id, user_id, key, value, size, updated_at) VALUES (?, ?, ?, ?, 10, ?)', app, u.id, `stand-${String(k).padStart(2, '0')}`, k % 2 ? JSON.stringify({ level: k }) : 'kein JSON {', now);
  }
  for (let k = 0; k < 450; k++) h.db.run("INSERT INTO comments (id, app_id, author_id, body, created_at, kind) VALUES (?, ?, ?, ?, ?, 'comment')", `export-c${k}`, `export-app-${k % 2}`, u.id, `Kommentar ${k}`, now + (k % 7));
  for (let k = 0; k < 230; k++) h.db.run('INSERT INTO feedback (id, class_id, student_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)', `export-f${k}`, cls, u.id, lehmann.id, `Rückmeldung ${k}`, now + (k % 5));

  const res = await b.get('/meine-daten/export');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(res.headers['content-disposition'], 'attachment; filename="meine-daten.json"');
  assert.equal(res.headers['cache-control'], 'private, no-store');
  assert.equal(res.headers['transfer-encoding'], 'chunked', 'written piece by piece, not built in memory first');
  assert.equal(res.headers['content-length'], undefined);
  const ex = res.json();
  assert.equal(res.text, JSON.stringify(ex, null, 2), 'exactly the format of JSON.stringify(…, null, 2)');
  // complete, in the same order as the database
  assert.deepEqual(ex.appDaten.map((a) => a.app), ['Export 0', 'Export 1']);
  for (const [i, a] of ex.appDaten.entries()) {
    assert.deepEqual(a.ergebnisse.map((r) => r.titel), Array.from({ length: 150 }, (_, k) => `R${k}`));
    assert.deepEqual(a.ergebnisse[7].einzelheiten, { k: 7, text: 'Antwort 7', list: [7, { tief: [] }] });
    assert.equal(a.ergebnisse[5].einzelheiten, null);
    assert.deepEqual(a.spielstaende.map((s) => s.schluessel), h.db.all('SELECT key FROM saves WHERE app_id = ? AND user_id = ? ORDER BY key', `export-app-${i}`, u.id).map((s) => s.key));
    assert.equal(a.spielstaende[0].wert, 'kein JSON {');
    assert.deepEqual(a.spielstaende[1].wert, { level: 1 });
  }
  assert.deepEqual(ex.kommentare.map((c) => c.text), h.db.all('SELECT body FROM comments WHERE author_id = ? ORDER BY created_at, rowid', u.id).map((c) => c.body));
  assert.deepEqual(ex.rueckmeldungen.map((f) => [f.text, f.von]), h.db.all('SELECT body FROM feedback WHERE student_id = ? ORDER BY created_at, rowid', u.id).map((f) => [f.body, 'Herr Lehmann']));
  assert.ok(!res.text.includes(lehmann.email), 'still no address of anybody else');
});

test('Meine Daten: ein zweiter Export derselben Person während des ersten wird abgelehnt (429)', async () => {
  const u = h.addUser('Export Zweimal', 'student');
  const b = await h.browser().login(u);
  const now = Date.now();
  // about 24 MB: the download cannot be finished while nobody reads it
  h.db.run("INSERT INTO apps (id, owner_id, name, description, emoji, color, origin_key, created_at, updated_at) VALUES ('export-gross', ?, 'Groß', '', '🎮', 0, 'exportgross', ?, ?)", u.id, now, now);
  const details = JSON.stringify({ text: 'x'.repeat(30 * 1024) });
  h.db.tx(() => {
    for (let k = 0; k < 800; k++) h.db.run("INSERT INTO results (app_id, user_id, title, score, max_score, details, created_at) VALUES ('export-gross', ?, ?, 1, 1, ?, ?)", u.id, `R${k}`, details, now);
  });
  // the first download: headers arrive, then nobody reads
  const first = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: h.config.publicPort, path: '/meine-daten/export', headers: { host: h.config.hubHost, cookie: cookieOf(b) } });
    req.on('response', (res) => {
      res.pause();
      resolve({ req, res });
    });
    req.on('error', reject);
    req.end();
  });
  try {
    assert.equal(first.res.statusCode, 200);
    const second = await b.get('/meine-daten/export');
    assert.equal(second.status, 429);
    assert.match(second.text, /Dein Download wird gerade schon erstellt/);
    assert.equal(second.headers['content-disposition'], undefined, 'an error page, not a download');
    assert.equal((await M.get('/meine-daten/export')).status, 200, 'another person is not affected');
  } finally {
    first.req.destroy();
  }
  // when the first connection is closed, the next download works - and is complete
  let res;
  for (let i = 0; i < 40; i++) {
    res = await b.get('/meine-daten/export');
    if (res.status === 200) break;
    await sleep(25);
  }
  assert.equal(res.status, 200);
  assert.equal(res.json().appDaten[0].ergebnisse.length, 800);
});

test('Eingaben: unsichtbare Richtungszeichen verschwinden aus Namen und Texten – Richtungsmarken bleiben', async () => {
  const { cleanText } = require('../src/util');
  const ch = (code) => String.fromCharCode(code);
  const [RLO, LRI, PDI, RLM, LS] = [0x202e, 0x2066, 0x2069, 0x200f, 0x2028].map(ch);
  assert.equal(cleanText(`Lea${RLO}tsi doof`, 80), 'Leatsi doof', 'an override never reaches the page');
  assert.equal(cleanText(`a${LRI}b${PDI}c`, 80), 'abc', 'isolates neither');
  const hebrew = `${ch(0x05e9)}${ch(0x05dc)}${ch(0x05d5)}${ch(0x05dd)}${RLM}!`;
  assert.equal(cleanText(hebrew, 80), hebrew, 'direction marks in right-to-left text stay');
  assert.equal(cleanText(`eins${LS}zwei`, 80), 'eins zwei');
  assert.equal(cleanText(`eins${LS}zwei`, 80, { multiline: true }), 'eins\nzwei');
  // Through a real form: the name of a new app.
  const h = await startHub();
  try {
    const T = await h.browser().login(h.addUser('Herr Lehmann', 'teacher'));
    const res = await T.post('/apps', { name: `Quiz${RLO}nretsO`, emoji: '🎮', color: '0' });
    assert.equal(res.status, 303);
    const id = res.headers.location.split('/').pop();
    assert.equal(h.db.get('SELECT name FROM apps WHERE id = ?', id).name, 'QuiznretsO');
  } finally {
    await h.stop();
  }
});
