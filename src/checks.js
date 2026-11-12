'use strict';
// Checks that run once when an upload (or an editor version) is finished.
// They READ uploaded files as text - nothing is ever executed, imported or
// evaluated - and produce a report for the author and for reviewing teachers.
// The optional schulhub.json manifest is parsed and validated here.
//
// Report shape (stored as JSON on the version):
//   { items: [{ level: 'error' | 'warning' | 'note', text, file?, line? }],
//     stats: { files, bytes },
//     manifest: { achievements, settings } | null,
//     uses: ['save', 'results', ...] }   // SDK features the code appears to use (a hint, not a guarantee)
//
// Everything here works on plain strings with bounded regular expressions
// (no nested or unbounded quantifiers that could backtrack badly), within a
// budget of files and bytes, so a hostile upload cannot make the server slow.

const { parseManifest } = require('./manifest');
const { formatBytes } = require('./util');

const MAX_SCAN_BYTES = 512 * 1024; // per file: larger files are not read
const MAX_SCAN_FILES = 400; // per version
const MAX_SCAN_TOTAL = 4 * 1024 * 1024; // per version
const BIG_FILE = 5 * 1024 * 1024; // "this takes long on school Wi-Fi"
const PER_RULE_AND_FILE = 5; // the same finding in one file is reported this often, then summed up
const MAX_ITEMS = 200;

const HTML = new Set(['html', 'htm']);
const SCRIPT = new Set(['js', 'mjs']);
const STYLE = new Set(['css']);
// The Hub serves its own copy of these, whatever was uploaded under the name (see appsHost.js).
const HUB_FILES = new Set(['hub-sdk.js', 'hub-ui.css']);

const extOf = (p) => {
  const base = p.slice(p.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
};
const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);
/** True for files the Hub replaces with its own (hub-sdk.js, hub-ui.css - in any folder). */
const isHubFile = (p) => HUB_FILES.has(baseName(p));

// A URL that leaves the app's own origin: http(s)://… or protocol-relative //host.
const EXT = String.raw`(?:https?:)?\/\/[^\s"'<>()\x60]{1,300}`;
const ABS = String.raw`\/(?!\/)[^\s"'<>()\x60]{0,300}`;

// [rule, level, regex, text(match)] - every quantifier is bounded.
const HTML_RULES = [
  ['ext-script', 'error', new RegExp(String.raw`<script\b[^>]{0,800}?\bsrc\s{0,20}=\s{0,20}["']?\s{0,20}(${EXT})`, 'gi'),
    (u) => `Das Skript „${u}“ kommt aus dem Internet und wird im Hub blockiert – die App funktioniert dann nicht. Lade die Datei herunter und lege sie in deinen App-Ordner.`],
  ['ext-link', 'error', new RegExp(String.raw`<link\b[^>]{0,800}?\bhref\s{0,20}=\s{0,20}["']?\s{0,20}(${EXT})`, 'gi'),
    (u) => `„${u}“ (zum Beispiel eine Schrift oder ein Stylesheet) kommt aus dem Internet und wird im Hub blockiert. Lege die Datei in deinen App-Ordner.`],
  ['ext-media', 'warning', new RegExp(String.raw`<(?:img|audio|video|source|track|iframe|embed|object|input)\b[^>]{0,800}?\b(?:src|data|poster)\s{0,20}=\s{0,20}["']?\s{0,20}(${EXT})`, 'gi'),
    (u) => `„${u}“ kommt aus dem Internet und wird im Hub nicht geladen. Lege die Datei in deinen App-Ordner.`],
  ['ext-anchor', 'note', new RegExp(String.raw`<a\b[^>]{0,800}?\bhref\s{0,20}=\s{0,20}["']?\s{0,20}(${EXT})`, 'gi'),
    (u) => `Der Link „${u}“ führt ins Internet. In Apps im Hub lassen sich solche Links nicht öffnen.`],
  ['abs-attr', 'warning', new RegExp(String.raw`<[a-z][a-z0-9-]{0,30}\b[^>]{0,800}?\b(?:src|href)\s{0,20}=\s{0,20}["']?\s{0,20}(${ABS})`, 'gi'),
    (p) => absText(p)],
];
const STYLE_RULES = [
  ['ext-url', 'warning', new RegExp(String.raw`(?<!@import\s{0,20})url\(\s{0,20}["']?\s{0,20}(${EXT})`, 'gi'),
    (u) => `„${u}“ wird im Hub nicht geladen (Apps dürfen nichts aus dem Internet laden). Lege die Datei in deinen App-Ordner.`],
  ['ext-import', 'warning', new RegExp(String.raw`@import\s{1,20}(?:url\(\s{0,20}["']?|["'])\s{0,20}(${EXT})`, 'gi'),
    (u) => `@import von „${u}“ wird im Hub blockiert. Lege die Datei in deinen App-Ordner.`],
  ['abs-url', 'warning', new RegExp(String.raw`url\(\s{0,20}["']?\s{0,20}(${ABS})`, 'gi'), (p) => absText(p)],
];
const SCRIPT_RULES = [
  ['ext-fetch', 'warning', new RegExp(String.raw`\bfetch\s{0,20}\(\s{0,20}["'\x60]\s{0,20}(${EXT})`, 'g'),
    (u) => `fetch() an „${u}“ wird im Hub blockiert: Apps dürfen keine Daten ins Internet schicken oder von dort laden.`],
  ['ext-esimport', 'warning', new RegExp(String.raw`\bimport\b[^'"\x60;\n]{0,200}?["'\x60]\s{0,20}(${EXT})`, 'g'),
    (u) => `import von „${u}“ wird im Hub blockiert. Lege die Datei in deinen App-Ordner und importiere sie mit einem relativen Pfad.`],
  ['abs-fetch', 'warning', new RegExp(String.raw`\bfetch\s{0,20}\(\s{0,20}["'\x60](${ABS})`, 'g'), (p) => absText(p)],
];

function absText(p) {
  const rel = p.replace(/^\/+/, '') || 'index.html';
  return `Absoluter Pfad „${p}“: Im Hub funktionieren nur relative Pfade. Schreib „${rel}“ (ohne / am Anfang).`;
}

// SDK features the code seems to use, for "what this app stores" in the review.
const USES = [
  ['save', /\.save\s{0,5}\.\s{0,5}set\s{0,5}\(/],
  ['results', /\.results\s{0,5}\.\s{0,5}add\s{0,5}\(/],
  ['leaderboard', /\.leaderboard\s{0,5}\.\s{0,5}submit\s{0,5}\(/],
  ['progress', /\.progress\s{0,5}\.\s{0,5}set\s{0,5}\(/],
  ['achievements', /\.achievements\s{0,5}\.\s{0,5}unlock\s{0,5}\(/],
  ['files', /\.files\s{0,5}\.\s{0,5}put\s{0,5}\(/],
  ['shared', /\.shared\s{0,5}\.\s{0,5}set\s{0,5}\(/],
  ['classData', /\.classData\s{0,5}\.\s{0,5}set\s{0,5}\(/],
  ['browser', /\b(?:localStorage|sessionStorage|indexedDB)\b/],
];

/** Index of the first character of every line, for turning a match position into a line number. */
function lineStarts(text) {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}
function lineOf(starts, index) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * Inline <script> blocks (without src) or <style> blocks of an HTML text.
 * Found with simple global searches from a moving position, so the work is
 * linear in the size of the text however the tags are nested or broken.
 */
function blocks(text, tag) {
  const out = [];
  const openRe = new RegExp(`<${tag}\\b`, 'gi');
  const closeRe = new RegExp(`</${tag}`, 'gi');
  let from = 0;
  while (out.length < 200) {
    openRe.lastIndex = from;
    const open = openRe.exec(text);
    if (!open) break;
    const end = text.indexOf('>', open.index);
    if (end === -1) break;
    closeRe.lastIndex = end;
    const close = closeRe.exec(text);
    const stop = close ? close.index : text.length;
    if (tag !== 'script' || !/\bsrc\s{0,20}=/i.test(text.slice(open.index, end))) out.push({ start: end + 1, text: text.slice(end + 1, stop) });
    from = stop + 1;
  }
  return out;
}

function analyzeVersion(ctx, version) {
  const { uploads } = ctx;
  const files = uploads.listFiles(version.id);
  const items = [];
  const add = (level, text, extra = {}) => {
    if (items.length < MAX_ITEMS) items.push({ level, text, ...extra });
  };

  // ----- schulhub.json (validated in manifest.js) -----
  let manifest = null;
  const mf = files.find((f) => f.path === 'schulhub.json');
  if (mf) {
    if (mf.size > 64 * 1024) add('error', 'schulhub.json ist zu groß (höchstens 64 KB) und wird nicht verwendet.', { file: mf.path });
    else {
      const parsed = parseManifest(uploads.readBlob(mf.sha256).toString('utf8'));
      manifest = parsed.manifest;
      for (const e of parsed.errors) add('error', e, { file: mf.path });
      for (const w of parsed.warnings) add('warning', w, { file: mf.path });
    }
  }

  // ----- the code itself, read as text -----
  const uses = new Set();
  let usesConnect = null; // first place that calls Hub.connect
  let usesLocalStorage = null; // first place that uses localStorage
  let loadsSdk = false;
  let scanned = 0;
  let scannedBytes = 0;
  let skipped = 0;

  for (const f of files) {
    if (f.size > BIG_FILE) add('note', `„${f.path}“ ist ${formatBytes(f.size)} groß. Große Dateien laden im Schul-WLAN lange – vielleicht geht es kleiner.`, { file: f.path });
    const ext = extOf(f.path);
    const kind = HTML.has(ext) ? 'html' : SCRIPT.has(ext) ? 'script' : STYLE.has(ext) ? 'style' : null;
    if (!kind || isHubFile(f.path)) continue; // binary or not code; the Hub's own files are never used anyway
    if (f.size > MAX_SCAN_BYTES || scanned >= MAX_SCAN_FILES || scannedBytes + f.size > MAX_SCAN_TOTAL) {
      skipped++;
      continue;
    }
    const text = uploads.readBlob(f.sha256).toString('utf8');
    scanned++;
    scannedBytes += f.size;
    if (text.includes('\u0000')) continue; // not really text
    const starts = lineStarts(text);
    const counts = new Map();
    const report = (rule, level, message, index) => {
      const n = (counts.get(rule) || 0) + 1;
      counts.set(rule, n);
      if (n <= PER_RULE_AND_FILE) add(level, message, { file: f.path, line: lineOf(starts, index) });
    };
    const run = (rules, source, offset) => {
      for (const [rule, level, re, text_] of rules) {
        re.lastIndex = 0;
        for (const m of source.matchAll(re)) report(rule, level, text_(m[1].trim()), offset + m.index);
      }
    };
    const scripts = kind === 'html' ? blocks(text, 'script') : kind === 'script' ? [{ start: 0, text }] : [];

    if (kind === 'html') {
      run(HTML_RULES, text, 0);
      run(STYLE_RULES, text, 0); // <style> blocks and style="…" attributes
      if (/<script\b[^>]{0,800}?\bsrc\s{0,20}=\s{0,20}["']?[^"'\s>]{0,300}hub-sdk\.js/i.test(text)) loadsSdk = true;
      if (f.path === 'index.html') {
        if (!/<meta\b[^>]{0,800}?\bname\s{0,20}=\s{0,20}["']?viewport/i.test(text)) {
          add('warning', 'In index.html fehlt <meta name="viewport" content="width=device-width, initial-scale=1">. Ohne diese Zeile ist die App auf Handys winzig.', { file: f.path });
        }
        if (!/<title\b[^>]{0,200}>\s{0,50}[^\s<]/i.test(text)) add('note', 'index.html hat keinen <title>. Ein Titel hilft, die App im Browser wiederzufinden.', { file: f.path });
      }
    }
    if (kind === 'style') run(STYLE_RULES, text, 0);
    for (const s of scripts) {
      run(SCRIPT_RULES, s.text, s.start);
      const ls = /\blocalStorage\b/.exec(s.text);
      if (ls && !usesLocalStorage) usesLocalStorage = { file: f.path, line: lineOf(starts, s.start + ls.index) };
      const hc = /\bHub\s{0,5}\.\s{0,5}connect\s{0,5}\(/.exec(s.text);
      if (hc && !usesConnect) usesConnect = { file: f.path, line: lineOf(starts, s.start + hc.index) };
      for (const [key, re] of USES) if (re.test(s.text)) uses.add(key);
    }
    for (const n of counts.values()) {
      if (n > PER_RULE_AND_FILE) add('note', `… und ${n - PER_RULE_AND_FILE} weitere Stellen dieser Art in „${f.path}“.`, { file: f.path });
    }
  }

  if (usesLocalStorage) {
    add('note', 'localStorage funktioniert, speichert aber nur auf diesem einen Gerät. hub.save speichert im Konto – auf jedem Gerät, an dem sich die Person anmeldet.', usesLocalStorage);
  }
  if (usesConnect && !loadsSdk) {
    add('warning', 'Hub.connect() wird benutzt, aber keine Seite lädt hub-sdk.js. Füge <script src="hub-sdk.js"></script> vor deinem eigenen Skript ein.', usesConnect);
  }
  if (skipped) add('note', `${skipped === 1 ? 'Eine Datei wurde' : `${skipped} Dateien wurden`} nicht geprüft, weil sie sehr groß ${skipped === 1 ? 'ist' : 'sind'} oder die App sehr viele Dateien hat.`);

  const order = { error: 0, warning: 1, note: 2 };
  items.sort((a, b) => order[a.level] - order[b.level]);

  return {
    manifest,
    report: {
      items,
      stats: { files: files.length, bytes: files.reduce((n, f) => n + f.size, 0) },
      manifest: manifest ? { achievements: manifest.achievements.length, settings: manifest.settings.length } : null,
      uses: [...uses],
    },
  };
}

module.exports = { analyzeVersion, isHubFile, extOf };
