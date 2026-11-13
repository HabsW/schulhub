'use strict';
// The demo as an ordinary program: started a second time while it runs (a second double-click on its start file),
// it opens the running Hub in the browser and ends - without touching any data folder. A different program on the
// port is never taken for the Hub.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');

const SERVER = path.join(__dirname, '..', 'src', 'server.js');

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

/** Start src/server.js with these arguments and environment; output and exit code are collected. */
function run(args, env) {
  const child = spawn(process.execPath, [SERVER, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const done = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  /** The exit code - or the process is stopped and the test fails, if it does not end in time. */
  const exited = async (ms = 20_000) => {
    let timer;
    const late = new Promise((resolve) => (timer = setTimeout(() => resolve('still running'), ms)));
    const code = await Promise.race([done, late]);
    clearTimeout(timer);
    if (code === 'still running') {
      child.kill();
      await done;
    }
    return code;
  };
  return { child, output: () => out, done, exited };
}

async function until(ok, what, ms = 20_000) {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  assert.ok(ok(), `timed out: ${what}`);
}

test('Demo: ein zweiter Start öffnet den laufenden Hub im Browser und fasst keinen Datenordner an – ein fremdes Programm auf dem Port wird nie für ihn gehalten', { skip: process.platform !== 'linux' && 'the stand-in for the browser is xdg-open' }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'schulhub-demo-'));
  try {
    // A stand-in for the browser: it only notes which address it was asked to open.
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    const opened = path.join(tmp, 'geoeffnet.txt');
    fs.writeFileSync(path.join(bin, 'xdg-open'), `#!/bin/sh\necho "$@" >> '${opened}'\n`, { mode: 0o755 });
    const port = await freePort();
    const env = { BASE_URL: `http://localhost:${port}`, PATH: `${bin}${path.delimiter}${process.env.PATH}` };

    const first = run(['--dev'], { ...env, DATA_DIR: path.join(tmp, 'erster') });
    try {
      await until(() => first.output().includes('läuft:'), 'the first start');
      const second = run(['--dev', '--open'], { ...env, DATA_DIR: path.join(tmp, 'zweiter') });
      assert.equal(await second.exited(), 0, second.output());
      assert.match(second.output(), /läuft schon/);
      assert.equal(fs.readFileSync(opened, 'utf8').trim(), `http://localhost:${port}`, 'the browser opens the running Hub');
      assert.equal(fs.existsSync(path.join(tmp, 'zweiter', 'hub.sqlite')), false, 'no database made, no data folder touched');
    } finally {
      first.child.kill();
      await first.done;
    }

    // Something else answers on the port: not taken for the Hub - the start says the port is busy, no browser opens.
    const other = http.createServer((req, res) => res.end('<!doctype html><title>Etwas anderes</title>'));
    await new Promise((resolve) => other.listen(port, resolve)); // all addresses, IPv4 and IPv6
    try {
      const third = run(['--dev', '--open'], { ...env, DATA_DIR: path.join(tmp, 'dritter') });
      assert.equal(await third.exited(), 1, third.output());
      assert.match(third.output(), /ist schon belegt/);
      assert.equal(fs.readFileSync(opened, 'utf8').trim().split('\n').length, 1, 'no browser opened for something else');
    } finally {
      await new Promise((resolve) => other.close(resolve));
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
