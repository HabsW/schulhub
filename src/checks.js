'use strict';
// Checks that run once when an upload (or an editor version) is finished.
// They READ uploaded files as text - nothing is ever executed - and produce a
// report for the author and for reviewing teachers. The optional schulhub.json
// manifest is parsed and validated here.
//
// Report shape (stored as JSON on the version):
//   { items: [{ level: 'error' | 'warning' | 'note', text, file?, line? }],
//     stats: { files, bytes },
//     manifest: { achievements, settings } | null }

const { parseManifest } = require('./manifest');

function analyzeVersion(ctx, version) {
  const { uploads } = ctx;
  const files = uploads.listFiles(version.id);
  const items = [];
  const add = (level, text, extra = {}) => items.push({ level, text, ...extra });

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

  return {
    manifest,
    report: {
      items,
      stats: { files: files.length, bytes: files.reduce((n, f) => n + f.size, 0) },
      manifest: manifest ? { achievements: manifest.achievements.length, settings: manifest.settings.length } : null,
    },
  };
}

module.exports = { analyzeVersion };
