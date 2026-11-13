'use strict';
// Entry point.
//   npm run dev   -> local test mode (no Microsoft needed, demo data, test logins)
//   npm start     -> real mode (Microsoft sign-in only, configuration required)

// The built-in database (node:sqlite) needs Node.js 22.13 / 23.4 or newer: say so plainly, not as a stack trace.
const [major, minor] = process.versions.node.split('.').map(Number);
if (!(major > 23 || (major === 23 && minor >= 4) || (major === 22 && minor >= 13))) {
  console.error(`SchulHub braucht Node.js 22.13 oder neuer – installiert ist ${process.version}.\nBitte die LTS-Version von https://nodejs.org installieren und dann noch einmal starten.`);
  process.exit(1);
}

const path = require('node:path');
const { loadConfig } = require('./config');
const { createHub } = require('./app');
const { seedDemo } = require('./seed');

try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch {
  // no .env file: use the real environment (fine for npm run dev)
}

const dev = process.argv.includes('--dev');
let config;
try {
  config = loadConfig({ dev });
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const open = dev && process.argv.includes('--open');

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

async function main() {
  // The demo started a second time (a double-click on its start file while it runs): like any program, it shows
  // the one that runs - and this process never touches the data folder.
  if (open && (await hubAnswers(config))) {
    console.log(`${config.hubName} läuft schon: ${config.hubOrigin} – der Browser öffnet sich.`);
    openBrowser(config.hubOrigin);
    return;
  }
  let hub;
  try {
    hub = createHub(config);
  } catch (err) {
    // A refusal whoever runs the Hub can act on (a data folder without its database): the message alone.
    console.error(err.code === 'SCHULHUB_DATABASE_MISSING' ? err.message : err);
    process.exit(1);
  }
  if (dev) seedDemo(hub.ctx);

  hub.start().then(
    () => {
      console.log(`${config.hubName} läuft: ${config.hubOrigin}`);
      console.log(`Apps laufen isoliert unter: ${config.appsOriginPattern}`);
      if (dev) console.log('LOKALER TESTMODUS: Testpersonen-Anmeldung aktiv, Server nur auf diesem Rechner erreichbar.');
      if (open) openBrowser(config.hubOrigin);
    },
    (err) => {
      console.error(err.code === 'EADDRINUSE' ? `Port ${config.listenPort} ist schon belegt.` : err.message);
      process.exit(1);
    }
  );
}

/** Local demo only: does this Hub already answer at its own address (on this computer)? */
async function hubAnswers({ hubOrigin, hubName }) {
  try {
    const res = await fetch(`${hubOrigin}/`, { signal: AbortSignal.timeout(2000) });
    const title = /<title>([^<]*)<\/title>/.exec(await res.text());
    return res.ok && Boolean(title) && title[1].includes(hubName);
  } catch {
    return false; // nothing there (or something else): start normally
  }
}

/** Local demo only (`npm run demo`): open the start page in the default browser once the Hub is ready. */
function openBrowser(url) {
  const { spawn } = require('node:child_process');
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref();
  } catch {
    // no browser to open: the address is printed above
  }
}
