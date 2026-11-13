'use strict';
// Reliability at the size of a real school: the database settings, an index for every foreign key,
// and no statement on a hot path or in a deletion that reads a whole table. These are the regression
// guards for scripts/scale (seed, load, crash) - see CAPACITY.md.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { startHub } = require('./helpers');

/** The steps of SQLite's plan for a statement ("SCAN results", "SEARCH saves USING INDEX …"). */
const planOf = (db, sql, ...params) => db.all(`EXPLAIN QUERY PLAN ${sql}`, ...params).map((r) => r.detail);
// Tables that grow with the school (people × apps × time). Reading one of them whole is never cheap.
const BIG = ['results', 'saves', 'scores', 'plays', 'progress', 'achievements', 'audit_log', 'notices', 'app_files', 'user_files', 'comments', 'feedback', 'assignment_done', 'app_usage', 'announcement_dismissed', 'sessions'];
const fullScans = (plan) => plan.filter((d) => BIG.some((t) => new RegExp(`^SCAN ${t}\\b`).test(d)));

test('Datenbank: WAL, synchronous=NORMAL, Fremdschlüssel an – Löschungen werden sofort auf die Platte geschrieben', async () => {
  const h = await startHub();
  try {
    assert.equal(h.db.get('PRAGMA journal_mode').journal_mode, 'wal');
    assert.equal(h.db.get('PRAGMA synchronous').synchronous, 1, 'NORMAL: a commit does not wait for the disk');
    assert.equal(h.db.get('PRAGMA foreign_keys').foreign_keys, 1);
    // A durable transaction flushes its commit (FULL) and switches back afterwards.
    let inside = null;
    h.db.tx(() => {
      inside = h.db.get('PRAGMA synchronous').synchronous;
    }, { durable: true });
    assert.equal(inside, 2, 'FULL inside a durable transaction');
    assert.equal(h.db.get('PRAGMA synchronous').synchronous, 1, 'back to NORMAL afterwards');
    assert.throws(() => h.db.tx(() => {
      throw new Error('boom');
    }, { durable: true }), /boom/);
    assert.equal(h.db.get('PRAGMA synchronous').synchronous, 1, 'back to NORMAL after a rollback, too');
  } finally {
    await h.stop();
  }
});

test('Datenbank: jeder Fremdschlüssel hat einen Index, mit dem er beginnt (sonst liest jedes Löschen ganze Tabellen)', async () => {
  const h = await startHub();
  try {
    const missing = [];
    for (const { name } of h.db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")) {
      const leading = new Set(h.db.all(`PRAGMA index_list(${name})`).map((i) => h.db.all(`PRAGMA index_info(${i.name})`).find((c) => c.seqno === 0)?.name));
      const pk = h.db.all(`PRAGMA table_info(${name})`).find((c) => c.pk === 1);
      if (pk) leading.add(pk.name);
      for (const fk of h.db.all(`PRAGMA foreign_key_list(${name})`)) if (!leading.has(fk.from)) missing.push(`${name}.${fk.from}`);
    }
    assert.deepEqual(missing, [], 'foreign key columns without an index that starts with them');
  } finally {
    await h.stop();
  }
});

test('Datenbank: Konto, App und Klasse löschen liest keine ganze Tabelle – auch nicht über ON DELETE', async () => {
  const h = await startHub();
  try {
    for (const [sql, what] of [
      ['DELETE FROM users WHERE id = ?', 'account'],
      ['DELETE FROM apps WHERE id = ?', 'app'],
      ['DELETE FROM classes WHERE id = ?', 'class'],
      ['DELETE FROM app_versions WHERE id = ?', 'version'],
      ['DELETE FROM assignments WHERE id = ?', 'assignment'],
      ['DELETE FROM notices WHERE href >= ? AND href < ?', 'notices of an app'],
      ["DELETE FROM notices WHERE href >= '/pruefen/' AND href < '/pruefen0' AND instr(href, ?) > 0", 'review notices of an app'],
      ['DELETE FROM notices WHERE href = ?', 'notices of an assignment'],
    ]) {
      const params = (sql.match(/\?/g) || []).map(() => 'x');
      assert.deepEqual(fullScans(planOf(h.db, sql, ...params)), [], `deleting an ${what} reads whole tables`);
    }
  } finally {
    await h.stop();
  }
});

test('Datenbank: Startseiten, Kontingente und Meine Daten fragen nur die eigenen Zeilen ab', async () => {
  const h = await startHub();
  try {
    const hot = [
      // student start page: achievements of one person, newest first
      'SELECT ach.achievement, ach.unlocked_at, a.id AS app_id, a.name AS app_name FROM achievements ach JOIN apps a ON a.id = ach.app_id WHERE ach.user_id = ? ORDER BY ach.unlocked_at DESC LIMIT 8',
      'SELECT COUNT(*) AS n FROM achievements WHERE user_id = ?',
      // teachers' start page: results of a class in the last 14 days
      'SELECT created_at FROM results WHERE class_id = ? AND created_at > ?',
      // hub.files quota of one person
      'SELECT COALESCE(SUM(size), 0) AS bytes FROM user_files WHERE user_id = ? AND NOT (app_id = ? AND name = ?)',
      // admin: data of one account
      'SELECT (SELECT COALESCE(SUM(size), 0) FROM saves WHERE user_id = ?1) + (SELECT COALESCE(SUM(size), 0) FROM user_files WHERE user_id = ?1) AS data',
      // Meine Daten: what a person has, per table
      'SELECT COUNT(*) AS n FROM comments WHERE author_id = ?',
      'SELECT COUNT(*) AS n FROM results WHERE user_id = ?',
      'SELECT COUNT(*) AS n FROM scores WHERE user_id = ?',
      'SELECT COUNT(*) AS n FROM progress WHERE user_id = ?',
      'SELECT COUNT(*) AS n FROM assignment_done WHERE user_id = ?',
      'SELECT COUNT(*) AS n FROM announcement_dismissed WHERE user_id = ?',
      // the backup page: the last backups
      "SELECT at, actor_label, detail FROM audit_log WHERE action = 'sicherung_heruntergeladen' ORDER BY id DESC LIMIT 5",
    ];
    for (const sql of hot) {
      const params = (sql.match(/\?\d?/g) || []).filter((v, i, a) => !/\d/.test(v) || a.indexOf(v) === i).map(() => 'x');
      assert.deepEqual(fullScans(planOf(h.db, sql, ...params)), [], sql);
    }
  } finally {
    await h.stop();
  }
});

test('Sicherung und „Datenbank prüfen“ laufen in einem eigenen Thread – der Hub antwortet währenddessen weiter', async () => {
  const h = await startHub();
  try {
    const admin = h.addUser('Ada Admin', 'admin');
    const A = await h.browser().login(admin);
    // The Hub's own connection must not copy or check the database: that would stop every request.
    h.db.snapshot = () => {
      throw new Error('VACUUM INTO on the Hub thread');
    };
    const quick = h.db.all;
    h.db.all = (sql, ...p) => {
      if (/quick_check|integrity_check/i.test(sql)) throw new Error('quick_check on the Hub thread');
      return quick(sql, ...p);
    };
    const backup = await A.post('/admin/sicherung');
    assert.equal(backup.status, 200);
    assert.equal(backup.headers['content-type'], 'application/zip');
    const check = await A.post('/admin/datenbank-pruefen');
    assert.equal(check.status, 303);
    const after = await A.page('/admin');
    assert.match(after.text, /Die Datenbank ist in Ordnung/);
  } finally {
    await h.stop();
  }
});

test('Sicherung: solange die Datenbank kopiert wird, löscht der Hub keine Inhaltsdateien – danach schon', async () => {
  const h = await startHub();
  try {
    const teacher = h.addUser('Tilda Lehrerin', 'teacher');
    const T = await h.browser().login(teacher);
    const app = await h.makeApp(T, 'Kurzlebig', { 'index.html': '<h1>eins</h1>', 'nur-hier.js': 'console.log("nur in dieser Version")' });
    const version = h.db.get('SELECT * FROM app_versions WHERE app_id = ?', app.id);
    const sha = h.db.get("SELECT sha256 FROM app_files WHERE version_id = ? AND path = 'nur-hier.js'", version.id).sha256;
    const blob = h.hub.ctx.uploads.blobPath(sha);
    const { holdGarbage, releaseGarbage } = require('../src/backup');
    holdGarbage(h.hub.ctx);
    h.hub.ctx.services.deleteApp(teacher, h.db.get('SELECT * FROM apps WHERE id = ?', app.id));
    assert.ok(fs.existsSync(blob), 'a running backup may still refer to the file');
    releaseGarbage(h.hub.ctx);
    assert.ok(!fs.existsSync(blob), 'after the backup the file is collected');
  } finally {
    await h.stop();
  }
});

/** An app as popular apps get after a few months: 30,000 results and saves of 300 students. */
function popularApp(h, appId) {
  const students = Array.from({ length: 300 }, (_, i) => h.addUser(`Schüler ${i}`, 'student'));
  h.db.tx(() => {
    for (let i = 0; i < 30000; i++) {
      h.db.run('INSERT INTO results (app_id, user_id, title, score, max_score, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', appId, students[i % 300].id, 'Runde', i % 10, 10, '{"a":1}', Date.now() - i);
    }
    for (const s of students) h.db.run("INSERT INTO saves (app_id, user_id, key, value, size, updated_at) VALUES (?, ?, 'stand', '{}', 2, ?)", appId, s.id, Date.now());
  });
}

/**
 * How many rows of the app were still there when the app row (or its owner's account) was deleted:
 * whatever is left then goes in that ONE statement (ON DELETE CASCADE), with the Hub standing still.
 */
function leftForTheLastStep(h, appId) {
  const seen = { results: null, saves: null };
  const run = h.db.run;
  h.db.run = (sql, ...params) => {
    if (/^DELETE FROM (apps|users) WHERE id = \?/.test(sql) && seen.results === null) {
      seen.results = h.db.get('SELECT COUNT(*) AS n FROM results WHERE app_id = ?', appId).n;
      seen.saves = h.db.get('SELECT COUNT(*) AS n FROM saves WHERE app_id = ?', appId).n;
    }
    return run(sql, ...params);
  };
  return { seen, restore: () => (h.db.run = run) };
}

/** How long the Hub's thread stood still at most while fn ran (ms). */
async function longestStall(fn) {
  const { monitorEventLoopDelay } = require('node:perf_hooks');
  const d = monitorEventLoopDelay({ resolution: 5 });
  d.enable();
  try {
    await fn();
  } finally {
    d.disable();
  }
  return d.max / 1e6;
}

test('Eine viel genutzte App löschen hält den Hub nicht an: ihre vielen Daten gehen in kleinen Schritten', async () => {
  const h = await startHub();
  try {
    const teacher = h.addUser('Tilda Lehrerin', 'teacher');
    const T = await h.browser().login(teacher);
    const app = await h.makeApp(T, 'Beliebt');
    popularApp(h, app.id);
    await T.page(`/apps/${app.id}`);
    let res;
    const watch = leftForTheLastStep(h, app.id);
    const stall = await longestStall(async () => {
      res = await T.post(`/apps/${app.id}/loeschen`);
    });
    watch.restore();
    assert.equal(res.status, 303);
    assert.ok(watch.seen.results !== null, 'the app row was deleted');
    assert.ok(watch.seen.results <= 1000 && watch.seen.saves <= 1000, `left for the one last statement: ${watch.seen.results} results, ${watch.seen.saves} saves`);
    assert.equal(h.db.get('SELECT 1 AS x FROM apps WHERE id = ?', app.id), undefined);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM results WHERE app_id = ?', app.id).n, 0);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM saves WHERE app_id = ?', app.id).n, 0);
    assert.ok(stall < 150, `the Hub stood still for ${Math.round(stall)} ms while the app was deleted`);
  } finally {
    await h.stop();
  }
});

test('Ein Konto mit einer viel genutzten App löschen (selbst oder durch die Verwaltung) hält den Hub nicht an', async () => {
  const h = await startHub();
  try {
    const admin = h.addUser('Ada Admin', 'admin');
    const A = await h.browser().login(admin);
    for (const how of ['selbst', 'verwaltung']) {
      const teacher = h.addUser(`Tilda ${how}`, 'teacher');
      const T = await h.browser().login(teacher);
      const app = await h.makeApp(T, `Beliebt ${how}`);
      popularApp(h, app.id);
      let res;
      const watch = leftForTheLastStep(h, app.id);
      const stall = await longestStall(async () => {
        if (how === 'selbst') {
          await T.page('/meine-daten');
          res = await T.post('/meine-daten/konto-loeschen', { bestaetigung: 'LÖSCHEN' });
        } else {
          await A.page(`/admin/konten/${teacher.id}`);
          res = await A.post(`/admin/nutzer/${teacher.id}/loeschen`);
        }
      });
      watch.restore();
      assert.equal(res.status, 303, how);
      assert.ok(watch.seen.results !== null && watch.seen.results <= 1000, `${how}: left for the one last statement: ${watch.seen.results} results`);
      assert.equal(h.db.get('SELECT 1 AS x FROM users WHERE id = ?', teacher.id), undefined, how);
      assert.equal(h.db.get('SELECT COUNT(*) AS n FROM results WHERE app_id = ?', app.id).n, 0, how);
      assert.ok(stall < 150, `${how}: the Hub stood still for ${Math.round(stall)} ms while the account was deleted`);
    }
  } finally {
    await h.stop();
  }
});

test('Eine App löschen, zu der viele Rückmeldungen geschrieben wurden: ihre Mitteilungen gehen über den Index – keine Suche durch alle Mitteilungen aller Schüler/innen', async () => {
  const h = await startHub();
  try {
    const teacher = h.addUser('Tilda Lehrerin', 'teacher');
    const T = await h.browser().login(teacher);
    await T.post('/klassen', { name: '9a' });
    const cls = h.db.get("SELECT class_id AS id FROM class_members WHERE user_id = ? AND role = 'teacher'", teacher.id).id;
    const app = await h.makeApp(T, 'Vokabeln');
    await T.post(`/klassen/${cls}/apps`, { app: app.id });
    const students = Array.from({ length: 40 }, (_, i) => h.addUser(`Kind ${i}`, 'student'));
    h.db.tx(() => {
      for (const s of students) h.db.run("INSERT INTO class_members (class_id, user_id, role, joined_at) VALUES (?, ?, 'student', ?)", cls, s.id, Date.now());
    });
    // Feedback about the app to every student, as the teacher writes it (with its notice) …
    await T.page(`/klassen/${cls}`);
    for (const s of students) assert.equal((await T.post(`/klassen/${cls}/rueckmeldungen`, { schueler: s.id, app: app.id, text: 'Gut gemacht!' })).status, 303);
    // … and many other notices per student (a school year of assignments and feedback).
    h.db.tx(() => {
      for (const s of students) for (let i = 0; i < 60; i++) h.db.run("INSERT INTO notices (user_id, kind, text, href, created_at) VALUES (?, 'aufgabe', ?, '/start', ?)", s.id, `Neue Aufgabe ${i}`, Date.now());
    });
    const told = h.db.get("SELECT COUNT(*) AS n FROM notices WHERE kind = 'rueckmeldung'").n;
    assert.equal(told, 40);
    const scans = [];
    const run = h.db.run;
    h.db.run = (sql, ...p) => {
      if (/instr\((notices\.)?text/.test(sql)) scans.push(sql); // a search through the text of notices
      return run(sql, ...p);
    };
    try {
      await T.page(`/apps/${app.id}`);
      assert.equal((await T.post(`/apps/${app.id}/loeschen`)).status, 303);
    } finally {
      h.db.run = run;
    }
    assert.equal(h.db.get("SELECT COUNT(*) AS n FROM notices WHERE kind = 'rueckmeldung'").n, 0, 'the feedback notices quoting the app are gone');
    assert.equal(h.db.get("SELECT COUNT(*) AS n FROM notices WHERE kind = 'aufgabe'").n, 40 * 60, 'other notices stay');
    assert.ok(scans.length <= 1, `${scans.length} text searches through notices (one per student and name before)`);
  } finally {
    await h.stop();
  }
});

test('Sicherung: Datenbank und Dateien werden gestreamt – nie als Ganzes in den Speicher gelesen – und das Archiv ist gültig', async () => {
  const h = await startHub();
  const realReadFile = fs.promises.readFile;
  try {
    const admin = h.addUser('Ada Admin', 'admin');
    const teacher = h.addUser('Tilda Lehrerin', 'teacher');
    const A = await h.browser().login(admin);
    const T = await h.browser().login(teacher);
    await h.makeApp(T, 'Gesichert', { 'index.html': '<h1>gesichert</h1>', 'daten.bin': require('node:crypto').randomBytes(300_000) });
    const read = [];
    fs.promises.readFile = (file, ...rest) => {
      read.push(String(file));
      return realReadFile(file, ...rest);
    };
    await A.page('/admin/sicherung');
    const res = await A.post('/admin/sicherung');
    fs.promises.readFile = realReadFile;
    assert.equal(res.status, 200);
    assert.deepEqual(read.filter((f) => f.includes('sicherung-')), [], 'files of the backup are streamed, not read whole');
    // The archive is valid: every entry inflates to its declared size and checksum (yauzl checks both).
    const yauzl = require('yauzl');
    const zipFile = require('node:path').join(h.config.dataDir, 'test-backup.zip');
    fs.writeFileSync(zipFile, res.buffer);
    const entries = await new Promise((resolve, reject) => {
      yauzl.open(zipFile, { lazyEntries: true, validateEntrySizes: true }, (err, zip) => {
        if (err) return reject(err);
        const out = [];
        zip.on('entry', (e) => zip.openReadStream(e, (e2, stream) => {
          if (e2) return reject(e2);
          const chunks = [];
          stream.on('data', (c) => chunks.push(c));
          stream.on('error', reject);
          stream.on('end', () => {
            out.push({ name: e.fileName, data: Buffer.concat(chunks), crc: e.crc32 });
            zip.readEntry();
          });
        }));
        zip.on('end', () => resolve(out));
        zip.readEntry();
      });
    });
    // yauzl checks sizes, not checksums: every entry's CRC-32 (written after its streamed data) must fit its content.
    for (const e of entries) assert.equal(e.crc, require('node:zlib').crc32(e.data) >>> 0, `checksum of ${e.name}`);
    const dbEntry = entries.find((e) => e.name === 'hub.sqlite');
    assert.ok(dbEntry && dbEntry.data.subarray(0, 16).toString('latin1') === 'SQLite format 3\u0000', 'the database copy is in the archive');
    for (const e of entries.filter((x) => x.name.startsWith('blobs/'))) {
      assert.equal(require('node:crypto').createHash('sha256').update(e.data).digest('hex'), e.name.split('/').pop(), `${e.name} is intact`);
    }
  } finally {
    fs.promises.readFile = realReadFile;
    await h.stop();
  }
});

test('Aufbewahrung: viele alte Protokolleinträge gehen in Schritten – der Hub antwortet dazwischen', async () => {
  const h = await startHub();
  try {
    const old = Date.now() - 400 * 86_400_000;
    h.db.tx(() => {
      for (let i = 0; i < 12000; i++) h.db.run("INSERT INTO audit_log (at, actor_label, action, target) VALUES (?, 'System', 'anmeldung', '')", old - i);
    });
    const statements = [];
    const run = h.db.run;
    h.db.run = (sql, ...p) => {
      if (/DELETE FROM audit_log/.test(sql)) statements.push(sql);
      return run(sql, ...p);
    };
    let other = 0;
    const ticker = setInterval(() => other++, 0);
    try {
      await h.hub.ctx.services.maintenanceInSteps();
    } finally {
      clearInterval(ticker);
      h.db.run = run;
    }
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM audit_log WHERE at < ?', Date.now() - 365 * 86_400_000).n, 0, 'all of them are gone');
    assert.ok(statements.filter((s) => /LIMIT/.test(s)).length >= 6, `in batches (${statements.length} statements)`);
    assert.ok(other >= 3, 'other work ran between the batches');
  } finally {
    await h.stop();
  }
});

test('Uploads: große Dateien im Speicher sind für alle zusammen begrenzt, eine Person bekommt höchstens ein Viertel – Speichern aus Apps wird dadurch nie abgewiesen', async () => {
  const h = await startHub({ limits: { uploadMemoryBytes: 2 * 1024 * 1024 } });
  const http = require('node:http');
  const held = [];
  try {
    const names = ['Anna', 'Ben', 'Carl', 'Dora', 'Eve'];
    const people = names.map((n) => h.addUser(`${n} Bau`, 'teacher'));
    const B = await Promise.all(people.map((u) => h.browser().login(u)));
    const apps = [];
    for (let i = 0; i < names.length; i++) apps.push(await h.makeApp(B[i], `App ${names[i]}`));
    const versions = [];
    for (let i = 0; i < names.length; i++) versions.push((await B[i].send('POST', `/apps/${apps[i].id}/versionen`)).json());
    /** A 500 KB file body that is sent slowly: the request is admitted, its body stays on its way. */
    async function hold(i, file) {
      const csrf = /<meta name="csrf" content="([^"]*)"/.exec((await B[i].page('/apps')).text)[1];
      const req = http.request({
        host: '127.0.0.1', port: h.config.publicPort, method: 'PUT', path: `/apps/${apps[i].id}/versionen/${versions[i].id}/datei?pfad=${file}`,
        headers: { host: h.config.hubHost, cookie: [...B[i].jar].map(([k, v]) => `${k}=${v}`).join('; '), 'content-type': 'application/octet-stream', 'content-length': 500 * 1024, 'x-csrf-token': csrf },
      });
      let status = null;
      req.on('response', (res) => { status = res.statusCode; res.resume(); });
      req.on('error', () => {});
      req.write(Buffer.alloc(10));
      held.push(req);
      await new Promise((r) => setTimeout(r, 80));
      return { req, status: () => status };
    }
    const put = (i, file, bytes) => B[i].send('PUT', `/apps/${apps[i].id}/versionen/${versions[i].id}/datei?pfad=${file}`, Buffer.alloc(bytes), 'application/octet-stream');
    // One person: at most a quarter of the 2 MB (512 KB) - Anna's second big file waits.
    const first = await hold(0, 'a1.bin');
    assert.equal((await put(0, 'a2.bin', 500 * 1024)).status, 429, 'one person gets at most a quarter');
    assert.equal(first.status(), null, 'her first file is still on its way');
    // Everybody together: Ben, Carl and Dora fill the 2 MB with Anna; Eve's big file has to wait.
    for (const i of [1, 2, 3]) await hold(i, 'gross.bin');
    assert.equal((await put(4, 'gross.bin', 500 * 1024)).status, 429, 'the pool is full');
    // A save, a file of an app and a small upload still go through: they are never part of the pool.
    const t = await h.token(B[4], apps[4]);
    assert.equal((await B[4].api(apps[4], t.token, 'save.set', { key: 'stand', value: { x: 1 } })).json().ok, true);
    // Once the bodies are done (here: cut off), the places are free again.
    for (const r of held.splice(0)) r.destroy();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await put(4, 'gross.bin', 500 * 1024)).status, 200, 'the pool is free again');
    assert.equal((await put(0, 'a2.bin', 500 * 1024)).status, 200, 'and so is Anna\'s quarter');
    // A ZIP is written to a temp file and never counts.
    const zip = require('./helpers').makeZip([{ name: 'index.html', data: '<h1>z</h1>' }, { name: 'gross.bin', data: Buffer.alloc(900 * 1024) }]);
    assert.equal((await B[4].send('POST', `/apps/${apps[4].id}/versionen/zip`, zip, 'application/zip')).status, 200);
  } finally {
    for (const r of held) r.destroy();
    await h.stop();
  }
});

test('Uploads: ein Dateiinhalt, der nur kriecht, verliert nach 20 Sekunden seinen Platz', async () => {
  const h = await startHub({ limits: { minUploadRate: 16 * 1024 } });
  const http = require('node:http');
  try {
    const t = h.addUser('Tim Langsam', 'teacher');
    const T = await h.browser().login(t);
    const app = await h.makeApp(T, 'Langsam');
    const v = (await T.send('POST', `/apps/${app.id}/versionen`)).json();
    const csrf = /<meta name="csrf" content="([^"]*)"/.exec((await T.page('/apps')).text)[1];
    const realNow = Date.now;
    let shift = 0;
    Date.now = () => realNow() + shift;
    try {
      const closed = new Promise((resolve) => {
        const req = http.request({
          host: '127.0.0.1', port: h.config.publicPort, method: 'PUT', path: `/apps/${app.id}/versionen/${v.id}/datei?pfad=kriecht.bin`,
          headers: { host: h.config.hubHost, cookie: [...T.jar].map(([k, val]) => `${k}=${val}`).join('; '), 'content-type': 'application/octet-stream', 'content-length': 2 * 1024 * 1024, 'x-csrf-token': csrf },
        });
        req.on('error', () => resolve('cut'));
        req.on('close', () => resolve('cut'));
        req.write(Buffer.alloc(100));
      });
      // 25 seconds later (the clock is moved on), only 100 bytes have arrived: the watcher cuts the connection.
      await new Promise((r) => setTimeout(r, 100));
      shift = 25_000;
      const outcome = await Promise.race([closed, new Promise((r) => setTimeout(() => r('still open'), 7000))]);
      assert.equal(outcome, 'cut');
    } finally {
      Date.now = realNow;
    }
  } finally {
    await h.stop();
  }
});

test('Verwaltung: die Speicher-Rangliste wird nicht bei jedem Aufruf neu summiert – und nennt nie ein gelöschtes Konto', async () => {
  const h = await startHub();
  try {
    const admin = h.addUser('Ada Admin', 'admin');
    const big = h.addUser('Gustav Großspeicher', 'teacher');
    const A = await h.browser().login(admin);
    const G = await h.browser().login(big);
    await h.makeApp(G, 'Riesenapp', { 'index.html': '<h1>x</h1>', 'daten.bin': Buffer.alloc(200_000, 7) });
    let sums = 0;
    const all = h.db.all;
    h.db.all = (sql, ...p) => {
      if (/GROUP BY uid/.test(sql)) sums++;
      return all(sql, ...p);
    };
    try {
      assert.match((await A.get('/admin')).text, /Gustav Großspeicher/);
      await A.get('/admin');
      await A.get('/admin');
      assert.equal(sums, 1, 'summed once for three views');
      h.hub.ctx.services.deleteUser(admin, h.db.get('SELECT * FROM users WHERE id = ?', big.id));
      assert.doesNotMatch((await A.get('/admin')).text, /Gustav Großspeicher/, 'a deleted account is never named');
    } finally {
      h.db.all = all;
    }
  } finally {
    await h.stop();
  }
});

test('Datenbank: die WAL-Datei schrumpft nach großen Löschungen wieder (journal_size_limit 64 MB)', async () => {
  const h = await startHub();
  try {
    assert.equal(h.db.get('PRAGMA journal_size_limit').journal_size_limit, 64 * 1024 * 1024);
  } finally {
    await h.stop();
  }
});

/** An app of `owner` with some results, so that deleting it pauses between batches (as a real one does). */
function appWithData(h, owner, name) {
  const id = require('../src/util').newId();
  h.db.run("INSERT INTO apps (id, owner_id, name, emoji, origin_key, created_at, updated_at) VALUES (?, ?, ?, '🎮', ?, ?, ?)", id, owner.id, name, `a${require('node:crypto').randomBytes(10).toString('hex')}`, Date.now(), Date.now());
  h.db.tx(() => {
    for (let i = 0; i < 2500; i++) h.db.run("INSERT INTO results (app_id, user_id, title, created_at) VALUES (?, ?, 'R', ?)", id, owner.id, Date.now());
  });
  return id;
}

test('Zwei Admins löschen sich gleichzeitig gegenseitig: genau eine Löschung geschieht, ein Admin bleibt', async () => {
  const h = await startHub();
  try {
    const a = h.addUser('Ada Admin', 'admin');
    const b = h.addUser('Bob Admin', 'admin');
    appWithData(h, a, 'Adas App');
    appWithData(h, b, 'Bobs App');
    const [A, B] = await Promise.all([a, b].map((u) => h.browser().login(u)));
    await A.page(`/admin/konten/${b.id}`);
    await B.page(`/admin/konten/${a.id}`);
    await Promise.all([A.post(`/admin/nutzer/${b.id}/loeschen`), B.post(`/admin/nutzer/${a.id}/loeschen`)]);
    const left = h.db.all("SELECT name, disabled FROM users WHERE role = 'admin'");
    assert.equal(left.length, 1, `admins left: ${JSON.stringify(left)}`);
    assert.equal(left[0].disabled, 0, 'and that admin can still sign in');
    const gone = left[0].name === 'Ada Admin' ? 'Bob Admin' : 'Ada Admin';
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM audit_log WHERE actor_label LIKE ?', `${gone}%`).n, 0, 'no audit entry names the deleted admin');
  } finally {
    await h.stop();
  }
});

test('Ein Admin löscht sein Konto, während der andere Admin zurücktritt: nie ohne Admin, nie Daten weg und Konto noch da', async () => {
  const h = await startHub();
  try {
    const a = h.addUser('Ada Admin', 'admin');
    const b = h.addUser('Bob Admin', 'admin');
    const app = appWithData(h, a, 'Adas App');
    const [A, B] = await Promise.all([a, b].map((u) => h.browser().login(u)));
    await A.page('/meine-daten');
    await B.page(`/admin/konten/${b.id}`);
    await Promise.all([A.post('/meine-daten/konto-loeschen', { bestaetigung: 'LÖSCHEN' }), B.post(`/admin/nutzer/${b.id}/rolle`, { rolle: 'teacher' })]);
    assert.ok(h.db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").n >= 1, 'an active admin remains');
    const adaStays = Boolean(h.db.get('SELECT 1 AS ok FROM users WHERE id = ?', a.id));
    if (adaStays) assert.equal(h.db.get('SELECT COUNT(*) AS n FROM results WHERE app_id = ?', app).n, 2500, 'refused - and her app data is untouched');
    else assert.equal(h.db.get('SELECT role FROM users WHERE id = ?', b.id).role, 'admin', 'deleted - and Bob stayed admin');
  } finally {
    await h.stop();
  }
});

test('Sicherung: wer gesperrt wird, während die Kopie entsteht, bekommt sie nicht', async () => {
  const h = await startHub();
  const dbJobs = require('../src/dbJobs');
  const snapshot = dbJobs.snapshot;
  try {
    const a = h.addUser('Ada Admin', 'admin');
    const b = h.addUser('Bob Admin', 'admin');
    const A = await h.browser().login(a);
    await A.page('/admin/sicherung');
    // While the database is copied, the other admin blocks Ada (which signs her out everywhere).
    dbJobs.snapshot = async (...args) => {
      const made = await snapshot(...args);
      h.db.run('UPDATE users SET disabled = 1 WHERE id = ?', a.id);
      h.db.run('DELETE FROM sessions WHERE user_id = ?', a.id);
      return made;
    };
    const res = await A.post('/admin/sicherung');
    assert.equal(res.status, 404, 'no archive with everybody\'s data');
    assert.notEqual(res.headers['content-type'], 'application/zip');
    assert.ok(b);
  } finally {
    dbJobs.snapshot = snapshot;
    await h.stop();
  }
});

test('Sicherung: bricht das Schreiben mittendrin ab, sieht der Download nicht vollständig aus und zählt nicht als letzte Sicherung', async () => {
  const h = await startHub();
  try {
    const a = h.addUser('Ada Admin', 'admin');
    const A = await h.browser().login(a);
    await A.page('/admin/sicherung');
    const writeZip = h.hub.ctx.uploads.writeZip;
    h.hub.ctx.uploads.writeZip = async (res) => {
      res.write(Buffer.from('PK\u0003\u0004 halb'));
      throw Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' });
    };
    const http = require('node:http');
    const csrf = /<meta name="csrf" content="([^"]*)"/.exec((await A.page('/admin/sicherung')).text)[1];
    const outcome = await new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1', port: h.config.publicPort, method: 'POST', path: '/admin/sicherung',
        headers: { host: h.config.hubHost, cookie: [...A.jar].map(([k, v]) => `${k}=${v}`).join('; '), 'content-type': 'application/x-www-form-urlencoded', 'x-csrf-token': csrf },
      }, (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve('ended normally'));
        res.on('aborted', () => resolve('broken'));
        res.on('error', () => resolve('broken'));
      });
      req.on('error', () => resolve('broken'));
      req.end(`_csrf=${encodeURIComponent(csrf)}`);
    });
    h.hub.ctx.uploads.writeZip = writeZip;
    assert.equal(outcome, 'broken', 'the browser must see a failed download');
    assert.equal(require('../src/backup').lastBackupAt(h.db), null, 'and it is not "the last backup"');
  } finally {
    await h.stop();
  }
});

test('Dateien kommen ganz auf die Platte – auch wenn ein einzelner Schreibaufruf weniger schreibt', async () => {
  const h = await startHub();
  const fsReal = require('node:fs');
  const writeSync = fsReal.writeSync;
  try {
    const t = h.addUser('Tim Teil', 'teacher');
    const T = await h.browser().login(t);
    fsReal.writeSync = (fd, buf, off, len, ...rest) => (typeof off === 'number' && typeof len === 'number'
      ? writeSync(fd, buf, off, Math.min(len, 1000), ...rest)
      : writeSync(fd, Buffer.isBuffer(buf) ? buf.subarray(0, 1000) : buf));
    const content = require('node:crypto').randomBytes(50_000);
    const app = await h.makeApp(T, 'Ganz', { 'index.html': '<h1>x</h1>', 'gross.bin': content });
    fsReal.writeSync = writeSync;
    const row = h.db.get("SELECT f.sha256, f.size FROM app_files f JOIN app_versions v ON v.id = f.version_id WHERE v.app_id = ? AND f.path = 'gross.bin'", app.id);
    const onDisk = fsReal.readFileSync(h.hub.ctx.uploads.blobPath(row.sha256));
    assert.equal(onDisk.length, content.length, 'the whole file is on the disk');
    assert.equal(require('node:crypto').createHash('sha256').update(onDisk).digest('hex'), row.sha256);
  } finally {
    fsReal.writeSync = writeSync;
    await h.stop();
  }
});

test('Eine Klasse löschen nimmt auch die Mitteilungen ihrer Rückmeldungen mit; eine gelöschte Rückmeldung ihre eigene', async () => {
  const h = await startHub();
  try {
    const teacher = h.addUser('Tina Lehrerin', 'teacher');
    const kid = h.addUser('Kim Kind', 'student');
    const [T, K] = await Promise.all([teacher, kid].map((u) => h.browser().login(u)));
    await T.post('/klassen', { name: '6c' });
    const cls = h.db.get("SELECT class_id AS id FROM class_members WHERE user_id = ? AND role = 'teacher'", teacher.id).id;
    await K.post(`/beitreten/${h.db.get("SELECT code FROM join_codes WHERE class_id = ? AND role = 'student'", cls).code}`);
    await T.page(`/klassen/${cls}`);
    await T.post(`/klassen/${cls}/rueckmeldungen`, { schueler: kid.id, text: 'Erste' });
    await T.post(`/klassen/${cls}/rueckmeldungen`, { schueler: kid.id, text: 'Zweite' });
    const [first, second] = h.db.all('SELECT id FROM feedback WHERE student_id = ? ORDER BY created_at, rowid', kid.id);
    assert.equal(h.db.get("SELECT COUNT(*) AS n FROM notices WHERE user_id = ? AND kind = 'rueckmeldung'", kid.id).n, 2);
    // Deleting one feedback takes its notice along.
    await K.page('/rueckmeldungen');
    assert.equal((await K.post(`/rueckmeldungen/${first.id}/loeschen`, { zurueck: '/rueckmeldungen' })).status, 303);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM notices WHERE href = ?', `/rueckmeldungen#rueckmeldung-${first.id}`).n, 0);
    // Deleting the class takes the rest along.
    h.hub.ctx.services.deleteClass(teacher, h.db.get('SELECT * FROM classes WHERE id = ?', cls));
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM notices WHERE href = ?', `/rueckmeldungen#rueckmeldung-${second.id}`).n, 0);
  } finally {
    await h.stop();
  }
});

test('Aus der Klasse genommen: die Beitrittsseite bietet den alten Code nicht mehr an – „Meine Daten“ zeigt es und der Export enthält es', async () => {
  const h = await startHub();
  try {
    const teacher = h.addUser('Tina Lehrerin', 'teacher');
    const kid = h.addUser('Kai Kind', 'student');
    const [T, K] = await Promise.all([teacher, kid].map((u) => h.browser().login(u)));
    await T.post('/klassen', { name: '7d' });
    const cls = h.db.get("SELECT class_id AS id FROM class_members WHERE user_id = ? AND role = 'teacher'", teacher.id).id;
    const code = h.db.get("SELECT code FROM join_codes WHERE class_id = ? AND role = 'student'", cls).code;
    await K.post(`/beitreten/${code}`);
    await T.page(`/klassen/${cls}/mitglieder`);
    assert.equal((await T.post(`/klassen/${cls}/mitglieder/${kid.id}/entfernen`)).status, 303);
    const page = await K.page(`/beitreten/${code}`);
    assert.equal(page.status, 200);
    assert.doesNotMatch(page.text, /Ja, beitreten/, 'the old code is not offered');
    const mine = await K.page('/meine-daten');
    assert.match(mine.text, /„7d“ \(.*\) hat dich eine Lehrkraft genommen/);
    const exported = (await K.get('/meine-daten/export')).json();
    assert.deepEqual(exported.ausKlassenGenommen.map((r) => r.klasse), ['7d']);
  } finally {
    await h.stop();
  }
});

test('Beim Start werden Dateien entfernt, auf die nichts mehr verweist (z. B. Löschungen, die auf eine Sicherung warteten, als der Hub stoppte)', async () => {
  const h = await startHub();
  try {
    const { uploads, userFiles } = h.hub.ctx;
    const orphan = require('node:crypto').createHash('sha256').update('niemand').digest('hex');
    const blob = uploads.blobPath(orphan);
    fs.mkdirSync(require('node:path').dirname(blob), { recursive: true });
    fs.writeFileSync(blob, 'niemand');
    const userBlob = userFiles.blobPath(orphan);
    fs.mkdirSync(require('node:path').dirname(userBlob), { recursive: true });
    fs.writeFileSync(userBlob, 'niemand');
    const teacher = h.addUser('Tim Bleibt', 'teacher');
    const T = await h.browser().login(teacher);
    const app = await h.makeApp(T, 'Bleibt');
    const kept = h.db.get("SELECT f.sha256 FROM app_files f JOIN app_versions v ON v.id = f.version_id WHERE v.app_id = ? AND f.path = 'index.html'", app.id).sha256;
    assert.equal(uploads.sweep(), 1);
    assert.equal(userFiles.sweep(), 1);
    assert.ok(!fs.existsSync(blob) && !fs.existsSync(userBlob), 'the files nobody refers to are gone');
    assert.ok(fs.existsSync(uploads.blobPath(kept)), 'files in use stay');
  } finally {
    await h.stop();
  }
});

test('Löschungen gehen sofort auf die Platte: Konto, App, Klasse und App-Daten laufen in einer Transaktion mit synchronous=FULL', async () => {
  const h = await startHub();
  try {
    const seen = [];
    const tx = h.db.tx;
    h.db.tx = (fn, options) => tx(() => {
      seen.push(h.db.get('PRAGMA synchronous').synchronous);
      return fn();
    }, options);
    const admin = h.addUser('Ada Admin', 'admin');
    const t = h.addUser('Tom Weg', 'teacher');
    const T = await h.browser().login(t);
    const app = await h.makeApp(T, 'Weg');
    const { services } = h.hub.ctx;
    seen.length = 0;
    services.deleteAppData(app.id, t.id);
    services.deleteApp(t, h.db.get('SELECT * FROM apps WHERE id = ?', app.id));
    services.deleteClass(t, { id: services.createClass(t, 'Weg-Klasse'), name: 'Weg-Klasse' });
    services.deleteUser(admin, h.db.get('SELECT * FROM users WHERE id = ?', t.id));
    h.db.tx = tx;
    const deleting = seen.filter((v, i) => i !== 2); // the class was created in between (not a deletion)
    assert.deepEqual(deleting, deleting.map(() => 2), `synchronous inside the deletions: ${seen}`);
  } finally {
    await h.stop();
  }
});

test('Sicherung: was gelöscht wird, während die Datenbank kopiert wird, bleibt bis danach auf der Platte – dann geht es', async () => {
  const h = await startHub();
  const dbJobs = require('../src/dbJobs');
  const snapshot = dbJobs.snapshot;
  try {
    const admin = h.addUser('Ada Admin', 'admin');
    const t = h.addUser('Tilda Lehrerin', 'teacher');
    const [A, T] = await Promise.all([admin, t].map((u) => h.browser().login(u)));
    const app = await h.makeApp(T, 'Kurz', { 'index.html': '<h1>x</h1>', 'nur.js': 'let nur = 1;' });
    const sha = h.db.get("SELECT f.sha256 FROM app_files f JOIN app_versions v ON v.id = f.version_id WHERE v.app_id = ? AND f.path = 'nur.js'", app.id).sha256;
    const blob = h.hub.ctx.uploads.blobPath(sha);
    let duringCopy = null;
    dbJobs.snapshot = async (...args) => {
      const made = await snapshot(...args);
      // While the copy is made, the app (and its only file) is deleted.
      h.hub.ctx.services.deleteApp(t, h.db.get('SELECT * FROM apps WHERE id = ?', app.id));
      duringCopy = fs.existsSync(blob);
      return made;
    };
    await A.page('/admin/sicherung');
    assert.equal((await A.post('/admin/sicherung')).status, 200);
    assert.equal(duringCopy, true, 'the deletion waited for the backup');
    assert.equal(fs.existsSync(blob), false, 'and happened afterwards');
  } finally {
    dbJobs.snapshot = snapshot;
    await h.stop();
  }
});

test('App löschen: nach der Pause zählt die App, wie sie jetzt ist – ein neuer Name verschwindet mit ihr', async () => {
  const h = await startHub();
  const { services } = h.hub.ctx;
  const trim = services.trimAppData;
  try {
    const t = h.addUser('Tilda Lehrerin', 'teacher');
    const T = await h.browser().login(t);
    const app = await h.makeApp(T, 'Alter Name');
    // While the batched deletion pauses, the app is renamed (another tab).
    services.trimAppData = async (ids) => {
      await trim(ids);
      h.db.run("UPDATE apps SET name = 'Neuer Name' WHERE id = ?", app.id);
    };
    await T.page(`/apps/${app.id}`);
    assert.equal((await T.post(`/apps/${app.id}/loeschen`)).status, 303);
    assert.equal(h.db.get("SELECT target FROM audit_log WHERE action = 'app_geloescht' ORDER BY id DESC LIMIT 1").target, 'Neuer Name');
  } finally {
    services.trimAppData = trim;
    await h.stop();
  }
});
