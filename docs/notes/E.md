# Package E – Beispiel-Apps und Demo-Daten

## SECURITY.md

| Bedrohung | Umgang |
|---|---|
| Eine Beispiel-App lädt Code oder Schriften von fremden Servern oder schickt Daten dorthin | Alle Dateien liegen im Ordner, nur relative Pfade. Ein Test durchsucht jede Datei der Beispiele: keine Internet-Adresse (auch nicht in Kommentaren), keine protokoll-relativen Adressen, keine absoluten Pfade in `src`/`href`/`url()`, kein `@import`, keine eigenen Netzwerkzugriffe (`fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon`, `import()`) – Apps reden nur über das SDK mit dem Hub. Im Hub verbietet zusätzlich die CSP der App-Ursprünge jeden fremden Host. |
| Daten aus dem Netz (Wortlisten, Quizfragen und Karten der Lehrkraft, Namen in Bestenlisten, gespeicherte Spielstände) werden zu Code oder Markup | Die Beispiele setzen Text nur über `textContent`/`append(string)`. Der Test verbietet `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `DOMParser`, `eval`, `Function()`, `setTimeout("…")`, `javascript:`-Adressen, `setAttribute('style'|'on…'|'src'|'href')`, Inline-Skripte, `on…=`-Attribute und `style=`-Attribute im HTML. Spielstände und Einstellungen werden beim Lesen geprüft (z. B. nur gültige Wortpaare, nur bekannte Farben im Pixel-Studio). |
| Ein Beispiel umgeht die Upload-Prüfung oder hat ein fehlerhaftes Manifest | Jeder Beispielordner wird im Test durch die echte Prüfung geschickt (`services.createApp` → `createVersion` → `uploads.addDirectory` → `finishVersion`); der Bericht darf weder Fehler noch Warnungen enthalten, das gespeicherte Manifest muss genau `parseManifest(schulhub.json)` sein. Die Demo-Daten laden die Beispiele auf demselben Weg hoch. |
| Veraltete SDK-Kopien in den Beispielen | Der Test vergleicht `hub-sdk.js` und `hub-ui.css` jedes Beispiels Byte für Byte mit `sdk/`. (Im Hub liefert der Hub ohnehin seine eigene Fassung aus.) |
| Demo-Daten unterlaufen die Rechte (z. B. Daten sichtbar für Personen außerhalb der Klasse) | Die Demo-Daten werden nur mit `--dev` und nur auf leerer Datenbank angelegt. Zustandswechsel laufen über `classApps.add/submit`, `services.createClass/createJoinCode/notify/audit`; Klassen-Einstellungen werden vor dem Speichern mit `validateSettings` gegen die `schulhub.json` geprüft. Alle Ergebnisse tragen die `class_id` der 7b. Tests prüfen mit den Demo-Daten: Lena (ohne Klasse) bekommt 404 für die 7b, ihre Ergebnisse, Mias App, die Aufgabe und Apps der 7b und kein SDK-Token; Frau Yilmaz sieht die 7b nicht; Ben kann Mias wartende App nicht öffnen; die schulweite Freigabe ist für Lena spielbar (ohne Klasse, mit Standardstapel) und ihre Daten bleiben ihre. |
| Vorschau speichert echte Daten | Die Beispiele zeigen `hub.mode === 'preview'` ehrlich an („Vorschau – nichts wird gespeichert.“); gespeichert wird in der Vorschau ohnehin nur im Speicher des Hubs (sdkStore). |

Tests (`test/examples.test.js`):
- Beispiel-Apps: alle sechs da, jede mit Pflichtdateien und den aktuellen Kopien von SDK und UI-Kit
- Beispiel-Apps: schulhub.json ohne Fehler und ohne Warnungen
- Beispiel-Apps: ruhen nur auf sich selbst – keine absoluten Pfade, keine fremden Adressen, kein eval, kein innerHTML
- Beispiel-Apps: laufen durch die echte Upload-Prüfung (createApp, createVersion, addDirectory, finishVersion)
- Demo-Daten: nur auf leerer Datenbank, alles über die normale Prüfung, Zustände wie beschrieben
- Demo-Daten: Lena (ohne Klasse) kommt weder an die 7b noch an ihre Ergebnisse noch an Mias App
- Demo-Daten: die schulweite Freigabe ist für Lena spielbar – ohne Klasse, mit dem Standardstapel
- Demo-Daten: die Klasseneinstellungen sind gültig und kommen in der App an, die Daten der Klasse sind sichtbar

## README.md

### Die Beispiel-Apps

Im Ordner `examples/` – sechs Apps, jede läuft im Hub und auch lokal per Doppelklick auf `index.html`
(dann mit einer Testperson, gespeichert wird im Browser). Jede benutzt das UI-Kit (`hub-ui.css`),
funktioniert ab 360 px Breite mit Finger und Tastatur und beachtet „weniger Bewegung“.

| App | Für | Zeigt (SDK) | Die Lehrkraft stellt ein |
|---|---|---|---|
| `vokabeltrainer` | Englisch, Kl. 5–10 | Einstellungen, Spielstand, Fortschritt (gelernte Wörter), Erfolge, Ergebnisse Wort für Wort, Bestenliste | Wortliste (Paare), Abfragerichtung, Wörter pro Runde |
| `quiz-werkstatt` | jedes Fach | Einstellungen, Ergebnisse Frage für Frage, `results.mine` („Deine letzten Runden“), Fortschritt (bestes Ergebnis), Erfolge – einer geheim | Titel, Fragen (`Frage \| richtig \| falsch \| falsch`; ohne falsche Antworten wird eingetippt), Modus, Reihenfolge |
| `kopfrechnen` | Mathematik, Kl. 2–8 | Bestenliste mit Zeiten (`lowerIsBetter`), Fortschritt über fünf Stufen, Ergebnisse Aufgabe für Aufgabe, Erfolge | Zahlenraum, Rechenarten, Aufgaben pro Sprint |
| `lernkarten` | jedes Fach | Lernkartei mit fünf Fächern (Leitner), Spielstand pro Karte, Fortschritt (Karten im letzten Fach), Ergebnisse, Erfolge – einer geheim | Kartenstapel (Paare), Richtung, Karten pro Runde |
| `sternenfaenger` | Freizeit | Spiel auf einer Leinwand: Bestenliste pro Schwierigkeit, Rekord, Fortschritt (Level), Erfolge – einer geheim | Schwierigkeit |
| `pixel-studio` | Kunst | drei Leinwände als Spielstände, „Als Bild speichern“ als PNG über `hub.files` und eine Galerie daraus, Erfolge | – |

Was die Lehrkraft einstellt, steht in der `schulhub.json` der App unter `settings`; der Hub zeigt
dafür ein Formular (Klasse → App → Einstellungen). Ohne Klasse – oder lokal – gelten die
Standardwerte. Lokal per Doppelklick kann der Browser die `schulhub.json` nicht lesen: Erfolge
heißen dann so wie ihre `id`; über einen lokalen Webserver (z. B. `python3 -m http.server` im App-Ordner) ist alles wie im Hub.

Hinweis zum Vokabeltrainer: Version 1 hat die Wortliste in den Klassendaten (`hub.classData`)
gespeichert. Solange eine Klasse im Hub noch keine eigene Wortliste eingestellt hat, benutzt die
App diese alte Liste weiter; alte Spielstände werden übernommen.

### Beispieldaten (`npm run dev`)

Beim ersten Start mit leerer Datenbank legt der Testmodus an:

| Testperson | Rolle | Was man sieht |
|---|---|---|
| Mia Schmidt | Schülerin in „7b Englisch“ | Ankündigung, offene Aufgabe (begonnen, fällig in 3 Tagen), Rückmeldung von Herrn Lehmann, Fortschritt und Erfolge in vier Apps; besitzt „Pixel-Studio“, das auf die Prüfung wartet |
| Ben Hoffmann | Schüler in „7b Englisch“ | Aufgabe schon erledigt, Ergebnisse und Bestwerte in drei Apps |
| Lena Wagner | Schülerin ohne Klasse | sieht nur die schulweit freigegebenen „Lernkarten“; Beitreten per Link/QR-Code ausprobieren |
| Herr Lehmann | Lehrkraft der 7b | Vokabeltrainer (mit Wortliste „Unit 3“), Sternenfänger, Quiz-Werkstatt (mit Grammatikfragen), Kopfrechnen; Ergebnisse von Mia und Ben; Mias App in der Prüf-Warteschlange; Aufgabe, Ankündigung |
| Frau Yilmaz | Lehrkraft ohne Klasse | besitzt „Lernkarten“ (von der Admin schulweit freigegeben); sieht nichts von der 7b |
| Anna Adler | Admin | Verwaltung und Protokoll |
