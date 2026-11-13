'use strict';
// Long database jobs run in a worker thread with a connection of their own: the consistent copy of a
// backup (VACUUM INTO) and the integrity check (PRAGMA quick_check). node:sqlite is synchronous - on
// the Hub's own thread either job would stop every request of the whole school for as long as it
// takes, seconds on a big database. In WAL mode the worker only reads, and a reader never blocks
// the Hub's writes.

const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

if (!isMainThread && workerData && workerData.schulhubDbJob) {
  const { DatabaseSync } = require('node:sqlite');
  const { file, job, target } = workerData;
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout = 10000;');
    if (job === 'snapshot') {
      db.prepare('VACUUM INTO ?').run(target);
      // The content files the copy refers to (read here, not on the Hub's thread): only these belong into
      // the backup - a file whose rows were deleted before the copy (an account, app data) is not part of it.
      const copy = new DatabaseSync(target, { readOnly: true });
      try {
        const shas = (sql) => copy.prepare(sql).all().map((r) => r.sha256);
        parentPort.postMessage({
          ok: true,
          blobs: shas('SELECT sha256 FROM app_files UNION SELECT sha256 FROM draft_files'),
          userfiles: shas('SELECT DISTINCT sha256 FROM user_files'),
        });
      } finally {
        copy.close();
      }
    } else if (job === 'check') {
      parentPort.postMessage({ ok: true, rows: db.prepare('PRAGMA quick_check').all().map((r) => String(Object.values(r)[0])) });
    }
  } finally {
    db.close();
  }
}

/** A job that has not finished after this long is stopped: a hung worker must not hold back deletions for good. */
const JOB_TIMEOUT_MS = 30 * 60_000;

function run(file, job, target = null) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { schulhubDbJob: true, file, job, target } });
    let answer = null;
    const timer = setTimeout(() => worker.terminate(), JOB_TIMEOUT_MS);
    timer.unref();
    worker.once('message', (m) => {
      answer = m;
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      clearTimeout(timer);
      if (answer && code === 0) resolve(answer);
      else reject(new Error(`database job "${job}" ended without a result (exit ${code})`));
    });
  });
}

module.exports = {
  /** A consistent copy of the database file in `target` (for backups); resolves to the content hashes it refers to. */
  snapshot: (file, target) => run(file, 'snapshot', target).then((a) => ({ blobs: new Set(a.blobs), userfiles: new Set(a.userfiles) })),
  /** PRAGMA quick_check of the database file: ['ok'] or the problems found. */
  quickCheck: (file) => run(file, 'check').then((a) => a.rows),
};
