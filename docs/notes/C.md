# Package C – "Bauen" (developer experience)

In-browser editor on an app's draft (`/studio/:appId`), its JSON file API, five app templates
(`templates/`), the guide (`/entwickeln`), the SDK reference generated from one source
(`/entwickeln/sdk`, `src/sdkReference.js`), the template list with ZIP downloads
(`/entwickeln/vorlagen`, `/entwickeln/starter.zip`) and the SDK playground (`/entwickeln/spielwiese`).
`src/access.js` is unchanged: every editor route uses `access.canManageApp`.

## SECURITY.md

### Editor drafts: the editor and its file API

| Threat | Handling |
|---|---|
| Someone else reads or edits a draft | Every `/studio/:appId…` route loads the app and checks `access.canManageApp` (owner or admin) before anything else; everybody else – also a teacher who reviews the app and the app's players – gets 404. For `PUT` the check runs before the request body is read. |
| Forged requests | `PUT` and `POST` need the session's CSRF token (header `X-CSRF-Token` from the editor's script, form field for the version form) and a matching `Origin`, as everywhere in the Hub. |
| Path tricks, hidden or reserved names, wrong types, big files, full accounts | Every write goes through `uploads.putDraftFile` – the same name, type, size, file-count, version-size and account-quota checks as an upload. Reading looks a name up in the draft's rows only (exact match), never on disk. Renaming writes the content under the new name through `putDraftFile` and removes the old row in one transaction; it never overwrites another file (409). `?neu=1` (new files, uploads) never replaces. The file API never creates a draft by itself (409 without one). |
| Flooding | Rate limit `draftWrites` (600 per minute and person) on every write, after the permission check and before the body is read; a body is capped at `maxFileBytes`. "Als Version speichern" also counts against `uploadVersions`. |
| Uploaded code on the Hub's origin | The editor page never contains file content. Text files are fetched as JSON (`Cache-Control: no-store`) and live only inside CodeMirror's document (text nodes). Binary files are never sent to the editor (415) and images are not previewed on the Hub origin – the info panel shows name, size and how to use the file, as text. File names are escaped (`html```) or set with `textContent`. |
| The draft leaking through the app origin | The preview is the player's stage with a draft file token (`d: 1`, one hour) that only the owner's editor page or `GET /studio/:id/vorschau` (owner only) issues. A version token never reads draft files. The SDK token of a draft preview is always a preview (`p: 1`): nothing is stored, nothing counts as a play. |
| Changing approved code through the editor | Unchanged rule: the editor only writes the draft. "Als Version speichern" (`services.versionFromDraft`) makes a new, immutable version that needs `index.html` and goes through publish and class review like an upload. |
| Losing work by accident | Starting a draft from a version never replaces an existing draft unless `ersetzen=1` is sent; a template never overwrites a draft; discarding is a POST behind a confirmation that says what happens. The editor warns before leaving with unsaved changes and saves before its own links leave the page. |

### Templates, ZIP downloads, playground

| Threat | Handling |
|---|---|
| Templates as a way around upload rules | Templates are fixed files in the repository, checked when the Hub starts (allowed names and types, `index.html`, valid `schulhub.json`, no copies of `hub-sdk.js` / `hub-ui.css`); the Hub refuses to start with a broken template. The id in a URL is only looked up in that list, never used as a path. A new app from a template puts every file through `putDraftFile` inside one transaction: if anything is refused (for example a full account), no app, no draft and no orphaned file content remain. |
| ZIP downloads | Fixed file names, `Content-Disposition: attachment`. Content chosen by the server only: the template's files, `hub-sdk.js`, `hub-ui.css` and the four UI fonts – nothing from the database. |
| The playground | `POST` only. It creates the person's own app once (an ordinary app under all the usual rules) and reuses it afterwards; nobody else's app is ever opened. |

Tests (`test/studio.test.js`): *Editor und Datei-API: nur die Besitzerin – prüfende Lehrkraft, fremde
Lehrkraft und Mitschüler bekommen 404*, *Datei-API: Pfad-Tricks, reservierte Namen und verbotene
Dateitypen werden abgelehnt, nichts wird geschrieben*, *Datei-API: ohne CSRF-Token oder von fremder
Herkunft geht nichts*, *Datei-API: Schreiben ist gebremst*, *Der Entwurf ist über keinen
Versions-Link lesbar – auch nicht für Mitschüler, die die App spielen*, *„Als Version speichern“:
braucht index.html, macht eine unveränderliche Version, die Klasse behält die freigegebene*,
*Entwurf starten, ersetzen, verwerfen: nur mit Absicht und nur aus eigenen Versionen*, *Dateinamen
erscheinen im Editor nur als Text*, *Vorlagen: jede ist vollständig, gültig und bringt keine eigenen
Hub-Dateien mit*, *Neue App aus Vorlage: geht durch die Prüfung, legt genau die Dateien der Vorlage
an, eine volle Platte lässt nichts zurück*, *ZIP-Download: genau die Dateien der Vorlage plus SDK,
UI-Kit und Schrift – sonst nichts*, *Spielwiese: wird einmal angelegt und danach wiederverwendet;
jede Person hat ihre eigene*, *SDK-Referenz: beschreibt jede Funktion und jeden Wert, den hub-sdk.js
anbietet, und jede Klasse von hub-ui.css*, *Anleitung, Referenz und Vorlagen: für alle
Angemeldeten, die SDK-Datei lässt sich weiter laden*.

*(browser)* Checked in Chromium with the Hub CSP: no CSP violations and no console errors on the
editor, guide, reference, templates and playground pages; CodeMirror's styles arrive through the
adopted stylesheet; the preview, console, search panel, autocompletion, dialogs and uploads work.

## README.md

### Selbst bauen: Vorlagen, Editor, Anleitung

Unter **Bauen** finden alle Angemeldeten:

| Seite | Was dort ist |
|---|---|
| `/entwickeln/vorlagen` | Fünf Vorlagen: *Leere App*, *Quiz*, *Lernkarten*, *Spiel* (Apfelernte, Canvas), *Spielwiese*. „Neue App aus Vorlage“ legt eine App an und öffnet sie im Editor; „Als ZIP herunterladen“ liefert die Vorlage mit `hub-sdk.js`, `hub-ui.css` und Schrift, sodass sie per Doppelklick läuft. `/entwickeln/starter.zip` ist die leere Vorlage. |
| `/studio/<App>` | Der Editor (nur Besitzer/in und Admin): Dateien, Code (CodeMirror) und Vorschau mit Konsole nebeneinander, auf Tablets und Handys umschaltbar. Er arbeitet an einem **Entwurf**; die Versionen bleiben unverändert. *Speichern* (Strg+S) speichert alle geänderten Dateien und lädt die Vorschau neu. *Als Version speichern* macht aus dem Entwurf eine neue Version, die auf der App-Seite veröffentlicht und in Klassen eingereicht wird – wie ein Upload. Bilder und Töne lädt man mit *Hochladen* in den Entwurf. |
| `/entwickeln` | Die Anleitung in acht Schritten: lokal bauen, Regeln, hochladen oder Editor, Vorschau, veröffentlichen, Klasse, was Lehrkräfte sehen, Datenschutz. |
| `/entwickeln/sdk` | Die SDK-Referenz: jede Funktion mit Parametern, Rückgabe, Grenzen, Fehlern, Beispiel und dem Verhalten in Vorschau und lokal; dazu `schulhub.json` und `hub-ui.css`. |
| `/entwickeln/spielwiese` | Öffnet die eigene SDK-Spielwiese (einmal angelegt, danach wiederverwendet): ein Knopf pro SDK-Funktion. |

**Vorlagen pflegen.** Jede Vorlage ist ein Ordner `templates/<id>/` mit mindestens `index.html`,
`style.css`, `app.js` und `schulhub.json`, beschrieben in `templates/index.json`
(`id`, `name`, `appName` für neue Apps, `description`, `emoji` aus der festen Liste in
`src/html.js`, `color` 0–7, `category` aus `src/manifest.js`). `hub-sdk.js` und `hub-ui.css` gehören
**nicht** in den Ordner – der Hub liefert sie selbst, der ZIP-Download legt sie dazu. Der Hub prüft
die Vorlagen beim Start (Namen, Dateitypen, gültige `schulhub.json`) und startet nicht mit einer
kaputten Vorlage; `npm test` prüft sie ebenfalls.

**Die SDK-Referenz hat genau eine Quelle:** `src/sdkReference.js`. Wer `sdk/hub-sdk.js` ändert,
ergänzt dort die Beschreibung – ein Test führt das SDK aus und schlägt fehl, solange eine Funktion
undokumentiert ist (oder etwas dokumentiert ist, das es nicht gibt). Code in den Texten steht in
`Backticks`.

**CodeMirror** liegt fertig gebaut in `public/vendor/codemirror.js` (ein globales `HubEditor`, keine
Netzwerkzugriffe, CSP-tauglich). Neu bauen nur bei einem Update der Versionen:

```bash
cd scripts/vendor
npm ci
node build-codemirror.mjs   # schreibt public/vendor/codemirror.js und codemirror.LICENSE.txt
```

Details und geprüfte Punkte: `scripts/vendor/README.md`. Die Farben des Editors (Hintergrund,
Zeilennummern, Auswahl, Suche, Vorschläge und die `tok-*`-Klassen der Syntax) stehen in
`public/css/studio.css`, außerhalb jeder CSS-Ebene, damit sie CodeMirrors Grundstil schlagen.

Der Abschnitt „Was das SDK kann“ in der README beschreibt noch Version 1; er kann auf
`/entwickeln/sdk` verweisen.
