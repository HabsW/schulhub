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

// A plain host name: labels of letters, digits and hyphens - no scheme, port, path or wildcard.
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * Real mode: the addresses must keep uploaded apps away from the Hub's cookies.
 * Cookies belong to a whole registrable domain. If the Hub and the apps share one
 * (hub.schule.de + <key>.apps.schule.de), any app can set cookies that the Hub and
 * every other app receive - forty 4 KB cookies lock a browser out of everything for
 * months (HTTP 431), and planted cookies reach the Hub. So the Hub's host and
 * APPS_DOMAIN must not share a parent domain of two or more labels, unless the
 * operator names that suffix in APPS_PUBLIC_SUFFIX as a public suffix (like co.uk,
 * which browsers already treat as a boundary). And without HTTPS there is no
 * __Host- session cookie, so plain http is for localhost only.
 */
function addressProblems(base, env) {
  const out = [];
  if (base.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(base.hostname)) {
    out.push(`BASE_URL muss mit https:// beginnen (jetzt: ${base.origin}). Ohne HTTPS ist die Anmeldung nicht geschützt; nur localhost und 127.0.0.1 dürfen http:// nutzen.`);
  }
  const appsDomain = String(env.APPS_DOMAIN || '').trim().toLowerCase();
  if (!appsDomain) return out; // reported as missing
  if (!HOSTNAME.test(appsDomain)) {
    out.push(`APPS_DOMAIN muss ein reiner Domainname sein – ohne https://, ohne * und ohne Port, z. B. meine-schule-apps.de (jetzt: „${String(env.APPS_DOMAIN).slice(0, 80)}“).`);
    return out;
  }
  const hubHost = base.hostname.replace(/\.$/, '');
  const hub = hubHost.split('.').reverse();
  const apps = appsDomain.split('.').reverse();
  const common = [];
  while (common.length < Math.min(hub.length, apps.length) && hub[common.length] === apps[common.length]) common.push(hub[common.length]);
  const shared = common.reverse().join('.');
  const allowed = String(env.APPS_PUBLIC_SUFFIX || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (common.length >= 2 && allowed !== shared) {
    const suggestion = [`${common[0]}-apps`, ...common.slice(1)].join('.');
    out.push(
      `Hub (${hubHost}) und Apps (${appsDomain}) liegen unter derselben Domain „${shared}“. Dann kann jede App Cookies setzen, ` +
        'die der Hub und alle anderen Apps bekommen – und Browser damit monatelang aussperren. ' +
        `Nimm für die Apps eine eigene Domain, z. B. APPS_DOMAIN=${suggestion} (Wildcard-DNS und Wildcard-Zertifikat für *.${suggestion}). ` +
        `Nur wenn „${shared}“ eine öffentliche Endung wie co.uk ist, unter der viele fremde Domains liegen: APPS_PUBLIC_SUFFIX=${shared} setzen.`
    );
  }
  return out;
}

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
  if (!dev && !env.APPS_DOMAIN) problems.push('APPS_DOMAIN fehlt (eine eigene Domain für die Apps, z. B. meine-schule-apps.de mit Wildcard-DNS *.meine-schule-apps.de).');
  // The range the admin can choose in the Hub (src/settings.js). The daily maintenance (and the one at every
  // start) deletes older audit entries: "0" - often meant as "keep forever" - would delete all of them.
  const auditRetentionDays = env.AUDIT_RETENTION_DAYS === undefined || String(env.AUDIT_RETENTION_DAYS).trim() === '' ? 365 : Number(env.AUDIT_RETENTION_DAYS);
  if (!Number.isInteger(auditRetentionDays) || auditRetentionDays < 30 || auditRetentionDays > 3650) {
    problems.push(`AUDIT_RETENTION_DAYS muss eine ganze Zahl von 30 bis 3650 sein (Tage, wie lange das Protokoll bleibt; jetzt: „${String(env.AUDIT_RETENTION_DAYS).slice(0, 40)}“).`);
  }
  if (!dev) problems.push(...addressProblems(base, env));
  if (problems.length) throw new Error(`Konfiguration unvollständig oder unsicher (siehe .env.example):\n - ${problems.join('\n - ')}`);

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
    auditRetentionDays,
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
      resultsPerUser: 500, // per person, app and class (or without a class); the oldest are dropped
      boardsPerApp: 20, // leaderboards one person posts on in one app
      commentsPerApp: 500,
      classesPerTeacher: 60,
      fileBytes: 1 * MB, // hub.files: one file
      filesPerApp: 50, // hub.files: files per person per app
      fileTotalBytes: 10 * MB, // hub.files: all files of one person in one app
      fileAccountBytes: 50 * MB, // hub.files: all files of one person in all apps
      achievementsPerApp: 50,
      noticesPerUser: 200, // older in-Hub messages are dropped
      feedbackChars: 2000,
      parallelUploads: 4, // upload bodies (folder, editor, ZIP, hub.files) one person sends at the same time; the Hub's uploader sends 3
      parallelApiCalls: 32, // SDK data API requests one person has open at the same time (each body at most ~260 KB)
      parallelExports: 1, // "Meine Daten" downloads one person runs at the same time
      uploadMemoryBytes: 256 * MB, // big file bodies held in memory at the same time, by everybody together (one person: a quarter)
      minUploadRate: 16 * KB, // bytes per second a big file body must average after 20 s, or its place is freed
    },
    // [max events, per milliseconds]
    rate: {
      // Sign-in (see routes/home.js): nothing here can lock out a school that shares one address.
      loginSession: [20, 10 * 60_000], // starting a Microsoft sign-in, per browser session
      loginAnon: [300, 10 * 60_000], // starts from a browser without a session, per address; over it: sent to the start page, never refused
      loginFailAudit: [300, 10 * 60_000], // failed sign-ins written to the audit log, per address; never blocks a sign-in
      joinFail: [8, 10 * 60_000], // wrong join codes per person (never per address: see routes/classes.js)
      write: [240, 60_000], // state-changing Hub requests per user
      uploadFiles: [6000, 60 * 60_000], // per user
      uploadVersions: [30, 60 * 60_000], // per user
      sdk: [600, 60_000], // SDK calls per user and app
      sdkFiles: [120, 60_000], // hub.files uploads per user and app
      appFiles: [3000, 60_000], // static app files per person (from the file token)
      appFilesBad: [600, 60_000], // requests with an invalid file token, per address (never blocks valid ones)
      publish: [60, 60 * 60_000], // publishing versions, per person
      submit: [30, 60 * 60_000], // submissions to classes per person
      draftWrites: [600, 60_000], // editor saves per user
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
