// Entry point for public/vendor/codemirror.js (built by build-codemirror.mjs).
//
// Exposes exactly one global, window.HubEditor. The bundle carries no colour
// theme: the Hub styles the editor from its own stylesheet using CodeMirror's
// class names (.cm-editor, .cm-gutters, ...) and the tok-* token classes below.

import { StyleModule } from 'style-mod';
import { EditorState, Compartment, Prec } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars,
  drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightActiveLine,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  indentOnInput, syntaxHighlighting, HighlightStyle, bracketMatching, foldGutter, foldKeymap,
} from '@codemirror/language';
import {
  autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap,
} from '@codemirror/autocomplete';
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { tags as t } from '@lezer/highlight';

// ---------- CSP-safe style injection ----------
//
// CodeMirror injects its structural base styles through style-mod. For a
// Document, style-mod 4.1 writes them into a <style> element, which the Hub's
// CSP (style-src 'self', no 'unsafe-inline') blocks. We replace
// StyleModule.mount (public API) so the rules go into a constructed stylesheet
// adopted by the document instead; CSP does not apply to CSSOM. All rules sit
// in the cascade layer "codemirror", so any unlayered rule in hub.css wins over
// them regardless of selector specificity.
//
// Fallback for browsers without constructable stylesheets (Safari < 16.4,
// Firefox < 101): insert the same block into the first same-origin stylesheet
// already linked by the page, again via CSSOM. Only if neither works do we hand
// over to style-mod's own <style> path (which the CSP will then block).

const LAYER = 'codemirror';
const styleModMount = StyleModule.mount;
const styleSets = new WeakMap(); // Document -> { modules, write(css), attach(root) }

// Same ordering rules as style-mod's StyleSet.mount: later modules win, an
// already mounted module that now appears earlier is moved.
function addModules(list, modules) {
  let j = 0;
  let changed = false;
  for (const mod of modules) {
    let index = list.indexOf(mod);
    if (index > -1 && index < j) {
      list.splice(index, 1);
      j--;
      index = -1;
      changed = true;
    }
    if (index === -1) {
      list.splice(j++, 0, mod);
      changed = true;
    } else {
      j = index + 1;
    }
  }
  return changed;
}

function wrapRules(win, modules) {
  const rules = modules.map((m) => m.getRules()).filter(Boolean).join('\n');
  // @layer needs Chrome 99 / Firefox 97 / Safari 15.4. Older engines get a
  // neutral grouping rule instead (then hub.css needs more specific selectors).
  const block = typeof win.CSSLayerBlockRule === 'function' ? `@layer ${LAYER}` : '@media all';
  return `${block} {\n${rules}\n}`;
}

function adoptedSet(doc, win) {
  if (!win.CSSStyleSheet || !('adoptedStyleSheets' in doc)) return null;
  let sheet;
  try {
    sheet = new win.CSSStyleSheet();
    if (typeof sheet.replaceSync !== 'function') return null;
  } catch {
    return null;
  }
  return {
    modules: [],
    write(text) { sheet.replaceSync(text); },
    attach(root) {
      if (!root.adoptedStyleSheets) return;
      if (!root.adoptedStyleSheets.includes(sheet)) {
        root.adoptedStyleSheets = [sheet, ...root.adoptedStyleSheets];
      }
    },
  };
}

function linkedSheetSet(doc) {
  let target = null;
  for (const sheet of Array.from(doc.styleSheets)) {
    try {
      if (!sheet.disabled && sheet.cssRules) { target = sheet; break; }
    } catch { /* cross-origin sheet: rules not readable */ }
  }
  if (!target) return null;
  let own = null;
  return {
    modules: [],
    write(text) {
      if (own) {
        const old = Array.prototype.indexOf.call(target.cssRules, own);
        if (old > -1) target.deleteRule(old);
      }
      let at = 0;
      try {
        target.insertRule(text, 0);
      } catch {
        at = target.cssRules.length; // e.g. the sheet starts with @import
        target.insertRule(text, at);
      }
      own = target.cssRules[at];
    },
    attach() {},
  };
}

StyleModule.mount = function mount(root, modules, options) {
  const doc = root.ownerDocument || root;
  const win = doc.defaultView;
  let set = styleSets.get(doc);
  if (!set && win) {
    set = adoptedSet(doc, win) || (root === doc ? linkedSheetSet(doc) : null);
    if (set) styleSets.set(doc, set);
  }
  if (!set) return styleModMount.call(this, root, modules, options);
  if (addModules(set.modules, Array.isArray(modules) ? modules : [modules])) {
    set.write(wrapRules(win, set.modules));
  }
  set.attach(root);
  return undefined;
};

// ---------- Token classes (no colours) ----------

const tokenRules = [
  { tag: [t.keyword, t.atom, t.bool, t.null, t.self, t.modifier], class: 'tok-keyword' },
  { tag: [t.string, t.regexp, t.escape, t.url], class: 'tok-string' },
  { tag: t.comment, class: 'tok-comment' },
  { tag: [t.number, t.unit, t.color], class: 'tok-number' },
  { tag: t.tagName, class: 'tok-tag' },
  { tag: t.attributeName, class: 'tok-attr' },
  { tag: t.propertyName, class: 'tok-property' },
  { tag: [t.name, t.variableName, t.className, t.typeName, t.namespace, t.labelName, t.macroName], class: 'tok-variable' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], class: 'tok-function' },
  { tag: t.operator, class: 'tok-operator' },
  { tag: t.punctuation, class: 'tok-punct' },
  { tag: t.meta, class: 'tok-meta' },
  { tag: t.invalid, class: 'tok-invalid' },
];

const tokenClasses = Object.freeze(tokenRules.map((r) => r.class));

// HighlightStyle with only `class` options generates no style module, so no
// colours are injected.
const hubHighlight = HighlightStyle.define(tokenRules);

// ---------- German UI strings (the Hub is German) ----------

const phrasesDe = {
  // @codemirror/search
  'Find': 'Suchen',
  'Replace': 'Ersetzen',
  'next': 'weiter',
  'previous': 'zurück',
  'all': 'alle',
  'match case': 'Groß/klein',
  'regexp': 'Regex',
  'by word': 'ganzes Wort',
  'replace': 'ersetzen',
  'replace all': 'alle ersetzen',
  'close': 'schließen',
  'current match': 'aktueller Treffer',
  'replaced $ matches': '$ Treffer ersetzt',
  'replaced match on line $': 'Treffer in Zeile $ ersetzt',
  'on line': 'in Zeile',
  'Go to line': 'Gehe zu Zeile',
  'go': 'los',
  // @codemirror/language (folding)
  'Fold line': 'Zeile einklappen',
  'Unfold line': 'Zeile ausklappen',
  'folded code': 'eingeklappter Code',
  'unfold': 'ausklappen',
  'to': 'bis',
  // @codemirror/view, commands, autocomplete
  'Control character': 'Steuerzeichen',
  'Selection deleted': 'Auswahl gelöscht',
  'Completions': 'Vorschläge',
};

// ---------- Languages ----------

const LANGUAGES = ['html', 'css', 'js', 'json', 'text'];
const ALIASES = { javascript: 'js', mjs: 'js', htm: 'html', txt: 'text', plain: 'text' };

function normalizeLanguage(name) {
  const key = String(name || '').toLowerCase();
  const lang = ALIASES[key] || key;
  return LANGUAGES.includes(lang) ? lang : 'text';
}

const languageCache = new Map();
function languageExtension(lang) {
  if (!languageCache.has(lang)) {
    let ext = [];
    if (lang === 'html') ext = html(); // includes embedded CSS/JS and tag auto-closing
    else if (lang === 'css') ext = css();
    else if (lang === 'js') ext = javascript();
    else if (lang === 'json') ext = json();
    languageCache.set(lang, ext);
  }
  return languageCache.get(lang);
}

const EXTENSIONS = {
  html: 'html', htm: 'html', xhtml: 'html', svg: 'html', xml: 'html',
  css: 'css',
  js: 'js', mjs: 'js', cjs: 'js',
  json: 'json', webmanifest: 'json', map: 'json',
  txt: 'text', md: 'text', markdown: 'text', csv: 'text', tsv: 'text',
};

function languageFor(path) {
  const name = String(path || '').split(/[\\/]/).pop().toLowerCase();
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return 'text';
  return EXTENSIONS[name.slice(dot + 1)] || 'text';
}

// ---------- Editor ----------

// Shared by every editor instance (extensions are immutable values).
const baseExtensions = [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  history(),
  foldGutter(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  syntaxHighlighting(hubHighlight),
  bracketMatching(),
  closeBrackets(),
  autocompletion(),
  rectangularSelection(),
  crosshairCursor(),
  highlightActiveLine(),
  highlightSelectionMatches(),
  search(),
  EditorState.phrases.of(phrasesDe),
  keymap.of([
    ...closeBracketsKeymap,
    ...defaultKeymap,
    ...searchKeymap,
    ...historyKeymap,
    ...foldKeymap,
    ...completionKeymap,
    // Tab indents. Keyboard escape hatch (CodeMirror default): Escape, then
    // Tab within 2 s moves focus out; Ctrl-M / Shift-Alt-M toggles tab focus mode.
    indentWithTab,
  ]),
];

function readOnlyExtension(readOnly) {
  if (!readOnly) return [];
  return [
    EditorState.readOnly.of(true),
    // Stays focusable and selectable; no on-screen keyboard on touch devices.
    EditorView.contentAttributes.of({ 'aria-readonly': 'true', inputmode: 'none' }),
  ];
}

function create(parent, options = {}) {
  if (!parent || parent.nodeType !== 1) {
    throw new TypeError('HubEditor.create: parent must be an element');
  }
  const {
    doc = '',
    language = 'text',
    readOnly = false,
    wrap = false,
    onChange = null,
    onSave = null,
    ariaLabel = 'Quelltext',
  } = options;

  const current = { language: normalizeLanguage(language), readOnly: Boolean(readOnly) };
  const languageConf = new Compartment();
  const readOnlyConf = new Compartment();
  let editor = null;

  const extensions = () => [
    typeof onSave === 'function'
      ? Prec.highest(keymap.of([{
        key: 'Mod-s',
        preventDefault: true,
        run: () => { onSave(editor); return true; },
      }]))
      : [],
    baseExtensions,
    wrap ? EditorView.lineWrapping : [],
    EditorView.contentAttributes.of({ 'aria-label': String(ariaLabel) }),
    typeof onChange === 'function'
      ? EditorView.updateListener.of((update) => { if (update.docChanged) onChange(editor, update); })
      : [],
    languageConf.of(languageExtension(current.language)),
    readOnlyConf.of(readOnlyExtension(current.readOnly)),
  ];

  const newState = (text) => EditorState.create({ doc: String(text ?? ''), extensions: extensions() });
  const view = new EditorView({ state: newState(doc), parent });

  editor = {
    view,
    getValue: () => view.state.doc.toString(),
    // Loads a new document: replaces the text, resets undo history and
    // selection, keeps language/read-only settings. Does not call onChange.
    setValue(text) { view.setState(newState(text)); },
    setLanguage(lang) {
      current.language = normalizeLanguage(lang);
      view.dispatch({ effects: languageConf.reconfigure(languageExtension(current.language)) });
    },
    setReadOnly(value) {
      current.readOnly = Boolean(value);
      view.dispatch({ effects: readOnlyConf.reconfigure(readOnlyExtension(current.readOnly)) });
    },
    focus() { view.focus(); },
    destroy() { view.destroy(); },
  };
  return editor;
}

window.HubEditor = Object.freeze({
  create,
  languageFor,
  languages: Object.freeze(LANGUAGES.slice()),
  tokenClasses,
});
