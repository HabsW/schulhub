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

### Editor drafts

| Threat | Handling |
|---|---|
| Changing code after approval through the editor | The editor writes to one mutable **draft** per app (`app_drafts`, `draft_files`), never to a version. "Save as version" copies the draft's rows into a new version, which is immutable like any upload and goes through the same publish and review rules. |
| Draft files bypassing upload rules | Every draft write goes through the same path, extension, size, file-count, version-size and account-quota checks as uploads (`uploads.putDraftFile`). Drafts count toward the account quota. |
| Others reading a draft | Draft files are served only with a file token that names the draft (`d: 1`) for exactly that app, issued after `canManageApp`; never cached (`no-store`). A version token never reads draft files and vice versa. Draft previews always use the in-memory SDK store. |
| Deleting a draft deleting a version's files | Content blobs are shared; garbage collection keeps a blob while any version or draft references it. |

Tests: *Editor-Entwurf…*

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
- **Dependencies**: five, no build step.

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
- **No formal privacy review.** Before real use, the school's data protection officer should check this against the school's obligations.
