'use strict';
// Bug hunt: accounts, sessions, privacy and administration. Each test here
// failed on the code before its fix (see the commit that added it).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { startHub, makeZip } = require('./helpers');
const { restoreBackup, listStore } = require('../src/backup');
const dbJobs = require('../src/dbJobs');

const DAY = 86_400_000;
const PNG = (fill) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, fill)]);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

let h;
let admin, A;

const teacherClass = (userId, name) => h.db.get("SELECT c.id FROM classes c JOIN class_members m ON m.class_id = c.id AND m.user_id = ? AND m.role = 'teacher' WHERE c.name = ?", userId, name).id;
const joinCode = (classId) => h.db.get("SELECT code FROM join_codes WHERE class_id = ? AND role = 'student'", classId).code;
/** The entry names of a zip. */
function zipNames(buffer) {
  const yauzl = require('yauzl');
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const names = [];
      zip.on('error', reject);
      zip.on('entry', (e) => {
        names.push(e.fileName);
        zip.readEntry();
      });
      zip.on('end', () => resolve(names));
      zip.readEntry();
    });
  });
}
/** Raw request to an app's own origin (files API of the SDK). */
const appRequest = (b, app, method, url, { token, body = null, type } = {}) =>
  b.raw(method, url, { host: h.appHost(app), headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(type ? { 'content-type': type } : {}) }, body });

before(async () => {
  h = await startHub();
  admin = h.addUser('Anna Adler', 'admin');
  A = await h.browser().login(admin);
});
after(() => h.stop());

// ------------------------------------------------------------- announcements

test('Ankündigungen: die eigene Klasse und die ganze Schule stehen auf der Startseite, auch wenn andere Klassen viele neuere haben', async () => {
  const teacher = h.addUser('Herr Roth', 'teacher');
  const other = h.addUser('Frau Weiß', 'teacher');
  const student = h.addUser('Paul Roth', 'student');
  const [T, O, S] = await Promise.all([teacher, other, student].map((u) => h.browser().login(u)));
  await T.post('/klassen', { name: '6c' });
  const own = teacherClass(teacher.id, '6c');
  await S.post(`/beitreten/${joinCode(own)}`);
  await O.post('/klassen', { name: '10a' });
  const foreign = teacherClass(other.id, '10a');

  await A.page('/ankuendigungen');
  assert.equal((await A.post('/ankuendigungen', { ziel: 'schule', titel: 'Schulfest am Samstag' })).status, 303);
  await T.page('/ankuendigungen');
  assert.equal((await T.post('/ankuendigungen', { ziel: own, titel: 'Wandertag der 6c' })).status, 303);
  assert.ok((await S.get('/start')).text.includes('Wandertag der 6c'), 'shown while it is the newest');

  // A busy school: the teachers of other classes write announcements too (newer ones).
  await O.page('/ankuendigungen');
  for (let i = 0; i < 20; i++) assert.equal((await O.post('/ankuendigungen', { ziel: foreign, titel: `Nachricht ${i} an die 10a` })).status, 303);
  h.db.run("UPDATE announcements SET created_at = created_at + 1000 WHERE class_id = ?", foreign); // strictly newer

  const start = (await S.get('/start')).text;
  assert.ok(!start.includes('an die 10a'), 'nothing of a foreign class');
  assert.ok(start.includes('Wandertag der 6c'), 'the announcement of her own class is still shown');
  assert.ok(start.includes('Schulfest am Samstag'), 'the school-wide announcement is still shown');
});

// ----------------------------------------------------------------- accounts

test('Rollen: ein gesperrtes Admin-Konto lässt sich herabstufen, das einzige aktive nie', async () => {
  const blocked = h.addUser('Bernd Gesperrt', 'admin');
  await A.page(`/admin/konten/${blocked.id}`);
  assert.equal((await A.post(`/admin/nutzer/${blocked.id}/sperren`, { an: '1' })).status, 303);
  // Anna is now the only ACTIVE admin. The page offers to change Bernd's role (he does not count) …
  const page = (await A.page(`/admin/konten/${blocked.id}`)).text;
  assert.ok(page.includes(`/admin/nutzer/${blocked.id}/rolle`), 'the page offers the role change');
  // … and the route must allow it: Anna stays the active admin.
  const res = await A.post(`/admin/nutzer/${blocked.id}/rolle`, { rolle: 'teacher' });
  assert.equal(res.status, 303, 'demoting a blocked admin keeps an active admin');
  assert.equal(h.db.get('SELECT role FROM users WHERE id = ?', blocked.id).role, 'teacher');
  // The guard itself still holds for the only active admin.
  assert.equal((await A.post(`/admin/nutzer/${admin.id}/rolle`, { rolle: 'teacher' })).status, 400);
  assert.equal(h.db.get('SELECT role FROM users WHERE id = ?', admin.id).role, 'admin');
});

test('Konto löschen: wer nicht mehr Lehrkraft ist, erfährt trotzdem, welche Klassen mit dem Konto verschwinden', async () => {
  const teacher = h.addUser('Herr Brandt', 'teacher');
  const student = h.addUser('Lina Brandt', 'student');
  const [T, S] = await Promise.all([teacher, student].map((u) => h.browser().login(u)));
  await T.post('/klassen', { name: 'Theater-AG' });
  const cls = teacherClass(teacher.id, 'Theater-AG');
  await S.post(`/beitreten/${joinCode(cls)}`);
  assert.ok((await T.get('/meine-daten')).text.includes('„Theater-AG“, weil du dort die einzige Lehrkraft bist'), 'as a teacher he is told');

  // The admin makes him a student; he stays the only teacher of the class (a known open question).
  await A.page(`/admin/konten/${teacher.id}`);
  assert.equal((await A.post(`/admin/nutzer/${teacher.id}/rolle`, { rolle: 'student' })).status, 303);
  const page = (await T.page('/meine-daten')).text;
  assert.ok(page.includes('„Theater-AG“, weil du dort die einzige Lehrkraft bist'), 'the deletion page names the class that will be deleted');

  // What the page has to warn about really happens: the class goes with the account, and Lina loses it.
  assert.equal((await T.post('/meine-daten/konto-loeschen', { bestaetigung: 'LÖSCHEN' })).status, 303);
  assert.equal(h.db.get('SELECT 1 AS ok FROM classes WHERE id = ?', cls), undefined);
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM class_members WHERE user_id = ?', student.id).n, 0);
});

// ------------------------------------------------------------------ backups

test('Sicherung während einer Kontolöschung: die Dateien der gelöschten Person kommen beim Wiederherstellen nicht zurück', async () => {
  const student = h.addUser('Sina Sicherung', 'student');
  const S = await h.browser().login(student);
  const own = await h.makeApp(S, 'Sinas Tagebuch');
  const t = await h.token(S, own);
  const drawing = PNG(42);
  assert.equal((await appRequest(S, own, 'PUT', '/_hub/files/geheim', { token: t.token, body: drawing, type: 'image/png' })).json().ok, true);
  const sha = sha256(drawing);
  await S.page('/meine-daten');

  // Sina deletes her account while the backup copies the database (the copy runs in a worker thread
  // and takes seconds on a big database; here the deletion is put exactly into that moment).
  const original = dbJobs.snapshot;
  dbJobs.snapshot = async (...args) => {
    assert.equal((await S.post('/meine-daten/konto-loeschen', { bestaetigung: 'LÖSCHEN' })).status, 303);
    return original(...args);
  };
  let zip;
  try {
    await A.page('/admin/sicherung');
    const res = await A.post('/admin/sicherung');
    assert.equal(res.status, 200);
    zip = res.buffer;
  } finally {
    dbJobs.snapshot = original;
  }
  assert.equal(h.db.get('SELECT 1 AS ok FROM users WHERE id = ?', student.id), undefined, 'the account is gone');
  assert.ok(!fs.existsSync(h.hub.ctx.userFiles.blobPath(sha)), 'and so is her file in the running Hub');
  // The backup's database knows nothing of Sina: her drawing is no part of the backup either.
  assert.ok(!(await zipNames(zip)).includes(`userfiles/${sha.slice(0, 2)}/${sha}`), 'the deleted drawing is not in the archive');

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'schulhub-hunt-restore-'));
  try {
    const zipFile = path.join(work, 'sicherung.zip');
    fs.writeFileSync(zipFile, zip);
    const target = path.join(work, 'data');
    const result = await restoreBackup({ zipFile, dataDir: target });
    assert.equal(result.missing.userfiles, 0);
    // The restored database knows nothing of Sina - and her drawing must not lie on the disk without
    // an owner either, where nothing ever deletes it and every later backup takes it along.
    const { DatabaseSync } = require('node:sqlite');
    const restored = new DatabaseSync(path.join(target, 'hub.sqlite'), { readOnly: true });
    let referenced;
    try {
      assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get(student.id).n, 0);
      referenced = new Set(restored.prepare('SELECT DISTINCT sha256 FROM user_files').all().map((r) => r.sha256));
    } finally {
      restored.close();
    }
    assert.ok(!fs.existsSync(path.join(target, 'userfiles', sha.slice(0, 2), sha)), 'the deleted drawing is not restored');
    for (const rel of await listStore(path.join(target, 'userfiles'))) assert.ok(referenced.has(rel.split('/')[1]), `no file without an owner: ${rel}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('Wiederherstellung: Dateien, auf die die Datenbank nicht verweist, kommen nicht auf die Platte', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'schulhub-hunt-orphan-'));
  try {
    // An archive as a backup made before this fix could be: the database plus a file that nobody owns.
    const dbCopy = path.join(work, 'copy.sqlite');
    h.db.snapshot(dbCopy);
    const orphan = PNG(77);
    const sha = sha256(orphan);
    const zipFile = path.join(work, 'alt.zip');
    fs.writeFileSync(zipFile, makeZip([{ name: 'hub.sqlite', data: fs.readFileSync(dbCopy) }, { name: `userfiles/${sha.slice(0, 2)}/${sha}`, data: orphan }]));
    const lines = [];
    const target = path.join(work, 'data');
    const result = await restoreBackup({ zipFile, dataDir: target, log: (l) => lines.push(l) });
    assert.ok(!fs.existsSync(path.join(target, 'userfiles', sha.slice(0, 2), sha)), 'the file without an owner is not restored');
    assert.equal(result.userfiles, 0, 'and not counted as restored');
    assert.ok(lines.some((l) => l.includes('ohne Bezug')), 'the restore says so');
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------- notices

test('Mitteilungen: eine gelöschte Ankündigung oder Aufgabe nimmt ihre Mitteilung mit – auch mit der ganzen Klasse', async () => {
  const teacher = h.addUser('Frau Kern', 'teacher');
  const student = h.addUser('Ida Kern', 'student');
  const [T, S] = await Promise.all([teacher, student].map((u) => h.browser().login(u)));
  const mine = (text) => h.db.all('SELECT text, href FROM notices WHERE user_id = ?', student.id).filter((n) => n.text.includes(text));

  await T.post('/klassen', { name: '5a' });
  const cls = teacherClass(teacher.id, '5a');
  await S.post(`/beitreten/${joinCode(cls)}`);
  const app = await h.makeApp(T, 'Rechenkönig');
  await T.post(`/klassen/${cls}/apps`, { app: app.id });

  // A title written by mistake (it names a child) - the teacher deletes the announcement at once.
  await T.page('/ankuendigungen');
  assert.equal((await T.post('/ankuendigungen', { ziel: cls, titel: 'Anna hat Läuse, bitte Köpfe kontrollieren' })).status, 303);
  assert.equal(mine('Läuse').length, 1, 'the class got a notice quoting the title');
  const an = h.db.get("SELECT id FROM announcements WHERE title LIKE 'Anna hat%'");
  assert.equal((await T.post(`/ankuendigungen/${an.id}/loeschen`)).status, 303);
  assert.equal(h.db.get('SELECT 1 AS ok FROM announcements WHERE id = ?', an.id), undefined);
  assert.deepEqual(mine('Läuse'), [], 'the notice with the deleted title is gone');
  assert.ok(!(await S.get('/mitteilungen')).text.includes('Läuse'));
  assert.ok(!(await S.get('/meine-daten/export')).text.includes('Läuse'));

  // An assignment deleted by its teacher: its notice would quote the title and lead to a dead page.
  await T.page(`/klassen/${cls}/aufgaben/neu`);
  assert.equal((await T.post(`/klassen/${cls}/aufgaben`, { app: app.id, titel: 'Einmaleins bis Freitag' })).status, 303);
  const x = h.db.get("SELECT id FROM assignments WHERE title = 'Einmaleins bis Freitag'");
  assert.equal(mine('Einmaleins').length, 1);
  await T.page(`/aufgaben/${x.id}`);
  assert.equal((await T.post(`/aufgaben/${x.id}/loeschen`)).status, 303);
  assert.deepEqual(mine('Einmaleins'), [], 'the notice of the deleted assignment is gone');

  // The whole class deleted: what pointed into it goes with it.
  await T.page('/ankuendigungen');
  await T.post('/ankuendigungen', { ziel: cls, titel: 'Elternabend am Dienstag' });
  await T.page(`/klassen/${cls}/aufgaben/neu`);
  await T.post(`/klassen/${cls}/aufgaben`, { app: app.id, titel: 'Kopfrechnen üben' });
  assert.equal(mine('Elternabend').length + mine('Kopfrechnen').length, 2);
  await A.page('/admin/klassen');
  assert.equal((await A.post(`/admin/klassen/${cls}/loeschen`)).status, 303);
  assert.deepEqual([...mine('Elternabend'), ...mine('Kopfrechnen')], [], 'no notice of the deleted class is left');
});

// ---------------------------------------------------------------- retention

test('Aufbewahrung: AUDIT_RETENTION_DAYS außerhalb von 30 bis 3650 Tagen löscht das Protokoll nicht beim Start', async () => {
  const { loadConfig } = require('../src/config');
  const { createHub } = require('../src/app');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schulhub-hunt-audit-'));
  const configWith = (value) => loadConfig({ env: { BASE_URL: 'http://localhost:3000', ...(value === undefined ? {} : { AUDIT_RETENTION_DAYS: value }) }, dev: true, overrides: { dataDir, listenPort: 0 } });
  try {
    const first = createHub(configWith(undefined));
    first.ctx.services.audit(null, 'anmeldung_abgelehnt');
    first.ctx.db.run('UPDATE audit_log SET at = ?', Date.now() - DAY); // yesterday
    await first.stop();

    // "0" often means "keep forever" - here it would mean "delete everything", at every start and daily.
    for (const value of ['0', '7', 'ein Jahr', '99999']) {
      let hub = null;
      try {
        hub = createHub(configWith(value));
      } catch (err) {
        assert.match(err.message, /AUDIT_RETENTION_DAYS/, `${value}: the message names the setting`);
      }
      const kept = hub ? hub.ctx.db.get('SELECT COUNT(*) AS n FROM audit_log').n : 1;
      const days = hub ? hub.ctx.settings.get('retention.auditDays') : 365;
      if (hub) await hub.stop();
      assert.equal(kept, 1, `AUDIT_RETENTION_DAYS=${value} must not wipe the audit log`);
      assert.ok(Number.isInteger(days) && days >= 30 && days <= 3650, `${value}: only an allowed value is used (got ${days})`);
    }
    const ok = createHub(configWith('30'));
    assert.equal(ok.ctx.settings.get('retention.auditDays'), 30, 'an allowed value is used');
    await ok.stop();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Aufbewahrung: eine längere Frist für inaktive Konten gilt auch für schon markierte', async () => {
  const { settings, services } = h.hub.ctx;
  const quiet = h.addUser('Olaf Ruhig', 'student');
  h.db.run('UPDATE users SET last_login_at = ? WHERE id = ?', Date.now() - 200 * DAY, quiet.id);
  await A.page('/admin/aufbewahrung');
  const save = (days) => A.post('/admin/aufbewahrung', { 'retention.auditDays': '365', 'retention.archivedClassDays': '365', 'retention.inactiveFlagDays': String(days) });
  try {
    assert.equal((await save(90)).status, 303);
    services.maintenance();
    assert.ok(h.db.get('SELECT flagged_inactive_at FROM users WHERE id = ?', quiet.id).flagged_inactive_at, 'flagged after 90 days');

    // The school decides: only after 15 months. Olaf (200 days) is not "lange nicht benutzt" any more.
    assert.equal((await save(456)).status, 303);
    services.maintenance();
    assert.equal(h.db.get('SELECT flagged_inactive_at FROM users WHERE id = ?', quiet.id).flagged_inactive_at, null, 'the flag follows the period the admin set');
    const page = (await A.get('/admin/aufbewahrung')).text;
    assert.ok(!page.includes('Olaf Ruhig'), 'not listed as inactive for 456 days');
  } finally {
    await save(settings.DEFS['retention.inactiveFlagDays'].def());
  }
});

// -------------------------------------------------------------- Meine Daten

test('Meine Daten: der Export enthält jeden Protokolleintrag, den die Seite zählt', async () => {
  const busy = h.addUser('Herr Fleißig', 'teacher');
  const T = await h.browser().login(busy);
  const insert = h.db.run.bind(null, 'INSERT INTO audit_log (at, actor_id, actor_label, action) VALUES (?, ?, ?, ?)');
  const start = Date.now() - 300 * DAY;
  for (let i = 0; i < 1100; i++) insert(start + i * 60_000, busy.id, 'Herr Fleißig (teacher)', i % 2 ? 'version_hochgeladen' : 'anmeldung');
  const total = h.db.get('SELECT COUNT(*) AS n FROM audit_log WHERE actor_id = ?', busy.id).n;
  assert.ok((await T.get('/meine-daten')).text.includes(`${total} Einträge`), 'the page counts them all');
  const ex = (await T.get('/meine-daten/export')).json();
  assert.equal(ex.protokoll.length, total, 'the download has every entry the page counts');
  assert.ok(ex.protokoll.every((p) => Object.keys(p).join() === 'vorgang,zeitpunkt'), 'still only what and when');
});

// ------------------------------------------------- the account while a form is sent

/**
 * A form POST whose body arrives only when `release()` is called (a slow connection): the headers -
 * cookie and all - reach the Hub first. Resolves to the response.
 */
async function slowPost(hub, b, url, fields, pageUrl = url.replace(/\/[^/]+$/, '').replace('/admin/nutzer/', '/admin/konten/')) {
  const http = require('node:http');
  const page = await b.get(pageUrl);
  const csrf = /<meta name="csrf" content="([^"]*)"/.exec(page.text)[1];
  const body = new URLSearchParams({ _csrf: csrf, ...fields }).toString();
  let release;
  const response = new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: hub.config.publicPort, method: 'POST', path: url,
      headers: {
        host: hub.config.hubHost, cookie: [...b.jar].map(([k, v]) => `${k}=${v}`).join('; '),
        'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
    req.flushHeaders();
    release = () => req.end(body);
  });
  await new Promise((r) => setTimeout(r, 50)); // the Hub has read the headers and is waiting for the body
  return { release, response };
}

test('Verwaltung: wer gesperrt oder gelöscht wird, während sein Formular unterwegs ist, handelt nicht mehr als Admin', async () => {
  const hub = await startHub();
  try {
    const anna = hub.addUser('Anna Admin', 'admin');
    const bernd = hub.addUser('Bernd Admin', 'admin');
    const [AA, BB] = await Promise.all([anna, bernd].map((u) => hub.browser().login(u)));
    const activeAdmins = () => hub.db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").n;

    // Bernd blocks Anna; his form is on its way while Anna blocks him.
    const slow = await slowPost(hub, BB, `/admin/nutzer/${anna.id}/sperren`, { an: '1' });
    await AA.page(`/admin/konten/${bernd.id}`);
    assert.equal((await AA.post(`/admin/nutzer/${bernd.id}/sperren`, { an: '1' })).status, 303);
    slow.release();
    const late = await slow.response;
    assert.notEqual(late.status, 303, 'a blocked admin\'s late form is not carried out');
    assert.equal(hub.db.get('SELECT disabled FROM users WHERE id = ?', anna.id).disabled, 0, 'Anna is not blocked by a blocked admin');
    assert.equal(activeAdmins(), 1, 'there is always an active admin');

    // The same with deleting: Carla deletes Anna while Anna deletes her.
    const carla = hub.addUser('Carla Admin', 'admin');
    const CC = await hub.browser().login(carla);
    const slow2 = await slowPost(hub, CC, `/admin/nutzer/${anna.id}/loeschen`, {});
    await AA.page(`/admin/konten/${carla.id}`);
    assert.equal((await AA.post(`/admin/nutzer/${carla.id}/loeschen`)).status, 303);
    slow2.release();
    await slow2.response;
    assert.ok(hub.db.get('SELECT 1 AS ok FROM users WHERE id = ?', anna.id), 'a deleted admin deletes nobody');
    assert.equal(activeAdmins(), 1);
    assert.equal(hub.db.get('SELECT COUNT(*) AS n FROM audit_log WHERE actor_label LIKE ?', 'Carla%').n, 0, 'and her name does not come back into the audit log');
  } finally {
    await hub.stop();
  }
});

test('Abmelden, während in einem anderen Tab ein Formular unterwegs ist: die Sitzung bleibt beendet', async () => {
  const student = h.addUser('Tom Tabs', 'student');
  const S = await h.browser().login(student);
  const sessions = () => h.db.get('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', student.id).n;
  const slow = await slowPost(h, S, '/einstellungen', { farbschema: 'light' }, '/einstellungen');
  const oldCookie = S.jar.get('hub_sid');
  await S.page('/start');
  assert.equal((await S.post('/auth/logout')).status, 303, 'signed out in the other tab');
  assert.equal(sessions(), 0);
  slow.release();
  const late = await slow.response;
  assert.equal(sessions(), 0, 'the late form does not store the ended session again');
  assert.ok(!String(late.headers['set-cookie'] || '').includes(`hub_sid=${oldCookie}`), 'and does not hand the browser its cookie back');
  assert.equal(h.db.get('SELECT pref_theme FROM users WHERE id = ?', student.id).pref_theme, 'dark', 'nothing was changed after the logout');
});

// ------------------------------------------------------------------ sign-in

test('Anmeldung: wird eine Rolle durch ADMIN_EMAILS zurückgesetzt, steht das im Protokoll', async () => {
  const { randomUUID } = require('node:crypto');
  const hub = await startHub({ staffDomains: ['schule.example'], adminEmails: ['chefin@schule.example'] });
  try {
    const { auth } = hub.hub.ctx;
    auth.loginUrl = async (session) => {
      session.authFlow = { state: randomUUID(), verifier: 'v' };
      return `https://login.microsoftonline.com/schule/oauth2/v2.0/authorize?state=${session.authFlow.state}`;
    };
    auth.handleCallback = async (session) => {
      delete session.authFlow;
      return { oid: 'oid-chefin', name: 'Frau Chefin', email: 'chefin@schule.example' };
    };
    const signIn = async () => {
      const B = hub.browser();
      await B.page('/');
      const start = await B.get('/auth/login');
      const done = await B.get(`/auth/callback?code=x&state=${new URL(start.headers.location).searchParams.get('state')}`);
      assert.equal(done.status, 302);
      return B;
    };
    await signIn();
    const chefin = hub.db.get("SELECT * FROM users WHERE oid = 'oid-chefin'");
    assert.equal(chefin.role, 'admin', 'admin by ADMIN_EMAILS');

    // Another admin makes her a teacher - the audit log says so.
    const other = hub.addUser('Anna Admin', 'admin');
    const AA = await hub.browser().login(other);
    await AA.page(`/admin/konten/${chefin.id}`);
    assert.equal((await AA.post(`/admin/nutzer/${chefin.id}/rolle`, { rolle: 'teacher' })).status, 303);
    assert.equal(hub.db.get('SELECT role FROM users WHERE id = ?', chefin.id).role, 'teacher');

    // At her next sign-in ADMIN_EMAILS makes her admin again: the log must not end with "Admin → Lehrkraft".
    await signIn();
    assert.equal(hub.db.get('SELECT role FROM users WHERE id = ?', chefin.id).role, 'admin');
    const last = hub.db.get("SELECT * FROM audit_log WHERE action = 'rolle_geaendert' AND subject_id = ? ORDER BY id DESC LIMIT 1", chefin.id);
    assert.ok(last && /^Lehrkraft → Admin\b/.test(last.detail), `the role change back to admin is in the audit log (last entry: ${last && last.detail})`);
    assert.equal(last.actor_label, 'System');
  } finally {
    await hub.stop();
  }
});

test('Mitteilungen: eine Klasse, die mit dem Konto ihrer einzigen Lehrkraft verschwindet, nimmt ihre Mitteilungen mit', async () => {
  const teacher = h.addUser('Herr Abschied', 'teacher');
  const student = h.addUser('Jana Abschied', 'student');
  const [T, S] = await Promise.all([teacher, student].map((u) => h.browser().login(u)));
  await T.post('/klassen', { name: 'Schach-AG' });
  const cls = teacherClass(teacher.id, 'Schach-AG');
  await S.post(`/beitreten/${joinCode(cls)}`);
  const app = await h.makeApp(S, 'Janas Schachuhr');
  await S.page(`/apps/${app.id}`);
  await S.post(`/apps/${app.id}/einreichen`, { klasse: cls }); // a review request to the teacher
  await T.page('/ankuendigungen');
  await T.post('/ankuendigungen', { ziel: cls, titel: 'Turnier am Montag' });
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM notices WHERE user_id = ? AND text LIKE ?', student.id, '%Turnier am Montag%').n, 1);

  await T.page('/meine-daten');
  assert.equal((await T.post('/meine-daten/konto-loeschen', { bestaetigung: 'LÖSCHEN' })).status, 303);
  assert.equal(h.db.get('SELECT 1 AS ok FROM classes WHERE id = ?', cls), undefined, 'the class went with its only teacher');
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM notices WHERE user_id = ? AND text LIKE ?', student.id, '%Turnier am Montag%').n, 0, 'its announcement notice too');
});
