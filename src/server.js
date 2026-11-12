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

const hub = createHub(config);
if (dev) seedDemo(hub.ctx);

hub.start().then(
  () => {
    console.log(`${config.hubName} läuft: ${config.hubOrigin}`);
    console.log(`Apps laufen isoliert unter: ${config.appsOriginPattern}`);
    if (dev) console.log('LOKALER TESTMODUS: Testpersonen-Anmeldung aktiv, Server nur auf diesem Rechner erreichbar.');
  },
  (err) => {
    console.error(err.code === 'EADDRINUSE' ? `Port ${config.listenPort} ist schon belegt.` : err.message);
    process.exit(1);
  }
);
