'use strict';
// Attack tests for package A (Klassen & Unterricht): assignments, feedback,
// co-teachers, archive, per-class app settings, the class overview and
// results in class context, and the projector's live status. Every test
// plays someone who should NOT get through: a student, a teacher of another
// class, an outsider - or a teacher trying to change an archived class.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startHub } = require('./helpers');

let h;
let admin, lehmann, yilmaz, kaya, mia, ben, lena, olaf;
let A, L, Y, K, M, B, LE, O;
let c7, c9, quiz, other;

const EVIL = '<script>alert(1)</script><img src=x onerror=alert(2)>';
const MANIFEST = JSON.stringify({
  settings: [
    { key: 'woerter', label: 'Wörter', type: 'pairs', columns: ['Deutsch', 'Englisch'], default: [['Hund', 'dog']] },
    { key: 'zeit', label: 'Sekunden pro Frage', type: 'number', min: 5, max: 120, default: 30 },
    { key: 'tipps', label: 'Tipps anzeigen', type: 'boolean', default: true },
    { key: 'richtung', label: 'Richtung', type: 'choice', options: ['de-en', 'en-de', 'mix'], default: 'de-en' },
  ],
  results: { labels: { richtig: 'Richtig beantwortet' } },
});
const DEFAULTS = { woerter: [['Hund', 'dog']], zeit: 30, tipps: true, richtung: 'de-en' };

const teacherClass = (userId, name) => h.db.get("SELECT c.id FROM classes c JOIN class_members m ON m.class_id = c.id AND m.user_id = ? AND m.role = 'teacher' WHERE c.name = ?", userId, name).id;
const joinCode = (classId, role = 'student') => h.db.get('SELECT code FROM join_codes WHERE class_id = ? AND role = ?', classId, role).code;
const count = (sql, ...p) => h.db.get(sql, ...p).n;
const assignmentOf = (res) => res.headers.location.split('/').pop();
const json = (b, url) => b.raw('GET', url, { headers: { accept: 'application/json' } });

before(async () => {
  h = await startHub();
  admin = h.addUser('Anna Adler', 'admin');
  lehmann = h.addUser('Herr Lehmann', 'teacher');
  yilmaz = h.addUser('Frau Yilmaz', 'teacher');
  kaya = h.addUser('Herr Kaya', 'teacher');
  mia = h.addUser('Mia Schmidt', 'student');
  ben = h.addUser('Ben Hoffmann', 'student');
  lena = h.addUser('Lena Wagner', 'student');
  olaf = h.addUser('Olaf Fremd', 'student');
  [A, L, Y, K, M, B, LE, O] = await Promise.all([admin, lehmann, yilmaz, kaya, mia, ben, lena, olaf].map((u) => h.browser().login(u)));

  await L.post('/klassen', { name: '7b' });
  c7 = teacherClass(lehmann.id, '7b');
  for (const b of [M, B]) await b.post(`/beitreten/${joinCode(c7)}`);
  await Y.post('/klassen', { name: '9c' });
  c9 = teacherClass(yilmaz.id, '9c');
  await LE.post(`/beitreten/${joinCode(c9)}`);

  quiz = await h.makeApp(L, 'Quiz', { 'index.html': '<h1>Quiz</h1>', 'schulhub.json': MANIFEST });
  await L.post(`/klassen/${c7}/apps`, { app: quiz.id });
  // A colleague's shared app may be added by Frau Yilmaz to her class too.
  h.db.run('UPDATE apps SET shared = 1 WHERE id = ?', quiz.id);
  await Y.post(`/klassen/${c9}/apps`, { app: quiz.id });
  other = await h.makeApp(L, 'Nicht in der Klasse', { 'index.html': 'x' });
  assert.equal(h.hub.ctx.access.appApprovedIn(c9, quiz.id), true);
});
after(() => h.stop());

// ================================================================ assignments

test('Aufgaben: nur Lehrkräfte der Klasse stellen sie – Schüler, fremde Lehrkräfte und archivierte Klassen nicht', async () => {
  const before = count('SELECT COUNT(*) AS n FROM assignments');
  for (const [who, url] of [[M, `/klassen/${c7}/aufgaben/neu`], [Y, `/klassen/${c7}/aufgaben/neu`], [O, `/klassen/${c7}/aufgaben/neu`]]) {
    assert.equal((await who.get(url)).status, 404, url);
  }
  for (const who of [M, Y, O, LE]) {
    assert.equal((await who.post(`/klassen/${c7}/aufgaben`, { app: quiz.id, titel: 'Hack' })).status, 404);
  }
  // only apps approved in this class
  assert.equal((await L.post(`/klassen/${c7}/aufgaben`, { app: other.id, titel: 'x' })).status, 404);
  assert.equal(count('SELECT COUNT(*) AS n FROM assignments'), before, 'nothing was created');

  // validation: the due date must come after the start, dates must be real - each message at its field
  const form = `/klassen/${c7}/aufgaben/neu`;
  await L.page(form);
  for (const [fields, message] of [
    [{ faellig: '2001-01-01' }, 'Die Aufgabe muss nach dem Start fällig sein.'],
    [{ faellig: '2026-02-31' }, 'Das ist kein gültiges Datum.'],
    [{ faellig: '2026-12-01', faellig_zeit: '25:99' }, 'Das ist keine gültige Uhrzeit.'],
    [{ notiz: 'x'.repeat(1200) }, 'Höchstens 1000 Zeichen.'],
  ]) {
    const res = await L.post(`/klassen/${c7}/aufgaben`, { app: quiz.id, titel: 'Bleibt stehen', ...fields });
    assert.equal(res.status, 303);
    assert.equal(res.headers.location, form);
    const again = (await L.page(form)).text;
    assert.ok(again.includes(`<span class="error-text">${message}</span>`), message);
    assert.ok(again.includes('value="Bleibt stehen"'), 'typed values are kept');
  }

  const res = await L.post(`/klassen/${c7}/aufgaben`, { app: quiz.id, titel: '', notiz: 'Drei Runden' });
  assert.equal(res.status, 303);
  const id = assignmentOf(res);
  const row = h.db.get('SELECT * FROM assignments WHERE id = ?', id);
  assert.equal(row.title, 'Quiz', 'without a title it is named like the app');
  assert.equal(row.created_by, lehmann.id);
  // the students of THIS class are told, nobody else
  const told = h.db.all("SELECT user_id, href FROM notices WHERE kind = 'aufgabe' AND href = ?", `/aufgaben/${id}`).map((n) => n.user_id).sort();
  assert.deepEqual(told, [mia.id, ben.id].sort());

  // an archived class takes no new assignments
  await L.post('/klassen', { name: 'Alt-Aufgaben' });
  const old = teacherClass(lehmann.id, 'Alt-Aufgaben');
  await L.post(`/klassen/${old}/apps`, { app: quiz.id });
  await L.post(`/klassen/${old}/archivieren`);
  assert.equal((await L.get(`/klassen/${old}/aufgaben/neu`)).status, 404);
  assert.equal((await L.post(`/klassen/${old}/aufgaben`, { app: quiz.id })).status, 404);
  assert.equal(count('SELECT COUNT(*) AS n FROM assignments WHERE class_id = ?', old), 0);
});

test('Aufgaben: Schüler sehen nur die ihrer Klassen; „erledigt“ wird abgeleitet; abhaken nur für sich selbst', async () => {
  const id = assignmentOf(await L.post(`/klassen/${c7}/aufgaben`, { app: quiz.id, titel: `Runde ${EVIL}`, notiz: EVIL }));
  const x = h.db.get('SELECT * FROM assignments WHERE id = ?', id);
  const { assignments } = h.hub.ctx;

  // who may look
  const page = await M.get(`/aufgaben/${id}`);
  assert.equal(page.status, 200);
  assert.ok(page.text.includes('&lt;script&gt;alert(1)') && !page.text.includes('<script>alert(1)'), 'title and note are escaped');
  for (const who of [LE, O, Y]) assert.equal((await who.get(`/aufgaben/${id}`)).status, 404);

  // derived state: a result after the start = done, opening the app = started
  assert.equal(assignments.stateOf(x, mia.id), 'open');
  const mt = await h.token(M, quiz, c7);
  await M.api(quiz, mt.token, 'results.add', { title: 'Runde 1', score: 3, maxScore: 4 });
  assert.equal(assignments.stateOf(x, mia.id), 'done');
  await h.token(B, quiz, c7); // first open counts as a play
  assert.equal(assignments.stateOf(x, ben.id), 'started');

  // the teacher sees every student's state, filterable
  const table = (res) => res.text.split('teach-states')[1].split('</table>')[0];
  const t = await L.get(`/aufgaben/${id}?stand=erledigt`);
  assert.equal(t.status, 200);
  assert.ok(table(t).includes('Mia Schmidt') && !table(t).includes('Ben Hoffmann'));
  const started = table(await L.get(`/aufgaben/${id}?stand=begonnen`));
  assert.ok(started.includes('Ben Hoffmann') && !started.includes('Mia Schmidt'));

  // marking done: only for oneself, whatever the form says
  await B.page(`/aufgaben/${id}`);
  assert.equal((await B.post(`/aufgaben/${id}/erledigt`, { user: mia.id, schueler: mia.id, user_id: mia.id })).status, 303);
  assert.deepEqual(h.db.all('SELECT user_id FROM assignment_done WHERE assignment_id = ?', id).map((r) => r.user_id), [ben.id]);
  assert.equal(assignments.stateOf(x, ben.id), 'done');
  for (const who of [L, Y, LE, O]) assert.equal((await who.post(`/aufgaben/${id}/erledigt`)).status, 404);
  assert.equal((await B.post(`/aufgaben/${id}/offen`)).status, 303);
  assert.equal(assignments.stateOf(x, ben.id), 'started', 'undo removes only the own mark');

  // only the class's teachers change or delete it
  for (const who of [M, Y, O]) {
    assert.equal((await who.get(`/aufgaben/${id}/bearbeiten`)).status, 404);
    assert.equal((await who.post(`/aufgaben/${id}/bearbeiten`, { titel: 'gekapert' })).status, 404);
    assert.equal((await who.post(`/aufgaben/${id}/loeschen`)).status, 404);
  }
  assert.equal((await L.post(`/aufgaben/${id}/bearbeiten`, { titel: 'Runde 2', notiz: '', start: '', faellig: '' })).status, 303);
  assert.equal(h.db.get('SELECT title FROM assignments WHERE id = ?', id).title, 'Runde 2');
  assert.ok(h.db.get("SELECT 1 AS ok FROM audit_log WHERE action = 'aufgabe_geaendert'"));
  assert.equal((await L.post(`/aufgaben/${id}/loeschen`)).status, 303);
  assert.equal(h.db.get('SELECT 1 AS ok FROM assignments WHERE id = ?', id), undefined);
});

// ================================================================= feedback

test('Rückmeldungen: nur von der Lehrkraft an eigene Schüler/innen, privat, nur der Empfänger markiert gelesen, Löschen nach Regeln, alles escaped', async () => {
  const send = (who, classId, fields) => who.post(`/klassen/${classId}/rueckmeldungen`, { zurueck: `/klassen/${classId}`, ...fields });
  // who may NOT write
  assert.equal((await send(L, c7, { schueler: lena.id, text: 'nicht meine Schülerin' })).status, 404);
  assert.equal((await send(Y, c7, { schueler: mia.id, text: 'fremde Klasse' })).status, 404);
  assert.equal((await send(Y, c9, { schueler: mia.id, text: 'nicht in 9c' })).status, 404);
  assert.equal((await send(M, c7, { schueler: ben.id, text: 'Schüler an Schüler' })).status, 404);
  assert.equal((await send(L, c7, { schueler: mia.id, text: 'x', app: other.id })).status, 404, 'links only to apps of the class');
  const x9 = assignmentOf(await Y.post(`/klassen/${c9}/aufgaben`, { app: quiz.id }));
  assert.equal((await send(L, c7, { schueler: mia.id, text: 'x', aufgabe: x9 })).status, 404, 'links only to assignments of the class');
  assert.equal((await send(L, c7, { schueler: mia.id, text: 'x'.repeat(2100) })).status, 400, 'length limit');
  assert.equal((await send(L, c7, { schueler: mia.id, text: '   ' })).status, 400);
  assert.equal(count('SELECT COUNT(*) AS n FROM feedback'), 0);

  // the class's teacher writes to their own student
  assert.equal((await send(L, c7, { schueler: mia.id, text: `Gut gemacht ${EVIL}`, app: quiz.id })).status, 303);
  const f = h.db.get('SELECT * FROM feedback WHERE student_id = ?', mia.id);
  assert.equal(f.author_id, lehmann.id);
  assert.equal(f.app_id, quiz.id);
  assert.ok(h.db.get("SELECT 1 AS ok FROM notices WHERE user_id = ? AND kind = 'rueckmeldung' AND href = '/rueckmeldungen'", mia.id), 'the student is told');

  // reading: the student and the class's teachers - nobody else; always escaped
  const mine = await M.page('/rueckmeldungen');
  assert.ok(mine.text.includes('Gut gemacht &lt;script&gt;') && !mine.text.includes('<script>alert(1)'));
  assert.ok(!(await B.get('/rueckmeldungen')).text.includes('Gut gemacht'), 'classmates see nothing');
  assert.ok(!(await LE.get('/rueckmeldungen')).text.includes('Gut gemacht'));
  const teacherView = await L.get(`/klassen/${c7}/apps/${quiz.id}/ergebnisse/${mia.id}`);
  assert.ok(teacherView.text.includes('Gut gemacht &lt;script&gt;') && !teacherView.text.includes('<img src=x'));
  assert.ok((await M.get(`/klassen/${c7}`)).text.includes('Gut gemacht &lt;script&gt;'), 'shown on the class page for the student');
  assert.equal(h.db.get('SELECT read_at FROM feedback WHERE id = ?', f.id).read_at, null, 'looking never marks as read');

  // only the student marks it as read
  await B.page('/rueckmeldungen');
  assert.equal((await B.post(`/rueckmeldungen/${f.id}/gelesen`)).status, 404);
  assert.equal((await L.post(`/rueckmeldungen/${f.id}/gelesen`)).status, 404);
  assert.equal((await M.post(`/rueckmeldungen/${f.id}/gelesen`, { zurueck: 'https://evil.example/' })).status, 303);
  assert.ok(h.db.get('SELECT read_at FROM feedback WHERE id = ?', f.id).read_at);

  // deleting: author, student, admin - not classmates, other teachers or co-teachers
  await send(L, c7, { schueler: mia.id, text: 'zweite' });
  await send(L, c7, { schueler: mia.id, text: 'dritte' });
  const [second, third] = ['zweite', 'dritte'].map((t) => h.db.get('SELECT id FROM feedback WHERE body = ?', t).id);
  h.db.run("INSERT INTO class_members (class_id, user_id, role, joined_at) VALUES (?, ?, 'teacher', ?)", c7, kaya.id, Date.now());
  await K.page('/start');
  for (const who of [B, Y, K, LE]) assert.equal((await who.post(`/rueckmeldungen/${f.id}/loeschen`)).status, 404);
  assert.equal((await M.post(`/rueckmeldungen/${f.id}/loeschen`)).status, 303, 'the student may delete it (their data)');
  assert.equal((await L.post(`/rueckmeldungen/${second}/loeschen`)).status, 303, 'the author may');
  await A.page('/start');
  assert.equal((await A.post(`/rueckmeldungen/${third}/loeschen`)).status, 303, 'the admin may');
  assert.equal(count('SELECT COUNT(*) AS n FROM feedback WHERE student_id = ?', mia.id), 0);
  h.db.run('DELETE FROM class_members WHERE class_id = ? AND user_id = ?', c7, kaya.id);
});

// ============================================================== co-teachers

test('Lehrkraft-Einladung: nur Lehrkräfte der Klasse erzeugen sie, nur Lehrkräfte nutzen sie; die letzte Lehrkraft kann nicht gehen', async () => {
  for (const who of [M, Y, O]) assert.equal((await who.post(`/klassen/${c7}/einladung`, { minuten: '60' })).status, 404);
  assert.equal(count("SELECT COUNT(*) AS n FROM join_codes WHERE class_id = ? AND role = 'teacher'", c7), 0);
  assert.equal((await L.post(`/klassen/${c7}/einladung`, { minuten: '60' })).status, 303);
  const invite = joinCode(c7, 'teacher');
  assert.ok(h.db.get("SELECT 1 AS ok FROM audit_log WHERE action = 'lehrkraft_eingeladen'"));
  assert.ok(!(await M.get(`/klassen/${c7}`)).text.includes(invite), 'students never see the invitation');

  // a student account cannot use it - not even the confirmation offers a button
  const preview = await O.get(`/beitreten/${invite}`);
  assert.equal(preview.status, 200);
  assert.ok(preview.text.includes('Einladung für Lehrkräfte') && !preview.text.includes('Als Lehrkraft beitreten'));
  assert.ok(!preview.text.includes('Herr Lehmann') && !preview.text.includes('eingeladen, diese Klasse'), 'no class, no names, no invitation text for students');
  await O.page('/start');
  assert.equal((await O.post(`/beitreten/${invite}`)).status, 400);
  assert.equal(h.hub.ctx.access.classRole(olaf, c7), null);

  // a teacher becomes co-teacher; looking at the confirmation alone changes nothing
  assert.ok((await K.get(`/beitreten/${invite}`)).text.includes('Als Lehrkraft beitreten'));
  assert.equal(h.hub.ctx.access.classRole(kaya, c7), null, 'GET never joins');
  await K.page('/start');
  assert.equal((await K.post(`/beitreten/${invite}`)).status, 303);
  assert.equal(h.hub.ctx.access.classRole(kaya, c7), 'teacher');
  assert.ok((await L.get(`/klassen/${c7}/mitglieder`)).text.includes('Herr Kaya'));

  // the last teacher cannot leave; with a colleague one can
  await Y.page('/start');
  assert.equal((await Y.post(`/klassen/${c9}/verlassen`)).status, 400);
  assert.equal(h.hub.ctx.access.classRole(yilmaz, c9), 'teacher');
  assert.equal((await K.post(`/klassen/${c7}/verlassen`)).status, 303);
  assert.equal(h.hub.ctx.access.classRole(kaya, c7), null);
  assert.equal((await L.post(`/klassen/${c7}/verlassen`)).status, 400, 'now Herr Lehmann is the last one');
  assert.equal(h.hub.ctx.access.classRole(lehmann, c7), 'teacher');

  // a student can always leave an active class
  const pia = h.addUser('Pia Probe', 'student');
  const P = await h.browser().login(pia);
  await P.post(`/beitreten/${joinCode(c7)}`);
  assert.equal(h.hub.ctx.access.classRole(pia, c7), 'student');
  assert.equal((await P.post(`/klassen/${c7}/verlassen`)).status, 303);
  assert.equal(h.hub.ctx.access.classRole(pia, c7), null);

  // revoking the invitation
  assert.equal((await M.post(`/klassen/${c7}/einladung/loeschen`)).status, 404);
  assert.equal((await L.post(`/klassen/${c7}/einladung/loeschen`)).status, 303);
  assert.equal(count("SELECT COUNT(*) AS n FROM join_codes WHERE class_id = ? AND role = 'teacher'", c7), 0);
});

// ================================================================== archive

test('Archiv: Schüler verlieren den Zugriff, nichts lässt sich ändern, Zurückholen bringt alles wieder', async () => {
  await L.post('/klassen', { name: 'Archivklasse' });
  const cls = teacherClass(lehmann.id, 'Archivklasse');
  await M.post(`/beitreten/${joinCode(cls)}`);
  await L.post(`/klassen/${cls}/apps`, { app: quiz.id });
  const x = assignmentOf(await L.post(`/klassen/${cls}/aufgaben`, { app: quiz.id, titel: 'Archivaufgabe' }));
  await L.post(`/klassen/${cls}/rueckmeldungen`, { schueler: mia.id, text: 'vor dem Archiv' });

  assert.equal((await M.post(`/klassen/${cls}/archivieren`)).status, 404, 'students cannot archive');
  assert.equal((await Y.post(`/klassen/${cls}/archivieren`)).status, 404);
  assert.equal((await L.post(`/klassen/${cls}/archivieren`)).status, 303);
  assert.ok(h.db.get('SELECT archived_at FROM classes WHERE id = ?', cls).archived_at);
  assert.ok(h.db.get("SELECT 1 AS ok FROM audit_log WHERE action = 'klasse_archiviert' AND target = 'Archivklasse'"));

  // students lose access to everything of the class
  assert.equal((await M.get(`/klassen/${cls}`)).status, 404);
  assert.equal((await M.get(`/aufgaben/${x}`)).status, 404);
  assert.ok(!(await M.get('/klassen')).text.includes('Archivklasse'));
  assert.equal(await h.token(M, quiz, cls), null, 'apps cannot be opened in it');
  assert.equal((await M.post(`/aufgaben/${x}/erledigt`)).status, 404);

  // the teacher still reads it, with the deletion date
  const page = await L.get(`/klassen/${cls}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /wird sie mit allen Aufgaben und Rückmeldungen gelöscht/);
  assert.equal((await L.get(`/klassen/${cls}/apps/${quiz.id}/ergebnisse`)).status, 200);

  // ...but nothing changes
  const snapshot = () => JSON.stringify([
    h.db.get('SELECT name, subject, grade FROM classes WHERE id = ?', cls),
    count('SELECT COUNT(*) AS n FROM class_members WHERE class_id = ?', cls),
    count('SELECT COUNT(*) AS n FROM assignments WHERE class_id = ?', cls),
    h.db.get('SELECT title FROM assignments WHERE id = ?', x),
    count('SELECT COUNT(*) AS n FROM feedback WHERE class_id = ?', cls),
    count('SELECT COUNT(*) AS n FROM class_app_settings WHERE class_id = ?', cls),
    h.db.all('SELECT app_id, status FROM class_apps WHERE class_id = ? ORDER BY app_id', cls),
    count('SELECT COUNT(*) AS n FROM join_codes WHERE class_id = ?', cls),
  ]);
  const was = snapshot();
  const attempts = [
    [`/klassen/${cls}/umbenennen`, { name: 'Neu' }],
    [`/klassen/${cls}/bearbeiten`, { name: 'Neu', fach: 'Physik', stufe: '9' }],
    [`/klassen/${cls}/code`, { minuten: '60' }],
    [`/klassen/${cls}/code/loeschen`, {}],
    [`/klassen/${cls}/einladung`, { minuten: '60' }],
    [`/klassen/${cls}/apps`, { app: other.id }],
    [`/klassen/${cls}/apps/${quiz.id}/entfernen`, {}],
    [`/klassen/${cls}/aufgaben`, { app: quiz.id }],
    [`/aufgaben/${x}/bearbeiten`, { titel: 'geändert' }],
    [`/aufgaben/${x}/loeschen`, {}],
    [`/klassen/${cls}/rueckmeldungen`, { schueler: mia.id, text: 'im Archiv' }],
    [`/klassen/${cls}/apps/${quiz.id}/einstellungen`, { gesendet: '1', 's-zeit': '10' }],
    [`/klassen/${cls}/mitglieder/${mia.id}/entfernen`, {}],
    [`/klassen/${cls}/apps/${quiz.id}/ergebnisse/${mia.id}/loeschen`, {}],
  ];
  for (const [url, fields] of attempts) {
    const res = await L.post(url, fields);
    assert.ok([400, 404].includes(res.status), `${url} -> ${res.status}`);
  }
  assert.equal((await L.post(`/klassen/${cls}/verlassen`)).status, 400);
  assert.equal(snapshot(), was, 'nothing changed');
  assert.equal((await L.get(`/klassen/${cls}/apps/${quiz.id}/einstellungen`)).status, 404);

  // restore: everything is back
  assert.equal((await M.post(`/klassen/${cls}/wiederherstellen`)).status, 404);
  assert.equal((await L.post(`/klassen/${cls}/wiederherstellen`)).status, 303);
  assert.equal(h.db.get('SELECT archived_at FROM classes WHERE id = ?', cls).archived_at, null);
  assert.ok(h.db.get("SELECT 1 AS ok FROM audit_log WHERE action = 'klasse_wiederhergestellt'"));
  assert.equal((await M.get(`/klassen/${cls}`)).status, 200);
  assert.equal((await M.get(`/aufgaben/${x}`)).status, 200);
  assert.ok(await h.token(M, quiz, cls));
});

// =============================================================== app settings

test('App-Einstellungen: nur die Lehrkraft der Klasse; Werte werden geprüft; die App liest sie über hub.settings; andere Klassen bleiben unberührt', async () => {
  const url = `/klassen/${c7}/apps/${quiz.id}/einstellungen`;
  for (const who of [M, Y, O]) {
    assert.equal((await who.get(url)).status, 404);
    assert.equal((await who.post(url, { gesendet: '1', 's-zeit': '10' })).status, 404);
  }
  assert.equal((await Y.get(`/klassen/${c9}/apps/${quiz.id}/einstellungen`)).status, 200, 'her own class works');
  const form = await L.page(url);
  assert.equal(form.status, 200);
  assert.ok(form.text.includes('Sekunden pro Frage') && form.text.includes('Deutsch = Englisch'));

  // invalid values: nothing stored, the form comes back with the field's message
  const bad = await L.post(url, { gesendet: '1', 's-woerter': 'Katze = cat', 's-zeit': '999', 's-richtung': 'mix' }, { headers: { referer: `${h.config.hubOrigin}${url}` } });
  assert.equal(bad.status, 303);
  assert.equal(count('SELECT COUNT(*) AS n FROM class_app_settings WHERE class_id = ?', c7), 0);
  const again = await L.page(url);
  assert.ok(again.text.includes('höchstens 120'), 'per-field error');
  assert.ok(again.text.includes('999'), 'typed value kept');
  for (const fields of [{ 's-richtung': 'rueckwaerts' }, { 's-woerter': 'nur links' }]) {
    await L.post(url, { gesendet: '1', ...fields });
    assert.equal(count('SELECT COUNT(*) AS n FROM class_app_settings WHERE class_id = ?', c7), 0);
  }

  // valid values (the switch is off because it was not sent)
  assert.equal((await L.post(url, { gesendet: '1', 's-woerter': 'Katze = cat\nMaus = mouse', 's-zeit': '15', 's-richtung': 'mix', role: 'admin' })).status, 303);
  const saved = h.db.get('SELECT * FROM class_app_settings WHERE class_id = ? AND app_id = ?', c7, quiz.id);
  assert.deepEqual(JSON.parse(saved.value), { woerter: [['Katze', 'cat'], ['Maus', 'mouse']], zeit: 15, tipps: false, richtung: 'mix' });
  assert.equal(saved.updated_by, lehmann.id);
  assert.ok(h.db.get("SELECT 1 AS ok FROM audit_log WHERE action = 'app_einstellungen_geaendert'"));

  // the app reads them in this class - and only here
  const bt = await h.token(B, quiz, c7);
  assert.deepEqual((await B.api(quiz, bt.token, 'settings.all', {})).json().result, { woerter: [['Katze', 'cat'], ['Maus', 'mouse']], zeit: 15, tipps: false, richtung: 'mix' });
  const lt = await h.token(LE, quiz, c9);
  assert.deepEqual((await LE.api(quiz, lt.token, 'settings.all', {})).json().result, DEFAULTS, 'other class unaffected');

  // back to the defaults
  assert.equal((await M.post(`${url}/zuruecksetzen`)).status, 404);
  assert.equal((await L.post(`${url}/zuruecksetzen`)).status, 303);
  assert.deepEqual((await B.api(quiz, (await h.token(B, quiz, c7)).token, 'settings.all', {})).json().result, DEFAULTS);
});

// ===================================================== overview and results

test('Überblick und Ergebnisse: nur Ergebnisse aus dieser Klasse; fremde Lehrkräfte 404; entfernte Apps bleiben lesbar', async () => {
  // Pia is in both classes; the app is used in both.
  const pia = h.addUser('Pia Beide', 'student');
  const P = await h.browser().login(pia);
  await P.post(`/beitreten/${joinCode(c7)}`);
  await P.post(`/beitreten/${joinCode(c9)}`);
  const p7 = await h.token(P, quiz, c7);
  await P.api(quiz, p7.token, 'results.add', { title: 'ERGEBNIS-7B', score: 3, maxScore: 4, details: [{ wort: 'Hund', richtig: true }] });
  const p9 = await h.token(P, quiz, c9);
  await P.api(quiz, p9.token, 'results.add', { title: 'ERGEBNIS-9C', score: 1, maxScore: 4 });
  // legacy: recorded before version 2, class unknown ('') - shown to the class's teachers
  h.db.run("INSERT INTO results (app_id, user_id, title, score, max_score, class_id, created_at) VALUES (?, ?, 'ERGEBNIS-ALT', 1, 2, '', ?)", quiz.id, pia.id, Date.now());
  // made without any class: Paul plays the school-wide release at home, before joining 7b
  await A.page(`/apps/${quiz.id}`);
  assert.equal((await A.post(`/apps/${quiz.id}/schulweit`, { an: '1', version: quiz.published_version_id })).status, 303);
  const paul = h.addUser('Paul Zuhause', 'student');
  const PZ = await h.browser().login(paul);
  const home = await h.token(PZ, quiz);
  assert.equal(home.class, null, 'no class context');
  await PZ.api(quiz, home.token, 'results.add', { title: 'ZUHAUSE-OHNE-KLASSE', score: 4, maxScore: 4 });
  assert.equal(h.db.get("SELECT class_id FROM results WHERE title = 'ZUHAUSE-OHNE-KLASSE'").class_id, null);
  await A.post(`/apps/${quiz.id}/schulweit`, { an: '0' });
  await PZ.post(`/beitreten/${joinCode(c7)}`);

  const base7 = `/klassen/${c7}/apps/${quiz.id}/ergebnisse`;
  const detail7 = (await L.get(`${base7}/${pia.id}`)).text;
  assert.ok(detail7.includes('ERGEBNIS-7B') && detail7.includes('ERGEBNIS-ALT') && !detail7.includes('ERGEBNIS-9C'));
  assert.ok(detail7.includes('Richtig beantwortet'), 'labels from schulhub.json');
  const csv = await L.get(`${base7}.csv`);
  assert.ok(csv.text.includes('ERGEBNIS-7B') && !csv.text.includes('ERGEBNIS-9C'));
  // nothing made outside a class reaches the class's teacher: list, detail, CSV, overview grid
  for (const url of [base7, `${base7}/${paul.id}`, `${base7}.csv`]) assert.ok(!(await L.get(url)).text.includes('ZUHAUSE-OHNE-KLASSE'), url);
  const grid = (await L.get(`/klassen/${c7}`)).text;
  assert.ok(grid.includes('aria-label="Paul Zuhause, Quiz: begonnen"') && !grid.includes('Paul Zuhause, Quiz: bestes Ergebnis 100'), 'the home result counts nowhere');
  assert.match(csv.headers['content-disposition'], /^attachment; filename="ergebnisse-7b-quiz-\d{4}-\d{2}-\d{2}\.csv"$/);
  assert.ok(csv.text.includes('Fortschritt'), 'progress column');
  const detail9 = (await Y.get(`/klassen/${c9}/apps/${quiz.id}/ergebnisse/${pia.id}`)).text;
  assert.ok(detail9.includes('ERGEBNIS-9C') && !detail9.includes('ERGEBNIS-7B'));

  // the overview matrix uses the class context too: 7b = best of 3/4 and the old 1/2 = 75 %;
  // 9c = best of 1/4 and the old 1/2 = 50 % (7b's 75 % never counts there)
  const overview = await L.get(`/klassen/${c7}`);
  assert.equal(overview.status, 200);
  assert.ok(overview.text.includes('aria-label="Pia Beide, Quiz: bestes Ergebnis 75 %"'));
  assert.ok((await Y.get(`/klassen/${c9}`)).text.includes('aria-label="Pia Beide, Quiz: bestes Ergebnis 50 %"'));

  // teachers of other classes, students and outsiders: 404 everywhere
  for (const who of [Y, M, O]) {
    for (const url of [`/klassen/${c7}/aufgaben`, `/klassen/${c7}/apps`, `/klassen/${c7}/mitglieder`, `/klassen/${c7}/einstellungen`, base7, `${base7}.csv`, `${base7}/${pia.id}`]) {
      assert.equal((await who.get(url)).status, 404, `${url}`);
    }
  }
  assert.equal((await Y.get(`/klassen/${c7}`)).status, 404);

  // a removed app keeps its results readable for the class teacher - and can come back
  assert.equal((await L.post(`/klassen/${c7}/apps/${quiz.id}/entfernen`)).status, 303);
  assert.equal(h.db.get('SELECT status FROM class_apps WHERE class_id = ? AND app_id = ?', c7, quiz.id).status, 'removed');
  assert.equal((await L.get(base7)).status, 200);
  assert.ok((await L.get(`${base7}/${pia.id}`)).text.includes('ERGEBNIS-7B'));
  assert.equal((await L.get(`${base7}.csv`)).status, 200);
  assert.ok((await L.get(`/klassen/${c7}/apps`)).text.includes('Entfernte Apps'));
  assert.equal((await Y.get(base7)).status, 404);
  assert.equal(await h.token(P, quiz, c7), null, 'students cannot open it any more');
  assert.equal((await M.post(`/klassen/${c7}/apps/${quiz.id}/zurueckholen`)).status, 404);
  assert.equal((await L.post(`/klassen/${c7}/apps/${quiz.id}/zurueckholen`)).status, 303);
  assert.equal(h.db.get('SELECT status FROM class_apps WHERE class_id = ? AND app_id = ?', c7, quiz.id).status, 'approved');
  h.db.run('DELETE FROM class_members WHERE user_id IN (?, ?)', pia.id, paul.id);
});

// ============================================================ projector, classes

test('QR-Status: nur für Lehrkräfte der Klasse, nur eine Zahl – keine Namen', async () => {
  const url = `/klassen/${c7}/qr/status`;
  const res = await json(L, url);
  assert.equal(res.status, 200);
  const data = res.json();
  assert.equal(data.joined, count("SELECT COUNT(*) AS n FROM class_members WHERE class_id = ? AND role = 'student'", c7));
  assert.equal(data.state, 'valid');
  for (const name of ['Mia', 'Ben', 'Schmidt', 'Hoffmann']) assert.ok(!res.text.includes(name), `no names (${name})`);
  assert.deepEqual(Object.keys(data).sort(), ['joined', 'state', 'stateText', 'text']);
  for (const who of [M, B, Y, O]) assert.equal((await json(who, url)).status, 404);
  assert.equal((await json(h.browser(), url)).status, 401);
  // the projector page itself
  const qr = await L.get(`/klassen/${c7}/qr`);
  assert.equal(qr.status, 200);
  assert.ok(qr.text.includes(joinCode(c7)));
  assert.ok(!qr.text.includes('class="nav"'), 'no navigation on the projector');
  assert.equal((await M.get(`/klassen/${c7}/qr`)).status, 404);

  // the open projector learns what became of its code: replaced, deleted, expired
  const shown = /data-status="[^"]*seit=(\d+)"/.exec(qr.text)[1];
  const stateOf = async () => (await json(L, `${url}?seit=${shown}`)).json();
  assert.equal((await stateOf()).state, 'valid');
  h.db.run("UPDATE join_codes SET expires_at = ? WHERE class_id = ? AND role = 'student'", Date.now() - 1000, c7);
  assert.deepEqual([(await stateOf()).state, (await stateOf()).stateText], ['expired', 'Der Code ist abgelaufen. Niemand kann mehr damit beitreten.']);
  await L.page(`/klassen/${c7}/einstellungen`);
  await L.post(`/klassen/${c7}/code/loeschen`);
  assert.deepEqual([(await stateOf()).state, (await stateOf()).stateText], ['deleted', 'Der Code wurde gelöscht. Niemand kann mehr damit beitreten.']);
  await L.post(`/klassen/${c7}/code`, { minuten: '60' });
  assert.equal((await stateOf()).state, 'replaced');
  assert.ok((await L.get(`/klassen/${c7}/qr`)).text.includes('id="teach-qr-dead"'), 'the page carries the "no valid code" view');
});

test('Klassen: Fach und Stufe werden geprüft; Umbenennen und Code-Löschen stehen im Protokoll; Beitreten nur nach Bestätigung', async () => {
  assert.equal((await L.post('/klassen', { name: 'Physik 8', fach: 'Physik', stufe: '8' })).status, 303);
  const p8 = teacherClass(lehmann.id, 'Physik 8');
  assert.deepEqual({ ...h.db.get('SELECT subject, grade FROM classes WHERE id = ?', p8) }, { subject: 'Physik', grade: 8 });
  assert.equal((await L.post('/klassen', { name: 'Zauberkunde', fach: 'Zauberei' })).status, 400);
  assert.equal((await L.post('/klassen', { name: 'Stufe 14', stufe: '14' })).status, 400);
  assert.equal((await M.post('/klassen', { name: 'Hack', fach: 'Physik' })).status, 404);
  assert.equal((await M.get('/klassen/neu')).status, 404);

  assert.equal((await M.post(`/klassen/${p8}/bearbeiten`, { name: 'gekapert' })).status, 404);
  assert.equal((await L.post(`/klassen/${p8}/bearbeiten`, { name: `Physik ${EVIL}`.slice(0, 60), fach: 'Physik', stufe: '9' })).status, 303);
  assert.ok(h.db.get("SELECT 1 AS ok FROM audit_log WHERE action = 'klasse_umbenannt'"));
  const page = await L.get(`/klassen/${p8}`);
  assert.ok(!page.text.includes('<script>alert(1)') && page.text.includes('&lt;script&gt;'));
  await L.post(`/klassen/${p8}/bearbeiten`, { name: 'Physik 8', fach: 'Physik', stufe: '9' });

  // revoking the join code: audited, and the old code no longer works
  const code = joinCode(p8);
  assert.equal((await L.post(`/klassen/${p8}/code/loeschen`)).status, 303);
  assert.ok(h.db.get("SELECT 1 AS ok FROM audit_log WHERE action = 'beitrittscode_geloescht' AND target = 'Physik 8'"));
  await O.page('/start');
  assert.equal((await O.post(`/beitreten/${code}`)).status, 400);

  // the confirmation page alone never joins
  await L.post(`/klassen/${p8}/code`, { minuten: '60' });
  const fresh = joinCode(p8);
  const confirm = await O.get(`/beitreten/${fresh}`);
  assert.equal(confirm.status, 200);
  assert.ok(confirm.text.includes('Ja, beitreten') && confirm.text.includes('Herr Lehmann'));
  assert.equal(h.hub.ctx.access.classRole(olaf, p8), null);
  assert.equal((await O.post(`/beitreten/${fresh}`)).status, 303);
  assert.equal(h.hub.ctx.access.classRole(olaf, p8), 'student');

  // removing a student says so and only touches students
  await L.page(`/klassen/${p8}/mitglieder`);
  assert.equal((await L.post(`/klassen/${p8}/mitglieder/${lehmann.id}/entfernen`)).status, 404, 'teachers are never removed here');
  assert.equal((await L.post(`/klassen/${p8}/mitglieder/${olaf.id}/entfernen`)).status, 303);
  assert.equal(h.hub.ctx.access.classRole(olaf, p8), null);
});

// ======================================================= from the security review

test('Ergebnisse zurücksetzen: nur die Ergebnisse aus dieser Klasse – andere Klassen und persönliche Daten bleiben', async () => {
  const sara = h.addUser('Sara Zwei', 'student');
  const S = await h.browser().login(sara);
  await S.post(`/beitreten/${joinCode(c7)}`);
  await S.post(`/beitreten/${joinCode(c9)}`);
  const t7 = await h.token(S, quiz, c7);
  await S.api(quiz, t7.token, 'results.add', { title: 'SARA-7B', score: 1, maxScore: 2 });
  await S.api(quiz, t7.token, 'save.set', { key: 'stand', value: 'SPIELSTAND' });
  await S.api(quiz, t7.token, 'progress.set', { value: 0.5 });
  await S.api(quiz, t7.token, 'scores.submit', { board: 'punkte', score: 7 });
  const t9 = await h.token(S, quiz, c9);
  await S.api(quiz, t9.token, 'results.add', { title: 'SARA-9C', score: 2, maxScore: 2 });
  h.db.run("INSERT INTO results (app_id, user_id, title, score, max_score, class_id, created_at) VALUES (?, ?, 'SARA-ALT', 1, 1, '', ?)", quiz.id, sara.id, Date.now());

  const here = `/klassen/${c7}/apps/${quiz.id}/ergebnisse/${sara.id}`;
  assert.equal((await Y.post(`${here}/loeschen`)).status, 404, 'not a teacher of 7b');
  assert.equal((await M.post(`${here}/loeschen`)).status, 404);
  const page = await L.page(here);
  assert.ok(page.text.includes('Gelöscht werden nur die Ergebnisse aus 7b'), 'the confirmation says what happens');
  assert.equal((await L.post(`${here}/loeschen`)).status, 303);
  const left = h.db.all('SELECT title FROM results WHERE user_id = ? ORDER BY title', sara.id).map((r) => r.title);
  assert.deepEqual(left, ['SARA-9C', 'SARA-ALT'], "only 7b's results are gone; 9c's and the legacy ones stay");
  for (const table of ['saves', 'progress', 'scores']) assert.equal(count(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`, sara.id), 1, `${table} stay (the student's own data)`);
  assert.ok((await Y.get(`/klassen/${c9}/apps/${quiz.id}/ergebnisse/${sara.id}`)).text.includes('SARA-9C'), "9c's teacher still sees 9c's result");
  h.db.run('DELETE FROM class_members WHERE user_id = ?', sara.id);
});

test('Rechte im Detail: Einstellungen nur für freigegebene Apps, Einzelansicht nur für Schüler/innen dieser Klasse, Entfernen nur durch Lehrkraft oder Besitzer/in', async () => {
  // (a) per-class settings exist only for an app APPROVED in this class
  await L.post('/klassen', { name: 'Einstellungsprobe' });
  const cs = teacherClass(lehmann.id, 'Einstellungsprobe');
  await L.post(`/klassen/${cs}/apps`, { app: quiz.id });
  const settings = `/klassen/${cs}/apps/${quiz.id}/einstellungen`;
  assert.equal((await L.get(settings)).status, 200);
  await L.post(`/klassen/${cs}/apps/${quiz.id}/entfernen`);
  assert.equal(h.db.get('SELECT status FROM class_apps WHERE class_id = ? AND app_id = ?', cs, quiz.id).status, 'removed');
  assert.equal((await L.get(settings)).status, 404, 'removed app: no settings');
  assert.equal((await L.post(settings, { gesendet: '1', 's-zeit': '10' })).status, 404);
  await M.post(`/beitreten/${joinCode(cs)}`);
  await B.post(`/beitreten/${joinCode(cs)}`);
  const own = await h.makeApp(M, 'Wartet noch', { 'index.html': 'x', 'schulhub.json': MANIFEST });
  await M.post(`/klassen/${cs}/apps`, { app: own.id });
  assert.equal(h.db.get('SELECT status FROM class_apps WHERE class_id = ? AND app_id = ?', cs, own.id).status, 'pending');
  assert.equal((await L.get(`/klassen/${cs}/apps/${own.id}/einstellungen`)).status, 404, 'pending app: no settings');
  assert.equal((await L.post(`/klassen/${cs}/apps/${own.id}/einstellungen`, { gesendet: '1', 's-zeit': '10' })).status, 404);
  assert.equal(count('SELECT COUNT(*) AS n FROM class_app_settings WHERE class_id = ?', cs), 0);
  // the amber count in the navigation leads to /klassen - and from there to the review
  const classes = (await L.get('/klassen')).text;
  assert.ok(classes.includes('1 App wartet auf deine Prüfung') && classes.includes('href="/pruefen"'));

  // (b) a class teacher reads only students OF THIS CLASS - never someone else through it
  const base = `/klassen/${c7}/apps/${quiz.id}/ergebnisse`;
  const lt = await h.token(LE, quiz, c9);
  await LE.api(quiz, lt.token, 'results.add', { title: 'LENA-9C', score: 1, maxScore: 1 });
  for (const uid of [lena.id, yilmaz.id, admin.id, 'gibt-es-nicht']) {
    assert.equal((await L.get(`${base}/${uid}`)).status, 404, uid);
    assert.equal((await L.post(`${base}/${uid}/loeschen`)).status, 404, uid);
  }
  assert.equal(count("SELECT COUNT(*) AS n FROM results WHERE user_id = ? AND title = 'LENA-9C'", lena.id), 1);

  // (c) only the class's teacher or the app's owner takes an app out of a class
  for (const who of [M, B]) assert.equal((await who.post(`/klassen/${c7}/apps/${quiz.id}/entfernen`)).status, 404);
  assert.equal((await Y.post(`/klassen/${c7}/apps/${quiz.id}/entfernen`)).status, 404);
  assert.equal(h.db.get('SELECT status FROM class_apps WHERE class_id = ? AND app_id = ?', c7, quiz.id).status, 'approved');
  assert.equal((await B.post(`/klassen/${cs}/apps/${own.id}/entfernen`)).status, 404, "a classmate cannot withdraw Mia's submission");
  assert.equal(h.db.get('SELECT status FROM class_apps WHERE class_id = ? AND app_id = ?', cs, own.id).status, 'pending');
  assert.equal((await M.post(`/klassen/${cs}/apps/${own.id}/entfernen`)).status, 303, 'the owner withdraws her own');
  assert.equal(h.db.get('SELECT 1 AS ok FROM class_apps WHERE class_id = ? AND app_id = ?', cs, own.id), undefined);
});

test('Beitreten: der Code einer archivierten Klasse verrät nichts – er wird wie ein falscher Code abgelehnt', async () => {
  await L.post('/klassen', { name: 'Geheimes Archiv' });
  const arch = teacherClass(lehmann.id, 'Geheimes Archiv');
  const code = joinCode(arch);
  await L.post(`/klassen/${arch}/archivieren`);
  const curious = h.addUser('Neu Gier', 'student');
  const N = await h.browser().login(curious);
  const res = await N.get(`/beitreten/${code}`);
  const wrong = await N.get(`/beitreten/${'Z'.repeat(32)}`);
  assert.equal(res.status, 400);
  assert.equal(wrong.status, 400);
  for (const secret of ['Geheimes Archiv', 'Herr Lehmann']) assert.ok(!res.text.includes(secret), `does not show ${secret}`);
  const sentence = (t) => /ungültig oder abgelaufen[^<]*/.exec(t)?.[0];
  assert.ok(sentence(res.text) && sentence(res.text) === sentence(wrong.text), 'the same refusal as for a wrong code');
  await N.page('/start');
  assert.equal((await N.post(`/beitreten/${code}`)).status, 400);
  assert.equal(h.hub.ctx.access.classRole(curious, arch), null);
});

test('Aufgaben: Ergebnisse von vor der Aufgabe zählen nie – auch nicht aus derselben Minute', async () => {
  const { assignments } = h.hub.ctx;
  const { inputDateTime } = require('../src/teachingKit');
  // Ben finishes a round, then the teacher gives the task "starting now" (the form only shows minutes)
  const bt = await h.token(B, quiz, c7);
  await B.api(quiz, bt.token, 'results.add', { title: 'VORHER', score: 1, maxScore: 1 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await L.page(`/klassen/${c7}/aufgaben/neu`);
  const res = await L.post(`/klassen/${c7}/aufgaben`, { app: quiz.id, titel: 'Ab jetzt', start: inputDateTime(Date.now()) });
  assert.equal(res.status, 303);
  const x = h.db.get('SELECT * FROM assignments WHERE id = ?', assignmentOf(res));
  assert.equal(x.starts_at, x.created_at, 'a start in the current minute is the moment of creation');
  assert.ok(x.starts_at > h.db.get("SELECT created_at FROM results WHERE title = 'VORHER'").created_at);
  assert.notEqual(assignments.stateOf(x, ben.id), 'done', 'the earlier result does not count');
  assert.ok(assignments.openFor(ben.id).some((t) => t.id === x.id), 'so it is on his start page');
  // a start in the past is the moment of creation too
  const past = h.db.get('SELECT * FROM assignments WHERE id = ?', assignmentOf(await L.post(`/klassen/${c7}/aufgaben`, { app: quiz.id, titel: 'Gestern', start: inputDateTime(Date.now() - 86_400_000) })));
  assert.equal(past.starts_at, past.created_at);
  // editing without touching the start keeps it exactly
  await L.post(`/aufgaben/${x.id}/bearbeiten`, { titel: 'Ab jetzt!', start: inputDateTime(x.starts_at) });
  assert.deepEqual({ ...h.db.get('SELECT title, starts_at FROM assignments WHERE id = ?', x.id) }, { title: 'Ab jetzt!', starts_at: x.starts_at });
});
