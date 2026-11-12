# Package D – Schule & Verwaltung: notes for SECURITY.md and README.md

## SECURITY.md

New section "School pages, Meine Daten and Verwaltung" (package D):

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

For "Still open":

- **Backups contain all personal data and are not encrypted by the Hub.** Whoever holds the zip holds everything. Store it encrypted (e.g. an encrypted disk or `age`/`gpg`) and delete old backups according to the school's rules.
- **Browser backups are limited to ~3.5 GB and 65 000 files** (the zip writer has no ZIP64). Larger installations back up the `data/` folder on the server (stop the Hub, copy the folder).
- **`VACUUM INTO` and `PRAGMA quick_check` block the Hub briefly** on large databases (seconds); run them outside lessons.

## README.md

### Verwaltung (für den Admin)

Unter **Verwaltung** (nur für Admins):

- **Übersicht** – Zahlen auf einen Blick (Konten nach Rolle, Klassen, Apps, wartende Prüfungen und schulweite Updates, lange nicht benutzte Konten), Speicherbelegung des Datenordners mit den größten Konten und Apps, Zustand des Servers und **Datenbank prüfen**.
- **Konten** – Suche, Filter (Rolle, gesperrt, inaktiv markiert), 50 pro Seite. Rolle ändern, sperren und löschen auf der Seite eines Kontos – jeweils mit einer Rückfrage, die sagt, was passiert. Das letzte Admin-Konto lässt sich nicht herabstufen.
- **Klassen** – aktive und archivierte Klassen; archivieren, wiederherstellen, löschen.
- **Apps** – Stand jeder App, schulweite Freigabe an/aus, wartende schulweite Updates (freigegeben wird auf der Seite der App).
- **Protokoll** – alle wichtigen Vorgänge auf Deutsch, filterbar nach Vorgang, Person und Zeitraum.
- **Aufbewahrung** – Fristen und die Liste der lange nicht benutzten Konten.
- **Sicherung** – Sicherung herunterladen, Anleitung zum Wiederherstellen.

Ankündigungen an die ganze Schule (oder eine Klasse) schreibt der Admin unter `/ankuendigungen`; Lehrkräfte schreiben dort an ihre eigenen Klassen.

### Sicherung

**Verwaltung → Sicherung → „Sicherung herunterladen“** erzeugt eine ZIP-Datei mit allem, was der Hub
gespeichert hat: die Datenbank (`hub.sqlite`, eine in sich stimmige Kopie), alle App-Dateien
(`blobs/`) und alle Dateien, die Apps für Personen gespeichert haben (`userfiles/`). Der Hub läuft
dabei weiter. Geheimnisse (`.env`, `SESSION_SECRET`) sind **nicht** enthalten – sichere sie getrennt.

- Die Sicherung enthält **alle personenbezogenen Daten**. Bewahre sie verschlüsselt auf und nur dort,
  wo ausschließlich Befugte Zugriff haben. Lösche alte Sicherungen nach den Vorgaben der Schule.
- Empfehlung: jede Woche eine Sicherung. Die Übersicht erinnert, wenn die letzte älter als 7 Tage ist.
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

Das Werkzeug prüft das Archiv **vollständig, bevor es etwas schreibt**: nur erlaubte Dateinamen, keine
Verknüpfungen, begrenzte Größen, genug freier Platz, die Prüfsumme jeder Datei und eine gültige
SchulHub-Datenbank (keine neuere Version als der Hub). Erst dann werden die Daten an ihren Platz
gelegt. Aus dem Archiv wird nie etwas ausgeführt. Ohne `--data` gilt `DATA_DIR` aus `.env`, sonst `data/`.

### Aufbewahrung

Unter **Verwaltung → Aufbewahrung** stellt der Admin ein (innerhalb fester Grenzen):

| Was | Standard | Erlaubt |
|---|---|---|
| Protokoll aufbewahren | 365 Tage | 30–3650 |
| Archivierte Klassen löschen nach | 365 Tagen (ab dem Archivieren) | 30–3650 |
| Inaktive Konten markieren nach | 456 Tagen ohne Anmeldung (≈ 15 Monate) | 90–3650 |

Fest: Mitteilungen im Hub 180 Tage, abgelaufene Ankündigungen 30 Tage nach Ablauf, anonyme
Nutzungszahlen 400 Tage, Anmeldung 8 Stunden. Die Prüfung läuft beim Start und dann täglich.
**Konten werden nie automatisch gelöscht** – markierte Konten erscheinen in der Verwaltung, und der Admin
entscheidet. Mit der nächsten Anmeldung verschwindet die Markierung.

### Für alle

- **Darstellung** (Menü am Profilbild): Farbschema (wie das Gerät, dunkel, hell), Schriftgröße, weniger
  Bewegung, hoher Kontrast; außerdem „In Bestenlisten anonym“. Gilt auf allen Geräten.
- **Meine Daten**: alles, was der Hub über dich speichert – ansehen, als Datei herunterladen, die Daten
  einer App oder das ganze Konto löschen. Dateien aus Apps (z. B. Bilder) lädst du bei der App herunter.
- **Suchen** (Lupe oben): Apps und Klassen; Lehrkräfte finden auch die Schüler/innen ihrer Klassen.
- **Entdecken**: alle Apps, die du öffnen kannst, mit Filtern nach Fach, Klassenstufe und Herkunft.
  Lehrkräfte fügen Apps dort direkt einer ihrer Klassen hinzu.
