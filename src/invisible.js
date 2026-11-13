'use strict';
// Invisible characters that make text look different from what it is
// ("Trojan Source"). Bidi controls reorder how text is SHOWN, not how it is
// read by a program: '/*\u202E } \u2066if (isAdmin)\u2069 \u2066 begin admins only */' looks like a
// guarded block to a reviewer and runs unguarded. Used by the upload checks
// (uploads.js: file names), the check report (checks.js) and the code views
// (appViews.js: source viewer and diff), which show every such character as a
// marked placeholder like ⟨U+202E⟩ - never the raw character.

/** Embeddings, overrides and isolates (U+202A–U+202E, U+2066–U+2069): an error in a check report. */
const BIDI_CONTROL = /[\u202A-\u202E\u2066-\u2069]/;
/** Direction marks ALM, LRM, RLM: invisible, but normal in right-to-left text (a warning). */
const BIDI_MARK = /[\u061C\u200E\u200F]/;
/** Line and paragraph separator: a line end for JavaScript, a plain space in the browser (a warning). */
const LINE_SEPARATOR = /[\u2028\u2029]/;
/** Everything above: shown as a placeholder wherever code is shown. */
const IN_CODE = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\u2028\u2029]/g;
/** Every format character (Unicode category Cf) and the two separators: none is allowed in a file name. */
const IN_NAME = /[\p{Cf}\u2028\u2029]/gu;

const NAMES = {
  0x202a: 'Einbettung links nach rechts (LRE)',
  0x202b: 'Einbettung rechts nach links (RLE)',
  0x202c: 'Ende einer Einbettung (PDF)',
  0x202d: 'Überschreibung links nach rechts (LRO)',
  0x202e: 'Überschreibung rechts nach links (RLO)',
  0x2066: 'Isolierung links nach rechts (LRI)',
  0x2067: 'Isolierung rechts nach links (RLI)',
  0x2068: 'Isolierung nach dem ersten Zeichen (FSI)',
  0x2069: 'Ende einer Isolierung (PDI)',
  0x061c: 'Arabische Richtungsmarke (ALM)',
  0x200e: 'Richtungsmarke links nach rechts (LRM)',
  0x200f: 'Richtungsmarke rechts nach links (RLM)',
  0x2028: 'Zeilentrenner (LS) – für JavaScript ein Zeilenende',
  0x2029: 'Absatztrenner (PS) – für JavaScript ein Zeilenende',
};

const code = (c) => c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
/** "⟨U+202E⟩" - how an invisible character is shown. */
const label = (c) => `⟨U+${code(c)}⟩`;
/** "Unsichtbares Zeichen U+202E: Überschreibung rechts nach links (RLO)" - for a title attribute. */
const describe = (c) => `Unsichtbares Zeichen U+${code(c)}: ${NAMES[c.codePointAt(0)] || 'Formatzeichen'}`;
/** 'control' | 'mark' | 'line' | 'format' */
const kind = (c) => (BIDI_CONTROL.test(c) ? 'control' : BIDI_MARK.test(c) ? 'mark' : LINE_SEPARATOR.test(c) ? 'line' : 'format');

/** A copy of `text` in which every character matched by `re` (a /g pattern above) is its label - for messages and attributes. */
const plain = (text, re = IN_CODE) => String(text ?? '').replace(re, label);
/** Does `text` contain a character of `re`? */
const has = (text, re = IN_CODE) => String(text ?? '').search(re) !== -1;

module.exports = { BIDI_CONTROL, BIDI_MARK, LINE_SEPARATOR, IN_CODE, IN_NAME, label, describe, kind, plain, has };
