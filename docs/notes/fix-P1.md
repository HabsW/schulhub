# Fix P1 – app isolation (final security review, findings 1, 2, 3a)

Branch `fix/p1-isolation`. Files: `src/config.js` (`addressProblems`, called from `loadConfig` in real
mode), `.env.example`, `src/appsHost.js` (start page, frame gate, shared-data rule), `src/routes/player.js`,
`public/player.js`, new `sdk/hub-start.js` (the start page's script), new `test/isolation.test.js`.

## SECURITY.md

### App isolation – new rows (append to the table)

| Threat | Handling |
|---|---|
| An app setting cookies for the Hub, or a cookie bomb that locks a browser out of the Hub | Cookies are scoped to a whole registrable domain. In real mode the Hub refuses to start when its host and `APPS_DOMAIN` share a parent domain of two or more labels (`hub.meine-schule.de` + `apps.meine-schule.de` share `meine-schule.de`); the message names a separate domain to use instead (`src/config.js`, `addressProblems`). The only override is `APPS_PUBLIC_SUFFIX` set to exactly that shared suffix, for an operator who confirms it is a public suffix (like `co.uk`). Real mode also refuses a `BASE_URL` without `https://` (only `localhost` and `127.0.0.1` may use `http://`), so the session cookie is always `__Host-` and `Secure`, and `APPS_DOMAIN` must be a plain host name (no scheme, `*`, port or path). |
| The next person on a shared PC finding what an app stored for the previous one (localStorage, IndexedDB – where Godot and Unity save –, caches, service workers, cookies) | Before an app's own code runs, its frame shows a page of the Hub on the app's origin: `GET /~<file token>/_hub/start` (uploads can never create `_hub/` paths, any letter case). It needs a valid file token for exactly that app and carries a marker for the person the token was issued to: an HMAC of app id and user id with the session secret (`tokens.pseudonym('storage', …)`) – never a name, e-mail or id, the same in every session, different in every app. Its script is a Hub file (`/_hub/start.js` = `sdk/hub-start.js`, external, cacheable by content hash); the page has its own CSP (`default-src 'none'; script-src 'self'`, `frame-ancestors` the Hub, sandbox), `nosniff`, `no-store`. If the marker kept in the origin's `localStorage` differs (or is missing), the script deletes localStorage, sessionStorage, every IndexedDB database (`indexedDB.databases()`), Cache Storage, service worker registrations, the origin private file system and every cookie scripts can see (with `Domain=` of every parent label), then keeps the new marker. The same person again: nothing is touched, so a pupil's own device keeps its saves. Then it tells the Hub page by `postMessage` – to the Hub origin only – and the Hub page loads the app (`public/player.js`; only an address on that app's origin, with `location.replace`). The player holds its frame in a `<template>` until then. Pages that frame an app with a plain file token (review workbench, editor preview, any later page) are sent through the start page by the app origin itself: a frame navigation (`Sec-Fetch-Dest: iframe`) with a token not marked `r: 1` gets a 303 to it; only the player and the start page (a copy of the token with `r: 1`) issue marked tokens. A cleanup that cannot finish (a database still open in another tab, an API that does not answer within 3 s) lets the app start but keeps no marker, so the next start clears again. Cost, measured in Chromium (loopback, median of 15, page start → app loaded): player 16 → 24 ms, review 18 → 26 ms, editor 16 → 29 ms; after another person's leftovers +9 ms (the cleanup itself takes about 2 ms). *(browser: the review's repro – Sina's diary in localStorage – is gone for Pia; all six example apps load and save in the player, the review preview and the editor preview, also after "reload", without console errors)* |
| A student changing what classmates see after approval, without a new review (app-wide shared data) | `hub.shared` reaches everyone who opens the app and nobody reviews it. Writing it (`shared.set`, `shared.remove`) is allowed only in apps whose owner is staff (teacher or admin) – by the owner or the admin, as before. In an app of a student every write is refused for everybody (owner, classmates, teachers, admin), in previews too, with the code `read_only` and a German message; reads are unchanged. Class data (`hub.classData`) stays with the class's teachers in any app. |

Tests (`test/isolation.test.js`): *Adressen: Hub und Apps unter derselben Domain – der Hub startet nicht
und sagt, was zu ändern ist*, *Adressen: APPS_PUBLIC_SUFFIX erlaubt nur genau die gemeinsame öffentliche
Endung*, *Adressen: echter Betrieb nur mit https (außer localhost); APPS_DOMAIN ist ein reiner
Domainname*, *Adressen: die Beispielwerte in .env.example halten die Regeln ein*, *Startseite: nur mit
gültigem Datei-Link genau dieser App – fremde, abgelaufene und gefälschte Links werden abgewiesen*,
*Startseite: die Markierung ist je Person und je App verschieden, für dieselbe Person immer gleich – und
nichts Persönliches*, *Startseite: Rahmen mit einfachem Link (Prüfplatz, Editor) gehen erst über sie; der
Player hält sein Fenster bis dahin zurück*, *Uploads können nie einen Pfad unter _hub/ anlegen*,
*Startseite (Skript): für eine andere Person wird alles gelöscht, für dieselbe nichts; die Meldung geht nur
an den Hub* (runs `sdk/hub-start.js` against fake browser storage), *Daten für alle: in Apps von
Schüler/innen schreibt niemand – auch nicht die Besitzerin nach der Freigabe*, *Daten für alle: in Apps von
Lehrkräften wie bisher – Besitzer/in und Admin schreiben, alle lesen*. Each attack test fails when its
check is removed (verified one by one: address rules, https rule, frame gate, start page, the cleanup, the
marker comparison, the shared-data rule, the player's held frame, the player's marked token).

### App isolation – changed row (replace the first sentence of "App reads Hub cookies, pages or DOM")

> Each app has its own origin (`<random key>.<apps domain>`) on a registrable domain of its own – the Hub refuses to start when the apps domain shares a parent domain with the Hub (see below). No Hub cookie is ever sent there.

### Where security won over a feature (replace the bullet "Class data is written by teachers, app-wide data by the owner.")

- **Class data is written by teachers, app-wide data only in teachers' apps.** A student's app cannot store anything all its users see (`hub.shared` is read-only there), even though a pupil's high-score message or level editor would be fun. Without it, the owner of an approved app could show the whole class anything, unreviewed.
- **Another person's browser data is removed before an app starts.** On a shared PC the next pupil loses nothing of their own, but an app's offline cache (e.g. Unity's) is downloaded again after a change of person.

### Still open (replace the bullet "Cookie isolation between Hub and apps relies on the `__Host-` cookie …" with the first one; add the others)

- **Apps share one apps domain.** Every app has its own origin, but all are subdomains of one registrable domain (`APPS_DOMAIN`). In one browser an app can set cookies for that whole domain and disturb the other apps – up to a cookie bomb after which every app answers 431 for months in that browser. The Hub itself is safe (it must be on another registrable domain, enforced at start). The start page deletes such cookies when a different person starts an app, but only if its own request still gets through. The complete fix is to put the apps domain on the Public Suffix List, so browsers treat every app as a site of its own. (Locally, `*.apps.localhost` is cross-site to the Hub, and apps cannot set cookies at all.)
- **Apps can tell that they run in a preview** (`hub.mode`, `user.isTeacher`), so a hostile submission can behave harmlessly while a teacher reviews it and differently after approval (review finding 9). Reviewing the code, not only the behaviour, is the control; the workbench shows the source and the changes.
- **Browser storage between two starts.** What an app stored stays in the browser until that app is started again; the start page removes it only then, and only for a different person. A tab left open after logout keeps its app running until it is closed (the app cannot reach the Hub any more – its token dies with the session – but could read what the next person's copy of that app stores meanwhile). A pupil with developer tools on the same PC can read leftovers before the start page runs. On shared PCs, use the browser's guest mode or let it clear browsing data on exit.
- **Previews in the review workbench and the editor rely on Fetch Metadata** (`Sec-Fetch-Dest`) to be sent through the start page. Browsers without it (Safari before 16.4) show those previews without the storage check. The player does not depend on it.
- **App-wide data written before this change** in apps of students stays readable to their users, and nobody can change or delete it through the SDK any more.

## README.md

**Echter Betrieb, Schritt 3 (ersetzt den bisherigen Text):**

3. **Zwei Domains, HTTPS davor**: der Hub (z. B. `hub.meine-schule.de`) und eine **eigene Domain** für
   die Apps (z. B. `meine-schule-apps.de`, mit Wildcard-DNS `*.meine-schule-apps.de` und
   Wildcard-Zertifikat). Die App-Domain darf nicht unter der Domain des Hubs liegen – also nicht
   `apps.meine-schule.de`: Dann könnte jede App Cookies setzen, die der Hub bekommt, und Browser
   aussperren. Mit so einer Adresse startet der Hub nicht. `BASE_URL` beginnt immer mit `https://`.
   Beide zeigen über einen Reverse-Proxy (Caddy, nginx …) auf denselben Node-Prozess; der Proxy muss den
   `Host`-Header unverändert durchreichen. `TRUST_PROXY=1` setzen.

**Schritt 4 (ersetzt den bisherigen Text):**

4. Ohne vollständige und sichere Konfiguration startet der Hub nicht und sagt, was zu ändern ist.

**Neuer Absatz nach den Schritten (für den Betrieb):**

Gemeinsam genutzte PCs: Bevor eine App für eine andere Person startet, löscht der Hub, was die App im
Browser für die vorige Person gespeichert hat (Spielstände, Einstellungen, Cookies). Für dieselbe Person
bleibt alles erhalten. Wo sich viele einen PC teilen, nutzt trotzdem den Gastmodus des Browsers oder lasst
die Browserdaten beim Schließen löschen.

**Tabelle „Was das SDK kann“, Zeile `hub.classData.*`, `hub.shared.*` (ersetzt die Beschreibung):**

| `hub.classData.*`, `hub.shared.*` | Daten für eine Klasse (die Lehrkraft schreibt) und für alle Nutzer der App (schreiben kann nur, wem die App gehört, und nur in Apps von Lehrkräften – in Apps von Schüler/innen sind sie nur lesbar) |

**Regeln für Apps, neuer Punkt (am Ende der Liste):**

- **Browser-Speicher gehört der Person, die die App gerade benutzt.** Was deine App selbst im Browser
  speichert (`localStorage`, IndexedDB …), löscht der Hub, bevor sie für jemand anderen startet. Dafür
  merkt er sich in `localStorage` den Eintrag `schulhub:person` – lösch ihn nicht (`localStorage.clear()`
  löscht ihn mit), sonst räumt der Hub beim nächsten Start alles auf. Was sicher bleiben soll, gehört in
  `hub.save`.

## Requests to the lead (files I do not own)

1. **`src/sdkReference.js`, group `shared`** – replace `intro` and `local`, add `read_only` to
   `setErrors`, and add one row to `errors` right after `forbidden`:

   ```js
   intro: 'Daten für alle, die deine App benutzen – zum Beispiel Level oder eine Wortliste. Alle lesen. Schreiben kann nur, wem die App gehört (oder der Admin), und nur in Apps von Lehrkräften: In Apps von Schüler/innen sind diese Daten nur zum Lesen da, `set` und `remove` enden dort immer mit `read_only`. Für alle anderen enden sie mit `forbidden`.',
   local: 'Lokal darf die Testperson schreiben; gespeichert wird im Browser. Im Hub geht das nur in Apps von Lehrkräften.',
   setErrors: ['bad_key', 'bad_value', 'too_large', 'quota', 'forbidden', 'read_only'],
   // in `errors`, after 'forbidden':
   ['read_only', 'In Apps von Schüler/innen kann niemand Daten für alle speichern (`hub.shared`) – sonst sähe die ganze Klasse Texte, die keine Lehrkraft geprüft hat.'],
   ```

2. **`src/routes/docs.js` line 147** – replace the sentence after the first one with:

   ```html
   Texte, die andere lesen, schreibt nur die Lehrkraft (<code>hub.classData</code>, in Apps von Lehrkräften auch <code>hub.shared</code>).
   ```

3. **`templates/spielwiese/index.html` line 41** – replace with:

   ```html
   <p class="hub-muted">Alle lesen. Schreiben kann nur, wem die App gehört – und nur in Apps von Lehrkräften. In der Spielwiese einer Schülerin oder eines Schülers endet <code>set</code> deshalb mit <code>read_only</code>.</p>
   ```
4. **Optional, `src/routes/review.js` and `src/routes/studio.js`**: they work as they are (the app origin sends their plain frames through the start page: one 303 more, about 1 ms locally, and it needs `Sec-Fetch-Dest`). To drop both, render the frame like the player does – `<template id="appframe-hold" data-start="${origin}/~${fileToken}/_hub/start"><iframe id="appframe" … src="${origin}/~${fileToken}/index.html" …></iframe></template>` with `r: 1` in that token; `public/player.js` handles it. In the editor, keep `GET /studio/:id/vorschau` returning a **plain** token (as now), because `public/studio.js` sets `frame.src = d.src` directly.
5. **Decide**: delete app-wide data that students wrote into their own apps before this change (`DELETE FROM shared_data WHERE class_id = '' AND app_id IN (SELECT a.id FROM apps a JOIN users u ON u.id = a.owner_id WHERE u.role = 'student')`), or leave it read-only as now.
