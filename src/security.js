'use strict';
// Security building blocks: signed tokens, CSRF, rate limits, response headers.

const crypto = require('node:crypto');
const { HttpError, safeEqual } = require('./util');

// ---------- Signed, short-lived tokens ----------
// Format: <payload>.<signature>, both base64url. Each kind of token is signed
// with its own key (derived from SESSION_SECRET), so a file token can never be
// used as an SDK token or the other way round.

function createTokens(secret) {
  const keyFor = (kind) => crypto.createHmac('sha256', secret).update(`schulhub-token:${kind}`).digest();
  const mac = (kind, body) => crypto.createHmac('sha256', keyFor(kind)).update(body).digest('base64url');

  return {
    sign(kind, payload, ttlSeconds) {
      const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlSeconds * 1000 })).toString('base64url');
      return `${body}.${mac(kind, body)}`;
    },
    /** Returns the payload, or null if the token is forged, of another kind, or expired. */
    verify(kind, token) {
      if (typeof token !== 'string' || token.length > 2000) return null;
      const dot = token.indexOf('.');
      if (dot < 1) return null;
      const body = token.slice(0, dot);
      if (!safeEqual(token.slice(dot + 1), mac(kind, body))) return null;
      try {
        const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        return typeof payload.exp === 'number' && payload.exp > Date.now() ? payload : null;
      } catch {
        return null;
      }
    },
    /** Stable pseudonym, e.g. the user id an app gets to see (differs per app). */
    pseudonym: (kind, value) => mac(`pseudonym:${kind}`, value).slice(0, 20),
  };
}

// ---------- Rate limiting (in memory, fixed window) ----------

function createLimiter(rates) {
  const buckets = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (b.reset <= now) buckets.delete(k);
  }, 60_000);
  timer.unref();

  /** Count one event. Returns false when the limit is exceeded. */
  function hit(name, key) {
    const [max, windowMs] = rates[name];
    const id = `${name}:${key}`;
    const now = Date.now();
    let b = buckets.get(id);
    if (!b || b.reset <= now) buckets.set(id, (b = { count: 0, reset: now + windowMs }));
    b.count++;
    return b.count <= max;
  }
  /** Is the key currently over its limit? (does not count) */
  function blocked(name, key) {
    const b = buckets.get(`${name}:${key}`);
    return Boolean(b && b.reset > Date.now() && b.count >= rates[name][0]);
  }
  function guard(name, key) {
    if (!hit(name, key)) throw new HttpError(429, 'Das waren zu viele Anfragen in kurzer Zeit. Bitte warte einen Moment.');
  }
  return { hit, blocked, guard };
}

// ---------- CSRF ----------
// Every state-changing request must carry the per-session token (form field
// _csrf or header x-csrf-token) and, if the browser sends an Origin header,
// it must be the Hub's own origin.

function csrfToken(req) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('base64url');
  return req.session.csrf;
}

function csrfProtect(config) {
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (origin && origin !== config.hubOrigin) return next(new HttpError(403, 'Anfrage abgelehnt.'));
    const sent = req.headers['x-csrf-token'] || (req.body && req.body._csrf);
    if (!req.session.csrf || typeof sent !== 'string' || !safeEqual(sent, req.session.csrf)) {
      return next(new HttpError(403, 'Deine Sitzung ist abgelaufen oder die Anfrage war ungültig. Bitte lade die Seite neu.'));
    }
    next();
  };
}

// ---------- Response headers ----------

function hubHeaders(config) {
  const formAction = ["'self'"];
  // After logout we redirect to Microsoft's sign-out page (Chrome applies form-action to redirects).
  if (config.microsoft) formAction.push('https://login.microsoftonline.com');
  const csp = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    `form-action ${formAction.join(' ')}`,
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ];
  return (req, res, next) => {
    // frame-src also limits where an embedded app can navigate its own frame.
    res.setHeader('Content-Security-Policy', [...csp, `frame-src ${config.appsOriginPattern}`].join('; '));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    if (config.https) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    next();
  };
}

/** Headers for everything served from an app origin (uploaded, untrusted content). */
function appHeaders(config) {
  const csp = [
    // No network access except to the app's own origin: an app cannot load
    // trackers or send data anywhere else.
    "default-src 'self' data: blob:",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    `frame-ancestors ${config.hubOrigin}`,
    // Applies the iframe sandbox even if the document is somehow opened elsewhere.
    'sandbox allow-scripts allow-same-origin allow-forms allow-modals allow-pointer-lock',
  ].join('; ');
  return {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), display-capture=()',
    'X-Robots-Tag': 'noindex, nofollow',
    ...(config.https ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
  };
}

module.exports = { createTokens, createLimiter, csrfToken, csrfProtect, hubHeaders, appHeaders };
