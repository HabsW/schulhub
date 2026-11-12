# SchulHub security

Who we defend against:

1. **Curious, clever students** with an account: they open the console, edit and replay
   requests, guess ids, and upload hostile files to see what happens.
2. **Hostile or buggy apps**: uploaded code runs in other people's browsers.
3. **Outsiders** who find the site and have no account.

The users are minors, so the default everywhere is: deny, collect less, show less.

`npm test` runs the attack tests in `test/security.test.js`. Each section below names the
tests that try to break it. Things checked by hand in a real browser are marked *(browser)*.

## Threats and how each is handled

### Sign-in and sessions

| Threat | Handling |
|---|---|
| Accounts outside the school | Tenant-specific Microsoft authority, plus a check of the `tid` claim. E-mail domain must be in `STUDENT_EMAIL_DOMAINS` / `STAFF_EMAIL_DOMAINS`; anything else is refused. |
| Passwords leaking | The Hub has none. No self-registration. Microsoft tokens are discarded after sign-in; only `openid profile email` is requested. |
| Session fixation / theft | New session id at login. Cookie is `HttpOnly`, `SameSite=Lax`, `Secure` under HTTPS, and named `__Host-…` under HTTPS so no subdomain can set or shadow it. Absolute lifetime 8 hours. Logout destroys the session server-side. The database stores only a hash of the session id. |
| Login CSRF / code injection | `state` and PKCE verifier live in the server-side session and are single-use. |
| Open redirect after login | Return target must be a local path. |
| Test login reaching production | `/dev/login` only exists with `--dev`; `--dev` refuses to start unless `BASE_URL` is localhost and `NODE_ENV` is not `production`, and listens on loopback only. Real mode refuses to start with incomplete configuration. |

Tests: *Sitzung…*, *Testmodus…*, *Microsoft-Anmeldung…*

### Permissions

| Threat | Handling |
|---|---|
| Missing check on some route | Default deny: a global gate rejects every request without a valid session except a short allow-list. Every route then loads its object through a helper that checks this user against this exact class / app / version / student. |
| Browser-supplied role or owner | Never read. The user row is loaded from the database on every request, so role changes and blocks apply immediately. All decisions are in `src/access.js`. |
| Guessing ids | Ids are 96-bit random. "Not found" and "not allowed" return the same 404. |
| Teacher reading outside their classes | A teacher sees a student's app data only if the student is in one of **their** classes and the app is approved in **that** class. |
| App owner reading users' data | Owning an app gives no access to other people's saves or results. |
| Reviewer seeing private drafts | A teacher sees only the versions submitted to or approved in their classes. |
| Student swapping code after approval | Approval is bound to a version. A newly published version waits; the class keeps the approved one. Versions are immutable once uploaded. |
| CSRF | Every non-GET request needs the per-session token (form field or header) and, if present, a matching `Origin`. `SameSite=Lax` on top. |
| Join codes | 192-bit random, expiring (15 minutes to 1 week), one active code per class, revocable. A code can only ever insert a `student` membership. Wrong attempts are rate-limited per account. |

Tests: *ohne Anmeldung…*, *CSRF…*, *Schüler kann keine Klasse anlegen…*, *Rolle kommt nur aus der
Datenbank…*, *Beitrittscodes…*, *Schüler und fremde Lehrkräfte…*, *Wem eine App gehört…*,
*fremde Apps…*, *Schüler-Apps…*, *Verwaltung…*

### App isolation

| Threat | Handling |
|---|---|
| App reads Hub cookies, pages or DOM | Each app has its own origin (`<random key>.<apps domain>`). No Hub cookie is ever sent there. The app runs in an `<iframe sandbox>` without top-navigation or popups; the same sandbox is repeated as a CSP header on the app's documents. *(browser: cookie empty, `parent.document` and `top.location` blocked)* |
| App reads another app's data | Every data query is keyed by the app resolved from the request's host. The SDK token names one app and is rejected on any other app's origin. |
| Stolen or replayed token | SDK tokens are HMAC-signed, expire after 10 minutes, and are bound to user, app and session: after logout or a block they stop working at once. File tokens are a different kind and cannot be used as SDK tokens. |
| App sends data out | App CSP allows network access only to the app's own origin. The Hub's `frame-src` blocks the app from navigating its frame elsewhere. *(browser: `fetch` to the internet and to the Hub blocked, self-navigation blocked, popup blocked)* |
| Forged messages between app and Hub | The Hub page accepts messages only from the app's origin **and** its own frame, and replies only to that origin. The SDK accepts messages only from the Hub origin and its parent window. |
| App opened outside the Hub | Top-level requests (`Sec-Fetch-Dest: document`) are refused; `frame-ancestors` allows only the Hub. |
| Unpublished code visible to others | Files are served only with a signed token for exactly that version, issued after a permission check. |
| Apps learning identities | Apps get a display name and a per-app pseudonymous id. No e-mail address. |
| A preview writing real data | A preview (an owner trying a version, a teacher reviewing a submission) gets an SDK token marked as preview. The mark is inside the signed token, so the app cannot remove it. The SDK API then keeps every write in memory (`src/sdkStore.js`): bounded per preview (2 MB), in number (400) and overall (128 MB), dropped after 2 hours idle or on restart. Reads of class and app data fall through to the real data, writes never do. Previews are not counted as plays, and a preview leaderboard shows no real players. |

Tests: *App-Isolation…*, *App-Dateien…*, *SDK-Rechte…*, *Vorschau…*

### SDK features of version 2

| Threat | Handling |
|---|---|
| App unlocks arbitrary "achievements" (e.g. offensive titles shown in the Hub) | Only achievements declared in the version's `schulhub.json` can be unlocked. The manifest is uploaded data: parsed as JSON (never executed), validated field by field (`src/manifest.js`), lengths capped, emojis from a fixed list. It is part of the version the teacher reviews. Titles are always shown escaped. |
| App changes per-class settings | There is no write path from apps (`settings.set` does not exist). Teachers edit settings in the Hub; values are validated against the manifest's field types and capped at 64 KB. Apps read only the settings of the class they were opened from. |
| Files as an attack channel (`hub.files`) | Per person and app only. Allow-list of passive types (PNG, JPEG, WebP, GIF, JSON, text, CSV); images must start with the right magic bytes, JSON must parse; no HTML, no SVG. Stored by content hash in `data/userfiles/` (apart from app code), names validated like keys. Served on the app's origin only, with the stored type, `nosniff`, `Content-Disposition: attachment` and the app CSP. 1 MB per file, 50 files and 10 MB per person and app, rate-limited. Deleted with the person's app data or account (contents garbage-collected). |
| Progress values | Numbers only, clamped to 0..1; label capped at 60 characters. |
| Previews | All of the above go to the in-memory preview store during a preview, like saves and scores. |
| Uploaded copies of Hub files | `hub-sdk.js` and `hub-ui.css` (at any path) and fonts under `hub-ui-fonts/` are always served from the Hub's own files. |

Tests: *schulhub.json…*, *SDK-Fortschritt…*, *SDK-Erfolge…*, *SDK-Einstellungen…*, *SDK-Dateien…*, *Die Hub-eigenen Dateien…* (`test/foundation.test.js`)

### Editor drafts: data model

| Threat | Handling |
|---|---|
| Changing code after approval through the editor | The editor writes to one mutable **draft** per app (`app_drafts`, `draft_files`), never to a version. "Save as version" copies the draft's rows into a new version, which is immutable like any upload and goes through the same publish and review rules. |
| Draft files bypassing upload rules | Every draft write goes through the same path, extension, size, file-count, version-size and account-quota checks as uploads (`uploads.putDraftFile`). Drafts count toward the account quota. |
| Others reading a draft | Draft files are served only with a file token that names the draft (`d: 1`) for exactly that app, issued after `canManageApp`; never cached (`no-store`). A version token never reads draft files and vice versa. Draft previews always use the in-memory SDK store. |
| Deleting a draft deleting a version's files | Content blobs are shared; garbage collection keeps a blob while any version or draft references it. |

Tests: *Editor-Entwurf…*

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

### Classes: review, co-teachers, archive

| Threat | Handling |
|---|---|
| Approving something other than what was reviewed | Every change to an app in a class goes through one state machine (`src/classApps.js`). Approving and giving back name the exact waiting version; anything else is refused. |
| A returned app vanishing from the reviewer | A returned version stays visible to the class's teachers (`request_state = 'returned'`) and the reason is kept as a review comment. The owner can resubmit; the student gets an in-Hub notice. |
| Removing an app destroying results | An app that was ever approved becomes `removed`: not playable any more, but its results stay readable for the class's teachers (`canSeeStudentData` accepts `approved` and `removed`). Publishing a new version never brings it back. |
| Students bypassing review by "sharing" | Sharing with colleagues (`apps.shared`) only works for apps whose owner is staff (`access.isSharedWith`). A colleague may preview the shared app's published version before adding it. |
| Co-teacher invitations used by students | A join code has a role. A class code always creates a **student** membership, whoever uses it. A teacher invitation creates a teacher membership only for staff accounts; a student using it gets nothing. One active code per class and role. |
| Archived classes | Read-only (`canChangeClass` is false). Students lose access and class context; nobody can join; teachers keep read access to results. Archived classes do not count for "shares a class" on leaderboards. |

Tests: *Prüfen: Zurückgeben…*, *Entfernte Apps…*, *Kolleg/innen teilen Apps…*, *Lehrkraft-Einladung…*, *Archivierte Klassen…*

### Class pages and teaching tools

| Threat | Handling |
|---|---|
| Student or foreign teacher creates, edits or deletes assignments | `access.canAssign` (teacher of an active class + app approved there), `canManageAssignment` for edit/delete. Everything else answers 404. |
| Ticking an assignment "done" for someone else | `POST /aufgaben/:id/erledigt` only writes a row for the signed-in user (`access.canMarkDone`: student of the class, class active). Any user id in the form is ignored. "Done" is otherwise derived from results / full progress after the start (`src/assignments.js`). |
| Students seeing other classes' assignments | `access.canSeeAssignment` = may view the class; archived classes are invisible to students. |
| Teacher reading a class that is not theirs | Every class page, tab, result list, CSV, student detail, overview and settings page loads the class and checks `canManageClass` / `canChangeClass` / `canSeeClassResults` / `canSeeStudentData`; not allowed = 404. |
| Results leaking between classes | Teacher views (results list, student detail, CSV, overview grid, weekly charts, assignment detail) only count results with `class_id = <this class> OR class_id IS NULL`. Tested with one student in two classes. |
| Removed app hides earlier results from its teacher | `canSeeClassResults` allows status `approved` or `removed`; removed apps keep "Ergebnisse" and can be brought back (`classApps.restore`). |
| Private feedback read or written by the wrong person | Writing: `canGiveFeedback` (teacher of an active class → a student of that class). Optional links to an app / assignment are checked against the same class. Reading: `canReadFeedback` (the student, the class's teachers). Marking read: only the student (`canMarkFeedbackRead`), by POST – looking never changes state. Deleting: `canDeleteFeedback` (author, the student, admin). Length ≤ `limits.feedbackChars`. The notification text is composed by the server. |
| Co-teacher invitation misused | Created only by teachers of the active class (`canChangeClass`) with `services.createJoinCode(…, 'teacher')`; usable only by staff accounts (`access.joinRoleFor`); never shown to students; revocable; audited (`lehrkraft_eingeladen`, `einladung_geloescht`). A class code still always makes a student. |
| A class left without a teacher | `access.canLeaveClass`: a teacher may leave only while another teacher remains; otherwise the page points to archive / delete. |
| Changes to an archived class | Every change goes through `canChangeClass` (not archived) – including the app owner's own "remove from class" path, which previously only checked ownership. Students lose access to the class, its assignments and its apps; restoring brings everything back. Archive / restore are audited (`klasse_archiviert`, `klasse_wiederhergestellt`). |
| Tampered per-class app settings | Only `canEditAppSettings` (teacher of the active class, app approved there). Fields come from the manifest of the version approved in the class; values are validated with `validateSettings` (unknown keys ignored, per-field errors), stored as JSON with `updated_by/at`, audited. Apps can only read them (`settings.all`), only in their class context. |
| Projector page leaking names | `GET /klassen/:id/qr/status` (polled every 5 s) is teacher-only and returns a number and a sentence built by the server – never names; `Cache-Control: no-store`. The projector page has no navigation. |
| Join code confusion / guessing | Unchanged rules (192-bit, expiring, rate-limited). New: the confirmation page names class and teachers, joins only on POST; revoking asks first, shows a message and is audited (`beitrittscode_geloescht`); renaming is audited (`klasse_umbenannt`). |
| CSV formula injection / header injection | Every cell is quoted and formula-guarded; the file name is an ASCII slug (`ergebnisse-<klasse>-<app>-<datum>.csv`); `no-store`. |
| Open redirect after a form | The `zurueck` field is accepted only as a local path under `/klassen`, `/aufgaben` or `/rueckmeldungen` (`teachingKit.backTo`). |
| Script injection | All text (class names, titles, notes, feedback, result details, manifest labels) goes through `html```; result details are rendered by a fixed table/list renderer, never as HTML. Page JS sets text with `textContent` only. No inline styles or scripts. |

Tests (`test/teaching.test.js`):
- Aufgaben: nur Lehrkräfte der Klasse stellen sie – Schüler, fremde Lehrkräfte und archivierte Klassen nicht
- Aufgaben: Schüler sehen nur die ihrer Klassen; „erledigt“ wird abgeleitet; abhaken nur für sich selbst
- Rückmeldungen: nur von der Lehrkraft an eigene Schüler/innen, privat, nur der Empfänger markiert gelesen, Löschen nach Regeln, alles escaped
- Lehrkraft-Einladung: nur Lehrkräfte der Klasse erzeugen sie, nur Lehrkräfte nutzen sie; die letzte Lehrkraft kann nicht gehen
- Archiv: Schüler verlieren den Zugriff, nichts lässt sich ändern, Zurückholen bringt alles wieder
- App-Einstellungen: nur die Lehrkraft der Klasse; Werte werden geprüft; die App liest sie über hub.settings; andere Klassen bleiben unberührt
- Überblick und Ergebnisse: nur Ergebnisse aus dieser Klasse; fremde Lehrkräfte 404; entfernte Apps bleiben lesbar
- QR-Status: nur für Lehrkräfte der Klasse, nur eine Zahl – keine Namen
- Klassen: Fach und Stufe werden geprüft; Umbenennen und Code-Löschen stehen im Protokoll; Beitreten nur nach Bestätigung

### Apps, uploads and review

| Threat | Handling |
|---|---|
| A teacher of another class, a student, or the owner opening the review workbench | `access.reviewRequest(user, classId, appId)` (new, package B block): the user may change the class (`canChangeClass`: its teacher or the admin, never while archived) **and** the app's request there is `waiting` – or `returned`, which the workbench shows read-only. The requested version must also pass `canSeeVersion`. Everything else answers 404, for the page and for its three forms. |
| Approving or giving back something other than what was reviewed | The workbench forms send the exact version id; `classApps.approve` / `giveBack` refuse anything but the version that waits. If the owner publishes a newer version while the teacher is looking, the old form fails (400) instead of approving unseen code. A reason is required to give back. |
| The queue or "next app" revealing other classes | `/pruefen` and the redirect after a decision come from one query over the user's own teacher memberships in active classes (`class_members.role = 'teacher'`, `archived_at IS NULL`). The admin deciding in a class they do not teach is sent to `/pruefen`, never into that teacher's queue. Students get 404. |
| The diff exposing private versions | The workbench compares exactly two versions: the one approved in **this** class and the waiting one. No request parameter chooses versions. Both are checked with `access.canSeeVersion` before anything is read. |
| The diff as an attack or load channel | Computed on the server with `diff` 9.0.0 (`structuredPatch` with `maxEditLength` and `timeout`). Text files only (by type **and** by content: NUL bytes), ≤ 300 KB per file; at most 80 files, 4 MB and 1.5 s per comparison; at most 3000 lines rendered. The Hub's own `hub-sdk.js` / `hub-ui.css` are never compared. Every line is escaped by `html```; line numbers and +/− marks are CSS (`attr()`), so nothing user-written becomes markup. |
| Upload checks running uploaded code | `src/checks.js` only reads files as UTF-8 text (HTML, JS, CSS; ≤ 512 KB each, ≤ 400 files / 4 MB per version) and matches **bounded** regular expressions (every quantifier has a limit, `<script>` blocks are found with linear `indexOf`-style scans), so hostile files cannot cause catastrophic backtracking. Nothing is executed, imported, evaluated or fetched. Findings are text items `{ level, text, file, line }` and are escaped wherever shown. |
| Half-finished uploads left on the server | `POST /apps/:id/versionen/:vid/abbrechen` deletes a version **only while it is `uploading`**, only for `canManageApp` (owner or admin). `public/upload.js` calls it on every failure and on "Abbrechen"; a refused zip is removed by the server itself. A finished version can never be removed this way (404). |
| Usage numbers identifying students | Shown only to `canManageApp` (owner, admin) and only for published apps: opens per day (the anonymous `app_usage` counts), number of classes, people as "weniger als 5" below five, and the average result only with at least five distinct people ("zu wenige Daten" otherwise). No names, no numbers per class. Previews are never counted (preview tokens). |
| Students bypassing review by "sharing" | The switch "Mit Kolleg/innen teilen" is rendered and honoured only when `access.canShareApp` (staff owner); a posted value from anyone else is ignored. Changes are audited (`app_geteilt`, `app_nicht_mehr_geteilt`). |
| A school-wide update without the admin | `POST /apps/:id/schulweit` is admin-only (`isAdmin`, else 404). Approving (`update=<version>`) and turning down (`verwerfen=<version>`) are bound to exactly `apps.schoolwide_requested_version_id`; the request is cleared afterwards; both are audited (`schulweit_aktualisiert`, `schulweit_update_abgelehnt`) and the owner is told in the Hub. On/off clears a waiting request. |
| Review conversation leaking between classes | Comments written in the workbench carry their class and version. A teacher sees the general conversation and the decisions of **their** classes only – on the app page and in the workbench. Only plain comments (never decisions) can be deleted, by their author or the admin. |
| Withdrawing or removing someone else's app | `POST /apps/:id/zurueckziehen` and `POST /apps/:id/aus-klasse` require the owner (`canManageApp` plus `owner_id`), an existing row and an active class; they go through `classApps.withdraw` / `remove`. |
| User text in pages (names, notes, comments, reasons, report texts, manifest texts, file names, source, diffs) | Always through `html```. Source code is escaped text in `<pre>` with CSS-counter line numbers; `hub-sdk.js` / `hub-ui.css` (any folder) are marked "Standard-Datei des Hubs" and their uploaded content is never shown; binary files are listed with their size only. No inline styles anywhere – the device-width switch of the preview only changes classes. |
| Workbench preview writing real data | The preview is embedded exactly like the player (same sandbox attribute, own origin, file token for exactly the waiting version); the lead's token route issues a **preview** SDK token for `version` + `klasse`, so everything stays in memory and nothing counts as a play. |

Tests (`test/review.test.js`): *Prüfen-Liste: nur wartende Apps aus den eigenen, aktiven Klassen*, *Prüfplatz: 404 für fremde Lehrkräfte, Schüler/innen und Unbekanntes; die Vorschau ist eingebettet wie im Player*, *Entscheiden: nur über genau die wartende Version, nur durch die Lehrkraft der Klasse*, *Nach der Entscheidung geht es nur in den eigenen Klassen weiter*, *Änderungen: nur zwischen sichtbaren Versionen, HTML im Vergleich wird nie ausgeführt*, *Prüfbericht: externe Skripte, absolute Pfade, fehlende Teile – gemeldet, nichts wird ausgeführt*, *Nutzung: keine Namen, keine Zahlen je Klasse, kleine Zahlen bleiben verborgen*, *Mit Kolleg/innen teilen: nur Lehrkräfte als Besitzer*, *Schulweites Update: nur die Verwaltung gibt es frei – und nur genau die wartende Version*, *Abgebrochene Uploads: nur wer die App verwaltet räumt auf – fertige Versionen bleiben*, *Lehrkräfte sehen auf der App-Seite nur ihre eigenen Klassen*, *Versionsnotizen, Namen und Quelltext werden überall escaped*, *Neue App: ein Fehler führt zurück zum Formular, alle Eingaben bleiben stehen*.

### School pages, Meine Daten and Verwaltung

| Threat | Handling |
|---|---|
| Changing someone else's display settings, injecting into the `data-*` attributes of `<html>` | `POST /einstellungen` writes only `req.user`'s row; every value must be one of the fixed values (`src/formKit.js`, the columns also have `CHECK` constraints). Ids sent with the form are ignored. A refused form changes nothing. |
| The search as a people directory | `/suche` lists apps from `access.visibleApps` and classes from `access.visibleClasses`. People only for staff, and only students of classes they teach (checked per row with `canManageClass` + `isStudentOf`). Students get no people search at all. At least 2 characters, `%`/`_` are escaped, lists are bounded (200 apps, 40 people), the query is shown escaped. |
| The catalogue showing apps the person may not open, or adding apps to foreign classes | `/katalog` shows only `access.visibleApps`. "Zur Klasse hinzufügen" is offered only for the person's own active classes where `access.addToClassMode(…) === 'approve'` and the app is not already there; the buttons post to the existing `POST /klassen/:id/apps`, which applies the same rule again. A student's name is shown only to people who share a class with the app; elsewhere it says "von Schüler/innen gebaut". |
| Announcements by the wrong people | `/ankuendigungen` is staff only (404 for students). One class only via `access.canAnnounce` (teacher of an active class), the whole school only for the admin, deleting only via `access.canDeleteAnnouncement`; everything else answers 404. Title ≤ 120, text ≤ 1000 characters, shown as text; the end date must lie in the future and at most a year ahead. Created and deleted announcements are in the audit log; class members get an in-Hub notice. |
| Reading someone else's data through "Meine Daten" | Every query is keyed by `req.user.id`. `/meine-daten/app/:aid` answers 404 unless the person has data in that app or can open it (`access.resolvePlay`). `GET /meine-daten/app/:aid/datei/:name` looks up exactly (app, `req.user.id`, name), the name must be a valid key, and the file is always sent as `application/octet-stream` with `Content-Disposition: attachment` (extension from the stored type), `nosniff` and `no-store`. Deleting app data only touches the person's own rows. |
| The export leaking other people's data | `/meine-daten/export` contains only the person's rows: account, classes, own apps, comments, favourites, feedback received, assignments marked done, notices, own announcements, app data (saves, results, scores, progress, achievements with titles from `schulhub.json`, files with name/type/size/link). Other people appear only by name where it is needed (who wrote a piece of feedback), never with e-mail address or id. Audit entries only as "what and when", without targets or details that could name others. |
| Deleting an account by accident | Exactly the word `LÖSCHEN` in capitals (only surrounding spaces and Unicode normalisation are forgiven) plus a confirmation that lists the consequences: own apps with everything others saved in them, classes where the person is the only teacher. The last admin cannot delete their account. Afterwards the session is destroyed and the browser goes to `/?geloescht=1`. |
| Admin area reachable by others | One gate for `/admin…` (`access.isAdmin`): every page and action answers 404 for everyone else. |
| Dangerous admin actions by mistake | Role changes, blocking and deleting happen on the account page, each behind a confirmation that says what happens (what an admin may do; "wird sofort abgemeldet"; what is deleted). The last-admin guard is in the route and the page. Return targets of forms are accepted only inside `/admin`. Classes are archived, restored and deleted via `canManageClass`, each audited. Inactive accounts are only flagged and listed; nothing is ever deleted automatically. |
| Retention values out of range | `settings.set` validates every value; the form saves all values or none (one transaction); changes are audited with old → new value. |
| A backup as a data leak | The download is a POST with the CSRF token, admin only (no link or image can start it), audited with number of files and size. The zip contains only `hub.sqlite`, `blobs/<xx>/<sha256>` and `userfiles/<xx>/<sha256>` – no secrets, no temporary files. Temporary copies in `data/tmp` are removed when the download ends or is cancelled (and `data/tmp` is emptied at every start). The page tells the admin to store backups encrypted. |
| An inconsistent backup | The database is copied with `VACUUM INTO` (one consistent moment). Content files are pinned with hard links (copies where links are impossible) before and after the copy, so garbage collection during a long download cannot remove a file the copy refers to. A backup that would exceed the limits of the zip writer (no ZIP64) is refused with a message instead of producing a broken file. |
| A hostile archive on restore | Restoring is possible only on the command line (`npm run restore`), never through the web. The whole archive is checked before anything is written: only the three name shapes above (the folder must match the hash), regular files only (no symlinks or special files), no encryption, no duplicates, bounded sizes, enough free disk space; yauzl refuses absolute and `..` paths. Files are unpacked into a staging folder inside the data folder, every content hash is verified, and the database must pass the SQLite header check, `PRAGMA quick_check`, a known schema version and must not contain triggers or views. Only then is everything moved into place; existing data is moved to `data/vor-wiederherstellung-<time>/`, never deleted; sessions from the time of the backup are removed. Nothing from an archive is ever executed. |
| An unreadable audit log | Every action code passed to `services.audit()` in `src/` has a German label (`src/auditLabels.js`); a test greps the sources and fails for a code without one. Roles in the actor label are shown in German; unknown codes are shown as they are. |

Tests (`test/school.test.js`): *Darstellung: nur die eigenen Einstellungen, nur erlaubte Werte* · *Suche: nur Apps, Klassen und Personen, die man sehen darf; Schüler/innen finden keine Personen* · *Entdecken: nur sichtbare Apps; „Zur Klasse hinzufügen“ nur, wo die Lehrkraft sofort freigeben darf* · *Ankündigungen: Schüler/innen nie, Lehrkräfte nur für eigene Klassen, die ganze Schule nur der Admin* · *Meine Daten: Dateien nur die eigenen, immer als Download mit festen Headern* · *Meine Daten: die Seite einer App nur mit eigenen Daten oder wenn man sie öffnen darf* · *Meine Daten: der Export enthält alles Neue und keine fremden E-Mail-Adressen* · *Konto löschen: nur mit genau dem Wort LÖSCHEN, danach zurück zur Startseite* · *Verwaltung: jede Seite und jede Aktion gibt es für andere nicht* · *Verwaltung: Konten mit Filtern und Seiten, Rollen mit klaren Folgen, Klassen archivieren* · *Verwaltung: Aufbewahrung nur mit gültigen Fristen, alles oder nichts; Datenbank prüfen* · *Protokoll: jeder Vorgang auf Deutsch, Rollen auf Deutsch, Filter nach Vorgang, Person und Zeitraum* · *Sicherung: nur der Admin, nur per POST mit CSRF; das Archiv enthält nur erlaubte Pfade und eine gültige Datenbank* · *Wiederherstellung: feindliche Archive werden abgelehnt, ohne dass etwas geschrieben wird*

### Page shell

| Threat | Handling |
|---|---|
| Form errors as an open redirect | A failed form (400/409/413 only) goes back to the page it came from, taken from the `Referer` and accepted only if it has the Hub's own origin and is a plain local path (`isLocalPath`: never `//host`). Permission errors (401/403/404/429) are never turned into redirects. What the person typed is kept for one page view (text fields only, capped, never the CSRF token) and shown escaped. |
| Display settings as an injection channel | `data-theme`, `data-text`, `data-motion`, `data-contrast` on `<html>` come only from columns with `CHECK` constraints. |
| Favourites | Only for apps the person can open (`resolvePlay`); the return path is checked against local Hub paths. |
| In-Hub messages | Written only by the server (`services.notify`), shown escaped, links must be local paths. Each person sees and marks only their own; marking read is a POST. |
| Announcements | Shown and dismissable only if `access.canSeeAnnouncement` (school-wide, or a class the person can see); others answer 404. |
| The owner's editor draft in the player | `?entwurf=1` and draft tokens only for `canManageApp` and only if a draft exists; the token is always a preview (`p: 1`, `v: 'draft'`), so nothing is stored and nothing counts as a play. |

Tests: `test/shell.test.js`

### Example apps and demo data

| Threat | Handling |
|---|---|
| An example app loads code or fonts from other servers or sends data there | All files live in the app's folder, relative paths only. A test scans every file of the examples: no internet address (not even in comments), no protocol-relative address, no absolute path in `src`/`href`/`url()`, no `@import`, no own network access (`fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon`, `import()`) – apps talk to the Hub only through the SDK. In the Hub, the CSP of the app origins blocks every other host as well. |
| Data from the network (the teacher's word lists, quiz questions and cards, names in leaderboards, saved states) becoming code or markup | The examples set text only with `textContent` / `append(string)`. The test forbids `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `DOMParser`, `eval`, `Function()`, `setTimeout("…")`, `javascript:` addresses, `setAttribute('style'|'on…'|'src'|'href')`, inline scripts, `on…=` attributes and `style=` attributes in HTML. Saved states and settings are checked when read (e.g. only valid word pairs, only known colours in Pixel-Studio). |
| An example bypassing the upload checks or shipping a broken manifest | Every example folder goes through the real checks in a test (`services.createApp` → `createVersion` → `uploads.addDirectory` → `finishVersion`); the report must contain neither errors nor warnings, and the stored manifest must equal `parseManifest(schulhub.json)`. The demo data uploads the examples the same way. |
| Outdated SDK copies in the examples | The test compares `hub-sdk.js` and `hub-ui.css` of every example byte for byte with `sdk/`. (In the Hub, the Hub serves its own copy anyway.) |
| Demo data undermining permissions | Demo data is created only with `--dev` and only on an empty database. State changes go through `classApps.add/submit` and `services.createClass/createJoinCode/notify/audit`; class settings are validated against the app's `schulhub.json` before they are stored; all results carry the 7b's `class_id`. Tests check with the demo data: Lena (no class) gets 404 for the 7b, its results, Mia's app, the assignment and the 7b's apps, and no SDK token; Frau Yilmaz does not see the 7b; Ben cannot open Mia's waiting app; the school-wide release is playable for Lena and her data stays hers. |
| A preview storing real data | The examples say so honestly ("Vorschau – nichts wird gespeichert."); in a preview the Hub keeps everything in memory anyway (`src/sdkStore.js`). |

Tests (`test/examples.test.js`): *Beispiel-Apps: alle sechs da…*, *…schulhub.json ohne Fehler und ohne Warnungen*, *…ruhen nur auf sich selbst*, *…laufen durch die echte Upload-Prüfung*, *Demo-Daten: nur auf leerer Datenbank…*, *…Lena (ohne Klasse) kommt weder an die 7b…*, *…die schulweite Freigabe ist für Lena spielbar…*, *…die Klasseneinstellungen sind gültig…*

### Uploads

| Threat | Handling |
|---|---|
| Code running on the server | Nothing uploaded is ever executed, imported or interpreted. Files are stored as bytes and sent back as bytes. |
| Path traversal | File contents are stored under their SHA-256 hash; names exist only as database rows. No disk path is ever built from an uploaded name. Names are still validated (no `..`, absolute paths, backslashes, control characters, reserved `_hub/`). |
| Archive bombs | Limits on archive size, entry count, per-file and total unpacked size. Sizes are counted while unpacking, not trusted from the header. |
| Symlinks, encrypted or special entries | Rejected. |
| Dangerous file types | Allow-list of extensions; each is served with a fixed content type and `nosniff`. |
| Partial hostile upload left behind | A refused upload is deleted completely. |
| Uploaded content on the Hub origin | Never. The source viewer shows text escaped inside `<pre>`; downloads are `attachment` with a fixed file name. |
| Storage exhaustion | Quotas per file, version, app and account; rate limits on uploads. |

Tests: *Upload: Pfad-Tricks…*, *Upload: bösartige ZIP-Archive…*

### Injection

| Threat | Handling |
|---|---|
| XSS through names, comments, saved data, source code | All HTML is produced by a template function that escapes every value by default. The Hub's CSP is `default-src 'none'; script-src 'self'; style-src 'self'` – no inline scripts or styles exist. Icons and colours are chosen from fixed lists. |
| SQL injection | Prepared statements with bound parameters only. |
| Spreadsheet formula injection | CSV cells starting with `= + - @` are prefixed. |
| Host header tricks | Requests for unknown hosts are refused. |

Tests: *Alles von Nutzern Geschriebene…*, *unbekannte Host-Namen…*

### Abuse and operations

- **Rate limits** on logins, wrong join codes, state-changing requests, uploads, app files and SDK calls. Test: *SDK-Aufrufe werden gebremst*, *Beitrittscodes…*
- **Quotas** per user and app for saves, shared data, results, leaderboards, comments.
- **Audit log** of sign-ins, refused sign-ins, role changes, blocks, uploads, refused uploads, publishing, approvals, rejections, deletions and data exports. Readable by the admin only, pruned after `AUDIT_RETENTION_DAYS`.
- **Errors**: users see a German sentence; details go to the server log only. Test: *Fehlerseiten verraten keine Interna*
- **Secrets** come from environment variables. `.env` and `data/` are git-ignored. Nothing secret is sent to the browser.
- **Dependencies**: six npm packages (`express`, `express-session`, `@azure/msal-node`, `yauzl`, `qrcode-generator`, `diff` – the last one server-side only, for review diffs), no build step. Vendored and self-hosted: CodeMirror 6 (one prebuilt file, `public/vendor/`), the Atkinson Hyperlegible fonts, a Lucide icon subset rendered on the server. Nothing is loaded from another host; the maintainer scripts in `scripts/vendor/` rebuild the vendored files.

### Privacy (minors)

- Stored about a person: name, school e-mail, Microsoft object id, role, class memberships, last sign-in, and what apps saved for them. No IP addresses, no photos, no tracking.
- Teachers see names, not e-mail addresses.
- Leaderboards show a person's name only to people who are in at least one class together
  with that person, and never if the person chose to be anonymous. Everyone else – other
  classes, teachers of other classes, the whole school in a school-wide app – sees "Anonym".
  Test: *Bestenliste: Namen sehen nur Personen aus derselben Klasse…*
- "Meine Daten" shows everything, exports it as JSON, deletes per app or the whole account. Deleting an account removes its rows and anonymises its audit entries. Test: *Meine Daten…*
- Retention (`src/settings.js`, run daily by `services.maintenance`): audit log 365 days; archived
  classes are deleted 12 months after archiving; accounts without sign-in for 15 months are
  only **flagged** for the admin and never deleted automatically; in-Hub notices fade after
  6 months; anonymous daily usage counts after 400 days. The admin can change the periods within
  fixed ranges. Test: *Aufbewahrung…*
- Usage numbers for app authors are anonymous daily counts (`app_usage`: app, day, count) – no
  people, no classes.
- The audit entry for a deleted account names only the role, not the person.

## Where security won over a feature

- **No internet access for apps.** Costs authors the convenience of CDNs. Without it, any app could send student data to a third party.
- **Student app updates need re-approval.** Slower for student authors; otherwise approval would mean nothing.
- **Relative paths only, no top-level app pages.** Needed for per-version access tokens and the sandbox.
- **Class data is written by teachers, app-wide data by the owner.** There is no "everyone can write" shared store, because that is a channel for unmoderated content between minors.
- **No public showcase.** Everything stays behind school sign-in; there is no public route that serves app files.
- **Multiplayer is prepared, not switched on** (see "Still open"): a live channel between minors needs moderation rules first.
- **No short typed join codes.** Joining stays QR code or link with 192-bit codes; a short code would be guessable and is a third way in.
- **Previews never write real data**, even though it would be convenient to keep what a teacher typed while reviewing.
- **Names on leaderboards only within shared classes**, even in school-wide apps.

## Still open

- **Microsoft sign-in was not exercised end to end in development.** The redirect to the tenant authority and the role mapping are tested; the callback (code exchange, `tid` check) is ported from the working example but has not been run against a real tenant in this codebase. Test it with a real school account before going live.
- **Leaderboard scores and results come from the app's code in the student's browser** and can be faked by the student. They are for fun and practice, not for grades.
- **A hostile app can act as the person using it, inside that app** (it holds their short-lived token by design). It cannot reach other apps or the Hub. Teacher review before approval is the control.
- **The SDK token is readable by the app** and contains internal random ids of user and class. These grant nothing and are not personal data, but they are the same across apps.
- **Rate limits and login state are in memory**, per process. Run one process, or move them to a shared store before scaling out.
- **Cookie isolation between Hub and apps** relies on the `__Host-` cookie under HTTPS. Use a separate registrable domain for apps in production. On plain-HTTP localhost this protection is weaker.
- **Frame navigation blocking** was verified in Chromium only. Browsers that do not apply the parent's `frame-src` to later navigations would allow an app to navigate its own frame away (and leak what it knows about its own user).
- **App CSP allows inline scripts, `eval` and WASM** inside the app's own origin, because game engines need them. Containment is the origin and the sandbox, not the app's CSP.
- **No malware scanning** of uploads. Files are only ever delivered to browsers inside the sandbox; a teacher who downloads a zip should treat it like any download.
- **The admin can see everything**, and the database and blobs are not encrypted at rest. Protect the server, backups and the `data/` folder accordingly.
- **Godot/Unity builds that need threads** (cross-origin isolation) are not supported yet.
- **Multiplayer is prepared, not built.** The SDK has `hub.room()`, the API has `room.join`, the
  permission rule exists (`access.canJoinRoom`: active class, app approved there, teacher's
  opt-in `class_apps.multiplayer`), but there is no transport and every call answers
  `not_available`. Questions to settle before switching it on:
  - It is a channel between minors. What may travel (only structured game state, or any text)?
    Who can read it afterwards – nobody (ephemeral), or the teacher?
  - Moderation: can a teacher see who is in a room, mute or end it? What is logged (membership,
    never content)?
  - Abuse limits: message size and rate per person, room size, number of rooms per class.
  - Transport: WebSocket or Server-Sent Events on the app origin, authenticated by the same
    short-lived SDK token; it must die at logout and class removal like the token does today.
  - Preview: a preview must never join a real room.
  - Scaling: rooms live in memory in one process (same limit as rate limits today).
- **Backups contain all personal data and are not encrypted by the Hub.** Whoever holds the zip holds everything. Store it encrypted (e.g. an encrypted disk or `age`/`gpg`) and delete old backups according to the school's rules.
- **Browser backups are limited to ~3.5 GB and 65 000 files** (the zip writer has no ZIP64). Larger installations back up the `data/` folder on the server (stop the Hub, copy the folder).
- **`VACUUM INTO` and `PRAGMA quick_check` block the Hub briefly** on large databases (seconds); run them outside lessons.
- **Two tabs editing the same draft**: the last save wins (no locking).
- **No formal privacy review.** Before real use, the school's data protection officer should check this against the school's obligations.
