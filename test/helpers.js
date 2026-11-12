'use strict';
// Test helpers: a real Hub on a random port with a temporary data folder,
// a tiny HTTP client with a cookie jar, and a zip builder that can produce
// hostile archives.

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { loadConfig } = require('../src/config');
const { createHub } = require('../src/app');
const { newId } = require('../src/util');

async function startHub(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schulhub-test-'));
  const config = loadConfig({ env: { BASE_URL: 'http://localhost:3000' }, dev: true, overrides: { dataDir, listenPort: 0, ...overrides } });
  const hub = createHub(config);
  await hub.start();
  const { db } = hub.ctx;

  /** Create an account directly in the database (the test login only accepts dev- accounts). */
  function addUser(name, role) {
    const id = newId();
    db.run('INSERT INTO users (id, oid, name, email, role, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, `dev-${id}`, name, `${id}@schule.example`, role, Date.now());
    return db.get('SELECT * FROM users WHERE id = ?', id);
  }

  /** One browser: keeps cookies, knows its CSRF token. */
  function browser() {
    const jar = new Map();
    let csrf = '';

    function request(method, url, { host = config.hubHost, headers = {}, body = null } = {}) {
      return new Promise((resolve, reject) => {
        const h = { host, ...headers };
        if (host === config.hubHost && jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
        if (body !== null) h['content-length'] = Buffer.byteLength(body);
        const req = http.request({ host: '127.0.0.1', port: config.publicPort, method, path: url, headers: h }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            if (host === config.hubHost) {
              for (const line of res.headers['set-cookie'] || []) {
                const [pair] = line.split(';');
                const eq = pair.indexOf('=');
                if (/expires=Thu, 01 Jan 1970/i.test(line)) jar.delete(pair.slice(0, eq));
                else jar.set(pair.slice(0, eq), pair.slice(eq + 1));
              }
            }
            const buffer = Buffer.concat(chunks);
            const text = buffer.toString('utf8');
            resolve({ status: res.statusCode, headers: res.headers, text, buffer, json: () => JSON.parse(text) });
          });
        });
        req.on('error', reject);
        req.end(body);
      });
    }

    const b = {
      jar,
      get: (url, opts) => request('GET', url, opts),
      /** Load a page and remember the CSRF token from it. */
      async page(url) {
        const res = await request('GET', url);
        const m = /<meta name="csrf" content="([^"]*)"/.exec(res.text);
        if (m) csrf = m[1];
        return res;
      },
      /** Form POST with the CSRF token (like a real form). */
      post: (url, fields = {}, { withCsrf = true, headers = {} } = {}) =>
        request('POST', url, {
          headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
          body: new URLSearchParams({ ...(withCsrf ? { _csrf: csrf } : {}), ...fields }).toString(),
        }),
      /** JSON / binary request as the Hub's own scripts send them. */
      send: (method, url, body, type = 'application/json') =>
        request(method, url, { headers: { 'content-type': type, accept: 'application/json', 'x-csrf-token': csrf }, body: type === 'application/json' ? JSON.stringify(body ?? {}) : body }),
      async login(user) {
        await b.page('/');
        const res = await b.post('/dev/login', { user: user.id });
        if (res.status !== 303) throw new Error(`login failed: ${res.status}`);
        await b.page('/start');
        return b;
      },
      /** Call the SDK data API of an app (on the app's own host) with a bearer token. */
      api: (app, token, method, params = {}) =>
        request('POST', '/_hub/api', {
          host: `${app.origin_key}${config.appsHostSuffix}`,
          headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ method, params }),
        }),
      raw: request,
    };
    return b;
  }

  /** Create an app with one uploaded + published version, through the real routes. */
  async function makeApp(b, name, files = { 'index.html': '<h1>hi</h1>' }) {
    const created = await b.post('/apps', { name, emoji: '🎮', color: '0' });
    const id = created.headers.location.split('/').pop();
    const version = await uploadFolder(b, id, files);
    await b.post(`/apps/${id}/veroeffentlichen`, { version });
    return db.get('SELECT * FROM apps WHERE id = ?', id);
  }
  async function uploadFolder(b, appId, files) {
    const v = (await b.send('POST', `/apps/${appId}/versionen`)).json();
    for (const [p, content] of Object.entries(files)) {
      const res = await b.send('PUT', `/apps/${appId}/versionen/${v.id}/datei?pfad=${encodeURIComponent(p)}`, Buffer.from(content), 'application/octet-stream');
      if (res.status !== 200) throw new Error(`upload of ${p} failed: ${res.status} ${res.text}`);
    }
    const done = await b.send('POST', `/apps/${appId}/versionen/${v.id}/fertig`);
    if (done.status !== 200) throw new Error(`finish failed: ${done.text}`);
    return v.id;
  }
  /** Ask for an SDK token like the player page does. */
  async function token(b, app, klasse = null, version = null) {
    const res = await b.send('POST', `/apps/${app.id}/token`, { klasse, version, first: true });
    return res.status === 200 ? res.json() : null;
  }

  return {
    hub, config, db, addUser, browser, makeApp, uploadFolder, token,
    appHost: (app) => `${app.origin_key}${config.appsHostSuffix}`,
    async stop() {
      await hub.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/**
 * Build a zip by hand so tests can include things normal tools refuse to
 * create: "../" names, symlinks, or sizes that lie.
 * entries: [{ name, data, mode?, method? }]
 */
function makeZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.from(e.data || '');
    const stored = e.store ? data : zlib.deflateRawSync(data, { level: 9 });
    const name = Buffer.from(e.name, 'utf8');
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6);
    head.writeUInt16LE(e.store ? 0 : 8, 8);
    head.writeUInt32LE(0x00210000, 10);
    head.writeUInt32LE(zlib.crc32(data), 14);
    head.writeUInt32LE(stored.length, 18);
    head.writeUInt32LE(e.fakeSize ?? data.length, 22);
    head.writeUInt16LE(name.length, 26);
    parts.push(head, name, stored);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(0x0314, 4); // made by: unix
    c.writeUInt16LE(20, 6);
    head.copy(c, 8, 6, 30);
    c.writeUInt32LE(((e.mode ?? 0o100644) << 16) >>> 0, 38);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + stored.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

module.exports = { startHub, makeZip };
