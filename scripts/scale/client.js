'use strict';
// One browser of one person, for the load test: cookie jar, CSRF token, the sign-in through the
// Microsoft stand-in of scripts/scale/server.js, the player and the SDK API of an app.
// Built on Node's own fetch; every request is timed and recorded under a label.

const crypto = require('node:crypto');

class Browser {
  /** hub: { origin, appsSuffix }; stats: a Stats; who: the person (for messages). */
  constructor(hub, stats, who = null) {
    this.hub = hub;
    this.stats = stats;
    this.who = who;
    this.jar = new Map();
    this.csrf = '';
  }

  setStats(stats) {
    this.stats = stats;
  }

  async req(label, method, url, { headers = {}, body, expect = [200], binary = false, record = true } = {}) {
    const toHub = !/^https?:/.test(url);
    const target = toHub ? this.hub.origin + url : url;
    const h = { ...headers };
    if (toHub && this.jar.size) h.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const t0 = performance.now();
    let res;
    let data;
    try {
      res = await fetch(target, { method, headers: h, body, redirect: 'manual' });
      data = binary ? Buffer.from(await res.arrayBuffer()) : await res.text();
    } catch (err) {
      if (record) this.stats.record(label, performance.now() - t0, `network: ${err.cause?.code || err.message}`);
      return { status: 0, ok: false, error: err, text: '', headers: new Headers() };
    }
    const ms = performance.now() - t0;
    if (toHub) {
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(';');
        const eq = pair.indexOf('=');
        if (/expires=Thu, 01 Jan 1970/i.test(c)) this.jar.delete(pair.slice(0, eq));
        else this.jar.set(pair.slice(0, eq), pair.slice(eq + 1));
      }
    }
    const ok = expect.includes(res.status);
    if (record) {
      const shown = String(url).replace(/[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{20,}/g, '<token>');
      this.stats.record(label, ms, ok ? null : `HTTP ${res.status} ${method} ${shown.slice(0, 120)}: ${binary ? '' : String(data).replace(/\s+/g, ' ').slice(0, 200)}`);
    }
    return { status: res.status, ok, ms, headers: res.headers, location: res.headers.get('location'), text: binary ? '' : data, buffer: binary ? data : null };
  }

  /** A Hub page; keeps the CSRF token it carries. */
  async page(label, url, expect = [200]) {
    const r = await this.req(label, 'GET', url, { expect });
    const m = /<meta name="csrf" content="([^"]*)"/.exec(r.text);
    if (m) this.csrf = m[1];
    return r;
  }

  /** A form, as the browser sends it. */
  post(label, url, fields = {}, expect = [303]) {
    return this.req(label, 'POST', url, {
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: this.hub.origin },
      body: new URLSearchParams({ _csrf: this.csrf, ...fields }).toString(),
      expect,
    });
  }

  /** JSON or raw bytes, as the Hub's own scripts send them. */
  send(label, method, url, payload, { type = 'application/json', expect = [200] } = {}) {
    return this.req(label, method, url, {
      headers: { 'content-type': type, accept: 'application/json', 'x-csrf-token': this.csrf, origin: this.hub.origin },
      body: type === 'application/json' ? JSON.stringify(payload ?? {}) : payload,
      expect,
    });
  }

  /**
   * Sign in like a browser: a Hub page gives the session, "Mit Microsoft anmelden" leads to
   * Microsoft (the stand-in), which sends the browser back with a code naming the account.
   * `entry`: the page the person opened first (e.g. a join link).
   */
  async signIn(person, { entry = '/', prefix = 'sign-in' } = {}) {
    let r = await this.page(`${prefix}: first page`, entry, [200, 302]);
    if (r.status === 302) r = await this.page(`${prefix}: landing page`, r.location);
    if (r.status !== 200) return false;
    const login = await this.req(`${prefix}: /auth/login`, 'GET', '/auth/login', { expect: [302] });
    if (!login.ok) return false;
    const state = new URL(login.location).searchParams.get('state');
    const code = Buffer.from(JSON.stringify({ oid: person.oid, name: person.name, email: person.email })).toString('base64url');
    const back = await this.req(`${prefix}: /auth/callback`, 'GET', `/auth/callback?${new URLSearchParams({ code, state })}`, { expect: [302] });
    if (!back.ok) return false;
    const landed = await this.page(`${prefix}: page after sign-in`, back.location);
    this.landedOn = back.location;
    return landed.ok;
  }
}

/** One app opened in the player: its frame, its files and its SDK API. */
class AppSession {
  constructor(browser, app, classId) {
    this.b = browser;
    this.app = app;
    this.classId = classId;
    this.origin = `http://${app.origin_key}${browser.hub.appsSuffix}`;
    this.token = null;
    this.tokenAt = 0;
  }

  async open({ files = true } = {}) {
    const b = this.b;
    const p = await b.page('play: player page', `/apps/${this.app.id}/spielen${this.classId ? `?klasse=${this.classId}` : ''}`);
    if (!p.ok) return false;
    const start = /data-start="([^"]+)"/.exec(p.text);
    if (!(await this.refreshToken(true))) return false;
    if (!files || !start) return true;
    // The frame: the Hub's start page on the app origin, its script, then the app itself.
    const s = await b.req('app: start page', 'GET', start[1].replace(/&amp;/g, '&'), { headers: { 'sec-fetch-dest': 'iframe' } });
    const next = /data-next="([^"]+)"/.exec(s.text);
    const script = /<script src="([^"]+)"/.exec(s.text);
    if (script) await b.req('app: start script', 'GET', this.origin + script[1].replace(/&amp;/g, '&'), { headers: { 'sec-fetch-dest': 'script' } });
    if (!next) return false;
    const entry = next[1].replace(/&amp;/g, '&');
    const index = await b.req('app: file', 'GET', this.origin + entry, { headers: { 'sec-fetch-dest': 'iframe' } });
    const dir = entry.slice(0, entry.lastIndexOf('/') + 1);
    // The files index.html refers to (scripts, styles), as the browser would fetch them.
    for (const m of index.text.matchAll(/(?:src|href)="([^"#?:]+\.(?:js|css))"/g)) {
      await b.req('app: file', 'GET', this.origin + dir + m[1], { headers: { 'sec-fetch-dest': m[1].endsWith('.css') ? 'style' : 'script' } });
    }
    return true;
  }

  async refreshToken(first = false) {
    const t = await this.b.send(first ? 'play: token' : 'play: token refresh', 'POST', `/apps/${this.app.id}/token`, { klasse: this.classId, version: null, first });
    if (!t.ok) return false;
    this.token = JSON.parse(t.text).token;
    this.tokenAt = Date.now();
    return true;
  }

  /** One SDK call. Returns { ok, result } - ok:false also for {ok:false} answers of the API. */
  async api(method, params = {}, label = `sdk: ${method}`) {
    if (Date.now() - this.tokenAt > 8 * 60_000) await this.refreshToken(false);
    const r = await this.b.req(label, 'POST', `${this.origin}/_hub/api`, {
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json', origin: this.origin },
      body: JSON.stringify({ method, params }),
      record: false,
    });
    let body = null;
    try {
      body = JSON.parse(r.text);
    } catch {
      // reported below
    }
    const ok = r.status === 200 && body && body.ok === true;
    this.b.stats.record(label, r.ms ?? 0, ok ? null : `${method}: HTTP ${r.status} ${r.error ? r.error.cause?.code || r.error.message : String(r.text).slice(0, 200)}`);
    return { ok, result: body && body.result, status: r.status, unknown: r.status === 0 };
  }
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

module.exports = { Browser, AppSession, sha256 };
