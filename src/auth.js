'use strict';
// Sign-in. The only real way in is a Microsoft school account (OpenID Connect
// authorization code flow with PKCE, handled on the server by MSAL).
// The Hub never sees or stores a password, and keeps no Microsoft tokens.

const { HttpError, newId } = require('./util');
const { ROLE_LABEL } = require('./html');

// Only the basic sign-in claims. No Graph permissions are requested.
const SCOPES = ['openid', 'profile', 'email'];

function createAuth(ctx) {
  const { config, db } = ctx;
  let client = null;
  let cryptoProvider = null;
  if (config.microsoft) {
    const msal = require('@azure/msal-node');
    client = new msal.ConfidentialClientApplication({
      auth: {
        clientId: config.microsoft.clientId,
        // Tenant-specific authority: Microsoft itself refuses other tenants and personal accounts.
        authority: `https://login.microsoftonline.com/${config.microsoft.tenantId}`,
        clientSecret: config.microsoft.clientSecret,
      },
    });
    cryptoProvider = new msal.CryptoProvider();
  }
  const redirectUri = () => `${config.hubOrigin}/auth/callback`;

  /** Build the Microsoft login URL; state and PKCE verifier stay in the server-side session. */
  async function loginUrl(session) {
    if (!client) throw new HttpError(503, 'Die Microsoft-Anmeldung ist auf diesem Server nicht eingerichtet.');
    const { verifier, challenge } = await cryptoProvider.generatePkceCodes();
    const state = cryptoProvider.createNewGuid();
    session.authFlow = { state, verifier };
    return client.getAuthCodeUrl({
      scopes: SCOPES, redirectUri: redirectUri(), state,
      codeChallenge: challenge, codeChallengeMethod: 'S256', prompt: 'select_account',
    });
  }

  /** Validate the callback and return { oid, name, email } or throw a user-safe error. */
  async function handleCallback(session, query) {
    const flow = session.authFlow;
    delete session.authFlow; // one-time use
    const failed = new HttpError(403, 'Die Anmeldung hat nicht geklappt. Bitte versuche es noch einmal.');
    if (query.error || !flow || typeof query.state !== 'string' || query.state !== flow.state || typeof query.code !== 'string') throw failed;
    let result;
    try {
      result = await client.acquireTokenByCode({ code: query.code, scopes: SCOPES, redirectUri: redirectUri(), codeVerifier: flow.verifier });
    } catch (err) {
      console.warn('Token exchange failed:', err.errorCode || err.message);
      throw failed;
    }
    const claims = result.idTokenClaims || {};
    // Defence in depth: the token must come from OUR tenant.
    if (claims.tid !== config.microsoft.tenantId || !claims.oid) {
      throw new HttpError(403, 'Dieses Konto gehört nicht zu unserer Schule. Bitte melde dich mit deinem Schulkonto an.');
    }
    return { oid: String(claims.oid), name: String(claims.name || 'Ohne Namen'), email: String(claims.email || claims.preferred_username || '') };
  }

  /** Role for a first sign-in, from configuration only. null = not allowed in. */
  function roleForEmail(email) {
    const address = String(email).toLowerCase();
    const at = address.lastIndexOf('@');
    if (at < 1) return null; // not an e-mail address at all
    const domain = address.slice(at + 1);
    if (config.adminEmails.includes(address)) return 'admin';
    // If a domain is listed for both, the lower role wins; the admin can promote.
    if (config.studentDomains.includes(domain)) return 'student';
    if (config.staffDomains.includes(domain)) return 'teacher';
    return null;
  }

  /** Create or update the account after a successful sign-in. */
  function upsertUser({ oid, name, email }) {
    const initial = roleForEmail(email);
    if (!initial) throw new HttpError(403, 'Mit dieser E-Mail-Adresse ist keine Anmeldung möglich. Bitte nutze dein Schulkonto.');
    const cleanName = name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80) || 'Ohne Namen';
    const cleanEmail = email.toLowerCase().slice(0, 200);
    let user = db.get('SELECT * FROM users WHERE oid = ?', oid);
    if (!user) {
      const id = newId();
      db.run('INSERT INTO users (id, oid, name, email, role, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, oid, cleanName, cleanEmail, initial, Date.now(), Date.now());
      user = db.get('SELECT * FROM users WHERE id = ?', id);
    } else {
      if (user.disabled) throw new HttpError(403, 'Dieses Konto wurde gesperrt. Bitte wende dich an die Verwaltung.');
      // The stored role stays (the admin may have changed it); ADMIN_EMAILS always wins.
      const role = initial === 'admin' ? 'admin' : user.role;
      db.run('UPDATE users SET name = ?, email = ?, role = ?, last_login_at = ?, flagged_inactive_at = NULL WHERE id = ?', cleanName, cleanEmail, role, Date.now(), user.id);
      // An admin may have taken the role away: the audit log must not end with that change when it is undone here.
      if (role !== user.role) {
        ctx.services.audit(null, 'rolle_geaendert', cleanName, `${ROLE_LABEL[user.role]} → ${ROLE_LABEL[role]} (ADMIN_EMAILS, bei der Anmeldung)`, { subjectId: user.id });
      }
      user = db.get('SELECT * FROM users WHERE id = ?', user.id);
    }
    return user;
  }

  /** Start the logged-in session with a NEW session id (prevents session fixation). */
  function establishSession(req, user, done) {
    const returnTo = req.session.returnTo;
    req.session.regenerate((err) => {
      if (err) return done(err);
      req.session.userId = user.id;
      req.session.createdAt = Date.now();
      ctx.services.audit(user, 'anmeldung');
      // Only local paths are accepted as a return target.
      const target = typeof returnTo === 'string' && /^\/(?![/\\])/.test(returnTo) ? returnTo : '/start';
      req.session.save((e) => done(e, target));
    });
  }

  const logoutUrl = () =>
    config.microsoft
      ? `https://login.microsoftonline.com/${config.microsoft.tenantId}/oauth2/v2.0/logout?${new URLSearchParams({ post_logout_redirect_uri: `${config.hubOrigin}/` })}`
      : '/';

  return { loginUrl, handleCallback, roleForEmail, upsertUser, establishSession, logoutUrl, enabled: Boolean(client) };
}

module.exports = { createAuth };
