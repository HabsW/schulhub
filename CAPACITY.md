# SchulHub at school size: capacity and reliability

The question: does SchulHub hold up for about **1,000 students and 100 teachers** – students in one class,
in several and in none – as if it went live tomorrow? Target: **three times the expected peak with zero
errors, no lost or mixed-up data, and p95 under 300 ms.** This file says how that was checked, what was
found and changed, what the numbers are, and what is still risky. Sicherheit: [SECURITY.md](SECURITY.md).

## In short

- **It holds, with a wide margin, on the machine tested** (details and numbers below). At 3× the expected peak:
  0 errors, every confirmed write checked in the database, p95 below 1 ms for the app API and below
  300 ms for every page and step a person waits on. The fixed Hub saturates at about **66×** the expected
  peak on this machine; the code before this work saturated at about **7×**.
- **What broke first before:** every single write (a save, a result, a sign-in) waited for the disk to
  flush, on the Hub's only thread. That capped the whole school at about 900 requests per second here,
  and much lower on the slower disks of virtual servers. Fixed (`synchronous=NORMAL`, deletions still
  flushed).
- **What breaks first now:** the CPU of the one Node.js thread. Nothing errors when it is full – answers
  queue and get slower. Measured limit here: about 8,400 app requests per second.
- **Other freezes found and removed:** deleting a popular app or its owner's account (0.6 s, and up to
  3.8 s with a year of feedback notices), lowering the audit retention (1.8 s), backup copy and database
  check (on the Hub thread), deletions that read whole tables (20 foreign keys without an index), a
  teachers' start page that read every result of each class; the backup download no longer needs memory
  the size of the database.
- **Bugs found on the way:** 50+ real bugs by a state × action matrix, race tests, property-based tests of
  every permission rule and five independent bug hunts – each fixed with a test that fails without the fix
  (list in the report and in SECURITY.md).
- **Not proven here:** a real Microsoft tenant, a real school network, a slower server, power cuts
  (see *Still risky*).

## How the Hub uses the machine

One Node.js process answers everything. Its database, `node:sqlite`, is **synchronous and runs on that
same thread**: while one query runs, no other request of the school is served. That makes three rules:

1. **No request does work that grows with the school.** Every query a page or an app call makes reads
   only the rows it needs, through an index. A whole-table read is fine for a 48-row table and a freeze
   for a 250,000-row one.
2. **No write waits for the disk.** With the default `synchronous=FULL` a commit waits for an `fsync`, and
   the whole Hub waits with it.
3. **Long jobs leave the thread or go in small steps.** A backup copy, an integrity check or deleting tens
   of thousands of rows run in a worker thread or in batches with pauses between them.

## What was found and changed

The architecture was reviewed twice, independently (by the lead and by a separate reviewer), with
`EXPLAIN QUERY PLAN` of every statement the test suite runs (838 distinct statements, 68 with full-table
scans) and timings on the large dataset below. The independent reviewer also built denser data of its own
(six and twelve months of use: 493,000 and 963,000 results, 350,000 audit entries, 114,000 notices, a
684 MB and a 956 MB database) and measured the single operations and a 1× and 3× load on it – which is
how the second half of this table was found.

| Problem | Before | Change | After |
|---|---|---|---|
| Every commit waited for the disk (`synchronous=FULL`, WAL) | ~1 ms per write here, the Hub stopped meanwhile; 31 % of the server's time at 3× peak went to waiting for the disk; ceiling ~900 requests/s | `PRAGMA synchronous = NORMAL` (WAL stays; consistent after any crash; a process crash or `kill -9` loses nothing). Deletions are flushed anyway: `db.tx(fn, { durable: true })` | 0.1 ms per write; server busy 8 % at 3× peak |
| 20 foreign-key columns without an index | deleting a person, app or class made SQLite read whole child tables (ON DELETE); start page, quotas and Meine Daten read whole tables | migration 5: an index for every foreign key, plus results by class and time, notices by link, audit log by action; `PRAGMA optimize` at start and daily; a test fails if a new foreign key comes without an index | no deletion or hot query reads a whole table (tested by query plan) |
| Deleting an app with tens of thousands of results (or its owner's account) | one transaction, 613–674 ms here with 34,000 results, everybody waiting | the bulky rows go first in batches of 1,000 with a pause between them; the final transaction deletes the rest | longest stall < 30 ms |
| Backup copy (`VACUUM INTO`) and „Datenbank prüfen“ (`quick_check`) on the Hub thread | 146 ms / 74 ms here on a warm 300 MB database – seconds on a slow server or a cold disk | both run in a worker thread with their own connection; while the copy is made, no content file is deleted (it waits), so the backup always matches its files | the Hub keeps answering |
| Notices of a deleted app found by scanning every notice (once per app in an account deletion) | a full scan of `notices` per app | range on the indexed link | index |
| Teachers' start page: activity of each class read every result of the class | 44 ms of the admin's 70 ms start page | index on results by class and time | – |
| A file upload checked before its body was read could land in a version that was finished – and approved – meanwhile | a class could run code no teacher saw | `uploads.addFile` checks again in the same synchronous step as the insert | tested |
| Deleting an app (or its owner) searched the notices of every student who ever got feedback about it, once per app name and assignment title | 3.8 s stall for a long-serving teacher, 1.5 s for a popular app (independent review, six months of data) | a feedback's notice carries the feedback's own link; deleted through the index, one statement per feedback | ≤ 1 text search, for notices from before the change |
| The backup download read every file – also the database copy – whole into memory | 1.0 GB RAM for a 670 MB database copy; fails from 2 GiB (`ERR_FS_FILE_TOO_LARGE`) | file entries are read, deflated and sent piece by piece (data descriptor) | flat memory |
| Lowering the audit retention deleted months of entries in one statement, at whatever time the process had started | 1.8 s stall for 321,000 rows | retention runs at 3 o'clock at night, bulky deletions in batches of 2,000 | Hub answers between batches |
| Upload bodies held in memory were limited per person only | a class uploading big files at once could take the server's memory | `limits.uploadMemoryBytes` (256 MB) for everybody together; a ZIP goes to disk and does not count | 429 beyond it |
| The admin overview added up every file and data row of the school at every view | 60 + 60 ms per view on six months of data | sums kept for 5 minutes (names read fresh, a deleted account is never shown) | – |
| Smaller: MSAL kept Microsoft tokens in memory; the WAL file never shrank; content files were not flushed before the database named them | memory grew with sign-ins; 69 MB WAL kept; a power cut could leave a row pointing at a truncated file | `storeInCache` off and the account removed; `journal_size_limit` 64 MB; `fsync` before the rename | – |

Single statements are fast on this machine; what made the old Hub fragile was the per-write disk flush and
the few operations whose cost grows with the data. Everything else stayed: one process, one SQLite file,
no new dependencies.

## The measurements

**Machine:** AMD Ryzen 9 9950X3D (16 cores; the Hub uses one), 30 GB RAM, NVMe SSD (one `fsync` ≈ 1 ms),
Linux, Node.js 26. A typical school server or VM core is 2–3× slower, and VM disks flush more slowly –
read the limits below with that in mind.

**Data** (`scripts/scale/seed.js`, deterministic): 1,000 students, 100 teachers, 1 admin; 40 active and
8 archived classes (homerooms of 27–31, courses, clubs, one year group of 93; 12 with co-teachers);
students in 0 / 1 / 2 / 3+ classes: 120 / 646 / 199 / 35; 55 teachers without a class; 373 apps with
1,271 versions built from the example apps; 90 days of use: 247,000 results, 23,000 saves, 24,000
achievements, 10,650 plays, 15,000 notices, 5,000 feedback, 557 assignments, 113,000 audit entries.
Database 300 MB.

**Method** (`scripts/scale/`): the real Hub in **real mode** (not the test mode) in its own process, on
loopback; Microsoft's two sign-in calls are answered by a local stand-in after a simulated network delay of
150 ms ± 50 %, everything else is the production code path. The load generator is a separate process
using Node's built-in `fetch`, one cookie jar per person, all from one address (like a school behind one
NAT address). It plays the browser and the app: Hub pages, the player, the app's start page and files,
the SDK API. A probe in the server reports event-loop delay, event-loop utilisation (ELU), memory and GC;
optionally the time per SQL statement. **After every run, every write the server had confirmed is looked
up in the database** – the last save of each person, scores, results (with the class they belong to),
progress, achievements, uploaded files byte for byte, joins – and nothing may hold another person's data.

The expected peak (1×): a class of 30 joins by QR code in the same second; 300 people sign in within
2 minutes; 10 classes play at once, each student's app saving every ~4 s plus progress, scores, results
and leaderboards; their teachers read results every ~20 s; the teacher of the biggest class exports CSV
every minute; two people upload app versions. 3× multiplies all of it (900 sign-ins, 90 joining at once,
30 classes playing).

### Peak and stress

Final code; "before" is the code at the start of this work, same data, same machine. Latencies are
measured by the load generator per request (the person waits for several requests in a row where the
table says so). "Server busy" is the event-loop utilisation of the Hub's thread over the measured time.

| Scenario | Requests | Errors | p50 | p95 | p99 | Max | Server busy | RSS max |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Morning sign-in, 300 people in 2 min (1×) | 1,500 | 0 | 1.2 ms | 187 ms | 218 ms | 226 ms | 1.4 % | 176 MB |
| Morning sign-in, 900 people in 2 min (3×) | 4,500 | 0 | 1.1 ms | 189 ms | 219 ms | 232 ms | 3.6 % | 168 MB |
| QR join, 30 in the same second (1×) | 155 | 0 | 1.4 ms | 124 ms | 207 ms | 209 ms | 1.4 % | 176 MB |
| QR join, 90 in the same second (3×) | 473 | 0 | 14.6 ms | 143 ms | 220 ms | 235 ms | 4.4 % | 171 MB |
| Peak 1×: 10 classes play, results, CSV, uploads (4 min) | 42,844 | 0 | 0.3 ms | 0.9 ms | 2.7 ms | 41 ms | 4.8 % | 192 MB |
| Peak 3×: 30 classes play, results, CSV, uploads (4 min) | 100,666 | 0 | 0.3 ms | 1.1 ms | 9.7 ms | 99 ms | 10.5 % | 201 MB |
| *Before:* peak 3× | 75,160 | 0 | 1.4 ms | 9 ms | 36 ms | 787 ms | 41 % | 202 MB |

- **Sign-in as a person waits for it** (Hub page, Microsoft stand-in with 150 ms ± 50 % simulated network
  time, back, first page): p95 223 ms at 1×, 224 ms at 3×. The Hub's own share is a few milliseconds; the
  rest is the simulated round trip to Microsoft.
- **QR join as a student waits for it** (open the link, half of them sign in first, confirm, class page):
  p95 193 ms at 1×, 303 ms at 3× – before: 1,168 ms at 3×. All 30 / 90 students were members exactly once
  afterwards; the projector's join counter answered within 73 ms during the burst (before: 856 ms).
- **During peak 3×** (selected requests, p95): save 1 ms, leaderboard 0.6 ms, the teacher's live results
  page 8.6 ms, the class page 29 ms, CSV export of the 93-student class 7.8 ms (before 17 ms), one uploaded
  file 2.6 ms (before 14 ms), a 10 MB ZIP 40 ms (before 787 ms).
- **Data checked after the 3× run:** 56,133 confirmed saves and results of 713 players – each person's last
  save, best score, every result with the class it was made in, progress and achievements – all present,
  none holding another person's data; 54 uploaded versions identical byte for byte.


### Where the limit is (ramp)

All 874 students in 40 classes play at once; the time between saves halves at every step.

| Save every | × expected peak | Requests/s | p95 | p99 | Errors | Server busy (ELU) |
|---|---:|---:|---:|---:|---:|---:|
| **Before** 4 s | 2.9 | 372 | 4 ms | 8.5 ms | 0 | 39 % |
| **Before** 2 s | 5.8 | 739 | 9.9 ms | 20.8 ms | 0 | 73 % |
| **Before** 1 s | 7 (saturated) | 894 | 431 ms | 11.3 s | 0 | 100 % |
| **After** 4 s | 2.9 | 372 | 0.7 ms | 2.5 ms | 0 | 8 % |
| **After** 1 s | 11.6 | 1,492 | 1.6 ms | 14.9 ms | 0 | 23 % |
| **After** 0.5 s | 23 | 2,977 | 7 ms | 18 ms | 0 | 41 % |
| **After** 0.25 s | 46 | 5,883 | 11.2 ms | 17.4 ms | 0 | 70 % |
| **After** 0.125 s | 66 (saturated) | 8,452 | 54.5 ms | 72 ms | 0 | 100 % |

The load generator's own event-loop delay stayed at p99 ≈ 11 ms in every step: the limit measured is the
Hub's, not the generator's.

### Single operations on the big school

| Operation (on a copy of the big school) | Before | After |
|---|---:|---:|
| Delete the account of the student with the most results (1,532) | 101 ms | 48 ms |
| Delete the account of the teacher with the most apps | 273 ms | 110 ms |
| Delete the app with the most results (34,427) | 613 ms in one piece | batches; longest stall < 30 ms |
| Delete the biggest class | 5.5 ms | 5.4 ms |
| Daily retention | 0.8 ms | 0.7 ms |
| Backup copy (`VACUUM INTO`, 300 MB) | 146 ms on the Hub thread | in a worker thread |
| „Datenbank prüfen“ (`quick_check`) | 74 ms on the Hub thread | in a worker thread |
| Upgrade 4 → 5 at start (23 indexes on the big tables) | – | 0.45 s, once |

Slowest pages with the big school, one request at a time (median of 5), before → after: the admin's start
page 70 → 28 ms, the class page of the year group (93 students) 13 → 15 ms, the admin overview 16 → 14 ms,
„Meine Daten“ export of the busiest student 18 → 11 ms, the teacher's start page 24 → 10 ms, the student's
start page 7 → 2 ms; every other page under 5 ms.

### Crash test: kill -9 while writing

`scripts/scale/crash.js`, 12 rounds. In each round 80 students save and add results as fast as they can,
new accounts sign in and delete themselves again, teachers create classes that students join, upload and
publish versions and delete apps – and after 4–13 seconds the Hub is killed with `SIGKILL`, then started
again. After every kill the database file is opened and checked before the next start.

- **All checks passed in all 12 rounds:** `PRAGMA integrity_check` = ok, no broken foreign keys; every write
  the Hub had confirmed is there – 66,390 saves (the last value of each person), 66,352 results,
  60 uploaded versions (byte for byte, with their files on disk), 118 classes with their teacher and
  590 joins –; 632 deleted accounts and 28 deleted apps stayed deleted; the Hub started again each time,
  and the sessions of signed-in people still worked.
- **At the end:** every file the database names is on disk, every published version and every version a
  class plays exists and is ready, every class has a teacher, and no orphaned files were left.
- **Requests that failed are expected:** the ones a kill cut off, and many refusals of the test's teachers,
  who keep creating apps and classes in a loop until the Hub's limits (30 apps, 60 classes per person,
  uploads per hour) refuse them – the limits doing their job.


<!-- RESULTS-SOAK -->

## What breaks first as the load grows

1. **CPU of the Hub's one thread.** At about 8,400 app requests per second here (66× the expected peak),
   the thread is fully busy: nothing fails, answers queue (p95 55 ms, longest 2.5 s). On a server core
   2–3× slower that point comes at roughly 20–30× the expected peak. Memory stays flat (≈ 250 MB).
2. **Bursts of page requests in the same second.** 90 students joining by QR code in the same second all
   want rendered pages at once; the last waited 0.3 s (before: 1.2 s). Pages cost milliseconds of CPU,
   API calls fractions of one.
3. **Uploads in memory.** A file upload is read into memory before it is checked (≤ 25 MB). Big file bodies
   held at the same time are capped at 256 MB for everybody together (one person: a quarter); beyond, the
   uploader waits and sends the file again. Saves of apps never wait for this.
4. **The disk, for deletions.** Deletions still wait for one flush each (on purpose).

## Still risky

- **Measured on a fast desktop CPU and NVMe disk.** A small VM is slower per core and its disk flushes take
  2–10 ms. The margin (66× at saturation, 8 % busy at 3×) is large, but it was not measured on such a VM.
- **Power cuts / operating-system crashes:** with `synchronous=NORMAL` the last commits before a checkpoint
  can be lost (the database stays consistent). Deletions are flushed (accounts, apps, classes, app data),
  and a content file is removed only after the commit that freed it is on the disk – so deleted data does
  not come back and no row points at a removed file. A process crash or `kill -9` loses nothing – tested.
- **Microsoft sign-in itself** was replaced by a stand-in; Microsoft's own latency and limits are not part
  of these numbers.
- **One process, one server:** no failover. A restart takes about a second; sessions survive it.
- **Clients on school Wi-Fi:** a teacher's per-student results page with 200 detailed results is about
  1.7 MB of HTML; the year group's class page 450 KB. Fast on the server, heavy on a weak network.
- **Assignments:** „done“ is derived; an app that lowers a student's progress afterwards can turn a done
  assignment back to open (test marked `todo`, see SECURITY.md).
- **Uploading a very big version for an owner with very many stored files:** every uploaded file adds up
  the owner's stored bytes (twice) – 3.8 ms of the Hub's time per file for an owner with 28,000 stored files
  (independent review). Not a freeze, but a 2,000-file upload by such an owner costs about 8 s of the
  Hub's time, spread over its requests. A running byte count per owner would remove it.
- **Data grows every school year:** results are only deleted with their app, their owner or by a teacher's
  reset; the database grows by roughly 300 MB per 90 days of this school. Plan disk space, and keep the
  backup below the browser download's limit (3.5 GB; beyond, copy `data/` on the server).
- **A second start on the same data folder** (e.g. a second service by mistake) runs the migrations and
  the retention on the live database before it fails on the port. Let the process manager run exactly one.

## Before go-live: the server

- **CPU:** 2 vCPUs (one for the Hub, one for backup/check worker, GC and the proxy); a fast core matters
  more than many. **RAM:** 1 GB minimum, 2 GB comfortable (measured ≈ 250 MB at saturation; upload bodies
  in memory are capped at 256 MB for everybody together; the backup streams).
- **Disk:** local SSD for `data/` – **never** a network file system (NFS, SMB, some cloud file shares): SQLite's
  WAL needs local shared memory and locking. Leave room for the database (300 MB per 90 days of this
  school), the app files and the backups.
- **Reverse proxy with HTTPS** in front (Caddy, nginx): `TRUST_PROXY=1`, `Host` passed through, body limit
  ≥ 100 MB (ZIP uploads), timeouts ≥ 10 minutes for uploads, keep-alive to the Hub. **No per-address rate
  limits** for normal traffic: the whole school arrives from one address.
- **Process manager** that restarts the Hub (systemd `Restart=always`); `NODE_ENV=production`; open-file
  limit ≥ 4096; the clock synchronised (NTP: sessions and tokens expire by the clock).
- **Backups:** the admin download (it now runs beside the Hub) or a copy of `data/` – encrypted, off the
  server, regularly; test a restore once.
- **Monitoring:** that the process runs, its memory, free disk space; the server log for errors.
- **The rest is in README.md („Echter Betrieb“):** Microsoft app registration, a separate apps domain with
  wildcard certificate, `.env`.

## Repeat the measurements

```bash
node scripts/scale/seed.js --data data/scale                         # the big school (≈ 10 s)
node scripts/scale/load.js --data data/scale                         # pages, sign-in, QR join, peak (×1)
node scripts/scale/load.js --data data/scale --factor 3 --scenario signin,join,peak
node scripts/scale/load.js --data data/scale --scenario ramp         # to the limit
node scripts/scale/load.js --data data/scale --scenario soak --soak-minutes 180
node scripts/scale/crash.js --data data/scale --rounds 12            # kill -9 while writing
```

Each run copies the seeded folder first and writes `report.md` / `report.json` to `data/scale-results/`.
`--profile-sql` adds the time per SQL statement. The scripts never touch a real installation: the server
they start refuses anything but localhost, and `seed.js` refuses a folder that already has a database.
