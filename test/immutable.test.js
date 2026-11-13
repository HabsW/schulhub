'use strict';
// A finished version never changes - not even through an upload that was still on its way.
// A file request is checked before its body is read; the body can then take minutes (the request
// timeout is 10 minutes). Without a second look when the body is complete, a slowly sent file
// would land in a version that meanwhile was finished, published, submitted and APPROVED: the class
// would run code no teacher has seen.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startHub, makeZip } = require('./helpers');

let h;
let teacher;
let student;
let T;
let S;
let classId;

before(async () => {
  h = await startHub();
  teacher = h.addUser('Herr Lehmann', 'teacher');
  student = h.addUser('Mia Schmidt', 'student');
  T = await h.browser().login(teacher);
  S = await h.browser().login(student);
  await T.post('/klassen', { name: '7b' });
  classId = h.db.get("SELECT class_id FROM class_members WHERE user_id = ? AND role = 'teacher'", teacher.id).class_id;
  const code = h.db.get("SELECT code FROM join_codes WHERE class_id = ? AND role = 'student'", classId).code;
  await S.post(`/beitreten/${code}`);
});
after(() => h.stop());

/** Start a PUT whose body arrives slowly: headers and the first bytes now, the rest when finish() is called. */
async function slowPut(b, url, body) {
  const page = await b.page('/apps');
  const csrf = /<meta name="csrf" content="([^"]*)"/.exec(page.text)[1];
  let resolve;
  const done = new Promise((r) => {
    resolve = r;
  });
  const req = http.request({
    host: '127.0.0.1', port: h.config.publicPort, method: 'PUT', path: url,
    headers: {
      host: h.config.hubHost, cookie: [...b.jar].map(([k, v]) => `${k}=${v}`).join('; '),
      'content-type': 'application/octet-stream', 'content-length': body.length, 'x-csrf-token': csrf, accept: 'application/json',
    },
  }, (res) => {
    let text = '';
    res.on('data', (c) => (text += c));
    res.on('end', () => resolve({ status: res.statusCode, text }));
  });
  req.on('error', (err) => resolve({ status: 0, text: err.message }));
  req.write(body.subarray(0, 10));
  // Let the server admit the request and start reading the body.
  await new Promise((r) => setTimeout(r, 100));
  return {
    finish() {
      req.end(body.subarray(10));
      return done;
    },
  };
}

test('Fertige Version bleibt unverändert: eine langsam hochgeladene Datei landet nie in einer freigegebenen Version', async () => {
  const created = await S.post('/apps', { name: 'Mias Spiel', emoji: '🎮', color: '0' });
  const appId = created.headers.location.split('/').pop();
  const v = (await S.send('POST', `/apps/${appId}/versionen`)).json();
  assert.equal((await S.send('PUT', `/apps/${appId}/versionen/${v.id}/datei?pfad=index.html`, Buffer.from('<h1>harmlos</h1>'), 'application/octet-stream')).status, 200);

  // A second file is on its way - slowly.
  const late = await slowPut(S, `/apps/${appId}/versionen/${v.id}/datei?pfad=spaeter.js`, Buffer.from('/* nachgeschoben */ '.repeat(50)));

  // Meanwhile the version is finished, published, submitted - and the teacher approves what they saw.
  assert.equal((await S.send('POST', `/apps/${appId}/versionen/${v.id}/fertig`)).status, 200);
  await S.post(`/apps/${appId}/veroeffentlichen`, { version: v.id });
  await S.post(`/apps/${appId}/einreichen`, { klasse: classId });
  await T.page(`/pruefen/${classId}/${appId}`);
  const approved = await T.post(`/pruefen/${classId}/${appId}/freigeben`, { version: v.id });
  assert.equal(approved.status, 303);
  assert.equal(h.db.get('SELECT status FROM class_apps WHERE class_id = ? AND app_id = ?', classId, appId).status, 'approved');

  // Now the rest of the body arrives: it must be refused, and the approved version stays as approved.
  const answer = await late.finish();
  assert.notEqual(answer.status, 200, `a finished version took a file: ${answer.text}`);
  const files = h.db.all('SELECT path FROM app_files WHERE version_id = ? ORDER BY path', v.id).map((r) => r.path);
  assert.deepEqual(files, ['index.html']);
  const version = h.db.get('SELECT file_count, total_bytes FROM app_versions WHERE id = ?', v.id);
  assert.equal(version.file_count, 1);
});

test('Fertige Version bleibt unverändert: auch ein ZIP, das gerade entpackt wird, ändert keine fertige Version', async () => {
  const created = await S.post('/apps', { name: 'Mias Zip', emoji: '🎮', color: '0' });
  const appId = created.headers.location.split('/').pop();
  // The importer adds files one by one; a version that is finished meanwhile takes no more of them.
  const { uploads, services } = h.hub.ctx;
  const app = h.db.get('SELECT * FROM apps WHERE id = ?', appId);
  const version = services.createVersion(app);
  uploads.addFile(version, student.id, 'index.html', Buffer.from('<h1>zip</h1>'));
  services.finishVersion(student, app, version);
  assert.throws(() => uploads.addFile(version, student.id, 'nachher.js', Buffer.from('1')), /fertig|abgeschlossen|nicht mehr/i);
  // The real ZIP path: the archive's files go into the version it created, which is still open.
  const zip = makeZip([{ name: 'index.html', data: '<h1>z</h1>' }, { name: 'a.js', data: 'let a = 1;' }]);
  const res = await S.send('POST', `/apps/${appId}/versionen/zip`, zip, 'application/zip');
  assert.equal(res.status, 200, res.text);
});
