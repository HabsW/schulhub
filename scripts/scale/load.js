'use strict';
// Load and stress tests of SchulHub against a seeded school (scripts/scale/seed.js).
//
//   node scripts/scale/load.js --data <seeded dir> [--factor 1|3] [--scenario all|pages|signin|join|peak|soak]
//                              [--duration 240] [--soak-minutes 180] [--port 3701] [--profile-sql] [--out <dir>]
//
// The seeded folder is copied first (its data stays untouched), and the real Hub runs in real mode
// in a child process (scripts/scale/server.js) - load generator and server never share an event loop.
// Every request is timed; the server reports event-loop delay, event-loop utilisation, memory and
// garbage collection for each measured phase. After the load, every write the server confirmed is
// checked in the database: nothing lost, nothing written to the wrong person, class or app.
//
// Expected peak (factor 1): a class of 30 joins by QR code in the same second; 300 people sign in
// within 2 minutes; 10 classes play at once, each app saving every few seconds; their teachers
// read results (one exports CSV of the biggest class); two people upload app versions. Factor 3
// multiplies all of it.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { fork } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const { Stats, table } = require('./stats');
const { Browser, AppSession, sha256 } = require('./client');

// ------------------------------------------------------------------ options
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const flag = (name) => argv.includes(`--${name}`);
const ROOT = path.join(__dirname, '..', '..');
const O = {
  data: opt('data', null),
  port: Number(opt('port', '3701')),
  factor: Number(opt('factor', '1')),
  scenario: opt('scenario', 'all'),
  duration: Number(opt('duration', '240')),
  soakMinutes: Number(opt('soak-minutes', '180')),
  profileSql: flag('profile-sql'),
  seed: Number(opt('seed', '7')),
};
if (!O.data) {
  console.error('Aufruf: node scripts/scale/load.js --data <Ordner von scripts/scale/seed.js> [--factor 3] [--scenario peak]');
  process.exit(2);
}
O.data = path.resolve(O.data);
O.work = path.resolve(opt('work', `${O.data}-run`));
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
O.out = path.resolve(opt('out', path.join(ROOT, 'data', 'scale-results', `${stamp}-${O.scenario}-x${O.factor}`)));
fs.mkdirSync(O.out, { recursive: true });

// Deterministic choices.
let rngState = O.seed >>> 0;
const rnd = () => {
  rngState = (rngState + 0x6d2b79f5) >>> 0;
  let t = rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (list) => list[Math.floor(rnd() * list.length)];
const shuffle = (list) => {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const until = (t) => sleep(t - Date.now());
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const RUN = Date.now().toString(36);

// The load generator watches its own event loop: if it is late, its numbers would be too.
const clientLag = monitorEventLoopDelay({ resolution: 10 });
clientLag.enable();

// ------------------------------------------------------------------ the server
class Server {
  constructor() {
    this.samples = [];
    this.waiting = new Map();
    this.n = 0;
  }

  start() {
    const logFile = fs.openSync(path.join(O.out, 'server.log'), 'a');
    const args = ['--data', O.work, '--port', String(O.port), ...(O.profileSql ? ['--profile-sql'] : [])];
    this.child = fork(path.join(__dirname, 'server.js'), args, { execArgv: ['--expose-gc'], stdio: ['ignore', logFile, logFile, 'ipc'] });
    this.child.on('message', (m) => {
      if (m.type === 'sample') this.samples.push(m);
      const w = this.waiting.get(m.id);
      if (w) {
        this.waiting.delete(m.id);
        w(m);
      }
      if (m.type === 'ready' && this.onReady) this.onReady(m);
    });
    this.exited = new Promise((r) => this.child.once('exit', (code, signal) => r({ code, signal })));
    return new Promise((resolve, reject) => {
      this.onReady = resolve;
      this.child.once('exit', (code) => reject(new Error(`server exited (${code}), see ${O.out}/server.log`)));
    });
  }

  ask(type) {
    const id = ++this.n;
    return new Promise((r) => {
      this.waiting.set(id, r);
      this.child.send({ type, id });
    });
  }

  async stop() {
    this.child.send({ type: 'stop' });
    await this.exited;
  }
}

// ------------------------------------------------------------------ the school
function loadPlan(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  const users = new Map(db.prepare('SELECT id, oid, name, email, role, disabled FROM users').all().map((u) => [u.id, { ...u }]));
  const classes = db.prepare("SELECT id, name FROM classes WHERE archived_at IS NULL ORDER BY name").all();
  const memberRows = db.prepare('SELECT class_id, user_id, role FROM class_members').all();
  const appsIn = db.prepare(
    `SELECT a.id, a.origin_key, a.name, a.owner_id, ca.version_id, v.manifest FROM class_apps ca JOIN apps a ON a.id = ca.app_id
       JOIN app_versions v ON v.id = ca.version_id AND v.status = 'ready' WHERE ca.class_id = ? AND ca.status = 'approved' ORDER BY a.name`
  );
  const byId = new Map(classes.map((c) => [c.id, Object.assign(c, { students: [], teachers: [], apps: [] })]));
  for (const u of users.values()) u.classes = []; // active classes only
  for (const m of memberRows) {
    const c = byId.get(m.class_id);
    const u = users.get(m.user_id);
    if (!u || !c) continue;
    u.classes.push(m.class_id);
    if (u.disabled) continue;
    (m.role === 'teacher' ? c.teachers : c.students).push(u);
  }
  for (const c of classes) {
    c.apps = appsIn.all(c.id).map((a) => {
      let achievements = [];
      try {
        achievements = (JSON.parse(a.manifest || '{}').achievements || []).map((x) => x.id);
      } catch {
        // no manifest
      }
      return { id: a.id, origin_key: a.origin_key, name: a.name, owner_id: a.owner_id, achievements };
    });
  }
  for (const r of db.prepare('SELECT owner_id, COUNT(*) AS n FROM apps GROUP BY owner_id').all()) {
    const u = users.get(r.owner_id);
    if (u) u.apps = r.n;
  }
  db.close();
  const active = [...users.values()].filter((u) => !u.disabled);
  return {
    users,
    classes,
    students: active.filter((u) => u.role === 'student'),
    teachers: active.filter((u) => u.role === 'teacher'),
    admin: active.find((u) => u.role === 'admin'),
  };
}

// ------------------------------------------------------------------ report
const report = { options: { ...O }, started: new Date().toISOString(), scenarios: [], checks: [] };
const md = [];
function section(title, stats, win, extra = '') {
  const s = stats.summary();
  report.scenarios.push({ title, client: s, server: win });
  md.push(`## ${title}\n`);
  md.push(`${s.requests} requests in ${s.seconds} s (${s.perSecond}/s), errors: ${s.errors} (${(s.errorRate * 100).toFixed(3)} %)`);
  md.push(`All requests: p50 ${s.total.p50} ms · p95 ${s.total.p95} ms · p99 ${s.total.p99} ms · max ${s.total.max} ms\n`);
  md.push(table(s.labels, [['label', 'Request'], ['n', 'n', 'r'], ['errors', 'Errors', 'r'], ['p50', 'p50 ms', 'r'], ['p95', 'p95 ms', 'r'], ['p99', 'p99 ms', 'r'], ['max', 'max ms', 'r']]));
  if (win) {
    md.push(`\nServer: event-loop delay p50 ${win.lag.p50} ms · p99 ${win.lag.p99} ms · max ${win.lag.max} ms · event-loop utilisation ${(win.elu * 100).toFixed(1)} % · RSS max ${win.rssMaxMB} MB · heap max ${win.heapMaxMB} MB · GC ${win.gc.count}× ${win.gc.totalMs} ms (longest ${win.gc.maxMs} ms)`);
    if (win.sql && win.sql.length) {
      md.push('\nSQL by total time:\n');
      md.push(table(win.sql.slice(0, 10).map((q) => ({ ...q, sql: `\`${q.sql.slice(0, 110).replace(/\|/g, '/')}\`` })), [['totalMs', 'total ms', 'r'], ['n', 'n', 'r'], ['avgMs', 'avg ms', 'r'], ['maxMs', 'max ms', 'r'], ['sql', 'Statement']]));
    }
  }
  if (s.firstErrors.length) md.push(`\nFirst errors:\n${s.firstErrors.slice(0, 15).map((e) => `- ${e.label}: ${e.error}`).join('\n')}`);
  if (extra) md.push(`\n${extra}`);
  md.push('');
  writeReport();
}
function check(name, ok, detail = '') {
  report.checks.push({ name, ok, detail });
  log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
}
function writeReport() {
  const lag = { p50: clientLag.percentile(50) / 1e6, p99: clientLag.percentile(99) / 1e6, max: clientLag.max / 1e6 };
  report.loadGenerator = { lagMs: lag };
  fs.writeFileSync(path.join(O.out, 'report.json'), JSON.stringify(report, null, 1));
  const checks = report.checks.length ? `## Checks\n\n${report.checks.map((c) => `- ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? ` – ${c.detail}` : ''}`).join('\n')}\n` : '';
  fs.writeFileSync(
    path.join(O.out, 'report.md'),
    `# Load test ${O.scenario} ×${O.factor} (${report.started})\n\nData: ${O.data}\nLoad generator event-loop delay: p99 ${lag.p99.toFixed(1)} ms, max ${lag.max.toFixed(1)} ms\n\n${md.join('\n')}\n${checks}`
  );
}

// ------------------------------------------------------------------ helpers
let hub; // { origin, appsSuffix }
const signedIn = new Map(); // user id -> Browser

async function browserFor(person, stats, prefix = 'setup sign-in') {
  let b = signedIn.get(person.id);
  if (b) {
    b.setStats(stats);
    return b;
  }
  b = new Browser(hub, stats, person);
  if (!(await b.signIn(person, { prefix }))) return null;
  signedIn.set(person.id, b);
  return b;
}

/** Run fn for each item with at most `limit` at once. */
async function pool(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

function openDb() {
  return new DatabaseSync(path.join(O.work, 'hub.sqlite'), { readOnly: true });
}

/** A zip archive (stored, no compression) built by hand: no dependency. */
function zipOf(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const n = Buffer.from(name);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6);
    head.writeUInt32LE(0x00210000, 10);
    head.writeUInt32LE(zlib.crc32(data), 14);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(n.length, 26);
    parts.push(head, n, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(0x0314, 4);
    c.writeUInt16LE(20, 6);
    head.copy(c, 8, 6, 30);
    c.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    c.writeUInt32LE(offset, 42);
    central.push(c, n);
    offset += 30 + n.length + data.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

/** The files of an app version as an author would upload them: the example app plus some assets. */
function appFiles(n, { bigBytes = 0 } = {}) {
  const dir = path.join(ROOT, 'examples', 'kopfrechnen');
  const files = {};
  for (const f of fs.readdirSync(dir)) files[f] = fs.readFileSync(path.join(dir, f));
  files['index.html'] = Buffer.from(files['index.html'].toString('utf8').replace('</body>', `<!-- Lasttest ${RUN} ${n} -->\n</body>`));
  for (let i = 0; i < 18; i++) files[`assets/sprite-${i}.svg`] = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="${(i % 5) + 1}" fill="#${crypto.randomBytes(3).toString('hex')}"/></svg>`);
  for (let i = 0; i < 2; i++) files[`assets/sound-${i}.mp3`] = crypto.randomBytes(200_000);
  if (bigBytes) files['assets/level-data.bin'] = crypto.randomBytes(bigBytes);
  return files;
}

// ================================================================== scenarios

/** Page timings with the real data on an idle server: which pages get slow with a big school? */
async function scenarioPages(plan, server) {
  const stats = new Stats('pages');
  const db = openDb();
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const bigClass = one("SELECT class_id AS id, COUNT(*) AS n FROM class_members m JOIN classes c ON c.id = m.class_id AND c.archived_at IS NULL WHERE m.role = 'student' GROUP BY class_id ORDER BY n DESC LIMIT 1");
  const bigTeacher = plan.users.get(one("SELECT user_id AS id FROM class_members WHERE class_id = ? AND role = 'teacher' LIMIT 1", bigClass.id).id);
  const busyStudent = plan.users.get(one("SELECT m.user_id AS id FROM class_members m JOIN users u ON u.id = m.user_id AND u.disabled = 0 JOIN classes c ON c.id = m.class_id AND c.archived_at IS NULL WHERE m.role = 'student' GROUP BY m.user_id ORDER BY COUNT(*) DESC, m.user_id LIMIT 1").id);
  const lonely = plan.students.find((u) => u.classes.length === 0);
  const bigApp = one("SELECT r.app_id AS id, COUNT(*) AS n FROM results r JOIN class_members m ON m.user_id = r.user_id AND m.class_id = ? WHERE r.class_id = ? GROUP BY r.app_id ORDER BY n DESC LIMIT 1", bigClass.id, bigClass.id);
  const someStudent = one("SELECT user_id AS id FROM class_members WHERE class_id = ? AND role = 'student' LIMIT 1", bigClass.id).id;
  const ownApp = one('SELECT id FROM apps WHERE owner_id = ? ORDER BY updated_at DESC LIMIT 1', bigTeacher.id);
  const busyApp = one('SELECT app_id AS id FROM plays WHERE user_id = ? ORDER BY last_at DESC LIMIT 1', busyStudent.id);
  const busyClass = busyStudent.classes[0];
  const task = one('SELECT id FROM assignments WHERE class_id = ? ORDER BY created_at DESC LIMIT 1', bigClass.id);
  const heavyUser = one('SELECT user_id AS id FROM results GROUP BY user_id ORDER BY COUNT(*) DESC LIMIT 1').id;
  db.close();
  const cls = `/klassen/${bigClass.id}`;
  const people = [
    ['student in most classes', busyStudent, ['/start', '/klassen', `/klassen/${busyClass}`, '/katalog', '/suche?q=a', '/apps', '/meine-daten', '/mitteilungen', '/rueckmeldungen', busyApp ? `/apps/${busyApp.id}/spielen` : null, '/meine-daten/export']],
    ['student in no class', lonely, ['/start', '/klassen', '/katalog', '/apps', '/meine-daten']],
    [`teacher of the biggest class (${bigClass.n} students)`, bigTeacher, [
      '/start', '/klassen', cls, `${cls}/mitglieder`, `${cls}/apps`, `${cls}/aufgaben`, `${cls}/einstellungen`, `${cls}/qr`,
      bigApp ? `${cls}/apps/${bigApp.id}/ergebnisse` : null, bigApp ? `${cls}/apps/${bigApp.id}/ergebnisse.csv` : null,
      bigApp ? `${cls}/apps/${bigApp.id}/ergebnisse/${someStudent}` : null, task ? `/aufgaben/${task.id}` : null,
      '/pruefen', '/apps', ownApp ? `/apps/${ownApp.id}` : null, '/katalog', '/meine-daten', '/meine-daten/export',
    ]],
    ['admin', plan.admin, ['/admin', '/admin/konten', `/admin/konten/${heavyUser}`, '/admin/klassen', '/admin/apps', '/admin/protokoll', '/admin/protokoll?q=Lena', '/admin/aufbewahrung', '/admin/sicherung', '/ankuendigungen', '/start', '/katalog']],
  ];
  const rows = [];
  for (const [who, person, urls] of people) {
    if (!person) continue;
    const b = await browserFor(person, stats);
    if (!b) {
      stats.fail('pages', `sign-in failed for ${who}`);
      continue;
    }
    for (const url of urls.filter(Boolean)) {
      const label = url.replace(/[A-Za-z0-9_-]{20,}/g, ':id');
      const times = [];
      let sql = null;
      for (let i = 0; i < 5; i++) {
        if (i === 4 && O.profileSql) await server.ask('window-start');
        const r = await b.req(`${who}: ${label}`, 'GET', url, { expect: [200] });
        if (i === 4 && O.profileSql) sql = (await server.ask('window-end')).sql.slice(0, 3);
        times.push(r.ms);
      }
      times.sort((x, y) => x - y);
      rows.push({ who, page: label, median: Math.round(times[2] * 10) / 10, max: Math.round(times[4] * 10) / 10, sql: sql && times[2] > 30 ? sql.map((q) => `${q.totalMs} ms ${q.sql.slice(0, 70)}`).join(' / ') : '' });
    }
  }
  rows.sort((a, b) => b.median - a.median);
  section('Pages with the big school (idle server, 5 loads each)', stats, null,
    table(rows, [['who', 'Who'], ['page', 'Page'], ['median', 'median ms', 'r'], ['max', 'max ms', 'r'], ['sql', 'Top SQL (slow pages)']]));
  report.pages = rows;
}

/** Morning: 300 × factor people sign in within 2 minutes. */
async function scenarioSignIn(plan, server, people) {
  const stats = new Stats('sign-in');
  const span = 120_000;
  const t0 = Date.now() + 1000;
  await server.ask('window-start');
  const total = [];
  await Promise.all(people.map(async (person, i) => {
    await until(t0 + (i / people.length) * span + rnd() * 400);
    const started = performance.now();
    const b = new Browser(hub, stats, person);
    const ok = await b.signIn(person, { prefix: 'sign-in' });
    if (ok) {
      signedIn.set(person.id, b);
      // and on to the first page they need
      if (person.role === 'student' && person.classes.length) await b.page('after sign-in: class page', `/klassen/${person.classes[0]}`);
      else await b.page('after sign-in: classes', '/klassen');
    }
    total.push(performance.now() - started);
  }));
  const win = await server.ask('window-end');
  total.sort((a, b) => a - b);
  const q = (x) => Math.round(total[Math.floor(x * (total.length - 1))]);
  section(`Morning sign-in: ${people.length} people within 2 minutes`, stats, win,
    `Whole sign-in per person (Hub page, Microsoft stand-in with ${150} ms ±50 % network delay, back, first page): p50 ${q(0.5)} ms, p95 ${q(0.95)} ms, max ${q(1)} ms.`);
  const db = openDb();
  const missing = people.filter((p) => !db.prepare('SELECT 1 AS ok FROM sessions WHERE user_id = ? AND expires_at > ?').get(p.id, Date.now()));
  db.close();
  check(`sign-in: every one of ${people.length} people has a session`, missing.length === 0, missing.length ? `${missing.length} without` : '');
}

/** A class of 30 (× factor classes) joins by QR code in the same second. */
async function scenarioJoin(plan, server) {
  const stats = new Stats('join');
  const teachers = shuffle(plan.teachers.filter((t) => t.classes.length < 50)).slice(0, O.factor);
  const pool30 = shuffle(plan.students.filter((s) => s.classes.length <= 2));
  const groups = [];
  for (const [i, teacher] of teachers.entries()) {
    const tb = await browserFor(teacher, stats);
    await tb.page('teacher: new class form', '/klassen/neu');
    const created = await tb.post('teacher: create class', '/klassen', { name: `Lasttest ${RUN} Klasse ${i + 1}` });
    const classId = created.location.split('/').pop();
    const qr = await tb.page('teacher: QR page', `/klassen/${classId}/qr`);
    const link = /\/beitreten\/([A-Za-z0-9_-]{32})/.exec(qr.text);
    const status = /data-status="([^"]+)"/.exec(qr.text);
    groups.push({ classId, code: link[1], status: status[1].replace(/&amp;/g, '&'), teacher: tb, students: pool30.splice(0, 30) });
  }
  // Half of each class is already signed in (school computers), half scans with a phone and signs in first.
  await pool(groups.flatMap((g) => g.students.slice(0, 15)), 20, (s) => browserFor(s, new Stats('setup')));
  const t0 = Date.now() + 3000;
  await server.ask('window-start');
  const stopPolling = { done: false };
  const polls = groups.map(async (g) => {
    await until(t0 - 2000);
    while (!stopPolling.done) {
      await g.teacher.req('teacher: QR status (projector polls)', 'GET', g.status, { expect: [200] });
      await sleep(2000);
    }
  });
  const joinTimes = [];
  await Promise.all(groups.flatMap((g) => g.students.map(async (s, i) => {
    await until(t0);
    const started = performance.now();
    const link = `/beitreten/${g.code}`;
    let b = i < 15 ? signedIn.get(s.id) : null;
    if (b) {
      b.setStats(stats);
      await b.page('join: open link (signed in)', link);
    } else {
      b = new Browser(hub, stats, s);
      const ok = await b.signIn(s, { entry: link, prefix: 'join: phone sign-in' });
      if (!ok) return;
      signedIn.set(s.id, b);
    }
    const done = await b.post('join: confirm', link, {});
    if (done.ok) await b.page('join: class page', done.location);
    joinTimes.push(performance.now() - started);
  })));
  stopPolling.done = true;
  await Promise.all(polls);
  const win = await server.ask('window-end');
  joinTimes.sort((a, b) => a - b);
  const q = (x) => Math.round(joinTimes[Math.floor(x * (joinTimes.length - 1))] || 0);
  section(`QR join: ${groups.length} class(es) of 30 join in the same second`, stats, win,
    `From scanning to the class page, per student: p50 ${q(0.5)} ms, p95 ${q(0.95)} ms, max ${q(1)} ms (half of them sign in first).`);
  const db = openDb();
  for (const g of groups) {
    const members = db.prepare("SELECT user_id FROM class_members WHERE class_id = ? AND role = 'student'").all(g.classId).map((r) => r.user_id).sort();
    const want = g.students.map((s) => s.id).sort();
    check(`join: class ${g.classId.slice(0, 6)} has exactly its 30 students`, JSON.stringify(members) === JSON.stringify(want), `${members.length} members`);
  }
  db.close();
}

/** The peak: classes play at once, teachers read results and export, people upload. */
async function scenarioPeak(plan, server, playing, { duration = O.duration, title = '', interval = 4000, uploaders = 2 * O.factor, exportsEvery = 60_000, soak = false, tag = RUN } = {}) {
  // Every phase writes under its own tag (key, board, result title): a soak lesson that meets the same class and
  // app again must not count the writes of an earlier lesson as its own.
  const KEY = `lt-${tag}`.slice(0, 64);
  const stats = new Stats(title);
  const ledger = []; // what the server confirmed, checked afterwards
  const sessions = [];
  // Every class plays one of its apps; its students open it within the first 20 seconds.
  for (const c of playing) {
    c.lesson = c.apps.find((a) => a.achievements.length) || c.apps[0];
  }
  const setup = new Stats('setup');
  // A student in two playing classes plays in the first one (one app at a time).
  const seen = new Set();
  const players = playing.flatMap((c) => c.students.map((s) => ({ s, c }))).filter(({ s }) => !seen.has(s.id) && seen.add(s.id));
  await pool(players, 40, async ({ s }) => {
    const b = await browserFor(s, setup);
    if (b) b.setStats(stats);
  });
  for (const c of playing) for (const t of c.teachers.slice(0, 1)) (await browserFor(t, setup))?.setStats(stats);
  log(`peak: ${players.length} players in ${playing.length} classes, ${uploaders} uploaders`);

  const stopAt = Date.now() + 25_000 + duration * 1000;
  let measuring = false;
  const startMeasure = sleep(25_000).then(async () => {
    await server.ask('window-start');
    measuring = true;
    stats.started = Date.now();
    stats.labels.clear();
    stats.series = [];
    stats.errorCount = 0;
    stats.errors = [];
  });

  const play = async ({ s, c }) => {
    const b = signedIn.get(s.id);
    if (!b) return stats.fail('play', `${s.id} not signed in`);
    await sleep(rnd() * 20_000);
    const app = new AppSession(b, c.lesson, c.id);
    if (!(await app.open())) return stats.fail('play', 'could not open the app');
    const entry = { user: s, app: c.lesson, classId: c.id, seq: 0, ackedSeq: 0, unknownSeq: [], best: null, bestUnknown: [], results: 0, resultsUnknown: 0, progress: null, achievements: new Set() };
    ledger.push(entry);
    sessions.push(app);
    await app.api('settings.all');
    await app.api('save.get', { key: KEY });
    await app.api('achievements.list');
    await app.api('scores.top', { board: KEY, limit: 10 });
    let i = 0;
    while (Date.now() < stopAt) {
      await sleep(interval * (0.75 + rnd() * 0.5));
      if (Date.now() >= stopAt) break;
      i++;
      const seq = ++entry.seq;
      const value = { owner: s.oid, seq, run: tag, level: seq % 10, notes: 'x'.repeat(200 + Math.floor(rnd() * 2800)) };
      const saved = await app.api('save.set', { key: KEY, value });
      if (saved.ok) entry.ackedSeq = seq;
      else if (saved.unknown) entry.unknownSeq.push(seq);
      if (i % 2 === 0) {
        const v = (seq % 100) / 100;
        const p = await app.api('progress.set', { value: v, label: `Stufe ${seq % 10}` });
        if (p.ok) entry.progress = v;
        else entry.progress = undefined;
      }
      if (i % 3 === 0) {
        const score = rnd() < 0.2 ? Math.floor(rnd() * 10) : seq * 10 + Math.floor(rnd() * 10);
        const r = await app.api('scores.submit', { board: KEY, score });
        if (r.ok) entry.best = Math.max(entry.best ?? -Infinity, score);
        else if (r.unknown) entry.bestUnknown.push(score);
      }
      if (i % 4 === 0) {
        const r = await app.api('results.add', { title: `Lasttest ${tag}`, score: seq % 20, maxScore: 20, details: { aufgabe: `${seq} + ${seq}`, antwort: 2 * seq, richtig: true } });
        if (r.ok) entry.results++;
        else if (r.unknown) entry.resultsUnknown++;
      }
      if (i % 8 === 0) {
        const r = await app.api('scores.top', { board: KEY, limit: 10 });
        if (r.ok && entry.best !== null && entry.bestUnknown.length === 0) {
          const me = r.result.me && r.result.me.score;
          if (me !== entry.best) stats.fail('consistency: leaderboard shows my best', `expected ${entry.best}, got ${me}`);
          const scores = r.result.entries.map((x) => x.score);
          if (scores.some((x, k) => k > 0 && x > scores[k - 1])) stats.fail('consistency: leaderboard order', JSON.stringify(scores));
        }
      }
      if (i % 20 === 0 && c.lesson.achievements.length) {
        const id = c.lesson.achievements[(i / 20) % c.lesson.achievements.length];
        const r = await app.api('achievements.unlock', { id });
        if (r.ok) entry.achievements.add(id);
      }
      if (i % 25 === 0) {
        const r = await app.api('save.get', { key: KEY });
        if (r.ok && entry.unknownSeq.length === 0 && (!r.result || r.result.seq !== entry.ackedSeq || r.result.owner !== s.oid)) {
          stats.fail('consistency: read back my save', `expected seq ${entry.ackedSeq}, got ${r.result && r.result.seq} (${r.result && r.result.owner})`);
        }
      }
      if (rnd() < 0.02) await b.page('student: start page in between', '/start');
    }
  };

  const teacherLoop = async (c) => {
    const t = c.teachers[0];
    const b = t && signedIn.get(t.id);
    if (!b) return;
    const base = `/klassen/${c.id}/apps/${c.lesson.id}/ergebnisse`;
    let n = 0;
    await sleep(rnd() * 20_000);
    while (Date.now() < stopAt) {
      n++;
      await b.page('teacher: results page (live)', base);
      if (n % 3 === 0) await b.page('teacher: class page', `/klassen/${c.id}`);
      await sleep(20_000 * (0.75 + rnd() * 0.5));
    }
  };

  // The teacher of the biggest playing class exports CSV regularly, while everything else runs.
  const biggest = [...playing].sort((a, b) => b.students.length - a.students.length)[0];
  const exportLoop = async () => {
    const t = biggest.teachers[0];
    const b = t && signedIn.get(t.id);
    if (!b) return;
    await startMeasure;
    while (Date.now() < stopAt - 5000) {
      await sleep(exportsEvery / 2);
      const csv = await b.req(`teacher: CSV export (${biggest.students.length} students)`, 'GET', `/klassen/${biggest.id}/apps/${biggest.lesson.id}/ergebnisse.csv`, { expect: [200] });
      if (csv.ok) {
        const lines = csv.text.trim().split('\r\n');
        const names = new Set(biggest.students.map((x) => x.name));
        const foreign = lines.slice(1).filter((l) => !names.has(l.split(';')[0].replace(/^"|"$/g, '').replace(/^'/, '')));
        if (foreign.length) stats.fail('consistency: CSV only has the class', `${foreign.length} lines of other people: ${foreign[0].slice(0, 60)}`);
      }
      await b.page(`teacher: results page (${biggest.students.length} students)`, `/klassen/${biggest.id}/apps/${biggest.lesson.id}/ergebnisse`);
      await sleep(exportsEvery / 2);
    }
  };

  // Uploads: teachers upload new versions of a fresh app (25 files, ~0.5 MB) and publish them; one ZIP of ~10 MB per factor.
  const uploads = [];
  const uploadLoop = async (teacher, k) => {
    const b = await browserFor(teacher, setup);
    if (!b) return;
    b.setStats(stats);
    await b.page('upload: new app form', '/apps/neu');
    const made = await b.post('upload: create app', '/apps', { name: `Lasttest ${RUN} ${k}`, emoji: '🎮', color: '1' });
    const appId = made.location && made.location.split('/').pop();
    if (!appId) return;
    await b.page('upload: app page', `/apps/${appId}`);
    await sleep(5000 + k * 3000);
    let n = 0;
    while (Date.now() < stopAt - 10_000 && n < 15) {
      n++;
      const files = appFiles(`${k}-${n}`);
      const v = await b.send('upload: start version', 'POST', `/apps/${appId}/versionen`, {});
      if (!v.ok) break;
      const vid = JSON.parse(v.text).id;
      const list = Object.entries(files);
      await pool(list, 3, ([p, data]) => b.send('upload: one file (PUT)', 'PUT', `/apps/${appId}/versionen/${vid}/datei?pfad=${encodeURIComponent(p)}`, data, { type: 'application/octet-stream' }));
      const done = await b.send('upload: finish version (checks)', 'POST', `/apps/${appId}/versionen/${vid}/fertig`, {});
      if (done.ok) {
        uploads.push({ appId, versionId: vid, files: Object.fromEntries(list.map(([p, d]) => [p, sha256(d)])) });
        await b.page('upload: app page', `/apps/${appId}`);
        await b.post('upload: publish', `/apps/${appId}/veroeffentlichen`, { version: vid });
      }
      if (k === 0 && n === 2) {
        // One big ZIP per run and factor, as a teacher uploads an exported game.
        for (let z = 0; z < O.factor; z++) {
          const zfiles = appFiles(`zip-${z}`, { bigBytes: 9 * 1024 * 1024 });
          const r = await b.req('upload: ZIP of ~10 MB', 'POST', `/apps/${appId}/versionen/zip`, {
            headers: { 'content-type': 'application/zip', accept: 'application/json', 'x-csrf-token': b.csrf, origin: hub.origin },
            body: zipOf(zfiles),
          });
          if (r.ok) uploads.push({ appId, versionId: JSON.parse(r.text).id, files: Object.fromEntries(Object.entries(zfiles).map(([p, d]) => [p, sha256(d)])) });
        }
      }
      await sleep(30_000 * (0.75 + rnd() * 0.5));
    }
  };
  const uploadTeachers = shuffle(plan.teachers.filter((t) => !playing.some((c) => c.teachers.includes(t)) && (t.apps || 0) < 25)).slice(0, uploaders);

  await Promise.all([
    ...players.map(play),
    ...playing.map(teacherLoop),
    exportLoop(),
    ...uploadTeachers.map(uploadLoop),
    startMeasure,
  ]);
  const win = measuring ? await server.ask('window-end') : null;
  const extra = soak ? '' : `Players: ${players.length} in ${playing.length} classes (each saves every ~${interval / 1000} s, plus progress, scores, results, leaderboards); ${playing.length} teachers reading results every ~20 s; CSV export of a class of ${biggest.students.length} every ${exportsEvery / 1000} s; ${uploadTeachers.length} people uploading versions (25 files) and ${O.factor} ZIP(s) of ~10 MB.`;
  section(title, stats, win, extra);
  if (soak) report.soakTimeline = stats.timeline(5);
  verifyLedger(ledger, title, tag);
  verifyUploads(uploads);
  return { stats, win, ledger };
}

/** Every write the server confirmed is in the database, for the right person, app and class. */
function verifyLedger(ledger, title, tag = RUN) {
  const KEY = `lt-${tag}`.slice(0, 64);
  const db = openDb();
  const save = db.prepare('SELECT value FROM saves WHERE app_id = ? AND user_id = ? AND key = ?');
  const score = db.prepare('SELECT score FROM scores WHERE app_id = ? AND board = ? AND user_id = ?');
  const results = db.prepare("SELECT class_id, COUNT(*) AS n FROM results WHERE app_id = ? AND user_id = ? AND title = ? GROUP BY class_id");
  const progress = db.prepare('SELECT value FROM progress WHERE app_id = ? AND user_id = ?');
  const ach = db.prepare('SELECT achievement FROM achievements WHERE app_id = ? AND user_id = ?');
  let bad = [];
  for (const e of ledger) {
    const where = `${e.user.id.slice(0, 6)} in ${e.app.id.slice(0, 6)}`;
    if (e.ackedSeq > 0) {
      const row = save.get(e.app.id, e.user.id, KEY);
      const v = row && JSON.parse(row.value);
      const okSeq = v && (v.seq === e.ackedSeq || e.unknownSeq.includes(v.seq));
      if (!v || v.owner !== e.user.oid || !okSeq || v.run !== tag) bad.push(`save ${where}: expected seq ${e.ackedSeq} of ${e.user.oid}, found ${v ? `${v.seq} of ${v.owner}` : 'nothing'}`);
    }
    if (e.best !== null) {
      const row = score.get(e.app.id, KEY, e.user.id);
      const okBest = row && (row.score === e.best || (e.bestUnknown.length && row.score === Math.max(e.best, ...e.bestUnknown)));
      if (!okBest) bad.push(`score ${where}: expected ${e.best}, found ${row && row.score}`);
    }
    const rs = results.all(e.app.id, e.user.id, `Lasttest ${tag}`);
    const total = rs.reduce((n, r) => n + r.n, 0);
    if (total < e.results || total > e.results + e.resultsUnknown) bad.push(`results ${where}: expected ${e.results}, found ${total}`);
    if (rs.some((r) => r.class_id !== e.classId)) bad.push(`results ${where}: recorded under another class (${rs.map((r) => r.class_id).join(',')})`);
    if (e.progress !== null && e.progress !== undefined) {
      const row = progress.get(e.app.id, e.user.id);
      if (!row || Math.abs(row.value - e.progress) > 1e-9) bad.push(`progress ${where}: expected ${e.progress}, found ${row && row.value}`);
    }
    const have = new Set(ach.all(e.app.id, e.user.id).map((r) => r.achievement));
    for (const id of e.achievements) if (!have.has(id)) bad.push(`achievement ${where}: ${id} missing`);
  }
  // Nothing of this run landed with somebody else: every saved value names the person it belongs to.
  const foreign = db.prepare('SELECT s.user_id, u.oid, s.value FROM saves s JOIN users u ON u.id = s.user_id WHERE s.key = ?').all(KEY)
    .filter((r) => JSON.parse(r.value).owner !== r.oid);
  db.close();
  if (foreign.length) bad.push(`${foreign.length} saves hold another person's data`);
  const writes = ledger.reduce((n, e) => n + e.ackedSeq + e.results, 0);
  check(`${title}: every confirmed write of ${ledger.length} players is in the database, for the right person, app and class (${writes} saves and results checked)`, bad.length === 0, bad.slice(0, 5).join('; ') + (bad.length > 5 ? ` … (${bad.length})` : ''));
}

function verifyUploads(uploads) {
  if (!uploads.length) return;
  const db = openDb();
  const bad = [];
  for (const u of uploads) {
    const rows = db.prepare('SELECT path, sha256 FROM app_files WHERE version_id = ?').all(u.versionId);
    const got = Object.fromEntries(rows.map((r) => [r.path, r.sha256]));
    for (const [p, sha] of Object.entries(u.files)) {
      if (got[p] !== sha) bad.push(`${u.versionId.slice(0, 6)} ${p}: ${got[p] ? 'other content' : 'missing'}`);
      else {
        const file = path.join(O.work, 'blobs', sha.slice(0, 2), sha);
        if (!fs.existsSync(file) || sha256(fs.readFileSync(file)) !== sha) bad.push(`${p}: blob missing or damaged`);
      }
    }
  }
  db.close();
  check(`uploads: ${uploads.length} versions stored byte for byte`, bad.length === 0, bad.slice(0, 5).join('; '));
}

/**
 * Where is the limit? Every class with an app plays at once, and the time between saves halves at
 * every step (4 s, 2 s, 1 s, 0.5 s, 0.25 s) until answers get slow or fail. Factor = requests per
 * second compared with the expected peak (10 classes saving every ~4 s).
 */
async function scenarioRamp(plan, server) {
  const classes = plan.classes.filter((c) => c.students.length >= 5 && c.apps.length && c.teachers.length);
  const seen = new Set();
  const players = classes.flatMap((c) => c.students.map((s) => ({ s, c }))).filter(({ s }) => !seen.has(s.id) && seen.add(s.id));
  for (const c of classes) c.lesson = c.apps.find((a) => a.achievements.length) || c.apps[0];
  const setup = new Stats('setup');
  log(`ramp: signing in ${players.length} players`);
  await pool(players, 40, ({ s }) => browserFor(s, setup));
  const state = { interval: 4000, stats: new Stats('ramp'), stop: false };
  const steps = [4000, 2000, 1000, 500, 250, 125];
  const rows = [];
  // Expected peak: ~300 players, one save every ~4 s, plus the other calls of the peak scenario.
  const peakRate = 300 / 4;
  const loops = players.map(async ({ s, c }, k) => {
    const b = signedIn.get(s.id);
    if (!b) return;
    b.setStats(state.stats);
    await sleep((k % 50) * 200);
    const app = new AppSession(b, c.lesson, c.id);
    if (!(await app.open({ files: false }))) return;
    let i = 0;
    while (!state.stop) {
      await sleep(state.interval * (0.75 + rnd() * 0.5));
      if (state.stop) break;
      b.setStats(state.stats);
      i++;
      await app.api('save.set', { key: 'lasttest', value: { owner: s.oid, seq: i, run: RUN, notes: 'x'.repeat(500 + Math.floor(rnd() * 1500)) } });
      if (i % 3 === 0) await app.api('scores.submit', { board: 'lasttest', score: i });
      if (i % 4 === 0) await app.api('results.add', { title: `Lasttest ${RUN}`, score: i % 20, maxScore: 20 });
      if (i % 8 === 0) await app.api('scores.top', { board: 'lasttest', limit: 10 });
    }
  });
  await sleep(15_000);
  for (const interval of steps) {
    state.interval = interval;
    await sleep(Math.max(4000, interval * 2)); // settle at the new rate
    state.stats = new Stats(`ramp ${interval}`);
    const own = monitorEventLoopDelay({ resolution: 10 });
    own.enable();
    await server.ask('window-start');
    await sleep(45_000);
    const win = await server.ask('window-end');
    own.disable();
    const s = state.stats.summary();
    const saves = s.labels.find((l) => l.label === 'sdk: save.set');
    const row = {
      interval: `${interval} ms`, players: players.length, perSecond: s.perSecond,
      factor: Math.round(((saves ? saves.n / s.seconds : 0) / peakRate) * 10) / 10,
      p50: s.total.p50, p95: s.total.p95, p99: s.total.p99, max: s.total.max, errors: s.errors,
      elu: `${Math.round(win.elu * 100)} %`, lagP99: win.lag.p99, rss: win.rssMaxMB,
      // If the load generator itself is late, the step measures the generator, not the Hub.
      clientLagP99: Math.round(own.percentile(99) / 1e5) / 10,
    };
    rows.push(row);
    log(`ramp ${interval} ms: ${s.perSecond}/s, p95 ${s.total.p95} ms, errors ${s.errors}, ELU ${row.elu}`);
    report.ramp = rows;
    writeReport();
    if (s.total.p95 > 1000 || s.errorRate > 0.01) break;
  }
  state.stop = true;
  await Promise.all(loops);
  md.push(`## Ramp: where is the limit?\n\n${players.length} students in ${classes.length} classes play at once; the time between saves halves at each step (each step measured for 45 s). "× peak" compares the saves per second with the expected peak (10 classes, a save every ~4 s).\n`);
  md.push(table(rows, [['interval', 'Save every'], ['perSecond', 'requests/s', 'r'], ['factor', '× peak', 'r'], ['p50', 'p50 ms', 'r'], ['p95', 'p95 ms', 'r'], ['p99', 'p99 ms', 'r'], ['max', 'max ms', 'r'], ['errors', 'errors', 'r'], ['elu', 'ELU', 'r'], ['lagP99', 'lag p99 ms', 'r'], ['rss', 'RSS MB', 'r'], ['clientLagP99', 'generator lag p99 ms', 'r']]));
  md.push('');
  writeReport();
}

/** Several hours at normal load: lessons start and end, people sign in and out. */
async function scenarioSoak(plan, server) {
  const minutes = O.soakMinutes;
  const lessonMinutes = 15;
  const playable = plan.classes.filter((c) => c.students.length >= 10 && c.apps.length && c.teachers.length);
  const memory = [];
  const soakStart = Date.now();
  const sampler = setInterval(() => {
    const s = server.samples[server.samples.length - 1];
    if (s) memory.push({ minute: Math.round(((Date.now() - soakStart) / 60000) * 10) / 10, rssMB: Math.round(s.rss / 1048576), heapMB: Math.round(s.heapUsed / 1048576), sessions: s.sessions, elu: Math.round(s.elu * 1000) / 1000, lagP99: s.lagP99 });
  }, 30_000);
  const lessons = Math.ceil(minutes / lessonMinutes);
  const summaries = [];
  for (let l = 0; l < lessons; l++) {
    const left = minutes - l * lessonMinutes;
    const classes = shuffle(playable).slice(0, 5);
    // A new lesson: the classes sign in fresh (yesterday's sessions are not reused) and play.
    for (const c of classes) for (const p of [...c.students, ...c.teachers]) signedIn.delete(p.id);
    const r = await scenarioPeak(plan, server, classes, { duration: Math.min(lessonMinutes, left) * 60 - 25, title: `Soak lesson ${l + 1}/${lessons}`, uploaders: 1, exportsEvery: 300_000, soak: true, tag: `${RUN}-${l + 1}` });
    summaries.push({ lesson: l + 1, ...r.stats.summary().total, errors: r.stats.errorCount, elu: r.win && r.win.elu, lagP99: r.win && r.win.lag.p99, rssMaxMB: r.win && r.win.rssMaxMB });
    // People sign out at the end of the lesson, as on a school computer.
    for (const c of classes) {
      for (const p of c.students) {
        const b = signedIn.get(p.id);
        if (b && rnd() < 0.6) await b.post('soak: sign out', '/auth/logout', {}, [303]);
        signedIn.delete(p.id);
      }
    }
    if (server.child.connected) {
      const gc = await server.ask('gc');
      memory.push({ minute: Math.round(((Date.now() - soakStart) / 60000) * 10) / 10, afterGcHeapMB: Math.round(gc.memory.heapUsed / 1048576), rssMB: Math.round(gc.memory.rss / 1048576) });
    }
    report.soak = { memory, lessons: summaries };
    writeReport();
  }
  clearInterval(sampler);
  const afterGc = memory.filter((m) => m.afterGcHeapMB !== undefined);
  const firstHeap = afterGc[0]?.afterGcHeapMB;
  const lastHeap = afterGc[afterGc.length - 1]?.afterGcHeapMB;
  md.push(`## Soak: ${minutes} minutes at normal load\n\n5 classes play at a time; every ${lessonMinutes} minutes the next 5 classes sign in, play and sign out.\n`);
  md.push(table(summaries, [['lesson', 'Lesson', 'r'], ['p50', 'p50 ms', 'r'], ['p95', 'p95 ms', 'r'], ['p99', 'p99 ms', 'r'], ['max', 'max ms', 'r'], ['errors', 'errors', 'r'], ['elu', 'ELU', 'r'], ['lagP99', 'lag p99 ms', 'r'], ['rssMaxMB', 'RSS max MB', 'r']]));
  md.push(`\nHeap after a full GC at the end of each lesson: ${afterGc.map((m) => m.afterGcHeapMB).join(', ')} MB.`);
  check(`soak: heap after GC does not keep growing (first ${firstHeap} MB, last ${lastHeap} MB)`, lastHeap <= firstHeap * 1.25 + 10);
  const p95s = summaries.map((s) => s.p95);
  check(`soak: no slowdown (p95 first lesson ${p95s[0]} ms, last ${p95s[p95s.length - 1]} ms)`, p95s[p95s.length - 1] <= p95s[0] * 1.5 + 20);
  writeReport();
}

// ================================================================== main
async function main() {
  if (!fs.existsSync(path.join(O.data, 'hub.sqlite'))) throw new Error(`${O.data}/hub.sqlite fehlt - zuerst scripts/scale/seed.js ausführen`);
  log(`copying ${O.data} -> ${O.work}`);
  fs.rmSync(O.work, { recursive: true, force: true });
  fs.cpSync(O.data, O.work, { recursive: true });
  const plan = loadPlan(path.join(O.work, 'hub.sqlite'));
  log(`school: ${plan.students.length} students, ${plan.teachers.length} teachers, ${plan.classes.length} active classes`);

  const server = new Server();
  const ready = await server.start();
  hub = { origin: ready.origin, appsSuffix: ready.appsSuffix };
  log(`hub ${hub.origin} (pid ${ready.pid}), results in ${O.out}`);
  const want = (s) => O.scenario === 'all' || O.scenario.split(',').includes(s);

  try {
    // The classes that will play at peak, and who signs in in the morning.
    const playable = plan.classes.filter((c) => c.students.length >= 15 && c.apps.length && c.teachers.length);
    const biggest = [...playable].sort((a, b) => b.students.length - a.students.length)[0];
    const playing = [biggest, ...shuffle(playable.filter((c) => c !== biggest))].slice(0, 10 * O.factor);

    if (want('pages')) await scenarioPages(plan, server);
    if (want('signin')) {
      const morning = new Map();
      for (const c of playing) for (const p of [...c.students, ...c.teachers]) morning.set(p.id, p);
      for (const p of shuffle([...plan.students, ...plan.teachers])) {
        if (morning.size >= 300 * O.factor) break;
        morning.set(p.id, p);
      }
      await scenarioSignIn(plan, server, shuffle([...morning.values()].filter((p) => !signedIn.has(p.id))).slice(0, 300 * O.factor));
    }
    if (want('join')) await scenarioJoin(plan, server);
    if (want('peak')) await scenarioPeak(plan, server, playing, { title: `Peak ×${O.factor}: ${playing.length} classes play at once` });
    // Not part of "all": the ramp runs to the limit, the soak for hours.
    if (O.scenario.split(',').includes('ramp')) await scenarioRamp(plan, server);
    if (O.scenario.split(',').includes('soak')) await scenarioSoak(plan, server);
  } finally {
    const crashed = server.child.exitCode !== null || server.child.signalCode !== null;
    check('server ran through without crashing', !crashed);
    if (!crashed) await server.stop();
    writeReport();
    log(`report: ${path.join(O.out, 'report.md')}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
