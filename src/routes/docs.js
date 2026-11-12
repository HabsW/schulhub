'use strict';
// "Selbst bauen": the in-app guide for people who make apps.

const { html, page } = require('../html');

const QUICKSTART = `<!doctype html>
<html lang="de">
<head><meta charset="utf-8"><title>Mein Klickspiel</title></head>
<body>
  <h1 id="hallo"></h1>
  <button id="klick">Klick mich!</button>
  <p>Klicks: <span id="zahl">0</span></p>

  <script src="hub-sdk.js"></script>
  <script>
    Hub.connect().then(async (hub) => {
      document.getElementById('hallo').textContent = 'Hallo ' + hub.user.name + '!';

      // Spielstand laden (beim ersten Mal: 0)
      let klicks = await hub.save.get('klicks', 0);
      document.getElementById('zahl').textContent = klicks;

      document.getElementById('klick').onclick = async () => {
        klicks++;
        document.getElementById('zahl').textContent = klicks;
        await hub.save.set('klicks', klicks);              // im Konto speichern
        await hub.leaderboard.submit('klicks', klicks);    // Bestenliste
      };
    });
  </script>
</body>
</html>`;

const API = [
  ['hub.user', '{ id, name, isTeacher, isOwner } – wer gerade spielt. Die id ist in jeder App eine andere.'],
  ['hub.class', '{ id, name } der Klasse, aus der die App geöffnet wurde, oder null.'],
  ['hub.mode', "'live', 'preview' (private Vorschau) oder 'local' (auf deinem PC)."],
  ['hub.save.get(key, fallback)', 'Spielstand lesen – nur für diese Person in dieser App.'],
  ['hub.save.set(key, value)', 'Spielstand speichern. value ist alles, was JSON kann: Zahlen, Texte, Listen, Objekte.'],
  ['hub.save.remove(key) / hub.save.keys()', 'Löschen bzw. alle Schlüssel auflisten.'],
  ['hub.classData.get / set / remove / keys', 'Daten für eine Klasse, z. B. eine Wortliste. Alle in der Klasse lesen, nur die Lehrkraft schreibt.'],
  ['hub.shared.get / set / remove / keys', 'Daten für alle, die die App nutzen, z. B. Level. Alle lesen, nur du als Besitzer/in schreibst.'],
  ['hub.leaderboard.submit(board, score, { lowerIsBetter })', 'Punktzahl melden. Es zählt der beste Wert pro Person.'],
  ['hub.leaderboard.top(board, { limit, scope })', "Bestenliste: { entries: [{ rank, name, score, me }] }. scope: 'class' (Standard in einer Klasse) oder 'all'."],
  ['hub.results.add({ title, score, maxScore, details })', 'Ein Ergebnis festhalten. Die Lehrkraft sieht es in der Auswertung – ohne dass du dafür etwas bauen musst.'],
  ['hub.results.mine({ limit })', 'Die eigenen letzten Ergebnisse.'],
];

module.exports = (app, ctx) => {
  const { config } = ctx;
  const mb = (n) => Math.round(n / 1048576);

  app.get('/entwickeln', (req, res) => {
    const L = config.limits;
    const body = html`<section class="narrow prose"><h1>Selbst bauen</h1>
    <p class="lead">Jede Webseite in einem Ordner kann eine App im ${config.hubName} werden: ein Quiz, ein Spiel, ein Lernprogramm.
    Du brauchst keinen eigenen Server – Konten, Speichern, Klassen und Bestenlisten erledigt der Hub.</p>

    <h2>In fünf Schritten</h2>
    <ol><li>Lege auf deinem PC einen Ordner an, mit einer Datei <code>index.html</code> ganz oben.</li>
    <li>Lade das SDK herunter und lege es als <code>hub-sdk.js</code> in denselben Ordner:<br><a class="btn" href="/sdk/hub-sdk.js">hub-sdk.js herunterladen</a></li>
    <li>Baue und teste auf deinem PC. Dort läuft alles mit einer Testperson, gespeichert wird nur in deinem Browser.</li>
    <li>Lege unter <a href="/apps">Meine Apps</a> eine App an und lade den Ordner (oder eine ZIP-Datei davon) hoch.</li>
    <li>Probiere die private <strong>Vorschau</strong> aus, klicke dann auf <strong>Veröffentlichen</strong> und bringe die App in deine Klasse ein. Deine Lehrkraft gibt sie frei.</li></ol>

    <h2>Ein vollständiges Beispiel</h2>
    <pre class="code">${QUICKSTART}</pre>
    <p>Dieselbe Datei funktioniert auf deinem PC und im Hub – du musst nichts umschreiben.</p>

    <h2>Was das SDK kann</h2>
    <p>Mit <code>const hub = await Hub.connect()</code> bekommst du:</p>
    <div class="scroll"><table class="data"><tbody>${API.map(([name, text]) => html`<tr><td><code>${name}</code></td><td>${text}</td></tr>`)}</tbody></table></div>
    <p>Alle Funktionen außer <code>hub.user</code>, <code>hub.class</code> und <code>hub.mode</code> geben ein Promise zurück – benutze <code>await</code>.</p>

    <h2>Lokal testen</h2>
    <ul><li>Öffne <code>index.html</code> per Doppelklick oder mit einem lokalen Webserver.</li>
    <li>Als Lehrkraft testen: <code>index.html?lehrkraft</code> an die Adresse anhängen.</li>
    <li>In der Konsole steht „Lokaler Modus“, solange du nicht im Hub bist.</li></ul>

    <h2>Regeln für Apps</h2>
    <ul><li><strong>Alles muss im Ordner liegen.</strong> Apps können nichts aus dem Internet nachladen (keine CDNs, keine Online-Schriften, keine fremden Server). Lade Bibliotheken herunter und lege sie mit in den Ordner.</li>
    <li><strong>Benutze relative Pfade</strong>, also <code>bilder/held.png</code> statt <code>/bilder/held.png</code>.</li>
    <li>Erlaubt sind Web-Dateien: HTML, CSS, JavaScript, Bilder, Töne, Videos, Schriften, JSON, WASM und Daten von Spiele-Engines.</li>
    <li>Höchstens ${L.maxFiles} Dateien, ${mb(L.maxFileBytes)} MB pro Datei und ${mb(L.maxVersionBytes)} MB pro Version.</li>
    <li>Pro Person kann eine App ${mb(L.saveTotalBytes)} MB speichern.</li>
    <li>Spiele-Engines funktionieren, wenn sie ins Web exportieren (z. B. Godot ohne Threads, Phaser, p5.js, Scratch-Export als HTML, Unity WebGL).</li></ul>

    <h2>Gut zu wissen</h2>
    <ul><li>Lehrkräfte können den Quelltext deiner App ansehen, bevor sie sie freigeben.</li>
    <li>Wenn du eine neue Version veröffentlichst, nutzt die Klasse weiter die freigegebene Version, bis die Lehrkraft die neue freigibt.</li>
    <li>Bestenlisten zählen, was die App meldet. Sie sind zum Spaß da, nicht für Noten.</li></ul>
    </section>`;
    res.send(page(req, { title: 'Selbst bauen', body, active: 'entwickeln' }));
  });
};
