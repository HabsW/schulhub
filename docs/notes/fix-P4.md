# Fix P4: tests for checks that had none

New file `test/regressions.test.js` with 13 attack tests. No production code was changed.
The final review found these checks by mutation testing: the checks could be removed and the
whole suite still passed. Each test below now fails when its check is removed or weakened.
This was proven by changing the code one mutation at a time, running the whole suite, and then
restoring the code. 37 mutations: 37 caught, `git diff -- src/` empty afterwards.

| Test (`test/regressions.test.js`) | Check it protects | Mutations that now fail it |
|---|---|---|
| *Archivierte Klassen: Schüler/innen öffnen deren Apps auch ohne ?klasse= nicht mehr, und die Suche nennt sie nicht* | `access.resolvePlay` (archived filter on the class route without `?klasse=`), `access.visibleClasses` (archived classes only for their teachers; `/suche`) | A19, A37 |
| *Abgelaufene Tokens: ein alter Datei-Link und ein altes SDK-Token werden abgelehnt* | `tokens.verify` expiry | B08, expiry check reduced to "`exp` is a number" |
| *Rückkehr nach der Anmeldung: //fremd und /\fremd führen auf /start – bei Test- und Microsoft-Anmeldung* | `auth.establishSession` return target (local paths only) | B17, regex reduced to `^/`, backslash not excluded |
| *Sitzungen enden nach der festen Höchstdauer – auch wenn der Speicher sie noch länger hielte* | absolute session lifetime (`createdAt` + `sessionMs`) in `src/app.js` | B04, lifetime doubled, session without `createdAt` treated as fresh |
| *Testmodus hört nur auf dem eigenen Rechner (127.0.0.1, ::1) – auch wenn LISTEN_HOST gesetzt ist* | `loadConfig().listenHosts` in dev mode | B77 |
| *Speicherplatz pro Konto (maxUserBytes) gilt für Uploads – Datei für Datei und als ZIP, über alle Apps* | `uploads.addFile` account quota | B47 |
| *Microsoft-Rückmeldung (src/auth.js): Zustand, Code, Mandant und Einmal-Gebrauch werden geprüft* | `auth.handleCallback`: state, code, `error`, `tid`, `oid`, single use; tenant authority | B19, B20, flow not deleted, code type unchecked, `error` ignored, missing `oid`/state accepted, authority `common` |
| *Microsoft-Anmeldung über die echten Routen: falscher Zustand und fremder Mandant scheitern, der Ablauf gilt einmal* | the same through `/auth/login` and `/auth/callback` | B19, B20, flow not deleted, code type unchecked |
| *Hub-CSP: default-src 'none', Skripte und Stile nur von 'self' – auf jeder Art von Seite* | `hubHeaders` CSP on landing, start, class, app page, player, 404, 400 and redirect responses | B09, `style-src 'unsafe-inline'`, `default-src 'self'`, extra script host, extra style host, `script-src-attr 'unsafe-inline'`, `'unsafe-eval'`, `script-src *` |
| *Allgemeine Schreibgrenze (rate.write): 429 über der Grenze – nur für diese Person* | `limiter.guard('write', user)` in `src/app.js` | B02, one bucket for everybody |
| *Upload-Start-Grenze (rate.uploadVersions): 429 über der Grenze – nur für diese Person* | `limiter.guard('uploadVersions', user)` on `POST /apps/:id/versionen` | B49, one bucket for everybody |
| *Token-Arten sind getrennt: Datei-Link und SDK-Token gelten nie füreinander* | per-kind token keys (`schulhub-token:<kind>`), `verify('files')` and `verify('sdk')` | B07, file route also accepting SDK tokens, SDK API also accepting file tokens |
| *Sitzungsspeicher: die Sitzungs-ID aus dem Cookie steht nirgends in der Datenbank – und kein App-Token verrät sie* | `sidHash` in `src/sessions.js` | B78, raw id stored inside the session data |

How the Microsoft tests work: a stand-in for `@azure/msal-node` goes into `require.cache` only while
`createAuth` runs, and is removed right after. The stand-in has a fake `ConfidentialClientApplication`
whose token endpoint answers every code with claims the test chooses, plus a fake `CryptoProvider`.
Everything in `src/auth.js` and in the routes is the real code. The mutation script is
`scratchpad/fix/P4/mutate-p4.js`. It reuses the reviewer's `mutations.js` (A19, A37, B02, B04, B07,
B08, B09, B17, B19, B20, B47, B49, B77, B78) and adds 23 extra mutations.

## SECURITY.md

Paste these lines under the existing tables:

- Under **Sign-in and sessions**, add to the `Tests:` line: *Rückkehr nach der Anmeldung: //fremd und /\fremd führen auf /start…*, *Sitzungen enden nach der festen Höchstdauer…*, *Testmodus hört nur auf dem eigenen Rechner…*, *Microsoft-Rückmeldung (src/auth.js): Zustand, Code, Mandant und Einmal-Gebrauch…*, *Microsoft-Anmeldung über die echten Routen…*, *Sitzungsspeicher: die Sitzungs-ID aus dem Cookie steht nirgends in der Datenbank…* (`test/regressions.test.js`; Microsoft's library is replaced by a stand-in, and `src/auth.js` runs unchanged)
- Under **Permissions**, add to the `Tests:` line: *Archivierte Klassen: Schüler/innen öffnen deren Apps auch ohne ?klasse= nicht mehr, und die Suche nennt sie nicht* (`test/regressions.test.js`)
- Under **App isolation**, add to the `Tests:` line: *Abgelaufene Tokens…*, *Token-Arten sind getrennt: Datei-Link und SDK-Token gelten nie füreinander* (`test/regressions.test.js`)
- Under **Uploads**, add to the `Tests:` line: *Speicherplatz pro Konto (maxUserBytes) gilt für Uploads…* (`test/regressions.test.js`)
- Under **Injection**, add to the `Tests:` line: *Hub-CSP: default-src 'none', Skripte und Stile nur von 'self' – auf jeder Art von Seite* (`test/regressions.test.js`)
- Under **Abuse and operations → Rate limits**, add to the `Tests:` line: *Allgemeine Schreibgrenze (rate.write)…*, *Upload-Start-Grenze (rate.uploadVersions)…* (`test/regressions.test.js`)
- In **Still open**, replace the first sentence of the Microsoft bullet's explanation with: "The redirect to the tenant authority, the role mapping and the callback's own checks (state, code, Microsoft error, `tid`, `oid`, single use) are tested with a stand-in for Microsoft's library. The code exchange itself has not been run against a real tenant in development."
- Optional row for **Sign-in and sessions** (only if the lead changes `src/sessions.js`, see the P4 report): "SDK token after the absolute session end | The session store's expiry is capped at the session's start + 8 hours, so the SDK API refuses the session's tokens from then on, even without another Hub request."

## README.md

Nothing for operators or users.
