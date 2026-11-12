# Package A – Klassen & Unterricht

Class pages, joining, the projector view, results, assignments, feedback,
co-teachers, archive and per-class app settings. Routes: `src/routes/classes.js`,
`src/routes/results.js`, `src/routes/teaching.js`; shared helpers in
`src/teachingKit.js`; page CSS `public/css/teaching.css`; page JS `public/teaching.js`.
New permission functions in `src/access.js` (block "package A"): `canLeaveClass`,
`canSeeClassResults`, `canMarkFeedbackRead`.

## SECURITY.md

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

## README.md

### Klassen und Unterricht

- **Klassen anlegen** (Lehrkräfte): „Neue Klasse“ – Name, optional Fach und Klassenstufe. Die Klasse
  bekommt sofort einen Beitrittscode (1 Tag gültig).
- **Beitreten lassen**: Die Klassenseite hat oben „Beitreten lassen“. Das öffnet eine Ansicht für den
  Beamer (ohne Navigation, mit Vollbild): großer QR-Code, der Link als Text, „gültig bis …“ und eine
  Live-Zahl, wie viele schon beigetreten sind. Schüler/innen sehen vor dem Beitritt eine Bestätigung mit
  Klasse, Lehrkraft und einem Satz zum Datenschutz. Lehrkräfte fügen niemanden von Hand hinzu.
- **Klassenseite für Lehrkräfte** – Bereiche:
  - *Überblick*: wartende Einreichungen zuerst, Zahlen der Woche, Ergebnisse pro Woche, laufende
    Aufgaben und ein Raster „Wer ist wie weit?“ (Fortschritt oder bestes Ergebnis jeder Person in jeder
    App, höchstens 12 Apps; auf dem Handy eine Karte pro Person).
  - *Aufgaben*: laufende, geplante und abgelaufene Aufgaben mit erledigt / begonnen / offen.
  - *Apps*: Einreichungen von Schüler/innen (zur Prüfung), die Apps der Klasse mit Ergebnissen,
    Aufgabe stellen, Einstellungen und Entfernen; entfernte Apps lassen sich zurückholen; „App
    hinzufügen“ zeigt eigene, von Kolleg/innen geteilte und schulweite Apps.
  - *Mitglieder*: Schüler/innen mit Beitrittsdatum und letzter Aktivität; Lehrkräfte; Einladung für
    eine zweite Lehrkraft (Link, optional als QR-Code, nur für Lehrkraft-Konten).
  - *Einstellungen*: Name, Fach, Klassenstufe; Beitrittscode (neu erzeugen mit Gültigkeit, löschen);
    Archivieren; Klasse verlassen (nur wenn eine weitere Lehrkraft bleibt); Klasse löschen.
- **Aufgaben**: eine App der Klasse, ein Titel (sonst der App-Name), eine Notiz, Start (Standard: jetzt)
  und optional ein Termin. Die Schüler/innen bekommen eine Mitteilung. Erledigt ist eine Aufgabe, sobald
  nach dem Start ein Ergebnis gespeichert oder voller Fortschritt erreicht ist – oder wenn die Person
  sie selbst als erledigt markiert.
- **Ergebnisse** einer App in einer Klasse: Tabelle aller Schüler/innen (Filter „Nicht begonnen“),
  Ergebnisse pro Woche, Einzelansicht pro Person mit Blättern, lesbaren Feldnamen (aus
  `results.labels` in `schulhub.json`) und ✓/✗; CSV-Export mit Fortschritt. Es zählen nur Ergebnisse,
  die in dieser Klasse entstanden sind (oder vor der Version 2 ohne Klasse gespeichert wurden).
- **Rückmeldungen**: Lehrkräfte schreiben einer Person privat (bei den Ergebnissen oder bei einer
  Aufgabe). Schüler/innen finden alle unter „Rückmeldungen“ (`/rueckmeldungen`), können sie als gelesen
  markieren und löschen.
- **Archiv** (Schuljahresende): Die Klasse wird schreibgeschützt und für Schüler/innen unsichtbar. Sie
  wird nach der in der Verwaltung eingestellten Frist (`retention.archivedClassDays`, Standard 365
  Tage) automatisch gelöscht; bis dahin lässt sie sich zurückholen.
- **Einstellungen einer App pro Klasse**: Wenn eine App in `schulhub.json` `settings` erklärt, zeigt
  die Klasse bei der App „Einstellungen“ (Text, Zahl, Ja/Nein, Auswahl, Liste, Paare „links = rechts“).
  Die App liest die Werte mit `hub.settings` – nur in dieser Klasse.
