'use strict';
// Server-side HTML with escaping by default.
//
//   html`<p>${userText}</p>`     -> userText is ALWAYS escaped
//   html`<ul>${items.map(...)}</ul>` -> nested html`` fragments stay as they are
//
// The only way to output unescaped markup is raw(), which is used for
// markup the server generated itself (never for anything a user wrote).

const { csrfToken } = require('./security');

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

// ---------- shared fragments ----------

const EMOJIS = ['🎮', '🧩', '📚', '🔤', '🧮', '🌍', '🔬', '🎨', '🎵', '⭐', '🚀', '🐍', '🦊', '⚽', '🧠', '🗺️', '⏱️', '🎲', '💡', '🌱', '🏰', '🤖', '📝', '🧪'];
const COLORS = 8;
const ROLE_LABEL = { student: 'Schüler/in', teacher: 'Lehrkraft', admin: 'Admin' };

/** Colored tile with the app's emoji. Both values are validated against fixed lists. */
function appIcon(app, size = '') {
  const emoji = EMOJIS.includes(app.emoji) ? app.emoji : EMOJIS[0];
  const color = Number.isInteger(app.color) && app.color >= 0 && app.color < COLORS ? app.color : 0;
  return html`<span class="tile c${color} ${size}" aria-hidden="true">${emoji}</span>`;
}

const csrfField = (req) => html`<input type="hidden" name="_csrf" value="${csrfToken(req)}">`;

/** A one-button POST form (state changes are never links). */
function postButton(req, action, label, { cls = 'btn', confirm = '', fields = {} } = {}) {
  return html`<form method="post" action="${action}" class="inline"${confirm ? html` data-confirm="${confirm}"` : ''}>
    ${csrfField(req)}${Object.entries(fields).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
    <button class="${cls}">${label}</button></form>`;
}

/** Show any JSON value as plain text. Lists of flat objects become a table. */
function jsonView(value) {
  const flat = (o) => o && typeof o === 'object' && !Array.isArray(o) && Object.values(o).every((v) => v === null || typeof v !== 'object');
  const cell = (v) => (v === true ? '✓' : v === false ? '✗' : v === null || v === undefined ? '' : String(v));
  if (Array.isArray(value) && value.length > 0 && value.length <= 500 && value.every(flat)) {
    const cols = [...new Set(value.flatMap((o) => Object.keys(o)))].slice(0, 12);
    return html`<div class="scroll"><table class="data"><thead><tr>${cols.map((c) => html`<th>${c}</th>`)}</tr></thead>
      <tbody>${value.map((o) => html`<tr>${cols.map((c) => html`<td>${cell(o[c])}</td>`)}</tr>`)}</tbody></table></div>`;
  }
  if (flat(value) && Object.keys(value).length <= 40) {
    return html`<table class="data kv"><tbody>${Object.entries(value).map(([k, v]) => html`<tr><th>${k}</th><td>${cell(v)}</td></tr>`)}</tbody></table>`;
  }
  if (value === null || typeof value !== 'object') return html`<span>${cell(value)}</span>`;
  return html`<pre class="code">${JSON.stringify(value, null, 2)}</pre>`;
}

// ---------- page layout ----------

// Line icons for the main navigation (shown as a tab bar on phones). Fixed server markup.
const icon = (d) => raw(`<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`);
const ICONS = {
  start: icon('<path d="M4 11 12 4l8 7"/><path d="M6 10v10h12V10"/>'),
  klassen: icon('<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16 5.2a3 3 0 0 1 0 5.6M18 14.4c1.8.9 3 2.9 3 5.6"/>'),
  apps: icon('<rect x="4" y="4" width="6.5" height="6.5"/><rect x="13.5" y="4" width="6.5" height="6.5"/><rect x="4" y="13.5" width="6.5" height="6.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5"/>'),
  entwickeln: icon('<path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/>'),
  admin: icon('<path d="M12 3 4 6v6c0 4.4 3.4 8 8 9 4.6-1 8-4.6 8-9V6z"/><path d="m9 12 2 2 4-4"/>'),
};

function page(req, { title, body, active = '', bare = false, scripts = [] }) {
  const { config } = req.app.locals.ctx;
  const user = req.user;
  const flash = req.session && req.session.flash;
  if (flash) delete req.session.flash;
  const nav = (href, key, label) => html`<a href="${href}"${active === key ? raw(' class="on" aria-current="page"') : ''}>${ICONS[key]}<span>${label}</span></a>`;

  return html`<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#09090b">
<meta name="csrf" content="${req.session ? csrfToken(req) : ''}">
<title>${title} · ${config.hubName}</title>
<link rel="stylesheet" href="/static/hub.css">
<link rel="icon" href="/static/icon.svg">
<script src="/static/hub.js" defer></script>
${scripts.map((s) => html`<script src="/static/${s}" defer></script>`)}
</head>
<body${bare ? raw(' class="bare"') : ''}>
${config.dev ? html`<div class="devbar">Lokaler Testmodus – Anmeldung ohne Microsoft ist aktiv. Niemals so ins Netz stellen.</div>` : ''}
<header class="top">
  <a class="brand" href="/"><span class="logo" aria-hidden="true"></span>${config.hubName}</a>
  ${user ? html`<nav class="main" aria-label="Hauptmenü">
    ${nav('/start', 'start', 'Start')}
    ${nav('/klassen', 'klassen', 'Klassen')}
    ${nav('/apps', 'apps', 'Meine Apps')}
    ${nav('/entwickeln', 'entwickeln', 'Selbst bauen')}
    ${user.role === 'admin' ? nav('/admin', 'admin', 'Verwaltung') : ''}
  </nav>
  <div class="me">
    <a href="/meine-daten" class="who" title="Meine Daten">${user.name}<small>${ROLE_LABEL[user.role]}</small></a>
    <form method="post" action="/auth/logout">${csrfField(req)}<button class="btn ghost small">Abmelden</button></form>
  </div>` : ''}
</header>
<main${bare ? raw(' class="bare"') : ''}>
${flash ? html`<div class="flash ${flash.type === 'error' ? 'error' : 'ok'}" role="status">${flash.text}</div>` : ''}
${body}
</main>
${bare ? '' : html`<footer class="foot"><a href="/datenschutz">Welche Daten speichert ${config.hubName}?</a></footer>`}
</body>
</html>`.toString();
}

/** Remember a message for the next page (after a redirect). */
function flash(req, text, type = 'ok') {
  req.session.flash = { text, type };
}

module.exports = { html, raw, escapeHtml, page, flash, csrfField, postButton, appIcon, jsonView, EMOJIS, COLORS, ROLE_LABEL };
