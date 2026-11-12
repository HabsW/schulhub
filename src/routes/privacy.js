'use strict';
// "Meine Daten": everything the Hub stores about the signed-in person,
// with export and delete. Only ever touches req.user's own rows.

const { html, raw, page, flash, csrfField, postButton, appIcon, jsonView, ROLE_LABEL } = require('../html');
const { deny, bad, formatDate, formatBytes } = require('../util');

module.exports = (app, ctx) => {
  const { db, config, services } = ctx;

  /** Apps in which this user has any data. */
  const myAppData = (userId) =>
    db.all(
      `SELECT a.id, a.name, a.emoji, a.color,
              (SELECT COUNT(*) FROM saves s WHERE s.app_id = a.id AND s.user_id = ?1) AS saves,
              (SELECT COALESCE(SUM(size), 0) FROM saves s WHERE s.app_id = a.id AND s.user_id = ?1) AS bytes,
              (SELECT COUNT(*) FROM results r WHERE r.app_id = a.id AND r.user_id = ?1) AS results,
              (SELECT COUNT(*) FROM scores c WHERE c.app_id = a.id AND c.user_id = ?1) AS scores
         FROM apps a
        WHERE a.id IN (SELECT app_id FROM saves WHERE user_id = ?1 UNION SELECT app_id FROM results WHERE user_id = ?1
                       UNION SELECT app_id FROM scores WHERE user_id = ?1 UNION SELECT app_id FROM plays WHERE user_id = ?1)
        ORDER BY a.name`,
      userId
    );
  const isLastAdmin = (user) => user.role === 'admin' && db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").n <= 1;

  app.get('/meine-daten', (req, res) => {
    const u = req.user;
    const classes = db.all('SELECT c.id, c.name, m.role, m.joined_at FROM class_members m JOIN classes c ON c.id = m.class_id WHERE m.user_id = ? ORDER BY c.name', u.id);
    const data = myAppData(u.id);
    const owned = db.all('SELECT id, name FROM apps WHERE owner_id = ? ORDER BY name', u.id);
    const comments = db.get('SELECT COUNT(*) AS n FROM comments WHERE author_id = ?', u.id).n;
    const body = html`<h1>Meine Daten</h1>
    <p class="lead">Hier siehst du alles, was ${config.hubName} über dich speichert. Du kannst es herunterladen oder löschen.</p>
    <section class="panel"><h2>Konto</h2>
      <table class="data kv"><tbody><tr><th>Name</th><td>${u.name}</td></tr><tr><th>E-Mail</th><td>${u.email}</td></tr>
      <tr><th>Rolle</th><td>${ROLE_LABEL[u.role]}</td></tr><tr><th>Konto angelegt</th><td>${formatDate(u.created_at)}</td></tr>
      <tr><th>Letzte Anmeldung</th><td>${formatDate(u.last_login_at)}</td></tr></tbody></table>
      <p class="muted">Name und E-Mail kommen aus deinem Microsoft-Schulkonto. Ein Passwort speichert ${config.hubName} nicht.</p></section>

    <section class="panel"><h2>Bestenlisten</h2>
      <form method="post" action="/meine-daten/anonym" class="row">${csrfField(req)}
        <label class="check"><input type="checkbox" name="anonym" value="1"${u.anonymous_scores ? raw(' checked') : ''}> In Bestenlisten als „Anonym“ erscheinen</label>
        <button class="btn">Speichern</button></form></section>

    <section class="panel"><h2>Klassen</h2>
      ${classes.length ? classes.map((c) => html`<div class="rowline"><span class="grow"><a href="/klassen/${c.id}"><strong>${c.name}</strong></a>
        <small>${c.role === 'teacher' ? 'Lehrkraft' : 'Schüler/in'} · seit ${formatDate(c.joined_at)}</small></span>
        ${c.role === 'student' ? postButton(req, `/klassen/${c.id}/verlassen`, 'Verlassen', { cls: 'btn small ghost', confirm: `„${c.name}“ verlassen?` }) : ''}</div>`)
        : html`<p class="muted">Du bist in keiner Klasse.</p>`}</section>

    <section class="panel"><h2>Daten in Apps</h2>
      ${data.length ? data.map((a) => html`<div class="rowline">${appIcon(a, 'sm')}<span class="grow"><strong>${a.name}</strong>
        <small>${a.saves} Spielstände (${formatBytes(a.bytes)}) · ${a.results} Ergebnisse · ${a.scores} Bestwerte</small></span>
        <a class="btn small" href="/meine-daten/app/${a.id}">Ansehen</a>
        ${postButton(req, `/meine-daten/app/${a.id}/loeschen`, 'Löschen', { cls: 'btn small ghost', confirm: `Alle deine Daten in „${a.name}“ löschen? Dein Fortschritt dort ist dann weg.` })}</div>`)
        : html`<p class="muted">Noch keine App hat etwas für dich gespeichert.</p>`}</section>

    <section class="panel"><h2>Eigene Apps und Kommentare</h2>
      <p>${owned.length ? html`Du besitzt ${owned.length} App${owned.length === 1 ? '' : 's'}: ${owned.map((a, i) => html`${i ? ', ' : ''}<a href="/apps/${a.id}">${a.name}</a>`)}.` : 'Du besitzt keine Apps.'}
      Du hast ${comments} Kommentar${comments === 1 ? '' : 'e'} geschrieben.</p></section>

    <section class="panel"><h2>Alles herunterladen</h2>
      <p>Eine Datei mit allen Daten, die zu deinem Konto gespeichert sind.</p>
      <p><a class="btn" href="/meine-daten/export">Meine Daten herunterladen (JSON)</a></p></section>

    <section class="panel quiet"><h2>Konto löschen</h2>
      <p>Löscht dein Konto mit allen Spielständen, Ergebnissen, Kommentaren und deinen eigenen Apps. Das kann nicht rückgängig gemacht werden.
      Wenn du dich später wieder anmeldest, beginnst du mit einem leeren Konto.</p>
      ${isLastAdmin(u) ? html`<p class="muted">Du bist der einzige Admin. Ernenne zuerst einen weiteren Admin.</p>`
        : html`<form method="post" action="/meine-daten/konto-loeschen" class="row" data-confirm="Dein Konto wirklich endgültig löschen?">${csrfField(req)}
          <label>Tippe zur Bestätigung LÖSCHEN<input name="bestaetigung" autocomplete="off" required></label><button class="btn danger">Konto endgültig löschen</button></form>`}</section>`;
    res.send(page(req, { title: 'Meine Daten', body }));
  });

  app.get('/meine-daten/app/:aid', (req, res) => {
    const a = db.get('SELECT id, name, emoji, color FROM apps WHERE id = ?', String(req.params.aid));
    if (!a) throw deny();
    const u = req.user;
    const parse = (t) => {
      try {
        return JSON.parse(t);
      } catch {
        return t;
      }
    };
    const saves = db.all('SELECT key, value, updated_at FROM saves WHERE app_id = ? AND user_id = ? ORDER BY key', a.id, u.id);
    const results = db.all('SELECT title, score, max_score, details, created_at FROM results WHERE app_id = ? AND user_id = ? ORDER BY id DESC LIMIT 200', a.id, u.id);
    const scores = db.all('SELECT board, score FROM scores WHERE app_id = ? AND user_id = ?', a.id, u.id);
    const body = html`<p class="crumbs"><a href="/meine-daten">Meine Daten</a> ›</p><div class="apphead">${appIcon(a, 'lg')}<h1>Meine Daten in ${a.name}</h1></div>
      <section><h2>Spielstände</h2>${saves.length ? saves.map((s) => html`<details class="result"><summary><strong>${s.key}</strong> <span class="muted">${formatDate(s.updated_at)}</span></summary>${jsonView(parse(s.value))}</details>`) : html`<p class="muted">Keine.</p>`}</section>
      <section><h2>Ergebnisse</h2>${results.length ? results.map((r) => html`<details class="result"><summary><strong>${r.title}</strong> ${r.score === null ? '' : html`<span class="badge">${r.score}${r.max_score === null ? '' : ` / ${r.max_score}`}</span>`} <span class="muted">${formatDate(r.created_at)}</span></summary>${r.details ? jsonView(parse(r.details)) : ''}</details>`) : html`<p class="muted">Keine.</p>`}</section>
      <section><h2>Bestwerte</h2>${scores.length ? html`<table class="data kv"><tbody>${scores.map((s) => html`<tr><th>${s.board}</th><td>${s.score}</td></tr>`)}</tbody></table>` : html`<p class="muted">Keine.</p>`}</section>`;
    res.send(page(req, { title: `Meine Daten in ${a.name}`, body }));
  });

  app.post('/meine-daten/app/:aid/loeschen', (req, res) => {
    services.deleteAppData(String(req.params.aid), req.user.id);
    flash(req, 'Deine Daten in dieser App wurden gelöscht.');
    res.redirect(303, '/meine-daten');
  });

  app.post('/meine-daten/anonym', (req, res) => {
    db.run('UPDATE users SET anonymous_scores = ? WHERE id = ?', req.body.anonym === '1' ? 1 : 0, req.user.id);
    flash(req, 'Gespeichert.');
    res.redirect(303, '/meine-daten');
  });

  app.get('/meine-daten/export', (req, res) => {
    const u = req.user;
    const json = (t) => {
      try {
        return JSON.parse(t);
      } catch {
        return t;
      }
    };
    const out = {
      erstellt: new Date().toISOString(),
      konto: { name: u.name, email: u.email, rolle: u.role, angelegt: new Date(u.created_at).toISOString(), letzteAnmeldung: u.last_login_at ? new Date(u.last_login_at).toISOString() : null, anonymInBestenlisten: Boolean(u.anonymous_scores) },
      klassen: db.all('SELECT c.name, m.role AS rolle, m.joined_at AS seit FROM class_members m JOIN classes c ON c.id = m.class_id WHERE m.user_id = ?', u.id),
      eigeneApps: db.all('SELECT name, description AS beschreibung, created_at AS angelegt FROM apps WHERE owner_id = ?', u.id),
      kommentare: db.all('SELECT a.name AS app, c.body AS text, c.created_at AS zeitpunkt FROM comments c JOIN apps a ON a.id = c.app_id WHERE c.author_id = ?', u.id),
      appDaten: myAppData(u.id).map((a) => ({
        app: a.name,
        spielstaende: db.all('SELECT key, value, updated_at FROM saves WHERE app_id = ? AND user_id = ?', a.id, u.id).map((s) => ({ schluessel: s.key, wert: json(s.value), geaendert: s.updated_at })),
        ergebnisse: db.all('SELECT title, score, max_score, details, created_at FROM results WHERE app_id = ? AND user_id = ?', a.id, u.id).map((r) => ({ titel: r.title, punkte: r.score, maximal: r.max_score, einzelheiten: r.details ? json(r.details) : null, zeitpunkt: r.created_at })),
        bestwerte: db.all('SELECT board AS liste, score AS wert FROM scores WHERE app_id = ? AND user_id = ?', a.id, u.id),
        nutzung: db.get('SELECT first_at AS zuerst, last_at AS zuletzt, count AS anzahl FROM plays WHERE app_id = ? AND user_id = ?', a.id, u.id) || null,
      })),
    };
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="meine-daten.json"');
    res.send(JSON.stringify(out, null, 2));
  });

  app.post('/meine-daten/konto-loeschen', (req, res) => {
    if (String(req.body.bestaetigung || '').trim().toUpperCase() !== 'LÖSCHEN') throw bad('Bitte tippe zur Bestätigung das Wort LÖSCHEN.');
    if (isLastAdmin(req.user)) throw bad('Der einzige Admin kann sein Konto nicht löschen.');
    services.deleteUser(req.user, req.user);
    req.session.destroy(() => res.redirect(303, '/'));
  });
};
