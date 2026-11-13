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
