'use strict';
// Teacher review of what students did in an app. This works for EVERY app,
// because all app data goes through the Hub - app authors build nothing for it.
// Everything shown here was written by students or apps: it is always output
// as escaped plain text.

const { html, page, flash, postButton, appIcon, jsonView } = require('../html');
const { deny, formatDate } = require('../util');

/** Guard spreadsheet formulas and quote for CSV. */
function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

module.exports = (app, ctx) => {
  const { db, access, services } = ctx;

  /** Class teacher (or admin) + app approved in exactly this class, else 404. */
  function load(req) {
    const cls = db.get('SELECT * FROM classes WHERE id = ?', String(req.params.id));
    if (!cls || !access.canManageClass(req.user, cls.id)) throw deny();
    const a = db.get(
      "SELECT a.* FROM apps a JOIN class_apps ca ON ca.app_id = a.id WHERE a.id = ? AND ca.class_id = ? AND ca.status = 'approved'",
      String(req.params.aid), cls.id
    );
    if (!a) throw deny();
    return { cls, a };
  }
  const students = (cls, a) =>
    db.all(
      `SELECT u.id, u.name,
              (SELECT last_at FROM plays p WHERE p.app_id = ? AND p.user_id = u.id) AS last_at,
              (SELECT count FROM plays p WHERE p.app_id = ? AND p.user_id = u.id) AS opens,
              (SELECT COUNT(*) FROM results r WHERE r.app_id = ? AND r.user_id = u.id) AS results,
              (SELECT COUNT(*) FROM saves s WHERE s.app_id = ? AND s.user_id = u.id) AS saves
         FROM class_members m JOIN users u ON u.id = m.user_id
        WHERE m.class_id = ? AND m.role = 'student' ORDER BY u.name`,
      a.id, a.id, a.id, a.id, cls.id
    );
  const scoreText = (r) => (r.score === null ? '' : r.max_score === null ? String(r.score) : `${r.score} / ${r.max_score}`);

  app.get('/klassen/:id/apps/:aid/ergebnisse', (req, res) => {
    const { cls, a } = load(req);
    const list = students(cls, a);
    const latest = (uid) => db.get('SELECT title, score, max_score, created_at FROM results WHERE app_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1', a.id, uid);
    const body = html`<p class="crumbs"><a href="/klassen/${cls.id}">${cls.name}</a> ›</p>
      <div class="apphead">${appIcon(a, 'lg')}<div><h1>Ergebnisse: ${a.name}</h1><p class="muted">${cls.name} · ${list.length} Schüler/innen</p></div></div>
      ${list.length ? html`<div class="scroll"><table class="data"><thead><tr><th>Name</th><th>Zuletzt geöffnet</th><th>Geöffnet</th><th>Ergebnisse</th><th>Letztes Ergebnis</th><th></th></tr></thead><tbody>
        ${list.map((s) => {
          const r = latest(s.id);
          return html`<tr><td><strong>${s.name}</strong></td><td>${s.last_at ? formatDate(s.last_at) : html`<span class="muted">noch nie</span>`}</td>
            <td>${s.opens || 0}×</td><td>${s.results}</td><td>${r ? html`${r.title} <strong>${scoreText(r)}</strong>` : html`<span class="muted">–</span>`}</td>
            <td class="right"><a class="btn small" href="/klassen/${cls.id}/apps/${a.id}/ergebnisse/${s.id}">Ansehen</a></td></tr>`;
        })}</tbody></table></div>
        <p><a class="btn" href="/klassen/${cls.id}/apps/${a.id}/ergebnisse.csv">Als Tabelle herunterladen (CSV)</a></p>`
        : html`<div class="empty"><p>In dieser Klasse sind noch keine Schüler/innen.</p></div>`}`;
    res.send(page(req, { title: `Ergebnisse ${a.name}`, body, active: 'klassen' }));
  });

  app.get('/klassen/:id/apps/:aid/ergebnisse.csv', (req, res) => {
    const { cls, a } = load(req);
    const rows = db.all(
      `SELECT u.name, r.title, r.score, r.max_score, r.created_at FROM results r JOIN users u ON u.id = r.user_id
         JOIN class_members m ON m.user_id = r.user_id AND m.class_id = ? AND m.role = 'student'
        WHERE r.app_id = ? ORDER BY u.name, r.id`,
      cls.id, a.id
    );
    const lines = [['Name', 'Ergebnis', 'Punkte', 'Maximal', 'Zeitpunkt'].map(csvCell).join(';')];
    for (const r of rows) lines.push([r.name, r.title, r.score, r.max_score, formatDate(r.created_at)].map(csvCell).join(';'));
    services.audit(req.user, 'ergebnisse_exportiert', a.name, cls.name);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="ergebnisse.csv"');
    res.send(`﻿${lines.join('\r\n')}\r\n`);
  });

  /** One student. Checked again: student in this class AND app approved in this class. */
  function loadStudent(req) {
    const { cls, a } = load(req);
    const uid = String(req.params.uid);
    if (!access.canSeeStudentData(req.user, cls.id, a.id, uid)) throw deny();
    return { cls, a, student: db.get('SELECT id, name FROM users WHERE id = ?', uid) };
  }

  app.get('/klassen/:id/apps/:aid/ergebnisse/:uid', (req, res) => {
    const { cls, a, student } = loadStudent(req);
    const results = db.all('SELECT * FROM results WHERE app_id = ? AND user_id = ? ORDER BY id DESC LIMIT 200', a.id, student.id);
    const saves = db.all('SELECT key, value, size, updated_at FROM saves WHERE app_id = ? AND user_id = ? ORDER BY key', a.id, student.id);
    const scores = db.all('SELECT board, score, updated_at FROM scores WHERE app_id = ? AND user_id = ? ORDER BY board', a.id, student.id);
    const parse = (text) => {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    };
    const body = html`<p class="crumbs"><a href="/klassen/${cls.id}">${cls.name}</a> › <a href="/klassen/${cls.id}/apps/${a.id}/ergebnisse">Ergebnisse: ${a.name}</a> ›</p>
      <h1>${student.name}</h1>
      <section><h2>Ergebnisse</h2>
      ${results.length ? results.map((r) => html`<details class="result"><summary><strong>${r.title}</strong> ${scoreText(r) ? html`<span class="badge">${scoreText(r)}</span>` : ''}
        <span class="muted">${formatDate(r.created_at)}</span></summary>${r.details ? jsonView(parse(r.details)) : html`<p class="muted">Keine Einzelheiten.</p>`}</details>`)
        : html`<p class="muted">Noch keine Ergebnisse.</p>`}</section>
      ${scores.length ? html`<section><h2>Bestenlisten</h2><table class="data"><thead><tr><th>Liste</th><th>Bestwert</th><th>Erreicht</th></tr></thead><tbody>
        ${scores.map((s) => html`<tr><td>${s.board}</td><td>${s.score}</td><td>${formatDate(s.updated_at)}</td></tr>`)}</tbody></table></section>` : ''}
      <section><h2>Spielstände</h2>
      ${saves.length ? saves.map((s) => html`<details class="result"><summary><strong>${s.key}</strong> <span class="muted">${formatDate(s.updated_at)}</span></summary>${jsonView(parse(s.value))}</details>`)
        : html`<p class="muted">Keine Spielstände.</p>`}</section>
      <section class="panel quiet"><h2>Zurücksetzen</h2><p>Löscht alle Ergebnisse, Spielstände und Bestwerte von ${student.name} in dieser App.</p>
        ${postButton(req, `/klassen/${cls.id}/apps/${a.id}/ergebnisse/${student.id}/loeschen`, 'Daten in dieser App löschen', { cls: 'btn danger', confirm: `Alle Daten von ${student.name} in „${a.name}“ löschen?` })}</section>`;
    res.send(page(req, { title: student.name, body, active: 'klassen' }));
  });

  app.post('/klassen/:id/apps/:aid/ergebnisse/:uid/loeschen', (req, res) => {
    const { cls, a, student } = loadStudent(req);
    services.deleteAppData(a.id, student.id);
    services.audit(req.user, 'appdaten_zurueckgesetzt', a.name, cls.name);
    flash(req, `Die Daten von ${student.name} in „${a.name}“ wurden gelöscht.`);
    res.redirect(303, `/klassen/${cls.id}/apps/${a.id}/ergebnisse`);
  });
};
