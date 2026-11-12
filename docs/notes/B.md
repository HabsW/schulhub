# Package B – security review round: notes for the lead

## SECURITY.md

Additions to "Apps, uploads and review (package B)":

| Threat | Handling |
|---|---|
| A hostile upload stalling the Hub through the upload checks (they run synchronously in `services.finishVersion`) | `src/checks.js` reads HTML in **one linear pass**: a hand-written scanner splits every tag into its attributes once; a tag that does not end within 4 KB is skipped from where its scan stopped, so nothing is read twice. Scripts and style sheets are searched with patterns whose parts cannot overlap, and every look-ahead after a match is bounded and never revisited. On top, a **hard time budget of 40 ms per version** is checked inside the scan; when it is used up, the check stops and the report says "Prüfung abgebrochen – zu große Dateien". Measured: the slowest 512 KB file went from 591 ms to 8 ms; eight such files in an 11 KB zip from 4.7 s to 11 ms. |
| Large upload bodies buffered before the permission check (`PUT /apps/:id/versionen/:vid/datei`) | A middleware runs **before** `express.raw`: the app is loaded and checked with `canManageApp`, the version must belong to it and still be uploading, the content type must fit, and `limiter.guard('uploadFiles')` applies. A refused request is answered at once with `Connection: close`, so a stranger's body is never buffered (12 × 25 MB: RSS +0 MB, before +290 MB). The zip route already refuses before reading and streams to a temp file. |
| Comments deleted by the wrong person | `access.canDeleteComment` (package B block): only a plain comment, only by its author or the admin; decisions stay as the review record. `access.isAppOwner` decides the owner's own steps (submit, withdraw, take out) – the admin manages apps but does not act as their owner. |
| Usage numbers describing single persons | With fewer than five people who opened the app in 30 days, the owner sees neither the openings per day (chart) nor the total of openings – like the number of people and the average result. |

Tests (`test/review.test.js`, new): *Prüfbericht: feindliche Dateien blockieren den Hub nicht – lineare Prüfung mit Zeitbudget*, *Datei-Upload: Fremde werden abgewiesen, bevor der Inhalt gelesen wird*, *Kommentare löschen: nur die eigene – oder die Verwaltung; Entscheidungen bleiben*, *Veröffentlichen ohne Klasse sagt, wer die App öffnen kann*; *Nutzung…* now also covers the hidden daily chart. Each new attack test fails when its check is removed (verified: the reviewer's comment mutation, `express.raw` before the check, the old `checks.js`).

## Not in package B

The reviewer's t8-dos (c) – 60 withdraw + resubmit cycles create 60 teacher notices and history rows – needs a limit in `src/classApps.js` (`submit`) or a rate bucket in `src/config.js`; both are foundation files.
