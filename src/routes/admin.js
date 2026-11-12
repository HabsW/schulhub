'use strict';
// Head admin: users and roles, classes, apps, and the audit log.
// Every route starts with the same server-side check.

const { html, raw, page, flash, csrfField, postButton, appIcon, ROLE_LABEL } = require('../html');
const { deny, bad, formatDate, cleanText } = require('../util');

module.exports = (app, ctx) => {
  const { db, access, services } = ctx;

  // One gate for the whole area. Non-admins get the same 404 as for any unknown page.
  app.use('/admin', (req, res, next) => (access.isAdmin(req.user) ? next() : next(deny())));

  const tabs = (active) => html`<nav class="tabs">${[['', 'Nutzer'], ['/klassen', 'Klassen'], ['/apps', 'Apps'], ['/protokoll', 'Protokoll']].map(
    ([p, l]) => html`<a href="/admin${p}"${active === l ? raw(' class="on"') : ''}>${l}</a>`)}</nav>`;
  const admins = () => db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").n;
  const target = (req) => {
    const u = db.get('SELECT * FROM users WHERE id = ?', String(req.params.uid));
    if (!u) throw deny();
    return u;
  };

  app.get('/admin', (req, res) => {
    const q = cleanText(req.query.q, 60);
    const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const users = db.all("SELECT * FROM users WHERE name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' ORDER BY name LIMIT 200", like, like);
    const total = db.get('SELECT COUNT(*) AS n FROM users').n;
    const body = html`<h1>Verwaltung</h1>${tabs('Nutzer')}
      <form method="get" action="/admin" class="row"><label class="grow">Suche nach Name oder E-Mail<input name="q" value="${q}" maxlength="60"></label><button class="btn">Suchen</button></form>
      <p class="muted">${total} Konten insgesamt${users.length === 200 ? ' – es werden die ersten 200 Treffer gezeigt' : ''}.</p>
      <div class="scroll"><table class="data"><thead><tr><th>Name</th><th>E-Mail</th><th>Rolle</th><th>Letzte Anmeldung</th><th></th></tr></thead><tbody>
      ${users.map((u) => html`<tr><td><strong>${u.name}</strong>${u.disabled ? html` <span class="badge warn">Gesperrt</span>` : ''}</td><td>${u.email}</td>
        <td><form method="post" action="/admin/nutzer/${u.id}/rolle" class="row tight">${csrfField(req)}
          <select name="rolle" aria-label="Rolle von ${u.name}">${Object.entries(ROLE_LABEL).map(([r, l]) => html`<option value="${r}"${u.role === r ? raw(' selected') : ''}>${l}</option>`)}</select>
          <button class="btn small">Ändern</button></form></td>
        <td>${formatDate(u.last_login_at)}</td>
        <td class="right actions">${u.id === req.user.id ? html`<span class="muted">Das bist du</span>` : html`
          ${postButton(req, `/admin/nutzer/${u.id}/sperren`, u.disabled ? 'Entsperren' : 'Sperren', { cls: 'btn small ghost', fields: { an: u.disabled ? '0' : '1' } })}
          ${postButton(req, `/admin/nutzer/${u.id}/loeschen`, 'Löschen', { cls: 'btn small ghost', confirm: `Das Konto von ${u.name} mit allen Daten und Apps endgültig löschen?` })}`}</td></tr>`)}
      </tbody></table></div>`;
    res.send(page(req, { title: 'Verwaltung', body, active: 'admin' }));
  });

  app.post('/admin/nutzer/:uid/rolle', (req, res) => {
    const u = target(req);
    const role = String(req.body.rolle);
    if (!Object.hasOwn(ROLE_LABEL, role)) throw bad('Unbekannte Rolle.');
    if (u.role === 'admin' && role !== 'admin' && admins() <= 1) throw bad('Es muss mindestens einen Admin geben.');
    if (u.role !== role) {
      db.run('UPDATE users SET role = ? WHERE id = ?', role, u.id);
      services.audit(req.user, 'rolle_geaendert', u.name, `${ROLE_LABEL[u.role]} → ${ROLE_LABEL[role]}`);
      flash(req, `${u.name} ist jetzt ${ROLE_LABEL[role]}.`);
    }
    res.redirect(303, '/admin');
  });

  app.post('/admin/nutzer/:uid/sperren', (req, res) => {
    const u = target(req);
    if (u.id === req.user.id) throw bad('Du kannst dich nicht selbst sperren.');
    const on = req.body.an === '1';
    db.run('UPDATE users SET disabled = ? WHERE id = ?', on ? 1 : 0, u.id);
    if (on) db.run('DELETE FROM sessions WHERE user_id = ?', u.id); // signed out everywhere, immediately
    services.audit(req.user, on ? 'konto_gesperrt' : 'konto_entsperrt', u.name);
    res.redirect(303, '/admin');
  });

  app.post('/admin/nutzer/:uid/loeschen', (req, res) => {
    const u = target(req);
    if (u.id === req.user.id) throw bad('Dein eigenes Konto löschst du unter „Meine Daten“.');
    services.deleteUser(req.user, u);
    flash(req, 'Das Konto wurde gelöscht.');
    res.redirect(303, '/admin');
  });

  app.get('/admin/klassen', (req, res) => {
    const classes = db.all(
      `SELECT c.id, c.name, c.created_at,
              (SELECT GROUP_CONCAT(u.name, ', ') FROM class_members m JOIN users u ON u.id = m.user_id WHERE m.class_id = c.id AND m.role = 'teacher') AS teachers,
              (SELECT COUNT(*) FROM class_members m WHERE m.class_id = c.id AND m.role = 'student') AS students
         FROM classes c ORDER BY c.name LIMIT 500`
    );
    const body = html`<h1>Verwaltung</h1>${tabs('Klassen')}
      <div class="scroll"><table class="data"><thead><tr><th>Klasse</th><th>Lehrkraft</th><th>Schüler/innen</th><th>Angelegt</th></tr></thead><tbody>
      ${classes.map((c) => html`<tr><td><a href="/klassen/${c.id}"><strong>${c.name}</strong></a></td><td>${c.teachers || '–'}</td><td>${c.students}</td><td>${formatDate(c.created_at)}</td></tr>`)}
      </tbody></table></div>${classes.length ? '' : html`<p class="muted">Noch keine Klassen.</p>`}`;
    res.send(page(req, { title: 'Klassen verwalten', body, active: 'admin' }));
  });

  app.get('/admin/apps', (req, res) => {
    const apps = db.all(
      `SELECT a.*, u.name AS owner_name, u.role AS owner_role, (SELECT COUNT(*) FROM class_apps ca WHERE ca.app_id = a.id AND ca.status = 'approved') AS classes
         FROM apps a JOIN users u ON u.id = a.owner_id ORDER BY a.updated_at DESC LIMIT 500`
    );
    const body = html`<h1>Verwaltung</h1>${tabs('Apps')}
      <div class="scroll"><table class="data"><thead><tr><th>App</th><th>Besitzer/in</th><th>Stand</th><th>Klassen</th><th>Geändert</th></tr></thead><tbody>
      ${apps.map((a) => html`<tr><td><a class="inlineapp" href="/apps/${a.id}">${appIcon(a, 'sm')}<strong>${a.name}</strong></a></td>
        <td>${a.owner_name} <span class="muted">(${ROLE_LABEL[a.owner_role]})</span></td>
        <td>${a.schoolwide_version_id ? html`<span class="badge ok">Schulweit</span>` : a.published_version_id ? 'Veröffentlicht' : html`<span class="muted">Entwurf</span>`}</td>
        <td>${a.classes}</td><td>${formatDate(a.updated_at)}</td></tr>`)}
      </tbody></table></div>${apps.length ? '' : html`<p class="muted">Noch keine Apps.</p>`}`;
    res.send(page(req, { title: 'Apps verwalten', body, active: 'admin' }));
  });

  app.get('/admin/protokoll', (req, res) => {
    const before = Number.parseInt(req.query.vor, 10) || Number.MAX_SAFE_INTEGER;
    const action = cleanText(req.query.aktion, 40);
    const rows = db.all("SELECT * FROM audit_log WHERE id < ? AND (? = '' OR action = ?) ORDER BY id DESC LIMIT 100", before, action, action);
    const actions = db.all('SELECT DISTINCT action FROM audit_log ORDER BY action').map((r) => r.action);
    const last = rows.length === 100 ? rows[rows.length - 1].id : null;
    const body = html`<h1>Verwaltung</h1>${tabs('Protokoll')}
      <form method="get" action="/admin/protokoll" class="row"><label>Vorgang<select name="aktion"><option value="">Alle</option>
        ${actions.map((a) => html`<option value="${a}"${a === action ? raw(' selected') : ''}>${a}</option>`)}</select></label><button class="btn">Filtern</button></form>
      <div class="scroll"><table class="data"><thead><tr><th>Zeitpunkt</th><th>Wer</th><th>Vorgang</th><th>Betrifft</th><th>Einzelheiten</th></tr></thead><tbody>
      ${rows.map((r) => html`<tr><td>${formatDate(r.at)}</td><td>${r.actor_label}</td><td><code>${r.action}</code></td><td>${r.target}</td><td>${r.detail}</td></tr>`)}
      </tbody></table></div>
      ${last ? html`<p><a class="btn" href="/admin/protokoll?vor=${last}&amp;aktion=${encodeURIComponent(action)}">Ältere Einträge</a></p>` : ''}`;
    res.send(page(req, { title: 'Protokoll', body, active: 'admin' }));
  });
};
