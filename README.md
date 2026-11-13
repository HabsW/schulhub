# SchulHub

Ein Zuhause für kleine Web-Apps und Spiele, die Lehrkräfte und Schüler/innen selbst bauen.
Man lädt einen Ordner hoch (oder baut die App direkt im Browser) – und sie läuft für die ganze
Schule: mit Konten, Speichern, Klassen, Aufgaben und Auswertung, ohne dass jemand ein eigenes
Backend schreibt. Der Hub ist das Backend jeder App.

- **Schüler/innen** melden sich mit dem Microsoft-Schulkonto an und finden auf ihrer Startseite,
  wo sie weitermachen können, ihre Aufgaben mit Termin, Rückmeldungen der Lehrkraft, ihre Klassen,
  Favoriten und Erfolge. Unter **Entdecken** stehen alle Apps, die sie öffnen dürfen. Sie bauen
  eigene Apps (aus Vorlagen, im Editor oder als Ordner) und reichen sie in ihrer Klasse ein.
- **Lehrkräfte** legen Klassen an, lassen per QR-Code beitreten (Beamer-Ansicht), stellen Aufgaben,
  sehen im Überblick, wer wie weit ist, geben private Rückmeldungen, stellen Apps pro Klasse ein,
  prüfen Schüler-Apps an einem Prüfplatz (Vorschau, Änderungen, Prüfbericht) und archivieren Klassen
  am Schuljahresende. Eine zweite Lehrkraft kommt per Einladungslink dazu.
- **Der Admin** hat eine Übersicht mit Speicher und Zustand, verwaltet Konten, Klassen und schulweite
  Apps, liest das Protokoll auf Deutsch, stellt Aufbewahrungsfristen ein und lädt Sicherungen herunter.

Gestaltung: [DESIGN.md](DESIGN.md) · Sicherheit und Datenschutz: [SECURITY.md](SECURITY.md)

## Lokal ausprobieren (ein Befehl)

Voraussetzung: [Node.js](https://nodejs.org) 22.13 oder neuer.

```bash
npm install     # nur beim ersten Mal
npm run dev
```

Dann <http://localhost:3000> öffnen. `npm run demo` macht dasselbe und öffnet den Browser von selbst,
sobald der Hub bereit ist.

`npm run dev` startet den **lokalen Testmodus**: ohne Microsoft, mit Beispieldaten und einer
Anmeldung als Testperson (ein Klick auf der Startseite). Beim ersten Start mit leerer Datenbank:

| Testperson | Rolle | Was man sieht |
|---|---|---|
| Mia Schmidt | Schülerin in „7b Englisch“ | Ankündigung, offene Aufgabe (fällig in 3 Tagen), Rückmeldung von Herrn Lehmann, Fortschritt und Erfolge in vier Apps; besitzt „Pixel-Studio“, das auf die Prüfung wartet |
| Ben Hoffmann | Schüler in „7b Englisch“ | Aufgabe schon erledigt, Ergebnisse und Bestwerte in drei Apps |
| Lena Wagner | Schülerin ohne Klasse | sieht nur die schulweit freigegebenen „Lernkarten“; Beitreten per Link/QR-Code ausprobieren |
| Herr Lehmann | Lehrkraft der 7b | Vokabeltrainer (mit Wortliste), Sternenfänger, Quiz-Werkstatt, Kopfrechnen; Ergebnisse von Mia und Ben; Mias App wartet auf ihn |
| Frau Yilmaz | Lehrkraft ohne Klasse | besitzt „Lernkarten“ (schulweit freigegeben); sieht nichts von der 7b |
| Anna Adler | Admin | Verwaltung, Protokoll, Sicherung |

Der Testmodus ist deutlich markiert (roter Balken auf jeder Seite), lauscht nur auf dem eigenen
Rechner und **verweigert den Start**, wenn `BASE_URL` nicht `localhost` ist oder
`NODE_ENV=production` gesetzt ist. Alle Daten liegen im Ordner `data/` – zum Zurücksetzen einfach
löschen.

Tests (sie versuchen, die Regeln zu brechen – über 100 Angriffstests in `test/`):

```bash
npm test
```

## Was es gibt

### Für alle

- **Start**: persönlich – „Weitermachen“ mit Fortschritt, Aufgaben nach Termin, Rückmeldungen,
  Klassen, Favoriten, Apps aus den eigenen Klassen, Erfolge. Lehrkräfte sehen Zahlen, ihre
  Prüf-Warteschlange und die Aktivität ihrer Klassen.
- **Mitteilungen** (Glocke oben): „deine App wurde freigegeben“, „neue Aufgabe“, „neue Rückmeldung“ …
  nur im Hub, es werden keine E-Mails verschickt.
- **Entdecken** (`/katalog`): alle Apps, die man öffnen darf, mit Filtern nach Fach, Klassenstufe und
  Herkunft. Lehrkräfte fügen Apps dort direkt einer ihrer Klassen hinzu.
- **Suchen** (Lupe oben): Apps und Klassen; Lehrkräfte finden auch die Schüler/innen ihrer Klassen.
- **Darstellung** (Menü am Profilbild): dunkel (Standard), hell oder wie das Gerät, Schriftgröße,
  weniger Bewegung, hoher Kontrast; „In Bestenlisten anonym“. Gilt auf allen Geräten.
- **Was Lehrkräfte sehen** steht auf der Beitrittsseite und unter „Datenschutz“: in den Apps ihrer Klasse
  Namen, Ergebnisse aus der Klasse, Spielstände, Bestwerte, Fortschritt und Erfolge (auch von zu Hause oder
  aus anderen Klassen) und wann/wie oft eine App geöffnet wurde – nie die E-Mail-Adresse.
- **Meine Daten**: alles, was der Hub über dich speichert – ansehen, als JSON herunterladen, die Daten
  einer App oder das ganze Konto löschen. Dateien aus Apps (z. B. Bilder) lädst du bei der App herunter.

### Klassen und Unterricht (Lehrkräfte)

- **Klassen anlegen**: Name, optional Fach und Klassenstufe. Die Klasse bekommt sofort einen
  Beitrittscode (1 Tag gültig).
- **Beitreten lassen**: eine Beamer-Ansicht ohne Navigation – großer QR-Code, Link als Text,
  „gültig bis …“ und eine Live-Zahl, wie viele schon beigetreten sind. Wird der Code anderswo gelöscht
  oder läuft er ab, zeigt die offene Ansicht das innerhalb weniger Sekunden. Schüler/innen bestätigen den
  Beitritt selbst. Lehrkräfte fügen niemanden von Hand hinzu.
- **Klassenseite** mit den Bereichen *Überblick* (wartende Einreichungen zuerst, Zahlen der Woche,
  Ergebnisse pro Woche und ein Raster „Wer ist wie weit?“ – auf dem Handy eine Karte pro Person),
  *Aufgaben*, *Apps* (mit Ergebnissen, Einstellungen, Entfernen und Zurückholen), *Mitglieder*
  (mit Beitrittsdatum, letzter Aktivität und Einladung für eine zweite Lehrkraft) und *Einstellungen*
  (Name, Fach, Stufe, Beitrittscode, Archivieren, Löschen).
- **Aufgaben**: eine App der Klasse, Titel, Notiz, Start und optional ein Termin. Erledigt ist eine
  Aufgabe, sobald nach dem Start ein Ergebnis gespeichert oder voller Fortschritt erreicht ist – oder
  wenn die Person sie selbst als erledigt markiert. Ein Start „jetzt“ oder in der Vergangenheit ist der
  Moment, in dem die Aufgabe gestellt wird – Ergebnisse von davor und aus anderen Klassen zählen nie.
- **Ergebnisse** einer App in einer Klasse: Tabelle (Filter „Nicht begonnen“), Ergebnisse pro Woche,
  Einzelansicht pro Person mit Blättern und lesbaren Feldnamen, CSV-Export. Es zählen die Ergebnisse, die
  in dieser Klasse entstanden sind (und solche von vor der Version 2 ohne Klassenangabe) – nie solche, die
  ganz ohne Klasse entstanden sind, z. B. zu Hause in einer schulweiten App. „Ergebnisse zurücksetzen“
  löscht nur die Ergebnisse aus dieser Klasse; Spielstände, Fortschritt und Erfolge gehören der Schülerin
  oder dem Schüler (löschbar unter „Meine Daten“).
- **Rückmeldungen**: privat an eine Person, bei den Ergebnissen oder bei einer Aufgabe.
- **Geplante Aufgaben**: Eine Aufgabe mit späterem Start sehen Schüler/innen erst ab dem Start (dann auf
  ihrer Startseite, ohne Mitteilung). Rückmeldungen zu einer geplanten Aufgabe sind erst ab dem Start möglich.
- **Einstellungen einer App pro Klasse**: Wenn eine App in `schulhub.json` Einstellungen erklärt
  (z. B. eine Wortliste), zeigt der Hub dafür ein Formular. Die App liest die Werte mit `hub.settings`.
- **Archiv** am Schuljahresende: schreibgeschützt, für Schüler/innen unsichtbar, nach der
  eingestellten Frist (Standard 365 Tage) automatisch gelöscht; bis dahin zurückholbar.
- **Ankündigungen** (`/ankuendigungen`) an die eigenen Klassen; der Admin auch an die ganze Schule.

### Apps prüfen (Lehrkräfte)

**Prüfen** (`/pruefen`) zeigt alle wartenden Apps aus den eigenen Klassen, die älteste zuerst. Der
**Prüfplatz** zeigt links die App live (Breite Handy / Tablet / Voll, Konsole – in der Vorschau wird
nichts gespeichert) und rechts: Was ist neu, den Prüfbericht, die Änderungen seit der zuletzt in
dieser Klasse freigegebenen Version, was die App in `schulhub.json` erklärt und speichert, und den
Verlauf. Unten: **Freigeben** oder **Zurückgeben** mit Begründung, die die Schülerin oder der Schüler
sieht. Danach geht es mit der nächsten wartenden App weiter. Eine freigegebene Version bleibt in der
Klasse, bis die Lehrkraft eine neue freigibt.

### Apps bauen (alle)

| Seite | Was dort ist |
|---|---|
| `/apps` | **Meine Apps** mit Stand (veröffentlicht, Klassen, wartet, zurückgegeben, schulweit) und **Neue App** |
| `/apps/<id>` | Die App: Öffnen, Im Editor bearbeiten, Versionen (genau eine Hauptaktion: die neueste veröffentlichen), Hochladen (Ordner oder ZIP, auch per Ziehen, mit „Was ist neu?“), Klassen, Verlauf, anonyme Nutzung, Einstellungen |
| `/studio/<id>` | Der **Editor** (nur Besitzer/in und Admin): Dateien, Code (CodeMirror) und Vorschau mit Konsole, auf Tablet und Handy umschaltbar. Er arbeitet an einem **Entwurf**; *Als Version speichern* macht daraus eine neue, unveränderliche Version |
| `/entwickeln/vorlagen` | Fünf **Vorlagen** (Leere App, Quiz, Lernkarten, Spiel, Spielwiese) – als neue App im Editor oder als ZIP zum Bauen auf dem eigenen PC |
| `/entwickeln` | Die **Anleitung** in acht Schritten |
| `/entwickeln/sdk` | Die **SDK-Referenz**: jede Funktion mit Parametern, Grenzen, Beispiel, Verhalten in Vorschau und lokal; `schulhub.json` und `hub-ui.css` |
| `/entwickeln/spielwiese` | Die eigene **SDK-Spielwiese**: ein Knopf pro SDK-Funktion |

Nach jedem Upload gibt es einen **Prüfbericht**: Skripte oder Schriften aus dem Internet (blockiert),
absolute Pfade, `Hub.connect()` ohne `hub-sdk.js`, fehlendes `<meta name="viewport">`, Hinweise zu
`localStorage` und großen Dateien, und die Prüfung von `schulhub.json`. Der Bericht liest Dateien nur
als Text – ausgeführt wird auf dem Server nie etwas.

## Eine App bauen

Eine App ist ein Ordner mit Web-Dateien. Oben im Ordner liegt `index.html`. Am schnellsten geht es
mit einer Vorlage (`/entwickeln/vorlagen`, auch als ZIP für den eigenen PC).

```html
<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mein Klickspiel</title>
  <link rel="stylesheet" href="hub-ui.css">
</head>
<body class="hub-ui">
  <main class="hub-page hub-stack">
    <h1 id="hallo"></h1>
    <button class="hub-btn hub-primary" id="klick">Klick mich!</button>
    <p>Klicks: <span id="zahl">0</span></p>
  </main>
  <script src="hub-sdk.js"></script>
  <script src="app.js"></script>
</body>
</html>
```

```js
// app.js
Hub.connect().then(async (hub) => {
  document.getElementById('hallo').textContent = 'Hallo ' + hub.user.name + '!';
  let klicks = await hub.save.get('klicks', 0);            // Spielstand laden
  document.getElementById('zahl').textContent = klicks;
  document.getElementById('klick').onclick = async () => {
    klicks++;
    document.getElementById('zahl').textContent = klicks;
    await hub.save.set('klicks', klicks);                  // im Konto speichern
    await hub.leaderboard.submit('klicks', klicks);        // Bestenliste
    await hub.progress.set(Math.min(1, klicks / 100));     // Fortschritt für Start und Lehrkraft
  };
});
```

`hub-sdk.js` und `hub-ui.css` liefert der Hub selbst – für das Bauen auf dem eigenen PC liegen sie in
jeder Vorlage-ZIP (oder: `sdk/` in diesem Repository). Dieselbe Datei läuft lokal und im Hub: auf dem
eigenen PC (Doppelklick auf `index.html`) gibt es eine Testperson und gespeichert wird im Browser.
Als Lehrkraft lokal testen: `index.html?lehrkraft`.

### Was das SDK kann (Version 2)

`const hub = await Hub.connect()` – die vollständige Referenz steht im Hub unter **Bauen → SDK**.

| Aufruf | Bedeutung |
|---|---|
| `hub.user`, `hub.class`, `hub.mode`, `hub.theme`, `hub.app` | wer (Name und eine pro App andere `id`, keine E-Mail), aus welcher Klasse, `'live'` / `'preview'` (nichts wird dauerhaft gespeichert) / `'local'`, Darstellung, Version |
| `hub.save.get / set / remove / keys` | Spielstand **pro Konto** in dieser App |
| `hub.classData.*`, `hub.shared.*` | Daten für eine Klasse (die Lehrkraft schreibt) und für alle Nutzer der App (schreiben kann nur, wem die App gehört, und nur in Apps von Lehrkräften – in Apps von Schüler/innen sind sie nur lesbar) |
| `hub.leaderboard.submit / top` | Bestenliste der Klasse; Namen sehen nur Personen aus derselben Klasse, alle anderen „Anonym“ |
| `hub.results.add / mine` | Ergebnisse – erscheinen in der Auswertung der Lehrkraft |
| `hub.progress.set(0…1, { label }) / get` | Fortschritt – auf der Startseite und im Klassen-Überblick |
| `hub.achievements.unlock(id) / list` | Erfolge, erklärt in `schulhub.json` |
| `hub.settings.get(key) / all()` | Einstellungen, die die Lehrkraft für ihre Klasse im Hub festlegt (nur lesen) |
| `hub.files.put / get / list / remove` | kleine Dateien pro Person (PNG, JPEG, WebP, GIF, JSON, Text, CSV; 1 MB pro Datei) |
| `hub.room(name)` | Mehrspieler – **vorbereitet, noch nicht eingeschaltet** (antwortet `not_available`) |

`schulhub.json` (optional, oben im Ordner) erklärt, was der Hub für die App zeigt:

```json
{
  "category": "Englisch",
  "grades": [5, 7],
  "achievements": [{ "id": "erste-runde", "title": "Erste Runde", "emoji": "⭐" }],
  "settings": [{ "key": "woerter", "label": "Wörter", "type": "pairs", "columns": ["Deutsch", "Englisch"] }],
  "results": { "labels": { "richtig": "Richtig beantwortet" } }
}
```

### Regeln für Apps

- **Alles muss im Ordner liegen.** Apps können nichts aus dem Internet laden und nichts dorthin
  schicken (keine CDNs, keine Online-Schriften, keine fremden Server).
- **Relative Pfade** verwenden (`bilder/held.png`, nicht `/bilder/held.png`).
- Erlaubte Dateien: HTML, CSS, JS, JSON, Bilder, Töne, Videos, Schriften, WASM, Daten von
  Spiele-Engines. Weitere Endungen kann der Betreiber mit `EXTRA_FILE_EXTENSIONS` freischalten.
- Grenzen: 2000 Dateien, 25 MB pro Datei, 100 MB pro Version, 20 Versionen pro App, 500 MB pro
  Konto; pro Person 2 MB Spielstand und 10 MB Dateien je App.
- Versteckte Dateien (`.git`, `.DS_Store`), `node_modules` und `__MACOSX` werden übersprungen.
- **Keine unsichtbaren Zeichen in Dateinamen.** Namen mit Steuerzeichen für die Schreibrichtung,
  unsichtbaren Verbindern oder ähnlichen Zeichen werden abgelehnt (die Meldung zeigt sie als ⟨U+202E⟩).
  Im Code meldet der Prüfbericht Steuerzeichen für die Schreibrichtung als Fehler; Quelltext-Ansicht
  und Änderungen zeigen sie als rote Platzhalter, damit Code nicht anders aussieht, als er läuft.
- Pro Person werden höchstens 4 Dateien gleichzeitig hochgeladen (der Hub schickt selbst 3 auf
  einmal). „Meine Daten → Alles herunterladen“ läuft pro Person einmal zur Zeit.
- **Browser-Speicher gehört der Person, die die App gerade benutzt.** Was deine App selbst im Browser
  speichert (`localStorage`, IndexedDB …), löscht der Hub, bevor sie für jemand anderen startet. Dafür
  merkt er sich in `localStorage` den Eintrag `schulhub:person` – lösch ihn nicht (`localStorage.clear()`
  löscht ihn mit), sonst räumt der Hub beim nächsten Start alles auf. Was sicher bleiben soll, gehört in
  `hub.save`.
- **Name und Beschreibung von Schüler-Apps** lassen sich nicht ändern, solange die App in einer Klasse
  freigegeben ist, dort auf die Prüfung wartet oder für die ganze Schule freigegeben ist. Zum Ändern die
  Einreichung zurückziehen bzw. die App aus der Klasse nehmen, ändern, wieder einreichen – die Lehrkraft
  prüft dann den neuen Namen mit. Symbol, Farbe, Fach und Klassenstufen bleiben jederzeit änderbar.

### Die Beispiel-Apps

Im Ordner `examples/` – sechs Apps, jede läuft im Hub und lokal per Doppelklick. Jede benutzt das
UI-Kit, funktioniert ab 360 px Breite mit Finger und Tastatur und beachtet „weniger Bewegung“.

| App | Für | Zeigt (SDK) | Die Lehrkraft stellt ein |
|---|---|---|---|
| `vokabeltrainer` | Englisch, Kl. 5–10 | Einstellungen, Spielstand, Fortschritt, Erfolge, Ergebnisse Wort für Wort, Bestenliste | Wortliste (Paare), Abfragerichtung, Wörter pro Runde |
| `quiz-werkstatt` | jedes Fach | Ergebnisse Frage für Frage, „Deine letzten Runden“, Fortschritt, Erfolge | Titel, Fragen (`Frage \| richtig \| falsch \| falsch`), Modus, Reihenfolge |
| `kopfrechnen` | Mathematik, Kl. 2–8 | Bestenliste mit Zeiten, Fortschritt über fünf Stufen, Ergebnisse, Erfolge | Zahlenraum, Rechenarten, Aufgaben pro Sprint |
| `lernkarten` | jedes Fach | Lernkartei mit fünf Fächern, Fortschritt, Ergebnisse, Erfolge | Kartenstapel (Paare), Richtung, Karten pro Runde |
| `sternenfaenger` | Freizeit | Spiel auf einer Leinwand, Bestenliste pro Schwierigkeit, Fortschritt, Erfolge | Schwierigkeit |
| `pixel-studio` | Kunst | drei Leinwände als Spielstände, „Als Bild speichern“ über `hub.files`, Galerie, Erfolge | – |

Lokal per Doppelklick kann der Browser `schulhub.json` nicht lesen; mit
`Hub.connect({ local: { manifest } })` oder einem lokalen Webserver (`python3 -m http.server` im
App-Ordner) ist alles wie im Hub.

## Echter Betrieb

```bash
cp .env.example .env    # Werte eintragen
npm start
```

1. **App-Registrierung in Microsoft Entra**: ein Mandant („Single tenant“), Plattform „Web“,
   Redirect-URI `<BASE_URL>/auth/callback`. Es werden nur `openid`, `profile` und `email` angefragt –
   keine Graph-Berechtigungen, keine Admin-Zustimmung nötig.
2. **`.env` ausfüllen**: Mandant, Client-ID und -Secret, die E-Mail-Domains für Schüler/innen und
   Personal, `ADMIN_EMAILS`, `BASE_URL`, `APPS_DOMAIN`, `SESSION_SECRET`.
3. **Zwei Domains, HTTPS davor**: der Hub (z. B. `hub.meine-schule.de`) und eine **eigene Domain** für
   die Apps (z. B. `meine-schule-apps.de`, mit Wildcard-DNS `*.meine-schule-apps.de` und
   Wildcard-Zertifikat). Die App-Domain darf nicht unter der Domain des Hubs liegen – also nicht
   `apps.meine-schule.de`: Dann könnte jede App Cookies setzen, die der Hub bekommt, und Browser
   aussperren. Mit so einer Adresse startet der Hub nicht. `BASE_URL` beginnt immer mit `https://`.
   Beide zeigen über einen Reverse-Proxy (Caddy, nginx …) auf denselben Node-Prozess; der Proxy muss den
   `Host`-Header unverändert durchreichen und beim Hochladen die Größenangabe (`Content-Length`) – nginx
   und Caddy tun das von sich aus. `TRUST_PROXY=1` setzen. Der Proxy soll außerdem Anfrage-Fluten begrenzen.
4. Ohne vollständige und sichere Konfiguration startet der Hub nicht und sagt, was zu ändern ist.

Gemeinsam genutzte PCs: Bevor eine App für eine andere Person startet, löscht der Hub, was die App im
Browser für die vorige Person gespeichert hat (Spielstände, Einstellungen, Cookies). Für dieselbe Person
bleibt alles erhalten. Wo sich viele einen PC teilen, nutzt trotzdem den Gastmodus des Browsers oder lasst
die Browserdaten beim Schließen löschen.

Rollen: Wer sich zum ersten Mal anmeldet, bekommt die Rolle aus der E-Mail-Domain. Adressen anderer
Domains werden abgewiesen. Der Admin kann Rollen in der Verwaltung ändern.

Eine bestehende Datenbank wird beim Start automatisch auf das aktuelle Schema gehoben
(`PRAGMA user_version`, ohne Datenverlust).

**Server und Kapazität:** Getestet mit einer Schule aus 1.000 Schüler/innen, 100 Lehrkräften, 48 Klassen
und 90 Tagen Nutzung – beim Dreifachen der erwarteten Spitze ohne Fehler und ohne verlorene Daten. Was
gemessen wurde, wo die Grenze liegt und was der Server braucht (2 vCPU, 1–2 GB RAM, lokale SSD – kein
Netzlaufwerk für `data/`, ein Reverse-Proxy ohne Anfragegrenzen pro Adresse, ein Dienst, der den Hub
neu startet): [CAPACITY.md](CAPACITY.md). Die Messwerkzeuge liegen in `scripts/scale/`.

### Sicherung

**Verwaltung → Sicherung → „Sicherung herunterladen“** erzeugt eine ZIP-Datei mit allem, was der Hub
gespeichert hat: die Datenbank (`hub.sqlite`, eine in sich stimmige Kopie), alle App-Dateien
(`blobs/`) und alle Dateien, die Apps für Personen gespeichert haben (`userfiles/`). Der Hub läuft
dabei weiter. Geheimnisse (`.env`, `SESSION_SECRET`) sind **nicht** enthalten – sichere sie getrennt.

- Die Sicherung enthält **alle personenbezogenen Daten**. Bewahre sie verschlüsselt auf und nur dort,
  wo ausschließlich Befugte Zugriff haben. Lösche alte Sicherungen nach den Vorgaben der Schule.
- Empfehlung: jede Woche eine Sicherung; die Übersicht erinnert, wenn die letzte älter als 7 Tage ist.
- Über den Browser sind Sicherungen bis etwa 3,5 GB und 65 000 Dateien möglich. Bei mehr: Hub stoppen
  und den Ordner `data/` direkt auf dem Server kopieren.

### Wiederherstellen

Nur auf dem Server, über die Kommandozeile – im Browser lässt sich nichts zurückspielen.

```bash
# 1. Hub stoppen
# 2. Sicherung einspielen
npm run restore -- schulhub-sicherung-2026-11-12-2030.zip
#    Datenordner nicht leer?  ... --force   (alte Daten nach data/vor-wiederherstellung-…, nicht gelöscht)
#    anderer Datenordner?     ... --data /pfad/zum/ordner
# 3. Hub starten – alle melden sich neu an
```

Fehlt die Datenbank `data/hub.sqlite` (oder ist sie leer), während im Datenordner schon Dateien liegen,
**startet der Hub nicht** und sagt, was zu tun ist – statt eine leere Schule neben den alten Dateien
anzulegen. Nie eine ältere oder fremde `hub.sqlite` von Hand hineinlegen – wiederherstellen nur mit
`npm run restore`: Der Hub räumt beim Start Dateien weg, die seine Datenbank nicht kennt und die älter als
eine Stunde sind; mit der falschen Datenbank wären das die Dateien der Schule.

Das Werkzeug prüft das Archiv **vollständig, bevor es etwas schreibt**: nur erlaubte Dateinamen, keine
Verknüpfungen, begrenzte Größen, genug freier Platz, die Prüfsumme jeder App-Datei und eine gültige
SchulHub-Datenbank. Erst dann werden die Daten an ihren Platz gelegt. Aus dem Archiv wird nie etwas
ausgeführt.

### Aufbewahrung

Unter **Verwaltung → Aufbewahrung** (innerhalb fester Grenzen):

| Was | Standard | Erlaubt |
|---|---|---|
| Protokoll aufbewahren | 365 Tage | 30–3650 |
| Archivierte Klassen löschen nach | 365 Tagen (ab dem Archivieren) | 30–3650 |
| Inaktive Konten markieren nach | 456 Tagen ohne Anmeldung (≈ 15 Monate) | 90–3650 |

Fest: Mitteilungen im Hub 180 Tage, abgelaufene Ankündigungen 30 Tage nach Ablauf, anonyme
Nutzungszahlen 400 Tage, Anmeldung 8 Stunden. Die Prüfung läuft beim Start und dann täglich.
**Konten werden nie automatisch gelöscht** – markierte Konten erscheinen in der Verwaltung, und der
Admin entscheidet.

## Aufbau

```
src/server.js        Start (dev / echt)
src/app.js           ein HTTP-Server für zwei Arten von Hosts: Hub und App-Ursprünge; Fehlerseiten
src/access.js        ALLE Berechtigungsfragen an einer Stelle
src/db.js            Schema und Migrationen (PRAGMA user_version)
src/auth.js          Microsoft-Anmeldung (MSAL), Rollen aus der Konfiguration
src/security.js      Tokens, CSRF, Rate-Limits, Sicherheits-Header
src/html.js          HTML mit automatischem Escaping, Seitenrahmen, Bausteine des Design-Systems
src/icons.js         Symbole (Lucide-Auswahl, erzeugt)
src/uploads.js       Prüfung und Ablage hochgeladener Dateien, ZIP, Editor-Entwürfe
src/checks.js        Prüfbericht nach dem Hochladen (liest Dateien nur als Text)
src/manifest.js      schulhub.json: Erfolge, Einstellungen, Beschriftungen
src/appsHost.js      statische App-Dateien + Daten-API hinter dem SDK
src/sdkStore.js      Speicher hinter dem SDK: echt oder (Vorschau) nur im Arbeitsspeicher
src/userFiles.js     Dateien, die Apps für Personen speichern (hub.files)
src/classApps.js     das Leben einer App in einer Klasse: einreichen, freigeben, zurückgeben …
src/assignments.js   Aufgaben: erledigt / begonnen / offen
src/services.js      Vorgänge über mehrere Tabellen, Protokoll, Mitteilungen, Aufbewahrung
src/settings.js      Einstellungen der Verwaltung (Fristen)
src/backup.js        Sicherung und Wiederherstellung
src/routes/          Seiten: Start, Klassen, Unterricht, Ergebnisse, Apps, Prüfen, Player,
                     Editor, Anleitung, Suche/Entdecken/Darstellung, Meine Daten, Verwaltung
sdk/hub-sdk.js       das SDK (eine Datei, ohne Abhängigkeiten)
sdk/hub-ui.css       das UI-Kit für Apps
public/              hub.css (Design-System), Seiten-CSS in public/css/, Skripte, Schriften, vendor/
templates/           Vorlagen für neue Apps
examples/            sechs Beispiel-Apps
scripts/             restore.js; vendor/ (Bau von CodeMirror und Symbolen, nur für Maintainer);
                     demo-paket/ (Demo-ZIP mit Startdateien für Mac und Windows bauen)
test/                Tests, die die Regeln zu brechen versuchen
licenses/            Lizenzen der eingebundenen Schriften und Symbole
```

## Abhängigkeiten und Open Source

Sechs npm-Pakete: `express`, `express-session`, `@azure/msal-node`, `yauzl` (ZIP lesen),
`qrcode-generator` und **`diff`** 9.0.0 (BSD-3-Clause, nur auf dem Server): berechnet für den
Prüfplatz, welche Zeilen sich zwischen zwei Versionen geändert haben (Myers-Algorithmus mit Grenzen
für Aufwand und Zeit). Ein eigener Vergleich wäre mehr selbst geschriebener Code an einer
sicherheitsrelevanten Stelle. Datenbank ist das in Node eingebaute SQLite.

Im Repository mitgeliefert (selbst gehostet, keine Anfrage an fremde Server, CSP-tauglich):

| Was | Lizenz | Warum | Wo |
|---|---|---|---|
| **CodeMirror 6** | MIT | ein echter Code-Editor (Zeilennummern, Suchen, Vervollständigen, Rückgängig, Handy-Tastatur) für den Editor im Browser – selbst gebaut wäre das ein eigenes Projekt | `public/vendor/codemirror.js` (eine fertige Datei, globales `HubEditor`), Lizenzen in `public/vendor/codemirror.LICENSE.txt` |
| **Atkinson Hyperlegible Next und Mono** | SIL OFL 1.1 | vom Braille Institute für Lesbarkeit entworfen (I l 1 und O 0 sind verschieden) – passend für junge Leser/innen und billige Bildschirme; zusammen etwa 80 KB | `public/fonts/`, `licenses/` |
| **Lucide** (Auswahl von ~90 Symbolen) | ISC | ein einheitlicher Satz Symbole; auf dem Server als SVG eingefügt | `src/icons.js`, `licenses/lucide-ISC.txt` |

Die App selbst braucht **keinen Build-Schritt**. Nur wer CodeMirror oder die Symbole aktualisiert,
baut sie neu (Maintainer):

```bash
cd scripts/vendor
npm ci
node build-codemirror.mjs   # schreibt public/vendor/codemirror.js und codemirror.LICENSE.txt
node build-icons.mjs        # schreibt src/icons.js und licenses/lucide-ISC.txt
```

Details und geprüfte Punkte: `scripts/vendor/README.md`.

## Für später vorbereitet

- **Python im Browser**: Apps haben eine Spalte `kind` (heute `web`); Python wäre eine weitere Art
  mit einem vom Hub gelieferten Starter auf dem App-Ursprung.
- **Abgleich mit Microsoft Teams**: Klassen haben `source` und `external_id`.
- **Mehrspieler und Echtzeit**: `hub.room()` im SDK, die Berechtigung (`access.canJoinRoom`, mit
  Einwilligung der Lehrkraft pro Klasse und App) und die Spalte dafür gibt es; der Transport fehlt
  bewusst noch. Die offenen Fragen stehen in [SECURITY.md](SECURITY.md).

## Entwicklung

- Gestaltung und Bausteine: [DESIGN.md](DESIGN.md). Seiten-CSS gehört nach `public/css/<bereich>.css`.
- Demo zum Weitergeben: `scripts/demo-paket/build.sh <zielordner>` baut `SchulHub-Demo.zip` aus dem
  letzten Commit – mit allen npm-Paketen (kein `npm install` nötig) und Startdateien für Windows
  (`Start-Windows.cmd`) und Mac (`Start-Mac.command`, oder im Terminal `npm run demo`).
- Jede neue Funktion braucht eine Prüfung auf dem Server (`src/access.js`), einen Angriffstest in
  `test/` und einen Eintrag in [SECURITY.md](SECURITY.md).
- `test/access-model.test.js` vergleicht jede Funktion von `src/access.js` in zufälligen Welten mit
  einem eigenen Modell der Regeln, auch über die echten Seiten. Eine neue Funktion in `access.js`
  braucht dort ihre Regel im Modell. Andere Welten: `ACCESS_SEED=<Zahl> ACCESS_WORLDS=<Anzahl> node
  --test test/access-model.test.js`.
- Git: `main` ist der Stand vor dem Umbau, `redesign` der Umbau mit einem Commit pro Etappe.
