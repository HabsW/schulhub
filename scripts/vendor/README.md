# Vendored CodeMirror 6

`public/vendor/codemirror.js` is a self-hosted, single-file build of
[CodeMirror 6](https://codemirror.net/) for the Hub's in-browser code editor. It is a
minified classic script (IIFE) that defines exactly one global, `window.HubEditor`, and
makes no network requests. The built file is committed, so the app keeps needing no
build step. Only maintainers run the script in this folder, and its `node_modules/`
is ignored by the repo's `.gitignore`.

```html
<script src="/static/vendor/codemirror.js" defer></script>
<script src="/static/editor.js" defer></script>  <!-- calls HubEditor.create(...) -->
```

## Versions (pinned exactly in `package.json` / `package-lock.json`)

| Package | Version |
|---|---|
| @codemirror/view | 6.43.15 |
| @codemirror/state | 6.7.6 |
| @codemirror/commands | 6.11.1 |
| @codemirror/language | 6.13.1 |
| @codemirror/autocomplete | 6.20.4 |
| @codemirror/search | 6.7.2 |
| @codemirror/lang-html | 6.4.12 |
| @codemirror/lang-css | 6.3.1 |
| @codemirror/lang-javascript | 6.2.5 |
| @codemirror/lang-json | 6.0.2 |
| @lezer/highlight | 1.2.5 |
| style-mod | 4.1.4 |
| codemirror (meta package) | 6.0.2 |
| esbuild (build only) | 0.28.2 |

The `codemirror` meta package is pinned to keep the set aligned, but its `basicSetup` is
not used: it bundles CodeMirror's default colour highlight style. The entry builds an
equivalent setup without colours. Transitive packages (`@lezer/*`, `crelt`,
`w3c-keyname`, `@marijn/find-cluster-break`) are fixed by the lockfile. The licence file
lists every package that ends up in the bundle.

## Rebuild

```sh
cd scripts/vendor
npm ci
node build-codemirror.mjs
```

This writes `public/vendor/codemirror.js` and `public/vendor/codemirror.LICENSE.txt` and
prints the size, a sha256 and the largest contributors. The output is deterministic: an
unchanged lockfile gives a byte-identical file. npm 12 may report that esbuild's
postinstall script was blocked. That is harmless, because esbuild uses its platform
package (`@esbuild/<os>-<arch>`) directly.

To update, bump the exact versions in `package.json`, run `npm install`, rebuild, run the
browser checks again (see "Verified") and commit all four files plus the lockfile.

Size at these versions: 556,955 bytes (544 KiB) minified, about 190 KiB gzip, 158 KiB brotli.
That is above the ~450 KB target, and the size is in packages that cannot be trimmed:
`@codemirror/view` 185 KB, `@lezer/javascript` 76 KB (one grammar for JS, TS and JSX),
`@codemirror/state` 46 KB, `@codemirror/autocomplete` 34 KB, `@lezer/common` and
`@lezer/lr` 27 KB each. Choosing other esbuild targets (es2020 to esnext) changes nothing.

## API (`codemirror-entry.mjs`)

```js
const ed = HubEditor.create(parentElement, {
  doc: '', language: 'text', readOnly: false, wrap: false,
  onChange: null,   // (editor, update) after every document change by the user
  onSave: null,     // (editor) on Ctrl/Cmd+S; the browser's save dialog is suppressed
  ariaLabel: 'Quelltext',
});
ed.view; ed.getValue(); ed.setValue(text); ed.setLanguage('css');
ed.setReadOnly(true); ed.focus(); ed.destroy();

HubEditor.languageFor('js/app.mjs');  // 'html' | 'css' | 'js' | 'json' | 'text'
HubEditor.languages;                  // ['html', 'css', 'js', 'json', 'text']
HubEditor.tokenClasses;               // ['tok-keyword', 'tok-string', ...]
```

- `setValue` loads a new document. It resets undo history and the selection, keeps the
  language and read-only settings, and does not call `onChange`. CodeMirror normalises
  line breaks, so `getValue()` always returns `\n`.
- `languageFor` maps .html .htm .xhtml .svg .xml to html, .css to css, .js .mjs .cjs to
  js, and .json .webmanifest .map to json. Everything else (.txt .md .csv ...) is text.
- Unknown language names fall back to `text`.
- Built in: line numbers, active line, history, bracket matching, close brackets,
  auto-indent, folding, selection-match highlighting, the search panel (Ctrl/Cmd+F),
  autocompletion for HTML, CSS and JS, and multiple cursors.
- Tab indents. The keyboard escape hatch is CodeMirror's default: press Escape, then Tab
  within 2 s, to move focus out of the editor. Ctrl-M (Shift-Alt-M on macOS) toggles
  tab focus mode.
- A read-only editor stays focusable and selectable. It sets `aria-readonly` and
  `inputmode="none"`, so touch devices show no on-screen keyboard.
- UI strings (search panel, folding, screen-reader announcements) are German, through
  `EditorState.phrases`.

## Styling and the CSP

The bundle injects no colours. Syntax tokens get only the classes in
`HubEditor.tokenClasses` (`tok-keyword`, `tok-string`, `tok-comment`, `tok-number`,
`tok-tag`, `tok-attr`, `tok-property`, `tok-variable`, `tok-function`, `tok-operator`,
`tok-punct`, `tok-meta`, `tok-invalid`). The Hub styles those classes and CodeMirror's
stable classes (`.cm-editor`, `.cm-gutters`, `.cm-activeLine`, `.cm-selectionBackground`,
`.cm-cursor`, `.cm-panel.cm-search`, `.cm-tooltip-autocomplete`, ...) in `hub.css`.

CodeMirror still needs its structural base styles (layout, scrolling, gutters, cursor),
which it injects through `style-mod`. For a document, style-mod 4.1 writes them into a
`<style>` element, which the Hub CSP (`style-src 'self'`) blocks. A control build without
the fix confirmed this: Chromium reported a `style-src-elem` violation and the editor
lost its layout. The entry therefore replaces `StyleModule.mount`, a public static API:

1. **Primary path.** The rules go into one constructed `CSSStyleSheet` per document
   (`replaceSync` + `document.adoptedStyleSheets`). That is CSSOM, which CSP allows.
2. **Cascade layer.** All rules sit inside `@layer codemirror { ... }`. Any unlayered rule
   in `hub.css` therefore beats CodeMirror's base theme, whatever the selector
   specificity. For example, `.cm-gutters { ... }` beats `.ͼ2 .cm-gutters`. Keep the
   editor rules in `hub.css` unlayered.
3. **Fallback.** Some browsers have no constructable stylesheets (Safari < 16.4,
   Firefox < 101). There, the same `@layer` block is inserted with `insertRule` into the
   first same-origin stylesheet the page has already linked, such as `hub.css`. Engines
   without `@layer` (before Safari 15.4 or Chrome 99) get an `@media all` block instead,
   and Hub rules then need more specific selectors. If there is no usable stylesheet,
   style-mod's own `<style>` path runs, which the CSP blocks.

Everything else CodeMirror does with styles goes through `element.style` or
`style.cssText`, which is also CSSOM. The bundle contains no `eval`, no `new Function`,
no `innerHTML` and no network APIs.

The base theme's default colours are CodeMirror's light variant, so `hub.css` should set
at least the editor background, gutters, active line, selection, cursor, panels and
tooltips. The Hub's global `label`, `input` and `button` rules also apply to the search
panel's controls. Scope any corrections under `.cm-panel.cm-search`.

## Verified

The checks ran in headless Chromium against a throwaway server. It sent the exact Hub CSP
(`default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:;
font-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none';
frame-ancestors 'none'; object-src 'none'`) and `X-Content-Type-Options: nosniff`. The
page loaded the bundle with `<script defer>` and created the editor from a second
external script. All 52 checks passed:

- **Clean page.** Zero `securitypolicyviolation` events and zero console errors on the
  desktop, 360 px mobile and fallback pages. As a control, the harness did catch a
  deliberately injected `<style>`.
- **Styles.** `HubEditor` is the only new global. There is no `<style>` element, one
  adopted sheet inside `@layer codemirror`, and the base styles are active.
  Low-specificity test rules override the base theme.
- **Editing.** Typing, undo and redo, auto-indent, close brackets, bracket matching,
  selection matches, the active line and folding all work.
- **Autocompletion.** Works for JS (local names and keywords), CSS properties and HTML
  tags.
- **Highlighting.** `tok-*` classes appear for JS, HTML (with embedded JS and CSS), CSS
  and JSON. Every class seen is in `tokenClasses`. Token colour comes only from page CSS.
- **Languages.** Switching text, then html, then css works. `languageFor` returns the
  expected mapping.
- **Keyboard.** Ctrl+F opens the German search panel with focus in its field, and Escape
  closes it and refocuses the editor. Tab and Shift+Tab indent and dedent. Escape then
  Tab moves focus to the next element, and Escape then Shift+Tab to the previous one.
  Ctrl+S calls `onSave` with `defaultPrevented`.
- **API.** `getValue`/`setValue` round-trip (umlauts, emoji, tabs, blank lines).
  `setValue` resets history and does not fire `onChange`. Read-only blocks input, and
  `setReadOnly(false)` re-enables it. `wrap: true`, `ariaLabel` and `destroy()` work.
- **Mobile.** At 360 px wide, the page has no horizontal scroll and long lines scroll
  inside `.cm-scroller`. A tap focuses the editor and IME-style text input works.
- **Fallback.** Simulated by removing `adoptedStyleSheets`. The rules land in the linked
  stylesheet as one `@layer` block, which is replaced rather than duplicated on
  reconfigure, with no violations.

Not tested: real Safari and Firefox, and real mobile devices.

## Licences

Every bundled package is MIT licensed. `public/vendor/codemirror.LICENSE.txt` holds the
name, version, source and full licence text of each one (21 packages), collected from
`node_modules` by the build script. The build fails if a bundled package has no licence
file or a licence outside the allow list (MIT, ISC, BSD-2-Clause, BSD-3-Clause, 0BSD).
esbuild (MIT) is only used at build time and is not part of the bundle.
