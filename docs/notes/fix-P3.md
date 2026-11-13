# Fix P3: limits and text safety

Two medium findings of the final review: invisible bidi control characters could make code look
different to the reviewing teacher ("Trojan Source"), and one student could drive the Hub's memory
up with parallel uploads and with the personal data export. New tests: `test/limits.test.js` (9).

## 1. Invisible characters ("Trojan Source")

New module `src/invisible.js` names the characters once; uploads, the check report and the views
use it.

- **(a) File names.** `uploads.normalizePath` refuses every Unicode format character (`\p{Cf}`, e.g.
  U+202E, U+2066, U+200E, ZWJ U+200D, soft hyphen, BOM) and the line/paragraph separators U+2028/U+2029,
  for every name that is stored: folder upload, ZIP (whole archive refused), editor "new file",
  editor upload, editor rename. The message shows the character as `⟨U+202E⟩`, never raw
  (`JSON.stringify` alone left it raw). A name stored before this rule is only *looked up* when a draft
  file is deleted or renamed (`normalizePath(…, { lookup: true })`), so old names can still be cleaned
  up. A version made from such an old draft gets an error in its report.
- **(b) Check report** (`src/checks.js`). Every text file the source viewer shows (HTML, JS, CSS and
  also JSON, SVG, TXT, GLSL, PY …) is searched: bidi embeddings, overrides and isolates
  (U+202A–U+202E, U+2066–U+2069) are an **error**, the marks ALM/LRM/RLM (U+061C, U+200E, U+200F) a
  **warning** (normal in right-to-left text). One finding per line, naming the characters, with file
  and line. Code files are read first with the budget they always had; other text files have a budget
  of their own; text files too big for the viewer and the diff (> 512 KB) are not read. A NUL byte no
  longer hides anything (it only switches off the code checks, as before).
- **(c) Views.** The source viewer (`/apps/:id/versionen/:vid/quelltext`, in `src/routes/apps.js`), the
  diff, the file list of a first submission, the file tree and the check report render every such
  character as `<span class="review-ctl" title="Unsichtbares Zeichen U+202E: …">⟨U+202E⟩</span>`
  (direction marks amber: `review-ctl review-ctl-mark`), never the raw character. Escaping order: the
  text pieces are escaped by `html```, only the placeholder is markup (`appViews.visible`). File names
  (old ones) are rendered the same way; in attributes the placeholder is plain text.

Decisions beyond the brief:

- **U+2028/U+2029** are treated like the direction marks (warning, placeholder; refused in names):
  JavaScript ends a line there, Chromium shows a space – `// Kommentar⟨LS⟩alert(1)` looks like one
  comment and runs `alert(1)` (checked in Chromium).
- **Other invisible characters in code** (zero-width space, ZWJ/ZWNJ inside identifiers, BOM) are not
  marked: ZWJ is part of emoji sequences children use; marking them everywhere would bury the real
  warnings. Homoglyphs stay a reviewer limitation (see "Still open" below).
- A guard test fails if the Hub's own code (`src`, `public`, `sdk`, `templates`, `examples`, `scripts`)
  ever contains a raw bidi control, direction mark or line separator.

**What an error in the report does to publishing and submitting: nothing is blocked.** `services.publish`,
`classApps.add/submit/onPublish/approve` never read the report. An error is shown: as a red
"N Fehler" badge in the version list, in the review queue (`/pruefen`) and at the report in the
workbench; in the red "Version N ist hochgeladen" notice right after the upload; in the editor's flash
after "Als Version speichern" ("Der Prüfbericht meldet N Fehler – sieh ihn dir an, bevor du
veröffentlichst"); the source viewer opens its report by default. So for a student's app the teacher's
review (report on top of the workbench, placeholders in the diff) is the control. A teacher publishing
their own app (their classes switch at once) or the admin (every class) is not stopped either.

Verification: `scratchpad/fix/P3/scripts/f8-bidi-after.js` (16/16; the reviewer's `f8-bidi.js` now stops
at the refused name, 400). Screenshots: `scratchpad/fix/P3/out/f8-*-after-*.png`,
`scratchpad/shots/P3/quelltext-*.png` and `pruefen-*.png` (360–1920 px, no horizontal scrolling).

## 2. Memory: upload bodies and the export

- **(a) Before a body is read** (`PUT /apps/:id/versionen/:vid/datei` and `PUT /studio/:appId/datei`):
  after the permission check and rate limit, `uploads.admitVersionFile` / `admitDraftFile` check the
  name and type, require `Content-Length` (no `Transfer-Encoding`; else **411**), and refuse at once
  (**413**) when the declared size exceeds the file limit, what is left of the version (draft: minus the
  file it replaces) or what is left of the owner's account – counting the bodies being read at this
  moment for the same version/draft and account (in-flight reservations). The routes answer with
  `Connection: close` without reading, like the existing pre-body check. The checks after reading stay.
  The editor's `?neu=1` and content-type checks also moved before the body (and `neu=1` is checked
  again after it).
- **(b) At most 4 bodies per person at once** (`limits.parallelUploads`, both routes together; the
  Hub's uploader sends 3): **429** "Du lädst gerade schon 4 Dateien gleichzeitig hoch …", released on
  `finish`, `close` and request `error`.
- **(c) Export** (`/meine-daten/export`): `src/jsonStream.js` writes the document piece by piece with
  exactly the text of `JSON.stringify(…, null, 2)`, respecting back-pressure and yielding to the event
  loop after every 64 KB. Results, saves, comments, feedback and the list of apps are read a page at a
  time (ids first, then 20–200 rows per query, the owner checked again on every page). Same content
  (byte-identical to the old export on a test database apart from `erstellt`; ties in comments and
  feedback are now ordered by row id), same `Content-Type`, `Content-Disposition` and `Cache-Control`;
  `Content-Length`/`ETag` give way to chunked transfer. One export per person at a time
  (`limits.parallelExports`): **429** "Dein Download wird gerade schon erstellt …" (an error page, not a
  download). A failure in the middle breaks the connection, so half a file never looks complete.

Measured with the reviewer's `f5b-dos-scale.js` (separate Hub process, same machine):

| Attack | Before | After |
|---|---|---|
| A: 64 parallel 25 MB PUTs into one version | RSS 89 → 1738 MB; 4 × 200, 60 × 400 **after** reading | RSS 89 → 180 MB; 4 × 200, 60 × 413 **before** reading |
| B: one export (12 apps × 500 results, 179 MB) | RSS +431 MB, visitor waits up to 370 ms, 509 ms | RSS +41 MB, visitor ≤ 1 ms, 206 ms |
| B: 4 parallel exports | RSS 1693 → 2269 MB, visitor waits up to 1606 ms, 4 × 200 | RSS +1 MB, visitor ≤ 1 ms, 1 × 200, 3 × 429 |
| 64 parallel 2 MB PUTs (budget not reached; `f5c-parallel-small.js`) | RSS 89 → 266 MB, all 64 read, 14 refused after reading | RSS 89 → 126 MB, never more than 4 read at once, 51 × 429 |

## Tests (`test/limits.test.js`) and revert check

| Test | Fails when |
|---|---|
| *Dateinamen mit unsichtbaren Zeichen werden überall abgelehnt – die Meldung zeigt sie als ⟨U+…⟩* | the `\p{Cf}` rule in `normalizePath` is removed |
| *Prüfbericht: Steuerzeichen für die Schreibrichtung sind Fehler – mit Datei und Zeile, in jeder Textdatei* | `hiddenChecks` is not called |
| *Quelltext und Änderungen zeigen unsichtbare Zeichen als Platzhalter – nie das Zeichen selbst, richtig escaped* | the views output the text unchanged |
| *Der Code des Hubs selbst enthält keine unsichtbaren Steuerzeichen* | such a character is written raw into the Hub's code |
| *Upload: zu große Angaben werden abgelehnt, bevor der Inhalt gelesen wird – Datei, Version, Konto, ohne Größe* | the pre-body size/budget/quota/length checks are removed ("the server waited for the body") |
| *Upload: höchstens 4 Dateien gleichzeitig pro Person – über Ordner-Upload und Editor, frei nach Ende oder Abbruch* | the limit of 4 is removed |
| *JSON-Download: Stück für Stück geschrieben, genau wie JSON.stringify(…, null, 2)* | (correctness of `src/jsonStream.js`, slow receiver) |
| *Meine Daten: der Export wird gestreamt – vollständig, gültig, im gewohnten Format und mit denselben Kopfzeilen* | the old in-memory export is restored |
| *Meine Daten: ein zweiter Export derselben Person während des ersten wird abgelehnt (429)* | the old export, or the lock removed |

Revert check (`scratchpad/fix/P3/scripts/revert-check.py`): 7 mutations, each made its test fail; files
restored (checksums). The existing export tests pass unchanged. `npm test`: 143 pass.

## SECURITY.md

Add these rows to the table under **Apps, uploads and review**:

| Threat | Handling |
|---|---|
| Code that looks different to the reviewer than what runs ("Trojan Source": bidi controls such as U+202E reorder how text is shown) | The upload check (`src/checks.js`) searches every text file the source viewer shows – also JSON, SVG, TXT – for bidi embeddings, overrides and isolates (U+202A–U+202E, U+2066–U+2069): an **error** with file and line, one finding per line naming the characters. The direction marks ALM/LRM/RLM (U+061C, U+200E, U+200F, normal in right-to-left text) and U+2028/U+2029 (a line end for JavaScript, a space in the browser) are **warnings**. The source viewer, the diff, the file lists and the report never output these characters: each is a marked placeholder such as `⟨U+202E⟩` (`appViews.visible`; the text is escaped first, only the placeholder is markup). Findings do not block publishing; they are shown to the owner and on top of the teacher's workbench. Tests: *Prüfbericht: Steuerzeichen für die Schreibrichtung sind Fehler…*, *Quelltext und Änderungen zeigen unsichtbare Zeichen als Platzhalter…* (`test/limits.test.js`) |
| Large upload bodies held in memory (`PUT …/datei` of folder uploads and the editor) | Before the body is read, after the permission check: `Content-Length` is required (chunked bodies: 411), and the declared size must fit the file limit, what is left of the version or draft and of the owner's account, counting the bodies being read at that moment (413 at once, `Connection: close`, nothing read). One person reads at most 4 bodies at a time across both routes (`limits.parallelUploads`, 429), released when the response ends or the connection closes. The checks after reading stay. Measured: 64 parallel 25 MB PUTs RSS +91 MB (before +1649 MB). Tests: *Upload: zu große Angaben werden abgelehnt, bevor der Inhalt gelesen wird…*, *Upload: höchstens 4 Dateien gleichzeitig pro Person…* (`test/limits.test.js`) |

Add this row to the table under **Uploads**:

| Threat | Handling |
|---|---|
| File names that look like other names (e.g. `bild⟨U+202E⟩gnp.js` shown as "bildsj.png") | Every stored name is refused if it contains a Unicode format character (`\p{Cf}`: bidi controls, direction marks, zero-width joiners, soft hyphen, BOM) or U+2028/U+2029 – folder upload, ZIP, editor new file, upload and rename. Messages show the character as `⟨U+202E⟩`. Names stored before this rule are shown with placeholders, are reported as an error when such a draft becomes a version, and can still be renamed or deleted. Test: *Dateinamen mit unsichtbaren Zeichen werden überall abgelehnt…* (`test/limits.test.js`) |

Add to **Privacy (minors)**, after the "Meine Daten" bullet:

- The export is written piece by piece (`src/jsonStream.js`): the long lists (results, saves, comments,
  feedback, apps) are read a page at a time while the file is sent, with the same content and format
  as before; one export per person at a time (429). Measured with 179 MB of results: RSS +41 MB instead
  of +431 MB per export; four parallel requests no longer stall other visitors (≤ 1 ms instead of
  1.6 s). Tests: *Meine Daten: der Export wird gestreamt…*, *Meine Daten: ein zweiter Export derselben
  Person während des ersten wird abgelehnt (429)*, *JSON-Download: Stück für Stück geschrieben…*
  (`test/limits.test.js`)

Add to **Abuse and operations**:

- **Own code without invisible characters**: a test fails if a bidi control, direction mark or line
  separator is ever written raw into the Hub's code (`src`, `public`, `sdk`, `templates`, `examples`,
  `scripts`); write them as `\u` escapes. Test: *Der Code des Hubs selbst enthält keine unsichtbaren
  Steuerzeichen*

Add to **Still open**:

- **Lookalike code beyond bidi controls.** Zero-width characters inside identifiers (`isAdmin` with a
  ZWJ is another variable) and lookalike letters from other alphabets (homoglyphs) are neither reported
  nor marked; ZWJ is part of emoji that children use in their code. Versions uploaded before the
  bidi check have no such findings in their stored report; the views mark the characters anyway.
- **Upload bodies are still buffered in memory**, at most 4 × 25 MB per person at a time. Many accounts
  at once can still add up; streaming file bodies to disk would remove this.

## README.md

Unter **Regeln für Apps** ergänzen:

- **Keine unsichtbaren Zeichen in Dateinamen.** Namen mit Steuerzeichen für die Schreibrichtung,
  unsichtbaren Verbindern oder ähnlichen Zeichen werden abgelehnt (die Meldung zeigt sie als ⟨U+202E⟩).
  Im Code meldet der Prüfbericht Steuerzeichen für die Schreibrichtung als Fehler; Quelltext-Ansicht
  und Änderungen zeigen sie als rote Platzhalter, damit Code nicht anders aussieht, als er läuft.
- Pro Person werden höchstens 4 Dateien gleichzeitig hochgeladen (der Hub schickt selbst 3 auf
  einmal). „Meine Daten → Alles herunterladen“ läuft pro Person einmal zur Zeit.

Unter **Echter Betrieb**, Punkt 3, anfügen: „Der Proxy muss beim Hochladen die Größenangabe
(`Content-Length`) durchreichen – Browser senden sie immer mit, nginx und Caddy reichen sie von sich aus
weiter. Uploads ohne Größenangabe lehnt der Hub ab.“
