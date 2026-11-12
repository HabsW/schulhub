'use strict';
// All configuration comes from environment variables (see .env.example).
// Nothing in here is ever sent to the browser.

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const MB = 1024 * 1024;
const KB = 1024;
const PLACEHOLDERS = ['00000000-0000-0000-0000-000000000000', 'paste-secret-value-here', 'change-me-to-a-long-random-string'];

const list = (v) => String(v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

function loadConfig({ env = process.env, dev = false, overrides = {} } = {}) {
  const root = path.join(__dirname, '..');
  const problems = [];
  const base = new URL(env.BASE_URL || 'http://localhost:3000');
  const local = ['localhost', '127.0.0.1'].includes(base.hostname);

  if (dev && (!local || env.NODE_ENV === 'production')) {
    throw new Error('Der Testmodus (--dev) ist nur lokal erlaubt: BASE_URL muss localhost sein und NODE_ENV darf nicht "production" sein.');
  }

  const dataDir = path.resolve(root, overrides.dataDir || env.DATA_DIR || 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  // Session/token secret. Required in real mode; generated and kept in the
  // (git-ignored) data folder in local test mode.
  let sessionSecret = env.SESSION_SECRET;
  if (!sessionSecret && dev) {
    const file = path.join(dataDir, 'dev-secret');
    if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    sessionSecret = fs.readFileSync(file, 'utf8').trim();
  }
  if (!dev && (!sessionSecret || sessionSecret.length < 32 || PLACEHOLDERS.includes(sessionSecret))) {
    problems.push('SESSION_SECRET fehlt oder ist zu kurz (mindestens 32 Zeichen).');
  }

  let microsoft = null;
  const ms = { tenantId: env.TENANT_ID, clientId: env.CLIENT_ID, clientSecret: env.CLIENT_SECRET };
  const msComplete = Object.values(ms).every((v) => v && !PLACEHOLDERS.includes(v));
  if (msComplete) microsoft = ms;
  else if (!dev) problems.push('TENANT_ID, CLIENT_ID und CLIENT_SECRET müssen gesetzt sein.');

  const studentDomains = list(env.STUDENT_EMAIL_DOMAINS);
  const staffDomains = list(env.STAFF_EMAIL_DOMAINS);
  if (!dev && studentDomains.length + staffDomains.length === 0) {
    problems.push('STUDENT_EMAIL_DOMAINS und/oder STAFF_EMAIL_DOMAINS müssen gesetzt sein.');
  }
  if (!dev && !env.APPS_DOMAIN) problems.push('APPS_DOMAIN fehlt (z. B. apps.schule.example, mit Wildcard-DNS *.apps.schule.example).');
  if (problems.length) throw new Error(`Konfiguration unvollständig (siehe .env.example):\n - ${problems.join('\n - ')}`);

  const config = {
    dev,
    root,
    dataDir,
    hubName: env.HUB_NAME || 'SchulHub',
    scheme: base.protocol.replace(':', ''),
    https: base.protocol === 'https:',
    hubHostname: base.hostname,
    // Port that appears in URLs ('' = default port) and port we listen on.
    publicPort: base.port,
    listenPort: Number(env.PORT || base.port || 3000),
    // In test mode we only listen on the loopback interface.
    listenHosts: dev ? ['127.0.0.1', '::1'] : [env.LISTEN_HOST || '0.0.0.0'],
    appsDomain: (env.APPS_DOMAIN || 'apps.localhost').toLowerCase(),
    trustProxy: env.TRUST_PROXY ? Number(env.TRUST_PROXY) || env.TRUST_PROXY : false,
    sessionSecret,
    microsoft,
    studentDomains,
    staffDomains,
    adminEmails: list(env.ADMIN_EMAILS),
    sessionMs: 8 * 60 * 60 * 1000,
    sdkTokenSeconds: 10 * 60,
    fileTokenSeconds: 12 * 60 * 60,
    auditRetentionDays: Number(env.AUDIT_RETENTION_DAYS || 365),
    extraExtensions: list(env.EXTRA_FILE_EXTENSIONS),
    limits: {
      maxFileBytes: 25 * MB, // one file
      maxVersionBytes: 100 * MB, // one version, unpacked
      maxZipBytes: 100 * MB, // the uploaded archive itself
      maxFiles: 2000, // files per version
      maxVersionsPerApp: 20,
      maxAppsPerUser: 30,
      maxUserBytes: 500 * MB, // all versions of all apps of one user
      saveValueBytes: 256 * KB, // one saved value
      saveTotalBytes: 2 * MB, // all saves of one user in one app
      saveKeys: 200,
      sharedTotalBytes: 2 * MB, // shared data per app / per class
      resultBytes: 32 * KB,
      resultsPerUser: 500, // per app; oldest are dropped
      boardsPerApp: 20,
      commentsPerApp: 500,
      classesPerTeacher: 60,
    },
    // [max events, per milliseconds]
    rate: {
      login: [20, 10 * 60_000], // per IP
      joinFail: [8, 10 * 60_000], // wrong join codes per user
      joinFailIp: [300, 10 * 60_000], // ... and per IP (high: a whole school shares one address)
      write: [240, 60_000], // state-changing Hub requests per user
      uploadFiles: [6000, 60 * 60_000], // per user
      uploadVersions: [30, 60 * 60_000], // per user
      sdk: [600, 60_000], // SDK calls per user and app
      appFiles: [3000, 60_000], // static app files per IP
    },
  };
  Object.assign(config.limits, overrides.limits);
  Object.assign(config.rate, overrides.rate);
  for (const k of ['listenPort', 'sdkTokenSeconds', 'sessionMs', 'adminEmails', 'studentDomains', 'staffDomains']) {
    if (overrides[k] !== undefined) config[k] = overrides[k];
  }

  const port = () => (config.publicPort ? `:${config.publicPort}` : '');
  Object.defineProperties(config, {
    hubHost: { get: () => `${config.hubHostname}${port()}` },
    hubOrigin: { get: () => `${config.scheme}://${config.hubHost}` },
    appsHostSuffix: { get: () => `.${config.appsDomain}${port()}` },
    // CSP source that matches every app origin.
    appsOriginPattern: { get: () => `${config.scheme}://*.${config.appsDomain}${port()}` },
  });
  config.appOrigin = (originKey) => `${config.scheme}://${originKey}${config.appsHostSuffix}`;
  return config;
}

module.exports = { loadConfig, MB, KB };
