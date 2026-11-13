'use strict';
// Latency statistics for the load test: every request is recorded under a label.

const pct = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null);
const round = (x) => (x === null || x === undefined ? null : Math.round(x * 10) / 10);

class Stats {
  constructor(name) {
    this.name = name;
    this.labels = new Map();
    this.errors = [];
    this.errorCount = 0;
    this.series = []; // per 10 s: [t, count, errors, latencies]
    this.started = Date.now();
    this.bucket = null;
  }

  record(label, ms, error = null) {
    let s = this.labels.get(label);
    if (!s) this.labels.set(label, (s = { lat: [], errors: 0 }));
    s.lat.push(ms);
    const t = Math.floor((Date.now() - this.started) / 10_000);
    if (!this.bucket || this.bucket.t !== t) this.series.push((this.bucket = { t, n: 0, errors: 0, lat: [] }));
    this.bucket.n++;
    this.bucket.lat.push(ms);
    if (error) {
      s.errors++;
      this.errorCount++;
      this.bucket.errors++;
      if (this.errors.length < 300) this.errors.push({ label, error, at: new Date().toISOString() });
    }
  }

  /** A failure that is not a request (wrong data, a broken promise). */
  fail(label, error) {
    this.errorCount++;
    let s = this.labels.get(label);
    if (!s) this.labels.set(label, (s = { lat: [], errors: 0 }));
    s.errors++;
    if (this.errors.length < 300) this.errors.push({ label, error, at: new Date().toISOString() });
  }

  summary() {
    const rows = [];
    const all = [];
    let errors = 0;
    for (const [label, s] of this.labels) {
      const sorted = Float64Array.from(s.lat).sort();
      for (const x of s.lat) all.push(x);
      errors += s.errors;
      rows.push({ label, n: s.lat.length, errors: s.errors, p50: round(pct(sorted, 0.5)), p95: round(pct(sorted, 0.95)), p99: round(pct(sorted, 0.99)), max: round(sorted[sorted.length - 1] ?? null) });
    }
    rows.sort((a, b) => a.label.localeCompare(b.label));
    const sorted = Float64Array.from(all).sort();
    const seconds = (Date.now() - this.started) / 1000;
    return {
      name: this.name,
      seconds: Math.round(seconds),
      requests: all.length,
      perSecond: Math.round((all.length / seconds) * 10) / 10,
      errors: this.errorCount,
      errorRate: all.length ? this.errorCount / all.length : 0,
      total: { p50: round(pct(sorted, 0.5)), p95: round(pct(sorted, 0.95)), p99: round(pct(sorted, 0.99)), max: round(sorted[sorted.length - 1] ?? null) },
      labels: rows,
      firstErrors: this.errors.slice(0, 40),
    };
  }

  /** p95 per minute, for the soak test. */
  timeline(minutes = 1) {
    const out = new Map();
    for (const b of this.series) {
      const m = Math.floor((b.t * 10) / (60 * minutes));
      if (!out.has(m)) out.set(m, { minute: m * minutes, n: 0, errors: 0, lat: [] });
      const o = out.get(m);
      o.n += b.n;
      o.errors += b.errors;
      for (const x of b.lat) o.lat.push(x);
    }
    return [...out.values()].map((o) => {
      const sorted = Float64Array.from(o.lat).sort();
      return { minute: o.minute, requests: o.n, errors: o.errors, p50: round(pct(sorted, 0.5)), p95: round(pct(sorted, 0.95)), p99: round(pct(sorted, 0.99)) };
    });
  }
}

/** A small Markdown table. */
function table(rows, columns) {
  const head = `| ${columns.map((c) => c[1]).join(' | ')} |`;
  const line = `|${columns.map((c) => (c[2] === 'r' ? '---:' : '---')).join('|')}|`;
  const body = rows.map((r) => `| ${columns.map((c) => (r[c[0]] === null || r[c[0]] === undefined ? '–' : String(r[c[0]]))).join(' | ')} |`);
  return [head, line, ...body].join('\n');
}

module.exports = { Stats, table, pct, round };
