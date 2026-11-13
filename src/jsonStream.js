'use strict';
// A large JSON document written to an HTTP response piece by piece, with
// exactly the text JSON.stringify(value, null, 2) would produce. Long lists are
// lazy - lazy(() => iterable) - and their items are produced while the
// document is written, so it is never in memory as a whole. The response's
// back-pressure is respected, and after every chunk the event loop gets a turn,
// so other visitors are served while a big download is written.
//
// Lazy lists may be values of plain objects (also of objects that are items of
// a lazy list) or the document itself; everything else is written with
// JSON.stringify.

const CHUNK = 64 * 1024; // characters per write

class Lazy {
  constructor(items) {
    this.items = items;
  }
  toJSON() {
    throw new Error('A lazy list can only be written by writeJson, as a value of a plain object.');
  }
}
/** A list whose items are produced while it is written: items() returns an iterable (e.g. a generator). */
const lazy = (items) => new Lazy(items);

/** Values JSON.stringify leaves out of objects (and writes as null in arrays). */
const omitted = (v) => v === undefined || typeof v === 'function' || typeof v === 'symbol';
/** A plain object with a lazy list among its own values: written entry by entry. */
const holdsLazy = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.values(v).some((x) => x instanceof Lazy);
const pad = (depth) => '  '.repeat(depth);

/**
 * Write `value` to `res` as JSON with two spaces of indentation, then end the
 * response. Stops early (without ending) when the connection is closed.
 */
async function writeJson(res, value, { chunk = CHUNK } = {}) {
  let buf = '';
  const gone = () => res.destroyed;
  async function flush() {
    if (!buf || gone()) {
      buf = '';
      return;
    }
    const ok = res.write(buf);
    buf = '';
    if (!ok && !gone()) {
      await new Promise((resolve) => {
        const done = () => {
          res.off('drain', done);
          res.off('close', done);
          resolve();
        };
        res.on('drain', done);
        res.on('close', done);
      });
    }
    await new Promise((resolve) => setImmediate(resolve)); // a turn for everybody else
  }
  async function out(s) {
    buf += s;
    if (buf.length >= chunk) await flush();
  }

  async function write(v, depth) {
    if (gone()) return;
    if (v instanceof Lazy) {
      let n = 0;
      for (const item of v.items()) {
        await out(`${n++ ? ',' : '['}\n${pad(depth + 1)}`);
        await write(omitted(item) ? null : item, depth + 1);
        if (gone()) return;
      }
      await out(n ? `\n${pad(depth)}]` : '[]');
      return;
    }
    if (holdsLazy(v)) {
      const entries = Object.entries(v).filter(([, x]) => !omitted(x));
      for (let i = 0; i < entries.length; i++) {
        await out(`${i ? ',' : '{'}\n${pad(depth + 1)}${JSON.stringify(entries[i][0])}: `);
        await write(entries[i][1], depth + 1);
      }
      await out(`\n${pad(depth)}}`);
      return;
    }
    const s = JSON.stringify(v, null, 2);
    await out(s === undefined ? 'null' : depth ? s.replace(/\n/g, `\n${pad(depth)}`) : s);
  }

  await write(value, 0);
  await flush();
  if (!gone()) res.end();
}

module.exports = { writeJson, lazy };
