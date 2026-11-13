'use strict';
// Bug hunt: classes and membership. Each test plays one situation a student, a teacher or the
// admin really runs into (a colleague who tried the class QR code first, a teacher with many
// classes, a deleted class, a hand-made request) and checks what they see and what is stored.
// Tests marked `todo` show a confirmed problem whose fix is a product decision: they run and
// report, but do not fail the suite.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startHub } = require('./helpers');

let h;
let tom, beta, mia;
let T, BT, M;

let seq = 0;
const uniq = (prefix) => `${prefix} ${++seq}`;
const idFrom = (res) => res.headers.location.split('?')[0].split('/').pop();
const joinCode = (classId, role = 'student') => h.db.get('SELECT code FROM join_codes WHERE class_id = ? AND role = ? ORDER BY created_at DESC', classId, role)?.code;
const classRole = (userId, classId) => h.db.get('SELECT role FROM class_members WHERE class_id = ? AND user_id = ?', classId, userId)?.role ?? null;
const csrfOf = (res) => /<meta name="csrf" content="([^"]*)"/.exec(res.text)[1];
const flashOf = (res) => /<div class="notice[^"]*\bflash\b[^>]*>([\s\S]*?)<\/div>/.exec(res.text)?.[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() ?? '';

async function newClass(Tb, name = uniq('Klasse')) {
  const res = await Tb.post('/klassen', { name });
  assert.equal(res.status, 303);
  return { id: idFrom(res), name };
}
async function person(name, role) {
  const user = h.addUser(name, role);
  return { user, b: await h.browser().login(user) };
}

before(async () => {
  h = await startHub();
  tom = h.addUser('Tom Lehrer', 'teacher');
  beta = h.addUser('Frau Beta', 'teacher');
  mia = h.addUser('Mia Kind', 'student');
  [T, BT, M] = await Promise.all([tom, beta, mia].map((u) => h.browser().login(u)));
});
after(() => h.stop());

// ------------------------------------------------------------ co-teacher invitation

test('Einladung: eine Lehrkraft, die die Klasse vorher per QR-Code als Schüler/in betreten hat, wird mit der Einladung Lehrkraft – nicht still übergangen', async () => {
  const c = await newClass(T);
  // Frau Beta tries the class QR code on her phone first (as teachers do): she becomes a student - by design.
  assert.equal((await BT.post(`/beitreten/${joinCode(c.id)}`)).status, 303);
  assert.equal(classRole(beta.id, c.id), 'student');
  // Then Tom invites her to teach the class with him.
  await T.page(`/klassen/${c.id}/mitglieder`);
  assert.equal((await T.post(`/klassen/${c.id}/einladung`, { minuten: '60' })).status, 303);
  const invite = joinCode(c.id, 'teacher');

  // The invitation shows what it is for - not a silent jump to her student view of the class.
  const look = await BT.get(`/beitreten/${invite}`);
  assert.equal(look.status, 200, 'the invitation page is shown');
  assert.ok(look.text.includes('Als Lehrkraft beitreten'));
  assert.equal(classRole(beta.id, c.id), 'student', 'looking alone changes nothing');

  await BT.page('/start');
  const done = await BT.post(`/beitreten/${invite}`);
  assert.equal(done.status, 303);
  assert.equal(classRole(beta.id, c.id), 'teacher', 'the invitation made her a teacher of the class');
  assert.match(flashOf(await BT.get(done.headers.location)), /führst „.*“ jetzt mit/);
  assert.equal((await BT.get(`/klassen/${c.id}/mitglieder`)).status, 200, 'she sees the teacher tabs');
  assert.equal(h.db.get("SELECT COUNT(*) AS n FROM audit_log WHERE actor_id = ? AND action = 'klasse_beigetreten' AND detail = 'als Lehrkraft'", beta.id).n, 1);

  // Nothing else moves: a student account in the class gets nothing from the invitation ...
  assert.equal((await M.post(`/beitreten/${joinCode(c.id)}`)).status, 303);
  await M.page('/start');
  assert.equal((await M.post(`/beitreten/${invite}`)).status, 400);
  assert.equal(classRole(mia.id, c.id), 'student');
  // ... and a teacher of the class who opens the class code stays its teacher.
  await T.page('/start');
  assert.equal((await T.post(`/beitreten/${joinCode(c.id)}`)).status, 303);
  assert.equal(classRole(tom.id, c.id), 'teacher');
  assert.equal((await BT.post(`/beitreten/${joinCode(c.id)}`)).status, 303);
  assert.equal(classRole(beta.id, c.id), 'teacher', 'the class code never turns a teacher back into a student');
});

test('Klasse verlassen: bleibt nur eine gesperrte Lehrkraft zurück, ist die Klasse verwaist – die letzte aktive Lehrkraft geht nicht', async () => {
  const c = await newClass(T);
  const gast = await person('Herr Gast', 'teacher');
  await T.page(`/klassen/${c.id}/mitglieder`);
  assert.equal((await T.post(`/klassen/${c.id}/einladung`, { minuten: '60' })).status, 303);
  assert.equal((await gast.b.post(`/beitreten/${joinCode(c.id, 'teacher')}`)).status, 303);
  assert.equal(classRole(gast.user.id, c.id), 'teacher');
  // Herr Gast leaves the school: the admin blocks his account (as the admin page suggests).
  const { b: AD } = await person('Anna Admin', 'admin');
  await AD.page('/admin');
  assert.equal((await AD.post(`/admin/nutzer/${gast.user.id}/sperren`, { an: '1' })).status, 303);
  // Tom must not leave: nobody who can sign in would teach the class any more.
  const settings = await T.page(`/klassen/${c.id}/einstellungen`);
  assert.ok(!settings.text.includes(`action="/klassen/${c.id}/verlassen"`), 'no leave button');
  assert.equal((await T.post(`/klassen/${c.id}/verlassen`)).status, 400);
  assert.equal(classRole(tom.id, c.id), 'teacher');
  // Unblocked again, Herr Gast counts again.
  assert.equal((await AD.post(`/admin/nutzer/${gast.user.id}/sperren`, { an: '0' })).status, 303);
  await T.page(`/klassen/${c.id}/einstellungen`);
  assert.equal((await T.post(`/klassen/${c.id}/verlassen`)).status, 303);
  assert.equal(classRole(tom.id, c.id), null);
});

// ------------------------------------------------------------- class lists

test('Startseite: eine Lehrkraft mit mehr als 12 Klassen sieht die richtige Zahl und kommt zu allen', async () => {
  const { user, b } = await person('Herr Viele', 'teacher');
  const names = [];
  for (let i = 0; i < 13; i++) names.push((await newClass(b, `Kurs ${String(i).padStart(2, '0')}`)).name);
  await b.get('/klassen'); // the flash of the last "angelegt" is shown here, not on the start page
  const start = (await b.get('/start')).text;
  const stat = /<span class="stat-label">Klassen<\/span><span class="stat-value">(\d+)<\/span>/.exec(start);
  assert.equal(stat && stat[1], '13', 'the number on the start page counts every class');
  const main = start.split('<main')[1];
  const listed = names.filter((n) => main.includes(`>${n}<`));
  // At most 12 rows, but then the way to all of them is on the page.
  assert.ok(listed.length === 13 || /href="\/klassen"[^>]*>(?:<svg[\s\S]*?<\/svg>)?<span>Alle 13 Klassen<\/span>/.test(main), `listed ${listed.length} of 13 and no link to all of them`);
  assert.equal(h.db.get("SELECT COUNT(*) AS n FROM class_members WHERE user_id = ? AND role = 'teacher'", user.id).n, 13);
});

test('Große Klasse (über 300): Überblick und Mitglieder zählen alle – die Liste zeigt die ersten 300 und sagt es', async () => {
  const { b } = await person('Frau Groß', 'teacher');
  const c = await newClass(b, uniq('Schulchor'));
  // 301 students, written directly (joining one by one is tested elsewhere).
  h.db.tx(() => {
    for (let i = 0; i < 301; i++) {
      const u = h.addUser(`Chorkind ${String(i).padStart(3, '0')}`, 'student');
      h.db.run("INSERT INTO class_members (class_id, user_id, role, joined_at) VALUES (?, ?, 'student', ?)", c.id, u.id, Date.now());
    }
  });
  const overview = (await b.get(`/klassen/${c.id}`)).text;
  assert.ok(overview.includes('301 Schüler/innen'), 'the page head counts all');
  const stat = /<span class="stat-label">Schüler\/innen<\/span><span class="stat-value">(\d+)<\/span>/.exec(overview);
  assert.equal(stat && stat[1], '301', 'the number on the overview counts all');
  assert.ok(overview.includes('von 301 · seit Montag'));
  const members = (await b.get(`/klassen/${c.id}/mitglieder`)).text;
  const count = /<h2 id="s-students">[^<]*<span class="count-text">(\d+)<\/span><\/h2>/.exec(members);
  assert.equal(count && count[1], '301', 'the members heading counts all');
  assert.ok(members.includes('Es werden die ersten 300 von 301 Schüler/innen gezeigt.'));
});

// ------------------------------------------------------------- deleting a class

test('Klasse löschen: Mitteilungen, die in die Klasse führen, verschwinden mit ihr – auf jedem Weg, andere Klassen bleiben', async () => {
  const quiz = await h.makeApp(T, uniq('Quiz'), { 'index.html': '<h1>Quiz</h1>' });
  h.db.run('UPDATE apps SET shared = 1 WHERE id = ?', quiz.id); // colleagues may use it in their classes
  const own = await h.makeApp(M, uniq('Mias Spiel'), { 'index.html': '<h1>Mia</h1>' });

  /** A class of `Tb` with Mia, an assignment (Mia is told) and Mia's app waiting (the teachers are told). */
  async function busyClass(Tb) {
    const c = await newClass(Tb);
    assert.equal((await M.post(`/beitreten/${joinCode(c.id)}`)).status, 303);
    assert.equal((await Tb.post(`/klassen/${c.id}/apps`, { app: quiz.id })).status, 303);
    const x = await Tb.post(`/klassen/${c.id}/aufgaben`, { app: quiz.id, titel: uniq('Aufgabe') });
    assert.equal(x.status, 303);
    assert.equal((await M.post(`/klassen/${c.id}/apps`, { app: own.id })).status, 303);
    return { ...c, x: idFrom(x) };
  }
  const leading = (c) => h.db.all("SELECT user_id, href FROM notices WHERE href = ? OR href LIKE '/pruefen/' || ? || '/%'", `/aufgaben/${c.x}`, c.id);

  const keep = await busyClass(T);
  // (1) The teacher deletes the class.
  const gone = await busyClass(T);
  assert.equal(leading(gone).length, 2, 'Mia was told about the assignment, Tom about the waiting app');
  await T.page(`/klassen/${gone.id}/einstellungen`);
  assert.equal((await T.post(`/klassen/${gone.id}/loeschen`)).status, 303);
  assert.equal((await M.get(`/aufgaben/${gone.x}`)).status, 404, 'the assignment is gone');
  assert.deepEqual(leading(gone), [], 'no notice leads into the deleted class');

  // (2) The retention rule deletes an archived class.
  const old = await busyClass(T);
  await T.page(`/klassen/${old.id}/einstellungen`);
  assert.equal((await T.post(`/klassen/${old.id}/archivieren`)).status, 303);
  h.db.run('UPDATE classes SET archived_at = ? WHERE id = ?', Date.now() - 400 * 86_400_000, old.id);
  h.hub.ctx.services.maintenance();
  assert.equal(h.db.get('SELECT 1 AS ok FROM classes WHERE id = ?', old.id), undefined);
  assert.deepEqual(leading(old), []);

  // (3) The only teacher deletes their account: the class goes with it.
  const solo = await person('Frau Solo', 'teacher');
  const orphan = await busyClass(solo.b);
  await solo.b.page('/meine-daten');
  assert.equal((await solo.b.post('/meine-daten/konto-loeschen', { bestaetigung: 'LÖSCHEN' })).status, 303);
  assert.equal(h.db.get('SELECT 1 AS ok FROM classes WHERE id = ?', orphan.id), undefined);
  assert.deepEqual(leading(orphan), []);

  // The other class keeps its notices.
  assert.equal(leading(keep).length, 2, 'notices of another class stay');
});

test('Verwaltung: archivierte Klassen nennen den Löschtag mit Jahr – „Sa., 13. Nov.“ läse sich wie morgen', async () => {
  const { formatFullDate } = require('../src/util');
  const { b: AD } = await person('Ada Admin', 'admin');
  const c = await newClass(T);
  await T.page(`/klassen/${c.id}/einstellungen`);
  assert.equal((await T.post(`/klassen/${c.id}/archivieren`)).status, 303);
  const archivedAt = h.db.get('SELECT archived_at FROM classes WHERE id = ?', c.id).archived_at;
  const day = formatFullDate(archivedAt + h.hub.ctx.settings.get('retention.archivedClassDays') * 86_400_000);
  assert.match(day, /\d{4}$/);
  // The teacher's page already says it with the year ...
  assert.ok((await T.get(`/klassen/${c.id}/einstellungen`)).text.includes(`Wird am ${day} gelöscht.`));
  // ... the admin's list of archived classes says the same day.
  const list = (await AD.get(`/admin/klassen?archiv=1&q=${encodeURIComponent(c.name)}`)).text;
  const row = list.split(`>${c.name}</a>`)[1].split('</tr>')[0];
  assert.ok(row.includes(`wird am ${day} gelöscht`), row.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200));
});

// ------------------------------------------------------------- hand-made requests

test('Formulare der Klassen ohne Inhalt (nur das CSRF-Token im Kopf): eine Antwort, kein Serverfehler', async () => {
  const c = await newClass(T);
  const csrf = csrfOf(await T.page(`/klassen/${c.id}/einstellungen`));
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args);
  try {
    for (const [url, want] of [
      ['/klassen', 400], // no name
      [`/klassen/${c.id}/bearbeiten`, 400],
      [`/klassen/${c.id}/umbenennen`, 400],
      [`/klassen/${c.id}/code`, 303], // like the form with its default duration
      [`/klassen/${c.id}/einladung`, 303],
      [`/klassen/${c.id}/apps`, 404], // no app
    ]) {
      const res = await T.raw('POST', url, { headers: { 'x-csrf-token': csrf } });
      assert.equal(res.status, want, `${url} -> ${res.status}`);
    }
  } finally {
    console.error = original;
  }
  assert.deepEqual(errors, [], 'nothing was logged as a server error');
  assert.equal(h.db.get('SELECT name FROM classes WHERE id = ?', c.id).name, c.name, 'the class is unchanged');
});

// ------------------------------------------------------------- confirmed, fix proposed

test('Mitglied entfernen: wer entfernt wurde, kommt erst mit einem neuen Code zurück – wie die Bestätigung es sagt', { todo: 'Produktentscheidung: Rückkehr mit dem alten Code sperren (Entfernen merken) oder den Bestätigungstext ändern' }, async () => {
  const c = await newClass(T);
  const kid = await person('Kai Fremd', 'student');
  const code = joinCode(c.id);
  assert.equal((await kid.b.post(`/beitreten/${code}`)).status, 303);
  const members = await T.page(`/klassen/${c.id}/mitglieder`);
  assert.ok(members.text.includes('Mit einem neuen QR-Code kann Kai Fremd wieder beitreten.'), 'what the teacher is told before removing');
  assert.equal((await T.post(`/klassen/${c.id}/mitglieder/${kid.user.id}/entfernen`)).status, 303);
  assert.equal(classRole(kid.user.id, c.id), null);
  // The code on the board (valid for up to a week) still lets him straight back in.
  const back = await kid.b.post(`/beitreten/${code}`);
  assert.equal(classRole(kid.user.id, c.id), null, `the old code let him back in (${back.status})`);
});

test('Beitreten: ein veralteter Link zählt pro Klick einmal – vier Klicks sperren den neuen, gültigen Code nicht', { todo: 'Vorschlag: denselben falschen Code nur einmal zählen (oder nur das Absenden zählen)' }, async () => {
  const c = await newClass(T);
  const kid = await person('Lia Eilig', 'student');
  const stale = joinCode(c.id);
  assert.equal((await kid.b.page(`/beitreten/${stale}`)).status, 200, 'the confirmation page is open');
  // Meanwhile the teacher makes a new code (the projector reloads by itself).
  await T.page(`/klassen/${c.id}/einstellungen`);
  assert.equal((await T.post(`/klassen/${c.id}/code`, { minuten: '60' })).status, 303);
  // "Ja, beitreten" on the open page, four times, like a browser: the form error goes back to the page.
  const referer = `${h.config.hubOrigin}/beitreten/${stale}`;
  for (let i = 0; i < 4; i++) {
    const res = await kid.b.post(`/beitreten/${stale}`, {}, { headers: { referer } });
    assert.equal(res.status, 303);
    assert.equal((await kid.b.get(res.headers.location)).status, 400);
  }
  // Now Lia scans the new QR code on the board.
  const fresh = await kid.b.get(`/beitreten/${joinCode(c.id)}`);
  assert.equal(fresh.status, 200, `the new code is refused with ${fresh.status}`);
});

test('Beitreten: wer schon in der Klasse ist und den alten Link aus dem Chat öffnet, landet in der Klasse – nicht bei „frag nach einem neuen Code“', { todo: 'Vorschlag: abgelaufener Code einer Klasse, in der die Person ist (und die sie sehen darf) -> zur Klasse, ohne Fehlversuch' }, async () => {
  const c = await newClass(T);
  const kid = await person('Ole Dabei', 'student');
  const code = joinCode(c.id);
  assert.equal((await kid.b.post(`/beitreten/${code}`)).status, 303);
  // A week later the teacher's link in the class chat has expired; Ole uses it to get to his class.
  h.db.run('UPDATE join_codes SET expires_at = ? WHERE code = ?', Date.now() - 1000, code);
  const res = await kid.b.get(`/beitreten/${code}`);
  assert.equal(classRole(kid.user.id, c.id), 'student');
  assert.equal(res.status, 302, `he is told: ${/ungültig oder abgelaufen[^<]*/.exec(res.text)?.[0]}`);
  assert.equal(res.headers.location, `/klassen/${c.id}`);
});

// Outside the classes area (start page of a student in several classes), found on the way.
test('Startseite einer Schülerin in mehreren Klassen: „Aufgaben“ zählt alle offenen – nicht nur die sechs gezeigten', { todo: 'Vorschlag: Gesamtzahl zählen und unter der Liste auf die Klassenseiten verweisen' }, async () => {
  const kid = await person('Pia Viele', 'student');
  const quiz = await h.makeApp(T, uniq('Quiz'), { 'index.html': '<h1>Quiz</h1>' });
  for (let i = 0; i < 4; i++) {
    const c = await newClass(T);
    assert.equal((await kid.b.post(`/beitreten/${joinCode(c.id)}`)).status, 303);
    assert.equal((await T.post(`/klassen/${c.id}/apps`, { app: quiz.id })).status, 303);
    for (let j = 0; j < 2; j++) assert.equal((await T.post(`/klassen/${c.id}/aufgaben`, { app: quiz.id, titel: uniq('Aufgabe') })).status, 303);
  }
  const open = h.hub.ctx.assignments.openFor(kid.user.id, { limit: 100 }).length;
  assert.equal(open, 8);
  const start = (await kid.b.get('/start')).text;
  const heading = /<h2 id="s-tasks">[^<]*<span class="count-text">(\d+)<\/span><\/h2>/.exec(start);
  assert.equal(heading && heading[1], '8', 'the heading counts every open assignment');
});
