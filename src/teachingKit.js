'use strict';
// Shared helpers for the class pages of package A (routes/classes.js,
// routes/results.js, routes/teaching.js): loading a class with its permission
// check, school-time dates for forms, week buckets for charts, the feedback
// blocks, and small text helpers. Every permission decision comes from
// access.js; everything written by people is rendered through html``.

const { html, raw, csrfField, postButton, timeline, badge, field, formValue, icon, barChart, flash } = require('./html');
const { deny, plural, dayKey, formatAgo, formatFullDate, isLocalPath } = require('./util');

const TZ = 'Europe/Berlin';
const DAY = 86_400_000;

/** How long a join code or a teacher invitation stays valid (minutes -> label). */
const DURATIONS = { 15: '15 Minuten', 60: '1 Stunde', 1440: '1 Tag', 10080: '1 Woche' };

// ------------------------------------------------------------------ classes

/**
 * The class in req.params.id if the user may see it ('view'), manage it
 * ('manage': its teachers and the admin, also when archived) or change it
 * ('change': manage and not archived). Anything else is a 404.
 */
function loadClass(ctx, req, need = 'view') {
  const cls = ctx.db.get('SELECT * FROM classes WHERE id = ?', String(req.params.id));
  const { access } = ctx;
  const ok = cls && (need === 'change' ? access.canChangeClass(req.user, cls.id) : need === 'manage' ? access.canManageClass(req.user, cls.id) : access.canViewClass(req.user, cls.id));
  if (!ok) throw deny();
  return cls;
}

const studentsText = (n) => plural(n, 'Schüler/in', 'Schüler/innen');

/** "Englisch · Klassenstufe 7" (empty when neither is set). */
const classEyebrow = (cls) => [cls.subject, cls.grade ? `Klassenstufe ${cls.grade}` : ''].filter(Boolean).join(' · ');

/** A neutral mark for a class: its first word ("7b"), at most three characters. People and classes get no colours. */
function classMark(cls) {
  const first = String(cls.name || '?').trim().split(/\s+/)[0] || '?';
  const short = [...first].length <= 3 ? first : [...first].slice(0, 2).join('');
  return html`<span class="teach-mark" aria-hidden="true">${short}</span>`;
}

// -------------------------------------------------------------------- dates
// Forms work in school time (Europe/Berlin), whatever the server's zone is.

const wallFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

function wallParts(ts) {
  const p = {};
  for (const x of wallFmt.formatToParts(new Date(ts))) p[x.type] = x.value;
  return p;
}
/** "2026-11-12" in school time (for <input type="date">). */
const inputDate = (ts) => {
  const p = wallParts(ts);
  return `${p.year}-${p.month}-${p.day}`;
};
/** "14:30" in school time (for <input type="time">). */
const inputTime = (ts) => {
  const p = wallParts(ts);
  return `${p.hour}:${p.minute}`;
};
/** "2026-11-12T14:30" in school time (for <input type="datetime-local">). */
const inputDateTime = (ts) => `${inputDate(ts)}T${inputTime(ts)}`;

/** School-time wall clock ("YYYY-MM-DD", "HH:MM") -> timestamp; null if it is not a real date. */
function schoolTime(date, time = '00:00') {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  const t = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(String(time || ''));
  if (!d || !t) return null;
  const [y, mo, da, h, mi] = [+d[1], +d[2], +d[3], +t[1], +t[2]];
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || da < 1 || da > 31 || h > 23 || mi > 59) return null;
  const target = Date.UTC(y, mo - 1, da, h, mi);
  if (new Date(target).getUTCDate() !== da) return null; // e.g. 31 February
  let ts = target;
  for (let i = 0; i < 3; i++) {
    const p = wallParts(ts);
    ts += target - Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  }
  return ts;
}
/** "2026-11-12T14:30" (datetime-local) -> timestamp or null. */
function schoolDateTime(value) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2})?$/.exec(String(value || ''));
  return m ? schoolTime(m[1], m[2]) : null;
}

/** The day an archived class will be deleted by the retention rule. */
const deletionDay = (ctx, cls) => (cls.archived_at ? formatFullDate(cls.archived_at + ctx.settings.get('retention.archivedClassDays') * DAY) : '');

// -------------------------------------------------------------------- weeks

function isoWeek(utcMidnight) {
  const d = new Date(utcMidnight);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  return Math.ceil(((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY + 1) / 7);
}

/** The last n school weeks (Monday 00:00), oldest first: [{ start, end, label: 'KW 46', now }]. */
function weeks(n = 8, now = Date.now()) {
  const [y, m, d] = dayKey(now).split('-').map(Number);
  const today = Date.UTC(y, m - 1, d);
  const monday = today - ((new Date(today).getUTCDay() || 7) - 1) * DAY;
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const day = monday - i * 7 * DAY;
    out.push({ start: schoolTime(new Date(day).toISOString().slice(0, 10), '00:00'), label: `KW ${isoWeek(day)}`, now: i === 0 });
  }
  return out.map((w, i) => ({ ...w, end: i + 1 < out.length ? out[i + 1].start : Number.MAX_SAFE_INTEGER }));
}
/**
 * SQL that counts rows per week in one statement: "SUM(CASE ...) AS w0, ...".
 * `column` is a fixed column name from our own code; the bounds are bound
 * parameters (weekParams).
 */
const weekSums = (column, n) => Array.from({ length: n }, (_, i) => `SUM(CASE WHEN ${column} >= ? AND ${column} < ? THEN 1 ELSE 0 END) AS w${i}`).join(', ');
const weekParams = (ws) => ws.flatMap((w) => [w.start, w.end]);
const weekBars = (ws, counts) => ws.map((w, i) => ({ label: w.label, value: (counts && counts[`w${i}`]) || 0, now: w.now }));

/**
 * Results per week as columns, with exactly one row of week labels: our own
 * axis ("KW 46" on wider screens, "46" on phones so the labels never run into
 * each other; the current week in bold). The chart keeps its text alternative
 * with the full labels. No results: one calm sentence instead of an empty chart.
 */
function weekChart(bars, label) {
  if (!bars.some((b) => b.value > 0)) return html`<p class="muted teach-chart-empty">In den letzten ${bars.length} Wochen gab es keine Ergebnisse.</p>`;
  return html`<div class="teach-chart">${barChart(bars, { label, labels: false })}<div class="teach-axis" aria-hidden="true">${bars.map((b) => {
    const [prefix, number] = String(b.label).split(' ');
    return html`<span${b.now ? raw(' class="teach-axis-now"') : ''}>${number ? html`<span class="teach-kw">${prefix} </span>${number}` : b.label}</span>`;
  })}</div></div>`;
}

// ---------------------------------------------------------------- buttons

/** A POST button for a page head: on phones it stretches like the link buttons beside it. */
const headPostButton = (req, action, label, opts = {}) => html`<span class="teach-stretch">${postButton(req, action, label, { ...opts, block: true })}</span>`;

// ------------------------------------------------------------ form errors

/**
 * Send a form back to its page with every message at its field and what the
 * person typed (both for exactly one view of `path`; the error handler only
 * knows one message per form).
 */
function backToForm(req, res, { path, key, errors, fields }) {
  req.session.formState = { path, fields };
  req.session[key] = { path, errors };
  flash(req, errors._all || 'Bitte prüfe die markierten Felder.', 'error');
  res.redirect(303, path);
}
/** The per-field messages a form left for this page (read once). */
function takeFieldErrors(req, key) {
  const kept = req.session ? req.session[key] : null;
  if (req.session) delete req.session[key];
  return kept && kept.path === req.path ? kept.errors : {};
}

// --------------------------------------------------------------- returning

/** A local path to return to after a form, limited to the class area; otherwise the fallback. */
function backTo(value, fallback) {
  const p = typeof value === 'string' ? value : '';
  return p.length < 300 && isLocalPath(p) && /^\/(klassen|aufgaben|rueckmeldungen)(\/|\?|#|$)/.test(p) ? p : fallback;
}

/** Percent 0..100 of a result, or null when it has no maximum. */
function percentOf(score, max) {
  if (typeof score !== 'number' || typeof max !== 'number' || !(max > 0)) return null;
  return Math.max(0, Math.min(100, Math.round((score / max) * 100)));
}

// ----------------------------------------------------------------- feedback

/**
 * Feedback as a timeline. Every text in it was written by a person and is
 * escaped. Buttons appear only where access.js allows them.
 *   showStudent: name the student it was written to (teachers' lists)
 *   showClass:   name the class in the context line
 */
function feedbackTimeline(req, ctx, rows, { back, showStudent = false, showClass = true } = {}) {
  const { access } = ctx;
  return timeline(rows.map((f) => {
    const unread = !f.read_at && f.student_id === req.user.id;
    const context = [showClass ? f.class_name : '', f.app_name || ''].filter(Boolean).join(' · ');
    return {
      mark: 'message',
      head: html`<strong>${f.author_name || 'Gelöschtes Konto'}</strong>${showStudent && f.student_name ? html`<span class="faint">an ${f.student_name}</span>` : ''}${unread ? badge('neu', 'solid') : ''}`,
      time: formatAgo(f.created_at),
      body: f.body,
      extra: html`<div class="teach-fb-foot"><span class="meta">${context}${f.assignment_id && f.assignment_title ? html`${context ? ' · ' : ''}<a href="/aufgaben/${f.assignment_id}">${f.assignment_title}</a>` : ''}</span>
        <div class="actions">${unread && access.canMarkFeedbackRead(req.user, f) ? postButton(req, `/rueckmeldungen/${f.id}/gelesen`, 'Als gelesen markieren', { kind: 'quiet', size: 'sm', icon: 'check', fields: { zurueck: back } }) : ''}
        ${access.canDeleteFeedback(req.user, f) ? postButton(req, `/rueckmeldungen/${f.id}/loeschen`, 'Rückmeldung löschen', { kind: 'danger', size: 'sm', icon: 'trash', iconOnly: true, fields: { zurueck: back }, confirm: 'Rückmeldung löschen?\nSie verschwindet für die Schülerin oder den Schüler und für die Lehrkräfte der Klasse. Das kann nicht rückgängig gemacht werden.', confirmLabel: 'Löschen' }) : ''}</div></div>`,
    };
  }));
}

/**
 * Form for one private feedback (teacher -> one student). With `students`
 * the teacher picks the student; otherwise `student` is fixed.
 */
function feedbackForm(req, ctx, { cls, student = null, students = null, chosen = '', appId = '', assignmentId = '', back }) {
  const max = ctx.config.limits.feedbackChars;
  const pick = students
    ? field(req, {
        label: 'An',
        name: 'schueler',
        control: html`<select id="f-schueler" name="schueler" required><option value="">Schüler/in wählen</option>${students.map((s) => html`<option value="${s.id}"${s.id === formValue(req, 'schueler', chosen) ? ' selected' : ''}>${s.name}</option>`)}</select>`,
      })
    : html`<input type="hidden" name="schueler" value="${student.id}">`;
  return html`<form method="post" action="/klassen/${cls.id}/rueckmeldungen" class="form teach-fbform">${csrfField(req)}
    <input type="hidden" name="zurueck" value="${back}">${appId ? html`<input type="hidden" name="app" value="${appId}">` : ''}${assignmentId ? html`<input type="hidden" name="aufgabe" value="${assignmentId}">` : ''}
    ${pick}
    ${field(req, {
      label: student ? `Rückmeldung an ${student.name}` : 'Rückmeldung',
      name: 'text',
      type: 'textarea',
      required: true,
      hint: `Privat: Nur ${student ? student.name : 'die Schülerin oder der Schüler'} und die Lehrkräfte dieser Klasse lesen sie. Höchstens ${max} Zeichen.`,
      attrs: `maxlength="${Number(max)}" rows="4"`,
    })}
    <div class="actions"><button class="btn primary">${icon('send')}<span>Rückmeldung senden</span></button></div></form>`;
}

module.exports = {
  DURATIONS, DAY,
  loadClass, studentsText, classEyebrow, classMark,
  inputDate, inputTime, inputDateTime, schoolTime, schoolDateTime, deletionDay,
  weeks, weekSums, weekParams, weekBars, weekChart,
  headPostButton, backTo, percentOf, backToForm, takeFieldErrors,
  feedbackTimeline, feedbackForm,
};
