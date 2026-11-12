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

const TZ = 'Europe/Berlin';
const dateFmt = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short', timeZone: TZ });
const dayFmt = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: 'numeric', month: 'short', timeZone: TZ });
const longDayFmt = new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: 'numeric', month: 'long', timeZone: TZ });
const fullDateFmt = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'long', year: 'numeric', timeZone: TZ });
const ymdFmt = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: TZ });
const formatDate = (ts) => (ts ? dateFmt.format(new Date(ts)) : '–');
/** "Do., 12. Nov." */
const formatDay = (ts) => (ts ? dayFmt.format(new Date(ts)) : '–');
/** "Donnerstag, 12. November" */
const formatLongDay = (ts) => longDayFmt.format(new Date(ts));
/** "12. November 2026" */
const formatFullDate = (ts) => (ts ? fullDateFmt.format(new Date(ts)) : '–');
/** Calendar day in school time, "2026-11-12". */
const dayKey = (ts) => ymdFmt.format(new Date(ts));
/** Whole calendar days from today to ts (negative = in the past), in school time. */
function daysFromToday(ts, now = Date.now()) {
  const [a, b] = [dayKey(now), dayKey(ts)].map((d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)));
  return Math.round((b - a) / 86_400_000);
}

/** German count with the right noun: plural(1, 'Spielstand', 'Spielstände') -> "1 Spielstand". */
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** "gerade eben", "vor 5 Minuten", "gestern", "vor 3 Tagen", else the date. */
function formatAgo(ts, now = Date.now()) {
  if (!ts) return 'nie';
  const s = Math.round((now - ts) / 1000);
  if (s < 60) return 'gerade eben';
  if (s < 3600) return `vor ${plural(Math.round(s / 60), 'Minute', 'Minuten')}`;
  const days = -daysFromToday(ts, now);
  if (days === 0) return `vor ${plural(Math.round(s / 3600), 'Stunde', 'Stunden')}`;
  if (days === 1) return 'gestern';
  if (days < 7) return `vor ${days} Tagen`;
  return formatDay(ts);
}

/**
 * A due date in words plus how urgent it is:
 * { text: 'morgen fällig', tone: 'wait' } - tone is 'danger' (overdue), 'wait' (≤ 2 days) or ''.
 */
function formatDue(ts, now = Date.now()) {
  if (!ts) return { text: 'ohne Termin', tone: '' };
  const d = daysFromToday(ts, now);
  if (ts < now) return { text: d === 0 ? 'heute abgelaufen' : `seit ${plural(-d || 1, 'Tag', 'Tagen')} überfällig`, tone: 'danger' };
  if (d === 0) return { text: 'heute fällig', tone: 'wait' };
  if (d === 1) return { text: 'morgen fällig', tone: 'wait' };
  if (d <= 2) return { text: `in ${d} Tagen fällig`, tone: 'wait' };
  return { text: `fällig ${formatDay(ts)}`, tone: '' };
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace('.', ',')} KB`;
  return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

/** Normalise user-written text: string, no control characters, bounded length. */
function cleanText(value, max, { multiline = false } = {}) {
  let s = typeof value === 'string' ? value : '';
  s = s.normalize('NFC');
  if (multiline) s = s.replace(/\r\n?/g, '\n');
  s = s.replace(multiline ? /[\u0000-\u0008\u000b-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g, ' ');
  return s.trim().slice(0, max);
}

/** A local path to redirect to: must start with one "/" (never "//host" or "/\\host"). */
const isLocalPath = (p) => typeof p === 'string' && /^\/(?![/\\])/.test(p) && !/[\u0000-\u001f]/.test(p);

/** Constant-time string comparison. */
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = {
  newId, HttpError, deny, bad, cleanText, safeEqual, isLocalPath,
  formatDate, formatDay, formatLongDay, formatFullDate, formatAgo, formatDue, formatBytes, dayKey, daysFromToday, plural,
};
