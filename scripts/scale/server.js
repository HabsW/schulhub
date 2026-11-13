'use strict';
// The real Hub in REAL mode (not --dev) for load and crash tests, on this computer only.
//
//   node scripts/scale/server.js --data <dir> --port <n> [--profile-sql]
//
// Differences from `npm start`, and nothing else:
//  - Microsoft is not asked. A stand-in answers MSAL's two calls: the sign-in address carries the
//    state as usual, and the "code" the load client sends back to /auth/callback names the account
//    (oid, name, e-mail) - like a real ID token would, after a short simulated network delay.
//    Everything the Hub does with a sign-in (account update, new session, audit entry, limits) runs
//    unchanged. Refuses to start unless the Hub is on localhost and listens on loopback only.
//  - A probe reports event-loop delay, event-loop utilisation, memory and garbage collection to the
//    parent process (IPC), and with --profile-sql the time spent in every SQL statement.
// Never load this file in a real installation: anybody could sign in as anybody.

const path = require('node:path');
const Module = require('node:module');
const { monitorEventLoopDelay, performance, PerformanceObserver } = require('node:perf_hooks');

const arg = (name, def = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const dataDir = path.resolve(arg('data', ''));
const port = Number(arg('port', '3700'));
if (!arg('data')) throw new Error('--data <dir> fehlt');

const TENANT = '11111111-2222-3333-4444-555555555555';
const env = {
  BASE_URL: `http://localhost:${port}`,
  DATA_DIR: dataDir,
  SESSION_SECRET: 'scale-test-secret-0123456789abcdef0123456789abcdef',
  TENANT_ID: TENANT,
  CLIENT_ID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  CLIENT_SECRET: 'scale-test-client-secret',
  STUDENT_EMAIL_DOMAINS: 'schueler.example',
  STAFF_EMAIL_DOMAINS: 'schule.example',
  ADMIN_EMAILS: 'admin@schule.example',
  APPS_DOMAIN: 'apps.localhost',
  LISTEN_HOST: '127.0.0.1',
};
if (process.env.NODE_ENV === 'production') throw new Error('Nicht im Produktivbetrieb.');

// ---------- the stand-in for Microsoft (MSAL) ----------
const delayMs = Number(arg('idp-delay', '150')); // what the token exchange with Microsoft costs in time (not CPU)
class StandInClient {
  async getAuthCodeUrl({ state, redirectUri }) {
    return `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize?${new URLSearchParams({ state, redirect_uri: redirectUri })}`;
  }
  async acquireTokenByCode({ code }) {
    await new Promise((r) => setTimeout(r, delayMs * (0.5 + Math.random())));
    let who;
    try {
      who = JSON.parse(Buffer.from(String(code), 'base64url').toString('utf8'));
    } catch {
      throw Object.assign(new Error('invalid_grant'), { errorCode: 'invalid_grant' });
    }
    return { idTokenClaims: { tid: TENANT, oid: who.oid, name: who.name, email: who.email } };
  }
}
const realLoad = Module._load;
Module._load = function load(request, ...rest) {
  const m = realLoad.call(this, request, ...rest);
  return request === '@azure/msal-node' ? { ...m, ConfidentialClientApplication: StandInClient } : m;
};

const { loadConfig } = require('../../src/config');
const { createHub } = require('../../src/app');

const config = loadConfig({ env, dev: false });
config.listenHosts = ['127.0.0.1', '::1']; // *.apps.localhost resolves to ::1 here, localhost to both
if (config.hubHostname !== 'localhost') throw new Error('nur auf localhost');

const hub = createHub(config);

// ---------- SQL profile ----------
const sqlStats = new Map();
if (process.argv.includes('--profile-sql')) {
  const db = hub.ctx.db;
  for (const kind of ['get', 'all', 'run']) {
    const orig = db[kind];
    db[kind] = (sql, ...params) => {
      const t = process.hrtime.bigint();
      try {
        return orig(sql, ...params);
      } finally {
        const ms = Number(process.hrtime.bigint() - t) / 1e6;
        let s = sqlStats.get(sql);
        if (!s) sqlStats.set(sql, (s = { n: 0, ms: 0, max: 0 }));
        s.n++;
        s.ms += ms;
        if (ms > s.max) s.max = ms;
      }
    };
  }
  const tx = db.tx;
  db.tx = (fn) => {
    const t = process.hrtime.bigint();
    try {
      return tx(fn);
    } finally {
      const ms = Number(process.hrtime.bigint() - t) / 1e6;
      let s = sqlStats.get('(transaction incl. commit)');
      if (!s) sqlStats.set('(transaction incl. commit)', (s = { n: 0, ms: 0, max: 0 }));
      s.n++;
      s.ms += ms;
      if (ms > s.max) s.max = ms;
    }
  };
}

// ---------- probe ----------
// A "window" is one measured phase of a scenario: the parent opens and closes it.
const window = { lag: null, elu: null, start: 0, rssMax: 0, heapMax: 0, gcMs: 0, gcCount: 0, gcMaxMs: 0 };
const perSecond = monitorEventLoopDelay({ resolution: 5 });
perSecond.enable();
let lastElu = performance.eventLoopUtilization();
new PerformanceObserver((list) => {
  for (const e of list.getEntries()) {
    window.gcMs += e.duration;
    window.gcCount++;
    if (e.duration > window.gcMaxMs) window.gcMaxMs = e.duration;
  }
}).observe({ entryTypes: ['gc'] });

const ms = (ns) => Math.round((ns / 1e6) * 100) / 100;
function memory() {
  const m = process.memoryUsage();
  return { rss: m.rss, heapUsed: m.heapUsed, external: m.external, arrayBuffers: m.arrayBuffers };
}
const tick = setInterval(() => {
  const m = memory();
  if (m.rss > window.rssMax) window.rssMax = m.rss;
  if (m.heapUsed > window.heapMax) window.heapMax = m.heapUsed;
  const elu = performance.eventLoopUtilization(lastElu);
  lastElu = performance.eventLoopUtilization();
  const sessions = hub.ctx.db.get('SELECT COUNT(*) AS n FROM sessions').n;
  process.send?.({
    type: 'sample', at: Date.now(), elu: elu.utilization, lagP50: ms(perSecond.percentile(50)), lagP99: ms(perSecond.percentile(99)), lagMax: ms(perSecond.max),
    ...m, sessions, previews: hub.ctx.previewStores ? hub.ctx.previewStores.size() : null,
  });
  perSecond.reset();
}, 1000);
tick.unref();

process.on('message', (msg) => {
  if (msg.type === 'window-start') {
    window.lag = monitorEventLoopDelay({ resolution: 5 });
    window.lag.enable();
    window.elu = performance.eventLoopUtilization();
    window.start = Date.now();
    window.rssMax = 0;
    window.heapMax = 0;
    window.gcMs = 0;
    window.gcCount = 0;
    window.gcMaxMs = 0;
    sqlStats.clear();
    process.send({ type: 'window-started', id: msg.id });
  } else if (msg.type === 'window-end') {
    const h = window.lag;
    h.disable();
    const elu = performance.eventLoopUtilization(window.elu);
    const top = [...sqlStats.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 15)
      .map(([sql, s]) => ({ sql: sql.replace(/\s+/g, ' ').slice(0, 220), n: s.n, totalMs: Math.round(s.ms), avgMs: Math.round((s.ms / s.n) * 1000) / 1000, maxMs: Math.round(s.max * 100) / 100 }));
    process.send({
      type: 'window', id: msg.id, seconds: (Date.now() - window.start) / 1000,
      lag: { p50: ms(h.percentile(50)), p95: ms(h.percentile(95)), p99: ms(h.percentile(99)), max: ms(h.max), mean: ms(h.mean) },
      elu: Math.round(elu.utilization * 1000) / 1000,
      rssMaxMB: Math.round(window.rssMax / 1048576), heapMaxMB: Math.round(window.heapMax / 1048576), memoryNow: memory(),
      gc: { count: window.gcCount, totalMs: Math.round(window.gcMs), maxMs: Math.round(window.gcMaxMs * 10) / 10 },
      sql: top,
    });
  } else if (msg.type === 'gc' && global.gc) {
    global.gc();
    process.send({ type: 'gc-done', id: msg.id, memory: memory() });
  } else if (msg.type === 'stop') {
    hub.stop().then(() => process.exit(0));
  }
});

hub.start().then(
  () => process.send?.({ type: 'ready', origin: config.hubOrigin, appsSuffix: config.appsHostSuffix, pid: process.pid }),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
