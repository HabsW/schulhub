'use strict';
// Demo data for the local test mode: six test people, the class "7b Englisch"
// with four apps in use, a student app waiting for review, a school-wide app,
// an assignment, feedback, an announcement - and a few days of realistic use,
// so a fresh `npm run dev` shows the platform working.
//
// Only ever called when the server runs with --dev, and only on an empty
// database. The example apps go through the normal upload validation; state
// changes use the services (classApps, services) wherever they exist. App data
// (results, saves, scores ...) is written directly, the way the SDK API would
// have stored it, because there is no server-side API for "pretend a student
// played yesterday".

const path = require('node:path');
const { newId, dayKey } = require('./util');
const { manifestOf, validateSettings } = require('./manifest');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const PEOPLE = [
  ['dev-admin', 'Anna Adler', 'admin'],
  ['dev-lehrer', 'Herr Lehmann', 'teacher'],
  ['dev-lehrerin', 'Frau Yilmaz', 'teacher'],
  ['dev-mia', 'Mia Schmidt', 'student'],
  ['dev-ben', 'Ben Hoffmann', 'student'],
  ['dev-lena', 'Lena Wagner', 'student'],
];

// The example apps: folder in examples/, fields as the author would type them.
const APPS = {
  vokabeltrainer: { name: 'Vokabeltrainer', emoji: '🔤', color: '1', description: 'Vokabeln üben – die Lehrkraft legt die Wörter für die Klasse fest. Mit Fortschritt, Erfolgen und Bestenliste.' },
  sternenfaenger: { name: 'Sternenfänger', emoji: '⭐', color: '4', description: 'Fang die Sterne, weich den Meteoriten aus. Zehn Level, Bestenliste und Erfolge.' },
  'quiz-werkstatt': { name: 'Quiz-Werkstatt', emoji: '💡', color: '0', description: 'Ein Quiz für jedes Fach: Die Lehrkraft schreibt die Fragen im Hub, die Klasse spielt – mit Auswahl- oder Eintipp-Antworten.' },
  kopfrechnen: { name: 'Kopfrechnen', emoji: '🧮', color: '2', description: 'Kopfrechen-Sprint auf Zeit: fünf Stufen, Bestzeiten in der Klasse. Zahlenraum und Rechenarten stellt die Lehrkraft ein.' },
  'pixel-studio': { name: 'Pixel-Studio', emoji: '🎨', color: '3', description: 'Male Pixelbilder. Deine Bilder werden in deinem Konto gespeichert – und als PNG in deiner Galerie.' },
  lernkarten: { name: 'Lernkarten', emoji: '📚', color: '5', description: 'Karteikarten mit Lernkartei: Was du kannst, kommt seltener dran. Für jedes Fach – die Karten legt die Lehrkraft fest.' },
};

// What Herr Lehmann set up for 7b (validated against each app's schulhub.json before it is stored).
const WORDS_7B = [
  ['der Bahnhof', 'station'], ['die Fahrkarte', 'ticket'], ['der Koffer', 'suitcase'], ['der Flughafen', 'airport'],
  ['die Reise', 'trip / journey'], ['das Gepäck', 'luggage'], ['die Abfahrt', 'departure'], ['die Ankunft', 'arrival'],
  ['verpassen', 'to miss'], ['ankommen', 'to arrive'], ['der Strand', 'beach'], ['das Wetter', 'weather'],
  ['die Landkarte', 'map'], ['die Brücke', 'bridge'], ['der Reisepass', 'passport'], ['die Unterkunft', 'accommodation'],
];
const QUIZ_7B = {
  titel: 'Grammatik-Check Unit 3',
  modus: 'gemischt',
  mischen: true,
  fragen: [
    'Simple past von „go“? | went | goed | gone | going',
    'Welches Wort passt? She ___ to school by bus. | goes | go | going | gone',
    'Plural von „child“? | children',
    'Übersetze: der Bahnhof | station',
    'Welcher Satz ist richtig? | I have never been to London. | I never was in London since. | I have never be to London. | I am never been to London.',
    'Simple past von „buy“? | bought | buyed | brought | buy',
    'Gegenteil von „expensive“? | cheap',
    'Welches Fragewort passt? ___ do you live? | Where | Who | What | Which',
  ],
};

/** Small deterministic random numbers, so the demo looks the same on every machine. */
function random(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** The quiz app's fingerprint of a question set (same function as in examples/quiz-werkstatt/app.js). */
function fingerprint(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

/** A heart for Mia's first Pixel-Studio canvas (16 x 16, colour indexes of the app's palette). */
function heart() {
  const out = [];
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const px = (x + 0.5 - 8) / 5.6;
      const py = (8 - (y + 0.5)) / 5.6 + 0.15;
      const inside = (px * px + py * py - 1) ** 3 - px * px * py ** 3 <= 0;
      const shine = (x === 4 && y >= 4 && y <= 6) || (x === 5 && y === 4);
      out.push(inside ? (shine ? 8 : 2) : 0);
    }
  }
  return out;
}

function seedDemo(ctx) {
  const { db, services, uploads, config, classApps } = ctx;
  if (db.get('SELECT COUNT(*) AS n FROM users').n > 0) return;
  const now = Date.now();
  /** A moment `days` ago at a given local time - never in the future. */
  const at = (days, hour, minute = 0) => {
    const d = new Date(now - days * DAY);
    d.setHours(hour, minute, 0, 0);
    return Math.min(d.getTime(), now - 5 * MINUTE);
  };

  // ----- people -----
  const users = {};
  for (const [oid, name, role] of PEOPLE) {
    const id = newId();
    db.run('INSERT INTO users (id, oid, name, email, role, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, oid, name, `${oid.slice(4)}@schule.example`, role, now - 40 * DAY);
    users[oid] = db.get('SELECT * FROM users WHERE id = ?', id);
  }
  const admin = users['dev-admin'];
  const teacher = users['dev-lehrer'];
  const yilmaz = users['dev-lehrerin'];
  const mia = users['dev-mia'];
  const ben = users['dev-ben'];

  // ----- the class (students join by QR code in real life; here they are simply members) -----
  const classId = services.createClass(teacher, '7b Englisch');
  db.run("UPDATE classes SET subject = 'Englisch', grade = 7, created_at = ? WHERE id = ?", now - 30 * DAY, classId);
  services.createJoinCode(teacher, classId, 7 * 24 * 60);
  for (const s of [mia, ben]) {
    db.run("INSERT INTO class_members (class_id, user_id, role, joined_at) VALUES (?, ?, 'student', ?)", classId, s.id, now - 28 * DAY);
  }
  const cls = db.get('SELECT * FROM classes WHERE id = ?', classId);

  // ----- apps: uploaded through the normal validation, then published -----
  function example(owner, folder) {
    const id = services.createApp(owner, APPS[folder]);
    const app = db.get('SELECT * FROM apps WHERE id = ?', id);
    const version = services.createVersion(app);
    uploads.addDirectory(version, owner.id, path.join(config.root, 'examples', folder));
    services.finishVersion(owner, app, version);
    services.publish(owner, app, version);
    return db.get('SELECT * FROM apps WHERE id = ?', id);
  }
  const vocab = example(teacher, 'vokabeltrainer');
  const stars = example(teacher, 'sternenfaenger');
  const quiz = example(teacher, 'quiz-werkstatt');
  const math = example(teacher, 'kopfrechnen');
  const pixel = example(mia, 'pixel-studio');
  const cards = example(yilmaz, 'lernkarten');

  for (const app of [vocab, stars, quiz, math]) classApps.add(teacher, cls, app, 'approve');
  // Mia asks her teacher to review her own app (it waits in Herr Lehmann's queue).
  classApps.submit(mia, cls, pixel);
  db.run('INSERT INTO comments (id, app_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)', newId(), pixel.id, mia.id, 'Hallo Herr Lehmann, können wir mein Pixel-Studio in der Klasse benutzen?', now - 20 * MINUTE);
  // The admin releases Frau Yilmaz's flashcards for the whole school (as POST /apps/:id/schulweit does).
  db.run('UPDATE apps SET schoolwide_version_id = published_version_id WHERE id = ?', cards.id);
  services.audit(admin, 'schulweit_freigegeben', cards.name);

  // ----- per-class settings, checked against the app's manifest like the settings form does -----
  function classSettings(app, input, when) {
    const manifest = manifestOf(db.get('SELECT manifest FROM app_versions WHERE id = ?', app.published_version_id));
    const { values, errors } = validateSettings(manifest, input);
    if (Object.keys(errors).length) {
      console.warn(`Demo-Einstellungen für ${app.name} passen nicht zur schulhub.json:`, errors);
      return null;
    }
    db.run('INSERT INTO class_app_settings (class_id, app_id, value, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)', classId, app.id, JSON.stringify(values), teacher.id, when);
    return values;
  }
  classSettings(vocab, { woerter: WORDS_7B, richtung: 'de-en', runde: 8 }, at(9, 15, 20));
  const quizSettings = classSettings(quiz, QUIZ_7B, at(3, 14, 5)) || QUIZ_7B;

  // ----- a few days of use (the rows the SDK would have written) -----
  function session(app, user, ts) {
    db.run(
      `INSERT INTO plays (app_id, user_id, first_at, last_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (app_id, user_id) DO UPDATE SET first_at = MIN(first_at, excluded.first_at), last_at = MAX(last_at, excluded.last_at), count = count + 1`,
      app.id, user.id, ts, ts
    );
    db.run('INSERT INTO app_usage (app_id, day, opens) VALUES (?, ?, 1) ON CONFLICT (app_id, day) DO UPDATE SET opens = opens + 1', app.id, dayKey(ts));
  }
  const result = (app, user, ts, title, score, maxScore, details) =>
    db.run('INSERT INTO results (app_id, user_id, title, score, max_score, details, class_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', app.id, user.id, title, score, maxScore, JSON.stringify(details), classId, ts);
  const save = (app, user, key, value, ts) => {
    const json = JSON.stringify(value);
    db.run('INSERT OR REPLACE INTO saves (app_id, user_id, key, value, size, updated_at) VALUES (?, ?, ?, ?, ?, ?)', app.id, user.id, key, json, Buffer.byteLength(json), ts);
  };
  const progress = (app, user, value, label, ts) =>
    db.run('INSERT OR REPLACE INTO progress (app_id, user_id, value, label, updated_at) VALUES (?, ?, ?, ?, ?)', app.id, user.id, value, label, ts);
  const achieve = (app, user, id, ts) => db.run('INSERT OR IGNORE INTO achievements (app_id, user_id, achievement, unlocked_at) VALUES (?, ?, ?, ?)', app.id, user.id, id, ts);
  const best = (app, board, user, score, ts) =>
    db.run('INSERT OR REPLACE INTO scores (app_id, board, user_id, score, updated_at) VALUES (?, ?, ?, ?, ?)', app.id, board, user.id, score, ts);

  // Vokabeltrainer: rounds of 8 words; the saved state is replayed from the rounds, exactly like the app does it.
  const typo = (s) => {
    const swapped = s.length > 4 ? s.slice(0, 2) + s[3] + s[2] + s.slice(4) : s;
    return swapped !== s ? swapped : s.slice(0, -1);
  };
  function vocabRounds(user, rounds) {
    const known = {};
    let streak = 0;
    let total = 0;
    for (const r of rounds) {
      const log = r.words.map((i) => {
        const [de, en] = WORDS_7B[i];
        const solution = en;
        const right = !r.wrong.includes(i);
        known[`${de}|${en}`] = right ? (known[`${de}|${en}`] || 0) + 1 : 0;
        streak = right ? streak + 1 : 0;
        return { wort: de, antwort: right ? en.split(' / ')[0] : typo(en.split(' / ')[0]), loesung: solution, richtig: right };
      });
      const score = log.filter((l) => l.richtig).length;
      total += score;
      session(vocab, user, r.ts - 4 * MINUTE);
      result(vocab, user, r.ts, 'Übungsrunde', score, log.length, log);
    }
    const last = rounds[rounds.length - 1].ts;
    const learned = WORDS_7B.filter(([de, en]) => (known[`${de}|${en}`] || 0) >= 2).length;
    save(vocab, user, 'gekonnt', known, last);
    save(vocab, user, 'serie', streak, last);
    save(vocab, user, 'richtig-gesamt', total, last);
    best(vocab, 'richtig', user, total, last);
    progress(vocab, user, learned / WORDS_7B.length, `${learned} von ${WORDS_7B.length} Wörtern gelernt`, last);
    achieve(vocab, user, 'erste-runde', rounds[0].ts);
  }
  const first8 = [0, 1, 2, 3, 4, 5, 6, 7];
  const last8 = [8, 9, 10, 11, 12, 13, 14, 15];
  vocabRounds(mia, [
    { ts: at(6, 16, 10), words: first8, wrong: [2, 5, 6] },
    { ts: at(4, 17, 40), words: last8, wrong: [9, 15] },
    { ts: at(2, 18, 5), words: first8, wrong: [5] },
  ]);
  vocabRounds(ben, [
    { ts: at(3, 15, 30), words: first8, wrong: [1, 2, 5, 6] },
    { ts: now - 55 * MINUTE, words: first8, wrong: [5] },
  ]);

  // Sternenfänger
  function starRounds(user, rounds, unlocked) {
    let record = 0;
    let level = 1;
    for (const r of rounds) {
      session(stars, user, r.ts - 3 * MINUTE);
      result(stars, user, r.ts, 'Spielrunde (Normal)', r.score, null, { punkte: r.score, level: r.level, sterne: r.score, meteore: r.hits, sekunden: r.seconds, schwierigkeit: 'Normal' });
      record = Math.max(record, r.score);
      level = Math.max(level, r.level);
    }
    const last = rounds[rounds.length - 1].ts;
    save(stars, user, 'rekorde', { normal: record }, last);
    save(stars, user, 'bestes-level', level, last);
    best(stars, 'punkte', user, record, last);
    progress(stars, user, level / 10, `Level ${level} von 10 erreicht`, last);
    for (const [id, ts] of unlocked) achieve(stars, user, id, ts);
  }
  starRounds(mia, [{ ts: at(5, 19, 12), score: 23, level: 3, hits: 2, seconds: 74 }, { ts: at(1, 18, 47), score: 37, level: 4, hits: 1, seconds: 109 }], [['erster-stern', at(5, 19, 8)]]);
  starRounds(ben, [{ ts: at(3, 20, 15), score: 52, level: 6, hits: 2, seconds: 151 }], [['erster-stern', at(3, 20, 11)], ['level-5', at(3, 20, 14)]]);

  // Quiz-Werkstatt: Mia played the grammar check once (Ben has not yet).
  {
    const lines = quizSettings.fragen;
    const wrongAnswers = { 2: 'childs', 5: 'brought' };
    const log = lines.map((line, i) => {
      const [frage, richtig] = line.split('|').map((x) => x.trim());
      return { frage, antwort: wrongAnswers[i] || richtig, loesung: richtig, richtig: !wrongAnswers[i] };
    });
    const score = log.filter((l) => l.richtig).length;
    const ts = at(1, 17, 20);
    session(quiz, mia, ts - 6 * MINUTE);
    result(quiz, mia, ts, `Quiz: ${quizSettings.titel}`, score, log.length, log);
    save(quiz, mia, 'bestes', { quiz: fingerprint(`${quizSettings.titel}\n${lines.join('\n')}`), score, max: log.length }, ts);
    save(quiz, mia, 'runden', 1, ts);
    progress(quiz, mia, score / log.length, `Bestes Ergebnis: ${score} von ${log.length}`, ts);
    achieve(quiz, mia, 'erstes-quiz', ts);
  }

  // Kopfrechnen: both passed level 1 (numbers up to 20 with the default settings).
  function sprint(user, ts, seconds, mistakes, seed, unlocked) {
    const rnd = random(seed);
    const pick = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
    const log = [];
    for (let i = 0; i < 20; i++) {
      const op = ['plus', 'minus', 'mal'][pick(0, 2)];
      let text;
      let res;
      if (op === 'plus') {
        res = pick(7, 20);
        const a = pick(1, res - 1);
        text = `${a} + ${res - a}`;
      } else if (op === 'minus') {
        const a = pick(7, 20);
        const b = pick(1, a - 1);
        text = `${a} − ${b}`;
        res = a - b;
      } else {
        const a = pick(2, 10);
        const b = pick(2, Math.max(2, Math.floor(20 / a)));
        text = `${a} · ${b}`;
        res = a * b;
      }
      const wrong = i === 11 && mistakes > 0;
      log.push({ aufgabe: text, antwort: wrong ? res + 1 : res, loesung: res, richtig: !wrong, sekunden: Math.round((1.2 + rnd() * 2.6) * 10) / 10 });
    }
    const right = log.filter((l) => l.richtig).length;
    const time = `${String(seconds).replace('.', ',')} s`;
    session(math, user, ts - 2 * MINUTE);
    result(math, user, ts, `Sprint Stufe 1 · ${time}`, right, log.length, log);
    save(math, user, 'stufen', { 1: { best: seconds, passed: true } }, ts);
    save(math, user, 'stufe', 2, ts);
    best(math, 'stufe-1', user, seconds, ts);
    progress(math, user, 0.2, 'Stufe 1 von 5 geschafft', ts);
    for (const id of unlocked) achieve(math, user, id, ts);
  }
  sprint(ben, at(2, 16, 40), 48.6, 1, 7, ['erster-sprint']);
  sprint(mia, at(1, 16, 5), 55.2, 0, 11, ['erster-sprint', 'fehlerfrei']);

  // Pixel-Studio: Mia's first canvas already has a heart on it.
  session(pixel, mia, at(1, 19, 30));
  save(pixel, mia, 'bild-1', heart(), at(1, 19, 42));

  // ----- an assignment (due in three days): Ben is done, Mia has started -----
  const assignmentId = newId();
  const startsAt = now - 2 * HOUR;
  db.run(
    'INSERT INTO assignments (id, class_id, app_id, title, note, starts_at, due_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    assignmentId, classId, vocab.id, 'Vokabeln Unit 3 üben', 'Übt die Wörter aus Unit 3 – mindestens eine Runde, gern mehr. Am Freitag schreiben wir den Test.', startsAt, now + 3 * DAY, teacher.id, startsAt
  );
  services.notify([mia.id, ben.id], 'aufgabe', `Neue Aufgabe in ${cls.name}: „Vokabeln Unit 3 üben“`, `/aufgaben/${assignmentId}`);
  session(vocab, mia, now - 25 * MINUTE); // opened, not finished yet
  services.audit(teacher, 'aufgabe_erstellt', 'Vokabeln Unit 3 üben', cls.name);

  // ----- feedback from Herr Lehmann to Mia -----
  db.run(
    'INSERT INTO feedback (id, class_id, student_id, author_id, app_id, assignment_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    newId(), classId, mia.id, teacher.id, vocab.id, null,
    'Super, Mia – 7 von 8 in deiner letzten Runde! Schau dir „luggage“ noch einmal an, das war knifflig. Weiter so!', at(1, 8, 15)
  );
  services.notify([mia.id], 'rueckmeldung', 'Herr Lehmann hat dir eine Rückmeldung geschrieben.', '/rueckmeldungen');

  // ----- an announcement to 7b -----
  db.run(
    'INSERT INTO announcements (id, class_id, author_id, title, body, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    newId(), classId, teacher.id, 'Vokabeltest am Freitag', 'Am Freitag schreiben wir den Test zu Unit 3. Übt vorher im Vokabeltrainer – die Wortliste ist schon eingestellt. Viel Erfolg!', now - 3 * HOUR, now + 5 * DAY
  );

  console.log('Demo-Daten angelegt: sechs Testpersonen, Klasse „7b Englisch“ mit vier Apps, eine Schüler-App wartet auf Prüfung, „Lernkarten“ für die ganze Schule.');
}

module.exports = { seedDemo, WORDS_7B, QUIZ_7B };
