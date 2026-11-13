'use strict';
// View fragments shared by the app pages (routes/apps.js) and the review
// workbench (routes/review.js), package B: check reports, the review history,
// diffs, what an app declares and stores. Everything goes through html`` -
// every value (file names, notes, comments, manifest texts, source lines) is
// escaped. Styles: public/css/apps.css (shared) and public/css/review.css.

const { html, raw, icon, badge, list, row, timeline, csrfField, postButton, field } = require('./html');
const { plural, formatAgo, formatBytes } = require('./util');
const invisible = require('./invisible');

// ------------------------------------------------------- invisible characters

/**
 * Text with every invisible character of `re` (src/invisible.js) shown as a
 * marked placeholder, e.g. ⟨U+202E⟩ - the raw character is never output.
 * Returns html fragments: the text pieces are escaped by html``, only the
 * placeholder markup is ours (escape first, then mark - never the other way).
 */
function visible(text, re = invisible.IN_CODE) {
  const s = String(text ?? '');
  if (!invisible.has(s, re)) return s;
  const out = [];
  let last = 0;
  re.lastIndex = 0; // matchAll starts where a shared /g pattern was left
  for (const m of s.matchAll(re)) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const c = m[0];
    out.push(html`<span class="review-ctl${invisible.kind(c) === 'mark' ? ' review-ctl-mark' : ''}" title="${invisible.describe(c)}">${invisible.label(c)}</span>`);
    last = m.index + c.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
/** A line of code: bidi controls, direction marks and line separators as placeholders. */
const codeText = (text) => visible(text, invisible.IN_CODE);
/** A file or folder name: every format character as a placeholder (names stored before that rule). */
const nameText = (name) => visible(name, invisible.IN_NAME);
/** A file name for an attribute (aria-label, title): placeholders as plain text. */
const nameAttr = (name) => invisible.plain(name, invisible.IN_NAME);

// ------------------------------------------------------------- check report

const LEVELS = {
  error: { label: 'Fehler', icon: 'alert' },
  warning: { label: 'Warnung', icon: 'warning' },
  note: { label: 'Hinweis', icon: 'info' },
};

/** The stored report of a version row (written by the server), or null for old versions. */
function parseReport(version) {
  if (!version || !version.report) return null;
  try {
    const r = JSON.parse(version.report);
    return r && Array.isArray(r.items) ? r : null;
  } catch {
    return null;
  }
}

function reportCounts(report) {
  const c = { error: 0, warning: 0, note: 0 };
  for (const it of report ? report.items : []) if (Object.hasOwn(c, it.level)) c[it.level]++;
  return c;
}

/** "2 Fehler" "1 Warnung" "3 Hinweise" - or "ohne Befund". */
function reportBadges(report) {
  if (!report) return html`<span class="meta">ohne Prüfbericht</span>`;
  const c = reportCounts(report);
  if (!c.error && !c.warning && !c.note) return badge('ohne Befund', 'ok');
  return html`<span class="apps-badges">${c.error ? badge(plural(c.error, 'Fehler', 'Fehler'), 'danger') : ''}${c.warning ? badge(plural(c.warning, 'Warnung', 'Warnungen'), 'wait') : ''}${c.note ? badge(plural(c.note, 'Hinweis', 'Hinweise')) : ''}</span>`;
}

/** The tone a report deserves in a notice: 'danger' with errors, 'wait' with warnings, else 'ok'. */
function reportTone(report) {
  const c = reportCounts(report);
  return c.error ? 'danger' : c.warning ? 'wait' : 'ok';
}

/**
 * The findings as a list. href(item) may return a link to the file and line
 * in the source viewer.
 */
function reportList(report, { href = null } = {}) {
  if (!report) return html`<p class="meta">Für diese Version gibt es keinen Prüfbericht (sie ist älter als die Prüfung).</p>`;
  if (!report.items.length) return html`<p class="apps-report-ok">${icon('checkCircle')}<span>Keine Auffälligkeiten: keine Dateien aus dem Internet, keine absoluten Pfade, alles Nötige ist da.</span></p>`;
  return html`<ul class="apps-report" role="list">${report.items.map((it) => {
    const level = Object.hasOwn(LEVELS, it.level) ? it.level : 'note';
    // Findings quote code (URLs) and name files: invisible characters in them are shown as placeholders.
    const where = it.file ? html`${nameText(it.file)}${it.line ? `, Zeile ${it.line}` : ''}` : '';
    const link = href && it.file ? href(it) : '';
    return html`<li class="apps-report-item"><span class="apps-level apps-level-${level}">${icon(LEVELS[level].icon)}</span>
      <div class="apps-report-text"><span><span class="visually-hidden">${LEVELS[level].label}: </span>${codeText(it.text)}</span>${where ? html`<span class="meta">${link ? html`<a class="apps-loclink" href="${link}">${where}</a>` : where}</span>` : ''}</div></li>`;
  })}</ul>`;
}

// ------------------------------------------------------------------ history

/**
 * The review history and conversation of one app: the newest `limit` entries,
 * oldest first, and whether there are older ones. Each row: kind, body,
 * created_at, author_id, author_name, author_role, version_number, class_id, class_name.
 */
function historyRows(db, appId, limit = 60) {
  const rows = db.all(
    `SELECT c.id, c.kind, c.body, c.created_at, c.author_id, c.class_id, c.version_id,
            u.name AS author_name, u.role AS author_role, v.number AS version_number, k.name AS class_name
       FROM comments c LEFT JOIN users u ON u.id = c.author_id
       LEFT JOIN app_versions v ON v.id = c.version_id LEFT JOIN classes k ON k.id = c.class_id
      WHERE c.app_id = ? ORDER BY c.created_at DESC, c.rowid DESC LIMIT ?`,
    appId, limit + 1
  );
  return { rows: rows.slice(0, limit).reverse(), more: rows.length > limit };
}

/** Timeline of history rows. canDelete(row) / deleteAction(row) for the person's own comments. */
function historyTimeline(req, rows, { canDelete = () => false, deleteAction = () => '' } = {}) {
  const items = rows.map((r) => {
    const who = html`<strong>${r.author_name || 'Gelöschtes Konto'}</strong>`;
    const ver = r.version_number ? `Version ${r.version_number}` : 'eine gelöschte Version';
    const where = r.class_name || 'einer Klasse';
    const time = formatAgo(r.created_at);
    if (r.kind === 'submitted') return { mark: 'send', tone: 'wait', head: html`${who}<span>hat ${ver} in ${where} eingereicht</span>`, time, body: r.body || '' };
    if (r.kind === 'approved') return { mark: 'checkCircle', tone: 'ok', head: html`${who}<span>hat ${ver} für ${where} freigegeben</span>`, time, body: r.body || '' };
    if (r.kind === 'returned') return { mark: 'undo', tone: 'danger', head: html`${who}<span>hat ${ver} in ${where} zurückgegeben</span>`, time, body: r.body || '', bodyCls: 'returned' };
    const role = r.author_role === 'admin' ? 'Verwaltung' : r.author_role === 'teacher' ? 'Lehrkraft' : '';
    return {
      mark: 'message',
      head: html`${who}${role ? badge(role) : ''}${r.class_name ? html`<span class="meta">zu ${r.class_name}</span>` : ''}`,
      time,
      body: r.body,
      extra: canDelete(r) ? html`<div class="apps-comment-tools">${postButton(req, deleteAction(r), 'Kommentar löschen', { kind: 'quiet', size: 'sm', confirm: 'Kommentar löschen?\nDer Kommentar verschwindet für alle.', confirmLabel: 'Löschen' })}</div>` : '',
    };
  });
  return timeline(items);
}

function commentForm(req, action, { label = 'Kommentar schreiben', hint = '' } = {}) {
  return html`<form method="post" action="${action}" class="apps-comment">${csrfField(req)}
    ${field(req, { label, name: 'text', type: 'textarea', required: true, hint, attrs: 'maxlength="2000" rows="3"' })}
    <div class="actions"><button class="btn">${icon('send')}<span>Kommentar senden</span></button></div></form>`;
}

// ------------------------------------------------------- declared and stored

const USE_LABELS = {
  save: ['Spielstände', 'im Konto der Person; Lehrkräfte ihrer Klassen sehen sie'],
  results: ['Ergebnisse', 'die Lehrkraft der Klasse sieht sie'],
  leaderboard: ['Punkte für eine Bestenliste', 'Namen sehen nur Personen aus derselben Klasse'],
  progress: ['Fortschritt', 'sichtbar für die Person und die Lehrkraft'],
  achievements: ['Erfolge', 'nur die in schulhub.json erklärten'],
  files: ['Dateien, zum Beispiel Bilder', 'im Konto der Person, höchstens 1 MB pro Datei'],
  shared: ['Daten für alle, die die App nutzen', 'schreiben darf nur die Besitzerin oder der Besitzer'],
  classData: ['Daten für die Klasse', 'schreiben darf nur die Lehrkraft'],
  browser: ['Daten im Browser (localStorage)', 'bleiben auf dem Gerät; der Hub sieht und löscht sie nicht'],
};
const SETTING_TYPES = { text: 'Text', number: 'Zahl', boolean: 'Ja/Nein', choice: 'Auswahl', list: 'Liste', pairs: 'Paare' };

/** What the app declares in schulhub.json (achievements, settings) and what its code appears to store. */
function declaredView(manifest, report) {
  const achievements = (manifest && manifest.achievements) || [];
  const settings = (manifest && manifest.settings) || [];
  const uses = report && Array.isArray(report.uses) ? report.uses.filter((u) => Object.hasOwn(USE_LABELS, u)) : null;
  const settingSub = (s) => {
    const range = s.type === 'number' && (s.min !== null || s.max !== null) ? ` (${s.min ?? '…'} bis ${s.max ?? '…'})` : '';
    const cols = s.type === 'pairs' && Array.isArray(s.columns) ? ` (${s.columns.join(' / ')})` : '';
    return `${SETTING_TYPES[s.type] || s.type}${range}${cols}${s.help ? ` – ${s.help}` : ''}`;
  };
  return html`<div class="apps-declared">
    <div><h3>Speichert</h3>
      ${uses === null ? html`<p class="meta">Unbekannt – diese Version wurde vor der Prüfung hochgeladen.</p>`
        : uses.length ? list(uses.map((u) => row({ title: USE_LABELS[u][0], sub: USE_LABELS[u][1], start: html`<span class="apps-use">${icon(u === 'browser' ? 'hardDrive' : 'database')}</span>` })), 'bare')
        : html`<p class="meta">Im Code ist kein Speichern zu erkennen.</p>`}
      <p class="hint apps-hint">Ermittelt aus dem Code (z. B. <code>hub.save.set</code>) – ein Hinweis, keine Garantie.</p></div>
    <div><h3>Erfolge ${achievements.length ? html`<span class="count-text">${achievements.length}</span>` : ''}</h3>
      ${achievements.length ? list(achievements.slice(0, 50).map((a) => row({ title: a.title, sub: html`${a.description || ''}${a.secret ? html` ${badge('geheim')}` : ''}`, start: html`<span class="apps-emoji" aria-hidden="true">${a.emoji}</span>` })), 'bare')
        : html`<p class="meta">Keine.</p>`}</div>
    <div><h3>Einstellungen für Lehrkräfte ${settings.length ? html`<span class="count-text">${settings.length}</span>` : ''}</h3>
      ${settings.length ? list(settings.slice(0, 30).map((s) => row({ title: s.label, sub: settingSub(s), start: html`<span class="apps-use">${icon('sliders')}</span>` })), 'bare')
        : html`<p class="meta">Keine.</p>`}</div>
  </div>`;
}

// -------------------------------------------------------------------- diffs

const KIND_TEXT = {
  binary: 'Keine Textdatei – wird nicht verglichen.',
  large: 'Zu groß für den Vergleich (über 300 KB) – im Quelltext ansehen.',
  hub: 'Standard-Datei des Hubs: Der Hub liefert immer seine eigene Fassung aus.',
  budget: 'Nicht verglichen, weil sich insgesamt sehr viel geändert hat – im Quelltext ansehen.',
  toomany: 'Sehr viele Änderungen in dieser Datei – im Quelltext ansehen.',
  'same-text': 'Nur unsichtbare Änderungen (zum Beispiel Zeilenenden).',
};
const STATUS = { added: ['neu', 'ok'], removed: ['entfernt', 'danger'], changed: ['geändert', ''] };

function hunkView(h, showHead) {
  let o = h.oldStart;
  let n = h.newStart;
  const lines = [];
  for (const l of h.lines) {
    const t = l[0];
    const text = l.slice(1);
    if (t === '\\') continue; // "\ No newline at end of file"
    // Line numbers and the +/- marks are CSS content: they are shown, but not copied with the code.
    // Invisible characters (bidi controls ...) appear as marked placeholders, never raw.
    if (t === '+') lines.push(html`<span class="review-line review-add"><span class="review-ln"></span><span class="review-ln" data-n="${n++}"></span><span class="review-tx review-tx-add">${codeText(text)}</span></span>`);
    else if (t === '-') lines.push(html`<span class="review-line review-del"><span class="review-ln" data-n="${o++}"></span><span class="review-ln"></span><span class="review-tx review-tx-del">${codeText(text)}</span></span>`);
    else lines.push(html`<span class="review-line"><span class="review-ln" data-n="${o++}"></span><span class="review-ln" data-n="${n++}"></span><span class="review-tx">${codeText(text)}</span></span>`);
  }
  return html`${showHead ? html`<div class="review-hunk-head">ab Zeile ${h.newStart}</div>` : ''}<pre class="review-code"><code>${lines}</code></pre>`;
}

/**
 * The changes of a diff (src/versionDiff.js) as one disclosure per file. At
 * most `budget` lines are rendered in total; small files open by default.
 * sourceHref(path) links a file to the source viewer of the new version.
 */
function diffView(diff, { sourceHref = () => '', budget = 3000 } = {}) {
  let left = budget;
  if (!diff.files.length) return html`<p class="meta">Keine Datei hat sich geändert.</p>`;
  return html`<div class="review-files">${diff.files.map((f) => {
    const [label, tone] = STATUS[f.status];
    const counts = f.added || f.removed ? html`<span class="review-count"><span class="review-plus">+${f.added}</span><span class="review-minus">−${f.removed}</span></span>` : '';
    let body;
    let size = 0;
    if (f.status === 'removed') {
      body = html`<p class="review-note">Diese Datei gibt es in der neuen Version nicht mehr${f.removed ? ` (${plural(f.removed, 'Zeile', 'Zeilen')})` : ''}.</p>`;
    } else if (f.kind !== 'text') {
      const sizes = f.status === 'changed' ? `${formatBytes(f.oldSize)} → ${formatBytes(f.size)}` : formatBytes(f.size);
      body = html`<p class="review-note">${KIND_TEXT[f.kind] || ''} <span class="meta">${sizes}</span></p>`;
    } else {
      size = f.hunks.reduce((s, h) => s + h.lines.length, 0);
      if (size > left) {
        body = html`<p class="review-note">Nicht mehr angezeigt – die Seite wäre zu lang. ${sourceHref(f.path) ? html`<a href="${sourceHref(f.path)}">Datei im Quelltext öffnen</a>` : ''}</p>`;
        size = 0;
      } else {
        left -= size;
        body = html`<div class="review-diff" tabindex="0" role="region" aria-label="Änderungen in ${nameAttr(f.path)}">${f.hunks.map((h) => hunkView(h, f.status === 'changed'))}</div>`;
      }
    }
    const open = f.status !== 'removed' && size > 0 && size <= 120;
    const link = f.status !== 'removed' && sourceHref(f.path);
    return html`<details class="review-file"${open ? raw(' open') : ''}><summary>${badge(label, tone)}<code class="review-path">${nameText(f.path)}</code>${counts}</summary>
      ${body}${link && f.kind === 'text' ? html`<p class="review-filelink"><a href="${link}">${icon('fileCode', { cls: 'sm' })}Ganze Datei ansehen</a></p>` : ''}</details>`;
  })}</div>`;
}

/** First submission: no earlier version to compare with - the files of the version. */
function fileListView(files, { sourceHref = () => '', isText = () => false, limit = 200 } = {}) {
  const shown = files.slice(0, limit);
  return html`${list(shown.map((f) => row({
    title: html`<code class="review-path">${nameText(f.path)}</code>`,
    sub: formatBytes(f.size),
    href: isText(f.path) ? sourceHref(f.path) : '',
    chevron: false,
  })), 'apps-filelist')}${files.length > limit ? html`<p class="meta mt-2">… und ${plural(files.length - limit, 'weitere Datei', 'weitere Dateien')}.</p>` : ''}`;
}

module.exports = {
  parseReport, reportCounts, reportBadges, reportTone, reportList,
  historyRows, historyTimeline, commentForm, declaredView, diffView, fileListView, USE_LABELS,
  codeText, nameText, nameAttr,
};
