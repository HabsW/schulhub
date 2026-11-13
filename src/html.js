'use strict';
// Server-side HTML with escaping by default, the page layout, and the
// component helpers every page is built from (see DESIGN.md).
//
//   html`<p>${userText}</p>`         -> userText is ALWAYS escaped
//   html`<ul>${items.map(...)}</ul>` -> nested html`` fragments stay as they are
//
// The only way to output unescaped markup is raw(), which is used for markup
// the server generated itself (icons, QR codes) - never for anything a user wrote.
// No helper ever writes a style attribute: the CSP forbids inline styles.

const { csrfToken } = require('./security');
const ICONS = require('./icons');

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

class Raw {
  constructor(s) {
    this.s = s;
  }
  toString() {
    return this.s;
  }
}
const raw = (s) => new Raw(String(s));

function render(v) {
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(render).join('');
  if (v === null || v === undefined || v === false || v === true) return '';
  return escapeHtml(v);
}

function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new Raw(out);
}

// ======================================================== fixed vocabularies

const EMOJIS = ['🎮', '🧩', '📚', '🔤', '🧮', '🌍', '🔬', '🎨', '🎵', '⭐', '🚀', '🐍', '🦊', '⚽', '🧠', '🗺️', '⏱️', '🎲', '💡', '🌱', '🏰', '🤖', '📝', '🧪'];
const COLORS = 8;
const COLOR_NAMES = ['Himmel', 'Wiese', 'Orange', 'Kirsche', 'Flieder', 'Türkis', 'Sonne', 'Sand'];
const ROLE_LABEL = { student: 'Schüler/in', teacher: 'Lehrkraft', admin: 'Admin' };

// ================================================================ primitives

/** Inline SVG icon from the fixed set in src/icons.js. With `label`, it is announced; otherwise hidden. */
function icon(name, { cls = '', label = '' } = {}) {
  const inner = ICONS[name];
  if (!inner) throw new Error(`unknown icon ${name}`);
  const a11y = label ? `role="img" aria-label="${escapeHtml(label)}"` : 'aria-hidden="true" focusable="false"';
  return raw(`<svg class="ico${cls ? ` ${escapeHtml(cls)}` : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" ${a11y}>${inner}</svg>`);
}

/** The brand mark: a 2x2 grid of tiles, one filled - many apps, one Hub. */
const brandMark = () =>
  raw('<svg class="brand-mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="2.5" y="2.5" width="8.5" height="8.5" rx="2.2" fill="currentColor"/><rect x="13" y="2.5" width="8.5" height="8.5" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="2.5" y="13" width="8.5" height="8.5" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="13" y="13" width="8.5" height="8.5" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>');

/** 'app-3' - the class that gives an element the app's identity colour (validated index). */
const appClass = (app) => `app-${Number.isInteger(app && app.color) && app.color >= 0 && app.color < COLORS ? app.color : 0}`;

/** Tile with the app's emoji in its colour. Sizes: xs, sm, (md), lg, xl. Both values come from fixed lists. */
function appIcon(app, size = '') {
  const emoji = EMOJIS.includes(app.emoji) ? app.emoji : EMOJIS[0];
  return html`<span class="tile ${appClass(app)}${size ? ` ${size}` : ''}" aria-hidden="true">${emoji}</span>`;
}

/** Initials of a person (no photos, no colours: people are not apps). */
function avatar(name, size = '') {
  const parts = String(name || '?').trim().split(/\s+/).filter((p) => /\p{L}/u.test(p));
  const initials = (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] || '?').slice(0, 2)).toUpperCase();
  return html`<span class="avatar${size ? ` ${size}` : ''}" aria-hidden="true">${initials}</span>`;
}

const csrfField = (req) => html`<input type="hidden" name="_csrf" value="${csrfToken(req)}">`;

const BTN_KINDS = { primary: 'primary', secondary: '', quiet: 'quiet', danger: 'danger' };
/** Class list for a button: kind (primary|secondary|quiet|danger), size (sm|lg), icon-only, block. */
function btnClass({ kind = 'secondary', size = '', iconOnly = false, block = false, extra = '' } = {}) {
  return ['btn', BTN_KINDS[kind] ?? '', size, iconOnly ? 'icon' : '', block ? 'block' : '', extra].filter(Boolean).join(' ');
}

/** A link styled as a button. */
function linkButton(href, label, { kind = 'secondary', size = '', icon: ico = '', iconOnly = false, block = false, attrs = '' } = {}) {
  return html`<a class="${btnClass({ kind, size, iconOnly, block })}" href="${href}"${attrs ? raw(` ${attrs}`) : ''}${iconOnly ? html` aria-label="${label}" title="${label}"` : ''}>${ico ? icon(ico) : ''}${iconOnly ? '' : html`<span>${label}</span>`}</a>`;
}

/**
 * A one-button POST form (state changes are never links).
 * options: kind/size/icon (new) or cls (legacy class string), confirm (question
 * shown before sending), confirmLabel (label of the confirming button), fields (hidden inputs).
 */
function postButton(req, action, label, { cls = '', kind = 'secondary', size = '', icon: ico = '', iconOnly = false, confirm = '', confirmLabel = '', fields = {}, block = false } = {}) {
  const klass = cls || btnClass({ kind, size, iconOnly, block });
  const danger = /\bdanger\b/.test(klass);
  return html`<form method="post" action="${action}" class="inline"${confirm ? html` data-confirm="${confirm}" data-confirm-label="${confirmLabel || label}"${danger ? raw(' data-danger="1"') : ''}` : ''}>
    ${csrfField(req)}${Object.entries(fields).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
    <button class="${klass}"${iconOnly ? html` aria-label="${label}" title="${label}"` : ''}>${ico ? icon(ico) : ''}${iconOnly ? '' : html`<span>${label}</span>`}</button></form>`;
}

// ============================================================== components

/** Status pill. tone: '' | 'ok' | 'wait' | 'danger' | 'solid'. */
const badge = (text, tone = '', { mono = false } = {}) => html`<span class="badge${tone ? ` ${tone}` : ''}${mono ? ' mono' : ''}">${text}</span>`;

/** Small number pill (navigation counts). */
const countPill = (n, tone = '') => (n > 0 ? html`<span class="count${tone ? ` ${tone}` : ''}">${n > 99 ? '99+' : n}</span>` : '');

/**
 * The head of a page.
 *  crumbs: [[href, label], ...]   title   eyebrow   lead (text)   meta (html)
 *  actions (html, primary first)  app (an app row: colour band + tile)  tabs (html from tabs())
 */
function pageHead({ crumbs = [], eyebrow = '', title, lead = '', meta = '', actions = '', app = null, tabs: tabsHtml = '' }) {
  return html`${crumbs.length ? html`<nav class="crumbs" aria-label="Brotkrumen">${crumbs.map(([href, label], i) => html`${i ? icon('chevronRight') : ''}<a href="${href}">${label}</a>`)}</nav>` : ''}
  <header class="page-head${app ? ` app-head ${appClass(app)}` : ''}">
    <div class="page-head-main">${app ? appIcon(app, 'xl') : ''}
      <div class="page-head-text">${eyebrow ? html`<span class="eyebrow">${eyebrow}</span>` : ''}<h1>${title}</h1>
        ${lead ? html`<p>${lead}</p>` : ''}${meta ? html`<div class="meta-row">${meta}</div>` : ''}</div></div>
    ${actions ? html`<div class="actions">${actions}</div>` : ''}
  </header>${tabsHtml}`;
}

/** Underline tabs. items: [[href, label, key, count?]]; current: key. */
function tabs(items, current, label = 'Bereiche') {
  return html`<nav class="tabs" aria-label="${label}">${items.map(([href, text, key, count]) =>
    html`<a href="${href}"${key === current ? raw(' aria-current="page"') : ''}>${text}${count ? html` <span class="count${count.tone ? ` ${count.tone}` : ''}">${count.n ?? count}</span>` : ''}</a>`)}</nav>`;
}

/** Head of a section: h2 (with optional count text), optional description and actions. */
function sectionHead(title, { count = null, sub = '', actions = '', id = '' } = {}) {
  return html`<div class="section-head"><h2${id ? html` id="${id}"` : ''}>${title}${count !== null ? html` <span class="count-text">${count}</span>` : ''}</h2>${actions ? html`<div class="actions">${actions}</div>` : ''}${sub ? html`<p>${sub}</p>` : ''}</div>`;
}

/**
 * One list row. The whole row is clickable when href is given (title becomes
 * a link that covers the row); buttons in `end` stay separately clickable.
 */
function row({ href = '', title, sub = '', start = '', end = '', chevron = Boolean(href), cls = '', clamp = false, titleAttrs = '' }) {
  return html`<li class="row${cls ? ` ${cls}` : ''}">${start}<div class="row-main">${href
    ? html`<a class="row-link row-title" href="${href}"${titleAttrs ? raw(` ${titleAttrs}`) : ''}>${title}</a>`
    : html`<span class="row-title">${title}</span>`}${sub ? html`<span class="row-sub${clamp ? ' clamp' : ''}">${sub}</span>` : ''}</div>${end || chevron ? html`<div class="row-end">${end}${chevron ? icon('chevronRight', { cls: 'chev' }) : ''}</div>` : ''}</li>`;
}
const list = (rows, cls = '') => html`<ul class="list${cls ? ` ${cls}` : ''}" role="list">${rows}</ul>`;

/** A row for an app: tile, name, description or custom sub line. */
function appRow(app, { href = '', sub, end = '', cls = '' } = {}) {
  return row({ href, title: app.name, sub: sub === undefined ? String(app.description || '').split('\n')[0].slice(0, 120) : sub, start: appIcon(app), end, cls, clamp: true });
}

/** App shelf item (tile above name). */
function shelfItem(app, href, sub = '') {
  return html`<li><a class="shelf-item" href="${href}">${appIcon(app)}<strong>${app.name}</strong>${sub ? html`<small>${sub}</small>` : ''}</a></li>`;
}
const shelf = (items, label = 'Apps') => html`<ul class="shelf" role="list" aria-label="${label}">${items}</ul>`;

/**
 * Responsive data table. On phones every row becomes a record (no sideways
 * scrolling): the server writes the labels, CSS does the rest.
 *  columns: [{ label, key?, num?, primary?, actions?, render?(row) }]
 */
function dataTable({ columns, rows, caption = '', empty: emptyHtml = '', cls = '' }) {
  if (!rows.length && emptyHtml) return emptyHtml;
  const cellOf = (col, r) => (col.render ? col.render(r) : r[col.key]);
  return html`<div class="table-wrap"><table class="data records${cls ? ` ${cls}` : ''}">${caption ? html`<caption>${caption}</caption>` : ''}
    <thead><tr>${columns.map((c) => html`<th scope="col"${c.num ? raw(' class="num"') : ''}>${c.actions ? html`<span class="visually-hidden">${c.label || 'Aktionen'}</span>` : c.label}</th>`)}</tr></thead>
    <tbody>${rows.map((r) => html`<tr>${columns.map((c) => {
      const value = cellOf(c, r);
      const klass = [c.num ? 'num' : '', c.primary ? 'primary-cell' : '', c.actions ? 'actions-cell' : '', value === '' || value === null || value === undefined ? 'empty-cell' : ''].filter(Boolean).join(' ');
      return html`<td${klass ? html` class="${klass}"` : ''} data-label="${c.label || ''}"><span class="cell">${value}</span></td>`;
    })}</tr>`)}</tbody></table></div>`;
}

/** Progress bar as SVG (widths are attributes, not styles). value 0..1. tone: '' | 'app' | 'ok' | 'wait'. */
function meter(value, { tone = '', label = '' } = {}) {
  const v = Math.max(0, Math.min(1, Number(value) || 0));
  const w = Math.round(v * 1000) / 10;
  return html`<svg class="meter${tone ? ` ${tone}` : ''}" viewBox="0 0 100 6" preserveAspectRatio="none" role="img" aria-label="${label || `${Math.round(v * 100)} Prozent`}"><rect class="track" x="0" y="0" width="100" height="6" rx="3"/>${v > 0 ? html`<rect class="fill" x="0" y="0" width="${Math.max(w, 3)}" height="6" rx="3"/>` : ''}</svg>`;
}

/** Tiny trend line (SVG). values: numbers. */
function sparkline(values, { label = 'Verlauf', cls = 'spark' } = {}) {
  const v = values.map((x) => Number(x) || 0);
  if (v.length < 2 || v.every((x) => x === 0)) return ''; // no activity: no line (a flat line reads as a stray rule)
  const max = Math.max(...v, 1);
  const pts = v.map((x, i) => `${((i / (v.length - 1)) * 100).toFixed(1)},${(22 - (x / max) * 20).toFixed(1)}`).join(' ');
  return html`<svg class="chart ${cls}" viewBox="0 0 100 24" preserveAspectRatio="none" role="img" aria-label="${label}"><polyline class="line" points="${pts}" vector-effect="non-scaling-stroke"/></svg>`;
}

/**
 * Column chart (SVG) with a text alternative. bars: [{ label, value, now? }].
 * Labels are an HTML row under the bars (long series show every k-th label);
 * pass `labels: false` to draw your own axis instead.
 */
function barChart(bars, { label = 'Diagramm', unit = '', height = 120, labels = true } = {}) {
  const max = Math.max(1, ...bars.map((b) => b.value));
  const n = bars.length || 1;
  const gap = 4;
  const bw = (600 - gap * (n - 1)) / n;
  // Labels are HTML under the SVG: SVG text would shrink to unreadable sizes on phones.
  return html`<figure class="chart-figure"><svg class="chart" viewBox="0 0 600 ${height + 2}" preserveAspectRatio="none" role="img" aria-label="${label}">
    <line class="axis" x1="0" y1="${height}" x2="600" y2="${height}"/>
    ${bars.map((b, i) => {
      const h = Math.round((b.value / max) * (height - 4));
      return html`<rect class="bar${b.now ? ' now' : ''}" x="${(i * (bw + gap)).toFixed(1)}" y="${height - h}" width="${bw.toFixed(1)}" height="${Math.max(h, b.value > 0 ? 2 : 0)}" rx="2"/>`;
    })}
  </svg>${labels ? html`<div class="chart-labels${bars.length > 8 && bars.length <= 12 ? ' many' : ''}" aria-hidden="true">${bars.map((b, i) => html`<span>${bars.length <= 12 || i % Math.ceil(bars.length / 8) === 0 || i === bars.length - 1 ? b.label : ''}</span>`)}</div>` : ''}
  <figcaption class="visually-hidden">${label}: ${bars.map((b) => `${b.label} ${b.value}${unit}`).join(', ')}</figcaption></figure>`;
}

/** A number with a label. tone: '' | 'ok' | 'wait' | 'danger'. */
function stat({ label, value, sub = '', tone = '', href = '' }) {
  const inner = html`<span class="stat-label">${label}</span><span class="stat-value">${value}</span>${sub ? html`<span class="stat-sub">${sub}</span>` : ''}`;
  return href ? html`<a class="stat${tone ? ` ${tone}` : ''}" href="${href}">${inner}</a>` : html`<div class="stat${tone ? ` ${tone}` : ''}">${inner}</div>`;
}
const stats = (items) => html`<div class="stats">${items}</div>`;

/** Empty state: what this place is for, and the one thing to do next. */
function empty({ icon: ico = 'inbox', title, text = '', actions = '' }) {
  return html`<div class="empty"><span class="empty-icon">${icon(ico)}</span><strong>${title}</strong>${text ? html`<p>${text}</p>` : ''}${actions ? html`<div class="actions">${actions}</div>` : ''}</div>`;
}

/** Callout. tone: '' | 'ok' | 'wait' | 'danger'. */
function notice({ tone = '', title = '', text = '', actions = '', icon: ico = '', role = '', cls = '' }) {
  const glyph = ico || { ok: 'checkCircle', wait: 'clock', danger: 'alert' }[tone] || 'info';
  return html`<div class="notice${tone ? ` ${tone}` : ''}${cls ? ` ${cls}` : ''}"${role ? html` role="${role}"` : ''}>${icon(glyph)}<div class="notice-body">${title ? html`<strong>${title}</strong>` : ''}${text ? html`<div class="notice-text">${text}</div>` : ''}${actions ? html`<div class="actions">${actions}</div>` : ''}</div></div>`;
}

/**
 * Form field with label, hint and error. `control` is the input markup; or
 * pass `input` options to build a text input that keeps what the person typed
 * after a validation error (see formValue).
 */
function field(req, { label, name, type = 'text', value = '', hint = '', error = '', required = false, attrs = '', control = null, id = '' }) {
  const fid = id || `f-${name}`;
  const v = name ? formValue(req, name, value) : value;
  const inputHtml = control || (type === 'textarea'
    ? html`<textarea id="${fid}" name="${name}"${required ? raw(' required') : ''}${error ? raw(' aria-invalid="true"') : ''}${hint ? html` aria-describedby="${fid}-hint"` : ''}${attrs ? raw(` ${attrs}`) : ''}>${v}</textarea>`
    : html`<input id="${fid}" type="${type}" name="${name}" value="${v}"${required ? raw(' required') : ''}${error ? raw(' aria-invalid="true"') : ''}${hint ? html` aria-describedby="${fid}-hint"` : ''}${attrs ? raw(` ${attrs}`) : ''}>`);
  return html`<div class="field"><label for="${fid}">${label}</label>${inputHtml}${hint ? html`<span class="hint" id="${fid}-hint">${hint}</span>` : ''}${error ? html`<span class="error-text">${error}</span>` : ''}</div>`;
}

/**
 * What the person typed into `name` before the last form came back with an
 * error (the error handler keeps it for one page view), else the fallback.
 */
function formValue(req, name, fallback = '') {
  const s = req.session && req.session.formState;
  if (!s || s.path !== req.path || !Object.hasOwn(s.fields, name)) return fallback;
  return s.fields[name];
}

/** Vertical history: [{ mark: icon, tone, head (html), time, body, bodyCls }] */
function timeline(items) {
  return html`<ol class="timeline">${items.map((it) => html`<li><span class="t-mark${it.tone ? ` ${it.tone}` : ''}">${icon(it.mark || 'message')}</span><div><div class="t-head">${it.head}${it.time ? html`<time>${it.time}</time>` : ''}</div>${it.body ? html`<div class="t-body${it.bodyCls ? ` ${it.bodyCls}` : ''}">${it.body}</div>` : ''}${it.extra || ''}</div></li>`)}</ol>`;
}

/** Calendar chip for a due date: day number + month, tinted by urgency. */
function dueChip(ts, tone = '') {
  if (!ts) return html`<span class="due none" aria-hidden="true"><small>offen</small></span>`;
  const d = new Date(ts);
  const day = new Intl.DateTimeFormat('de-DE', { day: 'numeric', timeZone: 'Europe/Berlin' }).format(d);
  const mon = new Intl.DateTimeFormat('de-DE', { month: 'short', timeZone: 'Europe/Berlin' }).format(d).replace('.', '');
  return html`<span class="due${tone ? ` ${tone}` : ''}" aria-hidden="true"><b>${day}</b><small>${mon}</small></span>`;
}

/** Show any JSON value as plain text. Lists of flat objects become a table; labels can rename keys. */
function jsonView(value, labels = {}) {
  const flat = (o) => o && typeof o === 'object' && !Array.isArray(o) && Object.values(o).every((v) => v === null || typeof v !== 'object');
  const cell = (v) => (v === true ? '✓' : v === false ? '✗' : v === null || v === undefined ? '' : String(v));
  // own properties only: a saved key like 'constructor' must never pick up something from the prototype
  const name = (k) => (labels && Object.hasOwn(labels, k) && typeof labels[k] === 'string' ? labels[k] : k);
  if (Array.isArray(value) && value.length > 0 && value.length <= 500 && value.every(flat)) {
    const cols = [...new Set(value.flatMap((o) => Object.keys(o)))].slice(0, 12);
    // A row without one of the columns (e.g. 'constructor') shows an empty cell, not Object.prototype's function.
    return dataTable({ columns: cols.map((c, i) => ({ label: name(c), primary: i === 0, render: (o) => cell(Object.hasOwn(o, c) ? o[c] : null) })), rows: value });
  }
  if (Array.isArray(value) && value.length > 24 && value.every((v) => v === null || typeof v !== 'object')) {
    return html`<pre class="code">${JSON.stringify(value)}</pre>`;
  }
  if (flat(value) && Object.keys(value).length <= 40) {
    return html`<dl class="kv">${Object.entries(value).map(([k, v]) => html`<div><dt>${name(k)}</dt><dd>${cell(v)}</dd></div>`)}</dl>`;
  }
  if (value === null || typeof value !== 'object') return html`<span>${cell(value)}</span>`;
  return html`<pre class="code">${JSON.stringify(value, null, 2)}</pre>`;
}

// ================================================================= layout

const NAV = [
  ['/start', 'start', 'Start', 'start'],
  ['/klassen', 'klassen', 'Klassen', 'klassen'],
  ['/katalog', 'entdecken', 'Entdecken', 'apps'],
  ['/apps', 'bauen', 'Bauen', 'bauen'],
];
// Older page code still passes these keys.
const ACTIVE_ALIAS = { apps: 'bauen', entwickeln: 'bauen', katalog: 'entdecken' };

/** Everything the frame of a signed-in page needs, in a few cheap queries. */
function shellData(req) {
  const { db, access } = req.app.locals.ctx;
  const u = req.user;
  const unread = db.get('SELECT COUNT(*) AS n FROM notices WHERE user_id = ? AND read_at IS NULL', u.id).n;
  const waiting = access.isStaff(u)
    ? db.get(
        `SELECT COUNT(*) AS n FROM class_apps ca JOIN class_members m ON m.class_id = ca.class_id AND m.user_id = ? AND m.role = 'teacher'
           JOIN classes c ON c.id = ca.class_id AND c.archived_at IS NULL WHERE ca.request_state = 'waiting'`,
        u.id
      ).n
    : 0;
  const classes = access.visibleClasses(u).slice(0, 9);
  return { unread, waiting, classes };
}

/**
 * The page frame.
 *  title, body                  required
 *  active                       nav key: start | klassen | entdecken | bauen | admin
 *  shell                        'app' (default) | 'player' | 'public'   (bare: true = 'player')
 *  width                        '' | 'wide' | 'narrow'
 *  scripts, styles              extra files from /static (styles: e.g. ['css/review.css'])
 *  appColor                     an app row: the player bar takes its colour
 */
function page(req, { title, body, active = '', bare = false, shell = '', scripts = [], styles = [], width = '', topbarTitle = '', classId = '' }) {
  const { config } = req.app.locals.ctx;
  const user = req.user;
  const mode = shell || (bare ? 'player' : user ? 'app' : 'public');
  const key = ACTIVE_ALIAS[active] || active;
  const flashMsg = req.session && req.session.flash;
  if (flashMsg) delete req.session.flash;
  // Form values kept after a validation error were read while the body was
  // built (formValue); they are used for exactly this one page view.
  if (req.session && req.session.formState) delete req.session.formState;
  const prefs = user || { pref_theme: 'dark', pref_text: 'normal', pref_motion: 'auto', pref_contrast: 'normal' };
  const data = user && mode === 'app' ? shellData(req) : null;

  const navLink = ([href, k, label, ico], count = null) =>
    html`<li><a class="nav-item" href="${href}"${k === key ? raw(' aria-current="page"') : ''}>${icon(ico)}<span>${label}</span>${count}</a></li>`;

  const frame = mode === 'app'
    ? html`<header class="topbar">
        <a class="brand" href="/start" aria-label="${config.hubName} – Start">${brandMark()}<span class="brand-name">${config.hubName}</span></a>
        <span class="topbar-title">${topbarTitle || title}</span>
        <form class="topbar-search" role="search" method="get" action="/suche">${icon('search', { cls: 'sm' })}<label class="visually-hidden" for="topsearch">Suchen</label><input id="topsearch" type="search" name="q" value="${req.path === '/suche' && typeof req.query.q === 'string' ? req.query.q.slice(0, 80) : ''}" placeholder="Apps, Klassen, Personen suchen" autocomplete="off"${req.path === '/suche' && !req.query.q ? raw(' autofocus') : ''}></form>
        <a class="icon-btn search-link" href="/suche" aria-label="Suchen" title="Suchen">${icon('search')}</a>
        <a class="icon-btn" href="/mitteilungen" aria-label="${data.unread ? `Mitteilungen, ${data.unread} neu` : 'Mitteilungen'}" title="Mitteilungen">${icon('bell')}${data.unread ? html`<span class="count dot" aria-hidden="true"></span>` : ''}</a>
        <details class="menu">
          <summary aria-label="Menü von ${user.name}" title="${user.name}">${avatar(user.name)}</summary>
          <div class="menu-panel">
            <div class="menu-head">${avatar(user.name, 'lg')}<div><strong>${user.name}</strong><small>${ROLE_LABEL[user.role]}</small></div></div>
            <a href="/meine-daten">${icon('database')}Meine Daten</a>
            <a href="/einstellungen">${icon('contrast')}Darstellung</a>
            ${user.role === 'admin' ? html`<a href="/admin">${icon('verwaltung')}Verwaltung</a>` : ''}
            <a href="/entwickeln">${icon('help')}Hilfe zum Bauen</a>
            <a href="/datenschutz">${icon('lock')}Datenschutz</a>
            <hr>
            <form method="post" action="/auth/logout">${csrfField(req)}<button>${icon('logout')}Abmelden</button></form>
          </div>
        </details>
      </header>
      <nav class="nav" aria-label="Hauptmenü">
        <a class="nav-brand" href="/start" aria-label="${config.hubName}">${brandMark()}<span class="brand-name">${config.hubName}</span></a>
        <ul class="nav-items">
          ${navLink(NAV[0])}
          ${navLink(NAV[1], data.waiting ? html`<span class="count wait" aria-label="${data.waiting} warten auf Prüfung">${data.waiting}</span>` : null)}
          ${navLink(NAV[2])}
          ${navLink(NAV[3])}
          ${user.role === 'admin' ? navLink(['/admin', 'admin', 'Verwaltung', 'verwaltung']) : ''}
        </ul>
        ${data.classes.length ? html`<div class="nav-section"><h2>Deine Klassen</h2>
          ${data.classes.slice(0, 8).map((c) => html`<a href="/klassen/${c.id}"${c.id === classId ? raw(' aria-current="page"') : ''}><span>${c.name}</span></a>`)}
          ${data.classes.length > 8 ? html`<a class="more" href="/klassen">Alle Klassen</a>` : ''}</div>` : ''}
      </nav>`
    : mode === 'public'
      ? html`<header class="topbar"><a class="brand" href="/">${brandMark()}<span class="brand-name">${config.hubName}</span></a></header>`
      : '';

  return html`<!doctype html>
<html lang="de" data-theme="${prefs.pref_theme}" data-text="${prefs.pref_text}" data-motion="${prefs.pref_motion}" data-contrast="${prefs.pref_contrast}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#0a0b0c">
<meta name="csrf" content="${req.session ? csrfToken(req) : ''}">
<title>${title} · ${config.hubName}</title>
<link rel="preload" href="/static/fonts/atkinson-next-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/static/hub.css">
${styles.map((s) => html`<link rel="stylesheet" href="/static/${s}">`)}
<link rel="icon" href="/static/icon.svg" type="image/svg+xml">
<script src="/static/hub.js" defer></script>
${scripts.map((s) => html`<script src="/static/${s}" defer></script>`)}
</head>
<body class="shell${mode === 'app' ? '' : ` ${mode}`}">
<a class="skip" href="#main">Zum Inhalt springen</a>
${config.dev ? html`<div class="devbar" role="note">Lokaler Testmodus – Anmeldung ohne Microsoft. Niemals so ins Netz stellen.</div>` : ''}
${frame}
${mode === 'player'
  ? body
  : html`<main id="main" class="main${width ? ` ${width}` : ''}" tabindex="-1">
${flashMsg ? notice({ tone: flashMsg.type === 'error' ? 'danger' : 'ok', text: flashMsg.text, role: flashMsg.type === 'error' ? 'alert' : 'status', cls: 'flash' }) : ''}
${body}
</main>
<footer class="foot"><a href="/datenschutz">Welche Daten speichert ${config.hubName}?</a>${user ? html`<a href="/einstellungen">Darstellung und Barrierefreiheit</a>` : ''}</footer>`}
</body>
</html>`.toString();
}

/** Remember a message for the next page (after a redirect). type: 'ok' | 'error'. */
function flash(req, text, type = 'ok') {
  req.session.flash = { text, type };
}

module.exports = {
  html, raw, escapeHtml, page, flash, csrfField, postButton, linkButton, btnClass, icon, brandMark,
  appIcon, appClass, avatar, badge, countPill, pageHead, tabs, sectionHead, row, list, appRow, shelf, shelfItem,
  dataTable, meter, sparkline, barChart, stat, stats, empty, notice, field, formValue, timeline, dueChip, jsonView,
  EMOJIS, COLORS, COLOR_NAMES, ROLE_LABEL,
};
