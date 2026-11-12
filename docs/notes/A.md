# Package A – changes from the security review and the workflow test

Only the delta to what is already merged into SECURITY.md and README.md.
New permission function in `src/access.js` (block "package A"): `canRemoveFromClass(user, cls, classAppRow)`.

## SECURITY.md

Replace these rows of the package A table:

| Threat | Handling |
|---|---|
| Results leaking between classes | Teacher views (results list, student detail, CSV, overview grid, weekly charts, assignment detail) only count results with `class_id = <this class> OR class_id = ''` (`''` = recorded before version 2, class unknown). Results recorded without any class (`class_id IS NULL`, e.g. at home in a school-wide app) appear in no class view. Tested with one student in two classes and a result made at home. |
| Changes to an archived class | Every change goes through `canChangeClass` (not archived), including the app owner's "remove from class" path: `access.canRemoveFromClass` allows the class's teachers (and the admin), or the app's owner who can see the class – never while archived. Students lose access to the class, its assignments and its apps; restoring brings everything back. Archive / restore are audited (`klasse_archiviert`, `klasse_wiederhergestellt`). |
| Projector page leaking names / showing a dead code | `GET /klassen/:id/qr/status` (polled every 5 s) is teacher-only and returns a number, a sentence built by the server and the state of the code on the screen (valid, expired, deleted, replaced, archived) – never names; `Cache-Control: no-store`. A dead code is replaced by the "no valid code" view at once. The projector page has no navigation. |
| Join code confusion / guessing | Unchanged rules (192-bit, expiring, rate-limited). The confirmation page names class and teachers and joins only on POST. The code of an archived class is refused exactly like a wrong code (same message, counted by the rate limit, no class or teacher names); someone a code is not for (a student with a teacher invitation) gets a refusal without names. Revoking asks first, shows a message and is audited (`beitrittscode_geloescht`); renaming is audited (`klasse_umbenannt`). |

Add this row:

| Threat | Handling |
|---|---|
| One class's teacher deleting another class's data | "Ergebnisse zurücksetzen" deletes only the student's results with `class_id = <this class>`. Results of other classes and legacy results (`''`, not attributable to one class) stay; saves, scores, progress and achievements are the student's own data and stay (deletable in Meine Daten). Tested with one student in two classes. |

Add these test names (`test/teaching.test.js`); each check below was verified by mutation (removing it in a copy makes a test fail):
- Ergebnisse zurücksetzen: nur die Ergebnisse aus dieser Klasse – andere Klassen und persönliche Daten bleiben
- Rechte im Detail: Einstellungen nur für freigegebene Apps, Einzelansicht nur für Schüler/innen dieser Klasse, Entfernen nur durch Lehrkraft oder Besitzer/in
- Beitreten: der Code einer archivierten Klasse verrät nichts – er wird wie ein falscher Code abgelehnt
- Aufgaben: Ergebnisse von vor der Aufgabe zählen nie – auch nicht aus derselben Minute

## README.md

- **Ergebnisse**: Es zählen die Ergebnisse, die in dieser Klasse entstanden sind (und solche von vor der
  Version 2 ohne Klassenangabe) – nie solche, die ganz ohne Klasse entstanden sind, z. B. zu Hause in einer
  schulweiten App. „Ergebnisse zurücksetzen“ löscht nur die Ergebnisse aus dieser Klasse; Spielstände,
  Fortschritt und Erfolge gehören der Schülerin oder dem Schüler (löschbar unter „Meine Daten“).
- **Aufgaben**: Ein Start „jetzt“ oder in der Vergangenheit ist der Moment, in dem die Aufgabe gestellt
  wird – Ergebnisse von davor zählen nie.
- **Beamer-Ansicht**: Wird der Code anderswo gelöscht, läuft er ab oder kommt ein neuer, zeigt die offene
  Beamer-Ansicht das innerhalb weniger Sekunden (mit „Code erzeugen“ bzw. dem neuen Code).
