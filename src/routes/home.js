'use strict';
// Landing page, sign-in / sign-out, local test login, and the personal start page.

const { html, page, csrfField, appIcon, ROLE_LABEL } = require('../html');
const { HttpError } = require('../util');

/** A clickable app card. `href` is built by the server from ids it looked up itself. */
function appCard(app, href, sub = '') {
  return html`<a class="card app" href="${href}">${appIcon(app)}<span class="grow"><strong>${app.name}</strong>
    <small>${sub || app.description.split('\n')[0].slice(0, 70)}</small></span></a>`;
}

module.exports = (app, ctx) => {
  const { db, config, auth, limiter, services, access } = ctx;

  app.get('/', (req, res) => {
    if (req.user) return res.redirect('/start');
    const joining = String(req.session.returnTo || '').startsWith('/beitreten/');
    const devUsers = config.dev ? db.all("SELECT id, name, role FROM users WHERE oid LIKE 'dev-%' ORDER BY CASE role WHEN 'student' THEN 0 WHEN 'teacher' THEN 1 ELSE 2 END, name") : [];
    const body = html`<section class="hero">
      <h1>Willkommen bei ${config.hubName}</h1>
      <p class="lead">Lern-Apps und Spiele von unserer Schule – für unsere Schule. Einmal anmelden, und alles ist da: deine Klassen, deine Apps, dein Fortschritt.</p>
      ${joining ? html`<p class="flash ok">Melde dich an, um der Klasse beizutreten.</p>` : ''}
      ${auth.enabled
        ? html`<p><a class="btn primary big" href="/auth/login">Mit Microsoft-Schulkonto anmelden</a></p>
               <p class="muted">Es gibt keine eigenen Passwörter: Du meldest dich mit deinem Schulkonto an.</p>`
        : html`<p class="muted">Die Microsoft-Anmeldung ist hier nicht eingerichtet (lokaler Testmodus).</p>`}
    </section>
    ${config.dev ? html`<section class="devlogin">
      <h2>Lokaler Testmodus: als Testperson anmelden</h2>
      <p class="muted">Diese Anmeldung gibt es nur mit <code>npm run dev</code> auf dem eigenen Rechner.</p>
      <div class="grid">${devUsers.map((u) => html`<form method="post" action="/dev/login" class="card">${csrfField(req)}
        <input type="hidden" name="user" value="${u.id}"><strong>${u.name}</strong><small>${ROLE_LABEL[u.role]}</small>
        <button class="btn">Anmelden</button></form>`)}</div>
    </section>` : ''}`;
    res.send(page(req, { title: 'Willkommen', body }));
  });

  // ---------- Microsoft sign-in ----------
  app.get('/auth/login', async (req, res, next) => {
    limiter.guard('login', req.ip);
    const url = await auth.loginUrl(req.session);
    req.session.save((err) => (err ? next(err) : res.redirect(url)));
  });

  app.get('/auth/callback', async (req, res, next) => {
    limiter.guard('login', req.ip);
    let user;
    try {
      user = auth.upsertUser(await auth.handleCallback(req.session, req.query));
    } catch (err) {
      if (err instanceof HttpError) services.audit(null, 'anmeldung_abgelehnt');
      return next(err);
    }
    auth.establishSession(req, user, (err, target) => (err ? next(err) : res.redirect(target)));
  });

  app.post('/auth/logout', (req, res) => {
    if (req.user) services.audit(req.user, 'abmeldung');
    req.session.destroy(() => {
      res.clearCookie(config.https ? '__Host-hub_sid' : 'hub_sid', { path: '/', secure: config.https, httpOnly: true, sameSite: 'lax' });
      res.redirect(303, req.user ? auth.logoutUrl() : '/');
    });
  });

  // ---------- LOCAL TEST MODE ONLY ----------
  // This route does not exist unless the server was started with --dev,
  // which itself refuses to start unless BASE_URL is localhost.
  if (config.dev) {
    app.post('/dev/login', (req, res, next) => {
      const user = db.get("SELECT * FROM users WHERE id = ? AND oid LIKE 'dev-%' AND disabled = 0", String(req.body.user || ''));
      if (!user) return next(new HttpError(400, 'Diese Testperson gibt es nicht.'));
      db.run('UPDATE users SET last_login_at = ? WHERE id = ?', Date.now(), user.id);
      auth.establishSession(req, user, (err, target) => (err ? next(err) : res.redirect(303, target)));
    });
  }

  // ---------- personal start page ----------
  app.get('/start', (req, res) => {
    const user = req.user;
    const classes = db.all(
      `SELECT c.id, c.name, m.role FROM classes c JOIN class_members m ON m.class_id = c.id AND m.user_id = ? ORDER BY c.name`,
      user.id
    );
    const classApps = (classId) =>
      db.all(
        `SELECT a.* FROM class_apps ca JOIN apps a ON a.id = ca.app_id
          WHERE ca.class_id = ? AND ca.status = 'approved' AND ca.version_id IS NOT NULL ORDER BY a.name`,
        classId
      );
    // What a teacher has to look at: submissions and updates waiting in their classes.
    const waiting = db.all(
      `SELECT a.id, a.name, a.emoji, a.color, a.description, c.name AS class_name, u.name AS owner_name
         FROM class_apps ca JOIN apps a ON a.id = ca.app_id JOIN classes c ON c.id = ca.class_id
         JOIN class_members m ON m.class_id = ca.class_id AND m.user_id = ? AND m.role = 'teacher'
         JOIN users u ON u.id = a.owner_id
        WHERE ca.status = 'pending' OR ca.requested_version_id IS NOT NULL ORDER BY ca.created_at`,
      user.id
    );
    const recent = db
      .all('SELECT a.* FROM plays p JOIN apps a ON a.id = p.app_id WHERE p.user_id = ? ORDER BY p.last_at DESC LIMIT 8', user.id)
      .filter((a) => access.resolvePlay(user, a))
      .slice(0, 4);
    const schoolwide = db.all('SELECT * FROM apps WHERE schoolwide_version_id IS NOT NULL ORDER BY name LIMIT 60');
    const firstName = user.name.includes(',') ? user.name.split(',')[1].trim() : /^(Herr|Frau|Dr\.?)\s/.test(user.name) ? user.name : user.name.split(' ')[0];

    const body = html`<h1>Hallo, ${firstName}!</h1>
    ${waiting.length ? html`<section><h2>Wartet auf deine Freigabe</h2><div class="grid">
      ${waiting.map((a) => appCard(a, `/apps/${a.id}`, `von ${a.owner_name} · ${a.class_name}`))}</div></section>` : ''}
    ${recent.length ? html`<section><h2>Weitermachen</h2><div class="grid">
      ${recent.map((a) => appCard(a, `/apps/${a.id}/spielen`))}</div></section>` : ''}
    <section><h2>Meine Klassen</h2>
    ${classes.length === 0 ? html`<div class="empty">${user.role === 'student'
        ? html`<p><strong>Du bist noch in keiner Klasse.</strong></p><p>Deine Lehrkraft zeigt dir einen QR-Code oder einen Link. Scanne ihn mit dem Handy oder öffne den Link – schon bist du dabei.</p>`
        : html`<p><strong>Noch keine Klasse.</strong></p><p><a class="btn primary" href="/klassen">Erste Klasse anlegen</a></p>`}</div>` : ''}
    ${classes.map((c) => {
      const apps = classApps(c.id);
      return html`<div class="classblock"><h3><a href="/klassen/${c.id}">${c.name}</a>${c.role === 'teacher' ? html` <span class="badge">Du unterrichtest</span>` : ''}</h3>
        ${apps.length ? html`<div class="grid">${apps.map((a) => appCard(a, `/apps/${a.id}/spielen?klasse=${c.id}`))}</div>`
          : html`<p class="muted">In dieser Klasse gibt es noch keine Apps.</p>`}</div>`;
    })}</section>
    ${schoolwide.length ? html`<section><h2>Für die ganze Schule</h2><div class="grid">
      ${schoolwide.map((a) => appCard(a, `/apps/${a.id}/spielen`))}</div></section>` : ''}`;
    res.send(page(req, { title: 'Start', body, active: 'start' }));
  });

  app.get('/datenschutz', (req, res) => {
    const body = html`<section class="narrow prose"><h1>Welche Daten speichert ${config.hubName}?</h1>
    <p>So wenig wie möglich. Hier steht alles – in normaler Sprache.</p>
    <h2>Über dich</h2>
    <ul><li><strong>Name und Schul-E-Mail-Adresse</strong> aus deinem Microsoft-Schulkonto, damit Lehrkräfte dich erkennen.</li>
    <li><strong>Eine Kennnummer</strong> von Microsoft, damit dein Konto dasselbe bleibt, auch wenn sich dein Name ändert.</li>
    <li><strong>Deine Rolle</strong> (Schüler/in, Lehrkraft oder Admin) und in welchen Klassen du bist.</li>
    <li>Wann du dich zuletzt angemeldet hast.</li></ul>
    <p>Dein Passwort sieht ${config.hubName} nie. Es werden keine Fotos, Geburtsdaten, Adressen oder Standorte gespeichert, und es gibt keine Werbung und kein Tracking.</p>
    <h2>In den Apps</h2>
    <ul><li><strong>Spielstände</strong>, damit du weitermachen kannst.</li>
    <li><strong>Ergebnisse</strong> (zum Beispiel geübte Vokabeln). Die sehen nur du und die Lehrkräfte der Klasse, in der die App freigegeben ist.</li>
    <li><strong>Bestenlisten.</strong> Du kannst einstellen, dass dort statt deines Namens „Anonym“ steht.</li></ul>
    <p>Apps laufen abgeschottet: Eine App kommt nur an ihre eigenen Daten und kann nichts ins Internet schicken. Apps erfahren deinen Namen, aber nicht deine E-Mail-Adresse.</p>
    <h2>Deine Rechte</h2>
    <p>Unter <a href="/meine-daten">Meine Daten</a> kannst du jederzeit alles ansehen, herunterladen und löschen – einzelne App-Daten oder dein ganzes Konto.</p>
    <h2>Protokoll</h2>
    <p>Wichtige Vorgänge (Anmeldungen, Uploads, Freigaben, Löschungen, Rollenänderungen) werden für die Schulleitung protokolliert und nach ${config.auditRetentionDays} Tagen automatisch gelöscht.</p>
    </section>`;
    res.send(page(req, { title: 'Datenschutz', body }));
  });
};

module.exports.appCard = appCard;
