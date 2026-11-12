'use strict';
// Entry point.
//   npm run dev   -> local test mode (no Microsoft needed, demo data, test logins)
//   npm start     -> real mode (Microsoft sign-in only, configuration required)

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
