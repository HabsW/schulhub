# SchulHub

Ein Zuhause für kleine Web-Apps und Spiele, die Lehrkräfte und Schüler/innen selbst bauen.
Man lädt einen Ordner hoch – und die App läuft für die ganze Schule: mit Konten, Speichern,
Klassen und Auswertung für Lehrkräfte, ohne dass jemand ein eigenes Backend schreibt.

- **Schüler/innen** melden sich einmal mit dem Microsoft-Schulkonto an und finden ihre Klassen,
  die Apps dazu und ihren Fortschritt in jeder App. Sie können eigene Apps bauen und hochladen.
- **Lehrkräfte** legen Klassen an, lassen per QR-Code beitreten, weisen Apps zu, sehen die
  Ergebnisse ihrer Schüler/innen in jeder App und prüfen Schüler-Apps (Vorschau, Quelltext,
  Kommentare, Download), bevor sie sie für die Klasse freigeben.
- **Admin** verwaltet Konten und Rollen, sieht alle Klassen und Apps und das Protokoll.

## Lokal ausprobieren (ein Befehl)

Voraussetzung: [Node.js](https://nodejs.org) 22.13 oder neuer.

```bash
npm install     # nur beim ersten Mal
npm run dev
```

Dann <http://localhost:3000> öffnen.

`npm run dev` startet den **lokalen Testmodus**: ohne Microsoft, mit Beispieldaten und einer
Anmeldung als Testperson (ein Klick auf der Startseite). Zum Ausprobieren gibt es:

| Testperson | Rolle | Was man sieht |
|---|---|---|
| Mia Schmidt, Ben Hoffmann | Schüler/in in „7b Englisch“ | Klassen, Apps, eigener Fortschritt; Mia besitzt die App „Pixel-Studio“ |
| Lena Wagner | Schülerin ohne Klasse | Beitreten per Link/QR-Code ausprobieren |
| Herr Lehmann | Lehrkraft von „7b Englisch“ | Klasse, QR-Code, Ergebnisse, eine Schüler-App wartet auf Freigabe |
| Frau Yilmaz | Lehrkraft ohne Klasse | Sieht nichts von der 7b |
| Anna Adler | Admin | Verwaltung und Protokoll |

Der Testmodus ist deutlich markiert (roter Balken auf jeder Seite), lauscht nur auf dem eigenen
Rechner und **verweigert den Start**, wenn `BASE_URL` nicht `localhost` ist oder
`NODE_ENV=production` gesetzt ist. Alle Daten liegen im Ordner `data/` – zum Zurücksetzen
einfach löschen.

Tests (sie versuchen, die Regeln zu brechen):

```bash
npm test
```

## Eine App bauen und hochladen

Eine App ist ein Ordner mit Web-Dateien. Oben im Ordner liegt `index.html`.
Die ausführliche Anleitung steht auch im Hub unter **Selbst bauen**.

1. Ordner anlegen, `index.html` hinein.
2. `sdk/hub-sdk.js` in den Ordner kopieren (oder im Hub unter „Selbst bauen“ herunterladen).
3. Bauen und testen – direkt auf dem eigenen PC:

```html
<!doctype html>
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
      let klicks = await hub.save.get('klicks', 0);            // Spielstand laden
      document.getElementById('zahl').textContent = klicks;
      document.getElementById('klick').onclick = async () => {
        klicks++;
        document.getElementById('zahl').textContent = klicks;
        await hub.save.set('klicks', klicks);                  // im Konto speichern
        await hub.leaderboard.submit('klicks', klicks);        // Bestenliste
      };
    });
  </script>
</body>
</html>
```

4. Im Hub: **Meine Apps → Neue App anlegen**, dann **Ordner auswählen** (oder eine ZIP-Datei).
5. **Vorschau** öffnen (privat, nur für dich), dann **Veröffentlichen**.
6. Die App in eine Klasse einbringen. Lehrkräfte fügen eigene Apps direkt hinzu;
   Apps von Schüler/innen prüft die Lehrkraft und gibt sie frei.

### Dieselbe Datei läuft lokal und im Hub

`hub-sdk.js` merkt selbst, wo es läuft. Auf dem eigenen PC (Doppelklick auf `index.html` oder
ein lokaler Webserver) gibt es eine Testperson, und gespeichert wird im Browser. Im Hub sind es
echte Konten. Am Code der App ändert sich nichts. Als Lehrkraft lokal testen: `index.html?lehrkraft`.

### Was das SDK kann

`const hub = await Hub.connect()`

| Aufruf | Bedeutung |
|---|---|
| `hub.user` | `{ id, name, isTeacher, isOwner }` – die `id` ist in jeder App eine andere, E-Mail gibt es nicht |
| `hub.class` | `{ id, name }` der Klasse, aus der die App geöffnet wurde, oder `null` |
| `hub.mode` | `'live'`, `'preview'` oder `'local'`. In der Vorschau wird nichts dauerhaft gespeichert. |
| `hub.save.get(key, fallback)` / `set(key, value)` / `remove(key)` / `keys()` | Spielstand **pro Konto** in dieser App |
| `hub.classData.get / set / remove / keys` | Daten **für eine Klasse** (z. B. Wortliste): alle lesen, die Lehrkraft schreibt |
| `hub.shared.get / set / remove / keys` | Daten **für alle Nutzer der App** (z. B. Level): alle lesen, Besitzer/in schreibt |
| `hub.leaderboard.submit(board, score, { lowerIsBetter })` | Punktzahl melden, der beste Wert zählt |
| `hub.leaderboard.top(board, { limit, scope })` | Bestenliste der Klasse (`scope: 'all'` für alle). Namen sieht nur, wer mit der Person in einer Klasse ist; alle anderen sehen „Anonym“. |
| `hub.results.add({ title, score, maxScore, details })` | Ergebnis festhalten – erscheint in der Auswertung der Lehrkraft |
| `hub.results.mine({ limit })` | eigene letzte Ergebnisse |

Werte sind alles, was JSON kann. Schlüssel: Buchstaben, Ziffern, `_ . : -`, höchstens 64 Zeichen.

### Regeln für Apps

- **Alles muss im Ordner liegen.** Apps können nichts aus dem Internet laden und nichts
  dorthin schicken (keine CDNs, keine Online-Schriften, keine fremden Server).
- **Relative Pfade** verwenden (`bilder/held.png`, nicht `/bilder/held.png`).
- Erlaubte Dateien: HTML, CSS, JS, JSON, Bilder, Töne, Videos, Schriften, WASM, Daten von
  Spiele-Engines. Weitere Endungen kann der Betreiber mit `EXTRA_FILE_EXTENSIONS` freischalten.
- Grenzen: 2000 Dateien, 25 MB pro Datei, 100 MB pro Version, 20 Versionen pro App,
  500 MB pro Konto; pro Person 2 MB Spielstand je App.
- Versteckte Dateien (`.git`, `.DS_Store`), `node_modules` und `__MACOSX` werden übersprungen.

### Die Beispiel-Apps

Im Ordner `examples/` – jede läuft auch lokal per Doppelklick auf `index.html`.

| App | Zeigt |
|---|---|
| `vokabeltrainer` | Wortliste pro Klasse (die Lehrkraft bearbeitet sie in der App), Fortschritt pro Konto, Ergebnisse Wort für Wort für die Lehrkraft, Bestenliste |
| `sternenfaenger` | Ein kleines Spiel mit Bestenliste und gespeichertem Rekord |
| `pixel-studio` | Mehrere Spielstände pro Konto (drei Bilder), automatisches Speichern |

## Echter Betrieb

```bash
cp .env.example .env    # Werte eintragen
npm start
```

1. **App-Registrierung in Microsoft Entra** (wie im Login-Beispiel): ein Mandant („Single tenant“),
   Plattform „Web“, Redirect-URI `<BASE_URL>/auth/callback`. Es werden nur `openid`, `profile`
   und `email` angefragt – keine Graph-Berechtigungen, keine Admin-Zustimmung nötig.
2. **`.env` ausfüllen**: Mandant, Client-ID und -Secret, die E-Mail-Domains für Schüler/innen
   und Personal, `ADMIN_EMAILS`, `BASE_URL`, `APPS_DOMAIN`, `SESSION_SECRET`.
3. **Zwei Adressen, HTTPS davor**: der Hub (z. B. `hub.schule.de`) und eine Wildcard-Domain
   für die Apps (z. B. `*.apps.schule.de`, mit Wildcard-Zertifikat). Beide zeigen über einen
   Reverse-Proxy (Caddy, nginx …) auf denselben Node-Prozess; der Proxy muss den `Host`-Header
   unverändert durchreichen. `TRUST_PROXY=1` setzen.
4. Ohne vollständige Konfiguration startet der Hub nicht und sagt, was fehlt.

Rollen: Wer sich zum ersten Mal anmeldet, bekommt die Rolle aus der E-Mail-Domain. Adressen
anderer Domains werden abgewiesen. Der Admin kann Rollen in der Verwaltung ändern.

## Aufbau

```
src/server.js      Start (dev / echt)
src/app.js         ein HTTP-Server für zwei Arten von Hosts: Hub und App-Ursprünge
src/access.js      ALLE Berechtigungsfragen an einer Stelle
src/auth.js        Microsoft-Anmeldung (MSAL), Rollen aus der Konfiguration
src/security.js    Tokens, CSRF, Rate-Limits, Sicherheits-Header
src/uploads.js     Prüfung und Ablage hochgeladener Dateien, ZIP
src/appsHost.js    statische App-Dateien + Daten-API hinter dem SDK
src/services.js    Vorgänge über mehrere Tabellen, Protokoll
src/routes/        Seiten: Start, Klassen, Apps, Ergebnisse, Meine Daten, Verwaltung
src/html.js        HTML mit automatischem Escaping
sdk/hub-sdk.js     das SDK (eine Datei, ohne Abhängigkeiten)
public/            CSS und die wenigen Skripte des Hubs
examples/          drei Beispiel-Apps
test/              Tests, die die Regeln zu brechen versuchen
```

Fünf Abhängigkeiten: `express`, `express-session`, `@azure/msal-node`, `yauzl` (ZIP lesen),
`qrcode-generator`. Datenbank ist das in Node eingebaute SQLite.

**Für später vorbereitet:** Apps haben eine Spalte `kind` (heute `web`; Python im Browser wäre
eine weitere Art mit eigenem Starter). Klassen haben `source` und `external_id` für einen
Abgleich mit Microsoft Teams. Das SDK spricht über eine einzige Aufruf-Funktion mit dem Hub –
Echtzeit-Funktionen können dort einen zweiten Transport bekommen, ohne dass Apps sich ändern.

Sicherheit: siehe [SECURITY.md](SECURITY.md).
