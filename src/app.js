'use strict';
// Builds the whole Hub: one HTTP server that answers for two kinds of hosts.
//   - the Hub host            -> the Express app below (pages, sessions, permissions)
//   - <key>.<apps domain>     -> appsHost.js (static app files + SDK data API)
// Any other Host header is refused.

const path = require('node:path');
const http = require('node:http');
const express = require('express');
const session = require('express-session');

const { openDb } = require('./db');
const { createTokens, createLimiter, csrfProtect, hubHeaders } = require('./security');
const { createSessionStore } = require('./sessions');
const { createAccess } = require('./access');
const { createUploads } = require('./uploads');
const { createServices } = require('./services');
const { createUserFiles } = require('./userFiles');
const { createClassApps } = require('./classApps');
const { createSettings } = require('./settings');
const { createAssignments } = require('./assignments');
const { createAuth } = require('./auth');
const { createAppsHost } = require('./appsHost');
const { HttpError, isLocalPath } = require('./util');
const { html, page, flash, empty, linkButton } = require('./html');

// Pages that work without being signed in. Everything else is denied by default.
const PUBLIC = new Set(['/', '/auth/login', '/auth/callback', '/auth/logout', '/dev/login', '/datenschutz']);

function createHubApp(ctx) {
  const { config, db } = ctx;
  const app = express();
  app.locals.ctx = ctx;
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);

  app.use(hubHeaders(config));
  app.use('/static', express.static(path.join(config.root, 'public'), { index: false, redirect: false, maxAge: config.dev ? 0 : '1h' }));
  app.get('/sdk/hub-sdk.js', (req, res) => {
    res.setHeader('Content-Disposition', 'attachment; filename="hub-sdk.js"');
    res.sendFile(path.join(config.root, 'sdk', 'hub-sdk.js'));
  });

  app.use(
    session({
      // "__Host-" cookies cannot be set or overwritten by any other (sub)domain.
      name: config.https ? '__Host-hub_sid' : 'hub_sid',
      secret: config.sessionSecret,
      store: createSessionStore(db, config.sessionMs),
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: 'lax', secure: config.https, path: '/', maxAge: config.sessionMs },
    })
  );

  // Who is asking? Loaded fresh from the database on EVERY request, so role
  // changes, blocks and deletions take effect immediately.
  app.use((req, res, next) => {
    const s = req.session;
    if (!s.userId) return next();
    const user = db.get('SELECT * FROM users WHERE id = ?', s.userId);
    const expired = !s.createdAt || Date.now() - s.createdAt > config.sessionMs;
    if (user && !user.disabled && !expired) {
      req.user = user;
      // Pages of signed-in people are personal: never kept by the browser (shared school PCs, back button after logout).
      res.setHeader('Cache-Control', 'no-store');
      return next();
    }
    s.regenerate(next);
  });

  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.use(express.json({ limit: '64kb' }));
  app.use(csrfProtect(config));

  // Default deny + a general limit on state-changing requests.
  app.use((req, res, next) => {
    if (!req.user && !PUBLIC.has(req.path)) {
      if (req.method === 'GET' && !wantsJson(req)) {
        req.session.returnTo = req.originalUrl;
        return res.redirect('/');
      }
      return next(new HttpError(401, 'Bitte melde dich an.'));
    }
    // PUT is only used for file uploads, which have their own (larger) limit.
    if (req.user && !['GET', 'HEAD', 'PUT'].includes(req.method)) ctx.limiter.guard('write', req.user.id);
    next();
  });

  require('./routes/home')(app, ctx);
  require('./routes/classes')(app, ctx);
  require('./routes/apps')(app, ctx);
  require('./routes/player')(app, ctx);
  require('./routes/results')(app, ctx);
  require('./routes/privacy')(app, ctx);
  require('./routes/admin')(app, ctx);
  require('./routes/docs')(app, ctx);
  require('./routes/teaching')(app, ctx);
  require('./routes/review')(app, ctx);
  require('./routes/studio')(app, ctx);
  require('./routes/school')(app, ctx);

  app.use((req, res, next) => next(new HttpError(404, 'Diese Seite gibt es nicht – oder du hast keinen Zugriff darauf.')));

  // Errors: users see a friendly German sentence, never stack traces or internals.
  app.use((err, req, res, _next) => {
    let status = 500;
    let message = 'Da ist etwas schiefgegangen. Bitte versuche es noch einmal.';
    if (err instanceof HttpError) {
      status = err.status;
      message = err.message;
    } else if (err && err.type === 'entity.too.large') {
      status = 413;
      message = 'Das war zu groß.';
    } else if (err && err.status >= 400 && err.status < 500) {
      status = 400;
      message = 'Die Anfrage war ungültig.';
    } else {
      console.error(err);
    }
    if (res.headersSent) return res.end();
    // A form that failed validation goes back to the page it came from, with
    // the message and what the person typed - instead of a dead-end error page.
    // Only for plain validation problems; never for 401/403/404/429 or JSON.
    if (req.method === 'POST' && !wantsJson(req) && [400, 409, 413].includes(status) && req.session) {
      const back = sameOriginPath(req, config);
      if (back) {
        flash(req, message, 'error');
        req.session.formState = { path: back.split('?')[0], fields: keptFields(req.body) };
        return res.redirect(303, back);
      }
    }
    res.status(status);
    if (wantsJson(req)) return res.json({ error: message });
    const titles = { 401: 'Bitte melde dich an', 403: 'Das ist nicht erlaubt', 404: 'Nicht gefunden', 413: 'Das war zu groß', 429: 'Kurz durchatmen' };
    const body = html`<div class="error-page">${empty({
      icon: status === 404 ? 'search' : status === 429 ? 'timer' : 'alert',
      title: titles[status] || 'Das hat nicht geklappt',
      text: message,
      actions: linkButton(req.user ? '/start' : '/', 'Zur Startseite', { kind: 'primary' }),
    })}</div>`;
    try {
      res.send(page(req, { title: titles[status] || 'Hinweis', body, width: 'narrow' }));
    } catch {
      res.type('text/plain').send(message);
    }
  });

  return app;
}

const wantsJson = (req) => String(req.headers.accept || '').includes('application/json');

/** The Hub page a form was sent from (same origin only), or null. */
function sameOriginPath(req, config) {
  try {
    const ref = new URL(String(req.headers.referer || ''));
    if (ref.origin !== config.hubOrigin) return null;
    const p = ref.pathname + ref.search;
    return isLocalPath(p) ? p : null;
  } catch {
    return null;
  }
}

/** What the person typed, to show it again after an error: text fields only, bounded, never the CSRF token. */
function keptFields(body) {
  const out = {};
  let total = 0;
  for (const [k, v] of Object.entries(body && typeof body === 'object' ? body : {})) {
    if (k === '_csrf' || typeof v !== 'string' || v.length > 5000 || !/^[A-Za-z0-9_.:-]{1,64}$/.test(k)) continue;
    total += v.length;
    if (total > 20000) break;
    out[k] = v;
  }
  return out;
}

/** Create everything. Returns { ctx, start(), stop() }. */
function createHub(config) {
  const db = openDb(path.join(config.dataDir, 'hub.sqlite'));
  const ctx = { config, db };
  ctx.tokens = createTokens(config.sessionSecret);
  ctx.limiter = createLimiter(config.rate);
  ctx.access = createAccess(db);
  ctx.settings = createSettings(db, config);
  ctx.uploads = createUploads(ctx);
  ctx.userFiles = createUserFiles(ctx);
  ctx.services = createServices(ctx);
  ctx.classApps = createClassApps(ctx);
  ctx.assignments = createAssignments(ctx);
  ctx.auth = createAuth(ctx);

  const hubApp = createHubApp(ctx);
  const appsHost = createAppsHost(ctx);

  const handler = (req, res) => {
    const host = String(req.headers.host || '').toLowerCase();
    if (host === config.hubHost) return hubApp(req, res);
    if (host.endsWith(config.appsHostSuffix)) return appsHost(req, res, host.slice(0, -config.appsHostSuffix.length));
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Unbekannte Adresse. Bitte öffne ${config.hubOrigin}`);
  };
  // One listener per address. In test mode these are the two loopback addresses
  // (*.localhost resolves to 127.0.0.1 or ::1 depending on the system).
  const servers = [];
  const listen = (host, port) =>
    new Promise((resolve, reject) => {
      const server = http.createServer(handler);
      server.requestTimeout = 10 * 60_000;
      server.once('error', reject);
      server.listen(port, host, () => {
        servers.push(server);
        resolve(server);
      });
    });

  // Retention (audit log, archived classes, inactive-account flags): at start and daily.
  ctx.services.maintenance();
  const daily = setInterval(() => ctx.services.maintenance(), 86_400_000);
  daily.unref();

  return {
    ctx,
    async start() {
      const [first, ...more] = config.listenHosts;
      const server = await listen(first, config.listenPort);
      // With port 0 (tests) the real port is only known now.
      if (config.listenPort === 0) config.publicPort = String(server.address().port);
      for (const host of more) await listen(host, server.address().port).catch(() => {}); // e.g. IPv6 switched off
    },
    stop: () =>
      Promise.all(
        servers.map(
          (server) =>
            new Promise((resolve) => {
              server.closeAllConnections();
              server.close(resolve);
            })
        )
      ).then(() => {
        clearInterval(daily);
        db.close();
      }),
  };
}

module.exports = { createHub };
