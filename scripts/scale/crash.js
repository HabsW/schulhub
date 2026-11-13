'use strict';
// Crash test: kill -9 the Hub while it writes, restart it, and check that the database is whole and
// that nothing the Hub had confirmed is lost - many times in a row.
//
//   node scripts/scale/crash.js --data <seeded dir> [--rounds 12] [--port 3721]
//
// The writes during each round: students saving, adding results and scores very often; a teacher
// uploading and publishing versions; new accounts signing in, playing and deleting themselves;
// teachers creating classes that students join; apps being deleted. After every kill:
//  - the database file opens, `PRAGMA integrity_check` is "ok" and there are no broken references;
//  - every write the Hub had answered with success is there (and deletions stay deleted);
//  - the Hub starts again and the sessions of signed-in people still work.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fork } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { Stats } = require('./stats');
const { Browser, AppSession, sha256 } = require('./client');

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const ROOT = path.join(__dirname, '..', '..');
const DATA = path.resolve(opt('data', ''));
const WORK = path.resolve(opt('work', `${DATA}-crash`));
const PORT = Number(opt('port', '3721'));
const ROUNDS = Number(opt('rounds', '12'));
const OUT = path.resolve(opt('out', path.join(ROOT, 'data', 'scale-results', `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-crash`)));
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const RUN = Date.now().toString(36);
const RESULTS_KEPT = 500; // src/config.js limits.resultsPerUser
const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
}

function startServer() {
  const logFile = fs.openSync(path.join(OUT, 'server.log'), 'a');
  const child = fork(path.join(__dirname, 'server.js'), ['--data', WORK, '--port', String(PORT)], { stdio: ['ignore', logFile, logFile, 'ipc'] });
  return new Promise((resolve, reject) => {
    child.on('message', (m) => m.type === 'ready' && resolve({ child, hub: { origin: m.origin, appsSuffix: m.appsSuffix } }));
    child.once('exit', (code, signal) => reject(new Error(`server exited (${code} ${signal}) before it was ready, see ${OUT}/server.log`)));
  });
}

/** Open the database file the way the next start would, and check it. */
function checkFile(round) {
  const db = new DatabaseSync(path.join(WORK, 'hub.sqlite'));
  const integrity = db.prepare('PRAGMA integrity_check').all().map((r) => Object.values(r)[0]);
  const fk = db.prepare('PRAGMA foreign_key_check').all();
  db.close();
  check(`round ${round}: integrity_check after kill -9`, integrity.length === 1 && integrity[0] === 'ok', integrity.slice(0, 3).join('; '));
  check(`round ${round}: no broken references`, fk.length === 0, fk.length ? JSON.stringify(fk.slice(0, 3)) : '');
}

// What the Hub confirmed, across all rounds.
const ledger = { saves: new Map(), results: new Map(), deletedUsers: [], classes: [], deletedApps: [], versions: [] };

async function main() {
  if (!fs.existsSync(path.join(DATA, 'hub.sqlite'))) throw new Error('--data: Ordner von scripts/scale/seed.js');
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.cpSync(DATA, WORK, { recursive: true });
  const db0 = new DatabaseSync(path.join(WORK, 'hub.sqlite'), { readOnly: true });
  const players = db0.prepare(
    `SELECT u.id, u.oid, u.name, u.email, ca.class_id, a.id AS app_id, a.origin_key FROM class_members m JOIN users u ON u.id = m.user_id AND u.disabled = 0
       JOIN classes c ON c.id = m.class_id AND c.archived_at IS NULL JOIN class_apps ca ON ca.class_id = m.class_id AND ca.status = 'approved'
       JOIN apps a ON a.id = ca.app_id WHERE m.role = 'student' GROUP BY u.id ORDER BY u.id LIMIT 80`
  ).all();
  const teachers = db0.prepare("SELECT u.* FROM users u WHERE u.role = 'teacher' AND u.disabled = 0 AND (SELECT COUNT(*) FROM apps WHERE owner_id = u.id) < 20 ORDER BY u.id LIMIT 4").all();
  const joiners = db0.prepare("SELECT u.* FROM users u WHERE u.role = 'student' AND u.disabled = 0 AND NOT EXISTS (SELECT 1 FROM class_members m WHERE m.user_id = u.id) ORDER BY u.id LIMIT 60").all();
  db0.close();
  const stats = new Stats('crash');
  const browsers = new Map();
  let server = await startServer();
  let hub = server.hub;

  for (let round = 1; round <= ROUNDS; round++) {
    const roundStart = Date.now();
    const stopAt = roundStart + 4000 + Math.random() * 9000;
    let killed = false;
    const alive = () => !killed;
    const tasks = [];

    // Students saving and adding results as fast as an app would in a busy moment.
    for (const p of players) {
      tasks.push((async () => {
        let b = browsers.get(p.id);
        if (!b) {
          b = new Browser(hub, stats, p);
          if (!(await b.signIn(p))) return;
          browsers.set(p.id, b);
        }
        b.hub = hub;
        const app = new AppSession(b, { id: p.app_id, origin_key: p.origin_key }, p.class_id);
        if (!(await app.open({ files: false }))) return;
        const key = `${p.id}:${p.app_id}`;
        while (alive()) {
          const seq = (ledger.saves.get(key)?.attempt || 0) + 1;
          const entry = ledger.saves.get(key) || { acked: 0, attempt: 0, unknown: [] };
          entry.attempt = seq;
          ledger.saves.set(key, entry);
          const r = await app.api('save.set', { key: 'crashtest', value: { owner: p.oid, seq, run: RUN } });
          if (r.ok) entry.acked = seq;
          else entry.unknown.push(seq);
          const rr = ledger.results.get(key) || { acked: 0, unknown: 0 };
          ledger.results.set(key, rr);
          const res = await app.api('results.add', { title: `Crashtest ${RUN}`, score: seq % 10, maxScore: 10 });
          if (res.ok) rr.acked++;
          else rr.unknown++;
          await sleep(50 + Math.random() * 150);
        }
      })());
    }

    // New people sign in, use an app, and delete their account again.
    tasks.push((async () => {
      while (alive()) {
        const n = crypto.randomBytes(4).toString('hex');
        const person = { oid: `crash-${RUN}-${n}`, name: `Crash Test ${n}`, email: `crash.${n}@schueler.example` };
        const b = new Browser(hub, stats, person);
        if (!(await b.signIn(person))) continue;
        await b.page('account: Meine Daten', '/meine-daten');
        const done = await b.post('account: delete', '/meine-daten/konto-loeschen', { bestaetigung: 'LÖSCHEN' });
        if (done.ok) ledger.deletedUsers.push(person.oid);
      }
    })());

    // Teachers create classes that students join; upload, publish and delete apps.
    for (const [k, t] of teachers.entries()) {
      tasks.push((async () => {
        let b = browsers.get(t.id);
        if (!b) {
          b = new Browser(hub, stats, t);
          if (!(await b.signIn(t))) return;
          browsers.set(t.id, b);
        }
        b.hub = hub;
        while (alive()) {
          if (k % 2 === 0) {
            await b.page('teacher: new class', '/klassen/neu');
            const made = await b.post('teacher: create class', '/klassen', { name: `Crash ${RUN} ${round}-${k}` });
            if (!made.ok) break; // a limit refused it (or the Hub is gone): this teacher is done for the round
            const classId = made.location.split('/').pop();
            const qr = await b.page('teacher: QR', `/klassen/${classId}/qr`);
            const code = /\/beitreten\/([A-Za-z0-9_-]{32})/.exec(qr.text);
            const entry = { classId, teacher: t.id, joined: [] };
            ledger.classes.push(entry);
            if (!code) continue;
            for (const s of joiners.slice((round * 7 + k) % 50, ((round * 7 + k) % 50) + 5)) {
              let sb = browsers.get(s.id);
              if (!sb) {
                sb = new Browser(hub, stats, s);
                if (!(await sb.signIn(s))) continue;
                browsers.set(s.id, sb);
              }
              sb.hub = hub;
              await sb.page('join: link', `/beitreten/${code[1]}`);
              const j = await sb.post('join: confirm', `/beitreten/${code[1]}`, {});
              if (j.ok) entry.joined.push(s.id);
            }
          } else {
            await b.page('upload: new app', '/apps/neu');
            const made = await b.post('upload: create app', '/apps', { name: `Crash ${RUN} ${round}-${k}`, emoji: '🎮', color: '2' });
            if (!made.ok) break; // a limit refused it (or the Hub is gone): this teacher is done for the round
            const appId = made.location.split('/').pop();
            await b.page('upload: app page', `/apps/${appId}`);
            const v = await b.send('upload: start', 'POST', `/apps/${appId}/versionen`, {});
            if (!v.ok) break;
            const vid = JSON.parse(v.text).id;
            const files = { 'index.html': Buffer.from(`<h1>Crash ${RUN} ${crypto.randomBytes(8).toString('hex')}</h1>`), 'app.js': crypto.randomBytes(30000), 'big.bin': crypto.randomBytes(2_000_000) };
            for (const [p, d] of Object.entries(files)) await b.send('upload: file', 'PUT', `/apps/${appId}/versionen/${vid}/datei?pfad=${encodeURIComponent(p)}`, d, { type: 'application/octet-stream' });
            const fin = await b.send('upload: finish', 'POST', `/apps/${appId}/versionen/${vid}/fertig`, {});
            if (fin.ok) ledger.versions.push({ appId, vid, files: Object.fromEntries(Object.entries(files).map(([p, d]) => [p, sha256(d)])) });
            await b.page('upload: app page', `/apps/${appId}`);
            const pub = await b.post('upload: publish', `/apps/${appId}/veroeffentlichen`, { version: vid });
            if (pub.ok && Math.random() < 0.5) {
              const del = await b.post('app: delete', `/apps/${appId}/loeschen`, {});
              if (del.ok) ledger.deletedApps.push(appId);
            }
          }
        }
      })());
    }

    await sleep(stopAt - Date.now());
    killed = true;
    server.child.kill('SIGKILL');
    await new Promise((r) => (server.child.exitCode !== null || server.child.signalCode ? r() : server.child.once('exit', r)));
    await Promise.allSettled(tasks);
    log(`round ${round}: killed after ${((stopAt - roundStart) / 1000).toFixed(1)} s of writes`);
    checkFile(round);
    verify(round);
    server = await startServer();
    hub = server.hub;
    // Sessions survive a crash: a signed-in browser keeps working without signing in again.
    const someone = browsers.get(players[0].id);
    if (someone) {
      someone.hub = hub;
      const r = await someone.req('after restart: start page with the old cookie', 'GET', '/start', { expect: [200] });
      check(`round ${round}: the Hub starts again and old sessions still work`, r.ok, `status ${r.status}`);
    }
  }
  server.child.send({ type: 'stop' });
  await new Promise((r) => server.child.once('exit', r));
  finalChecks();
  const s = stats.summary();
  const failed = checks.filter((c) => !c.ok);
  const md = `# Crash test (${ROUNDS} × kill -9 during writes)\n\n${s.requests} requests; requests cut off by the kills are expected to fail (${s.errors}).\n\n` +
    `Confirmed and checked: ${[...ledger.saves.values()].reduce((n, e) => n + e.acked, 0)} saves (last value per person), ${[...ledger.results.values()].reduce((n, e) => n + e.acked, 0)} results, ` +
    `${ledger.versions.length} uploaded versions, ${ledger.classes.length} classes with ${ledger.classes.reduce((n, c) => n + c.joined.length, 0)} joins, ${ledger.deletedUsers.length} deleted accounts, ${ledger.deletedApps.length} deleted apps.\n\n` +
    `## Checks\n\n${checks.map((c) => `- ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? ` – ${c.detail}` : ''}`).join('\n')}\n`;
  fs.writeFileSync(path.join(OUT, 'report.md'), md);
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ checks, client: s }, null, 1));
  log(`${failed.length ? `${failed.length} checks FAILED` : 'all checks passed'} - ${path.join(OUT, 'report.md')}`);
  process.exit(failed.length ? 1 : 0);
}

function verify(round) {
  const db = new DatabaseSync(path.join(WORK, 'hub.sqlite'), { readOnly: true });
  const bad = [];
  const save = db.prepare("SELECT value FROM saves WHERE user_id = ? AND app_id = ? AND key = 'crashtest'");
  for (const [key, e] of ledger.saves) {
    if (!e.acked) continue;
    const [uid, aid] = key.split(':');
    const row = save.get(uid, aid);
    const v = row && JSON.parse(row.value);
    // The value is the last confirmed one - or a later one whose answer the kill cut off.
    if (!v || v.seq < e.acked || (v.seq !== e.acked && !e.unknown.includes(v.seq))) bad.push(`save ${key.slice(0, 13)}: confirmed ${e.acked}, found ${v && v.seq}`);
  }
  // The Hub keeps the newest RESULTS_KEPT results per person, app and class (limits.resultsPerUser):
  // beyond that, older ones go by design - so at least min(confirmed, RESULTS_KEPT) must be there.
  const results = db.prepare('SELECT COUNT(*) AS n FROM results WHERE user_id = ? AND app_id = ? AND title = ?');
  for (const [key, e] of ledger.results) {
    const [uid, aid] = key.split(':');
    const n = results.get(uid, aid, `Crashtest ${RUN}`).n;
    if (n < Math.min(e.acked, RESULTS_KEPT) || n > e.acked + e.unknown) bad.push(`results ${key.slice(0, 13)}: confirmed ${e.acked} (+${e.unknown} unknown), found ${n}`);
  }
  for (const oid of ledger.deletedUsers) if (db.prepare('SELECT 1 AS x FROM users WHERE oid = ?').get(oid)) bad.push(`deleted account ${oid} is back`);
  for (const id of ledger.deletedApps) if (db.prepare('SELECT 1 AS x FROM apps WHERE id = ?').get(id)) bad.push(`deleted app ${id} is back`);
  for (const c of ledger.classes) {
    if (!db.prepare("SELECT 1 AS x FROM class_members WHERE class_id = ? AND user_id = ? AND role = 'teacher'").get(c.classId, c.teacher)) bad.push(`class ${c.classId} lost its teacher`);
    for (const s of c.joined) if (!db.prepare('SELECT 1 AS x FROM class_members WHERE class_id = ? AND user_id = ?').get(c.classId, s)) bad.push(`join of ${s} into ${c.classId} lost`);
  }
  for (const v of ledger.versions) {
    if (ledger.deletedApps.includes(v.appId)) continue;
    const rows = db.prepare("SELECT f.path, f.sha256, ver.status FROM app_files f JOIN app_versions ver ON ver.id = f.version_id WHERE f.version_id = ?").all(v.vid);
    const got = Object.fromEntries(rows.map((r) => [r.path, r.sha256]));
    for (const [p, sha] of Object.entries(v.files)) {
      if (got[p] !== sha) bad.push(`version ${v.vid.slice(0, 6)} ${p} missing`);
      else if (!fs.existsSync(path.join(WORK, 'blobs', sha.slice(0, 2), sha))) bad.push(`blob of ${p} missing on disk`);
    }
    if (rows[0] && rows[0].status !== 'ready') bad.push(`version ${v.vid.slice(0, 6)} not ready`);
  }
  db.close();
  check(`round ${round}: every confirmed write is there, deletions stay deleted`, bad.length === 0, bad.slice(0, 4).join('; ') + (bad.length > 4 ? ` … (${bad.length})` : ''));
}

function finalChecks() {
  const db = new DatabaseSync(path.join(WORK, 'hub.sqlite'), { readOnly: true });
  const missingBlobs = db.prepare('SELECT DISTINCT sha256 FROM app_files UNION SELECT DISTINCT sha256 FROM draft_files').all()
    .filter((r) => !fs.existsSync(path.join(WORK, 'blobs', r.sha256.slice(0, 2), r.sha256)));
  const missingUserFiles = db.prepare('SELECT DISTINCT sha256 FROM user_files').all().filter((r) => !fs.existsSync(path.join(WORK, 'userfiles', r.sha256.slice(0, 2), r.sha256)));
  const brokenPublished = db.prepare("SELECT a.id FROM apps a LEFT JOIN app_versions v ON v.id = a.published_version_id WHERE a.published_version_id IS NOT NULL AND (v.id IS NULL OR v.status <> 'ready' OR v.app_id <> a.id)").all();
  const brokenClassApps = db.prepare("SELECT ca.class_id FROM class_apps ca LEFT JOIN app_versions v ON v.id = ca.version_id WHERE ca.version_id IS NOT NULL AND (v.id IS NULL OR v.status <> 'ready')").all();
  const orphanClasses = db.prepare("SELECT c.id FROM classes c WHERE NOT EXISTS (SELECT 1 FROM class_members m WHERE m.class_id = c.id AND m.role = 'teacher')").all();
  const referenced = new Set(db.prepare('SELECT sha256 FROM app_files UNION SELECT sha256 FROM draft_files').all().map((r) => r.sha256));
  db.close();
  let orphanBlobs = 0;
  let orphanBytes = 0;
  for (const d of fs.readdirSync(path.join(WORK, 'blobs'))) {
    for (const f of fs.readdirSync(path.join(WORK, 'blobs', d))) {
      if (!referenced.has(f)) {
        orphanBlobs++;
        orphanBytes += fs.statSync(path.join(WORK, 'blobs', d, f)).size;
      }
    }
  }
  check('end: every app file the database names exists on disk', missingBlobs.length === 0, `${missingBlobs.length} missing`);
  check('end: every user file the database names exists on disk', missingUserFiles.length === 0, `${missingUserFiles.length} missing`);
  check('end: every published version exists and is ready', brokenPublished.length === 0, `${brokenPublished.length} broken`);
  check('end: every version a class plays exists and is ready', brokenClassApps.length === 0, `${brokenClassApps.length} broken`);
  check('end: every class still has a teacher', orphanClasses.length === 0, `${orphanClasses.length} without`);
  check(`end: files on disk nobody refers to (left by a kill between database and disk): ${orphanBlobs} (${Math.round(orphanBytes / 1024)} KB)`, true);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
