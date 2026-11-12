'use strict';
// The SDK reference: the ONE source for /entwickeln/sdk. Plain data with
// German text, rendered as escaped text by src/routes/docs.js. A test runs
// sdk/hub-sdk.js and checks that every function and property it offers is
// documented here (memberNames()).
//
// Limits come from the running configuration, so the page always shows the
// numbers that really apply.

const { CATEGORIES, ACHIEVEMENT_EMOJIS, SETTING_TYPES } = require('./manifest');

const KB = 1024;
const size = (bytes) => (bytes >= 1024 * KB ? `${Math.round(bytes / (1024 * KB))} MB` : `${Math.round(bytes / KB)} KB`);
const KEY_TEXT = '1 bis 64 Zeichen: Buchstaben ohne Umlaute, Ziffern und `_` `.` `:` `-`';

/** Members of a key-value store (save, shared, classData): get, set, remove, keys. */
function kvMembers(ns, { exampleKey, exampleValue, setLimits, setErrors, readHint }) {
  return [
    {
      name: `hub.${ns}.get`,
      sig: `hub.${ns}.get(key, fallback)`,
      text: `Liest einen Wert. ${readHint}`,
      params: [['key', 'Text', KEY_TEXT], ['fallback', 'beliebig, optional', 'Was zurückkommt, wenn unter diesem Schlüssel noch nichts steht. Ohne `fallback`: `null`.']],
      returns: 'Promise mit dem gespeicherten Wert (Zahl, Text, Liste, Objekt …) oder `fallback`.',
      errors: ['bad_key'],
      example: `const wert = await hub.${ns}.get('${exampleKey}', ${exampleValue.fallback});`,
    },
    {
      name: `hub.${ns}.set`,
      sig: `hub.${ns}.set(key, value)`,
      text: 'Speichert einen Wert unter einem Schlüssel und ersetzt, was dort vorher stand.',
      params: [['key', 'Text', KEY_TEXT], ['value', 'alles, was JSON kann', 'Zahlen, Texte, `true`/`false`, Listen und Objekte daraus. Funktionen, Dateien und `undefined` nicht.']],
      returns: 'Promise mit `true`.',
      limits: setLimits,
      errors: setErrors,
      example: `await hub.${ns}.set('${exampleKey}', ${exampleValue.set});`,
    },
    {
      name: `hub.${ns}.remove`,
      sig: `hub.${ns}.remove(key)`,
      text: 'Löscht einen Schlüssel mit seinem Wert. Gibt es ihn nicht, passiert nichts.',
      params: [['key', 'Text', KEY_TEXT]],
      returns: 'Promise mit `true`.',
      errors: setErrors.filter((e) => !['bad_value', 'too_large', 'quota'].includes(e)),
      example: `await hub.${ns}.remove('${exampleKey}');`,
    },
    {
      name: `hub.${ns}.keys`,
      sig: `hub.${ns}.keys()`,
      text: 'Listet alle Schlüssel auf, unter denen etwas steht.',
      params: [],
      returns: 'Promise mit einer alphabetisch sortierten Liste von Texten.',
      example: `const schluessel = await hub.${ns}.keys(); // z. B. ['${exampleKey}']`,
    },
  ];
}

/** The whole reference. config: the Hub's configuration (limits and rates). */
function sdkReference(config) {
  const L = config.limits;
  const R = config.rate;
  const perMinute = (rate) => Math.round((rate[0] * 60_000) / rate[1]);

  const groups = [
    {
      id: 'verbinden',
      title: 'Verbinden',
      code: 'Hub',
      intro: 'Binde `hub-sdk.js` mit `<script src="hub-sdk.js"></script>` ein. Die Datei liefert der Hub selbst aus, auch wenn deine App eine eigene Kopie enthält. Danach gibt es genau ein globales Objekt: `Hub`.',
      members: [
        {
          name: 'Hub.connect',
          sig: 'Hub.connect(options)',
          text: 'Verbindet die App mit dem Hub. Läuft sie nicht im Hub (zum Beispiel per Doppelklick auf `index.html`), startet der lokale Testmodus mit einer Testperson. Jeder weitere Aufruf gibt dasselbe Promise zurück.',
          params: [['options', 'Objekt, optional', 'Nur für den lokalen Testmodus. In `local` kannst du `isTeacher`, `name`, `theme`, `settings` (Werte für `hub.settings`) und `manifest` (den Inhalt deiner `schulhub.json` – dann gelten Erfolge und Einstellungen auch per Doppelklick) angeben.', "Hub.connect({ local: { isTeacher: true, name: 'Frau Test', theme: 'light', settings: { zeit: 10 } } });"]],
          returns: 'Promise mit dem `hub`-Objekt, über das alles andere läuft.',
          errors: ['no_hub'],
          example: "Hub.connect().then(async (hub) => {\n  document.querySelector('h1').textContent = 'Hallo ' + hub.user.name;\n  const stand = await hub.save.get('stand', { level: 1 });\n});",
          preview: 'Im Hub fragt das SDK die Seite um sie herum nach einem Schlüssel, der nur für diese Person, diese App und diese Sitzung gilt. Antwortet sie 15 Sekunden lang nicht, endet das Promise mit `no_hub`.',
          local: 'Mit `index.html?lehrkraft` in der Adresse ist die Testperson eine Lehrkraft.',
        },
        {
          name: 'Hub.version',
          sig: 'Hub.version',
          kind: 'property',
          text: 'Die Version des SDK als Zahl. Diese Anleitung beschreibt Version 2.',
          returns: '2',
          example: "if (Hub.version < 2) console.warn('Bitte hub-sdk.js erneuern.');",
        },
      ],
    },
    {
      id: 'wer',
      title: 'Wer, wo, wie',
      code: 'hub.user · hub.class · hub.mode · hub.app',
      intro: 'Diese vier Werte sind sofort da – ohne `await`.',
      members: [
        {
          name: 'hub.user',
          sig: 'hub.user',
          kind: 'property',
          text: 'Wer die App gerade benutzt. Apps erfahren nie die E-Mail-Adresse.',
          returns: '`{ id, name, isTeacher, isOwner }`',
          fields: [
            ['id', 'Kennung der Person – in jeder App eine andere, in deiner App immer dieselbe.'],
            ['name', 'Der Anzeigename, zum Beispiel „Mia Schmidt“.'],
            ['isTeacher', '`true`, wenn die Person Lehrkraft der Klasse ist, aus der die App geöffnet wurde.'],
            ['isOwner', '`true` für die Besitzerin oder den Besitzer der App.'],
          ],
          example: "if (hub.user.isTeacher) document.getElementById('bearbeiten').hidden = false;",
          local: 'Die Testperson „Test-Schüler“ (mit ?lehrkraft: „Test-Lehrkraft“). `isOwner` ist lokal immer `true`.',
        },
        {
          name: 'hub.class',
          sig: 'hub.class',
          kind: 'property',
          text: 'Die Klasse, aus der die App geöffnet wurde – oder `null`, wenn sie ohne Klasse läuft.',
          returns: '`{ id, name }` oder `null`',
          example: "const titel = hub.class ? 'Klasse ' + hub.class.name : 'Ohne Klasse';",
          preview: 'In der Vorschau im Editor gibt es keine Klasse: `hub.class` ist `null`.',
          local: 'Lokal gibt es die „Testklasse“.',
        },
        {
          name: 'hub.mode',
          sig: 'hub.mode',
          kind: 'property',
          text: 'Wo die App gerade läuft.',
          returns: "`'live'` (im Hub), `'preview'` (Vorschau: nichts wird dauerhaft gespeichert) oder `'local'` (auf deinem PC)",
          example: "if (hub.mode === 'preview') zeigeHinweis('Vorschau – nichts wird gespeichert.');",
        },
        {
          name: 'hub.theme',
          sig: 'hub.theme',
          kind: 'property',
          text: 'Die Darstellung, die die Person im Hub gewählt hat. Apps mit `hub-ui.css` (und `<body class="hub-ui">`) übernehmen sie automatisch.',
          returns: "`'dark'`, `'light'` oder `'auto'` (wie das Gerät)",
          example: "if (hub.theme === 'light') zeichneHellenHintergrund();",
          local: "Lokal `'auto'` – oder was du mit `Hub.connect({ local: { theme: 'light' } })` angibst.",
        },
        {
          name: 'hub.app',
          sig: 'hub.app',
          kind: 'property',
          text: 'Name und Versionsnummer der App, die gerade läuft.',
          returns: '`{ name, version }` – `version` ist `0` für den Entwurf im Editor.',
          example: "console.log(hub.app.name + ', Version ' + hub.app.version);",
          local: 'Lokal ist `name` der Titel der Seite und `version` `0`.',
        },
      ],
    },
    {
      id: 'save',
      title: 'Spielstand pro Person',
      code: 'hub.save',
      intro: 'Daten nur für die Person, die die App gerade benutzt – in dieser App. Niemand sonst kann sie lesen, auch du als Autor/in nicht.',
      preview: `Alles bleibt im Arbeitsspeicher (höchstens ${size(2 * 1024 * KB)} pro Vorschau) und ist nach zwei Stunden oder einem Neustart weg.`,
      local: 'Gespeichert wird im Browser (localStorage), getrennt nach Ordner.',
      members: kvMembers('save', {
        exampleKey: 'level',
        exampleValue: { fallback: '1', set: '3' },
        readHint: 'Jede Person hat ihren eigenen Spielstand.',
        setLimits: [`Ein Wert höchstens ${size(L.saveValueBytes)}.`, `Alle Werte einer Person in dieser App zusammen höchstens ${size(L.saveTotalBytes)} und ${L.saveKeys} Schlüssel.`],
        setErrors: ['bad_key', 'bad_value', 'too_large', 'quota'],
      }),
    },
    {
      id: 'shared',
      title: 'Daten für alle',
      code: 'hub.shared',
      intro: 'Daten für alle, die deine App benutzen – zum Beispiel Level oder eine Wortliste. Alle lesen, nur du als Besitzer/in schreibst. Für alle anderen enden `set` und `remove` mit `forbidden`.',
      preview: 'Lesen zeigt die echten Daten. Was die Vorschau schreibt, bleibt im Arbeitsspeicher.',
      local: 'Lokal darf die Testperson schreiben; gespeichert wird im Browser.',
      members: kvMembers('shared', {
        exampleKey: 'level-1',
        exampleValue: { fallback: 'null', set: "{ ziel: 10, zeit: 60 }" },
        readHint: 'Alle, die die App benutzen, lesen dieselben Daten.',
        setLimits: [`Ein Wert höchstens ${size(L.saveValueBytes)}.`, `Alle Werte der App zusammen höchstens ${size(L.sharedTotalBytes)} und ${L.saveKeys} Schlüssel.`],
        setErrors: ['bad_key', 'bad_value', 'too_large', 'quota', 'forbidden'],
      }),
    },
    {
      id: 'classData',
      title: 'Daten der Klasse',
      code: 'hub.classData',
      intro: 'Daten für eine Klasse, zum Beispiel die Wortliste dieser Woche. Alle in der Klasse lesen, nur die Lehrkraft der Klasse schreibt. Wurde die App nicht aus einer Klasse geöffnet, endet jeder Aufruf mit `no_class`.',
      preview: 'Lesen zeigt die echten Daten der Klasse, Schreiben bleibt im Arbeitsspeicher. Im Editor gibt es keine Klasse (`no_class`).',
      local: 'Lokal gibt es die „Testklasse“ und die Testperson darf schreiben.',
      members: kvMembers('classData', {
        exampleKey: 'woerter',
        exampleValue: { fallback: '[]', set: "[['Hund', 'dog'], ['Katze', 'cat']]" },
        readHint: 'Jede Klasse hat ihre eigenen Daten.',
        setLimits: [`Ein Wert höchstens ${size(L.saveValueBytes)}.`, `Alle Werte einer Klasse zusammen höchstens ${size(L.sharedTotalBytes)} und ${L.saveKeys} Schlüssel.`],
        setErrors: ['bad_key', 'bad_value', 'too_large', 'quota', 'forbidden', 'no_class'],
      }).map((m) => (m.name === 'hub.classData.get' || m.name === 'hub.classData.keys' ? { ...m, errors: [...(m.errors || []), 'no_class'] } : m)),
    },
    {
      id: 'leaderboard',
      title: 'Bestenlisten',
      code: 'hub.leaderboard',
      intro: 'Punktzahlen, bei denen der beste Wert pro Person zählt. Namen sieht nur, wer mit der Person in einer Klasse ist – alle anderen sehen „Anonym“. Bestenlisten sind zum Spaß da, nicht für Noten: die Werte meldet die App.',
      preview: 'In der Vorschau zeigt die Bestenliste nur dich. Nichts wird gespeichert.',
      local: 'Lokal erscheinen erfundene Mitschüler/innen (Ada, Linus, Grace), damit die Liste nicht leer ist.',
      members: [
        {
          name: 'hub.leaderboard.submit',
          sig: 'hub.leaderboard.submit(board, score, options)',
          text: 'Meldet eine Punktzahl. Gespeichert wird sie nur, wenn sie besser ist als der bisherige Bestwert dieser Person.',
          params: [
            ['board', 'Text', `Name der Bestenliste, ${KEY_TEXT}.`],
            ['score', 'Zahl', 'Die erreichte Punktzahl oder Zeit.'],
            ['options', 'Objekt, optional', '`{ lowerIsBetter: true }` für Zeiten: dann gewinnt der kleinere Wert.'],
          ],
          returns: 'Promise mit `{ best, improved }` – der Bestwert der Person und ob er gerade besser geworden ist.',
          limits: [`Höchstens ${L.boardsPerApp} Bestenlisten pro App.`],
          errors: ['bad_key', 'bad_value', 'quota'],
          example: "const r = await hub.leaderboard.submit('punkte', 120);\nif (r.improved) zeige('Neuer Rekord!');",
        },
        {
          name: 'hub.leaderboard.top',
          sig: 'hub.leaderboard.top(board, options)',
          text: 'Liest die besten Einträge einer Bestenliste.',
          params: [
            ['board', 'Text', 'Name der Bestenliste.'],
            ['options', 'Objekt, optional', "`limit` (1 bis 100, sonst 10), `scope` (`'class'` oder `'all'`; ohne Angabe `'class'`, wenn die App aus einer Klasse geöffnet wurde) und `lowerIsBetter` – gib es an wie bei `submit`.", "hub.leaderboard.top('zeit', { limit: 5, scope: 'all', lowerIsBetter: true });"],
          ],
          returns: 'Promise mit `{ scope, entries: [{ rank, name, score, me }], me }` – `me` ist `{ score }` oder `null`.',
          errors: ['bad_key'],
          example: "const top = await hub.leaderboard.top('punkte', { limit: 5 });\nfor (const e of top.entries) console.log(e.rank, e.name, e.score);",
        },
      ],
    },
    {
      id: 'results',
      title: 'Ergebnisse für die Lehrkraft',
      code: 'hub.results',
      intro: 'Ein Ergebnis hält fest, wie eine Runde gelaufen ist. Die Lehrkräfte der Klasse, aus der die App geöffnet wurde, sehen es in ihrer Auswertung – ohne dass du dafür etwas bauen musst. Wie die Felder in `details` heißen, legst du in `schulhub.json` unter `results.labels` fest.',
      preview: 'In der Vorschau landet nichts in einer Auswertung; es bleibt im Arbeitsspeicher (höchstens 100).',
      local: 'Lokal wird im Browser gespeichert (höchstens 100).',
      members: [
        {
          name: 'hub.results.add',
          sig: 'hub.results.add(result)',
          text: 'Hält ein Ergebnis fest.',
          params: [
            ['result.title', 'Text, optional', 'Zum Beispiel „Runde 3“. Höchstens 120 Zeichen; ohne Titel heißt es „Ergebnis“.'],
            ['result.score', 'Zahl, optional', 'Erreichte Punkte.'],
            ['result.maxScore', 'Zahl, optional', 'Mögliche Punkte.'],
            ['result.details', 'alles, was JSON kann, optional', 'Einzelheiten, zum Beispiel jede Antwort. Eine Liste gleich gebauter Objekte zeigt der Hub als Tabelle.'],
          ],
          returns: 'Promise mit `true`.',
          limits: [`\`details\` höchstens ${size(L.resultBytes)}.`, `Pro Person und App bleiben die neuesten ${L.resultsPerUser} Ergebnisse.`],
          errors: ['too_large'],
          example: "await hub.results.add({\n  title: 'Quiz-Runde', score: 4, maxScore: 5,\n  details: [{ frage: 'Hauptstadt von Frankreich?', gegeben: 'Paris', richtig: true }],\n});",
        },
        {
          name: 'hub.results.mine',
          sig: 'hub.results.mine(options)',
          text: 'Die eigenen letzten Ergebnisse, das neueste zuerst.',
          params: [['options', 'Objekt, optional', '`{ limit: 20 }` – 1 bis 100.']],
          returns: 'Promise mit einer Liste `[{ title, score, maxScore, details, at }]` – `at` ist ein Zeitstempel in Millisekunden.',
          example: 'const letzte = await hub.results.mine({ limit: 3 });',
        },
      ],
    },
    {
      id: 'progress',
      title: 'Fortschritt',
      code: 'hub.progress',
      intro: 'Eine Zahl von 0 bis 1 pro Person und App, zum Beispiel 0.4 für 40 %. Sie erscheint auf der Startseite der Person („Weitermachen“) und bei den Lehrkräften ihrer Klasse.',
      preview: 'In der Vorschau bleibt der Fortschritt im Arbeitsspeicher.',
      local: 'Lokal wird im Browser gespeichert.',
      members: [
        {
          name: 'hub.progress.set',
          sig: 'hub.progress.set(value, options)',
          text: 'Setzt den Fortschritt. Werte unter `0` oder über `1` werden auf `0` bzw. `1` gesetzt.',
          params: [['value', 'Zahl', '0 bis 1.'], ['options', 'Objekt, optional', "`{ label: 'Level 2 von 5' }` – höchstens 60 Zeichen."]],
          returns: 'Promise mit `true`.',
          errors: ['bad_value'],
          example: "await hub.progress.set(2 / 5, { label: 'Level 2 von 5' });",
        },
        {
          name: 'hub.progress.get',
          sig: 'hub.progress.get()',
          text: 'Liest den eigenen Fortschritt.',
          params: [],
          returns: 'Promise mit `{ value, label, at }` oder `null`.',
          example: 'const p = await hub.progress.get();\nconst prozent = p ? Math.round(p.value * 100) : 0;',
        },
      ],
    },
    {
      id: 'achievements',
      title: 'Erfolge',
      code: 'hub.achievements',
      intro: 'Erfolge stehen in `schulhub.json` unter `achievements` – mit Titel, Beschreibung und Emoji. Die App kann nur diese freischalten. Der Hub zeigt sie auf der Startseite der Person.',
      preview: 'In der Vorschau gelten die Erfolge aus der `schulhub.json` des Entwurfs bzw. der Version; freigeschaltet wird nur im Arbeitsspeicher.',
      local: 'Lokal liest das SDK `schulhub.json` nur über einen lokalen Webserver. Per Doppelklick geöffnet, wird jede `id` angenommen.',
      members: [
        {
          name: 'hub.achievements.unlock',
          sig: 'hub.achievements.unlock(id)',
          text: 'Schaltet einen Erfolg frei. Mehrmals aufrufen schadet nicht: Es zählt das erste Mal.',
          params: [['id', 'Text', 'Die `id` aus `schulhub.json`.']],
          returns: 'Promise mit `{ id, title, description, emoji, secret, unlocked, at, new }` – `new` ist `true` beim ersten Mal.',
          errors: ['unknown_achievement'],
          example: "const e = await hub.achievements.unlock('erste-runde');\nif (e.new) zeige(e.emoji + ' ' + e.title);",
        },
        {
          name: 'hub.achievements.list',
          sig: 'hub.achievements.list()',
          text: 'Alle Erfolge der App, für die Person mit `unlocked` und `at`. Geheime Erfolge (`secret: true`) heißen „Geheimer Erfolg“, bis sie freigeschaltet sind.',
          params: [],
          returns: 'Promise mit einer Liste `[{ id, title, description, emoji, secret, unlocked, at }]`.',
          example: 'const alle = await hub.achievements.list();\nconst geschafft = alle.filter((e) => e.unlocked).length;',
        },
      ],
    },
    {
      id: 'settings',
      title: 'Einstellungen der Klasse',
      code: 'hub.settings',
      intro: 'Felder, die die Lehrkraft für ihre Klasse im Hub ausfüllt – zum Beispiel die Fragen eines Quiz. Du legst die Felder in `schulhub.json` unter `settings` fest. Apps lesen sie nur; ändern kann sie nur die Lehrkraft.',
      preview: 'Ohne Klasse (auch im Editor) gelten die Standardwerte aus `schulhub.json`.',
      local: 'Lokal gelten die Standardwerte aus `schulhub.json` (nur über einen lokalen Webserver) und was du mit `Hub.connect({ local: { settings: { … } } })` angibst.',
      members: [
        {
          name: 'hub.settings.all',
          sig: 'hub.settings.all()',
          text: 'Alle Einstellungen auf einmal. Das SDK fragt nur einmal pro Seitenaufruf beim Hub nach.',
          params: [],
          returns: 'Promise mit einem Objekt `{ key: Wert }` für jedes Feld aus `schulhub.json`.',
          example: 'const e = await hub.settings.all();\nconsole.log(e.fragen, e.zeit);',
        },
        {
          name: 'hub.settings.get',
          sig: 'hub.settings.get(key, fallback)',
          text: 'Eine Einstellung. Gib als `fallback` dasselbe an wie `default` in `schulhub.json` – dann läuft die App auch per Doppelklick.',
          params: [['key', 'Text', 'Der `key` des Felds aus `schulhub.json`.'], ['fallback', 'beliebig, optional', 'Was zurückkommt, wenn es das Feld nicht gibt.']],
          returns: 'Promise mit dem Wert oder `fallback`.',
          example: "const fragen = await hub.settings.get('fragen', [['2 + 2', '4']]);",
        },
      ],
    },
    {
      id: 'files',
      title: 'Dateien',
      code: 'hub.files',
      intro: 'Kleine Dateien für die Person, die die App benutzt – zum Beispiel ein gemaltes Bild. Erlaubt sind PNG, JPEG, WebP, GIF, JSON, Text und CSV, und der Inhalt muss zum Typ passen. HTML und SVG gehen nicht.',
      preview: 'In der Vorschau bleiben Dateien im Arbeitsspeicher.',
      local: 'Lokal liegen Dateien im Browser (localStorage, höchstens 1 MB pro Datei). Der Typ wird dort nicht geprüft.',
      members: [
        {
          name: 'hub.files.put',
          sig: 'hub.files.put(name, data, options)',
          text: 'Speichert eine Datei und ersetzt eine gleichnamige.',
          params: [
            ['name', 'Text', KEY_TEXT],
            ['data', 'Blob, ArrayBuffer, Uint8Array oder Text', 'Der Inhalt.'],
            ['options', 'Objekt, optional', "`{ type: 'image/png' }` – nötig bei `ArrayBuffer` und `Uint8Array`. Ein `Blob` bringt seinen Typ mit, Text ist `text/plain`."],
          ],
          returns: 'Promise mit `{ name, type, size }`.',
          limits: [`Eine Datei höchstens ${size(L.fileBytes)}.`, `Pro Person und App höchstens ${L.filesPerApp} Dateien und ${size(L.fileTotalBytes)}.`, `Höchstens ${perMinute(R.sdkFiles)} Dateien pro Minute.`],
          errors: ['bad_key', 'bad_type', 'too_large', 'quota', 'rate_limited'],
          example: "leinwand.toBlob(async (blob) => {\n  await hub.files.put('bild.png', blob);\n}, 'image/png');",
        },
        {
          name: 'hub.files.get',
          sig: 'hub.files.get(name)',
          text: 'Liest eine Datei.',
          params: [['name', 'Text', 'Der Name beim Speichern.']],
          returns: 'Promise mit einem `Blob` oder `null`, wenn es die Datei nicht gibt.',
          errors: ['bad_key'],
          example: "const blob = await hub.files.get('bild.png');\nif (blob) bild.src = URL.createObjectURL(blob);",
        },
        {
          name: 'hub.files.list',
          sig: 'hub.files.list()',
          text: 'Alle eigenen Dateien in dieser App.',
          params: [],
          returns: 'Promise mit einer Liste `[{ name, type, size, updatedAt }]`.',
          example: 'const dateien = await hub.files.list();',
        },
        {
          name: 'hub.files.remove',
          sig: 'hub.files.remove(name)',
          text: 'Löscht eine Datei.',
          params: [['name', 'Text', 'Der Name beim Speichern.']],
          returns: 'Promise mit `true`, wenn es die Datei gab, sonst `false`.',
          errors: ['bad_key'],
          example: "await hub.files.remove('bild.png');",
        },
      ],
    },
    {
      id: 'room',
      title: 'Mehrspieler (vorbereitet)',
      code: 'hub.room',
      intro: 'Räume für Spiele mit mehreren Personen in einer Klasse sind vorbereitet, aber in diesem Hub noch nicht eingeschaltet.',
      members: [
        {
          name: 'hub.room',
          sig: 'hub.room(name, options)',
          text: 'Würde einem Raum beitreten. Heute endet der Aufruf immer mit dem Fehler `not_available` – baue deine App so, dass sie dann allein weiterspielt.',
          params: [['name', 'Text', 'Name des Raums.'], ['options', 'Objekt, optional', '`{ maxPlayers: 4 }`']],
          returns: 'Promise, das mit `not_available` endet.',
          errors: ['not_available'],
          example: "hub.room('runde-1', { maxPlayers: 4 }).catch((e) => {\n  if (e.code === 'not_available') spieleAllein();\n});",
        },
      ],
    },
  ];

  const errors = [
    ['bad_key', `Ein Schlüssel oder Name ist ungültig (${KEY_TEXT}).`],
    ['bad_value', 'Der Wert passt nicht, zum Beispiel keine Zahl, wo eine Zahl stehen muss, oder etwas, das JSON nicht kann.'],
    ['too_large', 'Der Wert oder die Datei ist zu groß.'],
    ['quota', 'Der Platz ist voll: zu viele Schlüssel, Bestenlisten oder Dateien, oder zu viele Daten.'],
    ['forbidden', 'Das darf diese Person nicht, zum Beispiel `shared.set`, wenn ihr die App nicht gehört.'],
    ['no_class', 'Die App wurde nicht aus einer Klasse geöffnet (`classData`).'],
    ['unknown_achievement', 'Diesen Erfolg gibt es nicht in `schulhub.json`.'],
    ['bad_type', 'Dieser Dateityp ist nicht erlaubt, oder der Inhalt passt nicht zum Typ.'],
    ['rate_limited', `Zu viele Aufrufe in kurzer Zeit (höchstens ${perMinute(R.sdk)} pro Minute und App).`],
    ['not_available', 'Diese Funktion ist im Hub nicht eingeschaltet (Mehrspieler).'],
    ['session_expired', 'Die Sitzung ist abgelaufen. Die Person muss sich neu anmelden.'],
    ['unauthorized', 'Der Schlüssel der App gilt nicht mehr. Das SDK holt sich normalerweise selbst einen neuen.'],
    ['no_hub', 'Die Seite um die App herum hat nicht geantwortet.'],
    ['unknown_method', 'Diese Funktion gibt es nicht (veraltetes oder verändertes SDK).'],
    ['server_error', 'Auf dem Server ist etwas schiefgegangen.'],
  ];

  const manifest = {
    example: JSON.stringify({
      category: 'Englisch',
      grades: [5, 7],
      achievements: [{ id: 'erste-runde', title: 'Erste Runde', description: 'Ein Quiz beendet.', emoji: '⭐' }],
      settings: [{ key: 'woerter', label: 'Wörter', type: 'pairs', columns: ['Deutsch', 'Englisch'], default: [['Hund', 'dog']] }],
      results: { labels: { richtig: 'Richtig beantwortet' } },
    }, null, 2),
    fields: [
      ['category', 'Text', `Das Fach im Katalog: ${CATEGORIES.join(', ')}.`],
      ['grades', 'Liste', 'Klassenstufen von bis, zum Beispiel `[5, 7]` (1 bis 13).'],
      ['achievements', 'Liste', 'Bis zu 50 Erfolge mit `id`, `title` (bis 60 Zeichen), `description` (bis 160), `emoji` und `secret`. Die `id` ist ein Schlüssel; `secret: true` versteckt den Erfolg, bis er freigeschaltet ist.'],
      ['settings', 'Liste', 'Bis zu 30 Felder, die die Lehrkraft ausfüllt: `key`, `label`, `help`, `type`, `default` und je nach `type` weitere Angaben (siehe unten). `default` muss zum Feld passen.'],
      ['results.labels', 'Objekt', 'Lesbare Namen für die Felder in `details` eines Ergebnisses, zum Beispiel `{ "richtig": "Richtig beantwortet" }`.'],
      ['name, description, version, $schema', '–', 'Werden angenommen und nicht verwendet. Alles andere erzeugt eine Warnung.'],
    ],
    settingTypes: [
      ['text', 'Ein Text. `multiline: true` für mehrere Zeilen, `maxLength` bis 2000 (sonst 200).', '{ "key": "titel", "label": "Titel", "type": "text", "default": "Quiz" }'],
      ['number', 'Eine Zahl mit `min`, `max` und `step`.', '{ "key": "zeit", "label": "Sekunden", "type": "number", "min": 5, "max": 120, "default": 30 }'],
      ['boolean', 'Ja oder Nein.', '{ "key": "ton", "label": "Ton an", "type": "boolean", "default": true }'],
      ['choice', 'Eine Auswahl aus 2 bis 20 `options`, als Texte oder als `{ value, label }`.', '{ "key": "stufe", "label": "Stufe", "type": "choice", "options": ["leicht", "schwer"], "default": "leicht" }'],
      ['list', 'Eine Liste von Texten (je bis 200 Zeichen), `maxItems` bis 500 (sonst 100). Die Lehrkraft schreibt einen Eintrag pro Zeile.', '{ "key": "teams", "label": "Teams", "type": "list", "default": ["Füchse", "Eulen"] }'],
      ['pairs', 'Paare, zum Beispiel Frage und Antwort. `columns` benennt die beiden Spalten, `maxItems` bis 500 (sonst 200). Die Lehrkraft schreibt eine Zeile pro Paar: `links = rechts`.', '{ "key": "woerter", "label": "Wörter", "type": "pairs", "columns": ["Deutsch", "Englisch"], "default": [["Hund", "dog"]] }'],
    ],
    emojis: ACHIEVEMENT_EMOJIS,
    types: SETTING_TYPES,
    rules: ['Die Datei liegt ganz oben im Ordner, neben `index.html`.', 'Sie ist reines JSON: keine Kommentare, Texte in doppelten Anführungszeichen.', 'Höchstens 64 KB.', 'Der Hub prüft sie beim Hochladen. Fehler und Warnungen stehen im Prüfbericht der Version.'],
  };

  const ui = {
    intro: '`hub-ui.css` lässt deine App aussehen wie der Hub: Schrift, Farben, helles und dunkles Design. Wie `hub-sdk.js` liefert der Hub die Datei selbst aus; in jeder Vorlage (ZIP) liegt eine Kopie für deinen PC. Alle Klassen beginnen mit `hub-`, damit sie nicht mit deinem CSS kollidieren.',
    example: '<link rel="stylesheet" href="hub-ui.css">\n<body class="hub-ui">\n  <main class="hub-page hub-stack">\n    <h1>Mein Quiz</h1>\n    <div class="hub-card hub-stack">\n      <button class="hub-btn hub-primary">Los</button>\n    </div>\n  </main>\n</body>',
    classes: [
      ['hub-ui', 'Auf `<body>`: Grundschrift, Hintergrund und Textfarbe des Hubs.'],
      ['hub-page', 'Ein Seitenrahmen mit begrenzter Breite und Rand.'],
      ['hub-stack', 'Untereinander, mit gleichem Abstand.'],
      ['hub-row', 'Nebeneinander, bricht auf schmalen Bildschirmen um.'],
      ['hub-muted', 'Leisere Textfarbe für Nebensachen.'],
      ['hub-eyebrow', 'Kleine Überschrift in Großbuchstaben über einem Titel.'],
      ['hub-btn', 'Ein Knopf (mindestens 44 Pixel hoch).'],
      ['hub-primary', 'Zusammen mit `hub-btn`: der wichtigste Knopf, gefüllt.'],
      ['hub-quiet', 'Zusammen mit `hub-btn`: ein leiser Knopf ohne Rahmen.'],
      ['hub-danger', 'Zusammen mit `hub-btn` oder `hub-badge`: rot, für Löschen oder Fehler.'],
      ['hub-big', 'Zusammen mit `hub-btn`: ein großer Knopf.'],
      ['hub-input', 'Ein Eingabefeld.'],
      ['hub-select', 'Eine Auswahlliste.'],
      ['hub-textarea', 'Ein mehrzeiliges Eingabefeld.'],
      ['hub-label', 'Eine Beschriftung, die ihr Feld umschließt.'],
      ['hub-card', 'Eine Fläche mit Rahmen für zusammengehörige Inhalte.'],
      ['hub-list', 'Eine Liste mit Trennlinien.', '<ul class="hub-list"><li>Erster Eintrag</li></ul>'],
      ['hub-badge', 'Ein kleines Etikett.'],
      ['hub-ok', 'Zusammen mit `hub-badge`: grün, für Erledigtes.'],
      ['hub-wait', 'Zusammen mit `hub-badge`: gelb, für Wartendes.'],
      ['hub-progress', 'Ein Fortschrittsbalken.', '<progress class="hub-progress" max="1" value="0.4"></progress>'],
      ['hub-leaderboard', 'Eine nummerierte Bestenliste.', '<ol class="hub-leaderboard">\n  <li class="hub-me"><span>Mia</span><b>120</b></li>\n</ol>'],
      ['hub-me', 'Zusammen mit einem Eintrag der Bestenliste: hebt die eigene Zeile hervor.'],
      ['hub-toast', 'Eine kurze Meldung am unteren Rand, zum Beispiel „Gespeichert“.'],
    ],
    variables: ['`--hub-accent`: die Farbe des wichtigsten Knopfs (Standard: die Textfarbe), zum Beispiel `:root { --hub-accent: #5aa9ff; }`. Bei hellen Farben wird die Schrift auf dem Knopf im hellen Design schwer lesbar.', '`--hub-ground`, `--hub-raised-1` bis `-3`, `--hub-ink`, `--hub-ink-2`, `--hub-ink-3`, `--hub-line-1` bis `-3`, `--hub-ok`, `--hub-wait`, `--hub-danger`: die Farben des Hubs, hell und dunkel.'],
  };

  return { groups, errors, manifest, ui };
}

/** Every documented name, e.g. "hub.save.get", "hub.user", "Hub.connect" (for the coverage test). */
const memberNames = (ref) => ref.groups.flatMap((g) => g.members.map((m) => m.name));

module.exports = { sdkReference, memberNames };
