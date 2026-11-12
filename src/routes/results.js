'use strict';
// Results of one app in one class (package A): the students' table with a
// filter and a weekly chart, one student's details (readable with the labels
// from the app's schulhub.json), the CSV export and the reset. This works for
// EVERY app, because all app data goes through the Hub - app authors build
// nothing for it. Only results recorded in this class are shown
// (class_id = this class, or NULL for results from before classes were recorded).
// Everything shown here was written by students or apps: it is always output
// as escaped plain text.

const {
  html, page, flash, postButton, linkButton, pageHead, sectionHead, stats, stat, meter, badge, notice, empty,
  dataTable, icon,
} = require('../html');
const { deny, formatDate, formatAgo, dayKey } = require('../util');
const { manifestOf } = require('../manifest');
const kit = require('../teachingKit');

/** Guard spreadsheet formulas and quote for CSV. */
function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
/** Numbers the way German spreadsheets read them. */
const csvNumber = (n) => (typeof n === 'number' && Number.isFinite(n) ? String(n).replace('.', ',') : '');

/** ASCII part of a file name: "7b Englisch" -> "7b-englisch". */
function slug(s) {
  return (
    String(s || '')
      .toLowerCase()
      .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
      .normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'klasse'
  );
}

// Numbers and their units never break apart ("100 %", "8 / 8"): non-breaking spaces.
const NB = '\u00a0';
const scoreText = (score, max) => (score === null || score === undefined ? '' : max === null || max === undefined ? String(score) : `${score}${NB}/${NB}${max}`);
const pctText = (v) => (v === null || v === undefined ? '' : `${Math.round(Math.max(0, Math.min(1, v)) * 100)}${NB}%`);

/** A key without a label from schulhub.json, made readable: "richtig-gesamt" -> "Richtig gesamt", "maxScore" -> "Max Score". */
function readableKey(k) {
  const s = String(k).replace(/([a-zäöüß])([A-ZÄÖÜ])/g, '$1 $2').replace(/[_\-.:]+/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : String(k);
}

/** The label from schulhub.json for a key, else the key made readable. */
const labelFor = (labels, k) => (labels && Object.hasOwn(labels, k) && typeof labels[k] === 'string' ? labels[k] : readableKey(k));

/**
 * Result details as readable text: keys get the labels from schulhub.json,
 * true/false become ✓/✗. Lists of flat objects become a table (records on
 * phones). Nothing is ever interpreted as HTML.
 */
function detailView(value, labels, depth = 0) {
  const name = (k) => labelFor(labels, k);
  const flat = (o) => o && typeof o === 'object' && !Array.isArray(o) && Object.values(o).every((v) => v === null || typeof v !== 'object');
  const cell = (v) =>
    v === true
      ? html`<span class="teach-yes">✓<span class="visually-hidden"> ja</span></span>`
      : v === false
        ? html`<span class="teach-no">✗<span class="visually-hidden"> nein</span></span>`
        : v === null || v === undefined
          ? ''
          : String(v);
  if (depth > 2) return html`<pre class="code">${JSON.stringify(value, null, 2)}</pre>`;
  if (Array.isArray(value) && value.length > 0 && value.length <= 500 && value.every(flat)) {
    const cols = [...new Set(value.flatMap((o) => Object.keys(o)))].slice(0, 12);
    return dataTable({ cls: 'teach-details', columns: cols.map((c, i) => ({ label: name(c), primary: i === 0, render: (o) => cell(o[c]) })), rows: value });
  }
  if (Array.isArray(value) && value.every((v) => v === null || typeof v !== 'object')) {
    if (value.length > 40) return html`<pre class="code">${JSON.stringify(value)}</pre>`;
    return html`<p>${value.length ? value.map((v, i) => html`${i ? ', ' : ''}${cell(v)}`) : '–'}</p>`;
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length <= 40) {
    return html`<dl class="kv">${Object.entries(value).map(([k, v]) => html`<div><dt>${name(k)}</dt><dd>${v !== null && typeof v === 'object' ? detailView(v, labels, depth + 1) : cell(v)}</dd></div>`)}</dl>`;
  }
  if (value === null || typeof value !== 'object') return html`<p>${cell(value)}</p>`;
  return html`<pre class="code">${JSON.stringify(value, null, 2)}</pre>`;
}

const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

module.exports = (app, ctx) => {
  const { db, access, services } = ctx;

  /** Teacher of the class (or admin) + app approved in this class or removed from it (access.canSeeClassResults), else 404. */
  function load(req) {
    const cls = db.get('SELECT * FROM classes WHERE id = ?', String(req.params.id));
    const a = db.get('SELECT * FROM apps WHERE id = ?', String(req.params.aid));
    if (!cls || !a || !access.canSeeClassResults(req.user, cls.id, a.id)) throw deny();
    const ca = db.get('SELECT status, version_id FROM class_apps WHERE class_id = ? AND app_id = ?', cls.id, a.id);
    // Labels and settings come from the version the class uses (or used).
    const version = ca.version_id ? db.get('SELECT manifest FROM app_versions WHERE id = ?', ca.version_id) : null;
    return { cls, a, ca, manifest: manifestOf(version) };
  }

  /** All students of the class with their numbers in this app - one query. */
  const studentRows = (cls, a) =>
    db.all(
      `WITH cr AS (
         SELECT r.id, r.user_id, r.title, r.score, r.max_score, r.created_at,
                ROW_NUMBER() OVER (PARTITION BY r.user_id ORDER BY r.id DESC) AS rn
           FROM results r JOIN class_members m ON m.user_id = r.user_id AND m.class_id = ? AND m.role = 'student'
          WHERE r.app_id = ? AND (r.class_id = ? OR r.class_id IS NULL)
       ), agg AS (
         SELECT user_id, COUNT(*) AS n, MAX(CASE WHEN max_score > 0 THEN score * 1.0 / max_score END) AS best FROM cr GROUP BY user_id
       )
       SELECT u.id, u.name, agg.n AS results, agg.best,
              l.title AS last_title, l.score AS last_score, l.max_score AS last_max, l.created_at AS last_result_at,
              p.value AS progress, p.label AS progress_label, p.updated_at AS progress_at, pl.last_at AS played_at
         FROM class_members m JOIN users u ON u.id = m.user_id
         LEFT JOIN agg ON agg.user_id = u.id
         LEFT JOIN cr AS l ON l.user_id = u.id AND l.rn = 1
         LEFT JOIN progress p ON p.app_id = ? AND p.user_id = u.id
         LEFT JOIN plays pl ON pl.app_id = ? AND pl.user_id = u.id
        WHERE m.class_id = ? AND m.role = 'student'
        ORDER BY u.name COLLATE NOCASE LIMIT 300`,
      cls.id, a.id, cls.id, a.id, a.id, cls.id
    ).map((s) => ({
      ...s,
      started: Boolean(s.results || s.progress !== null || s.played_at),
      active_at: Math.max(s.last_result_at || 0, s.played_at || 0, s.progress_at || 0) || null,
    }));

  app.get('/klassen/:id/apps/:aid/ergebnisse', (req, res) => {
    const { cls, a, ca, manifest } = load(req);
    const base = `/klassen/${cls.id}/apps/${a.id}/ergebnisse`;
    const change = access.canChangeClass(req.user, cls.id);
    const approved = ca.status === 'approved';
    const all = studentRows(cls, a);
    const filter = req.query.filter === 'offen' ? 'offen' : '';
    const shown = filter ? all.filter((s) => !s.started) : all;
    const started = all.filter((s) => s.started).length;
    const wk = kit.weeks(8);
    const perWeek = db.get(
      `SELECT COUNT(*) AS total, ${kit.weekSums('r.created_at', wk.length)} FROM results r
         JOIN class_members m ON m.user_id = r.user_id AND m.class_id = ? AND m.role = 'student'
        WHERE r.app_id = ? AND (r.class_id = ? OR r.class_id IS NULL)`,
      ...kit.weekParams(wk), cls.id, a.id, cls.id
    );
    const bars = kit.weekBars(wk, perWeek);
    const bests = all.filter((s) => s.best !== null).map((s) => s.best);
    const average = bests.length ? bests.reduce((x, y) => x + y, 0) / bests.length : null;
    const hasSettings = manifest.settings.length > 0;

    const table = dataTable({
      cls: 'teach-results',
      columns: [
        { label: 'Name', primary: true, render: (s) => html`<a href="${base}/${s.id}">${s.name}</a>` },
        { label: 'Letztes Ergebnis', render: (s) => (s.last_title ? html`${s.last_title}${s.last_score !== null ? html` <span class="faint teach-nowrap">${scoreText(s.last_score, s.last_max)}</span>` : ''}` : '') },
        { label: 'Bestes', num: true, render: (s) => pctText(s.best) },
        { label: 'Ergebnisse', num: true, render: (s) => (s.results ? String(s.results) : '') },
        { label: 'Fortschritt', render: (s) => (s.progress === null ? '' : html`<span class="teach-prog">${meter(s.progress, { label: `${pctText(s.progress)} geschafft` })}<span class="num">${pctText(s.progress)}</span></span>`) },
        { label: 'Zuletzt aktiv', render: (s) => (s.active_at ? html`<span class="teach-nowrap">${formatAgo(s.active_at)}</span>` : html`<span class="faint teach-nowrap">noch nie</span>`) },
      ],
      rows: shown,
      empty: filter
        ? empty({ icon: 'checkCircle', title: 'Alle haben begonnen', text: 'Jede Person in der Klasse hat diese App schon geöffnet.', actions: linkButton(base, 'Alle zeigen', { kind: 'quiet' }) })
        : empty({ icon: 'userPlus', title: 'Noch keine Schüler/innen', text: 'Wer der Klasse beitritt, erscheint hier mit seinen Ergebnissen.' }),
    });

    const body = html`${pageHead({
      crumbs: [['/klassen', 'Klassen'], [`/klassen/${cls.id}/apps`, cls.name]],
      eyebrow: `Ergebnisse · ${cls.name}`,
      title: a.name,
      app: a,
      meta: html`<span>${kit.studentsText(all.length)}</span>${approved ? '' : badge('aus der Klasse entfernt')}`,
      actions: html`${linkButton(`${base}.csv`, 'CSV herunterladen', { icon: 'download' })}
        ${change && approved ? linkButton(`/klassen/${cls.id}/aufgaben/neu?app=${a.id}`, 'Aufgabe stellen', { kind: 'quiet', icon: 'tasks' }) : ''}
        ${change && approved && hasSettings ? linkButton(`/klassen/${cls.id}/apps/${a.id}/einstellungen`, 'Einstellungen', { kind: 'quiet', icon: 'sliders' }) : ''}`,
    })}
    ${approved ? '' : notice({
      tone: 'wait',
      icon: 'archive',
      title: 'Nicht mehr in der Klasse',
      text: 'Die Klasse kann diese App nicht mehr öffnen. Die Ergebnisse bleiben für dich lesbar.',
      actions: change ? postButton(req, `/klassen/${cls.id}/apps/${a.id}/zurueckholen`, 'Zurückholen', { size: 'sm', icon: 'undo' }) : '',
      cls: 'mb-6',
    })}
    <div class="grid-2 even section">
      <section aria-label="Zahlen"><div class="stats teach-stats2">${[
        stat({ label: 'Begonnen', value: started, sub: `von ${all.length}` }),
        stat({ label: 'Ergebnisse', value: perWeek.total || 0, sub: 'in dieser Klasse' }),
        stat({ label: 'Diese Woche', value: bars[bars.length - 1].value, sub: `Vorwoche: ${bars[bars.length - 2].value}` }),
        stat({ label: 'Bestes im Schnitt', value: average === null ? '–' : pctText(average), sub: average === null ? 'noch keine Punkte' : 'mit Punkten' }),
      ]}</div></section>
      <section aria-labelledby="s-week"><h2 class="visually-hidden" id="s-week">Ergebnisse pro Woche</h2>
        <div class="panel teach-chartpanel"><span class="teach-charttitle">Ergebnisse pro Kalenderwoche</span>${kit.weekChart(bars, `Ergebnisse pro Woche in ${a.name}, ${cls.name}`)}</div></section>
    </div>
    <section class="section" aria-labelledby="s-people">${sectionHead('Schüler/innen', { id: 's-people' })}
      <div class="teach-filterbar"><nav class="teach-seg" aria-label="Filter"><a href="${base}"${filter ? '' : html` aria-current="page"`}>Alle <span class="teach-seg-n">${all.length}</span></a><a href="${base}?filter=offen"${filter ? html` aria-current="page"` : ''}>Nicht begonnen <span class="teach-seg-n">${all.length - started}</span></a></nav></div>
      ${table}</section>`;
    res.send(page(req, { title: `Ergebnisse ${a.name}`, body, active: 'klassen', classId: cls.id, styles: ['css/teaching.css'] }));
  });

  app.get('/klassen/:id/apps/:aid/ergebnisse.csv', (req, res) => {
    const { cls, a } = load(req);
    const people = studentRows(cls, a);
    const byUser = new Map();
    for (const r of db.all(
      `SELECT r.user_id, r.title, r.score, r.max_score, r.created_at FROM results r
         JOIN class_members m ON m.user_id = r.user_id AND m.class_id = ? AND m.role = 'student'
        WHERE r.app_id = ? AND (r.class_id = ? OR r.class_id IS NULL) ORDER BY r.id`,
      cls.id, a.id, cls.id
    )) {
      if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
      byUser.get(r.user_id).push(r);
    }
    const lines = [['Name', 'Ergebnis', 'Punkte', 'Maximal', 'Prozent', 'Zeitpunkt', 'Fortschritt (Prozent)'].map(csvCell).join(';')];
    for (const s of people) {
      const progress = s.progress === null ? '' : String(Math.round(Math.max(0, Math.min(1, s.progress)) * 100));
      const rows = byUser.get(s.id) || [];
      if (!rows.length) lines.push([s.name, '', '', '', '', '', progress].map(csvCell).join(';'));
      for (const r of rows) {
        const pct = kit.percentOf(r.score, r.max_score);
        lines.push([s.name, r.title, csvNumber(r.score), csvNumber(r.max_score), pct === null ? '' : String(pct), formatDate(r.created_at), progress].map(csvCell).join(';'));
      }
    }
    services.audit(req.user, 'ergebnisse_exportiert', a.name, cls.name);
    const file = `ergebnisse-${slug(cls.name)}-${slug(a.name)}-${dayKey(Date.now())}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(`﻿${lines.join('\r\n')}\r\n`);
  });

  /** One student. Checked again: student in this class AND app approved (or removed) in this class. */
  function loadStudent(req) {
    const loaded = load(req);
    const uid = String(req.params.uid);
    if (!access.canSeeStudentData(req.user, loaded.cls.id, loaded.a.id, uid)) throw deny();
    return { ...loaded, student: db.get('SELECT id, name FROM users WHERE id = ?', uid) };
  }

  app.get('/klassen/:id/apps/:aid/ergebnisse/:uid', (req, res) => {
    const { cls, a, ca, manifest, student } = loadStudent(req);
    const listUrl = `/klassen/${cls.id}/apps/${a.id}/ergebnisse`;
    const here = `${listUrl}/${student.id}`;
    const labels = (manifest.results && manifest.results.labels) || {};
    const results = db.all('SELECT * FROM results WHERE app_id = ? AND user_id = ? AND (class_id = ? OR class_id IS NULL) ORDER BY created_at DESC, id DESC LIMIT 200', a.id, student.id, cls.id);
    const saves = db.all('SELECT key, value, size, updated_at FROM saves WHERE app_id = ? AND user_id = ? ORDER BY key LIMIT 200', a.id, student.id);
    const scores = db.all('SELECT board, score, updated_at FROM scores WHERE app_id = ? AND user_id = ? ORDER BY board', a.id, student.id);
    const progress = db.get('SELECT value, label, updated_at FROM progress WHERE app_id = ? AND user_id = ?', a.id, student.id);
    const played = db.get('SELECT first_at, last_at, count FROM plays WHERE app_id = ? AND user_id = ?', a.id, student.id);
    const unlocked = new Map(db.all('SELECT achievement, unlocked_at FROM achievements WHERE app_id = ? AND user_id = ?', a.id, student.id).map((r) => [r.achievement, r.unlocked_at]));
    const peers = db.all("SELECT u.id, u.name FROM class_members m JOIN users u ON u.id = m.user_id WHERE m.class_id = ? AND m.role = 'student' ORDER BY u.name COLLATE NOCASE LIMIT 300", cls.id);
    const at = peers.findIndex((p) => p.id === student.id);
    const prev = at > 0 ? peers[at - 1] : null;
    const next = at >= 0 && at < peers.length - 1 ? peers[at + 1] : null;
    const feedback = db
      .all(
        `SELECT f.*, u.name AS author_name, s.name AS student_name, ap.name AS app_name, x.title AS assignment_title FROM feedback f
           LEFT JOIN users u ON u.id = f.author_id LEFT JOIN users s ON s.id = f.student_id
           LEFT JOIN apps ap ON ap.id = f.app_id LEFT JOIN assignments x ON x.id = f.assignment_id
          WHERE f.class_id = ? AND f.student_id = ? ORDER BY f.created_at DESC LIMIT 20`,
        cls.id, student.id
      )
      .filter((f) => access.canReadFeedback(req.user, f));
    const canFeedback = access.canGiveFeedback(req.user, cls.id, student.id);
    const change = access.canChangeClass(req.user, cls.id);
    const best = results.map((r) => kit.percentOf(r.score, r.max_score)).filter((p) => p !== null);
    const lastActive = Math.max(played ? played.last_at : 0, results[0] ? results[0].created_at : 0, progress ? progress.updated_at : 0) || null;

    // One compact group: previous, next, position - nothing floats alone, names are never cut short.
    const pager = peers.length > 1
      ? html`<nav class="teach-pager" aria-label="Andere Schüler/innen dieser Klasse">
          ${prev ? html`<a class="btn sm teach-pager-btn" href="${listUrl}/${prev.id}" rel="prev" aria-label="Vorherige Person: ${prev.name}">${icon('chevronLeft')}<span>${prev.name}</span></a>` : ''}
          ${next ? html`<a class="btn sm teach-pager-btn" href="${listUrl}/${next.id}" rel="next" aria-label="Nächste Person: ${next.name}"><span>${next.name}</span>${icon('chevronRight')}</a>` : ''}
          <span class="meta teach-pager-pos">${at + 1} von ${peers.length}</span></nav>`
      : '';

    const achievements = manifest.achievements || [];
    const body = html`${pageHead({
      crumbs: [['/klassen', 'Klassen'], [`/klassen/${cls.id}`, cls.name], [listUrl, a.name]],
      eyebrow: `${a.name} · ${cls.name}`,
      title: student.name,
      meta: html`<span>${lastActive ? `zuletzt aktiv ${formatAgo(lastActive)}` : 'noch nie aktiv'}</span>${played ? html`<span>${played.count}× geöffnet</span>` : ''}${ca.status === 'approved' ? '' : badge('App aus der Klasse entfernt')}`,
      actions: canFeedback ? linkButton('#rueckmeldung', 'Rückmeldung geben', { icon: 'message' }) : '',
    })}
    ${pager}
    <section class="section" aria-label="Zahlen">${stats([
      stat({ label: 'Ergebnisse', value: results.length, sub: 'in dieser Klasse' }),
      stat({ label: 'Bestes Ergebnis', value: best.length ? `${Math.max(...best)}${NB}%` : '–' }),
      stat({ label: progress && progress.label ? progress.label : 'Fortschritt', value: progress ? pctText(progress.value) : '–', sub: progress ? formatAgo(progress.updated_at) : '' }),
      stat({ label: 'Erfolge', value: achievements.length ? `${achievements.filter((x) => unlocked.has(x.id)).length}/${achievements.length}` : '–' }),
    ])}</section>
    <div class="grid-2 section">
      <div>
        <section class="section" aria-labelledby="s-results">${sectionHead('Ergebnisse', { id: 's-results', count: results.length ? String(results.length) : null })}
          ${results.length
            ? html`<div class="teach-resultlist">${results.map((r) => {
                const p = kit.percentOf(r.score, r.max_score);
                return html`<details class="disclosure teach-result"><summary><span class="teach-result-title"><strong>${r.title}</strong><span class="meta">${formatDate(r.created_at)}</span></span>
                  ${r.score !== null ? badge(html`${scoreText(r.score, r.max_score)}${p !== null ? ` · ${p}${NB}%` : ''}`) : ''}</summary>
                  <div class="disclosure-body">${r.details ? detailView(parse(r.details), labels) : html`<p class="meta">Keine Einzelheiten gespeichert.</p>`}</div></details>`;
              })}</div>`
            : empty({ icon: 'chart', title: 'Noch keine Ergebnisse', text: `${student.name} hat in dieser Klasse noch kein Ergebnis in „${a.name}“.` })}</section>
        ${achievements.length ? html`<section class="section" aria-labelledby="s-ach">${sectionHead('Erfolge', { id: 's-ach', count: `${achievements.filter((x) => unlocked.has(x.id)).length} von ${achievements.length}` })}
          ${achievements.some((x) => unlocked.has(x.id))
            ? html`<div class="achievement-strip">${achievements.filter((x) => unlocked.has(x.id)).map((x) => html`<span class="achievement" title="${formatDate(unlocked.get(x.id))}"><span class="emoji" aria-hidden="true">${x.emoji}</span>${x.title}</span>`)}</div>`
            : html`<p class="muted">Noch kein Erfolg freigeschaltet.</p>`}</section>` : ''}
        ${scores.length ? html`<section class="section" aria-labelledby="s-scores">${sectionHead('Bestenlisten', { id: 's-scores' })}
          ${dataTable({ columns: [{ label: 'Liste', primary: true, render: (s) => labelFor(labels, s.board) }, { label: 'Bestwert', num: true, render: (s) => String(s.score) }, { label: 'Erreicht', render: (s) => formatDate(s.updated_at) }], rows: scores })}</section>` : ''}
        <section class="section" aria-labelledby="s-saves">${sectionHead('Spielstände', { id: 's-saves', count: saves.length ? String(saves.length) : null })}
          ${saves.length
            ? html`<div>${saves.map((s) => html`<details class="disclosure"><summary><span class="teach-result-title"><strong>${labelFor(labels, s.key)}</strong><span class="meta">${formatDate(s.updated_at)}</span></span></summary>
                <div class="disclosure-body">${detailView(parse(s.value), labels)}</div></details>`)}</div>`
            : html`<p class="muted">Keine Spielstände.</p>`}</section>
      </div>
      <div>
        <section class="section" aria-labelledby="s-fb" id="rueckmeldung">${sectionHead('Rückmeldungen', { id: 's-fb', count: feedback.length ? String(feedback.length) : null })}
          ${canFeedback ? kit.feedbackForm(req, ctx, { cls, student, appId: a.id, back: here }) : ''}
          ${feedback.length ? html`<div class="mt-6">${kit.feedbackTimeline(req, ctx, feedback, { back: here, showClass: false })}</div>` : canFeedback ? '' : html`<p class="muted">Noch keine Rückmeldungen.</p>`}</section>
        ${change ? html`<section class="danger-zone" aria-labelledby="s-reset"><h2 id="s-reset">Daten zurücksetzen</h2>
          <p class="mt-2 mb-4">Löscht alle Ergebnisse, Spielstände, Bestwerte, den Fortschritt und die Erfolge von ${student.name} in dieser App – auch die aus anderen Klassen.</p>
          ${postButton(req, `${here}/loeschen`, 'Daten in dieser App löschen', { kind: 'danger', icon: 'trash', confirm: `Alle Daten von ${student.name} in „${a.name}“ löschen?\nErgebnisse, Spielstände, Bestwerte, Fortschritt und Erfolge werden gelöscht. Das kann nicht rückgängig gemacht werden.`, confirmLabel: 'Löschen' })}</section>` : ''}
      </div>
    </div>`;
    res.send(page(req, { title: `${student.name} · ${a.name}`, body, active: 'klassen', classId: cls.id, styles: ['css/teaching.css'] }));
  });

  app.post('/klassen/:id/apps/:aid/ergebnisse/:uid/loeschen', (req, res) => {
    const { cls, a, student } = loadStudent(req);
    // Archived classes are read-only.
    if (!access.canChangeClass(req.user, cls.id)) throw deny();
    services.deleteAppData(a.id, student.id);
    services.audit(req.user, 'appdaten_zurueckgesetzt', a.name, cls.name);
    flash(req, `Die Daten von ${student.name} in „${a.name}“ wurden gelöscht.`);
    res.redirect(303, `/klassen/${cls.id}/apps/${a.id}/ergebnisse`);
  });
};
