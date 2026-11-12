'use strict';
// Small helpers shared by everything.

const crypto = require('node:crypto');

/** Random, URL-safe id (96 bits by default). */
const newId = (bytes = 12) => crypto.randomBytes(bytes).toString('base64url');

/** An error that is safe to show to the user (German message, no internals). */
class HttpError extends Error {
  constructor(status, message) {
    super(message || 'Fehler');
    this.status = status;
    this.expose = true;
  }
}

/**
 * "Not found" and "not allowed" look identical on purpose, so that guessing
 * ids tells an attacker nothing about what exists.
 */
const deny = () => new HttpError(404, 'Diese Seite gibt es nicht – oder du hast keinen Zugriff darauf.');
const bad = (message) => new HttpError(400, message);

const dateFmt = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Berlin' });
const formatDate = (ts) => (ts ? dateFmt.format(new Date(ts)) : '–');

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace('.', ',')} KB`;
  return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

/** Normalise user-written text: string, no control characters, bounded length. */
function cleanText(value, max, { multiline = false } = {}) {
  let s = typeof value === 'string' ? value : '';
  s = s.normalize('NFC').replace(multiline ? /[\u0000-\u0008\u000b-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g, ' ');
  if (multiline) s = s.replace(/\r\n?/g, '\n');
  return s.trim().slice(0, max);
}

/** Constant-time string comparison. */
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = { newId, HttpError, deny, bad, formatDate, formatBytes, cleanText, safeEqual };
