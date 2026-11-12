'use strict';
// Small building blocks for the school and admin pages (package D): reading
// query values safely, filter controls, paging, and the fixed vocabularies
// of the display settings. Everything renders through html`` (escaped).

const { html, raw, icon, btnClass, formValue } = require('./html');
const { cleanText } = require('./util');

/** A query value as clean text; '' when missing, repeated (?a=1&a=2) or not a string. */
function queryText(req, name, max = 60) {
  const v = req.query[name];
  return typeof v === 'string' ? cleanText(v, max) : '';
}

/** A query value from a fixed list, else the fallback. */
function queryChoice(req, name, allowed, fallback = '') {
  const v = req.query[name];
  return typeof v === 'string' && allowed.includes(v) ? v : fallback;
}

/** Text for a LIKE pattern with \ as the escape character. */
const likePattern = (q) => `%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** "2026-11-20" -> { y, m0, d } for a real calendar day, else null. */
function parseDay(value) {
  const m = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim()) : null;
  if (!m) return null;
  const [y, m0, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const t = new Date(Date.UTC(y, m0, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m0 && t.getUTCDate() === d && y >= 2000 && y <= 2200 ? { y, m0, d } : null;
}

const berlinHour = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', hourCycle: 'h23' });
/** Midnight at the start of a calendar day in school time (Europe/Berlin), in ms. Day overflow is allowed (d + 1). */
function dayStart({ y, m0, d }) {
  const utc = Date.UTC(y, m0, d);
  // At 00:00 UTC it is 01:00 or 02:00 in Berlin; that hour is the offset.
  return utc - Number(berlinHour.format(new Date(utc))) * 3_600_000;
}

/** ?seite=N as a whole number 1..10000. */
function pageNumber(req) {
  const n = Number.parseInt(typeof req.query.seite === 'string' ? req.query.seite : '', 10);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, 10_000) : 1;
}

/** URL of a list with query values; empty values and page 1 are left out. */
function listUrl(base, params = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === '' || v === null || v === undefined || (k === 'seite' && Number(v) === 1)) continue;
    q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `${base}?${s}` : base;
}

/** "Zurück" / "Seite x von y" / "Weiter". Nothing when everything fits on one page. */
function pager({ base, params = {}, page, pages }) {
  if (pages <= 1) return '';
  const link = (n, label, ico, after) =>
    html`<a class="${btnClass({ size: 'sm' })}" href="${listUrl(base, { ...params, seite: n })}"${n < page ? raw(' rel="prev"') : raw(' rel="next"')}>${after ? '' : icon(ico)}<span>${label}</span>${after ? icon(ico) : ''}</a>`;
  return html`<nav class="school-pager" aria-label="Seiten">
    ${page > 1 ? link(page - 1, 'Zurück', 'chevronLeft', false) : html`<span></span>`}
    <span class="school-pager-info">Seite ${page} von ${pages}</span>
    ${page < pages ? link(page + 1, 'Weiter', 'chevronRight', true) : html`<span></span>`}
  </nav>`;
}

/**
 * <select> that keeps the value typed before a validation error.
 * options: [[value, label], ...] or { group, options } for an <optgroup>.
 */
function selectControl(req, { name, id = `f-${name}`, options, value = '', attrs = '' }) {
  const current = String(req ? formValue(req, name, value) : value);
  const opt = ([v, label]) => html`<option value="${v}"${String(v) === current ? raw(' selected') : ''}>${label}</option>`;
  return html`<select id="${id}" name="${name}"${attrs ? raw(` ${attrs}`) : ''}>${options.map((o) =>
    Array.isArray(o) ? opt(o) : o.options.length ? html`<optgroup label="${o.group}">${o.options.map(opt)}</optgroup>` : '')}</select>`;
}

/**
 * Radio buttons as one segmented control, grouped by a fieldset with a legend.
 * scroll: on phones the options stay in one line that scrolls sideways (many options).
 */
function segmented({ name, legend, options, value, hint = '', id = `seg-${name}`, cls = '', scroll = false }) {
  return html`<fieldset class="school-field${cls ? ` ${cls}` : ''}"${hint ? html` aria-describedby="${id}-hint"` : ''}>
    <legend>${legend}</legend>
    <div class="segmented school-seg${scroll ? ' school-seg-scroll' : ''}">${options.map(([v, label, ico]) => html`<label><input type="radio" name="${name}" value="${v}"${v === value ? raw(' checked') : ''}>${ico ? icon(ico, { cls: 'sm' }) : ''}<span>${label}</span></label>`)}</div>
    ${hint ? html`<p class="school-hint" id="${id}-hint">${hint}</p>` : ''}
  </fieldset>`;
}

/**
 * Display and accessibility settings: database column, form field, the fixed
 * values (the CHECK constraints in src/db.js allow exactly these) and labels.
 */
const DISPLAY_PREFS = [
  {
    column: 'pref_theme', field: 'farbschema', legend: 'Farbschema',
    hint: '„Wie das Gerät“ folgt der hellen oder dunklen Einstellung deines Handys oder Computers.',
    options: [['auto', 'Wie das Gerät', 'monitor'], ['dark', 'Dunkel', 'moon'], ['light', 'Hell', 'sun']],
  },
  {
    column: 'pref_text', field: 'schriftgroesse', legend: 'Schriftgröße',
    hint: 'Vergrößert alle Texte und Bedienelemente.',
    options: [['normal', 'Normal'], ['large', 'Groß'], ['larger', 'Sehr groß']],
  },
  {
    column: 'pref_motion', field: 'bewegung', legend: 'Bewegung',
    hint: '„Weniger Bewegung“ schaltet Animationen und Übergänge ab.',
    options: [['auto', 'Wie das Gerät'], ['reduce', 'Weniger Bewegung']],
  },
  {
    column: 'pref_contrast', field: 'kontrast', legend: 'Kontrast',
    hint: 'Hoher Kontrast macht die Schrift heller und Linien kräftiger.',
    options: [['normal', 'Normal'], ['high', 'Hoch']],
  },
];

/** "Dunkel · Schrift normal · …" - the person's display settings in words. */
function displaySummary(user) {
  const label = (pref) => {
    const o = pref.options.find(([v]) => v === user[pref.column]);
    return o ? o[1] : '–';
  };
  const [theme, text, motion, contrast] = DISPLAY_PREFS.map(label);
  return `${theme} · Schrift ${text.toLowerCase()} · Bewegung ${motion === 'Wie das Gerät' ? 'wie das Gerät' : 'reduziert'} · Kontrast ${contrast.toLowerCase()}`;
}

module.exports = {
  queryText, queryChoice, pageNumber, listUrl, pager, selectControl, segmented, likePattern, parseDay, dayStart,
  DISPLAY_PREFS, displaySummary,
};
