#!/usr/bin/env node
'use strict';
// Scale seed: fills a FRESH data folder with a large, realistic school, so that
// load tests and page timings run against real-sized data instead of the
// six-person demo.
//
//   node scripts/scale/seed.js --data <dir> [--students 1000] [--teachers 100]
//        [--classes 40] [--days 90] [--seed 42] [--force]
//
// - Test data only. Never point this at a real Hub's data folder: ids and join
//   codes come from the seeded random generator, so anyone who knows the seed
//   knows them.
// - Refuses if <dir>/hub.sqlite exists, unless --force is given; then it removes
//   hub.sqlite*, blobs/, userfiles/ and tmp/ in that folder, and nothing else.
// - Deterministic: the same arguments give the same data. All times are anchored
//   at today 00:00 (Europe/Berlin), so two runs on the same day give the same
//   database; the summary prints a content fingerprint to compare runs.
// - Built through the Hub's own code: loadConfig + createHub create the schema
//   and migrations. The six example apps (examples/) are uploaded and analysed
//   once through the normal upload path; every seeded version gets app_files rows
//   pointing at those content-addressed blobs, plus the real manifest and check
//   report. Editor drafts go through uploads.draftFromVersion/putDraftFile and
//   drawings through userFiles.put, so every referenced file exists on disk.
//   App data is written the way the SDK API writes it.
// - All dates stay inside the Hub's retention rules (services.maintenance), so
//   the next start of a Hub on this folder deletes nothing; the summary checks it.
// - No ANALYZE here: the planner statistics come from the Hub itself (PRAGMA
//   optimize when it opens the database, and daily), as on a real installation.
//   The database ends with PRAGMA wal_checkpoint(TRUNCATE).
//
// Sign in by hand: DATA_DIR=<dir> npm run dev - the landing page lists the dev-
// accounts printed at the end of the summary.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const { loadConfig } = require('../../src/config');
const { createHub } = require('../../src/app');
const { validateSettings, effectiveSettings } = require('../../src/manifest');
const { dayKey, formatDue, formatBytes } = require('../../src/util');
const { schoolTime } = require('../../src/teachingKit');
const { EMOJIS, COLORS } = require('../../src/html');

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const USAGE = `Usage: node scripts/scale/seed.js --data <dir> [--students 1000] [--teachers 100] [--classes 40] [--days 90] [--seed 42] [--force]

  --data <dir>     data folder to fill (created if missing)
  --students <n>   students (default 1000)
  --teachers <n>   teachers (default 100)
  --classes <n>    active classes (default 40); about a fifth more are archived from last year
  --days <n>       days of activity before today (default 90, from 14 to 330)
  --seed <n>       random seed (default 42): the same arguments give the same data
  --force          replace the Hub data in <dir>: removes hub.sqlite*, blobs/, userfiles/, tmp/

Test data only - never point this at a real Hub's data folder.`;

function die(message) {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

function parseArgs(argv) {
  const o = { data: null, students: 1000, teachers: 100, classes: 40, days: 90, seed: 42, force: false };
  const RANGE = { students: [60, 20000], teachers: [10, 2000], classes: [8, 400], days: [14, 330], seed: [0, 4294967295] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') {
      o.force = true;
      continue;
    }
    if (a === '--help' || a === '-h') {
      console.log(USAGE);
      process.exit(0);
    }
    const m = /^--(data|students|teachers|classes|days|seed)(?:=(.*))?$/.exec(a);
    if (!m) die(`Unknown option: ${a}`);
    const v = m[2] !== undefined ? m[2] : argv[++i];
    if (v === undefined || v === '') die(`--${m[1]} needs a value.`);
    if (m[1] === 'data') o.data = v;
    else {
      const n = Number(v);
      const [lo, hi] = RANGE[m[1]];
      if (!Number.isInteger(n) || n < lo || n > hi) die(`--${m[1]} must be a whole number from ${lo} to ${hi}.`);
      o[m[1]] = n;
    }
  }
  if (!o.data) die('--data <dir> is missing.');
  return o;
}

/** Refuse an existing Hub unless --force; with --force remove exactly the Hub's data, nothing else. */
function prepareFolder(dir, force) {
  if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) die(`${dir} is not a folder.`);
  const db = path.join(dir, 'hub.sqlite');
  if (fs.existsSync(db) && !force) die(`${db} exists. Use --force to replace the Hub data in this folder.`);
  if (!force || !fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) if (name.startsWith('hub.sqlite')) fs.rmSync(path.join(dir, name), { force: true });
  for (const sub of ['blobs', 'userfiles', 'tmp']) fs.rmSync(path.join(dir, sub), { recursive: true, force: true });
}

// ================================================================ randomness

/** mulberry32 plus the helpers this script needs. Every random choice goes through here. */
function makeRandom(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const R = {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    real: (lo, hi) => lo + next() * (hi - lo),
    chance: (p) => next() < p,
    pick: (list) => list[Math.floor(next() * list.length)],
    /** pairs: [[item, weight], ...] */
    weighted(pairs) {
      let total = 0;
      for (const [, w] of pairs) total += w;
      let r = next() * total;
      for (const [item, w] of pairs) {
        r -= w;
        if (r < 0) return item;
      }
      return pairs[pairs.length - 1][0];
    },
    shuffle(list) {
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
      }
      return list;
    },
    sample: (list, k) => R.shuffle(list.slice()).slice(0, Math.max(0, k)),
    normal() {
      const u = Math.max(next(), 1e-12);
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
    },
    logNormal: (sigma) => Math.exp(sigma * R.normal()),
    binomial(n, p) {
      let k = 0;
      for (let i = 0; i < n; i++) if (next() < p) k++;
      return k;
    },
    u32: () => (next() * 4294967296) >>> 0,
    bytes(n) {
      const b = Buffer.alloc(n);
      for (let i = 0; i < n; i++) b[i] = Math.floor(next() * 256);
      return b;
    },
    /** Same shape as util.newId (12 bytes, base64url). */
    id: () => R.bytes(12).toString('base64url'),
    hex: (n) => R.bytes(Math.ceil(n / 2)).toString('hex').slice(0, n),
    /** A time between lo and hi, mostly near lo. */
    early: (lo, hi, power = 2) => lo + (hi - lo) * Math.pow(next(), power),
  };
  return R;
}

/** Zipf-like picker: earlier names in the list are more common. */
function zipf(R, list, s) {
  const cum = [];
  let acc = 0;
  list.forEach((_, i) => cum.push((acc += 1 / Math.pow(i + 1, s))));
  return () => {
    const r = R.next() * acc;
    let lo = 0;
    let hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    return list[lo];
  };
}

/** "Müller" -> "mueller", "Yılmaz" -> "yilmaz": the local part of a school e-mail address. */
function ascii(s) {
  return s.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/ı/g, 'i').replace(/ł/g, 'l')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
}

// ================================================================ calendar

// School holidays and public holidays (month-day ranges, roughly a German school year).
const HOLIDAYS = [['01-01', '01-02'], ['03-30', '04-10'], ['05-01', '05-01'], ['05-14', '05-15'], ['05-26', '05-29'], ['07-13', '08-21'], ['10-03', '10-03'], ['10-19', '10-31'], ['12-21', '12-31']];

function makeCalendar(D) {
  const addDays = (ymd, n) => {
    const [y, m, d] = ymd.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  };
  const weekday = (ymd) => new Date(`${ymd}T12:00:00Z`).getUTCDay();
  const holiday = (ymd) => HOLIDAYS.some(([a, b]) => ymd.slice(5) >= a && ymd.slice(5) <= b);
  const isSchool = (ymd) => weekday(ymd) >= 1 && weekday(ymd) <= 5 && !holiday(ymd);
  const midnight = (ymd) => schoolTime(ymd, '00:00');
  const today = dayKey(Date.now());
  const NOW = midnight(today);
  // The school year starts on the first Monday on or after 22 August.
  const syOf = (y) => {
    let d = `${y}-08-22`;
    while (weekday(d) !== 1) d = addDays(d, 1);
    return d;
  };
  let sy = syOf(Number(today.slice(0, 4)));
  if (midnight(sy) > NOW - 14 * DAY) sy = syOf(Number(today.slice(0, 4)) - 1);
  const lastSy = syOf(Number(sy.slice(0, 4)) - 1);
  let yearEnd = `${sy.slice(0, 4)}-07-12`;
  while (!isSchool(yearEnd)) yearEnd = addDays(yearEnd, -1);
  const windowStart = addDays(today, -D - 2);
  const first = addDays(lastSy < windowStart ? lastSy : windowStart, -21);
  const last = addDays(today, 60);
  const days = [];
  for (let d = first; d <= last; d = addDays(d, 1)) {
    days.push({ i: days.length, ymd: d, start: midnight(d), wd: weekday(d), school: isSchool(d), dayNo: Math.floor(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / DAY) });
  }
  const starts = days.map((x) => x.start);
  /** Index of the day that contains ts (clamped to the table). */
  function indexOf(ts) {
    if (ts <= starts[0]) return 0;
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= ts) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
  return { today, NOW, SY: midnight(sy), lastSY: midnight(lastSy), yearEnd: midnight(yearEnd), days, indexOf, dayOf: (ts) => days[indexOf(ts)] };
}

// Minutes after midnight for the kinds of moments people use the Hub.
const SLOTS = {
  lesson: [7 * 60 + 50, 15 * 60 + 15],
  afternoon: [15 * 60 + 30, 18 * 60],
  evening: [18 * 60, 21 * 60 + 30],
  late: [21 * 60 + 30, 22 * 60 + 45],
  free: [10 * 60, 21 * 60],
  office: [7 * 60 + 15, 16 * 60 + 30],
};

// ================================================================ content

const GIRLS = ['Emma', 'Mia', 'Hannah', 'Emilia', 'Sofia', 'Lina', 'Anna', 'Marie', 'Mila', 'Lea', 'Lena', 'Leonie', 'Amelie', 'Clara', 'Johanna', 'Ella', 'Luisa', 'Laura', 'Lara', 'Sophie', 'Charlotte', 'Paula', 'Maja', 'Ida', 'Frieda', 'Mathilda', 'Nele', 'Lilly', 'Emily', 'Pia', 'Greta', 'Elena', 'Helena', 'Jana', 'Nora', 'Sarah', 'Lisa', 'Julia', 'Katharina', 'Zoe', 'Alina', 'Antonia', 'Melina', 'Selin', 'Elif', 'Zeynep', 'Amira', 'Aylin', 'Ronja', 'Finja', 'Mira', 'Carla', 'Isabella', 'Victoria', 'Valentina', 'Romy', 'Theresa', 'Annika', 'Merle', 'Jasmin', 'Leni', 'Defne', 'Noemi', 'Josephine', 'Fiona', 'Larissa', 'Chiara', 'Milena', 'Hira', 'Nina', 'Anna-Lena', 'Marlene'];
const BOYS = ['Ben', 'Paul', 'Leon', 'Finn', 'Elias', 'Jonas', 'Luis', 'Noah', 'Felix', 'Lukas', 'Maximilian', 'Henry', 'Emil', 'Theo', 'Anton', 'Jakob', 'Liam', 'Moritz', 'Julian', 'Niklas', 'David', 'Tim', 'Tom', 'Erik', 'Oskar', 'Matteo', 'Samuel', 'Linus', 'Leo', 'Jan', 'Philipp', 'Fabian', 'Simon', 'Alexander', 'Benjamin', 'Jonathan', 'Vincent', 'Mats', 'Hannes', 'Lennard', 'Till', 'Ole', 'Carl', 'Valentin', 'Constantin', 'Max', 'Johannes', 'Daniel', 'Florian', 'Mehmet', 'Emir', 'Yusuf', 'Ali', 'Can', 'Deniz', 'Omar', 'Ibrahim', 'Adam', 'Mika', 'Malte', 'Nils', 'Jannik', 'Robin', 'Kilian', 'Marlon', 'Luca', 'Nico', 'Leonard', 'Aaron', 'Milan', 'Jan-Luca'];
const SURNAMES = ['Müller', 'Schmidt', 'Schneider', 'Fischer', 'Weber', 'Meyer', 'Wagner', 'Becker', 'Schulz', 'Hoffmann', 'Schäfer', 'Koch', 'Bauer', 'Richter', 'Klein', 'Wolf', 'Schröder', 'Neumann', 'Schwarz', 'Zimmermann', 'Braun', 'Krüger', 'Hofmann', 'Hartmann', 'Lange', 'Schmitt', 'Werner', 'Schmitz', 'Krause', 'Meier', 'Lehmann', 'Schmid', 'Schulze', 'Maier', 'Köhler', 'Herrmann', 'König', 'Walter', 'Mayer', 'Huber', 'Kaiser', 'Fuchs', 'Peters', 'Lang', 'Scholz', 'Möller', 'Weiß', 'Jung', 'Hahn', 'Schubert', 'Vogel', 'Friedrich', 'Keller', 'Günther', 'Frank', 'Berger', 'Winkler', 'Roth', 'Beck', 'Lorenz', 'Baumann', 'Franke', 'Albrecht', 'Schuster', 'Simon', 'Ludwig', 'Böhm', 'Winter', 'Kraus', 'Martin', 'Schumacher', 'Krämer', 'Vogt', 'Stein', 'Jäger', 'Otto', 'Sommer', 'Groß', 'Seidel', 'Heinrich', 'Brandt', 'Haas', 'Schreiber', 'Graf', 'Schulte', 'Dietrich', 'Ziegler', 'Kuhn', 'Kühn', 'Pohl', 'Engel', 'Horn', 'Busch', 'Bergmann', 'Thomas', 'Voigt', 'Sauer', 'Arnold', 'Wolff', 'Pfeiffer', 'Yılmaz', 'Kaya', 'Demir', 'Şahin', 'Çelik', 'Öztürk', 'Aydın', 'Nowak', 'Kowalski', 'Wiśniewski', 'Popović', 'Nguyen', 'Tran', 'Ahmadi', 'Hosseini', 'Ivanova', 'Petrov', 'Rossi', 'Russo', 'Ferreira', 'Silva', 'Hoxha', 'Krasniqi', 'Haddad', 'Al-Hassan', 'Mansour', 'Okafor', 'Mensah', 'Novak', 'Horvat', 'Kovačević', 'Jovanović', 'Lindner', 'Kessler', 'Brinkmann', 'Thiele', 'Hesse', 'Ernst', 'Paul', 'Bock', 'Kopp', 'Wendt'];
const T_WOMEN = ['Andrea', 'Sabine', 'Claudia', 'Susanne', 'Petra', 'Nicole', 'Stefanie', 'Katrin', 'Anja', 'Julia', 'Kerstin', 'Birgit', 'Martina', 'Christina', 'Sandra', 'Melanie', 'Tanja', 'Silke', 'Daniela', 'Nadine', 'Miriam', 'Ayşe', 'Svenja', 'Ulrike', 'Heike', 'Monika', 'Carolin', 'Eva', 'Ines', 'Bettina', 'Franziska', 'Lisa', 'Sarah', 'Anna'];
const T_MEN = ['Thomas', 'Michael', 'Stefan', 'Andreas', 'Markus', 'Christian', 'Frank', 'Jens', 'Matthias', 'Martin', 'Peter', 'Torsten', 'Oliver', 'Sebastian', 'Tobias', 'Jan', 'Dirk', 'Ralf', 'Uwe', 'Holger', 'Björn', 'Kai', 'Lars', 'Murat', 'Florian', 'Daniel', 'Alexander', 'Philipp', 'Benedikt', 'Volker', 'Henrik', 'Nils'];

// [category (catalogue value), name in the class name, weight]
const HOMEROOM_SUBJECTS = [['Englisch', 'Englisch', 24], ['Mathematik', 'Mathe', 20], ['Deutsch', 'Deutsch', 14], ['Biologie', 'Bio', 8], ['Erdkunde', 'Erdkunde', 6], ['Geschichte', 'Geschichte', 6], ['Französisch', 'Französisch', 5], ['Physik', 'Physik', 5], ['Informatik', 'Informatik', 4], ['Chemie', 'Chemie', 3], ['Musik', 'Musik', 3], ['Kunst', 'Kunst', 2]];
const COURSES = [['WP Informatik 9/10', 'Informatik', [9, 10]], ['Französisch 7 (2. Fremdsprache)', 'Französisch', [7]], ['Latein 8', 'Latein', [8]], ['Spanisch 9', 'Spanisch', [9]], ['Bili Erdkunde 8', 'Erdkunde', [8]], ['Förderkurs Mathe 6', 'Mathematik', [6]], ['Physik-Profil 10', 'Physik', [10]], ['Darstellen & Gestalten 9', 'Kunst', [9]], ['Latein 7', 'Latein', [7]], ['Französisch 6', 'Französisch', [6]], ['Förderkurs Deutsch 5', 'Deutsch', [5]], ['Chemie-Profil 10', 'Chemie', [10]]];
const CLUBS = [['Robotik-AG', 'Informatik'], ['Schach-AG', 'Freizeit'], ['Theater-AG', 'Deutsch'], ['Schülerzeitung', 'Deutsch'], ['Garten-AG', 'Biologie'], ['Chor', 'Musik'], ['Mathe-Olympiade', 'Mathematik'], ['Fußball-AG', 'Sport']];

const EN_WORDS = [['der Bahnhof', 'station'], ['die Fahrkarte', 'ticket'], ['der Koffer', 'suitcase'], ['der Flughafen', 'airport'], ['die Reise', 'trip / journey'], ['das Gepäck', 'luggage'], ['die Abfahrt', 'departure'], ['die Ankunft', 'arrival'], ['verpassen', 'to miss'], ['ankommen', 'to arrive'], ['der Strand', 'beach'], ['das Wetter', 'weather'], ['die Landkarte', 'map'], ['die Brücke', 'bridge'], ['der Reisepass', 'passport'], ['die Unterkunft', 'accommodation'], ['das Frühstück', 'breakfast'], ['das Abendessen', 'dinner'], ['die Hausaufgaben', 'homework'], ['die Pause', 'break'], ['der Bleistift', 'pencil'], ['das Heft', 'exercise book'], ['schwierig', 'difficult'], ['einfach', 'easy'], ['laut', 'loud'], ['leise', 'quiet'], ['teuer', 'expensive'], ['billig', 'cheap'], ['gestern', 'yesterday'], ['morgen', 'tomorrow'], ['immer', 'always'], ['manchmal', 'sometimes'], ['die Insel', 'island'], ['der Berg', 'mountain'], ['der Fluss', 'river'], ['der Wald', 'forest'], ['das Geschenk', 'present / gift'], ['der Geburtstag', 'birthday'], ['die Nachricht', 'message'], ['erklären', 'to explain'], ['vergessen', 'to forget'], ['sich erinnern', 'to remember'], ['die Umwelt', 'environment'], ['der Müll', 'rubbish / trash'], ['die Zukunft', 'future'], ['der Nachbar', 'neighbour'], ['gewinnen', 'to win'], ['verlieren', 'to lose']];
const FR_WORDS = [['der Hund', 'le chien'], ['die Katze', 'le chat'], ['das Haus', 'la maison'], ['die Schule', 'l’école'], ['der Freund', 'l’ami'], ['das Buch', 'le livre'], ['das Wasser', 'l’eau'], ['der Apfel', 'la pomme'], ['die Stadt', 'la ville'], ['das Fenster', 'la fenêtre'], ['der Tisch', 'la table'], ['der Stuhl', 'la chaise'], ['das Brot', 'le pain'], ['der Bruder', 'le frère'], ['die Schwester', 'la sœur'], ['groß', 'grand'], ['klein', 'petit'], ['heute', 'aujourd’hui'], ['morgen', 'demain'], ['gestern', 'hier'], ['das Zimmer', 'la chambre'], ['die Küche', 'la cuisine'], ['der Garten', 'le jardin'], ['spielen', 'jouer'], ['essen', 'manger'], ['trinken', 'boire'], ['sprechen', 'parler'], ['wohnen', 'habiter'], ['der Montag', 'lundi'], ['die Woche', 'la semaine']];
const LA_WORDS = [['der Sklave', 'servus'], ['der Herr', 'dominus'], ['die Freundin', 'amica'], ['der Senator', 'senator'], ['rufen', 'vocare'], ['sehen', 'videre'], ['hören', 'audire'], ['kommen', 'venire'], ['schreiben', 'scribere'], ['lesen', 'legere'], ['groß', 'magnus'], ['gut', 'bonus'], ['schlecht', 'malus'], ['der Krieg', 'bellum'], ['der Frieden', 'pax'], ['die Stadt', 'urbs'], ['das Volk', 'populus'], ['der König', 'rex'], ['das Wort', 'verbum'], ['jetzt', 'nunc'], ['immer', 'semper'], ['und', 'et'], ['aber', 'sed'], ['nicht', 'non'], ['der Weg', 'via'], ['das Leben', 'vita'], ['der Gott', 'deus'], ['das Wasser', 'aqua'], ['die Erde', 'terra'], ['der Brief', 'epistula']];
const ES_WORDS = [['der Hund', 'el perro'], ['die Katze', 'el gato'], ['das Haus', 'la casa'], ['die Schule', 'la escuela'], ['der Freund', 'el amigo'], ['das Buch', 'el libro'], ['das Wasser', 'el agua'], ['der Apfel', 'la manzana'], ['die Stadt', 'la ciudad'], ['das Fenster', 'la ventana'], ['der Tisch', 'la mesa'], ['die Familie', 'la familia'], ['der Strand', 'la playa'], ['das Meer', 'el mar'], ['sprechen', 'hablar'], ['essen', 'comer'], ['leben', 'vivir'], ['heute', 'hoy'], ['morgen', 'mañana'], ['groß', 'grande'], ['klein', 'pequeño'], ['schön', 'bonito'], ['die Woche', 'la semana'], ['der Sommer', 'el verano'], ['der Winter', 'el invierno']];
const WORDS_BY_SUBJECT = { Englisch: EN_WORDS, Französisch: FR_WORDS, Latein: LA_WORDS, Spanisch: ES_WORDS };

// Quiz lines in the format of examples/quiz-werkstatt: "Frage | richtig | falsch | falsch | falsch" or "Frage | Antwort".
const QUIZZES = {
  Geschichte: { titles: ['Das Mittelalter', 'Die Römer', 'Französische Revolution', 'Steinzeit', 'Weimarer Republik'], fragen: ['Wann wurde Karl der Große Kaiser? | 800 | 1066 | 476 | 1492', 'Wie hieß die Burg-Wohnung des Burgherrn? | Palas | Bergfried | Zwinger | Kemenate', 'Wer war der erste römische Kaiser? | Augustus | Caesar | Nero | Trajan', 'In welchem Jahr begann die Französische Revolution? | 1789', 'Wie hieß der Grenzwall der Römer in Germanien? | Limes | Rubikon | Hadrian | Forum', 'Welche Stadt war Hauptstadt des Byzantinischen Reiches? | Konstantinopel | Rom | Athen | Alexandria', 'Wie nennt man die Zeit vor der Erfindung der Schrift? | Vorgeschichte | Antike | Mittelalter | Neuzeit', 'Wann fiel die Berliner Mauer? | 1989', 'Wer schrieb die 95 Thesen? | Martin Luther | Johannes Calvin | Karl V. | Erasmus'] },
  Biologie: { titles: ['Die Zelle', 'Ökosystem Wald', 'Der menschliche Körper', 'Fotosynthese'], fragen: ['Wo liegt die Erbinformation? | Zellkern | Zellwand | Vakuole | Ribosom', 'Welches Organ pumpt das Blut? | Herz | Lunge | Leber | Niere', 'Was entsteht bei der Fotosynthese? | Sauerstoff | Stickstoff | Helium | Methan', 'Wie viele Knochen hat ein Erwachsener ungefähr? | 206 | 106 | 306 | 56', 'Welche Tiere sind Säugetiere? | Wale | Haie | Pinguine | Krokodile', 'Wie heißt das grüne Blattpigment? | Chlorophyll', 'Was zersetzt im Wald das Laub? | Destruenten | Produzenten | Konsumenten | Parasiten', 'Wie heißt die Hülle einer Pflanzenzelle? | Zellwand'] },
  Erdkunde: { titles: ['Europa', 'Klimazonen', 'Deutschland', 'Die Kontinente'], fragen: ['Wie heißt der längste Fluss Deutschlands? | Rhein | Elbe | Donau | Weser', 'Wie heißt die Hauptstadt von Kanada? | Ottawa | Toronto | Vancouver | Montreal', 'Wie viele Bundesländer hat Deutschland? | 16', 'Welches ist der höchste Berg Deutschlands? | Zugspitze | Watzmann | Brocken | Feldberg', 'In welcher Klimazone liegt Deutschland? | gemäßigte Zone | Tropen | Subtropen | Polarzone', 'Welcher Kontinent ist der größte? | Asien | Afrika | Europa | Amerika', 'Wie heißt die Hauptstadt von Australien? | Canberra | Sydney | Melbourne | Perth', 'Welches Meer liegt im Norden Deutschlands? | Nordsee'] },
  Mathematik: { titles: ['Bruchrechnung', 'Prozente', 'Geometrie', 'Gleichungen'], fragen: ['Was ist 3/4 von 20? | 15 | 12 | 16 | 5', 'Was sind 15 % von 200? | 30 | 15 | 20 | 35', 'Wie groß ist die Winkelsumme im Dreieck? | 180° | 360° | 90° | 270°', 'Löse: 2x + 6 = 14 | 4', 'Welche Zahl ist eine Primzahl? | 13 | 9 | 15 | 21', 'Was ist 1/2 + 1/3? | 5/6 | 2/5 | 1/6 | 2/3', 'Wie viele Ecken hat ein Würfel? | 8', 'Was ist 7 · 8? | 56'] },
  Physik: { titles: ['Elektrischer Strom', 'Kräfte', 'Optik'], fragen: ['In welcher Einheit misst man Kraft? | Newton | Watt | Volt | Joule', 'Was leitet Strom gut? | Kupfer | Holz | Glas | Gummi', 'Wie schnell ist Licht ungefähr? | 300 000 km/s | 300 km/s | 3 000 km/s | 30 000 km/s', 'In welcher Einheit misst man Spannung? | Volt', 'Was passiert mit Licht an einem Spiegel? | Reflexion | Brechung | Beugung | Streuung', 'Formelzeichen der Stromstärke? | I'] },
  Chemie: { titles: ['Elemente', 'Säuren und Basen', 'Stoffe trennen'], fragen: ['Welches Symbol hat Gold? | Au | Ag | Go | Gd', 'Welcher pH-Wert ist neutral? | 7 | 0 | 14 | 1', 'Woraus besteht Wasser? | Wasserstoff und Sauerstoff | Stickstoff und Sauerstoff | Kohlenstoff und Wasserstoff | Helium und Sauerstoff', 'Wie trennt man Salz und Wasser? | Eindampfen | Filtrieren | Sieben | Dekantieren', 'Welches Element hat das Symbol O? | Sauerstoff', 'Ist Zitronensaft sauer oder basisch? | sauer'] },
  Deutsch: { titles: ['Wortarten', 'Kommasetzung', 'Satzglieder'], fragen: ['Welche Wortart ist „schnell“? | Adjektiv | Nomen | Verb | Präposition', 'Wie heißt der Plural von „Atlas“? | Atlanten | Atlasse | Atlase | Atlässe', 'Welches Wort ist ein Nomen? | Freude | freuen | fröhlich | froh', 'Was ist das Subjekt in „Der Hund bellt“? | Der Hund | bellt | Der | Hund bellt', 'Wer schrieb „Der Erlkönig“? | Goethe | Schiller | Heine | Fontane', 'Welcher Fall antwortet auf „Wem?“ | Dativ'] },
  Englisch: { titles: ['Grammatik-Check Unit 3', 'Simple Past', 'Vokabeltest'], fragen: ['Simple past von „go“? | went | goed | gone | going', 'Welches Wort passt? She ___ to school by bus. | goes | go | going | gone', 'Plural von „child“? | children', 'Übersetze: der Bahnhof | station', 'Simple past von „buy“? | bought | buyed | brought | buy', 'Gegenteil von „expensive“? | cheap', 'Welches Fragewort passt? ___ do you live? | Where | Who | What | Which', 'Welcher Satz ist richtig? | I have never been to London. | I never was in London since. | I have never be to London. | I am never been to London.'] },
  Informatik: { titles: ['Algorithmen', 'Binärzahlen', 'Internet'], fragen: ['Was ist 1010 im Dezimalsystem? | 10 | 8 | 12 | 5', 'Wofür steht HTML? | Hypertext Markup Language | High Tech Modern Language | Home Tool Markup Language | Hyperlink Text Mode Language', 'Wie viele Bit hat ein Byte? | 8', 'Was ist eine Schleife? | eine Wiederholung | eine Variable | ein Fehler | ein Kommentar', 'Was bedeutet „WWW“? | World Wide Web', 'Welche Zahl ist binär 111? | 7 | 3 | 111 | 6'] },
  Musik: { titles: ['Instrumente', 'Komponisten'], fragen: ['Wie viele Linien hat ein Notensystem? | 5', 'Welches Instrument ist ein Blechblasinstrument? | Trompete | Querflöte | Klarinette | Oboe', 'Wer komponierte die „Mondscheinsonate“? | Beethoven | Mozart | Bach | Haydn', 'Wie heißt der Schlüssel für hohe Töne? | Violinschlüssel | Bassschlüssel | Altschlüssel | Tenorschlüssel', 'Wie viele Saiten hat eine Gitarre meist? | 6'] },
};

// Flashcard decks for examples/lernkarten: [front, back].
const DECKS = {
  Erdkunde: { titel: 'Bundesländer und Hauptstädte', karten: [['Bayern', 'München'], ['Sachsen', 'Dresden'], ['Hessen', 'Wiesbaden'], ['Niedersachsen', 'Hannover'], ['Nordrhein-Westfalen', 'Düsseldorf'], ['Schleswig-Holstein', 'Kiel'], ['Thüringen', 'Erfurt'], ['Brandenburg', 'Potsdam'], ['Saarland', 'Saarbrücken'], ['Rheinland-Pfalz', 'Mainz'], ['Sachsen-Anhalt', 'Magdeburg'], ['Mecklenburg-Vorpommern', 'Schwerin'], ['Baden-Württemberg', 'Stuttgart'], ['Berlin', 'Berlin'], ['Hamburg', 'Hamburg'], ['Bremen', 'Bremen']] },
  Chemie: { titel: 'Elemente und Symbole', karten: [['H', 'Wasserstoff'], ['He', 'Helium'], ['C', 'Kohlenstoff'], ['N', 'Stickstoff'], ['O', 'Sauerstoff'], ['Na', 'Natrium'], ['Mg', 'Magnesium'], ['Al', 'Aluminium'], ['S', 'Schwefel'], ['Cl', 'Chlor'], ['K', 'Kalium'], ['Ca', 'Calcium'], ['Fe', 'Eisen'], ['Cu', 'Kupfer'], ['Zn', 'Zink'], ['Ag', 'Silber'], ['Au', 'Gold'], ['Pb', 'Blei']] },
  Biologie: { titel: 'Fachbegriffe Zelle', karten: [['Zellkern', 'enthält die Erbinformation'], ['Mitochondrium', 'Kraftwerk der Zelle'], ['Chloroplast', 'Ort der Fotosynthese'], ['Zellmembran', 'grenzt die Zelle ab'], ['Vakuole', 'Speicher für Zellsaft'], ['Zellwand', 'gibt Pflanzenzellen Halt'], ['Cytoplasma', 'Grundsubstanz der Zelle'], ['Ribosom', 'baut Proteine'], ['Gewebe', 'Verband gleichartiger Zellen'], ['Organ', 'Verband verschiedener Gewebe']] },
  Englisch: { titel: 'Irregular Verbs', karten: [['go', 'went – gone'], ['see', 'saw – seen'], ['take', 'took – taken'], ['give', 'gave – given'], ['write', 'wrote – written'], ['eat', 'ate – eaten'], ['buy', 'bought – bought'], ['think', 'thought – thought'], ['come', 'came – come'], ['find', 'found – found'], ['speak', 'spoke – spoken'], ['swim', 'swam – swum'], ['begin', 'began – begun'], ['drink', 'drank – drunk']] },
  Geschichte: { titel: 'Wichtige Jahreszahlen', karten: [['Krönung Karls des Großen', '800'], ['Entdeckung Amerikas', '1492'], ['Thesenanschlag Luthers', '1517'], ['Westfälischer Frieden', '1648'], ['Französische Revolution', '1789'], ['Reichsgründung', '1871'], ['Ende des Ersten Weltkriegs', '1918'], ['Gründung der Bundesrepublik', '1949'], ['Mauerfall', '1989'], ['Deutsche Einheit', '1990']] },
  Physik: { titel: 'Größen und Einheiten', karten: [['Kraft', 'Newton (N)'], ['Spannung', 'Volt (V)'], ['Stromstärke', 'Ampere (A)'], ['Widerstand', 'Ohm (Ω)'], ['Energie', 'Joule (J)'], ['Leistung', 'Watt (W)'], ['Masse', 'Kilogramm (kg)'], ['Zeit', 'Sekunde (s)'], ['Temperatur', 'Kelvin (K)'], ['Frequenz', 'Hertz (Hz)']] },
  Latein: { titel: 'Vokabeln Lektion 5', karten: LA_WORDS.slice(0, 16).map(([de, la]) => [la, de]) },
  Französisch: { titel: 'Vocabulaire Unité 2', karten: FR_WORDS.slice(0, 16).map(([de, fr]) => [fr, de]) },
};

const TEMPLATES = ['vokabeltrainer', 'sternenfaenger', 'quiz-werkstatt', 'kopfrechnen', 'pixel-studio', 'lernkarten'];
// emoji / colour of the demo, expected result rounds per opening, weight in a person's choice of apps
const TEMPLATE_INFO = {
  vokabeltrainer: { emoji: '🔤', color: 1, rps: 1.55, w: 1.1 },
  sternenfaenger: { emoji: '⭐', color: 4, rps: 2.5, w: 1.0 },
  'quiz-werkstatt': { emoji: '💡', color: 0, rps: 1.25, w: 0.9 },
  kopfrechnen: { emoji: '🧮', color: 2, rps: 2.0, w: 1.0 },
  'pixel-studio': { emoji: '🎨', color: 3, rps: 0, w: 0.8 },
  lernkarten: { emoji: '📚', color: 5, rps: 1.2, w: 0.9 },
};
const PIXEL_PALETTE = ['#ffffff', '#2b2118', '#e03131', '#f08c00', '#ffd43b', '#2f9e44', '#1c7ed6', '#7048e8', '#f783ac', '#8d6e63'];
const STAR_MODES = { leicht: 'Leicht', normal: 'Normal', schwer: 'Schwer' };
const SIGNS = { plus: '+', minus: '−', mal: '·', geteilt: ':' };

const VERSION_NOTES = ['Neue Fragen ergänzt', 'Fehler beim Speichern behoben', 'Schönere Farben', 'Mehr Level', 'Wortliste erweitert', 'Texte korrigiert', 'Läuft jetzt auch auf dem Handy', 'Startbildschirm überarbeitet', 'Bestenliste repariert', 'Tippfehler behoben', 'Schwierigkeit angepasst', 'Hilfe-Text ergänzt'];
const RETURN_REASONS = ['Bitte schreib auf die Startseite, wie das Spiel funktioniert.', 'Die Texte haben noch einige Rechtschreibfehler – schau sie dir bitte noch einmal an.', 'Auf dem Handy ist der Knopf „Start“ nicht zu sehen.', 'Bei Frage 3 ist die richtige Antwort falsch eingetragen.', 'Das Spiel ist noch zu schwer für die 5. Klasse – mach Level 1 etwas leichter.', 'Bitte nimm den Namen deiner Mitschülerin aus der App, das ist privat.', 'Die Musik startet von selbst und ist sehr laut. Bitte nur auf Knopfdruck.', 'Es fehlt noch ein Titel und eine kurze Beschreibung.', 'Die Farben sind schwer zu lesen (gelb auf weiß). Bitte mehr Kontrast.', 'Nach dem Ende kann man nicht noch einmal spielen.', 'Einige Bilder laden nicht – lade sie bitte mit hoch.', 'Bitte erkläre im Spiel, was die Punkte bedeuten.'];
const APPROVE_NOTES = ['Schön gemacht!', 'Super, die Klasse wird sich freuen.', 'Danke, jetzt passt alles.', 'Toll verbessert!', 'Gute Idee – freigegeben.', 'Prima, die Fehler sind weg.'];
const REVIEW_COMMENTS = ['Sieht schon gut aus! Ich schaue es mir am Wochenende genauer an.', 'Kannst du mir erklären, was der zweite Knopf macht?', 'Die Idee gefällt mir sehr.', 'Wie viele Level soll es am Ende geben?', 'Läuft bei mir gut – auch auf dem Tablet.', 'Bitte prüf noch die Rechtschreibung im Startbildschirm.', 'Die Bestenliste funktioniert, klasse!', 'Ich habe zwei Runden gespielt – macht Spaß.'];
const OWNER_REPLIES = ['Danke, ich habe es geändert!', 'Ich habe die Fehler verbessert und neu veröffentlicht.', 'Okay, mache ich bis Freitag.', 'Ist jetzt drin, können Sie noch mal schauen?', 'Ich wusste nicht, wie das geht – ich frage morgen im Unterricht.', 'Hab die Farben geändert.'];
const COLLEAGUE_COMMENTS = ['Benutze ich in meiner 7c – läuft prima.', 'Könntest du noch eine leichtere Stufe einbauen?', 'Danke fürs Teilen!', 'Meine Klasse liebt die App.', 'Gibt es die Wortliste auch für Unit 4?'];
const FEEDBACK_TEXTS = [
  'Super gemacht, {first}! Weiter so.',
  'Toll, {first} – du bist richtig drangeblieben.',
  'Schau dir die Aufgaben, die du falsch hattest, noch einmal in Ruhe an.',
  'Du hast die Aufgabe noch nicht abgeschlossen. Denk an den Termin!',
  'Sehr ordentlich gearbeitet. Versuch beim nächsten Mal, etwas genauer zu lesen.',
  'Klasse Ergebnis in „{app}“! Probier jetzt die nächste Stufe.',
  'Ich sehe, dass du viel geübt hast – das zahlt sich aus.',
  'Bitte übe die Wörter aus der letzten Stunde noch einmal, das sitzt noch nicht ganz.',
  '{first}, du warst diese Woche sehr fleißig. Danke!',
  'Achte bei den Rechenaufgaben auf die Vorzeichen.',
  'Gute Steigerung seit letzter Woche!',
  'Mach bitte noch eine Runde „{app}“ bis Freitag.',
  'Das war schon sehr gut. Bei den letzten Fragen hast du dich etwas beeilt – lass dir ruhig Zeit.',
  'Prima! Du kannst dir jetzt die Bonusaufgabe vornehmen.',
  'Ich habe gesehen, dass du dir Mühe gegeben hast. Frag ruhig nach, wenn etwas unklar ist.',
  'Du hast fast alles richtig – nur die unregelmäßigen Formen brauchen noch Übung.',
  'Bitte arbeite die Aufgabe zu Ende, bevor du ein anderes Spiel startest.',
  'Sehr schön! Erklär deinem Nachbarn morgen doch einmal, wie du vorgegangen bist.',
  'Nicht aufgeben – beim zweiten Versuch klappt es bestimmt besser.',
  'Volle Punktzahl, Glückwunsch!',
];
const ASSIGNMENT_NOTES = ['Spiel mindestens zwei Runden und versuch, über 80 % zu kommen.', 'Übt die Wörter aus der Stunde – am Freitag schreiben wir den Test.', 'Bitte bis zur nächsten Stunde erledigen.', 'Wer fertig ist, kann die nächste Stufe probieren.', 'Arbeitet in Ruhe – es zählt nicht die Zeit.', 'Macht die Runde zweimal: einmal allein, einmal mit eurem Lernpartner.', 'Zur Vorbereitung auf die Klassenarbeit.', 'Freiwillige Zusatzübung für alle, die noch üben möchten.'];
const SCHOOL_ANNOUNCEMENTS = [['Willkommen im neuen Schuljahr!', 'Alle Apps aus dem letzten Jahr sind noch da. Neue Klassen legen eure Lehrkräfte in den ersten Tagen an – ihr tretet per QR-Code bei.'], ['Neue Apps für die ganze Schule', 'Im Katalog findet ihr neue Lern-Apps für alle Klassenstufen. Schaut mal rein!'], ['Wartung am Samstag', 'Am Samstag zwischen 8 und 10 Uhr ist SchulHub kurz nicht erreichbar.'], ['Projektwoche', 'In der Projektwoche nutzen die neunten Klassen SchulHub für ihre Projekte. Bitte denkt an eure Zugangsdaten.'], ['Herbstferien', 'Schöne Ferien! SchulHub bleibt erreichbar – wer möchte, kann weiter üben.'], ['Datenschutz: Meine Daten', 'Unter „Meine Daten“ seht ihr jederzeit, was gespeichert ist, und könnt es herunterladen oder löschen.']];
const CLASS_ANNOUNCEMENTS = [['Vokabeltest am Freitag', 'Am Freitag schreiben wir den Test zu Unit 3. Übt vorher im Vokabeltrainer!'], ['Neue App in der Klasse', 'Ich habe eine neue App freigeschaltet. Probiert sie bis zur nächsten Stunde aus.'], ['Klassenarbeit nächste Woche', 'Die Klassenarbeit ist am Dienstag. Nutzt die Lernkarten zur Vorbereitung.'], ['Hausaufgabe', 'Bitte erledigt bis Montag die Aufgabe im Hub.'], ['Ausflug', 'Denkt an den Ausflug am Donnerstag – wir treffen uns um 8 Uhr am Bahnhof.'], ['Bitte Kopfhörer mitbringen', 'In der nächsten Stunde arbeiten wir mit den Apps. Bringt bitte Kopfhörer mit.'], ['Wettbewerb', 'Wer bis zu den Ferien die meisten richtigen Antworten hat, bekommt einen kleinen Preis!'], ['Stunde fällt aus', 'Die Stunde am Mittwoch fällt aus. Nutzt die Zeit für die Aufgabe im Hub.']];
const UPLOAD_REFUSALS = ['Der Dateityp von "video.mov" ist nicht erlaubt. Erlaubt sind Web-Dateien wie HTML, CSS, JS, Bilder, Töne, Schriften und WASM.', 'In der App fehlt die Startdatei "index.html" (sie muss ganz oben im Ordner liegen).', 'Die Datei ist kein gültiges ZIP-Archiv.', 'Der Dateityp von "spiel.exe" ist nicht erlaubt. Erlaubt sind Web-Dateien wie HTML, CSS, JS, Bilder, Töne, Schriften und WASM.', '"musik.wav" ist zu groß (maximal 25 MB pro Datei).'];

// App names by template. `x` is the owner's subject (teachers) or first name (students).
const TEACHER_APP_NAMES = {
  vokabeltrainer: (R, subj) => {
    const n = R.int(1, 7);
    return R.pick({
      Französisch: [`Vocabulaire Unité ${n}`, `Französisch Lektion ${n}`, 'Vokabeln Französisch'],
      Latein: [`Latein Lektion ${n}`, `Vokabeln Prima ${n}`, 'Lateinvokabeln'],
      Spanisch: [`Vocabulario Unidad ${n}`, 'Spanisch-Vokabeln'],
    }[subj] || [`Vokabeln Unit ${n}`, `English Words Unit ${n}`, 'Vokabeltrainer', 'Words & Phrases', `Vokabel-Check Unit ${n}`, 'Irregular Verbs Trainer']);
  },
  'quiz-werkstatt': (R, subj) => {
    const q = QUIZZES[subj];
    return q ? `${subj}-Quiz: ${R.pick(q.titles)}` : R.pick(['Allgemeinwissen-Quiz', 'Quiz der Woche', 'Rätselrunde', 'Wissens-Check']);
  },
  lernkarten: (R, subj) => (DECKS[subj] ? R.pick([DECKS[subj].titel, `Lernkarten ${subj}`, `${subj}: Karteikarten`]) : R.pick(['Hauptstädte Europas', 'Lernkartei', 'Karteikarten'])),
  kopfrechnen: (R) => R.pick(['Kopfrechnen', 'Einmaleins-Sprint', 'Mathe-Sprint', 'Blitzrechnen', 'Rechenkönig', 'Kopfrechentraining', 'Plus & Minus bis 100']),
  sternenfaenger: (R) => R.pick(['Sternenfänger', 'Sternenjagd', 'Weltraum-Pause', 'Fang die Sterne', 'Belohnungsspiel']),
  'pixel-studio': (R) => R.pick(['Pixel-Studio', 'Pixelkunst', 'Pixelbilder', 'Malwerkstatt', 'Kunst: Pixel-Art']),
};
const STUDENT_APP_NAMES = {
  'pixel-studio': (R, f) => R.pick([`${f}s Pixelwelt`, 'Mein Pixel-Studio', 'Pixelparty', 'Pixel-Malbuch', 'Bunte Pixel', 'Pixelzoo', 'Kunstwerkstatt']),
  sternenfaenger: (R, f) => R.pick([`${f}s Sternenjagd`, 'Super Sternenfänger', 'Weltraum-Abenteuer', 'Meteoritenregen', 'Galaxy Run', 'Sternenregen', 'Raketenflug', 'Mein erstes Spiel']),
  'quiz-werkstatt': (R, f) => R.pick([`${f}s Quiz`, 'Tier-Quiz', 'Fußball-Quiz', 'Quiz über Hunde', 'Weltraum-Quiz', 'Dino-Quiz', 'Musik-Quiz', 'Pferde-Quiz']),
  kopfrechnen: (R, f) => R.pick(['Mathe-Blitz', 'Rechen-Rakete', `${f}s Rechenspiel`, 'Einmaleins-Turbo', 'Mathe-Challenge']),
  lernkarten: (R, f) => R.pick(['Lernkarten Bio', 'Vokabelkarten', 'Spickzettel', 'Merkkarten', `${f}s Lernkarten`]),
  vokabeltrainer: (R, f) => R.pick(['Vokabel-Booster', 'English Trainer', `${f}s Vokabeln`, 'Wörter lernen', 'Vocab Master']),
};
// The authors' descriptions of the example apps (as in src/seed.js).
const TEMPLATE_DESCRIPTIONS = {
  vokabeltrainer: 'Vokabeln üben – die Lehrkraft legt die Wörter für die Klasse fest. Mit Fortschritt, Erfolgen und Bestenliste.',
  sternenfaenger: 'Fang die Sterne, weich den Meteoriten aus. Zehn Level, Bestenliste und Erfolge.',
  'quiz-werkstatt': 'Ein Quiz für jedes Fach: Die Lehrkraft schreibt die Fragen im Hub, die Klasse spielt – mit Auswahl- oder Eintipp-Antworten.',
  kopfrechnen: 'Kopfrechen-Sprint auf Zeit: fünf Stufen, Bestzeiten in der Klasse. Zahlenraum und Rechenarten stellt die Lehrkraft ein.',
  'pixel-studio': 'Male Pixelbilder. Deine Bilder werden in deinem Konto gespeichert – und als PNG in deiner Galerie.',
  lernkarten: 'Karteikarten mit Lernkartei: Was du kannst, kommt seltener dran. Für jedes Fach – die Karten legt die Lehrkraft fest.',
};
const STUDENT_DESCRIPTIONS = ['Mein erstes eigenes Spiel!', 'Viel Spaß beim Spielen :)', 'Gemacht im Informatikunterricht.', 'Schafft ihr alle Level?', 'Zum Üben für die Arbeit.', 'Noch nicht fertig, aber schon spielbar.'];

/** The quiz app's fingerprint of a question set (same function as in examples/quiz-werkstatt/app.js). */
function fingerprint(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}
/** The flashcard app's id of a card (examples/lernkarten/app.js). */
function cardId(pair) {
  const text = `${pair[0]}\u0000${pair[1]}`;
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}
/** 48.2 -> "48,2 s", 65.3 -> "1:05,3 min" (examples/kopfrechnen/app.js). */
function timeText(seconds) {
  const dec = (n) => (Math.round(n * 10) / 10).toFixed(1).replace('.', ',');
  if (seconds < 60) return `${dec(seconds)} s`;
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${dec(s)} min`;
}
function typo(s) {
  const swapped = s.length > 4 ? s.slice(0, 2) + s[3] + s[2] + s.slice(4) : s;
  return swapped !== s ? swapped : s.slice(0, -1) || `${s}e`;
}

// ================================================================ drawings

/** A 16 x 16 pixel picture (colour indexes of the Pixel-Studio palette), like a pupil would paint. */
function drawing(seed) {
  const R = makeRandom(seed);
  const px = new Array(256).fill(0);
  const set = (x, y, c) => {
    if (x >= 0 && x < 16 && y >= 0 && y < 16) px[y * 16 + x] = c;
  };
  const rect = (x0, y0, x1, y1, c) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, c);
  };
  const kind = R.int(0, 6);
  const c = () => R.int(1, 9);
  if (kind === 0) {
    const col = R.pick([2, 8, 7]);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const px2 = (x + 0.5 - 8) / 5.6;
        const py = (8 - (y + 0.5)) / 5.6 + 0.15;
        if ((px2 * px2 + py * py - 1) ** 3 - px2 * px2 * py ** 3 <= 0) set(x, y, col);
      }
    }
  } else if (kind === 1) {
    rect(0, 0, 15, 9, 6);
    rect(0, 10, 15, 15, 5);
    rect(4, 7, 11, 13, R.pick([2, 3, 9]));
    for (let k = 0; k < 5; k++) rect(4 + k, 6 - k, 11 - k, 6 - k, 2);
    rect(7, 10, 8, 13, 1);
    set(R.int(1, 3), R.int(1, 3), 4);
  } else if (kind === 2) {
    rect(7, 9, 8, 15, 9);
    for (let y = 1; y < 10; y++) for (let x = 2; x < 14; x++) if ((x - 7.5) ** 2 / 30 + (y - 5) ** 2 / 16 <= 1) set(x, y, 5);
    for (let k = 0; k < 4; k++) set(R.int(4, 11), R.int(3, 7), 2);
  } else if (kind === 3) {
    const face = R.pick([4, 3]);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if ((x - 7.5) ** 2 + (y - 7.5) ** 2 <= 49) set(x, y, face);
    set(5, 5, 1);
    set(10, 5, 1);
    for (let x = 4; x <= 11; x++) set(x, x === 4 || x === 11 ? 9 : 10, 1);
  } else if (kind === 4) {
    const a = c();
    const b = c();
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) set(x, y, Math.floor((x + y * R.int(0, 1)) / 2) % 2 ? a : b);
  } else if (kind === 5) {
    rect(0, 0, 15, 15, 6);
    for (let y = 1; y < 6; y++) for (let x = 10; x < 15; x++) if ((x - 12) ** 2 + (y - 3) ** 2 <= 4) set(x, y, 4);
    rect(0, 12, 15, 15, R.pick([5, 4, 9]));
    for (let k = 0; k < 3; k++) rect(R.int(0, 9), R.int(2, 5), R.int(10, 12), R.int(5, 6), 0);
  } else {
    for (let k = 0; k < R.int(3, 7); k++) {
      const col = c();
      const cx = R.int(0, 15);
      const cy = R.int(0, 15);
      const r = R.int(1, 4);
      for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) set(x, y, col);
    }
  }
  return px;
}

/** A real PNG (320 x 320, indexed colours) of a 16 x 16 picture - what Pixel-Studio's "Als Bild speichern" uploads. */
function encodePng(pixels) {
  const W = 320;
  const SCALE = 20;
  const raw = Buffer.alloc((W + 1) * W);
  for (let y = 0; y < W; y++) {
    const row = y * (W + 1);
    const py = Math.floor(y / SCALE) * 16;
    for (let x = 0; x < W; x++) raw[row + 1 + x] = pixels[py + Math.floor(x / SCALE)];
  }
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(W, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 3; // indexed colour
  const plte = Buffer.from(PIXEL_PALETTE.flatMap((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('PLTE', plte), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ================================================================ templates

/**
 * Upload and analyse each example app once through the Hub's own path (as src/seed.js does):
 * blobs land in blobs/, the check report and the validated manifest are made by the Hub.
 * The temporary uploader and its apps are removed again; the blobs stay for the seeded versions.
 */
function analyseTemplates(ctx) {
  const { db, services, uploads, config } = ctx;
  const id = 'scale-template-uploader';
  db.run("INSERT INTO users (id, oid, name, email, role, created_at) VALUES (?, ?, 'Vorlagen', 'vorlagen@schule.example', 'teacher', 0)", id, `x-${id}`);
  const owner = db.get('SELECT * FROM users WHERE id = ?', id);
  const out = {};
  for (const folder of TEMPLATES) {
    const appId = services.createApp(owner, { name: folder, emoji: TEMPLATE_INFO[folder].emoji, color: '0' });
    const app = db.get('SELECT * FROM apps WHERE id = ?', appId);
    const version = services.createVersion(app);
    uploads.addDirectory(version, owner.id, path.join(config.root, 'examples', folder));
    services.finishVersion(owner, app, version);
    const v = db.get('SELECT * FROM app_versions WHERE id = ?', version.id);
    const files = db.all('SELECT path, path_lower, size, sha256 FROM app_files WHERE version_id = ? ORDER BY path', version.id);
    if (!v.manifest) throw new Error(`examples/${folder}: no manifest after analysis`);
    out[folder] = { folder, manifestJson: v.manifest, reportJson: v.report, manifest: JSON.parse(v.manifest), fileCount: v.file_count, totalBytes: v.total_bytes, files };
    out[folder].defaults = effectiveSettings(out[folder].manifest, null);
  }
  db.run('DELETE FROM audit_log WHERE actor_id = ?', id);
  db.run('DELETE FROM users WHERE id = ?', id); // cascades: the temporary apps, versions and file rows
  return out;
}

// ================================================================ the school

function buildSchool(R, cal, TPL, opts) {
  const { NOW, days } = cal;
  const S = opts.students;
  const T = opts.teachers;
  const C = opts.classes;
  const D = opts.days;
  const W = NOW - D * DAY; // start of the activity window
  const WI = cal.indexOf(W);
  const NI = cal.indexOf(NOW - 1);
  // Retention limits (services.maintenance), with a margin of more than a week.
  const AUDIT_FLOOR = NOW - 355 * DAY; // audit_log: 365 days
  const NOTICE_FLOOR = NOW - 170 * DAY; // notices: 180 days
  const USAGE_FLOOR = NOW - 390 * DAY; // app_usage: 400 days
  const UPGRADE = NOW - 280 * DAY; // results before this were recorded before schema 2: class_id ''
  const SY = cal.SY;
  const LAST_SY = cal.lastSY;
  const ARCHIVED_AT = Math.max(cal.yearEnd + 13 * HOUR, NOW - 300 * DAY); // archived classes: 365 days
  const ARCH_FROM = Math.max(LAST_SY + 14 * DAY, NOW - 335 * DAY); // old results; app_usage keeps 400 days

  const out = {
    people: [], classes: [], apps: [], comments: [], settings: [], shared: [], assignments: [], done: [], feedback: [], announcements: [], dismissed: [],
    codes: [], saves: [], scores: [], results: [], plays: [], progress: [], achievements: [], files: [], favorites: [], usage: new Map(), notices: [], audit: [], dev: [],
    stats: {},
  };

  // ------------------------------------------------------------ events
  function audit(at, actor, action, target = '', detail = '', { subject = null, app = null } = {}) {
    if (actor) touch(actor, at);
    if (at < AUDIT_FLOOR || at >= NOW) return;
    out.audit.push({ at, actor, action, target: String(target).slice(0, 200), detail: String(detail).slice(0, 500), subject, app });
  }
  function notify(users, kind, text, href, at, subject = null) {
    if (at < NOTICE_FLOOR || at >= NOW) return;
    for (const u of new Set(users)) if (u) out.notices.push({ u, kind, text: String(text).slice(0, 300), href, at, subject });
  }

  // ------------------------------------------------------------ time
  const slotTime = (day, slot) => {
    const [a, b] = SLOTS[slot];
    return day.start + R.int(a, b) * MIN + R.int(0, 59) * 1000;
  };
  function slotFor(day, kind) {
    if (kind === 'lesson') return day.school ? 'lesson' : 'free';
    if (kind === 'student') {
      if (!day.school) return R.chance(0.75) ? 'free' : 'evening';
      const r = R.next();
      return r < 0.58 ? 'lesson' : r < 0.86 ? 'afternoon' : r < 0.985 ? 'evening' : 'late';
    }
    if (!day.school) return R.chance(0.5) ? 'free' : 'evening';
    return R.chance(0.62) ? 'office' : R.chance(0.7) ? 'evening' : 'afternoon';
  }
  const lowerBound = (arr, v) => {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  /** A day between from and to: one the person signs in on, else a school day, else any. */
  function pickDay(p, from, to) {
    const a = cal.indexOf(from);
    const b = cal.indexOf(to);
    const act = p ? p.activeDays : [];
    if (act.length) {
      const lo = lowerBound(act, a);
      const hi = lowerBound(act, b + 1);
      if (hi > lo) return days[act[R.int(lo, hi - 1)]];
    }
    for (let k = 0; k < 8; k++) {
      const d = days[R.int(a, b)];
      if (d.school) return d;
    }
    return days[R.int(a, b)];
  }
  /** Something person p does between from and to, at a plausible moment (null if impossible). */
  function timeFor(p, from, to, kind = p.role === 'student' ? 'student' : 'teacher') {
    from = Math.max(from, p.created_at + MIN);
    to = Math.min(to, p.end - MIN, NOW - MIN);
    if (!(to > from)) return null;
    let ts = null;
    for (let k = 0; k < 4 && ts === null; k++) {
      const d = pickDay(p, from, to);
      const t = slotTime(d, slotFor(d, kind));
      if (t >= from && t <= to) ts = t;
    }
    if (ts === null) ts = Math.floor(from + R.next() * (to - from));
    touch(p, ts);
    return ts;
  }
  /** Remember that p was active at ts (inside the window): sign-ins are made from this. */
  function touch(p, ts) {
    if (ts < W || ts >= NOW || !p) return;
    const i = cal.indexOf(ts);
    const d = days[i];
    const school = d.school && ts - d.start < 15 * HOUR + 20 * MIN;
    let t = p.touched.get(i);
    if (!t) p.touched.set(i, (t = { s: null, e: null }));
    if (school) t.s = t.s === null ? ts : Math.min(t.s, ts);
    else t.e = t.e === null ? ts : Math.min(t.e, ts);
  }
  const lessonAt = (dayIndex) => slotTime(days[dayIndex], 'lesson');
  function nthSchoolDay(ts, k) {
    let i = cal.indexOf(ts);
    for (let n = -1; i < days.length - 1; i++) if (days[i].school && ++n === k) return i;
    return i;
  }

  // ------------------------------------------------------------ people
  const people = out.people;
  const students = [];
  const teachers = [];
  function mkPerson(role, n, first, last) {
    const p = {
      idx: people.length, id: R.id(), role, n, first, last, name: `${first} ${last}`, oid: '', email: '',
      created_at: 0, lastYear: false, end: NOW, inactive: false, blockedAt: null, anon: 0,
      prefs: [R.weighted([['dark', 60], ['auto', 26], ['light', 14]]), R.weighted([['normal', 90], ['large', 7], ['larger', 3]]), R.chance(0.1) ? 'reduce' : 'auto', R.chance(0.05) ? 'high' : 'normal'],
      signP: 0.7, act: 1, activeDays: [], touched: new Map(), classes: [], grade: null, homeroom: null, apps: [], lastLogin: null, drawFiles: 0,
    };
    people.push(p);
    return p;
  }
  const surname = zipf(R, SURNAMES, 0.75);
  const girl = zipf(R, GIRLS, 0.45);
  const boy = zipf(R, BOYS, 0.45);
  const woman = zipf(R, T_WOMEN, 0.3);
  const man = zipf(R, T_MEN, 0.3);

  const admin = mkPerson('admin', 0, 'Katrin', 'Albers');
  admin.oid = 'scale-admin';
  admin.email = 'admin@schule.example';
  const staffMail = new Set([admin.email]);
  const tw = Math.max(3, String(T).length);
  const sw = Math.max(4, String(S).length);
  for (let n = 1; n <= T; n++) {
    const p = mkPerson('teacher', n, R.chance(0.62) ? woman() : man(), surname());
    p.oid = `scale-t-${String(n).padStart(tw, '0')}`;
    let mail = `${ascii(p.first)}.${ascii(p.last)}@schule.example`;
    for (let k = 2; staffMail.has(mail); k++) mail = `${ascii(p.first)}.${ascii(p.last)}${k}@schule.example`;
    staffMail.add(mail);
    p.email = mail;
    teachers.push(p);
  }
  const taken = new Set();
  for (let n = 1; n <= S; n++) {
    // The name lists are short: draw again on a clash, so that duplicates stay as rare as in a real school.
    const female = R.chance(0.5);
    let first;
    let last;
    for (let k = 0; k < 30; k++) {
      first = female ? girl() : boy();
      last = surname();
      if (!taken.has(`${first} ${last}`) || R.chance(0.04)) break;
    }
    taken.add(`${first} ${last}`);
    const p = mkPerson('student', n, first, last);
    p.anon = R.chance(0.1) ? 1 : 0;
    students.push(p);
  }
  // Exact duplicate names on purpose (two "Lena Müller" ...).
  [['Lena', 'Müller'], ['Leon', 'Schmidt'], ['Elif', 'Yılmaz']].forEach(([f, l], k) => {
    for (const i of [(11 + k * 97) % S, (Math.floor(S * 0.6) + k * 31) % S]) Object.assign(students[i], { first: f, last: l, name: `${f} ${l}` });
  });
  for (const p of students) {
    p.oid = `scale-s-${String(p.n).padStart(sw, '0')}`;
    p.email = `${ascii(p.first)}.${ascii(p.last)}.${p.n}@schueler.example`;
  }

  // ------------------------------------------------------------ classes
  const classes = out.classes;
  function mkClass(kind, name, subject, grade) {
    const c = { idx: classes.length, id: R.id(), kind, name, subject, grade, created_at: 0, archived_at: null, teachers: [], students: [], rows: [], rowByApp: new Map(), assignments: [], settingsOf: new Map(), classData: new Map(), grades: grade ? [grade] : [] };
    classes.push(c);
    return c;
  }
  function join(c, p, role = 'student', primary = false) {
    const m = { cls: c, p, role, primary, at: 0 };
    (role === 'teacher' ? c.teachers : c.students).push(m);
    p.classes.push(m);
    return m;
  }
  const activeOf = (p) => p.classes.filter((m) => m.cls.kind !== 'archived');

  const nBig = C >= 8 ? 1 : 0;
  const nClubs = Math.max(1, Math.round((C * 3) / 40));
  const nCourses = Math.max(1, Math.round((C * 7) / 40));
  const nHome = Math.max(1, C - nBig - nClubs - nCourses);
  const nArch = Math.max(1, Math.round(C / 5));
  const GRADES = [5, 6, 7, 8, 9, 10];
  const perGrade = GRADES.map((g, i) => Math.floor(nHome / 6) + (i < nHome % 6 ? 1 : 0));
  const subjectPairs = HOMEROOM_SUBJECTS.map((x) => [x, x[2]]);
  const homerooms = [];
  GRADES.forEach((g, gi) => {
    for (let k = 0; k < perGrade[gi]; k++) {
      const [subject, label] = R.weighted(subjectPairs);
      homerooms.push(mkClass('homeroom', `${g}${'abcdefghijklmnopqrstuvwxyz'[k % 26]}${k >= 26 ? Math.floor(k / 26) : ''} ${label}`, subject, g));
    }
  });

  // About 12 % of the students are in no class (Oberstufe, or they left: about 5 % have not signed in for a long time).
  const pool = R.shuffle(students.slice());
  const nClassless = Math.round(S * 0.12);
  const nInactive = Math.min(nClassless, Math.round(S * 0.05));
  const classless = pool.slice(0, nClassless);
  const homePool = pool.slice(nClassless);
  classless.forEach((p, i) => {
    p.inactive = i < nInactive;
    p.grade = R.pick(p.inactive ? [11, 12, 13] : [11, 12]);
  });
  // Homeroom sizes: everybody starts at 24, the rest is spread up to 31 (more only if the school needs it).
  const sizes = homerooms.map(() => 24);
  const capSize = Math.max(31, Math.ceil(homePool.length / homerooms.length));
  const pref = homerooms.map(() => R.real(0.4, 1.6));
  if (homePool.length < 24 * homerooms.length) {
    sizes.fill(Math.floor(homePool.length / homerooms.length));
    for (let i = 0; i < homePool.length % homerooms.length; i++) sizes[i]++;
  } else {
    for (let rest = homePool.length - 24 * homerooms.length; rest > 0; rest--) {
      const open = sizes.map((s, i) => [i, s < capSize ? pref[i] : 0]).filter(([, w]) => w > 0);
      sizes[R.weighted(open)]++;
    }
  }
  {
    let k = 0;
    homerooms.forEach((c, i) => {
      for (let j = 0; j < sizes[i]; j++) {
        const p = homePool[k++];
        p.grade = c.grade;
        p.homeroom = c;
        join(c, p);
      }
    });
  }
  // One whole year group: the class with the most students.
  let big = null;
  let bigRooms = [];
  if (nBig) {
    const g = perGrade[4] >= 3 ? 9 : GRADES[perGrade.indexOf(Math.max(...perGrade))];
    bigRooms = homerooms.filter((c) => c.grade === g).slice(0, 3);
    big = mkClass('big', `Jahrgang ${g} Projektwoche`, 'Fächerübergreifend', g);
    for (const r of bigRooms) for (const m of r.students.slice()) join(big, m.p);
  }
  const courses = [];
  for (let i = 0; i < nCourses; i++) {
    const def = COURSES[i % COURSES.length];
    const c = mkClass('course', i < COURSES.length ? def[0] : `${def[0]} (${Math.floor(i / COURSES.length) + 1})`, def[1], def[2][0]);
    c.grades = def[2];
    courses.push(c);
  }
  const clubs = [];
  for (let i = 0; i < nClubs; i++) {
    const def = CLUBS[i % CLUBS.length];
    clubs.push(mkClass('club', i < CLUBS.length ? def[0] : `${def[0]} ${Math.floor(i / CLUBS.length) + 1}`, def[1], null));
  }
  const kindCount = (p, kind) => p.classes.filter((m) => m.cls.kind === kind).length;
  // A few students in four classes: homeroom, year group, a course and a club.
  const busy = big && courses[0] && clubs[0]
    ? R.sample(big.students.map((m) => m.p).filter((p) => courses[0].grades.includes(p.grade)), Math.max(2, Math.round(S / 200)))
    : [];
  for (const p of busy) {
    join(courses[0], p);
    join(clubs[0], p);
  }
  for (const c of courses) {
    const cand = R.shuffle(homePool.filter((p) => c.grades.includes(p.grade) && !p.classes.some((m) => m.cls === c)));
    cand.sort((a, b) => kindCount(a, 'course') - kindCount(b, 'course'));
    const want = Math.min(cand.length + c.students.length, R.int(15, 25)) - c.students.length;
    for (const p of cand.slice(0, Math.max(0, want))) join(c, p);
  }
  for (const c of clubs) {
    const cand = R.shuffle(homePool.filter((p) => !p.classes.some((m) => m.cls === c)));
    cand.sort((a, b) => kindCount(a, 'club') - kindCount(b, 'club'));
    const want = Math.min(cand.length + c.students.length, R.int(8, 20)) - c.students.length;
    for (const p of cand.slice(0, Math.max(0, want))) join(c, p);
  }
  const active = [...homerooms, ...courses, ...clubs, ...(big ? [big] : [])];

  // Archived classes from last year: their pupils are one grade higher now (grade 10 is now Oberstufe, without a class).
  const archived = [];
  const usedNames = new Set();
  for (let i = 0; i < nArch; i++) {
    let c;
    let members;
    if (i === nArch - 1 && nArch >= 4) {
      c = mkClass('archived', CLUBS[0][0], CLUBS[0][1], null);
      members = R.sample([...homePool.filter((p) => p.grade >= 6), ...classless], R.int(10, 16));
    } else {
      let g;
      let letter;
      let tries = 0;
      do {
        g = R.pick(GRADES);
        letter = 'abcd'[R.int(0, 3)];
      } while (usedNames.has(`${g}${letter}`) && ++tries < 50);
      usedNames.add(`${g}${letter}`);
      const [subject, label] = R.weighted(subjectPairs);
      c = mkClass('archived', `${g}${letter} ${label}`, subject, g);
      const nextYear = homerooms.filter((h) => h.grade === g + 1);
      const same = nextYear.find((h) => h.name.startsWith(`${g + 1}${letter} `)) || (nextYear.length ? R.pick(nextYear) : null);
      const cand = same ? same.students.map((m) => m.p) : classless.slice();
      members = R.sample(cand, Math.min(cand.length, R.int(22, 29)));
    }
    for (const p of members) {
      join(c, p);
      p.lastYear = true;
    }
    archived.push(c);
  }

  // ------------------------------------------------------------ teachers in classes
  const K = Math.min(T, Math.max(3, Math.round(T * 0.45)));
  const tPool = R.shuffle(teachers.slice());
  const withClass = tPool.slice(0, K);
  const noClass = tPool.slice(K);
  let ti = 0;
  const nextTeacher = () => (ti < withClass.length ? withClass[ti++] : R.pick(withClass));
  const open = new Set(active);
  const bigTeacher = nextTeacher();
  for (const c of [...bigRooms, big, courses[0]].filter(Boolean)) {
    join(c, bigTeacher, 'teacher', true);
    open.delete(c);
  }
  for (const n of C >= 20 ? [4, 3] : []) {
    const p = nextTeacher();
    for (const c of R.sample([...open], n)) {
      join(c, p, 'teacher', true);
      open.delete(c);
    }
  }
  for (const c of R.shuffle([...open])) join(c, nextTeacher(), 'teacher', true);
  // About 30 % of the classes have co-teachers (2-3 teachers); the year group has two.
  const coClasses = R.sample(active.filter((c) => c !== big), Math.round(active.length * 0.3) - (big ? 1 : 0));
  if (big) coClasses.push(big);
  for (const c of coClasses) {
    for (let k = 0, n = c === big ? 2 : R.chance(0.3) ? 2 : 1; k < n; k++) {
      const p = nextTeacher();
      if (!c.teachers.some((m) => m.p === p)) join(c, p, 'teacher', false);
    }
  }
  while (ti < withClass.length) {
    const p = withClass[ti++];
    const c = R.pick(active.filter((x) => x !== big && !x.teachers.some((m) => m.p === p)));
    join(c, p, 'teacher', false);
  }
  const coTeacher = withClass.find((p) => p !== bigTeacher && activeOf(p).length === 1 && !activeOf(p)[0].primary) || withClass[withClass.length - 1];
  // Teachers without a class: one signs in as a dev account, some have not signed in for long, some are blocked.
  const devNoClassTeacher = noClass[0];
  const nInactiveT = Math.max(1, Math.round(T * 0.03));
  const nBlockedT = Math.max(1, Math.round(T * 0.02));
  const inactiveTeachers = noClass.slice(1, 1 + nInactiveT);
  const blockedTeachers = noClass.slice(1 + nInactiveT, 1 + nInactiveT + nBlockedT);
  const freeTeachers = noClass.slice(1 + nInactiveT + nBlockedT);
  for (const p of inactiveTeachers) p.inactive = true;
  for (const c of archived) {
    const cands = R.chance(0.75) || !freeTeachers.length ? withClass.filter((p) => p !== coTeacher) : freeTeachers;
    join(c, R.pick(cands), 'teacher', true);
    if (R.chance(0.2)) {
      const p = R.pick(withClass);
      if (!c.teachers.some((m) => m.p === p)) join(c, p, 'teacher', false);
    }
    for (const m of c.teachers) m.p.lastYear = true;
  }

  // ------------------------------------------------------------ timelines
  for (const c of homerooms) c.created_at = lessonAt(nthSchoolDay(SY, R.int(0, 4)));
  for (const c of courses) c.created_at = lessonAt(nthSchoolDay(SY, R.int(3, 12)));
  for (const c of clubs) c.created_at = lessonAt(nthSchoolDay(SY, R.int(6, 18)));
  if (big) big.created_at = lessonAt(nthSchoolDay(Math.max(SY + 10 * DAY, NOW - 26 * DAY), R.int(0, 2)));
  for (const c of archived) {
    c.created_at = lessonAt(nthSchoolDay(LAST_SY, R.int(0, 8)));
    c.archived_at = ARCHIVED_AT + R.int(0, 9) * DAY + R.int(0, 300) * MIN;
  }
  for (const c of [...active, ...archived]) {
    const horizon = Math.min(NOW - 3 * HOUR, c.archived_at || Infinity);
    for (const m of c.teachers) if (m.primary) m.at = c.created_at;
    for (const m of c.students) {
      const r = R.next();
      let at;
      if (c.kind === 'big') at = c.created_at + R.int(3, 2 * 24 * 60) * MIN;
      else if (r < 0.75) at = c.created_at + R.int(3, 110) * MIN; // in the same lesson, by QR code
      else if (r < 0.97) at = lessonAt(cal.indexOf(c.created_at + R.real(1, 12) * DAY));
      else at = lessonAt(cal.indexOf(c.created_at + R.real(14, 60) * DAY)); // joined later in the year
      m.at = Math.max(c.created_at + 2 * MIN, Math.min(at, horizon));
    }
  }
  // People exist before they do anything: an account is created by its first sign-in.
  const firstMembership = (p) => Math.min(...p.classes.map((m) => (m.primary ? m.cls.created_at : m.at || Infinity)), Infinity);
  for (const p of teachers) {
    p.lastYear = p.lastYear || p.inactive || R.chance(0.75);
    let t = p.lastYear ? LAST_SY + R.real(-12, 25) * DAY : SY - R.real(1, 12) * DAY;
    t = Math.min(t, firstMembership(p) - R.int(60, 4000) * MIN);
    p.created_at = slotTime(cal.dayOf(t), 'office');
    p.signP = R.real(0.72, 0.98);
  }
  admin.created_at = slotTime(cal.dayOf(LAST_SY - 20 * DAY), 'office');
  admin.signP = 0.9;
  admin.lastYear = true;
  for (const p of students) {
    if (p.grade !== 5 && R.chance(0.55)) p.lastYear = true;
    if (p.inactive) p.lastYear = true;
    const archivedJoin = Math.min(...p.classes.filter((m) => m.cls.kind === 'archived').map((m) => m.at), Infinity);
    const firstJoin = firstMembership(p);
    let t;
    if (archivedJoin < Infinity) t = archivedJoin - R.int(1, 15) * MIN;
    else if (p.lastYear) t = slotTime(cal.dayOf(LAST_SY + R.real(3, 120) * DAY), 'lesson');
    else if (firstJoin < Infinity) t = firstJoin - R.int(1, 15) * MIN;
    else t = slotTime(cal.dayOf(Math.min(SY + R.real(0, 50) * DAY, NOW - 3 * DAY)), 'lesson');
    p.created_at = Math.min(t, firstJoin - MIN);
    p.signP = activeOf(p).length ? R.real(0.45, 0.93) : R.real(0.22, 0.65);
    p.act = R.logNormal(0.55);
  }
  // Not signed in for a long time (about 5 %): students who left after last year, a few teachers.
  for (const p of [...classless.slice(0, nInactive), ...inactiveTeachers]) {
    const lo = Math.max(p.created_at + 20 * DAY, NOW - 300 * DAY);
    p.lastLogin = slotTime(cal.dayOf(R.real(lo, Math.max(lo + DAY, NOW - 100 * DAY))), p.role === 'student' ? 'lesson' : 'office');
    p.end = p.lastLogin + MIN;
  }
  // The dev accounts (`dev-` oids are listed on the dev login page).
  const activeClassless = classless.slice(nInactive).filter((p) => !p.classes.length);
  const devNoClassStudent = activeClassless[0] || classless[nInactive];
  const devOneClass = homePool.find((p) => activeOf(p).length === 1 && !p.classes.some((m) => m.cls.kind === 'archived') && p.homeroom && p.homeroom.kind === 'homeroom' && p.homeroom !== bigRooms[0]);
  const devFour = busy[0] || homePool.find((p) => activeOf(p).length >= 3);
  // Blocked accounts: a few students (one of them a dev account) and one or two teachers.
  const blockable = homePool.filter((p) => p !== devOneClass && p !== devFour && !busy.includes(p));
  const blockedStudents = R.sample(blockable, Math.max(2, Math.round(S * 0.006)));
  for (const p of [...blockedStudents, ...blockedTeachers]) {
    p.blockedAt = slotTime(cal.dayOf(R.real(Math.max(NOW - 25 * DAY, p.created_at + 3 * DAY), NOW - 2 * DAY)), 'office');
    p.end = p.blockedAt;
  }
  const devBlocked = blockedStudents[0];
  for (const p of [devNoClassStudent, devOneClass, devFour, devBlocked, bigTeacher, coTeacher, devNoClassTeacher]) if (p) p.signP = Math.max(p.signP, 0.9);
  for (const p of [devNoClassStudent, devOneClass, devFour]) if (p) p.act = Math.max(p.act, 1.4);
  // Days each person signs in inside the window (about 70 % of school days, a few weekend days).
  for (const p of people) {
    const from = Math.max(cal.indexOf(Math.max(W, p.created_at)), WI);
    const to = Math.min(cal.indexOf(Math.min(NOW - 1, p.end)), NI);
    for (let i = from; i <= to; i++) if (R.chance(days[i].school ? p.signP : p.signP * 0.17)) p.activeDays.push(i);
  }

  // ------------------------------------------------------------ class events
  for (const c of [...active, ...archived]) {
    const primary = c.teachers.find((m) => m.primary).p;
    audit(c.created_at, primary, 'klasse_erstellt', c.name);
    const horizon = Math.min(NOW - 2 * HOUR, c.archived_at || Infinity);
    for (const m of c.teachers.filter((x) => !x.primary)) {
      const invited = timeFor(primary, c.created_at + 2 * HOUR, Math.min(c.created_at + 15 * DAY, horizon - DAY)) ?? c.created_at + 3 * HOUR;
      audit(invited, primary, 'lehrkraft_eingeladen', c.name, '1 Tag');
      m.at = invited + R.int(10, 1200) * MIN;
      if (m.p.created_at >= m.at) m.p.created_at = m.at - R.int(30, 600) * MIN;
      audit(m.at, m.p, 'klasse_beigetreten', c.name, 'als Lehrkraft');
      c.teacherCode = { by: primary, at: invited, minutes: 1440 }; // the last invitation stays until it is replaced
    }
    for (const m of c.students) audit(m.at, m.p, 'klasse_beigetreten', c.name, 'als Schüler/in');
    // Join codes: the teacher showed new QR codes now and then; the current one is from the last days.
    if (c.kind !== 'archived') {
      for (let k = R.int(0, 2); k > 0; k--) {
        const by = R.pick(c.teachers).p;
        const at = timeFor(by, c.created_at + DAY, Math.min(c.created_at + 30 * DAY, NOW - 4 * DAY));
        if (at) audit(at, by, 'beitrittscode_erzeugt', c.name, R.pick(['15 Minuten', '1 Stunde', '1 Tag']));
      }
      const by = R.pick(c.teachers).p;
      const at = timeFor(by, NOW - 3 * DAY, NOW - HOUR) ?? NOW - 5 * HOUR;
      audit(at, by, 'beitrittscode_erzeugt', c.name, '1 Woche');
      out.codes.push({ code: R.bytes(24).toString('base64url'), c, by, at, expires: at + 10080 * MIN, role: 'student' });
    } else {
      out.codes.push({ code: R.bytes(24).toString('base64url'), c, by: c.teachers[0].p, at: c.created_at, expires: c.created_at + 1440 * MIN, role: 'student' });
    }
  }
  const teachersAt = (c, t) => c.teachers.filter((m) => m.at <= t && m.p.end > t).map((m) => m.p);
  const studentsAt = (c, t) => c.students.filter((m) => m.at <= t).map((m) => m.p);

  // ------------------------------------------------------------ apps
  const apps = out.apps;
  const originKeys = new Set();
  const subjectOf = (p) => {
    const prim = p.classes.find((m) => m.role === 'teacher' && m.primary && m.cls.kind !== 'archived') || p.classes.find((m) => m.role === 'teacher');
    return prim ? prim.cls.subject : R.weighted(subjectPairs.map(([x, w]) => [x[0], w]));
  };
  function mkApp(owner, tpl, fromTemplate) {
    let key;
    do key = `a${R.hex(20)}`;
    while (originKeys.has(key));
    originKeys.add(key);
    const a = {
      idx: apps.length, id: R.id(), owner, tpl, origin_key: key, fromTemplate, created_at: 0, versions: [], pubs: [], published: null,
      swHistory: [], swFrom: null, swReq: null, shared: 0, sharedAt: null, updated_at: 0, category: '', grade_min: null, grade_max: null,
      details: R.chance(0.47), draft: null, uploading: null, name: '', description: '', emoji: TEMPLATE_INFO[tpl].emoji, color: TEMPLATE_INFO[tpl].color,
    };
    apps.push(a);
    owner.apps.push(a);
    return a;
  }
  const spread = (owners, total, fixed, dist) => {
    const counts = owners.map((p) => fixed.get(p) || R.weighted(dist));
    let sum = counts.reduce((x, y) => x + y, 0);
    for (let guard = 0; sum !== total && guard < 100000; guard++) {
      const i = R.int(0, owners.length - 1);
      if (fixed.has(owners[i])) continue;
      if (sum < total && counts[i] < 15) (counts[i]++, sum++);
      else if (sum > total && counts[i] > 1) (counts[i]--, sum--);
    }
    return counts;
  };
  // About 120 apps of 30 teachers, 250 apps of 150 students, a few of the admin.
  const nTeacherOwners = Math.max(3, Math.round(T * 0.3));
  const tOwners = [bigTeacher, devNoClassTeacher];
  for (const p of R.sample(withClass.filter((x) => x !== bigTeacher), Math.round(nTeacherOwners * 0.65) - 1)) tOwners.push(p);
  for (const p of R.sample(freeTeachers, nTeacherOwners - tOwners.length)) tOwners.push(p);
  const tCounts = spread(tOwners, Math.round(T * 1.2), new Map([[bigTeacher, 8], [devNoClassTeacher, 3]]), [[1, 18], [2, 22], [3, 20], [4, 14], [5, 10], [6, 7], [8, 5], [10, 4]]);
  const nStudentOwners = Math.max(5, Math.round(S * 0.15));
  const sEligible = students.filter((p) => !p.inactive && !p.blockedAt);
  const sOwners = [devNoClassStudent, devOneClass, devFour].filter(Boolean);
  for (const p of R.sample(activeClassless.filter((p) => !sOwners.includes(p)), Math.round(nStudentOwners * 0.12))) sOwners.push(p);
  for (const p of R.sample(sEligible.filter((p) => !sOwners.includes(p) && p.homeroom), nStudentOwners - sOwners.length)) sOwners.push(p);
  const sCounts = spread(sOwners, Math.round(S * 0.25), new Map([[devNoClassStudent, 2], [devOneClass, 1], [devFour, 2]]), [[1, 60], [2, 24], [3, 9], [4, 4], [5, 3]]);
  const T_TPL = [['vokabeltrainer', 25], ['quiz-werkstatt', 25], ['lernkarten', 20], ['kopfrechnen', 15], ['sternenfaenger', 7], ['pixel-studio', 8]];
  const S_TPL = [['pixel-studio', 28], ['sternenfaenger', 25], ['quiz-werkstatt', 18], ['kopfrechnen', 10], ['lernkarten', 10], ['vokabeltrainer', 9]];
  const plan = [];
  tOwners.forEach((p, i) => { for (let k = 0; k < tCounts[i]; k++) plan.push([p, R.weighted(T_TPL)]); });
  sOwners.forEach((p, i) => { for (let k = 0; k < sCounts[i]; k++) plan.push([p, R.weighted(S_TPL)]); });
  for (const tpl of ['quiz-werkstatt', 'lernkarten', 'sternenfaenger']) plan.push([admin, tpl]);

  for (const [owner, tpl] of plan) {
    const staff = owner.role !== 'student';
    const a = mkApp(owner, tpl, R.chance(staff ? 0.25 : 0.55));
    const m = TPL[tpl].manifest;
    // Catalogue data: what the author chose in the form, or (left empty) what the manifest fills in.
    const subj = staff ? (tpl === 'kopfrechnen' ? 'Mathematik' : tpl === 'vokabeltrainer' ? R.pick(['Englisch', 'Englisch', 'Englisch', 'Französisch', 'Latein', 'Spanisch']) : subjectOf(owner)) : null;
    if (staff && R.chance(0.55) && !['sternenfaenger', 'pixel-studio'].includes(tpl)) a.category = subj;
    else a.category = m.category || '';
    if (staff && R.chance(0.5)) {
      const g = R.int(5, 9);
      [a.grade_min, a.grade_max] = R.chance(0.5) ? [g, g] : [g, g + 1];
    } else if (m.grades) [a.grade_min, a.grade_max] = m.grades;
    const names = new Set(owner.apps.filter((x) => x !== a).map((x) => x.name.toLowerCase()));
    let base = staff ? TEACHER_APP_NAMES[tpl](R, subj || '') : STUDENT_APP_NAMES[tpl](R, owner.first);
    if (owner === admin) base = { 'quiz-werkstatt': 'Schulhaus-Rallye', lernkarten: 'Hausordnung kennen', sternenfaenger: 'Pausenspiel' }[tpl];
    let name = base;
    for (let k = 2; names.has(name.toLowerCase()); k++) name = `${base} ${k}`.slice(0, 60);
    a.name = name;
    a.description = staff ? (R.chance(0.8) ? TEMPLATE_DESCRIPTIONS[tpl] : '') : R.chance(0.5) ? R.pick(STUDENT_DESCRIPTIONS) : '';
    if (R.chance(0.3)) a.emoji = R.pick(EMOJIS);
    if (R.chance(0.4)) a.color = R.int(0, COLORS - 1);
    // When: teachers' apps partly from last year; pupils build theirs this year.
    let lo;
    let hi;
    if (owner === admin) [lo, hi] = [LAST_SY + 20 * DAY, ARCHIVED_AT - 60 * DAY];
    else if (staff && owner.lastYear && R.chance(0.5)) [lo, hi] = [LAST_SY + 14 * DAY, ARCHIVED_AT - 25 * DAY];
    else if (staff) [lo, hi] = [Math.max(SY - 12 * DAY, owner.created_at + HOUR), NOW - 2 * DAY];
    else if (owner.lastYear && R.chance(0.1)) [lo, hi] = [ARCH_FROM, ARCHIVED_AT - 20 * DAY];
    else [lo, hi] = [Math.max(SY + 2 * DAY, owner.created_at + HOUR), NOW - 8 * HOUR];
    a.created_at = timeFor(owner, lo, Math.max(hi, lo + HOUR)) ?? lo;
    audit(a.created_at, owner, a.fromTemplate ? 'app_aus_vorlage' : 'app_erstellt', a.name, '', { app: a });
    // Versions: 1-12, mostly few.
    const nv = R.weighted([[1, 24], [2, 20], [3, 15], [4, 11], [5, 8], [6, 6], [7, 5], [8, 4], [9, 3], [10, 2], [11, 1], [12, 1]]);
    const gap = staff ? 9 * DAY : 3 * DAY;
    let t = a.created_at;
    for (let k = 1; k <= nv; k++) {
      const nt = timeFor(owner, t + (k === 1 ? 3 * MIN : 15 * MIN), Math.min(NOW - HOUR, t + (k === 1 ? 2 * DAY : R.real(0.3, 2.2) * gap)));
      if (nt === null) break;
      t = nt;
      a.versions.push({ id: R.id(), number: k, created_at: t, status: 'ready', note: k > 1 && R.chance(0.3) ? R.pick(VERSION_NOTES) : '' });
      audit(t, owner, 'version_hochgeladen', a.name, `Version ${k}, ${TPL[tpl].fileCount} Dateien`, { app: a });
    }
    if (!a.versions.length) {
      a.versions.push({ id: R.id(), number: 1, created_at: a.created_at + 2 * MIN, status: 'ready', note: '' });
      audit(a.created_at + 2 * MIN, owner, 'version_hochgeladen', a.name, `Version 1, ${TPL[tpl].fileCount} Dateien`, { app: a });
    }
    // About 85 % are published; sometimes the newest version is not published yet.
    if (owner === admin || R.chance(0.85)) {
      let p = a.versions.length;
      if (p >= 2 && R.chance(0.15)) p--;
      for (const v of a.versions.slice(0, p)) {
        if (v.number !== p && !R.chance(0.8)) continue;
        const next = a.versions[v.number];
        const limit = Math.min(next ? next.created_at - MIN : NOW - 30 * MIN, v.created_at + 8 * HOUR);
        let at = Math.min(limit, v.created_at + R.int(1, 240) * MIN);
        if (at <= v.created_at) at = v.created_at + 20_000;
        a.pubs.push({ v, at, by: owner });
        audit(at, owner, 'veroeffentlicht', a.name, `Version ${v.number}`, { app: a });
      }
      a.published = a.pubs[a.pubs.length - 1].v;
    }
    // About 40 % of the teachers' apps are shared with colleagues.
    if (owner.role === 'teacher' && a.pubs.length && R.chance(0.47)) {
      a.shared = 1;
      a.sharedAt = timeFor(owner, a.pubs[0].at + 10 * MIN, Math.min(NOW - HOUR, a.pubs[0].at + R.real(1, 25) * DAY)) ?? a.pubs[0].at + 10 * MIN;
      audit(a.sharedAt, owner, 'app_geteilt', a.name, '', { app: a });
    }
  }
  const pubAt = (a, t) => {
    let v = null;
    for (const pb of a.pubs) {
      if (pb.at <= t) v = pb.v;
      else break;
    }
    return v;
  };
  const swAt = (a, t) => {
    let v = null;
    for (const h of a.swHistory) {
      if (h.at <= t) v = h.v;
      else break;
    }
    return v;
  };
  const lastVersion = (a) => a.versions[a.versions.length - 1];

  // School-wide: about 8 apps (two of them drawing apps); two have an update waiting for the admin.
  const nSw = Math.max(3, Math.round(C / 5));
  const early = (a) => a.pubs.length && a.pubs[0].at < NOW - 12 * DAY;
  const swPick = [];
  const addSw = (list, n) => {
    for (const a of list) {
      if (n <= 0 || swPick.length >= nSw) break;
      if (!swPick.includes(a)) {
        swPick.push(a);
        n--;
      }
    }
  };
  addSw(apps.filter((a) => a.owner === admin && early(a)), 1);
  addSw(R.shuffle(apps.filter((a) => a.owner.role === 'teacher' && a.tpl === 'pixel-studio' && early(a))), 1);
  addSw(R.shuffle(apps.filter((a) => a.owner.role === 'student' && a.tpl === 'pixel-studio' && early(a) && a.owner !== devNoClassStudent)), 1);
  addSw(R.shuffle(apps.filter((a) => a.owner.role === 'student' && a.tpl === 'sternenfaenger' && early(a))), 1);
  addSw(R.shuffle(apps.filter((a) => a.owner.role === 'teacher' && early(a) && !['pixel-studio', 'sternenfaenger'].includes(a.tpl))), nSw);
  const waitingSw = R.sample(swPick.filter((a) => a.owner !== admin && a.pubs.length >= 2), 2);
  for (const a of swPick) {
    const waiting = waitingSw.includes(a);
    const rIdx = waiting ? R.int(0, a.pubs.length - 2) : R.int(Math.max(0, a.pubs.length - 3), a.pubs.length - 1);
    const lo = a.pubs[rIdx].at + HOUR;
    const hi = rIdx + 1 < a.pubs.length ? a.pubs[rIdx + 1].at - HOUR : NOW - 2 * DAY;
    const r = timeFor(admin, lo, Math.max(hi, lo + HOUR)) ?? lo;
    a.swFrom = r;
    a.swHistory.push({ at: r, v: pubAt(a, r) }); // the admin releases the version that is published at that moment
    audit(r, admin, 'schulweit_freigegeben', a.name, '', { app: a });
    for (let k = 0; k < a.pubs.length; k++) {
      const pb = a.pubs[k];
      if (pb.at <= r) continue;
      if (a.owner === admin) {
        a.swHistory.push({ at: pb.at, v: pb.v }); // the admin's own publish updates the release at once
        continue;
      }
      a.swReq = pb.v; // waits for the admin
      const lastPub = k === a.pubs.length - 1;
      if (waiting && lastPub) break;
      const until = lastPub ? NOW - 10 * MIN : a.pubs[k + 1].at - MIN;
      let at = timeFor(admin, pb.at + 20 * MIN, Math.min(until, pb.at + 4 * DAY));
      if (at === null && lastPub) at = pb.at + (NOW - pb.at) / 2;
      if (at === null) continue; // the next version came first
      if (R.chance(0.9) || lastPub) {
        a.swHistory.push({ at, v: pb.v });
        audit(at, admin, 'schulweit_aktualisiert', a.name, `Version ${pb.v.number}`, { app: a });
        notify([a.owner], 'freigegeben', `Version ${pb.v.number} von „${a.name}“ ist jetzt für die ganze Schule freigegeben.`, `/apps/${a.id}`, at);
      } else {
        audit(at, admin, 'schulweit_update_abgelehnt', a.name, `Version ${pb.v.number}`, { app: a });
        notify([a.owner], 'zurueckgegeben', `Version ${pb.v.number} von „${a.name}“ wurde nicht schulweit freigegeben. Die Schule behält die bisherige Version.`, `/apps/${a.id}`, at);
      }
      a.swReq = null;
    }
  }
  const swApps = swPick.filter((a) => a.swHistory.length);

  // ------------------------------------------------------------ apps in classes (review history)
  const reviewDelay = () => (R.chance(0.8) ? R.real(0.5 * HOUR, 3 * DAY) : R.real(3 * DAY, 12 * DAY));
  function comment(app, author, kind, v, c, at, body = '') {
    out.comments.push({ id: R.id(), app, author, body, at, kind, v, c });
  }
  /**
   * One app in one class, as classApps.js would have written it over time: added by a teacher
   * ('approve') or submitted by its owner ('submit'), then every later publish of the owner
   * (onPublish) and every decision of a teacher of the class, until now (or the archive).
   */
  function runClassApp(c, app, mode, actor, t0, removeAt = null) {
    if (c.rowByApp.has(app)) return null;
    const horizon = Math.min(NOW - MIN, c.archived_at || Infinity, removeAt || Infinity);
    const row = { c, app, status: 'pending', version: null, requested: null, state: null, added_by: actor, decided_by: null, decided_at: null, created_at: t0, playFrom: null, playTo: null, deleted: false };
    const review = `/pruefen/${c.id}/${app.id}`;
    let decisionAt = null;
    if (mode === 'approve') {
      const own = app.owner === actor || (app.shared && app.sharedAt <= t0);
      const v = own ? pubAt(app, t0) : swAt(app, t0);
      if (!v) return null;
      Object.assign(row, { status: 'approved', version: v, decided_by: actor, decided_at: t0, playFrom: t0 });
      audit(t0, actor, 'app_zugewiesen', app.name, c.name, { app });
    } else {
      const v = pubAt(app, t0);
      if (!v) return null;
      Object.assign(row, { requested: v, state: 'waiting' });
      comment(app, actor, 'submitted', v, c, t0);
      audit(t0, actor, 'app_eingereicht', app.name, `${c.name}, Version ${v.number}`, { app });
      notify(teachersAt(c, t0), 'pruefen', `„${app.name}“ (Version ${v.number}) wartet auf deine Prüfung in ${c.name}.`, review, t0);
      decisionAt = t0 + reviewDelay();
    }
    let i = app.pubs.findIndex((pb) => pb.at > t0);
    if (i < 0) i = app.pubs.length;
    for (let guard = 0; guard < 200; guard++) {
      const next = i < app.pubs.length && app.pubs[i].at < horizon ? app.pubs[i] : null;
      if (decisionAt !== null && decisionAt < horizon && (!next || decisionAt < next.at)) {
        const at = decisionAt;
        decisionAt = null;
        const teacher = R.pick(teachersAt(c, at));
        if (!teacher) continue;
        const v = row.requested;
        if (R.chance(0.35)) {
          const said = at - R.int(5, 120) * MIN;
          comment(app, teacher, 'comment', v, c, said, R.pick(REVIEW_COMMENTS));
          if (app.owner !== teacher) notify([app.owner], 'kommentar', `${teacher.name} hat „${app.name}“ kommentiert.`, `/apps/${app.id}#verlauf`, said, teacher);
        }
        if (R.chance(0.74)) {
          Object.assign(row, { status: 'approved', version: v, requested: null, state: null, decided_by: teacher, decided_at: at });
          if (row.playFrom === null) row.playFrom = at;
          comment(app, teacher, 'approved', v, c, at, R.chance(0.3) ? R.pick(APPROVE_NOTES) : '');
          audit(at, teacher, 'app_freigegeben', app.name, `${c.name}, Version ${v.number}`, { app });
          if (app.owner !== teacher) notify([app.owner], 'freigegeben', `„${app.name}“ ist jetzt in ${c.name} freigegeben.`, `/apps/${app.id}`, at);
        } else {
          Object.assign(row, { state: 'returned', status: row.status === 'approved' ? 'approved' : 'rejected', decided_by: teacher, decided_at: at });
          comment(app, teacher, 'returned', v, c, at, R.pick(RETURN_REASONS));
          audit(at, teacher, 'app_zurueckgegeben', app.name, `${c.name}, Version ${v.number}`, { app });
          notify([app.owner], 'zurueckgegeben', `„${app.name}“ wurde in ${c.name} zurückgegeben. Schau dir an, was noch fehlt.`, `/apps/${app.id}`, at);
          if (R.chance(0.4)) {
            const reply = at + R.real(HOUR, 2 * DAY);
            if (reply < Math.min(horizon, next ? next.at : Infinity)) {
              comment(app, app.owner, 'comment', null, null, reply, R.pick(OWNER_REPLIES));
              touch(app.owner, reply);
              notify(teachersAt(c, reply), 'kommentar', `${app.owner.name} hat „${app.name}“ kommentiert.`, `/apps/${app.id}#verlauf`, reply, app.owner);
            }
          }
        }
        continue;
      }
      if (!next) break;
      i++;
      const publisher = next.by;
      const trusted = publisher.role === 'admin' || c.teachers.some((m) => m.p === publisher && m.at <= next.at);
      if (trusted) {
        Object.assign(row, { status: 'approved', version: next.v, requested: null, state: null, decided_by: publisher, decided_at: next.at });
        if (row.playFrom === null) row.playFrom = next.at;
        decisionAt = null;
      } else if (row.version !== next.v && !(row.state === 'waiting' && row.requested === next.v)) {
        Object.assign(row, { requested: next.v, state: 'waiting', status: row.status === 'approved' ? 'approved' : 'pending' });
        comment(app, publisher, 'submitted', next.v, c, next.at);
        notify(teachersAt(c, next.at), 'pruefen', `Neue Version ${next.v.number} von „${app.name}“ wartet auf deine Prüfung in ${c.name}.`, review, next.at);
        decisionAt = next.at + reviewDelay();
      }
    }
    if (removeAt && removeAt < Math.min(NOW, c.archived_at || Infinity) && removeAt > t0) {
      // Taken out of the class: results stay readable when it was ever approved.
      const by = R.pick(teachersAt(c, removeAt)) || actor;
      if (row.version) Object.assign(row, { status: 'removed', requested: null, state: null, decided_by: by, decided_at: removeAt, playTo: removeAt });
      else row.deleted = true;
      audit(removeAt, by, 'app_aus_klasse_entfernt', app.name, c.name, { app });
    } else if (mode === 'submit' && row.state && R.chance(0.04)) {
      // The owner takes the request back.
      const at = timeFor(app.owner, row.decided_at || t0, NOW - HOUR);
      if (at) {
        if (row.status === 'approved') Object.assign(row, { requested: null, state: null });
        else if (row.version) Object.assign(row, { status: 'removed', requested: null, state: null, playTo: at });
        else row.deleted = true;
        audit(at, app.owner, 'einreichung_zurueckgezogen', app.name, c.name, { app });
      }
    }
    if (row.playFrom !== null && row.playTo === null) row.playTo = Math.min(NOW, c.archived_at || NOW);
    c.rowByApp.set(app, row);
    c.rows.push(row);
    return row;
  }
  // Pupils submit their published apps to one of their classes (the teacher reviews them).
  for (const a of apps) {
    if (a.owner.role !== 'student' || !a.pubs.length) continue;
    const s = a.owner;
    const mine = activeOf(s).filter((m) => m.role === 'student');
    if (!mine.length || !R.chance(0.62)) continue;
    const targets = [R.pick(mine)];
    if (mine.length > 1 && R.chance(0.2)) targets.push(R.pick(mine.filter((m) => m !== targets[0])));
    for (const m of targets) {
      const lo = Math.max(a.pubs[0].at + 5 * MIN, m.at + 10 * MIN);
      const t0 = timeFor(s, lo, Math.min(NOW - 3 * HOUR, lo + R.real(1, 20) * DAY));
      if (t0 !== null) runClassApp(m.cls, a, 'submit', s, t0, R.chance(0.04) ? t0 + R.real(5, 40) * DAY : null);
    }
  }
  // Teachers add their own apps, colleagues' shared apps and school-wide apps (6-20 approved per class).
  const approvedCount = (c) => c.rows.filter((r) => r.status === 'approved' && !r.deleted).length;
  function teacherAdds(c, target, extra = false) {
    const horizon = Math.min(NOW - 2 * HOUR, c.archived_at || Infinity);
    const mine = c.teachers.map((m) => m.p);
    const ok = (a) => a.pubs.length && !c.rowByApp.has(a) && a.pubs[0].at < horizon - 2 * DAY;
    // Teachers set up a class mostly from what exists at the start; newer apps come in later.
    const byAvail = (list, availOf) => list.map((a) => [a, availOf(a) + R.real(0, 25) * DAY]).sort((x, y) => x[1] - y[1]).map((x) => x[0]);
    const own = byAvail(apps.filter((a) => mine.includes(a.owner) && ok(a)), (a) => a.pubs[0].at);
    const swl = byAvail(swApps.filter((a) => ok(a) && a.swFrom < horizon - DAY), (a) => a.swFrom);
    const shared = byAvail(apps.filter((a) => a.shared && !mine.includes(a.owner) && ok(a) && a.sharedAt < horizon - DAY), (a) => Math.max(a.sharedAt, a.pubs[0].at));
    const list = extra ? [...swl, ...shared] : [...own.slice(0, R.int(1, Math.max(1, Math.ceil(target / 2)))), ...swl.slice(0, R.int(1, 3)), ...shared];
    for (const a of list) {
      if (approvedCount(c) >= Math.min(target, 20)) break;
      const isOwn = mine.includes(a.owner);
      const adder = isOwn ? a.owner : R.pick(mine);
      const memb = c.teachers.find((m) => m.p === adder);
      // From when this teacher may add it: own app once published, a shared one once shared, a school-wide one once released.
      const avail = isOwn ? a.pubs[0].at : Math.min(a.shared ? Math.max(a.sharedAt, a.pubs[0].at) : Infinity, a.swHistory.length ? a.swFrom : Infinity);
      const lo = Math.max(avail, memb.at, c.created_at) + 10 * MIN;
      if (horizon - lo < HOUR) continue;
      const tt = R.early(lo, horizon, 2.5);
      const t0 = timeFor(adder, tt, Math.min(horizon, tt + 2 * DAY)) ?? tt;
      runClassApp(c, a, 'approve', adder, t0, R.chance(0.05) && horizon - t0 > 10 * DAY ? R.real(t0 + 7 * DAY, horizon) : null);
    }
  }
  const TARGET = { homeroom: [8, 18], course: [6, 14], club: [6, 10], big: [6, 9], archived: [5, 10] };
  for (const c of [...active, ...archived]) teacherAdds(c, R.int(...TARGET[c.kind]));
  for (const c of active) if (approvedCount(c) < 6) teacherAdds(c, 6, true);

  // ------------------------------------------------------------ per-class settings and class data
  function settingsInput(tpl, c) {
    const subj = c.subject;
    if (tpl === 'vokabeltrainer') {
      const words = WORDS_BY_SUBJECT[subj] || EN_WORDS;
      return { woerter: R.sample(words, R.int(12, Math.min(30, words.length))), richtung: R.weighted([['de-en', 60], ['en-de', 20], ['gemischt', 20]]), runde: R.pick([8, 10, 12, 15]) };
    }
    if (tpl === 'quiz-werkstatt') {
      const q = QUIZZES[subj] || QUIZZES[R.pick(Object.keys(QUIZZES))];
      return { titel: R.pick(q.titles), fragen: R.sample(q.fragen, R.int(5, q.fragen.length)), modus: R.chance(0.8) ? 'gemischt' : 'eingabe', mischen: R.chance(0.75) };
    }
    if (tpl === 'lernkarten') {
      const d = DECKS[subj] || DECKS[R.pick(Object.keys(DECKS))];
      return { titel: d.titel, karten: R.sample(d.karten, R.int(Math.min(10, d.karten.length), d.karten.length)), richtung: R.weighted([['vorne', 70], ['hinten', 15], ['beide', 15]]), runde: R.pick([8, 10, 12, 15]) };
    }
    if (tpl === 'kopfrechnen') {
      const g = c.grade || 6;
      return { bis: g <= 5 ? 100 : g <= 6 ? 200 : g <= 8 ? 500 : 1000, plus: true, minus: true, mal: R.chance(0.85), geteilt: R.chance(0.45), aufgaben: R.pick([10, 15, 20, 20, 25]) };
    }
    if (tpl === 'sternenfaenger') return { schwierigkeit: R.weighted([['leicht', 30], ['normal', 50], ['schwer', 20]]) };
    return {};
  }
  for (const c of [...active, ...archived]) {
    for (const row of c.rows) {
      if (row.deleted || row.playFrom === null) continue;
      const m = TPL[row.app.tpl].manifest;
      if (m.settings.length && R.chance(0.45)) {
        const by = R.pick(teachersAt(c, row.playFrom + HOUR));
        const at = by && timeFor(by, row.playFrom + 5 * MIN, Math.min(row.playTo, row.playFrom + 10 * DAY) - MIN);
        if (!at) continue;
        // Checked against the app's schulhub.json like the settings form does.
        const { values, errors } = validateSettings(m, settingsInput(row.app.tpl, c));
        if (Object.keys(errors).length) throw new Error(`settings for ${row.app.tpl} do not fit its schulhub.json: ${JSON.stringify(errors)}`);
        c.settingsOf.set(row.app, values);
        out.settings.push({ c, app: row.app, value: JSON.stringify(values), by, at });
        audit(at, by, 'app_einstellungen_geaendert', row.app.name, c.name, { app: row.app });
      } else if (row.app.tpl === 'vokabeltrainer' && row.app.owner.role === 'teacher' && c.kind !== 'archived' && R.chance(0.7)) {
        // Version 1 of the Vokabeltrainer kept the class's word list in hub.classData (it still reads it).
        const by = c.teachers.find((x) => x.p === row.app.owner)?.p || R.pick(teachersAt(c, row.playFrom + HOUR));
        const at = by && timeFor(by, row.playFrom + 5 * MIN, Math.min(row.playTo, row.playFrom + 14 * DAY) - MIN);
        if (!at) continue;
        const list = R.sample(WORDS_BY_SUBJECT[c.subject] || EN_WORDS, R.int(12, 30));
        c.classData.set(row.app, list);
        out.shared.push({ app: row.app, scope: c.id, key: 'woerter', value: JSON.stringify(list), at });
      }
    }
  }
  // A few app-wide entries (hub.shared) - only apps of staff can write them.
  for (const a of R.sample(apps.filter((x) => x.owner.role !== 'student' && x.pubs.length), Math.max(3, Math.round(S / 150)))) {
    const at = timeFor(a.owner, a.pubs[0].at + 10 * MIN, NOW - HOUR);
    if (!at) continue;
    const entries = [
      ['hinweis', `Neu: ${a.name} gibt es jetzt auch für die Klassen ${R.int(5, 7)} bis ${R.int(8, 10)}.`],
      ['wortliste-standard', R.sample(EN_WORDS, 16)],
      ['rekord-der-woche', { name: 'Anonym', punkte: R.int(40, 240), woche: R.int(36, 46) }],
    ];
    for (const [key, value] of R.sample(entries, R.int(1, 3))) out.shared.push({ app: a, scope: '', key, value: JSON.stringify(value), at });
  }

  // ------------------------------------------------------------ assignments
  for (const c of [...active, ...archived]) {
    const archivedClass = c.kind === 'archived';
    // About one a week: ~10 so far this school year; last year's classes had them all year (from ARCH_FROM on).
    const n = archivedClass ? R.int(15, 25) : R.int(8, 12);
    for (let k = 0; k < n; k++) {
      const horizon = Math.min(NOW - HOUR, c.archived_at || Infinity);
      const lo = Math.max(c.created_at + 2 * DAY, archivedClass ? ARCH_FROM : -Infinity);
      if (horizon - lo < DAY) break;
      const planned = !archivedClass && R.chance(0.15);
      const t = planned ? R.real(Math.max(lo, NOW - 7 * DAY), horizon) : R.early(horizon, lo, 1.6);
      const rows = c.rows.filter((r) => !r.deleted && r.playFrom !== null && r.playFrom <= t && r.playTo > t + HOUR);
      const by = R.pick(teachersAt(c, t));
      if (!rows.length || !by) continue;
      const created = timeFor(by, t, Math.min(horizon, t + DAY)) ?? t;
      const row = R.pick(rows);
      let starts = created;
      if (planned) starts = slotTime(days[nthSchoolDay(NOW + R.real(1, 14) * DAY, 0)], 'lesson');
      else if (R.chance(0.15)) starts = Math.min(created + R.real(HOUR, 5 * DAY), horizon);
      let due = null;
      if (R.chance(0.8)) {
        const dueDay = days[cal.indexOf(starts + R.real(2, 14) * DAY)];
        due = R.chance(0.7) ? schoolTime(dueDay.ymd, '23:59') : schoolTime(dueDay.ymd, '08:00');
        if (due <= starts) due = starts + 2 * DAY;
      }
      const title = R.chance(0.5) ? row.app.name : R.pick([`${row.app.name} üben`, 'Wiederholung für die Arbeit', `Übung bis ${due ? 'zum Termin' : 'nächste Woche'}`, 'Hausaufgabe im Hub', `${c.subject || 'Fach'}: Übungsrunde`]);
      const x = { id: R.id(), c, app: row.app, title: title.slice(0, 120), note: R.chance(0.6) ? R.pick(ASSIGNMENT_NOTES) : '', starts, due, by, created };
      c.assignments.push(x);
      out.assignments.push(x);
      audit(created, by, 'aufgabe_erstellt', x.title, c.name, { app: row.app });
      // Only an assignment that has started is announced; a planned one appears on its start day.
      if (starts <= created) notify(studentsAt(c, created), 'aufgabe', `Neue Aufgabe in ${c.name}: „${x.title}“${due ? ` (${formatDue(due, created).text})` : ''}`, `/aufgaben/${x.id}`, created);
      if (starts < NOW) {
        const until = Math.min(due ?? NOW, NOW - MIN, c.archived_at || Infinity);
        for (const m of c.students) {
          if (m.at > until || m.p.end < starts || !R.chance(0.6)) continue;
          const at = timeFor(m.p, Math.max(starts, m.at), until);
          if (at) out.done.push({ x, p: m.p, at });
        }
      }
    }
  }

  // ------------------------------------------------------------ announcements
  const nSchoolAnn = Math.max(2, Math.round(C / 8));
  for (let k = 0; k < nSchoolAnn; k++) {
    const [title, body] = SCHOOL_ANNOUNCEMENTS[k % SCHOOL_ANNOUNCEMENTS.length];
    const kind = k % 5;
    const created = timeFor(admin, kind === 3 ? NOW - 28 * DAY : Math.max(W, NOW - 70 * DAY), kind === 3 ? NOW - 20 * DAY : NOW - DAY) ?? NOW - 2 * DAY;
    const expires = kind === 0 || kind === 2 ? null : kind === 3 ? days[cal.indexOf(NOW - R.int(2, 18) * DAY)].start : days[cal.indexOf(NOW + R.int(3, 40) * DAY)].start;
    out.announcements.push({ id: R.id(), c: null, by: admin, title, body, created: Math.min(created, (expires || Infinity) - DAY), expires });
  }
  for (let k = 0; k < Math.round(C / 2); k++) {
    const c = R.pick(active);
    const [title, body] = R.pick(CLASS_ANNOUNCEMENTS);
    const by = R.pick(c.teachers).p;
    const r = R.next();
    const created = timeFor(by, Math.max(c.created_at + DAY, NOW - 40 * DAY), NOW - HOUR) ?? NOW - 3 * HOUR;
    // Expired ones only recently: the Hub deletes announcements 30 days after they expire.
    let expires = r < 0.3 ? null : r < 0.7 ? days[cal.indexOf(NOW + R.int(1, 30) * DAY)].start : days[cal.indexOf(NOW - R.int(1, 16) * DAY)].start;
    if (expires !== null && expires <= created) expires = days[cal.indexOf(created + 2 * DAY)].start;
    const an = { id: R.id(), c, by, title, body, created, expires };
    out.announcements.push(an);
    notify(c.teachers.concat(c.students).filter((m) => m.at <= created && m.p !== by).map((m) => m.p), 'ankuendigung', `Neue Ankündigung in ${c.name}: ${title}`, '/start', created);
  }
  for (const an of out.announcements) {
    audit(an.created, an.by, 'ankuendigung_erstellt', an.title, an.c ? an.c.name : 'Ganze Schule');
    if (an.expires !== null && an.expires < NOW) continue;
    const audience = an.c ? an.c.students.map((m) => m.p) : R.sample(students.filter((p) => !p.inactive), Math.round(S * 0.15));
    for (const p of R.sample(audience, Math.round(audience.length * R.real(0.1, 0.4)))) {
      const at = timeFor(p, an.created + 10 * MIN, NOW - MIN);
      if (at) out.dismissed.push({ an, p });
    }
  }
  // Teacher invitations: some still valid now, the others expired.
  for (const c of R.sample(active, Math.max(2, Math.round(C / 15)))) {
    const by = c.teachers.find((m) => m.primary).p;
    const at = timeFor(by, NOW - 2 * DAY, NOW - 2 * HOUR) ?? NOW - 5 * HOUR;
    audit(at, by, 'lehrkraft_eingeladen', c.name, '1 Woche');
    c.teacherCode = { by, at, minutes: 10080 };
  }
  for (const c of [...active, ...archived]) {
    if (c.teacherCode) out.codes.push({ code: R.bytes(24).toString('base64url'), c, by: c.teacherCode.by, at: c.teacherCode.at, expires: c.teacherCode.at + c.teacherCode.minutes * MIN, role: 'teacher' });
  }

  // ------------------------------------------------------------ playing (plays, results, saves, scores ...)
  const pairs = new Map();
  const pairOf = (p, a) => {
    const k = p.idx * 1_000_000 + a.idx;
    let x = pairs.get(k);
    if (!x) pairs.set(k, (x = { p, app: a, ctxs: [], sessions: [], w: 0, n: 0, teacher: p.role !== 'student', archived: [] }));
    return x;
  };
  const KIND_W = { homeroom: 3.5, course: 2.5, club: 2, big: 2.5 };
  /** The apps a pupil can open now, and how (class context as the SDK would record it). */
  function optionsFor(s) {
    const map = new Map();
    const add = (a, o) => {
      if (o.to - o.from < HOUR) return;
      if (!map.has(a)) map.set(a, []);
      map.get(a).push(o);
    };
    for (const m of activeOf(s)) {
      if (m.role !== 'student') continue;
      for (const row of m.cls.rows) {
        if (row.deleted || row.playFrom === null) continue;
        add(row.app, { cls: m.cls, from: Math.max(row.playFrom, m.at, W), to: Math.min(row.playTo, s.end, NOW) - MIN, w: KIND_W[m.cls.kind] });
      }
    }
    for (const a of swApps) if (!map.has(a)) add(a, { cls: null, from: Math.max(a.swFrom, s.created_at, W), to: Math.min(s.end, NOW) - MIN, w: 1.2 });
    for (const a of s.apps) if (a.pubs.length && !map.has(a)) add(a, { cls: null, from: Math.max(a.pubs[0].at, W), to: Math.min(s.end, NOW) - MIN, w: 2.2 });
    return map;
  }
  // About 200 pupils save drawings (1-10 PNGs each, at most 3 per drawing app as the app allows).
  const drawerTarget = Math.round(S * 0.2);
  let drawers = 0;
  for (const s of R.shuffle(students.filter((p) => !p.inactive))) {
    const options = optionsFor(s);
    if (!options.size) continue;
    const list = [...options.entries()];
    const pixel = list.filter(([a]) => a.tpl === 'pixel-studio');
    if (pixel.length && drawers < drawerTarget && R.chance(0.5)) {
      s.drawFiles = Math.min(R.int(1, 10), pixel.length * 3);
      drawers++;
    }
    const forced = s.drawFiles ? pixel.slice(0, Math.ceil(s.drawFiles / 3)) : [];
    const n = Math.min(list.length, Math.max(forced.length, s === devFour ? 14 : R.int(3, 13)));
    const chosen = forced.slice();
    const restList = list.filter((e) => !chosen.includes(e)).map((e) => [e, Math.max(...e[1].map((o) => o.w)) * TEMPLATE_INFO[e[0].tpl].w]);
    while (chosen.length < n && restList.length) {
      const e = R.weighted(restList);
      chosen.push(e);
      restList.splice(restList.findIndex((x) => x[0] === e), 1);
    }
    for (const [a, os] of chosen) {
      const pr = pairOf(s, a);
      pr.ctxs = os;
      pr.w = s.act * R.logNormal(0.7) * TEMPLATE_INFO[a.tpl].w;
    }
  }
  // Assignments: most pupils open the assigned app in the class while it runs (3-15 apps per pupil in all).
  const appsOfPupil = new Map();
  for (const pr of pairs.values()) appsOfPupil.set(pr.p, (appsOfPupil.get(pr.p) || 0) + 1);
  for (const c of active) {
    for (const x of c.assignments) {
      if (x.starts > NOW - HOUR) continue;
      const until = Math.min(x.due ?? x.starts + 10 * DAY, NOW - MIN);
      const row = c.rowByApp.get(x.app);
      for (const m of c.students) {
        const s = m.p;
        if (s.inactive || m.at > until || !R.chance(0.62)) continue;
        if (!pairs.has(s.idx * 1_000_000 + x.app.idx)) {
          if ((appsOfPupil.get(s) || 0) >= 15) continue;
          appsOfPupil.set(s, (appsOfPupil.get(s) || 0) + 1);
        }
        const pr = pairOf(s, x.app);
        if (!pr.ctxs.length) {
          pr.ctxs = [{ cls: c, from: Math.max(row.playFrom, m.at, W), to: Math.min(row.playTo, s.end, NOW) - MIN, w: 1 }];
          pr.w = s.act * 0.25 * TEMPLATE_INFO[x.app.tpl].w;
        }
        for (let k = R.int(1, 2); k > 0; k--) {
          const lim = Math.min(until, row.playTo - MIN, s.end - MIN);
          const ts = timeFor(s, Math.max(x.starts, m.at) + MIN, lim);
          if (ts !== null) pr.sessions.push({ ts, c, lim });
        }
      }
    }
  }
  // Teachers open the apps of their classes and their own apps; the admin the school-wide ones.
  for (const t of [...teachers, admin]) {
    if (t.inactive) continue;
    for (const m of activeOf(t)) {
      for (const row of m.cls.rows) {
        if (row.deleted || row.playFrom === null || !R.chance(0.3)) continue;
        const o = { cls: m.cls, from: Math.max(row.playFrom, m.at, W), to: Math.min(row.playTo, t.end, NOW) - MIN, w: 1 };
        if (o.to - o.from < HOUR) continue;
        const pr = pairOf(t, row.app);
        pr.ctxs.push(o);
        pr.n += R.int(1, 4);
      }
    }
    for (const a of t.role === 'admin' ? R.sample(swApps, 3) : t.apps) {
      if (!a.pubs.length) continue;
      const pr = pairOf(t, a);
      if (!pr.ctxs.length) pr.ctxs.push({ cls: null, from: Math.max(t.role === 'admin' ? a.swFrom : a.pubs[0].at, W), to: Math.min(t.end, NOW) - MIN, w: 1 });
      pr.n += R.int(2, 8);
    }
  }
  // Scale the number of openings so that the results come to about 215 per pupil this year. Openings
  // are a rate: an app that came into a class late in the term is opened on fewer days, not more often.
  const rpsOf = (pr) => TEMPLATE_INFO[pr.app.tpl].rps * (pr.teacher ? 0.3 : 1);
  /** Days person p signs in on between from and to (school days for times outside the window). */
  const activeDaysIn = (p, from, to) => {
    const a = cal.indexOf(from);
    const b = cal.indexOf(to);
    const n = lowerBound(p.activeDays, b + 1) - lowerBound(p.activeDays, a);
    return n || Math.max(0.5, ((to - from) / DAY) * 0.6);
  };
  // A pupil has about the same time for the Hub every day, shared among the apps available that day:
  // a few openings on each day they sign in, spread over their apps. Teachers open apps a few times.
  {
    const target = S * 215;
    let fixed = 0;
    const byPupil = new Map();
    for (const pr of pairs.values()) {
      pr.valid = pr.ctxs.filter((o) => o.to - o.from >= HOUR);
      fixed += (pr.sessions.length + pr.n) * rpsOf(pr);
      if (pr.teacher || !pr.valid.length) continue;
      if (!byPupil.has(pr.p)) byPupil.set(pr.p, []);
      byPupil.get(pr.p).push(pr);
    }
    const onDay = (o, d) => o.from < days[d].start + DAY && o.to > days[d].start;
    const availableOn = (prs, d) => prs.filter((pr) => pr.valid.some((o) => onDay(o, d)));
    let unit = 0; // expected results per unit of the daily rate
    for (const [s, prs] of byPupil) {
      for (const d of s.activeDays) {
        const av = availableOn(prs, d);
        if (!av.length) continue;
        unit += (s.act * av.reduce((x, pr) => x + pr.w * rpsOf(pr), 0)) / av.reduce((x, pr) => x + pr.w, 0);
      }
    }
    const rate = Math.max(0.05, (target - fixed) / Math.max(unit, 1));
    const poisson = (m) => {
      const l = Math.exp(-m);
      let k = 0;
      for (let p = R.next(); p > l; p *= R.next()) k++;
      return k;
    };
    const sessionOn = (s, pr, d) => {
      const os = pr.valid.filter((o) => onDay(o, d));
      const o = R.weighted(os.map((x, j) => [x, x.w * (j === 0 ? 4 : 1)]));
      const from = Math.max(o.from, days[d].start, s.created_at + MIN);
      const to = Math.min(o.to, days[d].start + DAY - MIN, s.end - MIN, NOW - MIN);
      if (!(to > from)) return;
      let ts = null;
      for (let k = 0; k < 4 && ts === null; k++) {
        const t = slotTime(days[d], slotFor(days[d], 'student'));
        if (t >= from && t <= to) ts = t;
      }
      if (ts === null) ts = Math.floor(from + R.next() * (to - from));
      touch(s, ts);
      pr.sessions.push({ ts, c: o.cls, lim: o.to });
    };
    for (const [s, prs] of byPupil) {
      for (const d of s.activeDays) {
        const av = availableOn(prs, d).filter((pr) => pr.sessions.length * rpsOf(pr) < 470);
        if (!av.length) continue;
        const weights = av.map((x) => [x, x.w]);
        for (let k = poisson(rate * s.act); k > 0; k--) sessionOn(s, R.weighted(weights), d);
      }
      // Every app a pupil chose was opened at least once.
      for (const pr of prs) {
        if (pr.sessions.length) continue;
        const dd = s.activeDays.filter((d) => pr.valid.some((o) => onDay(o, d)));
        if (dd.length) sessionOn(s, pr, R.pick(dd));
        else {
          const o = pr.valid[0];
          const ts = timeFor(s, o.from, o.to);
          if (ts !== null) pr.sessions.push({ ts, c: o.cls, lim: o.to });
        }
      }
    }
    for (const pr of pairs.values()) {
      if (!pr.teacher || !pr.valid.length) continue;
      const weights = pr.valid.map((o, i) => [o, o.w * activeDaysIn(pr.p, o.from, o.to) * (i === 0 ? 4 : 1)]);
      for (let k = 0; k < pr.n; k++) {
        const o = R.weighted(weights);
        const ts = timeFor(pr.p, o.from, o.to);
        if (ts !== null) pr.sessions.push({ ts, c: o.cls, lim: o.to });
      }
    }
  }
  // ... and about 35 per pupil in last year's (archived) classes.
  {
    const list = [];
    for (const c of archived) {
      const rows = c.rows.filter((r) => !r.deleted && r.playFrom !== null);
      if (!rows.length) continue;
      for (const m of c.students) {
        for (const row of R.sample(rows, R.int(Math.min(2, rows.length), Math.min(6, rows.length)))) {
          const from = Math.max(row.playFrom, m.at, ARCH_FROM);
          const to = Math.min(row.playTo, m.p.end, c.archived_at) - MIN;
          if (to - from < DAY) continue;
          list.push({ pr: pairOf(m.p, row.app), c, from, to, w: m.p.act * R.logNormal(0.7) * TEMPLATE_INFO[row.app.tpl].w * ((to - from) / DAY) });
        }
      }
    }
    const weight = list.reduce((s, x) => s + x.w * TEMPLATE_INFO[x.pr.app.tpl].rps, 0);
    const K = (S * 35) / Math.max(weight, 1);
    for (const x of list) {
      const rps = TEMPLATE_INFO[x.pr.app.tpl].rps;
      const n = Math.min(Math.max(1, Math.round(x.w * K * R.real(0.75, 1.25))), rps > 0 ? Math.floor(200 / rps) : 60);
      for (let k = 0; k < n; k++) {
        const ts = timeFor(x.pr.p, x.from, x.to);
        if (ts !== null) x.pr.sessions.push({ ts, c: x.c, lim: x.to });
      }
    }
  }

  // Settings an app sees in a context: the class's settings, else (Vokabeltrainer) the old class list, else the defaults.
  const settingsCache = new Map();
  function ctxSettings(a, c) {
    const key = `${a.idx}:${c ? c.idx : '-'}`;
    if (!settingsCache.has(key)) {
      const defaults = TPL[a.tpl].defaults;
      let s = defaults;
      if (c && c.settingsOf.has(a)) s = c.settingsOf.get(a);
      else if (c && c.classData.has(a)) s = { ...defaults, woerter: c.classData.get(a) };
      settingsCache.set(key, s);
    }
    return settingsCache.get(key);
  }

  const tageOf = (ts) => days[cal.indexOf(ts)].dayNo;

  /** The rows one person's use of one app leaves behind, the way the template app writes them. */
  function simulate(pr) {
    const { p, app: a } = pr;
    const tpl = a.tpl;
    const results = [];
    const st = { skill: R.real(0.35, 0.8), rounds: 0, total: 0, best: 0, bestScore: 0, bestMax: 0, perfect: null, first: null, last: null, levels: {}, modeBest: {}, bestLevel: 1, streak: 0, maxStreak: 0, late: null, days: new Set(), quizFp: null, lastSet: null, top: 0 };
    const nResults = (ss) => {
      if (pr.teacher) return R.chance(0.3) ? 1 : 0;
      if (tpl === 'vokabeltrainer') return 1 + (R.chance(0.4) ? 1 : 0) + (R.chance(0.15) ? 1 : 0);
      if (tpl === 'sternenfaenger') return R.int(1, 4);
      if (tpl === 'quiz-werkstatt') return 1 + (R.chance(0.25) ? 1 : 0);
      if (tpl === 'kopfrechnen') return R.int(1, 3);
      if (tpl === 'lernkarten') return 1 + (R.chance(0.2) ? 1 : 0);
      return ss ? 0 : 0;
    };
    for (const ss of pr.sessions) {
      const set = ctxSettings(a, ss.c);
      st.lastSet = set;
      const k = nResults(ss);
      let t = ss.ts;
      for (let r = 0; r < k; r++) {
        t += R.int(2, 9) * MIN + R.int(0, 59) * 1000;
        if (t >= NOW || (ss.lim && t > ss.lim)) break; // not after the class was archived, the app removed, the account blocked
        const res = ROUND[tpl](st, set, t);
        if (!res) continue;
        st.rounds++;
        if (st.first === null) st.first = t;
        st.last = t;
        st.days.add(tageOf(t));
        if (days[cal.indexOf(t)].start + 20 * HOUR <= t) st.late = st.late || t;
        st.skill = Math.min(0.97, st.skill + R.real(0, 0.02));
        const cid = ss.c ? ss.c.id : null;
        results.push({ a, p, c: t < UPGRADE ? '' : cid, at: t, title: res.title, score: res.score, max: res.max, seed: a.details ? (R.u32() >>> 1) + 1 : 0, set, x: res.x || null, tpl });
      }
      if (st.first === null) st.first = ss.ts;
      st.last = Math.max(st.last || 0, ss.ts);
    }
    // At most 500 results per person and app: the SDK drops the oldest.
    for (const r of results.slice(-500)) out.results.push(r);
    finish(pr, st);
  }

  /** One round of each template app: title, score and what the details are made from. */
  const ROUND = {
    vokabeltrainer(st, set) {
      const words = set.woerter && set.woerter.length ? set.woerter : TPL.vokabeltrainer.defaults.woerter;
      const m = Math.min(set.runde || 10, words.length);
      const score = R.binomial(m, st.skill);
      st.total += score;
      st.streak = score === m ? st.streak + m : R.int(0, m - score);
      st.maxStreak = Math.max(st.maxStreak, st.streak);
      if (score === m && m >= 5) st.perfect = st.perfect || true;
      st.bestScore = Math.max(st.bestScore, score);
      return { title: 'Übungsrunde', score, max: m };
    },
    sternenfaenger(st, set) {
      const mode = set.schwierigkeit || 'normal';
      const level = Math.min(10, Math.max(1, Math.round(1 + st.skill * 9 * R.real(0.35, 1.15))));
      const score = level * R.int(6, 12) + R.int(0, 5);
      st.modeBest[mode] = Math.max(st.modeBest[mode] || 0, score);
      st.bestLevel = Math.max(st.bestLevel, level);
      st.top = Math.max(st.top, score);
      return { title: `Spielrunde (${STAR_MODES[mode]})`, score, max: null, x: [level, R.int(0, mode === 'leicht' ? 4 : 2), 20 + level * R.int(10, 25), mode] };
    },
    'quiz-werkstatt'(st, set) {
      const lines = set.fragen && set.fragen.length ? set.fragen : TPL['quiz-werkstatt'].defaults.fragen;
      const max = lines.length;
      const score = R.binomial(max, st.skill);
      if (!st.bestMax || score > st.bestScore) {
        st.bestScore = score;
        st.bestMax = max;
        st.quizFp = fingerprint(`${set.titel}\n${lines.join('\n')}`);
      }
      if (score === max) st.perfect = st.perfect || true;
      return { title: `Quiz: ${set.titel}`.slice(0, 120), score, max };
    },
    kopfrechnen(st, set) {
      const n = set.aufgaben || 20;
      let unlocked = 1;
      while (unlocked < 3 && st.levels[unlocked] && st.levels[unlocked].passed) unlocked++;
      const level = R.chance(0.8) ? unlocked : R.int(1, unlocked);
      const score = R.binomial(n, Math.min(0.99, st.skill + 0.1));
      const mistakes = n - score;
      const seconds = Math.round((n * R.real(1.6, 4.2) * (1 + 0.12 * level) + mistakes * 3) * 10) / 10;
      const passed = mistakes <= 2;
      const old = st.levels[level];
      if (passed) st.levels[level] = { best: old && old.best && old.best < seconds ? old.best : seconds, passed: true };
      if (!mistakes) st.perfect = st.perfect || true;
      st.fast = st.fast || (passed && n >= 20 && seconds < 60);
      st.current = passed && level < 3 ? level + 1 : level;
      return { title: `Sprint Stufe ${level} · ${timeText(seconds)}`, score, max: n, x: [level, seconds] };
    },
    lernkarten(st, set) {
      const cards = set.karten && set.karten.length ? set.karten : TPL.lernkarten.defaults.karten;
      const m = Math.min(set.runde || 12, cards.length);
      const score = R.binomial(m, st.skill);
      st.total += score;
      return { title: `Lernrunde: ${set.titel}`.slice(0, 120), score, max: m };
    },
    'pixel-studio'() {
      return null;
    },
  };

  /** Saves, best scores, progress, achievements (and drawings) after all of a person's rounds. */
  function finish(pr, st) {
    const { p, app: a } = pr;
    const tpl = a.tpl;
    const set = st.lastSet || TPL[tpl].defaults;
    const at = st.last;
    const save = (key, value, when = at) => out.saves.push({ a, p, key, value: JSON.stringify(value), at: when });
    const best = (board, score, when = at) => out.scores.push({ a, p, board, score, at: when });
    const progress = (value, label) => out.progress.push({ a, p, value: Math.min(1, Math.max(0, value)), label: label.slice(0, 60), at });
    const ach = (id, when) => {
      if (TPL[tpl].manifest.achievements.some((x) => x.id === id)) out.achievements.push({ a, p, id, at: Math.min(when, NOW - MIN) });
    };
    const firstAt = st.first;
    const between = () => firstAt + Math.floor(R.next() * Math.max(1, at - firstAt));
    if (pr.teacher && !st.rounds && tpl !== 'pixel-studio') return; // opened, nothing saved
    if (tpl === 'vokabeltrainer') {
      if (!st.rounds) return;
      const words = set.woerter && set.woerter.length ? set.woerter : TPL.vokabeltrainer.defaults.woerter;
      const seen = R.sample(words, Math.min(words.length, st.rounds * Math.min(set.runde || 10, words.length)));
      const known = {};
      for (const [de, en] of seen) known[`${de}|${en}`] = R.binomial(3, st.skill);
      const learned = Object.values(known).filter((n) => n >= 2).length;
      save('gekonnt', known);
      save('serie', st.streak);
      save('richtig-gesamt', st.total);
      best('richtig', st.total);
      progress(learned / words.length, `${learned} von ${words.length} Wörtern gelernt`);
      ach('erste-runde', firstAt);
      if (st.perfect) ach('fehlerfrei', between());
      if (st.maxStreak >= 10) ach('zehn-in-folge', between());
      if (learned === words.length) ach('alles-gelernt', at);
    } else if (tpl === 'sternenfaenger') {
      if (!st.rounds) return;
      save('rekorde', st.modeBest);
      save('bestes-level', st.bestLevel);
      for (const [mode, score] of Object.entries(st.modeBest)) best(mode === 'normal' ? 'punkte' : `punkte-${mode}`, score);
      progress(st.bestLevel / 10, `Level ${st.bestLevel} von 10 erreicht`);
      ach('erster-stern', firstAt);
      if (st.bestLevel >= 5) ach('level-5', between());
      if (st.top >= 100) ach('hundert', between());
      if (st.bestLevel >= 10) ach('level-10', at);
      if (R.chance(0.08)) ach('unberuehrt', between());
    } else if (tpl === 'quiz-werkstatt') {
      if (!st.rounds) return;
      save('bestes', { quiz: st.quizFp, score: st.bestScore, max: st.bestMax });
      save('runden', st.rounds);
      progress(st.bestMax ? st.bestScore / st.bestMax : 0, `Bestes Ergebnis: ${st.bestScore} von ${st.bestMax}`);
      ach('erstes-quiz', firstAt);
      if (st.perfect) ach('volle-punktzahl', between());
      if (st.rounds >= 5) ach('dranbleiben', between());
      if (st.perfect && R.chance(0.1)) ach('blitzmerker', between());
    } else if (tpl === 'kopfrechnen') {
      if (!st.rounds) return;
      const done = Object.values(st.levels).filter((l) => l.passed).length;
      save('stufen', st.levels);
      save('stufe', st.current || 1);
      for (const [lvl, l] of Object.entries(st.levels)) best(`stufe-${lvl}`, l.best);
      progress(done / 5, `Stufe ${done} von 5 geschafft`);
      ach('erster-sprint', firstAt);
      if (st.perfect) ach('fehlerfrei', between());
      if (st.levels[3] && st.levels[3].passed) ach('halbzeit', between());
      if (st.fast) ach('blitzrechner', between());
    } else if (tpl === 'lernkarten') {
      if (!st.rounds) return;
      const cards = set.karten && set.karten.length ? set.karten : TPL.lernkarten.defaults.karten;
      const seen = R.sample(cards, Math.min(cards.length, st.rounds * Math.min(set.runde || 12, cards.length)));
      const today = tageOf(at);
      const kartei = {};
      let done = 0;
      for (const card of seen) {
        const box = Math.min(5, 1 + R.binomial(Math.min(4, st.rounds), st.skill));
        if (box === 5) done++;
        kartei[cardId(card)] = [box, today + [0, 1, 2, 4, 8, 16][box]];
      }
      save('kartei', kartei);
      save('tage', [...st.days].sort((x, y) => x - y).slice(-30));
      progress(cards.length ? done / cards.length : 0, `${done} von ${cards.length} Karten im letzten Fach`);
      ach('erste-runde', firstAt);
      if (done > 0) ach('im-ziel', between());
      if (st.days.size >= 3) ach('drei-tage', between());
      if (done === cards.length) ach('gemeistert', at);
      if (st.late) ach('nachteule', st.late);
    } else if (tpl === 'pixel-studio') {
      if (pr.teacher) return;
      const n = Math.min(3, 1 + Math.floor(pr.sessions.length / 3));
      const pictures = [];
      for (let k = 1; k <= n; k++) {
        const px = drawing(R.u32());
        pictures.push(px);
        save(`bild-${k}`, px, pr.sessions[Math.min(pr.sessions.length - 1, (k - 1) * 3)].ts + R.int(2, 30) * MIN);
      }
      const files = Math.min(n, p.drawFiles || 0);
      p.drawFiles -= files;
      for (let k = 1; k <= files; k++) out.files.push({ a, p, name: `bild-${k}`, pixels: pictures[k - 1], at: Math.min(at + R.int(3, 40) * MIN, NOW - MIN) });
      if (files) progress(files / 3, `${files} von 3 Bildern in der Galerie`);
      if (files) ach('erstes-bild', at);
      if (R.chance(0.5)) ach('ausgemalt', between());
      if (R.chance(0.1)) ach('farbenfroh', between());
      if (files >= 3) ach('volle-galerie', at);
    }
    // A few pupil-made apps keep a long history of their own (a few up to 50 KB).
    if (a.owner.role === 'student' && st.rounds > 20 && R.chance(0.06)) {
      const target = R.int(5_000, 50_000);
      const hist = [];
      let size = 2;
      while (size < target) {
        const e = { t: firstAt + Math.floor(R.next() * (at - firstAt)), s: R.int(0, 20), n: R.pick(['Runde', 'Level', 'Bonus', 'Training']) };
        size += JSON.stringify(e).length + 1;
        hist.push(e);
      }
      save('verlauf', hist.sort((x, y) => x.t - y.t));
    }
  }

  // Every opening: plays (personal), app_usage (anonymous, per day); then the data the rounds left.
  const pairsOf = new Map();
  for (const pr of pairs.values()) {
    if (!pr.sessions.length) continue;
    pr.sessions.sort((x, y) => x.ts - y.ts);
    const { p, app: a } = pr;
    out.plays.push({ a, p, first: pr.sessions[0].ts, last: pr.sessions[pr.sessions.length - 1].ts, count: pr.sessions.length });
    for (const ss of pr.sessions) {
      if (ss.ts < USAGE_FLOOR) continue;
      const k = `${days[cal.indexOf(ss.ts)].ymd}|${a.idx}`;
      out.usage.set(k, (out.usage.get(k) || 0) + 1);
    }
    simulate(pr);
    if (!pairsOf.has(p)) pairsOf.set(p, []);
    pairsOf.get(p).push(pr);
  }

  // ------------------------------------------------------------ favourites
  for (const s of students) {
    if (s.inactive || !R.chance(0.3)) continue;
    const mine = pairsOf.get(s) || [];
    const playable = mine.filter((pr) => {
      const a = pr.app;
      if (a.owner === s && a.pubs.length) return true;
      if (a.swHistory.length) return true;
      return activeOf(s).some((m) => m.role === 'student' && m.cls.rowByApp.get(a)?.status === 'approved' && !m.cls.rowByApp.get(a).deleted);
    });
    for (const pr of R.sample(playable, R.int(1, 5))) {
      const at = Math.min(pr.sessions[0].ts + R.real(MIN, 5 * DAY), NOW - MIN);
      out.favorites.push({ p: s, a: pr.app, at });
      touch(s, at);
    }
  }

  // ------------------------------------------------------------ feedback (teacher -> one pupil)
  const fbClasses = active.filter((c) => c.students.length).map((c) => [c, c.students.length]);
  for (let k = 0, n = S * 5; k < n; k++) {
    const arch = archived.length && R.chance(0.05);
    const c = arch ? R.pick(archived) : R.weighted(fbClasses);
    if (!c.students.length) continue;
    const m = R.pick(c.students);
    const s = m.p;
    const horizon = Math.min(NOW - 30 * MIN, c.archived_at || Infinity);
    const lo = Math.max(m.at, c.created_at, arch ? ARCH_FROM : W) + HOUR;
    if (lo >= horizon) continue;
    const t0 = R.real(lo, horizon);
    const teacher = R.pick(teachersAt(c, t0));
    if (!teacher) continue;
    const at = timeFor(teacher, t0, Math.min(horizon, t0 + 2 * DAY));
    if (at === null) continue;
    const started = c.assignments.filter((x) => x.starts <= at);
    const rows = c.rows.filter((r) => !r.deleted && r.playFrom !== null && r.playFrom <= at);
    let x = null;
    let app = null;
    const r = R.next();
    if (r < 0.45 && started.length) {
      x = R.pick(started);
      app = x.app;
    } else if (r < 0.82 && rows.length) app = R.pick(rows).app;
    const body = R.pick(FEEDBACK_TEXTS).replace('{first}', s.first).replace('{app}', app ? app.name : 'der App');
    const readAt = R.chance(0.76) ? at + R.real(10 * MIN, 3 * DAY) : null;
    out.feedback.push({ id: R.id(), c, s, by: teacher, app, x, body, at, read: readAt !== null && readAt < Math.min(NOW, s.end) ? readAt : null });
    notify([s], 'rueckmeldung', `Neue Rückmeldung von ${teacher.name}${x ? ` zu „${x.title}“` : app ? ` zu „${app.name}“` : ''} (${c.name})`, '/rueckmeldungen', at, teacher);
  }
  // Colleagues comment on shared apps they use.
  for (const c of active) {
    for (const row of c.rows) {
      if (row.deleted || row.playFrom === null || row.app.owner.role !== 'teacher' || c.teachers.some((m) => m.p === row.app.owner) || !R.chance(0.12)) continue;
      const by = R.pick(c.teachers).p;
      const at = timeFor(by, row.playFrom + HOUR, row.playTo);
      if (!at) continue;
      comment(row.app, by, 'comment', null, null, at, R.pick(COLLEAGUE_COMMENTS));
      notify([row.app.owner], 'kommentar', `${by.name} hat „${row.app.name}“ kommentiert.`, `/apps/${row.app.id}#verlauf`, at, by);
    }
  }

  // ------------------------------------------------------------ drafts and stale uploads
  for (const a of apps) {
    const o = a.owner;
    if (o.inactive || o.blockedAt) continue;
    const lv = lastVersion(a);
    if (R.chance(0.15)) {
      const created = timeFor(o, lv.created_at + 30 * MIN, NOW - HOUR);
      if (created) a.draft = { created, updated: Math.min(created + R.real(0, 3 * DAY), NOW - 10 * MIN), edit: R.chance(0.5), note: R.chance(0.2) };
    }
  }
  for (const a of R.sample(apps.filter((x) => !x.owner.inactive && !x.owner.blockedAt && x.versions.length < 20), Math.max(2, Math.round(S / 200)))) {
    const at = timeFor(a.owner, Math.max(lastVersion(a).created_at + HOUR, NOW - 20 * DAY), NOW - 2 * HOUR);
    if (at) a.uploading = { id: R.id(), number: lastVersion(a).number + 1, created_at: at, files: TPL[a.tpl].files.slice(0, R.int(1, 3)) };
  }
  for (let k = 0; k < Math.max(5, Math.round(S / 70)); k++) {
    const a = R.pick(apps.filter((x) => !x.owner.inactive && !x.owner.blockedAt));
    const at = timeFor(a.owner, Math.max(a.created_at, W), NOW - HOUR);
    if (at) audit(at, a.owner, 'upload_abgelehnt', a.name, R.pick(UPLOAD_REFUSALS), { app: a });
  }

  // ------------------------------------------------------------ the admin and the school
  for (const p of [...blockedStudents, ...blockedTeachers]) audit(p.blockedAt, admin, 'konto_gesperrt', p.name, '', { subject: p });
  for (let k = 0; k < 3; k++) {
    const at = timeFor(admin, Math.max(W, NOW - 80 * DAY), NOW - HOUR);
    if (at) audit(at, admin, 'datenbank_geprueft', '', 'in Ordnung');
  }
  for (const c of archived) audit(c.archived_at, c.teachers.find((m) => m.primary).p, 'klasse_archiviert', c.name);
  for (const c of R.sample(active, Math.round(C * 0.75))) {
    const row = R.pick(c.rows.filter((r) => !r.deleted && r.playFrom !== null));
    const by = R.pick(c.teachers).p;
    const at = row && timeFor(by, row.playFrom + DAY, row.playTo);
    if (at) audit(at, by, 'ergebnisse_exportiert', row.app.name, c.name, { app: row.app });
  }
  for (const c of R.sample(active.filter((x) => x.kind !== 'homeroom'), Math.min(4, active.length))) {
    const by = R.pick(c.teachers).p;
    const at = timeFor(by, c.created_at + 3 * DAY, NOW - 4 * DAY); // before the class's current join code was made
    if (at) audit(at, by, R.chance(0.5) ? 'mitglied_entfernt' : 'beitrittscode_geloescht', c.name);
  }
  for (const s of R.sample(homePool.filter((p) => !p.blockedAt), Math.max(3, Math.round(S / 200)))) {
    const at = timeFor(s, SY + 7 * DAY, NOW - HOUR);
    if (at) audit(at, s, 'klasse_verlassen', R.pick(clubs.concat(courses)).name, 'Schüler/in');
  }

  // ------------------------------------------------------------ notices: dedupe, read state, the newest 200
  {
    const byUser = new Map();
    for (const n of out.notices) {
      if (!byUser.has(n.u)) byUser.set(n.u, []);
      byUser.get(n.u).push(n);
    }
    const kept = [];
    for (const [u, list] of byUser) {
      list.sort((x, y) => x.at - y.at);
      const unread = new Map(); // kind|text|href -> read_at of the newest copy (null = unread)
      const mine = [];
      for (const n of list) {
        const key = `${n.kind}\u0000${n.text}\u0000${n.href}`;
        if (unread.has(key)) {
          const r = unread.get(key);
          if (r === null || r > n.at) continue; // notify() skips the same unread message twice
        }
        const age = NOW - n.at;
        const pRead = age < 2 * DAY ? 0.25 : age < 7 * DAY ? 0.5 : age < 30 * DAY ? 0.72 : 0.86;
        let readAt = R.chance(pRead) ? n.at + R.real(5 * MIN, Math.min(2 * DAY, Math.max(10 * MIN, age - MIN))) : null;
        if (readAt !== null && (readAt >= NOW || readAt > u.end)) readAt = null;
        n.read = readAt;
        unread.set(key, readAt);
        mine.push(n);
      }
      for (const n of mine.slice(-200)) kept.push(n);
    }
    kept.sort((x, y) => x.at - y.at);
    out.notices = kept;
  }

  // ------------------------------------------------------------ sign-ins (one audit entry each)
  const signins = [];
  for (const p of people) {
    const from = Math.max(cal.indexOf(Math.max(W, p.created_at)), WI);
    const to = Math.min(cal.indexOf(Math.min(NOW - 1, p.end - MIN)), NI);
    const activeSet = new Set(p.activeDays);
    for (let i = from; i <= to; i++) {
      const t = p.touched.get(i);
      const d = days[i];
      const createdToday = p.created_at >= d.start && p.created_at < d.start + DAY;
      if (!t && !activeSet.has(i) && !createdToday) continue;
      const times = [];
      if (t && t.s !== null) times.push(t.s - R.int(1, 12) * MIN);
      if (t && t.e !== null) times.push(t.e - R.int(1, 10) * MIN);
      if (!t) times.push(slotTime(d, d.school ? (R.chance(0.8) ? 'lesson' : 'evening') : 'free'));
      if (d.school && (!t || t.s !== null)) {
        // School PCs: a new sign-in after changing rooms.
        if (R.chance(0.5)) times.push(slotTime(d, 'lesson'));
        if (R.chance(0.2)) times.push(slotTime(d, 'lesson'));
      }
      if (createdToday) times.push(p.created_at); // the account was made by this sign-in
      for (const ts of times) {
        const at = Math.max(ts, p.created_at, d.start + 5 * MIN);
        if (at >= NOW || at >= p.end) continue;
        signins.push({ at, actor: p, action: 'anmeldung' });
        p.lastLogin = Math.max(p.lastLogin || 0, at);
        // Signing out happens mostly on shared school PCs.
        if (R.chance(d.school && at - d.start < 15 * HOUR ? 0.35 : 0.08)) {
          const outAt = at + R.int(15, 80) * MIN;
          if (outAt < NOW && outAt < p.end) signins.push({ at: outAt, actor: p, action: 'abmeldung' });
        }
      }
    }
    if (!p.lastLogin) p.lastLogin = p.created_at;
  }
  // Failed sign-ins (other tenants, refused e-mail addresses) are logged without a person.
  for (let i = WI; i <= NI; i++) if (days[i].school && R.chance(0.4)) signins.push({ at: slotTime(days[i], 'lesson'), actor: null, action: 'anmeldung_abgelehnt' });
  for (const s of signins) if (s.at >= AUDIT_FLOOR && s.at < NOW) out.audit.push({ at: s.at, actor: s.actor, action: s.action, target: '', detail: '', subject: null, app: null });
  out.audit.sort((x, y) => x.at - y.at);
  out.results.sort((x, y) => x.at - y.at);

  // ------------------------------------------------------------ dev accounts
  const dev = (p, why) => {
    if (!p) return;
    p.oid = `dev-${p.oid}`;
    out.dev.push({ p, why });
  };
  dev(admin, 'admin');
  dev(bigTeacher, `teacher with several big classes (${activeOf(bigTeacher).map((m) => m.cls.name).join(', ')})`);
  dev(coTeacher, `co-teacher (${activeOf(coTeacher).map((m) => `${m.cls.name}${m.primary ? '' : ' as co-teacher'}`).join(', ')})`);
  dev(devNoClassTeacher, `teacher without any class (owns ${devNoClassTeacher.apps.length} apps)`);
  dev(devNoClassStudent, 'student in no class (school-wide and own apps)');
  dev(devOneClass, `student in one class (${activeOf(devOneClass).map((m) => m.cls.name).join(', ')})`);
  dev(devFour, `student in ${activeOf(devFour).length} classes (${activeOf(devFour).map((m) => m.cls.name).join(', ')})`);
  dev(devBlocked, `blocked student (${activeOf(devBlocked).map((m) => m.cls.name).join(', ')}) - the test login refuses it`);

  out.stats = { W, NOW, SY, LAST_SY, ARCHIVED_AT, ARCH_FROM, kinds: { homeroom: homerooms.length, course: courses.length, club: clubs.length, big: big ? 1 : 0, archived: archived.length }, drawers };
  return out;
}

// ================================================================ writing

function writeAll(ctx, out, TPL) {
  const { db, uploads, userFiles } = ctx;
  const BATCH = 40_000;
  const inBatches = (rows, fn) => {
    for (let i = 0; i < rows.length; i += BATCH) db.tx(() => rows.slice(i, i + BATCH).forEach(fn));
  };
  db.tx(() => {
    for (const p of out.people) {
      db.run(
        'INSERT INTO users (id, oid, name, email, role, disabled, anonymous_scores, created_at, last_login_at, pref_theme, pref_text, pref_motion, pref_contrast) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        p.id, p.oid, p.name, p.email, p.role, p.blockedAt ? 1 : 0, p.anon, p.created_at, p.lastLogin, ...p.prefs
      );
    }
    for (const c of out.classes) {
      db.run('INSERT INTO classes (id, name, created_at, archived_at, subject, grade) VALUES (?, ?, ?, ?, ?, ?)', c.id, c.name, c.created_at, c.archived_at, c.subject || '', c.grade);
      for (const m of [...c.teachers, ...c.students]) db.run('INSERT INTO class_members (class_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)', c.id, m.p.id, m.role, m.at);
    }
    for (const k of out.codes) db.run('INSERT INTO join_codes (code, class_id, created_by, created_at, expires_at, role) VALUES (?, ?, ?, ?, ?, ?)', k.code, k.c.id, k.by.id, k.at, k.expires, k.role);
  });
  db.tx(() => {
    for (const a of out.apps) {
      const t = TPL[a.tpl];
      const last = a.versions[a.versions.length - 1];
      const updated = Math.max(a.created_at, last.created_at, ...a.pubs.map((p) => p.at), a.sharedAt || 0);
      db.run(
        `INSERT INTO apps (id, owner_id, name, description, emoji, color, kind, origin_key, published_version_id, schoolwide_version_id, created_at, updated_at, category, grade_min, grade_max, shared, schoolwide_requested_version_id)
         VALUES (?, ?, ?, ?, ?, ?, 'web', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        a.id, a.owner.id, a.name, a.description, a.emoji, a.color, a.origin_key, a.published ? a.published.id : null,
        a.swHistory.length ? a.swHistory[a.swHistory.length - 1].v.id : null, a.created_at, updated, a.category, a.grade_min, a.grade_max, a.shared, a.swReq ? a.swReq.id : null
      );
      for (const v of a.versions) {
        db.run(
          "INSERT INTO app_versions (id, app_id, number, status, note, file_count, total_bytes, created_at, manifest, report) VALUES (?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?)",
          v.id, a.id, v.number, v.note, t.fileCount, t.totalBytes, v.created_at, t.manifestJson, t.reportJson
        );
        for (const f of t.files) db.run('INSERT INTO app_files (version_id, path, path_lower, size, sha256) VALUES (?, ?, ?, ?, ?)', v.id, f.path, f.path_lower, f.size, f.sha256);
      }
      if (a.uploading) {
        // A folder upload that was started and never finished (cleaned up at the next upload of this app).
        const u = a.uploading;
        db.run("INSERT INTO app_versions (id, app_id, number, status, created_at) VALUES (?, ?, ?, 'uploading', ?)", u.id, a.id, u.number, u.created_at);
        for (const f of u.files) db.run('INSERT INTO app_files (version_id, path, path_lower, size, sha256) VALUES (?, ?, ?, ?, ?)', u.id, f.path, f.path_lower, f.size, f.sha256);
      }
    }
  });
  // Editor drafts through the Hub's own functions (rows copied from a version; an edited file is a new blob).
  db.tx(() => {
    for (const a of out.apps) {
      if (!a.draft) continue;
      const appRow = db.get('SELECT * FROM apps WHERE id = ?', a.id);
      const v = a.versions[a.versions.length - 1];
      uploads.draftFromVersion(appRow, { id: v.id });
      if (a.draft.edit) {
        const index = fs.readFileSync(path.join(ctx.config.root, 'examples', a.tpl, 'index.html'), 'utf8');
        uploads.putDraftFile(appRow, 'index.html', Buffer.from(index.replace(/<title>[^<]*<\/title>/, `<title>${a.name.replace(/[<&>]/g, '')}</title>`), 'utf8'));
      }
      if (a.draft.note) uploads.putDraftFile(appRow, 'notizen.txt', Buffer.from(`Ideen für ${a.name}:\n- mehr Level\n- Hilfe-Text\n`, 'utf8'));
      db.run('UPDATE app_drafts SET created_at = ?, updated_at = ? WHERE app_id = ?', a.draft.created, a.draft.updated, a.id);
    }
  });
  db.tx(() => {
    for (const c of out.classes) {
      for (const r of c.rows) {
        if (r.deleted) continue;
        db.run(
          `INSERT INTO class_apps (class_id, app_id, status, version_id, requested_version_id, request_state, added_by, decided_by, decided_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          c.id, r.app.id, r.status, r.version ? r.version.id : null, r.requested ? r.requested.id : null, r.state, r.added_by.id, r.decided_by ? r.decided_by.id : null, r.decided_at, r.created_at
        );
      }
    }
    out.comments.sort((x, y) => x.at - y.at);
    for (const k of out.comments) {
      db.run('INSERT INTO comments (id, app_id, author_id, body, created_at, kind, version_id, class_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', k.id, k.app.id, k.author.id, k.body, k.at, k.kind, k.v ? k.v.id : null, k.c ? k.c.id : null);
    }
    for (const s of out.settings) db.run('INSERT INTO class_app_settings (class_id, app_id, value, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)', s.c.id, s.app.id, s.value, s.by.id, s.at);
    for (const s of out.shared) {
      db.run(
        `INSERT INTO shared_data (app_id, class_id, key, value, size, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (app_id, class_id, key) DO UPDATE SET value = excluded.value, size = excluded.size, updated_at = excluded.updated_at`,
        s.app.id, s.scope, s.key, s.value, Buffer.byteLength(s.value), s.at
      );
    }
    for (const x of out.assignments) {
      db.run('INSERT INTO assignments (id, class_id, app_id, title, note, starts_at, due_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', x.id, x.c.id, x.app.id, x.title, x.note, x.starts, x.due, x.by.id, x.created);
    }
    for (const d of out.done) db.run('INSERT OR IGNORE INTO assignment_done (assignment_id, user_id, done_at) VALUES (?, ?, ?)', d.x.id, d.p.id, d.at);
    out.feedback.sort((x, y) => x.at - y.at);
    for (const f of out.feedback) {
      db.run(
        'INSERT INTO feedback (id, class_id, student_id, author_id, app_id, assignment_id, body, created_at, read_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        f.id, f.c.id, f.s.id, f.by.id, f.app ? f.app.id : null, f.x ? f.x.id : null, f.body, f.at, f.read
      );
    }
    for (const an of out.announcements) {
      db.run('INSERT INTO announcements (id, class_id, author_id, title, body, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)', an.id, an.c ? an.c.id : null, an.by.id, an.title, an.body, an.created, an.expires);
    }
    for (const d of out.dismissed) db.run('INSERT OR IGNORE INTO announcement_dismissed (announcement_id, user_id) VALUES (?, ?)', d.an.id, d.p.id);
  });
  // App data, the way the SDK API stores it.
  db.tx(() => {
    for (const s of out.saves) db.run('INSERT OR REPLACE INTO saves (app_id, user_id, key, value, size, updated_at) VALUES (?, ?, ?, ?, ?, ?)', s.a.id, s.p.id, s.key, s.value, Buffer.byteLength(s.value), s.at);
    for (const s of out.scores) db.run('INSERT OR REPLACE INTO scores (app_id, board, user_id, score, updated_at) VALUES (?, ?, ?, ?, ?)', s.a.id, s.board, s.p.id, s.score, s.at);
    for (const p of out.plays) db.run('INSERT INTO plays (app_id, user_id, first_at, last_at, count) VALUES (?, ?, ?, ?, ?)', p.a.id, p.p.id, p.first, p.last, p.count);
    for (const p of out.progress) db.run('INSERT OR REPLACE INTO progress (app_id, user_id, value, label, updated_at) VALUES (?, ?, ?, ?, ?)', p.a.id, p.p.id, p.value, p.label, p.at);
    for (const x of out.achievements) db.run('INSERT OR IGNORE INTO achievements (app_id, user_id, achievement, unlocked_at) VALUES (?, ?, ?, ?)', x.a.id, x.p.id, x.id, x.at);
    for (const f of out.favorites) db.run('INSERT OR IGNORE INTO favorites (user_id, app_id, created_at) VALUES (?, ?, ?)', f.p.id, f.a.id, f.at);
    const usage = [...out.usage.entries()].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
    for (const [k, n] of usage) {
      const [day, idx] = k.split('|');
      db.run('INSERT INTO app_usage (app_id, day, opens) VALUES (?, ?, ?)', out.apps[Number(idx)].id, day, n);
    }
  });
  // Drawings through userFiles.put (type check, quota, content under userfiles/<aa>/<sha256>).
  db.tx(() => {
    for (const f of out.files) {
      userFiles.put(f.a.id, f.p.id, f.name, 'image/png', encodePng(f.pixels));
      db.run('UPDATE user_files SET updated_at = ? WHERE app_id = ? AND user_id = ? AND name = ?', f.at, f.a.id, f.p.id, f.name);
    }
  });
  inBatches(out.results, (r) => {
    db.run('INSERT INTO results (app_id, user_id, title, score, max_score, details, class_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', r.a.id, r.p.id, r.title, r.score, r.max, r.seed ? resultDetails(r) : null, r.c, r.at);
  });
  inBatches(out.notices, (n) => {
    db.run('INSERT INTO notices (user_id, kind, text, href, created_at, read_at, subject_id) VALUES (?, ?, ?, ?, ?, ?, ?)', n.u.id, n.kind, n.text, n.href, n.at, n.read, n.subject ? n.subject.id : null);
  });
  inBatches(out.audit, (e) => {
    db.run(
      'INSERT INTO audit_log (at, actor_id, actor_label, action, target, detail, subject_id, app_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      e.at, e.actor ? e.actor.id : null, e.actor ? `${e.actor.name} (${e.actor.role})` : 'System', e.action, e.target, e.detail, e.subject ? e.subject.id : null, e.app ? e.app.id : null
    );
  });
}

/** The details a template app sends with a result (made from the result's own seed). */
function resultDetails(r) {
  const R = makeRandom(r.seed);
  const set = r.set;
  const flags = (n, right) => {
    const f = new Array(n).fill(false);
    for (const i of R.sample([...Array(n).keys()], right)) f[i] = true;
    return f;
  };
  if (r.tpl === 'vokabeltrainer') {
    const words = R.sample(set.woerter, r.max);
    const ok = flags(r.max, r.score);
    return JSON.stringify(words.map(([de, en], i) => {
      const toEnglish = set.richtung === 'de-en' || (set.richtung === 'gemischt' && R.chance(0.5));
      const solution = toEnglish ? en : de;
      const first = solution.split(' / ')[0];
      return { wort: toEnglish ? de : en, antwort: ok[i] ? first : typo(first), loesung: solution, richtig: ok[i] };
    }));
  }
  if (r.tpl === 'sternenfaenger') {
    const [level, meteore, sekunden, mode] = r.x;
    return JSON.stringify({ punkte: r.score, level, sterne: r.score, meteore, sekunden, schwierigkeit: STAR_MODES[mode] });
  }
  if (r.tpl === 'quiz-werkstatt') {
    const lines = set.mischen ? R.shuffle(set.fragen.slice()) : set.fragen;
    const ok = flags(lines.length, r.score);
    return JSON.stringify(lines.map((line, i) => {
      const [frage, richtig, ...falsch] = line.split('|').map((x) => x.trim());
      const wrong = falsch.length && set.modus !== 'eingabe' ? R.pick(falsch) : typo(richtig);
      return { frage, antwort: ok[i] ? richtig : wrong, loesung: richtig, richtig: ok[i] };
    }));
  }
  if (r.tpl === 'kopfrechnen') {
    const [level] = r.x;
    const max = Math.max(10, Math.round(((set.bis || 100) * level) / 3));
    const ops = ['plus', 'minus', 'mal', 'geteilt'].filter((op) => set[op] === true);
    const ok = flags(r.max, r.score);
    const log = [];
    for (let i = 0; i < r.max; i++) {
      const op = ops.length ? R.pick(ops) : 'plus';
      let text;
      let res;
      if (op === 'plus') {
        res = R.int(Math.min(7, max), max);
        const a = R.int(1, Math.max(1, res - 1));
        text = `${a} ${SIGNS.plus} ${res - a}`;
      } else if (op === 'minus') {
        const a = R.int(Math.min(7, max), max);
        const b = R.int(1, Math.max(1, a - 1));
        text = `${a} ${SIGNS.minus} ${b}`;
        res = a - b;
      } else {
        const a = R.int(2, 10);
        const b = R.int(2, Math.max(2, Math.min(10, Math.floor(max / a))));
        if (op === 'mal') {
          text = `${a} ${SIGNS.mal} ${b}`;
          res = a * b;
        } else {
          text = `${a * b} ${SIGNS.geteilt} ${a}`;
          res = b;
        }
      }
      log.push({ aufgabe: text, antwort: ok[i] ? res : res + R.pick([-2, -1, 1, 10]), loesung: res, richtig: ok[i], sekunden: Math.round(R.real(1.2, 4.8) * 10) / 10 });
    }
    return JSON.stringify(log);
  }
  if (r.tpl === 'lernkarten') {
    const cards = R.sample(set.karten, r.max);
    const ok = flags(r.max, r.score);
    return JSON.stringify(cards.map((c, i) => ({ vorderseite: c[0], rueckseite: c[1], gewusst: ok[i], fach: ok[i] ? R.int(2, 5) : 1 })));
  }
  return null;
}

// ================================================================ checks and summary

function summarise(ctx, out, opts, cal, started) {
  const { db, config, uploads, userFiles } = ctx;
  const n = (x) => Number(x).toLocaleString('en-US');
  const one = (sql, ...p) => Object.values(db.get(sql, ...p))[0];
  const stats = (list) => {
    const s = list.slice().sort((x, y) => x - y);
    return s.length ? { min: s[0], median: s[Math.floor((s.length - 1) / 2)], max: s[s.length - 1] } : { min: 0, median: 0, max: 0 };
  };
  const lines = [];
  const line = (s = '') => lines.push(s);
  const tables = db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name);

  line(`SchulHub scale seed - ${config.dataDir}`);
  line(`  seed ${opts.seed} · ${n(opts.students)} students · ${n(opts.teachers)} teachers · ${opts.classes} classes · ${opts.days} days · anchored at ${cal.today} 00:00 Europe/Berlin`);
  line(`  school year from ${dayKey(cal.SY)} (last year from ${dayKey(cal.lastSY)}, archived about ${dayKey(out.stats.ARCHIVED_AT)}) · activity window from ${dayKey(out.stats.W)}`);
  line();
  line('Rows per table');
  for (const t of tables) line(`  ${t.padEnd(24)} ${n(one(`SELECT COUNT(*) FROM "${t}"`)).padStart(10)}`);
  line();

  // ---- people
  const activeCount = (role) => `SELECT u.id, (SELECT COUNT(*) FROM class_members m JOIN classes c ON c.id = m.class_id AND c.archived_at IS NULL WHERE m.user_id = u.id AND m.role = '${role}') AS n FROM users u WHERE u.role = '${role}'`;
  const sCounts = db.all(activeCount('student')).map((r) => r.n);
  const tCounts = db.all(activeCount('teacher')).map((r) => r.n);
  const bucket = (list, edges) => edges.map(([lo, hi]) => list.filter((x) => x >= lo && x <= hi).length);
  const [s0, s1, s2, s3] = bucket(sCounts, [[0, 0], [1, 1], [2, 2], [3, 99]]);
  const [t0, t1, t2] = bucket(tCounts, [[0, 0], [1, 1], [2, 99]]);
  line('People');
  line(`  students ${n(sCounts.length)} (blocked ${one("SELECT COUNT(*) FROM users WHERE role = 'student' AND disabled = 1")}, anonymous scores ${one("SELECT COUNT(*) FROM users WHERE role = 'student' AND anonymous_scores = 1")}) · teachers ${n(tCounts.length)} (blocked ${one("SELECT COUNT(*) FROM users WHERE role = 'teacher' AND disabled = 1")}) · admins ${one("SELECT COUNT(*) FROM users WHERE role = 'admin'")}`);
  line(`  not signed in for 90+ days: ${one('SELECT COUNT(*) FROM users WHERE last_login_at < ?', cal.NOW - 90 * DAY)} · signed in during the last 7 days: ${n(one('SELECT COUNT(*) FROM users WHERE last_login_at >= ?', cal.NOW - 7 * DAY))}`);
  line(`  students in 0 / 1 / 2 / 3+ active classes: ${s0} / ${s1} / ${s2} / ${s3}  (4+: ${sCounts.filter((x) => x >= 4).length})`);
  line(`  teachers with 0 / 1 / 2+ active classes: ${t0} / ${t1} / ${t2}  (3-6: ${tCounts.filter((x) => x >= 3).length}, max ${Math.max(...tCounts)})`);
  line(`  exact duplicate names: ${one('SELECT COUNT(*) FROM (SELECT name FROM users GROUP BY name HAVING COUNT(*) > 1)')} (e.g. "Lena Müller" ×${one("SELECT COUNT(*) FROM users WHERE name = 'Lena Müller'")})`);
  line();

  // ---- classes
  const sizes = db.all("SELECT (SELECT COUNT(*) FROM class_members m WHERE m.class_id = c.id AND m.role = 'student') AS n FROM classes c WHERE c.archived_at IS NULL").map((r) => r.n);
  const appsPer = db.all("SELECT (SELECT COUNT(*) FROM class_apps ca WHERE ca.class_id = c.id AND ca.status = 'approved') AS n FROM classes c WHERE c.archived_at IS NULL").map((r) => r.n);
  const co = one("SELECT COUNT(*) FROM classes c WHERE c.archived_at IS NULL AND (SELECT COUNT(*) FROM class_members m WHERE m.class_id = c.id AND m.role = 'teacher') >= 2");
  const k = out.stats.kinds;
  const sz = stats(sizes);
  const ap = stats(appsPer);
  line('Classes');
  line(`  active ${sizes.length} (${k.homeroom} homerooms, ${k.course} courses, ${k.club} clubs, ${k.big} year group) · archived ${one('SELECT COUNT(*) FROM classes WHERE archived_at IS NOT NULL')} · with co-teachers ${co}`);
  line(`  class sizes (students, active): min ${sz.min} / median ${sz.median} / max ${sz.max}`);
  const kindSizes = ['homeroom', 'course', 'club', 'big', 'archived'].map((kind) => {
    const s = stats(out.classes.filter((c) => c.kind === kind).map((c) => c.students.length));
    return `${{ homeroom: 'homerooms', course: 'courses', club: 'clubs', big: 'year group', archived: 'archived' }[kind]} ${s.min}-${s.max}`;
  });
  line(`    by kind: ${kindSizes.join(' · ')}`);
  line(`  approved apps per active class: min ${ap.min} / median ${ap.median} / max ${ap.max}`);
  const states = db.all("SELECT status || COALESCE('/' || request_state, '') AS s, COUNT(*) AS n FROM class_apps GROUP BY s ORDER BY s").map((r) => `${r.s} ${r.n}`).join(', ');
  line(`  class_apps by state: ${states}`);
  line(`  join codes: ${one("SELECT COUNT(*) FROM join_codes WHERE expires_at > ? AND role = 'student'", Date.now())} valid student codes, ${one("SELECT COUNT(*) FROM join_codes WHERE expires_at > ? AND role = 'teacher'", Date.now())} valid teacher invitations, ${one('SELECT COUNT(*) FROM join_codes WHERE expires_at <= ?', Date.now())} expired`);
  line();

  // ---- apps
  const byRole = db.all('SELECT u.role, COUNT(*) AS n, COUNT(DISTINCT a.owner_id) AS owners FROM apps a JOIN users u ON u.id = a.owner_id GROUP BY u.role ORDER BY u.role').map((r) => `${r.role} ${r.n} by ${r.owners}`).join(', ');
  line('Apps');
  line(`  apps ${one('SELECT COUNT(*) FROM apps')} (${byRole}) · published ${one('SELECT COUNT(*) FROM apps WHERE published_version_id IS NOT NULL')} · school-wide ${one('SELECT COUNT(*) FROM apps WHERE schoolwide_version_id IS NOT NULL')} (update waiting: ${one('SELECT COUNT(*) FROM apps WHERE schoolwide_requested_version_id IS NOT NULL AND schoolwide_requested_version_id IS NOT schoolwide_version_id')}) · shared ${one('SELECT COUNT(*) FROM apps WHERE shared = 1')} · drafts ${one('SELECT COUNT(*) FROM app_drafts')}`);
  line(`  versions ${n(one('SELECT COUNT(*) FROM app_versions'))} (ready ${n(one("SELECT COUNT(*) FROM app_versions WHERE status = 'ready'"))}, uploading ${one("SELECT COUNT(*) FROM app_versions WHERE status = 'uploading'")}) · per app max ${one('SELECT MAX(n) FROM (SELECT COUNT(*) AS n FROM app_versions GROUP BY app_id)')} · app files ${n(one('SELECT COUNT(*) FROM app_files'))} · draft files ${n(one('SELECT COUNT(*) FROM draft_files'))}`);
  line(`  by template: ${TEMPLATES.map((t) => `${t} ${out.apps.filter((a) => a.tpl === t).length}`).join(', ')}`);
  line(`  audit 'app_aus_vorlage': ${one("SELECT COUNT(*) FROM audit_log WHERE action = 'app_aus_vorlage'")} · 'app_erstellt': ${one("SELECT COUNT(*) FROM audit_log WHERE action = 'app_erstellt'")}`);
  line();

  // ---- activity
  const res = db.get("SELECT COUNT(*) AS n, SUM(class_id IS NULL) AS none, SUM(class_id = '') AS legacy, SUM(details IS NOT NULL) AS det FROM results");
  const saveSizes = stats(db.all('SELECT size FROM saves').map((r) => r.size));
  const big = db.all('SELECT size FROM saves ORDER BY size DESC LIMIT 1')[0];
  const noticeCounts = db.all('SELECT u.id, (SELECT COUNT(*) FROM notices x WHERE x.user_id = u.id) AS n FROM users u').map((r) => r.n);
  const nc = stats(noticeCounts);
  const unread = one('SELECT COUNT(*) FROM notices WHERE read_at IS NULL');
  const fb = db.get('SELECT COUNT(*) AS n, SUM(read_at IS NOT NULL) AS read FROM feedback');
  line('Activity');
  line(`  results ${n(res.n)} (in a class ${n(res.n - res.none - res.legacy)}, outside a class ${n(res.none)}, legacy '' ${n(res.legacy)}) · with details ${Math.round((100 * res.det) / Math.max(1, res.n))} % · max per person+app ${one('SELECT MAX(n) FROM (SELECT COUNT(*) AS n FROM results GROUP BY app_id, user_id)')}`);
  line(`  biggest class: ${n(one("SELECT MAX(n) FROM (SELECT COUNT(*) AS n FROM results WHERE class_id IS NOT NULL AND class_id <> '' GROUP BY class_id)"))} results · biggest app in one class: ${n(one("SELECT MAX(n) FROM (SELECT COUNT(*) AS n FROM results WHERE class_id IS NOT NULL AND class_id <> '' GROUP BY class_id, app_id)"))} results`);
  const perPupil = stats(db.all("SELECT COUNT(*) AS n FROM plays p JOIN users u ON u.id = p.user_id AND u.role = 'student' WHERE p.last_at >= ? GROUP BY p.user_id", out.stats.W).map((r) => r.n));
  line(`  plays ${n(one('SELECT COUNT(*) FROM plays'))} (openings ${n(one('SELECT SUM(count) FROM plays'))}) · students who played in the window: ${n(one("SELECT COUNT(DISTINCT p.user_id) FROM plays p JOIN users u ON u.id = p.user_id AND u.role = 'student' WHERE p.last_at >= ?", out.stats.W))} · apps each: min ${perPupil.min} / median ${perPupil.median} / max ${perPupil.max}`);
  line(`  openings per week: ${db.all("SELECT strftime('%W', day) AS w, SUM(opens) AS n FROM app_usage WHERE day >= ? GROUP BY w ORDER BY MIN(day)", dayKey(out.stats.W)).map((r) => n(r.n)).join(' ')}`);
  line(`  saves ${n(one('SELECT COUNT(*) FROM saves'))}: size min ${saveSizes.min} B / median ${saveSizes.median} B / max ${formatBytes(big ? big.size : 0)}; values 100 B-4 KB: ${Math.round((100 * one('SELECT COUNT(*) FROM saves WHERE size BETWEEN 100 AND 4096')) / Math.max(1, one('SELECT COUNT(*) FROM saves')))} %, over 10 KB: ${one('SELECT COUNT(*) FROM saves WHERE size > 10240')} · max per person+app ${formatBytes(one('SELECT MAX(s) FROM (SELECT SUM(size) AS s FROM saves GROUP BY app_id, user_id)') || 0)} / ${one('SELECT MAX(n) FROM (SELECT COUNT(*) AS n FROM saves GROUP BY app_id, user_id)')} keys`);
  line(`  scores ${n(one('SELECT COUNT(*) FROM scores'))} · boards per person+app max ${one('SELECT MAX(n) FROM (SELECT COUNT(*) AS n FROM scores GROUP BY app_id, user_id)')} · boards per app max ${one('SELECT MAX(n) FROM (SELECT COUNT(DISTINCT board) AS n FROM scores GROUP BY app_id)')} · progress ${n(one('SELECT COUNT(*) FROM progress'))} · achievements ${n(one('SELECT COUNT(*) FROM achievements'))}`);
  line(`  user files ${one('SELECT COUNT(*) FROM user_files')} PNGs of ${one('SELECT COUNT(DISTINCT user_id) FROM user_files')} students (per student max ${one('SELECT MAX(n) FROM (SELECT COUNT(*) AS n FROM user_files GROUP BY user_id)') || 0}) · shared data ${one("SELECT COUNT(*) FROM shared_data WHERE class_id <> ''")} class-scoped, ${one("SELECT COUNT(*) FROM shared_data WHERE class_id = ''")} app-wide · favourites ${one('SELECT COUNT(*) FROM favorites')} of ${one('SELECT COUNT(DISTINCT user_id) FROM favorites')} students`);
  line(`  assignments ${one('SELECT COUNT(*) FROM assignments')} (planned ${one('SELECT COUNT(*) FROM assignments WHERE starts_at > ?', cal.NOW)}, due in the past ${one('SELECT COUNT(*) FROM assignments WHERE due_at < ?', cal.NOW)}, due later ${one('SELECT COUNT(*) FROM assignments WHERE due_at >= ?', cal.NOW)}, no date ${one('SELECT COUNT(*) FROM assignments WHERE due_at IS NULL')}) · marked done ${n(one('SELECT COUNT(*) FROM assignment_done'))}`);
  line(`  feedback ${n(fb.n)} (read ${Math.round((100 * fb.read) / Math.max(1, fb.n))} %) · announcements ${one('SELECT COUNT(*) FROM announcements WHERE class_id IS NULL')} school-wide + ${one('SELECT COUNT(*) FROM announcements WHERE class_id IS NOT NULL')} class (expired ${one('SELECT COUNT(*) FROM announcements WHERE expires_at < ?', cal.NOW)}) · dismissed ${one('SELECT COUNT(*) FROM announcement_dismissed')}`);
  line(`  notices ${n(noticeCounts.reduce((x, y) => x + y, 0))}: per person min ${nc.min} / median ${nc.median} / max ${nc.max} · people with 20-100: ${noticeCounts.filter((x) => x >= 20 && x <= 100).length} of ${noticeCounts.length} · unread ${((100 * unread) / Math.max(1, noticeCounts.reduce((x, y) => x + y, 0))).toFixed(1)} %`);
  line(`    by kind: ${db.all('SELECT kind, COUNT(*) AS n FROM notices GROUP BY kind ORDER BY n DESC').map((r) => `${r.kind} ${n(r.n)}`).join(', ')}`);
  line(`  audit_log ${n(one('SELECT COUNT(*) FROM audit_log'))}: ${db.all('SELECT action, COUNT(*) AS n FROM audit_log GROUP BY action ORDER BY n DESC').map((r) => `${r.action} ${n(r.n)}`).join(', ')}`);
  line(`  app_usage ${n(one('SELECT COUNT(*) FROM app_usage'))} days · comments ${n(one('SELECT COUNT(*) FROM comments'))} (${db.all('SELECT kind, COUNT(*) AS n FROM comments GROUP BY kind ORDER BY kind').map((r) => `${r.kind} ${r.n}`).join(', ')})`);
  line();

  // ---- files on disk
  const codeShas = db.all('SELECT sha256 FROM app_files UNION SELECT sha256 FROM draft_files').map((r) => r.sha256);
  const fileShas = db.all('SELECT DISTINCT sha256 FROM user_files').map((r) => r.sha256);
  const missingCode = codeShas.filter((s) => !fs.existsSync(uploads.blobPath(s))).length;
  const missingFiles = fileShas.filter((s) => !fs.existsSync(userFiles.blobPath(s))).length;
  const dirBytes = (dir) => {
    let total = 0;
    let count = 0;
    if (!fs.existsSync(dir)) return { total, count };
    for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (e.isFile()) {
        total += fs.statSync(path.join(e.parentPath, e.name)).size;
        count++;
      }
    }
    return { total, count };
  };

  // ---- integrity, retention dry run, finish the WAL
  const integrity = db.all('PRAGMA integrity_check').map((r) => Object.values(r)[0]);
  const fkRows = db.all('PRAGMA foreign_key_check');
  const counts = () => Object.fromEntries(tables.map((t) => [t, one(`SELECT COUNT(*) FROM "${t}"`)]));
  // The Hub's own retention (services.maintenance) a week from now, rolled back. Its last step refreshes
  // the planner statistics (PRAGMA optimize); that one is switched off here - this database gets none.
  let retention = null;
  const SENTINEL = new Error('dry run');
  const optimize = db.optimize;
  db.optimize = () => {};
  try {
    db.tx(() => {
      const before = counts();
      ctx.services.maintenance(Date.now() + 7 * DAY);
      const after = counts();
      const flagged = one('SELECT COUNT(*) FROM users WHERE flagged_inactive_at IS NOT NULL');
      retention = { changed: tables.filter((t) => before[t] !== after[t]).map((t) => `${t} ${before[t]} -> ${after[t]}`), flagged };
      throw SENTINEL;
    });
  } catch (err) {
    if (err !== SENTINEL) throw err;
  } finally {
    db.optimize = optimize;
  }
  const limits = {
    results: one('SELECT MAX(n) FROM (SELECT COUNT(*) AS n FROM results GROUP BY app_id, user_id)') || 0,
    notices: nc.max,
    boards: one('SELECT MAX(n) FROM (SELECT COUNT(DISTINCT board) AS n FROM scores GROUP BY app_id)') || 0,
    saveBytes: one('SELECT MAX(s) FROM (SELECT SUM(size) AS s FROM saves GROUP BY app_id, user_id)') || 0,
    saveKeys: one('SELECT MAX(n) FROM (SELECT COUNT(*) AS n FROM saves GROUP BY app_id, user_id)') || 0,
    versions: one('SELECT MAX(n) FROM (SELECT COUNT(*) AS n FROM app_versions GROUP BY app_id)') || 0,
    apps: one('SELECT MAX(n) FROM (SELECT COUNT(*) AS n FROM apps GROUP BY owner_id)') || 0,
    comments: one('SELECT MAX(n) FROM (SELECT COUNT(*) AS n FROM comments GROUP BY app_id)') || 0,
    files: one('SELECT MAX(n) FROM (SELECT COUNT(*) AS n FROM user_files GROUP BY app_id, user_id)') || 0,
  };
  const L = config.limits;
  const limitText = [
    `results/person+app ${limits.results} ≤ ${L.resultsPerUser}`, `notices/person ${limits.notices} ≤ ${L.noticesPerUser}`, `boards/app ${limits.boards} ≤ ${L.boardsPerApp}`,
    `saves/person+app ${formatBytes(limits.saveBytes)} ≤ ${formatBytes(L.saveTotalBytes)}, ${limits.saveKeys} ≤ ${L.saveKeys} keys`, `versions/app ${limits.versions} ≤ ${L.maxVersionsPerApp}`,
    `apps/person ${limits.apps} ≤ ${L.maxAppsPerUser}`, `comments/app ${limits.comments} ≤ ${L.commentsPerApp}`, `files/person+app ${limits.files} ≤ ${L.filesPerApp}`,
  ];
  const limitOk = limits.results <= L.resultsPerUser && limits.notices <= L.noticesPerUser && limits.boards <= L.boardsPerApp && limits.saveBytes <= L.saveTotalBytes
    && limits.saveKeys <= L.saveKeys && limits.versions <= L.maxVersionsPerApp && limits.apps <= L.maxAppsPerUser && limits.comments <= L.commentsPerApp && limits.files <= L.filesPerApp;

  // Content fingerprint (every row of every table, plus the file names on disk) to compare runs.
  const hash = crypto.createHash('sha256');
  for (const t of [...tables, 'sqlite_sequence']) {
    for (const row of db.all(`SELECT * FROM "${t}" ORDER BY rowid`)) hash.update(JSON.stringify(Object.values(row)));
  }
  for (const s of [...new Set(codeShas)].sort()) hash.update(`b${s}`);
  for (const s of [...new Set(fileShas)].sort()) hash.update(`u${s}`);
  const fingerprintHex = hash.digest('hex');

  db.get('PRAGMA wal_checkpoint(TRUNCATE)');
  const dbFile = path.join(config.dataDir, 'hub.sqlite');
  const blobs = dirBytes(path.join(config.dataDir, 'blobs'));
  const ufiles = dirBytes(path.join(config.dataDir, 'userfiles'));
  const walBytes = fs.existsSync(`${dbFile}-wal`) ? fs.statSync(`${dbFile}-wal`).size : 0;
  line('Files');
  line(`  hub.sqlite ${formatBytes(fs.statSync(dbFile).size)} (WAL after checkpoint: ${walBytes} B) · blobs/ ${blobs.count} files, ${formatBytes(blobs.total)} · userfiles/ ${ufiles.count} files, ${formatBytes(ufiles.total)}`);
  line(`  referenced blobs missing on disk: ${missingCode} of ${new Set(codeShas).size} · user files missing: ${missingFiles} of ${fileShas.length}`);
  line();
  line('Checks');
  line(`  PRAGMA integrity_check: ${integrity.join('; ')}`);
  line(`  PRAGMA foreign_key_check: ${fkRows.length ? `${fkRows.length} broken references (${JSON.stringify(fkRows.slice(0, 3))})` : 'clean (0 rows)'}`);
  line(`  limits: ${limitOk ? 'all kept' : 'EXCEEDED'} - ${limitText.join(' · ')}`);
  line(`  retention dry run (services.maintenance at now + 7 days, rolled back): ${retention.changed.length ? `WOULD CHANGE ${retention.changed.join(', ')}` : 'deletes nothing'} · accounts it would flag as inactive: ${retention.flagged}`);
  line(`  no ANALYZE / PRAGMA optimize run (sqlite_stat1 present: ${one("SELECT COUNT(*) FROM sqlite_master WHERE name = 'sqlite_stat1'") ? 'yes' : 'no'}) · journal ${one('PRAGMA journal_mode')} · schema version ${one('PRAGMA user_version')}`);
  line(`  content fingerprint: ${fingerprintHex}`);
  line();
  line('Dev accounts (DATA_DIR=<dir> npm run dev, then "Anmelden" on the landing page; POST /dev/login user=<id>)');
  for (const d of out.dev) line(`  ${d.p.oid.padEnd(20)} id ${d.p.id}  ${d.p.name.padEnd(22)} ${d.why}`);
  line();
  line(`Run time: ${((Number(process.hrtime.bigint() - started) / 1e9)).toFixed(1)} s`);
  return {
    text: lines.join('\n'),
    ok: integrity.length === 1 && integrity[0] === 'ok' && !fkRows.length && !missingCode && !missingFiles && !retention.changed.length && limitOk,
  };
}

// ================================================================ main

function main() {
  const started = process.hrtime.bigint();
  const opts = parseArgs(process.argv.slice(2));
  const dataDir = path.resolve(process.cwd(), opts.data);
  prepareFolder(dataDir, opts.force);
  const config = loadConfig({ env: { BASE_URL: 'http://localhost:3000' }, dev: true, overrides: { dataDir } });
  const hub = createHub(config);
  const ctx = hub.ctx;
  try {
    const R = makeRandom(opts.seed);
    const cal = makeCalendar(opts.days);
    process.stdout.write('Analysing the example apps ... ');
    const TPL = analyseTemplates(ctx);
    process.stdout.write('building the school ... ');
    const out = buildSchool(R, cal, TPL, opts);
    process.stdout.write('writing ... ');
    writeAll(ctx, out, TPL);
    process.stdout.write('checking ...\n\n');
    const summary = summarise(ctx, out, opts, cal, started);
    console.log(summary.text);
    if (!summary.ok) {
      console.error('\nSome checks failed (see above).');
      process.exitCode = 1;
    }
  } finally {
    hub.stop();
  }
}

main();
