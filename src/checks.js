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
// Speed is part of the security model: this runs synchronously while an upload
// finishes (services.finishVersion), so a hostile upload must not be able to
// stall the Hub. Therefore:
//  - HTML is read in ONE linear pass (scanHtml): a hand-written scanner splits
//    each tag into its attributes once, and a tag that does not end is skipped
//    from where its scan stopped - every character is looked at a bounded
//    number of times, however broken the markup is.
//  - Scripts and style sheets are searched with simple patterns whose parts
//    cannot overlap, and every look-ahead after a match is bounded and never
//    revisited.
//  - A hard time budget per version (BUDGET_MS, checked inside the scan): when
//    it is used up, the check stops and the report says so.

const { parseManifest } = require('./manifest');
const { formatBytes } = require('./util');

const MAX_SCAN_BYTES = 512 * 1024; // per file: larger files are not read
const MAX_SCAN_FILES = 400; // per version
const MAX_SCAN_TOTAL = 4 * 1024 * 1024; // per version
const BUDGET_MS = 40; // per version: the check never blocks the Hub much longer than this
const MAX_TAG = 4096; // characters of one tag that are looked at
const MAX_ATTRS = 64; // attributes of one tag that are looked at
const BIG_FILE = 5 * 1024 * 1024; // "this takes long on school Wi-Fi"
const PER_RULE_AND_FILE = 5; // the same finding in one file is reported this often, then summed up
const MAX_ITEMS = 200;

const HTML = new Set(['html', 'htm']);
const SCRIPT = new Set(['js', 'mjs']);
const STYLE = new Set(['css']);
const MEDIA = new Set(['img', 'audio', 'video', 'source', 'track', 'iframe', 'embed', 'object', 'input']);
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

// ---------------------------------------------------------------- texts
const TEXTS = {
  'ext-script': (u) => `Das Skript „${u}“ kommt aus dem Internet und wird im Hub blockiert – die App funktioniert dann nicht. Lade die Datei herunter und lege sie in deinen App-Ordner.`,
  'ext-link': (u) => `„${u}“ (zum Beispiel eine Schrift oder ein Stylesheet) kommt aus dem Internet und wird im Hub blockiert. Lege die Datei in deinen App-Ordner.`,
  'ext-media': (u) => `„${u}“ kommt aus dem Internet und wird im Hub nicht geladen. Lege die Datei in deinen App-Ordner.`,
  'ext-anchor': (u) => `Der Link „${u}“ führt ins Internet. In Apps im Hub lassen sich solche Links nicht öffnen.`,
  'ext-url': (u) => `„${u}“ wird im Hub nicht geladen (Apps dürfen nichts aus dem Internet laden). Lege die Datei in deinen App-Ordner.`,
  'ext-import': (u) => `@import von „${u}“ wird im Hub blockiert. Lege die Datei in deinen App-Ordner.`,
  'ext-fetch': (u) => `fetch() an „${u}“ wird im Hub blockiert: Apps dürfen keine Daten ins Internet schicken oder von dort laden.`,
  'ext-esimport': (u) => `import von „${u}“ wird im Hub blockiert. Lege die Datei in deinen App-Ordner und importiere sie mit einem relativen Pfad.`,
  absolute: (p) => `Absoluter Pfad „${p}“: Im Hub funktionieren nur relative Pfade. Schreib „${p.replace(/^\/+/, '') || 'index.html'}“ (ohne / am Anfang).`,
};

// ------------------------------------------------------------- helpers
const isSpace = (c) => c === 32 || c === 9 || c === 10 || c === 13 || c === 12;
const isLetter = (c) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90);
const isNameChar = (c) => isLetter(c) || (c >= 48 && c <= 57) || c === 45 || c === 58 || c === 95;

/** 'external' (http(s)://… or //host), 'absolute' (/path) or '' for a URL as written in a file. */
function urlKind(value) {
  const v = value.trimStart().slice(0, 10).toLowerCase();
  if (v.startsWith('//') || v.startsWith('http://') || v.startsWith('https://')) return 'external';
  return v.startsWith('/') ? 'absolute' : '';
}
/** The URL as shown in a finding: up to the first space, at most 300 characters. */
const shownUrl = (value) => value.trim().split(/\s/, 1)[0].slice(0, 300);

/** Index of the first character of every line, for turning a position into a line number. */
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
 * One linear pass over an HTML text. Calls onTag(name, attrs, end) for every
 * start tag, with attrs = [{ name, value, at }] (at = index of the value), and
 * onBlock(kind, start, end) for the content of <script> without src and of
 * <style>. Comments are skipped. Returns false if the deadline passed.
 */
function scanHtml(text, onTag, onBlock, deadline) {
  const n = text.length;
  const closer = { script: /<\/script/gi, style: /<\/style/gi };
  let i = 0;
  let tags = 0;
  let checkedAt = 0;
  while (i < n) {
    if (++tags % 256 === 0 || i - checkedAt > 65536) {
      checkedAt = i;
      if (Date.now() > deadline) return false;
    }
    const lt = text.indexOf('<', i);
    if (lt === -1 || lt + 1 >= n) break;
    const c = text.charCodeAt(lt + 1);
    if (c === 33) { // <!-- comment --> or <!doctype …>
      const comment = text.startsWith('<!--', lt);
      const close = comment ? text.indexOf('-->', lt + 4) : text.indexOf('>', lt + 2);
      i = close === -1 ? n : close + (comment ? 3 : 1);
      continue;
    }
    if (!isLetter(c)) {
      i = lt + 1;
      continue;
    }
    let k = lt + 1;
    while (k < n && k - lt < 64 && isNameChar(text.charCodeAt(k))) k++;
    const name = text.slice(lt + 1, k).toLowerCase();
    const limit = Math.min(n, lt + MAX_TAG);
    const attrs = [];
    let closed = false;
    while (k < limit) {
      const ch = text.charCodeAt(k);
      if (ch === 62) { // >
        closed = true;
        k++;
        break;
      }
      if (isSpace(ch) || ch === 47 || ch === 61) { // space, "/" or a stray "="
        k++;
        continue;
      }
      const ns = k;
      while (k < limit) {
        const x = text.charCodeAt(k);
        if (isSpace(x) || x === 61 || x === 62 || x === 47) break;
        k++;
      }
      const attr = text.slice(ns, k).toLowerCase();
      let m = k;
      while (m < limit && isSpace(text.charCodeAt(m))) m++;
      if (m >= limit || text.charCodeAt(m) !== 61) { // an attribute without a value
        if (attrs.length < MAX_ATTRS) attrs.push({ name: attr, value: '', at: ns });
        k = m;
        continue;
      }
      m++;
      while (m < limit && isSpace(text.charCodeAt(m))) m++;
      const q = m < limit ? text.charCodeAt(m) : 0;
      let vs = m;
      let ve = m;
      if (q === 34 || q === 39) { // "…" or '…'
        vs = m + 1;
        ve = vs;
        while (ve < limit && text.charCodeAt(ve) !== q) ve++;
        k = ve < limit ? ve + 1 : limit;
      } else {
        while (ve < limit) {
          const x = text.charCodeAt(ve);
          if (isSpace(x) || x === 62) break;
          ve++;
        }
        k = ve;
      }
      if (attrs.length < MAX_ATTRS) attrs.push({ name: attr, value: text.slice(vs, Math.min(ve, vs + 2048)), at: vs });
    }
    onTag(name, attrs, k);
    i = k; // after the tag - or where an endless tag stopped being read: nothing is read twice
    if (closed && (name === 'script' || name === 'style')) {
      const re = closer[name];
      re.lastIndex = k;
      const close = re.exec(text);
      const end = close ? close.index : n;
      if (name === 'style' || !attrs.some((a) => a.name === 'src')) onBlock(name, k, end);
      i = Math.max(end, k);
    }
  }
  return true;
}

// ------------------------------------------------- scripts and style sheets
const JS_FETCH = /\bfetch\s*\(\s*(["'`])/g;
const JS_IMPORT = /\bimport\b/g;
const JS_CONNECT = /\bHub\s*\.\s*connect\s*\(/;
const JS_LOCAL = /\blocalStorage\b/;
const JS_BROWSER = /\b(?:localStorage|sessionStorage|indexedDB)\b/;
const JS_USES = /\.(save|results|leaderboard|progress|achievements|files|shared|classData)\s*\.\s*(set|add|submit|unlock|put)\s*\(/g;
// SDK feature -> the call that stores something
const USES = { save: 'set', results: 'add', leaderboard: 'submit', progress: 'set', achievements: 'unlock', files: 'put', shared: 'set', classData: 'set' };
const CSS_REF = /(@import\s+)?url\(\s*(["']?)|@import\s+(["'])/gi;

/** End of a quoted string literal starting at `start` (bounded). */
function literalEnd(s, start, quote, max = 300) {
  const lim = Math.min(s.length, start + max);
  let e = start;
  while (e < lim && s[e] !== quote && s[e] !== '\n') e++;
  return e;
}

/** Findings in JavaScript (a .js file or an inline <script>), positions relative to `offset`. */
function scriptChecks(js, offset, report, seen) {
  JS_FETCH.lastIndex = 0;
  for (let m = JS_FETCH.exec(js); m; m = JS_FETCH.exec(js)) {
    const start = m.index + m[0].length;
    const end = literalEnd(js, start, m[1]);
    const value = js.slice(start, end);
    const kind = urlKind(value);
    if (kind === 'external') report('ext-fetch', 'warning', TEXTS['ext-fetch'](shownUrl(value)), offset + m.index);
    else if (kind === 'absolute') report('abs-fetch', 'warning', TEXTS.absolute(shownUrl(value)), offset + m.index);
    JS_FETCH.lastIndex = Math.max(JS_FETCH.lastIndex, end);
  }
  JS_IMPORT.lastIndex = 0;
  let after = 0;
  for (let m = JS_IMPORT.exec(js); m; m = JS_IMPORT.exec(js)) {
    if (m.index < after) continue;
    const lim = Math.min(js.length, m.index + 206);
    let q = m.index + 6;
    while (q < lim && !'"\'`;\n'.includes(js[q])) q++;
    after = lim;
    if (q < lim && '"\'`'.includes(js[q])) {
      const end = literalEnd(js, q + 1, js[q]);
      const value = js.slice(q + 1, end);
      if (urlKind(value) === 'external') report('ext-esimport', 'warning', TEXTS['ext-esimport'](shownUrl(value)), offset + m.index);
      after = Math.max(after, end);
    }
  }
  if (!seen.connect) {
    const hc = JS_CONNECT.exec(js);
    if (hc) seen.connect = { at: offset + hc.index, report };
  }
  if (!seen.localStorage) {
    const ls = JS_LOCAL.exec(js);
    if (ls) seen.localStorage = { at: offset + ls.index, report };
  }
  if (JS_BROWSER.test(js)) seen.uses.add('browser');
  JS_USES.lastIndex = 0;
  for (let m = JS_USES.exec(js); m; m = JS_USES.exec(js)) if (USES[m[1]] === m[2]) seen.uses.add(m[1]);
}

/** Findings in CSS (a .css file, a <style> block or a style="…" attribute). */
function styleChecks(css, offset, report) {
  CSS_REF.lastIndex = 0;
  for (let m = CSS_REF.exec(css); m; m = CSS_REF.exec(css)) {
    const isImport = Boolean(m[1]) || m[3] !== undefined;
    const quote = m[2] || m[3] || '';
    const start = m.index + m[0].length;
    const lim = Math.min(css.length, start + 300);
    let end = start;
    if (quote) end = literalEnd(css, start, quote);
    else while (end < lim && css[end] !== ')' && !/\s/.test(css[end])) end++;
    const value = css.slice(start, end);
    const kind = urlKind(value);
    if (kind === 'external') report(isImport ? 'ext-import' : 'ext-url', 'warning', TEXTS[isImport ? 'ext-import' : 'ext-url'](shownUrl(value)), offset + m.index);
    else if (kind === 'absolute' && !isImport) report('abs-url', 'warning', TEXTS.absolute(shownUrl(value)), offset + m.index);
    CSS_REF.lastIndex = Math.max(CSS_REF.lastIndex, end);
  }
}

// ------------------------------------------------------------------ main

function analyzeVersion(ctx, version, { budgetMs = BUDGET_MS } = {}) {
  const { uploads } = ctx;
  const deadline = Date.now() + budgetMs;
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
  for (const f of files) {
    if (f.size > BIG_FILE) add('note', `„${f.path}“ ist ${formatBytes(f.size)} groß. Große Dateien laden im Schul-WLAN lange – vielleicht geht es kleiner.`, { file: f.path });
  }

  // ----- the code itself, read as text -----
  const seen = { uses: new Set(), connect: null, localStorage: null };
  let loadsSdk = false;
  let scanned = 0;
  let scannedBytes = 0;
  let skipped = 0;
  let stopped = false;

  for (const f of files) {
    const ext = extOf(f.path);
    const kind = HTML.has(ext) ? 'html' : SCRIPT.has(ext) ? 'script' : STYLE.has(ext) ? 'style' : null;
    if (!kind || isHubFile(f.path)) continue; // binary or not code; the Hub's own files are never used anyway
    if (Date.now() > deadline) {
      stopped = true;
      break;
    }
    if (f.size > MAX_SCAN_BYTES || scanned >= MAX_SCAN_FILES || scannedBytes + f.size > MAX_SCAN_TOTAL) {
      skipped++;
      continue;
    }
    const text = uploads.readBlob(f.sha256).toString('utf8');
    scanned++;
    scannedBytes += f.size;
    if (text.includes('\u0000')) continue; // not really text
    let starts = null;
    const line = (index) => lineOf(starts || (starts = lineStarts(text)), index);
    const counts = new Map();
    const report = (rule, level, message, index) => {
      const count = (counts.get(rule) || 0) + 1;
      counts.set(rule, count);
      if (count <= PER_RULE_AND_FILE) add(level, message, { file: f.path, line: line(index) });
    };
    report.line = line;
    report.file = f.path;

    if (kind === 'html') {
      const flags = { viewport: false, title: false };
      const ok = scanHtml(
        text,
        (name, attrs, end) => {
          for (const a of attrs) {
            const urlAttr = a.name === 'src' || a.name === 'href' || a.name === 'data' || a.name === 'poster';
            const target = urlAttr ? urlKind(a.value) : '';
            if (target === 'external') {
              const u = shownUrl(a.value);
              if (name === 'script' && a.name === 'src') report('ext-script', 'error', TEXTS['ext-script'](u), a.at);
              else if (name === 'link' && a.name === 'href') report('ext-link', 'error', TEXTS['ext-link'](u), a.at);
              else if (MEDIA.has(name) && a.name !== 'href') report('ext-media', 'warning', TEXTS['ext-media'](u), a.at);
              else if (name === 'a' && a.name === 'href') report('ext-anchor', 'note', TEXTS['ext-anchor'](u), a.at);
            } else if (target === 'absolute' && (a.name === 'src' || a.name === 'href')) {
              report('abs-attr', 'warning', TEXTS.absolute(shownUrl(a.value)), a.at);
            }
            if (a.name === 'style' && a.value) styleChecks(a.value, a.at, report);
            if (name === 'script' && a.name === 'src' && /hub-sdk\.js/i.test(a.value)) loadsSdk = true;
            if (name === 'meta' && a.name === 'name' && a.value.trim().toLowerCase() === 'viewport') flags.viewport = true;
          }
          if (name === 'title' && /^\s{0,50}[^\s<]/.test(text.slice(end, end + 60))) flags.title = true;
        },
        (block, start, end) => {
          const body = text.slice(start, end);
          if (block === 'script') scriptChecks(body, start, report, seen);
          else styleChecks(body, start, report);
        },
        deadline
      );
      if (!ok) {
        stopped = true;
        break;
      }
      if (f.path === 'index.html') {
        if (!flags.viewport) add('warning', 'In index.html fehlt <meta name="viewport" content="width=device-width, initial-scale=1">. Ohne diese Zeile ist die App auf Handys winzig.', { file: f.path });
        if (!flags.title) add('note', 'index.html hat keinen <title>. Ein Titel hilft, die App im Browser wiederzufinden.', { file: f.path });
      }
    } else if (kind === 'script') {
      scriptChecks(text, 0, report, seen);
    } else {
      styleChecks(text, 0, report);
    }
    for (const n of counts.values()) {
      if (n > PER_RULE_AND_FILE) add('note', `… und ${n - PER_RULE_AND_FILE} weitere Stellen dieser Art in „${f.path}“.`, { file: f.path });
    }
  }

  const where = (hit) => ({ file: hit.report.file, line: hit.report.line(hit.at) });
  if (seen.localStorage) {
    add('note', 'localStorage funktioniert, speichert aber nur auf diesem einen Gerät. hub.save speichert im Konto – auf jedem Gerät, an dem sich die Person anmeldet.', where(seen.localStorage));
  }
  if (seen.connect && !loadsSdk && !stopped) {
    add('warning', 'Hub.connect() wird benutzt, aber keine Seite lädt hub-sdk.js. Füge <script src="hub-sdk.js"></script> vor deinem eigenen Skript ein.', where(seen.connect));
  }
  if (stopped) add('note', 'Prüfung abgebrochen – zu große Dateien: Die Prüfung hat ihre Zeit aufgebraucht, nicht alle Dateien wurden geprüft.');
  else if (skipped) add('note', `${skipped === 1 ? 'Eine Datei wurde' : `${skipped} Dateien wurden`} nicht geprüft, weil sie sehr groß ${skipped === 1 ? 'ist' : 'sind'} oder die App sehr viele Dateien hat.`);

  const order = { error: 0, warning: 1, note: 2 };
  items.sort((a, b) => order[a.level] - order[b.level]);

  return {
    manifest,
    report: {
      items,
      stats: { files: files.length, bytes: files.reduce((n, f) => n + f.size, 0) },
      manifest: manifest ? { achievements: manifest.achievements.length, settings: manifest.settings.length } : null,
      uses: [...seen.uses],
    },
  };
}

module.exports = { analyzeVersion, isHubFile, extOf, BUDGET_MS };
