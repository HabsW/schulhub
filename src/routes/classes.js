'use strict';
// Classes: create, join by QR code / link, members, and the apps of a class.

const qrcode = require('qrcode-generator');
const { html, raw, page, flash, csrfField, postButton, appIcon } = require('../html');
const { deny, bad, cleanText, formatDate, safeEqual, HttpError } = require('../util');

const DURATIONS = { 15: '15 Minuten', 60: '1 Stunde', 1440: '1 Tag', 10080: '1 Woche' };

/** QR code as inline SVG, built from our own URL (no user input, no inline styles). */
function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 2} ${r + 2}h1v1h-1z`;
  return raw(`<svg class="qr" viewBox="0 0 ${n + 4} ${n + 4}" role="img" aria-label="QR-Code zum Beitreten"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`);
}

module.exports = (app, ctx) => {
  const { db, config, access, services, limiter } = ctx;

  const getClass = (id) => db.get('SELECT * FROM classes WHERE id = ?', String(id));
  /** Load a class the user may see, else 404. */
  function viewClass(req) {
    const cls = getClass(req.params.id);
    if (!cls || !access.canViewClass(req.user, cls.id)) throw deny();
    return cls;
  }
  /** Load a class the user may manage (its teacher or admin), else 404. */
  function manageClass(req) {
    const cls = getClass(req.params.id);
    if (!cls || !access.canManageClass(req.user, cls.id)) throw deny();
    return cls;
  }
  const activeCode = (classId) => db.get("SELECT * FROM join_codes WHERE class_id = ? AND role = 'student' AND expires_at > ?", classId, Date.now());
  const joinUrl = (code) => `${config.hubOrigin}/beitreten/${code}`;

  app.get('/klassen', (req, res) => {
    const classes = db.all(
      `SELECT c.id, c.name, m.role,
              (SELECT COUNT(*) FROM class_members s WHERE s.class_id = c.id AND s.role = 'student') AS students,
              (SELECT COUNT(*) FROM class_apps ca WHERE ca.class_id = c.id AND ca.status = 'approved') AS apps
         FROM classes c JOIN class_members m ON m.class_id = c.id AND m.user_id = ? ORDER BY c.name`,
      req.user.id
    );
    const body = html`<h1>Klassen</h1>
    ${classes.length ? html`<div class="grid">${classes.map((c) => html`<a class="card" href="/klassen/${c.id}"><strong>${c.name}</strong>
      <small>${c.students} Schüler/innen · ${c.apps} Apps${c.role === 'teacher' ? ' · Du unterrichtest' : ''}</small></a>`)}</div>`
      : html`<div class="empty"><p>${access.canCreateClass(req.user) ? 'Du hast noch keine Klasse angelegt.' : 'Du bist noch in keiner Klasse. Deine Lehrkraft zeigt dir einen QR-Code oder Link zum Beitreten.'}</p></div>`}
    ${access.canCreateClass(req.user) ? html`<section class="panel"><h2>Neue Klasse anlegen</h2>
      <form method="post" action="/klassen" class="row">${csrfField(req)}
      <label class="grow">Name der Klasse<input name="name" required minlength="2" maxlength="60" placeholder="z. B. 7b Englisch"></label>
      <button class="btn primary">Anlegen</button></form>
      <p class="muted">Schüler/innen treten danach selbst per QR-Code oder Link bei – niemand muss Namen eintippen.</p></section>` : ''}`;
    res.send(page(req, { title: 'Klassen', body, active: 'klassen' }));
  });

  app.post('/klassen', (req, res) => {
    if (!access.canCreateClass(req.user)) throw deny();
    const name = cleanText(req.body.name, 60);
    if (name.length < 2) throw bad('Bitte gib der Klasse einen Namen.');
    const mine = db.get("SELECT COUNT(*) AS n FROM class_members WHERE user_id = ? AND role = 'teacher'", req.user.id).n;
    if (mine >= config.limits.classesPerTeacher) throw bad('Du hast sehr viele Klassen. Bitte lösche zuerst alte Klassen.');
    const id = services.createClass(req.user, name);
    services.createJoinCode(req.user, id, 1440);
    res.redirect(303, `/klassen/${id}`);
  });

  app.get('/klassen/:id', (req, res) => {
    const cls = viewClass(req);
    const user = req.user;
    const manage = access.canManageClass(user, cls.id);
    const members = db.all('SELECT u.id, u.name, m.role FROM class_members m JOIN users u ON u.id = m.user_id WHERE m.class_id = ? ORDER BY m.role DESC, u.name', cls.id);
    const teachers = members.filter((m) => m.role === 'teacher');
    const students = members.filter((m) => m.role === 'student');
    const rows = db.all(
      `SELECT a.*, ca.status, ca.version_id, ca.requested_version_id, u.name AS owner_name
         FROM class_apps ca JOIN apps a ON a.id = ca.app_id JOIN users u ON u.id = a.owner_id
        WHERE ca.class_id = ? ORDER BY a.name`,
      cls.id
    );
    const playable = rows.filter((r) => r.status === 'approved' && r.version_id);
    const waiting = rows.filter((r) => r.status === 'pending' || r.requested_version_id);
    const mineWaiting = rows.filter((r) => r.owner_id === user.id && (r.status !== 'approved' || r.requested_version_id));
    // Apps this user could add: their own published apps, plus school-wide ones for teachers.
    const addable = db
      .all(
        `SELECT id, name FROM apps WHERE published_version_id IS NOT NULL AND (owner_id = ? OR (? = 1 AND schoolwide_version_id IS NOT NULL))
           AND id NOT IN (SELECT app_id FROM class_apps WHERE class_id = ?) ORDER BY name`,
        user.id, manage ? 1 : 0, cls.id
      );
    const code = manage ? activeCode(cls.id) : null;

    const body = html`<p class="crumbs"><a href="/klassen">Klassen</a> ›</p>
    <h1>${cls.name}</h1>
    <p class="muted">Lehrkraft: ${teachers.map((t) => t.name).join(', ') || '–'} · ${students.length} Schüler/innen</p>

    <section><h2>Apps</h2>
    ${playable.length ? html`<div class="grid">${playable.map((a) => html`<div class="card app">
        ${appIcon(a)}<span class="grow"><strong>${a.name}</strong><small>von ${a.owner_name}</small></span>
        <span class="actions"><a class="btn primary small" href="/apps/${a.id}/spielen?klasse=${cls.id}">Öffnen</a>
        ${manage ? html`<a class="btn small" href="/klassen/${cls.id}/apps/${a.id}/ergebnisse">Ergebnisse</a>
          ${postButton(req, `/klassen/${cls.id}/apps/${a.id}/entfernen`, 'Entfernen', { cls: 'btn small ghost', confirm: `„${a.name}“ aus der Klasse entfernen? Die Daten der Schüler/innen bleiben erhalten.` })}` : ''}</span>
      </div>`)}</div>` : html`<p class="muted">Noch keine Apps in dieser Klasse.</p>`}
    </section>

    ${manage && waiting.length ? html`<section class="panel attention"><h2>Wartet auf Freigabe</h2>
      ${waiting.map((a) => html`<div class="rowline">${appIcon(a, 'sm')}<span class="grow"><strong>${a.name}</strong> von ${a.owner_name}
        <small>${a.status === 'approved' ? 'Neue Version eingereicht – die Klasse nutzt weiter die freigegebene Version.' : 'Neu eingereicht.'}</small></span>
        <a class="btn small" href="/apps/${a.id}">Ansehen und prüfen</a></div>`)}</section>` : ''}
    ${!manage && mineWaiting.length ? html`<section class="panel"><h2>Deine eingereichten Apps</h2>
      ${mineWaiting.map((a) => html`<div class="rowline">${appIcon(a, 'sm')}<span class="grow"><strong>${a.name}</strong>
        <small>${a.status === 'rejected' ? 'Wurde abgelehnt – schau in die Kommentare.' : 'Wartet auf die Freigabe durch die Lehrkraft.'}</small></span>
        <a class="btn small" href="/apps/${a.id}">Zur App</a></div>`)}</section>` : ''}

    ${addable.length ? html`<section class="panel"><h2>${manage ? 'App zur Klasse hinzufügen' : 'Eigene App einreichen'}</h2>
      <form method="post" action="/klassen/${cls.id}/apps" class="row">${csrfField(req)}
      <label class="grow">App<select name="app">${addable.map((a) => html`<option value="${a.id}">${a.name}</option>`)}</select></label>
      <button class="btn primary">${manage ? 'Hinzufügen' : 'Einreichen'}</button></form>
      ${manage ? '' : html`<p class="muted">Deine Lehrkraft sieht sich die App an und gibt sie dann für die Klasse frei.</p>`}</section>` : ''}

    ${manage ? html`<section class="panel"><h2>Beitreten lassen</h2>
      ${code ? html`<div class="join"><a href="/klassen/${cls.id}/qr" title="Groß anzeigen">${qrSvg(joinUrl(code.code))}</a>
        <div><p>Schüler/innen scannen den Code oder öffnen den Link. Gültig bis <strong>${formatDate(code.expires_at)}</strong>.</p>
        <p><input class="copy" readonly value="${joinUrl(code.code)}" aria-label="Beitrittslink"> <button class="btn small" data-copy="${joinUrl(code.code)}">Link kopieren</button></p>
        <p><a class="btn" href="/klassen/${cls.id}/qr">Groß anzeigen (für den Beamer)</a>
        ${postButton(req, `/klassen/${cls.id}/code/loeschen`, 'Code abschalten', { cls: 'btn ghost' })}</p></div></div>`
        : html`<p>Zurzeit kann niemand beitreten. Erzeuge einen neuen Code, wenn neue Schüler/innen dazukommen sollen.</p>`}
      <form method="post" action="/klassen/${cls.id}/code" class="row">${csrfField(req)}
        <label>Neuer Code, gültig für<select name="minuten">${Object.entries(DURATIONS).map(([m, l]) => html`<option value="${m}"${m === '1440' ? raw(' selected') : ''}>${l}</option>`)}</select></label>
        <button class="btn">Neuen Code erzeugen</button></form>
      <p class="muted">Ein neuer Code macht den alten ungültig. Wer per Code beitritt, wird immer Schüler/in der Klasse – nie mehr.</p></section>` : ''}

    <section><h2>Mitglieder</h2>
    ${manage ? html`<table class="data"><thead><tr><th>Name</th><th>Rolle</th><th></th></tr></thead><tbody>
      ${members.map((m) => html`<tr><td>${m.name}</td><td>${m.role === 'teacher' ? 'Lehrkraft' : 'Schüler/in'}</td>
        <td class="right">${m.role === 'student' ? postButton(req, `/klassen/${cls.id}/mitglieder/${m.id}/entfernen`, 'Entfernen', { cls: 'btn small ghost', confirm: `${m.name} aus der Klasse entfernen?` }) : ''}</td></tr>`)}
      </tbody></table>` : html`<p class="muted">${students.length} Schüler/innen sind in dieser Klasse.</p>`}
    </section>

    <section class="panel quiet"><h2>Einstellungen</h2>
    ${manage ? html`<form method="post" action="/klassen/${cls.id}/umbenennen" class="row">${csrfField(req)}
        <label class="grow">Name<input name="name" value="${cls.name}" required minlength="2" maxlength="60"></label><button class="btn">Umbenennen</button></form>
      ${postButton(req, `/klassen/${cls.id}/loeschen`, 'Klasse löschen', { cls: 'btn danger', confirm: `Die Klasse „${cls.name}“ wirklich löschen? Das kann nicht rückgängig gemacht werden.` })}` : ''}
    ${access.classRole(user, cls.id) === 'student' ? postButton(req, `/klassen/${cls.id}/verlassen`, 'Klasse verlassen', { cls: 'btn ghost', confirm: 'Diese Klasse wirklich verlassen?' }) : ''}
    </section>`;
    res.send(page(req, { title: cls.name, body, active: 'klassen' }));
  });

  app.get('/klassen/:id/qr', (req, res) => {
    const cls = manageClass(req);
    const code = activeCode(cls.id);
    const body = html`<section class="center qrpage"><h1>${cls.name}</h1>
      ${code ? html`${qrSvg(joinUrl(code.code))}<p class="lead">Scanne den Code mit der Handykamera und melde dich mit deinem Schulkonto an.</p>
        <p class="muted">Gültig bis ${formatDate(code.expires_at)}</p>` : html`<p>Es gibt gerade keinen gültigen Beitrittscode.</p>`}
      <p><a class="btn" href="/klassen/${cls.id}">Zurück zur Klasse</a></p></section>`;
    res.send(page(req, { title: `Beitreten: ${cls.name}`, body, active: 'klassen' }));
  });

  app.post('/klassen/:id/code', (req, res) => {
    const cls = manageClass(req);
    const minutes = Object.hasOwn(DURATIONS, String(req.body.minuten)) ? Number(req.body.minuten) : 1440;
    services.createJoinCode(req.user, cls.id, minutes);
    services.audit(req.user, 'beitrittscode_erzeugt', cls.name, DURATIONS[minutes]);
    res.redirect(303, `/klassen/${cls.id}`);
  });

  app.post('/klassen/:id/code/loeschen', (req, res) => {
    const cls = manageClass(req);
    db.run("DELETE FROM join_codes WHERE class_id = ? AND role = 'student'", cls.id);
    res.redirect(303, `/klassen/${cls.id}`);
  });

  app.post('/klassen/:id/umbenennen', (req, res) => {
    const cls = manageClass(req);
    const name = cleanText(req.body.name, 60);
    if (name.length < 2) throw bad('Bitte gib der Klasse einen Namen.');
    db.run('UPDATE classes SET name = ? WHERE id = ?', name, cls.id);
    res.redirect(303, `/klassen/${cls.id}`);
  });

  app.post('/klassen/:id/loeschen', (req, res) => {
    const cls = manageClass(req);
    services.deleteClass(req.user, cls);
    flash(req, `Die Klasse „${cls.name}“ wurde gelöscht.`);
    res.redirect(303, '/klassen');
  });

  app.post('/klassen/:id/mitglieder/:uid/entfernen', (req, res) => {
    const cls = manageClass(req);
    // Only students can be removed here; teachers are never touched by this route.
    const done = db.run("DELETE FROM class_members WHERE class_id = ? AND user_id = ? AND role = 'student'", cls.id, String(req.params.uid));
    if (done.changes) services.audit(req.user, 'mitglied_entfernt', cls.name);
    res.redirect(303, `/klassen/${cls.id}`);
  });

  app.post('/klassen/:id/verlassen', (req, res) => {
    const cls = viewClass(req);
    db.run("DELETE FROM class_members WHERE class_id = ? AND user_id = ? AND role = 'student'", cls.id, req.user.id);
    flash(req, `Du hast „${cls.name}“ verlassen.`);
    res.redirect(303, '/klassen');
  });

  // ---------- joining ----------
  // The code is the only thing that matters here. It can only ever create a
  // 'student' membership; nothing in the request can change that.
  function findCode(req) {
    const key = req.user.id;
    if (limiter.blocked('joinFail', key) || limiter.blocked('joinFailIp', req.ip)) {
      throw new HttpError(429, 'Zu viele Versuche mit ungültigen Codes. Bitte warte ein paar Minuten.');
    }
    const sent = String(req.params.code || '');
    const row = /^[A-Za-z0-9_-]{32}$/.test(sent) ? db.get('SELECT * FROM join_codes WHERE code = ? AND expires_at > ?', sent, Date.now()) : null;
    if (!row || !safeEqual(row.code, sent)) {
      limiter.hit('joinFail', key);
      limiter.hit('joinFailIp', req.ip);
      throw bad('Dieser Beitrittscode ist ungültig oder abgelaufen. Bitte frag deine Lehrkraft nach einem neuen Code.');
    }
    return { row, cls: getClass(row.class_id) };
  }

  app.get('/beitreten/:code', (req, res) => {
    const { cls } = findCode(req);
    delete req.session.returnTo;
    const role = access.classRole(req.user, cls.id);
    if (role) return res.redirect(`/klassen/${cls.id}`);
    const teachers = db.all("SELECT u.name FROM class_members m JOIN users u ON u.id = m.user_id WHERE m.class_id = ? AND m.role = 'teacher'", cls.id);
    const body = html`<section class="narrow center"><h1>Klasse beitreten</h1>
      <p class="lead">Möchtest du der Klasse <strong>${cls.name}</strong> beitreten?</p>
      <p class="muted">Lehrkraft: ${teachers.map((t) => t.name).join(', ')}</p>
      <form method="post" action="/beitreten/${req.params.code}">${csrfField(req)}<button class="btn primary big">Ja, beitreten</button></form>
      <p class="muted">Deine Lehrkraft sieht dann deinen Namen und deine Ergebnisse in den Apps dieser Klasse.</p></section>`;
    res.send(page(req, { title: 'Klasse beitreten', body }));
  });

  app.post('/beitreten/:code', (req, res) => {
    const { row, cls } = findCode(req);
    // The code decides the membership (access.joinRoleFor): a class code always
    // makes a student, a co-teacher invitation works only for staff accounts.
    const role = access.joinRoleFor(req.user, row);
    if (!role) throw bad('Mit diesem Link kannst du dieser Klasse nicht beitreten.');
    const added = db.run('INSERT OR IGNORE INTO class_members (class_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)', cls.id, req.user.id, role, Date.now());
    if (added.changes) {
      services.audit(req.user, 'klasse_beigetreten', cls.name);
      flash(req, `Willkommen in „${cls.name}“!`);
    }
    res.redirect(303, `/klassen/${cls.id}`);
  });

  // ---------- apps in a class ----------
  /**
   * Put an app into a class. Who may add what, and whether it is approved at
   * once or waits for review, is decided by access.addToClassMode.
   */
  app.post('/klassen/:id/apps', (req, res) => {
    const cls = viewClass(req);
    const target = db.get('SELECT * FROM apps WHERE id = ?', String(req.body.app || ''));
    const mode = access.addToClassMode(req.user, target, cls.id);
    if (!mode) throw deny();
    const result = ctx.classApps.add(req.user, cls, target, mode);
    flash(req, result === 'approved' ? `„${target.name}“ ist jetzt in der Klasse „${cls.name}“.` : `„${target.name}“ wurde eingereicht. Deine Lehrkraft schaut sie sich an.`);
    res.redirect(303, `/klassen/${cls.id}`);
  });

  const classApp = (cls, appId) =>
    db.get('SELECT ca.*, a.name AS app_name, a.owner_id FROM class_apps ca JOIN apps a ON a.id = ca.app_id WHERE ca.class_id = ? AND ca.app_id = ?', cls.id, String(appId));

  const appRow = (row) => db.get('SELECT * FROM apps WHERE id = ?', row.app_id);

  app.post('/klassen/:id/apps/:aid/freigeben', (req, res) => {
    const cls = manageClass(req);
    const row = classApp(cls, req.params.aid);
    if (!row || !access.canChangeClass(req.user, cls.id)) throw deny();
    // Approve exactly the version that was reviewed (sent by the form, checked against the request).
    ctx.classApps.approve(req.user, cls, appRow(row), String(req.body.version || ''), req.body.notiz);
    flash(req, `„${row.app_name}“ ist für ${cls.name} freigegeben.`);
    res.redirect(303, `/apps/${row.app_id}`);
  });

  /** "Zurückgeben": the teacher sends the waiting version back with a reason the student sees. */
  app.post('/klassen/:id/apps/:aid/ablehnen', (req, res) => {
    const cls = manageClass(req);
    const row = classApp(cls, req.params.aid);
    if (!row || !access.canChangeClass(req.user, cls.id)) throw deny();
    ctx.classApps.giveBack(req.user, cls, appRow(row), String(req.body.version || ''), req.body.grund);
    flash(req, `„${row.app_name}“ wurde zurückgegeben. Deine Begründung steht bei der App.`);
    res.redirect(303, `/apps/${row.app_id}`);
  });

  app.post('/klassen/:id/apps/:aid/entfernen', (req, res) => {
    const cls = viewClass(req);
    const row = classApp(cls, req.params.aid);
    const teacher = access.canChangeClass(req.user, cls.id);
    // The class teacher can remove any app; an owner can withdraw their own.
    if (!row || !(teacher || row.owner_id === req.user.id)) throw deny();
    const a = appRow(row);
    if (!teacher && row.requested_version_id) {
      ctx.classApps.withdraw(req.user, cls, a);
      flash(req, `Die Einreichung von „${a.name}“ ist zurückgezogen.`);
    } else {
      ctx.classApps.remove(req.user, cls, a);
      flash(req, `„${a.name}“ ist nicht mehr in ${cls.name}. Ergebnisse bleiben für die Lehrkraft lesbar.`);
    }
    res.redirect(303, teacher ? `/klassen/${cls.id}` : `/apps/${row.app_id}`);
  });
};
