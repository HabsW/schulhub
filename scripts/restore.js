#!/usr/bin/env node
'use strict';
// Restore a SchulHub backup (the zip from Verwaltung -> Sicherung).
//
//   npm run restore -- <sicherung.zip> [--data <ordner>] [--force]
//   node scripts/restore.js <sicherung.zip> [--data <ordner>] [--force]
//
// Stop the Hub first. The archive is checked completely before anything is
// written (allowed names only, no links, bounded sizes, content hashes, a
// valid SchulHub database). Nothing from the archive is executed. With
// --force an existing data folder is accepted; its Hub data is moved to
// data/vor-wiederherstellung-<time>/ instead of being deleted.

const path = require('node:path');
const { restoreBackup, RestoreError } = require('../src/backup');
const { plural } = require('../src/util');

const USAGE = `Verwendung: node scripts/restore.js <sicherung.zip> [--data <ordner>] [--force]

  <sicherung.zip>   die Datei aus „Verwaltung → Sicherung“
  --data <ordner>   Datenordner des Hubs (Standard: DATA_DIR aus .env, sonst ./data)
  --force           auch in einen Ordner mit Daten wiederherstellen; die bisherigen
                    Daten werden nach „vor-wiederherstellung-…“ verschoben

Wichtig: Stoppe den Hub vor der Wiederherstellung und starte ihn danach wieder.`;

function parseArgs(argv) {
  const out = { zip: null, data: null, force: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') out.force = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--data') {
      out.data = argv[++i];
      if (!out.data) throw new RestoreError('Nach --data fehlt der Ordner.');
    } else if (a.startsWith('--data=')) out.data = a.slice(7);
    else if (a.startsWith('-')) throw new RestoreError(`Unbekannte Option ${a}.`);
    else if (!out.zip) out.zip = a;
    else throw new RestoreError(`Zu viele Angaben: ${a}.`);
  }
  return out;
}

async function main() {
  const root = path.join(__dirname, '..');
  try {
    process.loadEnvFile(path.join(root, '.env'));
  } catch {
    // no .env: use the environment as it is
  }
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`);
    return 2;
  }
  if (args.help || !args.zip) {
    (args.help ? console.log : console.error)(USAGE);
    return args.help ? 0 : 2;
  }
  const zipFile = path.resolve(args.zip);
  const dataDir = path.resolve(root, args.data || process.env.DATA_DIR || 'data');
  console.log('SchulHub – Sicherung wiederherstellen');
  console.log(`  Sicherung:   ${zipFile}`);
  console.log(`  Datenordner: ${dataDir}`);
  console.log('  Der Hub muss jetzt gestoppt sein (sonst überschreibt er die Daten wieder).\n');
  try {
    const result = await restoreBackup({ zipFile, dataDir, force: args.force, log: (line) => console.log(`✓ ${line}`) });
    if (result.aside) console.log(`\nDie bisherigen Daten liegen jetzt in ${result.aside}.`);
    console.log(`\nFertig: ${plural(result.users, 'Konto', 'Konten')}, ${plural(result.blobs, 'App-Datei', 'App-Dateien')}, ${plural(result.userfiles, 'Nutzerdatei', 'Nutzerdateien')} wiederhergestellt.`);
    console.log('Starte den Hub jetzt wieder. Alle müssen sich neu anmelden.');
    return 0;
  } catch (err) {
    if (err instanceof RestoreError) {
      console.error(`✗ Abgebrochen: ${err.message}`);
      console.error('Es wurde nichts verändert.');
      return 1;
    }
    console.error(`✗ Unerwarteter Fehler: ${err && err.message}`);
    console.error('Prüfe den Datenordner. Bisherige Daten liegen gegebenenfalls in „vor-wiederherstellung-…“.');
    return 1;
  }
}

// Exported for tests; runs when called as a script.
module.exports = { parseArgs };
if (require.main === module) main().then((code) => process.exit(code));
