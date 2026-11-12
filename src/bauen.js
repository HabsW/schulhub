'use strict';
// Shared helpers of the "Bauen" area (package C): the area's tab set and the
// app templates in templates/<id>/ (described by templates/index.json).
//
// Templates are files the Hub ships, but they are treated exactly like
// uploads when they become a draft: every file goes through
// uploads.putDraftFile, which applies the path, type, size and quota rules.
// Nothing from a request is ever used to build a disk path - template ids are
// looked up in the fixed list loaded at start.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { tabs, EMOJIS, COLORS } = require('./html');
const { CATEGORIES, parseManifest } = require('./manifest');
const { normalizePath, isJunk, extOf } = require('./uploads');

const ROOT = path.join(__dirname, '..');
const TEMPLATE_DIR = path.join(ROOT, 'templates');
const ID = /^[a-z][a-z0-9-]{1,31}$/;
// The Hub serves its own copies of these on every app origin; templates must not ship them.
const HUB_FILES = new Set(['hub-sdk.js', 'hub-ui.css']);
const UI_FONTS = ['atkinson-next-latin.woff2', 'atkinson-next-latin-ext.woff2', 'atkinson-mono-latin.woff2', 'atkinson-mono-latin-ext.woff2'];
// Template files are plain web files; the upload rules still apply when they become a draft.
const TEMPLATE_TYPES = new Set(['html', 'css', 'js', 'json', 'txt', 'md', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'mp3', 'ogg', 'wav']);

/** The tab set of the area (package B uses the same on /apps). */
const bauenTabs = (current) =>
  tabs([['/apps', 'Meine Apps', 'apps'], ['/entwickeln/vorlagen', 'Vorlagen', 'vorlagen'], ['/entwickeln', 'Anleitung', 'anleitung'], ['/entwickeln/sdk', 'SDK', 'sdk']], current);

function listDir(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = prefix + entry.name;
    if (entry.isDirectory()) out.push(...listDir(path.join(dir, entry.name), `${rel}/`));
    else if (entry.isFile()) out.push({ path: rel, file: path.join(dir, entry.name) });
  }
  return out;
}

/** Read and check templates/index.json and every template folder. Throws on anything unexpected. */
function loadTemplates(dir = TEMPLATE_DIR) {
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  if (!Array.isArray(index)) throw new Error('templates/index.json must be a list');
  const seen = new Set();
  return Object.freeze(index.map((t) => {
    const where = `template ${JSON.stringify(t && t.id)}`;
    if (!t || typeof t.id !== 'string' || !ID.test(t.id) || seen.has(t.id)) throw new Error(`${where}: bad or duplicate id`);
    seen.add(t.id);
    if (typeof t.name !== 'string' || !t.name.trim() || typeof t.description !== 'string') throw new Error(`${where}: name and description required`);
    if (!EMOJIS.includes(t.emoji)) throw new Error(`${where}: emoji must be one of EMOJIS`);
    if (!Number.isInteger(t.color) || t.color < 0 || t.color >= COLORS) throw new Error(`${where}: color must be 0..${COLORS - 1}`);
    if (t.category && !CATEGORIES.includes(t.category)) throw new Error(`${where}: unknown category`);
    const files = listDir(path.join(dir, t.id));
    for (const f of files) {
      if (normalizePath(f.path) !== f.path || isJunk(f.path) || !TEMPLATE_TYPES.has(extOf(f.path))) throw new Error(`${where}: file ${f.path} not allowed`);
      if (HUB_FILES.has(path.posix.basename(f.path)) || f.path.startsWith('hub-ui-fonts/')) throw new Error(`${where}: ${f.path} is provided by the Hub`);
    }
    if (!files.some((f) => f.path === 'index.html')) throw new Error(`${where}: index.html missing`);
    const manifest = files.find((f) => f.path === 'schulhub.json');
    if (manifest && parseManifest(fs.readFileSync(manifest.file, 'utf8')).errors.length) throw new Error(`${where}: schulhub.json has errors`);
    return Object.freeze({
      id: t.id,
      name: t.name.trim().slice(0, 60),
      appName: String(t.appName || t.name).trim().slice(0, 60),
      description: t.description.trim(),
      emoji: t.emoji,
      color: t.color,
      category: t.category || '',
      files: Object.freeze(files.map((f) => Object.freeze(f))),
    });
  }));
}

const TEMPLATES = loadTemplates();
/** A template by id from the fixed list, or null. */
const templateById = (id) => TEMPLATES.find((t) => t.id === id) || null;

/** Everything in a template's download: its files plus the SDK, the UI kit and its fonts, so it runs offline. */
function zipEntries(tpl) {
  return [
    ...tpl.files.map((f) => ({ path: f.path, file: f.file })),
    { path: 'hub-sdk.js', file: path.join(ROOT, 'sdk', 'hub-sdk.js') },
    { path: 'hub-ui.css', file: path.join(ROOT, 'sdk', 'hub-ui.css') },
    ...UI_FONTS.map((name) => ({ path: `hub-ui-fonts/${name}`, file: path.join(ROOT, 'public', 'fonts', name) })),
  ];
}

/** A name the owner does not use yet: "Quiz", else "Quiz 2", "Quiz 3" … */
function freeAppName(db, ownerId, base) {
  const taken = new Set(db.all('SELECT name FROM apps WHERE owner_id = ?', ownerId).map((r) => r.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; i < 100; i++) {
    const name = `${base} ${i}`.slice(0, 60);
    if (!taken.has(name.toLowerCase())) return name;
  }
  return base;
}

/**
 * Put every file of a template into the app's draft (inside the caller's
 * transaction). Each file goes through uploads.putDraftFile and its checks.
 */
function putTemplateFiles(ctx, app, tpl) {
  for (const f of tpl.files) ctx.uploads.putDraftFile(app, f.path, fs.readFileSync(f.file));
}

/** Content hashes of a template's files: blobs to clean up if a transaction fails after writing them. */
const templateShas = (tpl) => tpl.files.map((f) => crypto.createHash('sha256').update(fs.readFileSync(f.file)).digest('hex'));

/** Run fn in a transaction; if it fails, remove blobs the template may have left without any row. */
function withTemplateTx(ctx, tpl, fn) {
  try {
    return ctx.db.tx(fn);
  } catch (err) {
    ctx.uploads.collectGarbage(templateShas(tpl));
    throw err;
  }
}

/** Start an app's (missing) draft from a template. All or nothing. */
function draftFromTemplate(ctx, app, tpl) {
  withTemplateTx(ctx, tpl, () => putTemplateFiles(ctx, app, tpl));
}

/**
 * A new app from a template: name, emoji, colour and subject from the
 * template, a draft with every template file. All or nothing - if any file
 * is refused (for example because the account is full), no app is left behind.
 * Returns the app row.
 */
function appFromTemplate(ctx, user, tpl) {
  const { db, services } = ctx;
  return withTemplateTx(ctx, tpl, () => {
    const id = services.createApp(user, { name: freeAppName(db, user.id, tpl.appName), emoji: tpl.emoji, color: String(tpl.color), description: '' });
    if (tpl.category) db.run('UPDATE apps SET category = ? WHERE id = ?', tpl.category, id);
    const app = db.get('SELECT * FROM apps WHERE id = ?', id);
    putTemplateFiles(ctx, app, tpl);
    return app;
  });
}

module.exports = { bauenTabs, TEMPLATES, templateById, loadTemplates, zipEntries, freeAppName, appFromTemplate, draftFromTemplate, UI_FONTS };
