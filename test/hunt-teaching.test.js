'use strict';
// Bug hunt: teaching tools and what each person sees day to day - assignments, private
// feedback, the start pages of students and teachers, the class pages, notices about teaching
// events. Every test here failed on the code before its fix (see the commit that added it).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startHub } = require('./helpers');

const DAY = 86_400_000;
let h;
let seq = 0;

const idOf = (res) => res.headers.location.split('?')[0].split('/').pop();
const joinCode = (classId) => h.db.get("SELECT code FROM join_codes WHERE class_id = ? AND role = 'student'", classId).code;
/** The number in one stat tile of a page ("Klassen" -> 12). */
const statValue = (text, label) => {
  const m = new RegExp(`<span class="stat-label">${label}</span><span class="stat-value">([^<]*)</span>`).exec(text);
  return m ? m[1] : null;
};
/** The count next to a section heading (`<h2 id="s-tasks">Aufgaben <span class="count-text">7</span></h2>`). */
const sectionCount = (text, id) => {
  const m = new RegExp(`<h2 id="${id}">[^<]*(?:<span class="count-text">([^<]*)</span>)?</h2>`).exec(text);
  return m ? m[1] ?? null : undefined;
};

async function person(name, role) {
  const user = h.addUser(`${name} ${++seq}`, role);
  return { user, b: await h.browser().login(user) };
}
async function newClass(T, name) {
  const res = await T.post('/klassen', { name: `${name} ${++seq}` });
  assert.equal(res.status, 303);
  return idOf(res);
}
/** A class of a new teacher with the given number of new students and one app of the teacher in it. */
async function world(students = 1) {
  const teacher = await person('Herr Lehrer', 'teacher');
  const cls = await newClass(teacher.b, 'Klasse');
  const kids = [];
  for (let i = 0; i < students; i++) {
    const kid = await person('Kind', 'student');
    assert.equal((await kid.b.post(`/beitreten/${joinCode(cls)}`)).status, 303);
    kids.push(kid);
  }
  const app = await h.makeApp(teacher.b, `Übungsapp ${++seq}`, { 'index.html': '<h1>x</h1>' });
  assert.equal((await teacher.b.post(`/klassen/${cls}/apps`, { app: app.id })).status, 303);
  return { teacher, T: teacher.b, cls, kids, app };
}

before(async () => {
  h = await startHub();
});
after(() => h.stop());

// ------------------------------------------------------------------ start page: achievements

test('Start: Erfolge zeigen den geprüften Titel – nicht den einer neuen, noch nicht freigegebenen Version', async () => {
  const { b: L } = await person('Herr Erfolg', 'teacher');
  const { b: M } = await person('Max Autor', 'student');
  const { b: LE } = await person('Lea Mitschülerin', 'student');
  const cls = await newClass(L, '6a');
  for (const b of [M, LE]) assert.equal((await b.post(`/beitreten/${joinCode(cls)}`)).status, 303);
  const manifest = (title) => JSON.stringify({ achievements: [{ id: 'erste', title, emoji: '⭐' }] });
  const app = await h.makeApp(M, 'Wortspiel', { 'index.html': 'x', 'schulhub.json': manifest('Erste Runde') });
  assert.equal((await M.post(`/apps/${app.id}/einreichen`, { klasse: cls })).status, 303);
  assert.equal((await L.post(`/pruefen/${cls}/${app.id}/freigeben`, { version: app.published_version_id })).status, 303);
  const t = await h.token(LE, app, cls);
  assert.equal((await LE.api(app, t.token, 'achievements.unlock', { id: 'erste' })).json().ok, true);
  assert.ok((await LE.get('/start')).text.includes('Erste Runde'), 'precondition: the reviewed title is shown');

  // Max publishes a new version whose achievement title nobody reviewed: it waits for the teacher.
  const v2 = await h.uploadFolder(M, app.id, { 'index.html': 'x', 'schulhub.json': manifest('Lea ist doof') });
  assert.equal((await M.post(`/apps/${app.id}/veroeffentlichen`, { version: v2 })).status, 303);
  assert.equal(h.db.get('SELECT request_state FROM class_apps WHERE class_id = ? AND app_id = ?', cls, app.id).request_state, 'waiting');
  const start = (await LE.get('/start')).text;
  assert.ok(!start.includes('Lea ist doof'), 'text no teacher reviewed never reaches a classmate’s start page');
  assert.ok(start.includes('Erste Runde'), 'the title from the version her class uses');
  // End of the school year: the class is archived, Lea cannot open the app any more - the title stays the reviewed one.
  assert.equal((await L.post(`/klassen/${cls}/archivieren`)).status, 303);
  const later = (await LE.get('/start')).text;
  assert.ok(!later.includes('Lea ist doof') && later.includes('Erste Runde'), 'after archiving too');
});

// ------------------------------------------------------------------ removed and resubmitted

test('Schüler-App herausgenommen und neu eingereicht: Ergebnisse und Rückmeldungen zur Aufgabe bleiben für die Lehrkraft', async () => {
  const { user: lehrer, b: L } = await person('Frau Klar', 'teacher');
  const { b: M } = await person('Mia Autorin', 'student');
  const { user: ben, b: B } = await person('Ben Spieler', 'student');
  const cls = await newClass(L, '7c');
  for (const b of [M, B]) assert.equal((await b.post(`/beitreten/${joinCode(cls)}`)).status, 303);
  const app = await h.makeApp(M, 'Mias Quiz', { 'index.html': 'x' });
  assert.equal((await M.post(`/apps/${app.id}/einreichen`, { klasse: cls })).status, 303);
  assert.equal((await L.post(`/pruefen/${cls}/${app.id}/freigeben`, { version: app.published_version_id })).status, 303);
  const x = idOf(await L.post(`/klassen/${cls}/aufgaben`, { app: app.id, titel: 'Mias Quiz spielen' }));
  const bt = await h.token(B, app, cls);
  assert.equal((await B.api(app, bt.token, 'results.add', { title: 'BEN-ERGEBNIS', score: 3, maxScore: 4 })).json().ok, true);

  // Mia takes her app out of the class: "Ergebnisse bleiben für die Lehrkraft lesbar".
  assert.equal((await M.post(`/apps/${app.id}/aus-klasse`, { klasse: cls })).status, 303);
  const results = `/klassen/${cls}/apps/${app.id}/ergebnisse`;
  assert.equal((await L.get(results)).status, 200, 'precondition: removed, results readable');
  // ... and submits it again. Until the teacher decides, the old results must stay readable.
  assert.equal((await M.post(`/apps/${app.id}/einreichen`, { klasse: cls })).status, 303);
  assert.equal(h.db.get('SELECT status FROM class_apps WHERE class_id = ? AND app_id = ?', cls, app.id).status, 'pending');
  assert.equal((await L.get(results)).status, 200, 'the results list');
  assert.ok((await L.get(`${results}/${ben.id}`)).text.includes('BEN-ERGEBNIS'), "Ben's result in this class");
  // The feedback form on the assignment page still works.
  await L.page(`/aufgaben/${x}`);
  const fb = await L.post(`/klassen/${cls}/rueckmeldungen`, { schueler: ben.id, text: 'Gut gemacht!', app: app.id, aufgabe: x, zurueck: `/aufgaben/${x}` });
  assert.equal(fb.status, 303, 'feedback on the assignment');
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM feedback WHERE assignment_id = ? AND author_id = ?', x, lehrer.id).n, 1);
  // Given back this time: still the class's old results.
  assert.equal((await L.post(`/pruefen/${cls}/${app.id}/zurueckgeben`, { version: app.published_version_id, grund: 'Bitte mit Anleitung.' })).status, 303);
  assert.equal(h.db.get('SELECT status FROM class_apps WHERE class_id = ? AND app_id = ?', cls, app.id).status, 'rejected');
  assert.equal((await L.get(results)).status, 200, 'after giving it back');

  // Never approved in the class (only submitted): nothing to read, nothing to link - as before.
  const fresh = await h.makeApp(B, 'Bens Entwurf', { 'index.html': 'x' });
  assert.equal((await B.post(`/apps/${fresh.id}/einreichen`, { klasse: cls })).status, 303);
  assert.equal((await L.get(`/klassen/${cls}/apps/${fresh.id}/ergebnisse`)).status, 404);
  assert.equal((await L.get(`/klassen/${cls}/apps/${fresh.id}/ergebnisse/${ben.id}`)).status, 404);
  assert.equal((await L.post(`/klassen/${cls}/rueckmeldungen`, { schueler: ben.id, text: 'zu früh', app: fresh.id })).status, 404);
  assert.equal(h.db.get("SELECT COUNT(*) AS n FROM feedback WHERE body = 'zu früh'").n, 0);
});

// ------------------------------------------------------------------ notices

test('Aufgabe gelöscht: die Mitteilung „Neue Aufgabe“ geht mit – kein Link ins Leere', async () => {
  const { T, cls, kids, app } = await world(1);
  const [{ user: kid, b: K }] = kids;
  const x = idOf(await T.post(`/klassen/${cls}/aufgaben`, { app: app.id, titel: 'Wird gleich gelöscht' }));
  const notice = () => h.db.get("SELECT id FROM notices WHERE user_id = ? AND kind = 'aufgabe' AND href = ?", kid.id, `/aufgaben/${x}`);
  assert.ok(notice(), 'precondition: the student was told');
  assert.equal((await T.post(`/aufgaben/${x}/loeschen`)).status, 303);
  assert.equal((await K.get(`/aufgaben/${x}`)).status, 404, 'precondition: the assignment page is gone');
  assert.equal(notice(), undefined, 'the notice that led there went with it');
  assert.ok(!(await K.get('/mitteilungen')).text.includes('Wird gleich gelöscht'), 'not in her Mitteilungen');
});

test('Mitteilung „Neue Aufgabe“: der Termin steht als Datum drin – „morgen fällig“ stimmt schon am nächsten Tag nicht mehr', async () => {
  const { T, cls, kids, app } = await world(1);
  const [{ user: kid }] = kids;
  const { formatDay } = require('../src/util');
  const { inputDate } = require('../src/teachingKit');
  const due = Date.now() + DAY;
  const x = idOf(await T.post(`/klassen/${cls}/aufgaben`, { app: app.id, titel: 'Vokabeln', faellig: inputDate(due) }));
  const { text } = h.db.get("SELECT text FROM notices WHERE user_id = ? AND href = ?", kid.id, `/aufgaben/${x}`);
  const dueAt = h.db.get('SELECT due_at FROM assignments WHERE id = ?', x).due_at;
  assert.ok(!/heute|morgen|in \d+ Tagen/.test(text), `no words that are only true on the day it was sent: ${text}`);
  assert.ok(text.includes(formatDay(dueAt)), `the date itself: ${text}`);
});
