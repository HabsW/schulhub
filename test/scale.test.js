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
            out.push({ name: e.fileName, data: Buffer.concat(chunks) });
            zip.readEntry();
          });
        }));
        zip.on('end', () => resolve(out));
        zip.readEntry();
      });
    });
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

test('Uploads: was alle zusammen gerade im Speicher halten, ist begrenzt – ein ZIP (auf die Platte) zählt nicht', async () => {
  const h = await startHub({ limits: { uploadMemoryBytes: 1024 * 1024 } });
  try {
    const http = require('node:http');
    const people = [h.addUser('Anna Bau', 'teacher'), h.addUser('Ben Bau', 'teacher')];
    const [A, B] = await Promise.all(people.map((u) => h.browser().login(u)));
    const appA = await h.makeApp(A, 'App A');
    const appB = await h.makeApp(B, 'App B');
    const vA = (await A.send('POST', `/apps/${appA.id}/versionen`)).json();
    const vB = (await B.send('POST', `/apps/${appB.id}/versionen`)).json();
    // Anna's 700 KB body is on its way (held open) …
    const csrf = /<meta name="csrf" content="([^"]*)"/.exec((await A.page('/apps')).text)[1];
    const held = http.request({
      host: '127.0.0.1', port: h.config.publicPort, method: 'PUT', path: `/apps/${appA.id}/versionen/${vA.id}/datei?pfad=gross.bin`,
      headers: { host: h.config.hubHost, cookie: [...A.jar].map(([k, v]) => `${k}=${v}`).join('; '), 'content-type': 'application/octet-stream', 'content-length': 700 * 1024, 'x-csrf-token': csrf },
    });
    held.on('error', () => {});
    held.write(Buffer.alloc(10));
    await new Promise((r) => setTimeout(r, 100));
    // … so Ben's 700 KB do not fit into the 1 MB the whole Hub may hold: 429, unread.
    const refused = await B.send('PUT', `/apps/${appB.id}/versionen/${vB.id}/datei?pfad=gross.bin`, Buffer.alloc(700 * 1024), 'application/octet-stream');
    assert.equal(refused.status, 429);
    // A small file still fits, and a ZIP is not held in memory at all.
    assert.equal((await B.send('PUT', `/apps/${appB.id}/versionen/${vB.id}/datei?pfad=index.html`, Buffer.from('<h1>b</h1>'), 'application/octet-stream')).status, 200);
    const zip = require('./helpers').makeZip([{ name: 'index.html', data: '<h1>z</h1>' }, { name: 'gross.bin', data: Buffer.alloc(700 * 1024) }]);
    assert.equal((await B.send('POST', `/apps/${appB.id}/versionen/zip`, zip, 'application/zip')).status, 200);
    held.destroy();
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
