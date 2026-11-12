'use strict';
// What changed between two versions of one app - for the review workbench.
//
// Server-side only. File contents are read as text and compared; nothing is
// ever executed. Binary files are never diffed (by type and by content), the
// Hub's own files (hub-sdk.js, hub-ui.css) are skipped, and every step has a
// budget - file size, number of files, bytes read, edit length and time - so a
// hostile upload cannot stall the Hub. The CALLER checks that the user may see
// BOTH versions (access.canSeeVersion) before calling this.

const { structuredPatch } = require('diff');
const { isHubFile } = require('./checks');

const LIMITS = {
  fileBytes: 300 * 1024, // larger text files are listed, not diffed
  files: 80, // text files read per comparison
  bytes: 4 * 1024 * 1024, // bytes read per comparison
  ms: 1500, // time for all files together
  editLength: 4000, // more changed lines than this in one file: "too many changes to show"
};

/** NUL bytes in the first 8 KB: not text, whatever the file name says. */
function looksBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Lines of a text without the empty piece after a final newline. */
function linesOf(text) {
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/**
 * Compare two versions (ids of the same app).
 * Returns {
 *   files: [{ path, status: 'added'|'removed'|'changed', size, oldSize,
 *             kind: 'text'|'binary'|'large'|'hub'|'budget'|'toomany'|'same-text',
 *             added, removed, hunks: [{ oldStart, oldLines, newStart, newLines, lines }] | null }],
 *   unchanged: number, totals: { added, removed, addedFiles, removedFiles, changedFiles }
 * }
 */
function diffVersions(uploads, fromVersionId, toVersionId, options = {}) {
  const L = { ...LIMITS, ...options };
  const before = new Map(uploads.listFiles(fromVersionId).map((f) => [f.path, f]));
  const after = new Map(uploads.listFiles(toVersionId).map((f) => [f.path, f]));
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => a.localeCompare(b, 'de', { sensitivity: 'base' }));
  const started = Date.now();
  let read = 0;
  let diffed = 0;
  let unchanged = 0;
  const files = [];
  const totals = { added: 0, removed: 0, addedFiles: 0, removedFiles: 0, changedFiles: 0 };

  for (const path of paths) {
    const o = before.get(path);
    const n = after.get(path);
    if (o && n && o.sha256 === n.sha256) {
      unchanged++;
      continue;
    }
    const status = !o ? 'added' : !n ? 'removed' : 'changed';
    totals[`${status}Files`]++;
    const entry = { path, status, size: n ? n.size : 0, oldSize: o ? o.size : 0, kind: 'text', added: 0, removed: 0, hunks: null };
    files.push(entry);

    if (isHubFile(path)) {
      entry.kind = 'hub';
      continue;
    }
    if (!uploads.isTextFile(path)) {
      entry.kind = 'binary';
      continue;
    }
    if (entry.size > L.fileBytes || entry.oldSize > L.fileBytes) {
      entry.kind = 'large';
      continue;
    }
    if (diffed >= L.files || read + entry.size + entry.oldSize > L.bytes || Date.now() - started > L.ms) {
      entry.kind = 'budget';
      continue;
    }
    const oldBuf = o ? uploads.readBlob(o.sha256) : Buffer.alloc(0);
    const newBuf = n ? uploads.readBlob(n.sha256) : Buffer.alloc(0);
    read += oldBuf.length + newBuf.length;
    diffed++;
    if (looksBinary(oldBuf) || looksBinary(newBuf)) {
      entry.kind = 'binary';
      continue;
    }

    if (status === 'added' || status === 'removed') {
      // No comparison needed: every line is new (shown) or gone (counted).
      const lines = linesOf((status === 'added' ? newBuf : oldBuf).toString('utf8'));
      if (status === 'added') {
        entry.added = lines.length;
        entry.hunks = lines.length ? [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((l) => `+${l}`) }] : [];
      } else entry.removed = lines.length;
    } else {
      const remaining = Math.max(50, L.ms - (Date.now() - started));
      const patch = structuredPatch(path, path, oldBuf.toString('utf8'), newBuf.toString('utf8'), '', '', {
        context: 3,
        stripTrailingCr: true,
        maxEditLength: L.editLength,
        timeout: Math.min(500, remaining),
      });
      if (!patch) {
        entry.kind = 'toomany';
        continue;
      }
      entry.hunks = patch.hunks;
      for (const h of patch.hunks) {
        for (const l of h.lines) {
          if (l[0] === '+') entry.added++;
          else if (l[0] === '-') entry.removed++;
        }
      }
      if (!entry.added && !entry.removed) entry.kind = 'same-text'; // e.g. only line endings changed
    }
    totals.added += entry.added;
    totals.removed += entry.removed;
  }
  return { files, unchanged, totals };
}

module.exports = { diffVersions, LIMITS };
