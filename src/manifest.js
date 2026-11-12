'use strict';
// schulhub.json - the optional manifest an app ships in its top folder.
//
// It declares things the Hub shows or edits for the app, so apps do not have
// to build them: achievements, per-class settings a teacher edits in the Hub,
// readable labels for result details, and catalogue data.
//
// The file is uploaded, untrusted text. It is parsed as JSON (never executed),
// validated field by field against fixed rules, and only the normalised copy
// is stored. Every string in it is user-written and is always shown escaped.
//
// {
//   "category": "Englisch",            // one of CATEGORIES
//   "grades": [5, 7],                  // Klassenstufen, 1..13
//   "achievements": [{ "id": "erste-runde", "title": "Erste Runde", "description": "…", "emoji": "⭐" }],
//   "settings": [{ "key": "woerter", "label": "Wörter", "type": "pairs", "columns": ["Deutsch", "Englisch"], "default": [["Hund", "dog"]] }],
//   "results": { "labels": { "richtig-gesamt": "Richtig insgesamt" } }
// }

const KEY = /^[A-Za-z0-9_.:-]{1,64}$/;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_SETTINGS_BYTES = 64 * 1024;

const CATEGORIES = [
  'Deutsch', 'Englisch', 'Französisch', 'Spanisch', 'Latein', 'Mathematik', 'Informatik',
  'Physik', 'Chemie', 'Biologie', 'Sachunterricht', 'Erdkunde', 'Geschichte', 'Politik',
  'Wirtschaft', 'Religion und Ethik', 'Kunst', 'Musik', 'Sport', 'Fächerübergreifend', 'Freizeit',
];

// Emojis an achievement may use (fixed list, like app icons).
const ACHIEVEMENT_EMOJIS = ['🏅', '🏆', '⭐', '🌟', '🎯', '🚀', '🔥', '💎', '🧠', '📚', '✍️', '🎨', '🎵', '⚡', '🌱', '🌈', '🦉', '🐢', '🐇', '🧩', '🔤', '🧮', '🔬', '🌍', '⏱️', '💯', '🥇', '🥈', '🥉', '👏'];

const SETTING_TYPES = ['text', 'number', 'boolean', 'choice', 'list', 'pairs'];
const LIMITS = { achievements: 50, settings: 30, choiceOptions: 20, listItems: 500, itemChars: 200, textChars: 2000, labels: 100 };

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** One line of user text: trimmed, no control characters, capped. */
function str(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}
function multiline(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim().slice(0, max);
}
const int = (v, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : null);

/**
 * Validate a manifest text. Never throws.
 * Returns { manifest: object|null, errors: [string], warnings: [string] }.
 * With errors the manifest is still returned with every valid part kept.
 */
function parseManifest(text) {
  const errors = [];
  const warnings = [];
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_FILE_BYTES) {
    return { manifest: null, errors: ['schulhub.json ist zu groß (höchstens 64 KB).'], warnings };
  }
  let data;
  try {
    data = JSON.parse(text.replace(/^﻿/, ''));
  } catch (err) {
    return { manifest: null, errors: [`schulhub.json ist kein gültiges JSON: ${String(err.message).slice(0, 120)}`], warnings };
  }
  if (!isObj(data)) return { manifest: null, errors: ['schulhub.json muss ein Objekt { … } sein.'], warnings };

  const m = { achievements: [], settings: [], results: { labels: {} } };

  if (data.category !== undefined) {
    if (CATEGORIES.includes(data.category)) m.category = data.category;
    else warnings.push(`Unbekanntes Fach "${str(data.category, 40)}". Erlaubt: ${CATEGORIES.join(', ')}.`);
  }
  if (data.grades !== undefined) {
    const g = Array.isArray(data.grades) ? data.grades : [];
    const lo = int(g[0], 1, 13);
    const hi = int(g[1] === undefined ? g[0] : g[1], 1, 13);
    if (lo !== null && hi !== null && lo <= hi) m.grades = [lo, hi];
    else warnings.push('"grades" muss so aussehen: [5, 7] (Klassenstufen 1 bis 13).');
  }

  // ----- achievements -----
  if (data.achievements !== undefined) {
    if (!Array.isArray(data.achievements)) errors.push('"achievements" muss eine Liste sein.');
    else {
      const seen = new Set();
      for (const [i, a] of data.achievements.slice(0, LIMITS.achievements).entries()) {
        const where = `Erfolg ${i + 1}`;
        if (!isObj(a) || typeof a.id !== 'string' || !KEY.test(a.id)) {
          errors.push(`${where}: "id" fehlt oder ist ungültig (Buchstaben, Ziffern, _ . : -).`);
          continue;
        }
        if (seen.has(a.id)) {
          errors.push(`${where}: die id "${a.id}" kommt doppelt vor.`);
          continue;
        }
        const title = str(a.title, 60);
        if (!title) {
          errors.push(`${where}: "title" fehlt.`);
          continue;
        }
        seen.add(a.id);
        const emoji = ACHIEVEMENT_EMOJIS.includes(a.emoji) ? a.emoji : '🏅';
        if (a.emoji !== undefined && emoji !== a.emoji) warnings.push(`${where}: dieses Emoji ist nicht erlaubt, es wird 🏅 verwendet.`);
        m.achievements.push({ id: a.id, title, description: str(a.description, 160), emoji, secret: a.secret === true });
      }
      if (data.achievements.length > LIMITS.achievements) warnings.push(`Nur die ersten ${LIMITS.achievements} Erfolge werden verwendet.`);
    }
  }

  // ----- per-class settings -----
  if (data.settings !== undefined) {
    if (!Array.isArray(data.settings)) errors.push('"settings" muss eine Liste sein.');
    else {
      const seen = new Set();
      for (const [i, s] of data.settings.slice(0, LIMITS.settings).entries()) {
        const where = `Einstellung ${i + 1}`;
        if (!isObj(s) || typeof s.key !== 'string' || !KEY.test(s.key) || seen.has(s.key)) {
          errors.push(`${where}: "key" fehlt, ist ungültig oder doppelt.`);
          continue;
        }
        if (!SETTING_TYPES.includes(s.type)) {
          errors.push(`${where}: "type" muss eins davon sein: ${SETTING_TYPES.join(', ')}.`);
          continue;
        }
        const field = { key: s.key, type: s.type, label: str(s.label, 80) || s.key, help: str(s.help, 200) };
        if (s.type === 'text') {
          field.multiline = s.multiline === true;
          field.maxLength = int(s.maxLength, 1, LIMITS.textChars) || (field.multiline ? LIMITS.textChars : 200);
        } else if (s.type === 'number') {
          field.min = typeof s.min === 'number' && Number.isFinite(s.min) ? s.min : null;
          field.max = typeof s.max === 'number' && Number.isFinite(s.max) ? s.max : null;
          field.step = typeof s.step === 'number' && s.step > 0 ? s.step : 1;
          if (field.min !== null && field.max !== null && field.min > field.max) {
            errors.push(`${where}: "min" ist größer als "max".`);
            continue;
          }
        } else if (s.type === 'choice') {
          const options = (Array.isArray(s.options) ? s.options : [])
            .slice(0, LIMITS.choiceOptions)
            .map((o) => (isObj(o) ? { value: str(o.value, 64), label: str(o.label, 80) || str(o.value, 64) } : { value: str(o, 64), label: str(o, 80) }))
            .filter((o) => o.value);
          if (options.length < 2) {
            errors.push(`${where}: eine Auswahl braucht mindestens zwei "options".`);
            continue;
          }
          field.options = options;
        } else if (s.type === 'list') {
          field.maxItems = int(s.maxItems, 1, LIMITS.listItems) || 100;
        } else if (s.type === 'pairs') {
          const cols = Array.isArray(s.columns) ? s.columns.map((c) => str(c, 40)).filter(Boolean) : [];
          field.columns = cols.length === 2 ? cols : ['Begriff', 'Bedeutung'];
          field.maxItems = int(s.maxItems, 1, LIMITS.listItems) || 200;
        }
        // The default must itself be a valid value for the field.
        const d = s.default === undefined ? emptyValue(field) : s.default;
        const checked = checkValue(field, d);
        if (checked.error) {
          errors.push(`${where}: der Standardwert passt nicht (${checked.error}).`);
          field.default = emptyValue(field);
        } else field.default = checked.value;
        seen.add(s.key);
        m.settings.push(field);
      }
      if (data.settings.length > LIMITS.settings) warnings.push(`Nur die ersten ${LIMITS.settings} Einstellungen werden verwendet.`);
    }
  }

  // ----- readable labels for result details (teacher views) -----
  if (isObj(data.results) && isObj(data.results.labels)) {
    for (const [k, v] of Object.entries(data.results.labels).slice(0, LIMITS.labels)) {
      if (KEY.test(k) && str(v, 80)) m.results.labels[k] = str(v, 80);
    }
  }

  // Reserved for later (multiplayer). Accepted, but nothing uses it yet.
  if (isObj(data.multiplayer)) {
    const max = int(data.multiplayer.maxPlayers, 2, 40);
    if (max) m.multiplayer = { maxPlayers: max };
  }

  const known = new Set(['name', 'description', 'category', 'grades', 'achievements', 'settings', 'results', 'multiplayer', '$schema', 'version']);
  for (const k of Object.keys(data)) if (!known.has(k)) warnings.push(`Unbekannter Eintrag "${str(k, 40)}" wird ignoriert.`);
  return { manifest: m, errors, warnings };
}

function emptyValue(field) {
  switch (field.type) {
    case 'text':
      return '';
    case 'number':
      return field.min !== null && field.min !== undefined ? field.min : 0;
    case 'boolean':
      return false;
    case 'choice':
      return field.options[0].value;
    default:
      return [];
  }
}

/** Check one value against one field. Returns { value } (normalised) or { error }. */
function checkValue(field, v) {
  switch (field.type) {
    case 'text': {
      if (typeof v !== 'string') return { error: 'Text erwartet' };
      const value = field.multiline ? multiline(v, field.maxLength) : str(v, field.maxLength);
      return { value };
    }
    case 'number': {
      const n = typeof v === 'string' && v.trim() !== '' ? Number(v.replace(',', '.')) : v;
      if (typeof n !== 'number' || !Number.isFinite(n)) return { error: 'Zahl erwartet' };
      if (field.min !== null && n < field.min) return { error: `mindestens ${field.min}` };
      if (field.max !== null && n > field.max) return { error: `höchstens ${field.max}` };
      return { value: n };
    }
    case 'boolean':
      if (v === true || v === false) return { value: v };
      if (v === 'on' || v === '1' || v === 'true') return { value: true };
      if (v === '' || v === '0' || v === 'false' || v === undefined) return { value: false };
      return { error: 'Ja oder Nein erwartet' };
    case 'choice':
      return field.options.some((o) => o.value === v) ? { value: v } : { error: 'unbekannte Auswahl' };
    case 'list': {
      const items = Array.isArray(v) ? v : typeof v === 'string' ? v.split('\n') : null;
      if (!items) return { error: 'Liste erwartet' };
      const value = items.map((x) => str(String(x ?? ''), LIMITS.itemChars)).filter(Boolean);
      if (value.length > field.maxItems) return { error: `höchstens ${field.maxItems} Einträge` };
      return { value };
    }
    case 'pairs': {
      // From the form: one pair per line, "links = rechts". From JSON: [["links", "rechts"], …].
      const rows = Array.isArray(v) ? v : typeof v === 'string' ? v.split('\n').filter((l) => l.trim()).map((l) => l.split(/\s*=\s*/)) : null;
      if (!rows) return { error: 'Paare erwartet' };
      const value = [];
      for (const [i, r] of rows.entries()) {
        if (!Array.isArray(r) || r.length !== 2) return { error: `Zeile ${i + 1}: jede Zeile braucht genau ein "=" zwischen den beiden Teilen` };
        const a = str(String(r[0] ?? ''), LIMITS.itemChars);
        const b = str(String(r[1] ?? ''), LIMITS.itemChars);
        if (!a || !b) return { error: `Zeile ${i + 1}: ein Paar hat eine leere Seite` };
        value.push([a, b]);
      }
      if (value.length > field.maxItems) return { error: `höchstens ${field.maxItems} Paare` };
      return { value };
    }
    default:
      return { error: 'unbekannter Typ' };
  }
}

/**
 * Validate the settings a teacher submits for a class (form fields or JSON).
 * Returns { values, errors: { key: message } }. Unknown keys are ignored.
 */
function validateSettings(manifest, input) {
  const values = {};
  const errors = {};
  for (const field of (manifest && manifest.settings) || []) {
    const raw = input ? input[field.key] : undefined;
    const checked = checkValue(field, raw === undefined && field.type !== 'boolean' ? field.default : raw);
    if (checked.error) errors[field.key] = checked.error;
    else values[field.key] = checked.value;
  }
  if (Buffer.byteLength(JSON.stringify(values)) > MAX_SETTINGS_BYTES) errors._all = 'Die Einstellungen sind zu groß (höchstens 64 KB).';
  return { values, errors };
}

/** Defaults merged with stored class values; values that no longer fit the manifest fall back to the default. */
function effectiveSettings(manifest, stored) {
  const out = {};
  for (const field of (manifest && manifest.settings) || []) {
    const has = stored && Object.hasOwn(stored, field.key);
    const checked = has ? checkValue(field, stored[field.key]) : null;
    out[field.key] = checked && !checked.error ? checked.value : field.default;
  }
  return out;
}

/** The manifest stored on a version row (already validated), or an empty one. */
function manifestOf(versionRow) {
  if (!versionRow || !versionRow.manifest) return { achievements: [], settings: [], results: { labels: {} } };
  try {
    return JSON.parse(versionRow.manifest);
  } catch {
    return { achievements: [], settings: [], results: { labels: {} } };
  }
}

module.exports = { parseManifest, validateSettings, effectiveSettings, checkValue, manifestOf, CATEGORIES, ACHIEVEMENT_EMOJIS, SETTING_TYPES, KEY };
