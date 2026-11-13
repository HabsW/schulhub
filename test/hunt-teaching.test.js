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

test('Start (Lehrkraft): „Wartet auf dich“ nennt, seit wann die Version wartet – wie die Prüfen-Liste', async () => {
  const { b: L } = await person('Frau Neu', 'teacher');
  const { b: M } = await person('Mila Bauerin', 'student');
  const cls = await newClass(L, '5a');
  assert.equal((await M.post(`/beitreten/${joinCode(cls)}`)).status, 303);
  const app = await h.makeApp(M, 'Milas Spiel', { 'index.html': 'v1' });
  assert.equal((await M.post(`/apps/${app.id}/einreichen`, { klasse: cls })).status, 303);
  assert.equal((await L.post(`/pruefen/${cls}/${app.id}/freigeben`, { version: app.published_version_id })).status, 303);
  // Approved in September; today she publishes version 2, which waits for the teacher.
  h.db.run('UPDATE class_apps SET created_at = ? WHERE class_id = ? AND app_id = ?', Date.now() - 60 * DAY, cls, app.id);
  h.db.run("UPDATE comments SET created_at = ? WHERE app_id = ? AND kind = 'submitted'", Date.now() - 60 * DAY, app.id);
  const v2 = await h.uploadFolder(M, app.id, { 'index.html': 'v2' });
  assert.equal((await M.post(`/apps/${app.id}/veroeffentlichen`, { version: v2 })).status, 303);
  const rowOf = (text) => (/<a class="row-link row-title" href="\/pruefen\/[^"]+">Milas Spiel<\/a>\s*<span class="row-sub">([^<]*)<\/span>/.exec(text) || [])[1] || '';
  const queue = (await L.get('/pruefen')).text;
  assert.match(queue, /eingereicht gerade eben/, 'precondition: the review queue says it was just submitted');
  const start = rowOf((await L.get('/start')).text);
  assert.ok(start.includes('Version 2'), `precondition: ${start}`);
  assert.ok(start.endsWith('gerade eben'), `the start page agrees: ${start}`);
});

// ------------------------------------------------------------------ counts on the start pages

test('Start (Schüler/in): die Zahl der offenen Aufgaben stimmt auch bei mehr als sechs', async () => {
  const { T, cls, kids, app } = await world(1);
  const [{ b: K }] = kids;
  for (let i = 1; i <= 7; i++) {
    const faellig = new Date(Date.now() + (i + 3) * DAY).toISOString().slice(0, 10);
    assert.equal((await T.post(`/klassen/${cls}/aufgaben`, { app: app.id, titel: `Aufgabe Nr. ${i}`, faellig })).status, 303);
  }
  const start = (await K.get('/start')).text;
  assert.equal(sectionCount(start, 's-tasks'), '7', 'the head says how many are open');
});

test('Start (Lehrkraft): Klassen, wartende Apps und fällige Aufgaben werden ganz gezählt – nicht nur so viele, wie die Liste zeigt', async () => {
  const { b: T } = await person('Frau Viele', 'teacher');
  const classes = [];
  for (let i = 0; i < 13; i++) classes.push(await newClass(T, `Kurs ${String(i).padStart(2, '0')}`));
  const app = await h.makeApp(T, 'Viel-App', { 'index.html': 'x' });
  for (const c of classes.slice(0, 6)) assert.equal((await T.post(`/klassen/${c}/apps`, { app: app.id })).status, 303);
  for (const [i, c] of classes.slice(0, 6).entries()) {
    const faellig = new Date(Date.now() + (i + 1) * DAY).toISOString().slice(0, 10);
    assert.equal((await T.post(`/klassen/${c}/aufgaben`, { app: app.id, titel: `Bald ${i}`, faellig })).status, 303);
  }
  const start = (await T.get('/start')).text;
  assert.equal(statValue(start, 'Klassen'), '13', 'all 13 classes are counted');
  assert.equal(statValue(start, 'Aufgaben fällig'), '6', 'all 6 assignments due soon are counted');
});

test('Start (Lehrkraft): „Wartet auf dich“ zählt alle wartenden Apps – wie die Navigation', async () => {
  const { b: T } = await person('Herr Prüfer', 'teacher');
  const cls = await newClass(T, 'Prüfklasse');
  const now = Date.now();
  // 21 student apps waiting in his class (written directly: the submission route has its own limits).
  for (let i = 0; i < 21; i++) {
    const kid = h.addUser(`Bauer ${i} ${++seq}`, 'student');
    h.db.run("INSERT INTO class_members (class_id, user_id, role, joined_at) VALUES (?, ?, 'student', ?)", cls, kid.id, now);
    const appId = `warte-${seq}`;
    h.db.run("INSERT INTO apps (id, owner_id, name, emoji, origin_key, created_at, updated_at) VALUES (?, ?, ?, '🎮', ?, ?, ?)", appId, kid.id, `Warte-App ${i}`, `o${seq}x${i}`, now, now);
    h.db.run("INSERT INTO app_versions (id, app_id, number, status, created_at) VALUES (?, ?, 1, 'ready', ?)", `${appId}-v1`, appId, now);
    h.db.run('UPDATE apps SET published_version_id = ? WHERE id = ?', `${appId}-v1`, appId);
    h.db.run("INSERT INTO class_apps (class_id, app_id, status, requested_version_id, request_state, added_by, created_at) VALUES (?, ?, 'pending', ?, 'waiting', ?, ?)", cls, appId, `${appId}-v1`, kid.id, now + i);
  }
  const start = (await T.get('/start')).text;
  assert.match(start, /aria-label="21 warten auf Prüfung"/, 'precondition: the navigation counts 21');
  assert.equal(statValue(start, 'Warten auf Prüfung'), '21', 'the stat counts all of them');
  assert.equal(sectionCount(start, 's-wait'), '21', '… and so does the head of the list');
});

test('Start (Lehrkraft): „Heute aktiv“ zählt keine Schüler/innen aus archivierten Klassen', async () => {
  const { T, cls, kids, app } = await world(1);
  const [{ b: K }] = kids;
  // Last year's class used the same app; it is archived now. A former student of it uses the app
  // today - in her new class, with a colleague who added his shared app there.
  const old = await newClass(T, 'Vorjahr');
  assert.equal((await T.post(`/klassen/${old}/apps`, { app: app.id })).status, 303);
  const former = await person('Ehemalige', 'student');
  assert.equal((await former.b.post(`/beitreten/${joinCode(old)}`)).status, 303);
  assert.equal((await T.post(`/klassen/${old}/archivieren`)).status, 303);
  const colleague = await person('Frau Kollegin', 'teacher');
  const fresh = await newClass(colleague.b, 'Neue Klasse');
  h.db.run('UPDATE apps SET shared = 1 WHERE id = ?', app.id);
  assert.equal((await colleague.b.post(`/klassen/${fresh}/apps`, { app: app.id })).status, 303);
  assert.equal((await former.b.post(`/beitreten/${joinCode(fresh)}`)).status, 303);
  assert.ok(await h.token(former.b, app, fresh), 'she plays the app in her new class today');
  assert.equal(statValue((await T.get('/start')).text, 'Heute aktiv'), '0', 'nobody of his active classes was active');
  assert.ok(await h.token(K, app, cls));
  assert.equal(statValue((await T.get('/start')).text, 'Heute aktiv'), '1', 'his own student, in his class');
});

test('Start (Lehrkraft): „Heute aktiv“ zählt nur, was die Lehrkraft sehen darf – Apps ihrer Klasse, nicht Apps anderer Klassen', async () => {
  const { T, cls, kids } = await world(1);
  const [{ b: K }] = kids;
  // The student also is in another teacher's class and plays there - an app the first teacher never sees.
  const elsewhere = await world(0);
  assert.equal((await K.post(`/beitreten/${joinCode(elsewhere.cls)}`)).status, 303);
  assert.ok(await h.token(K, elsewhere.app, elsewhere.cls));
  const overview = (await T.get(`/klassen/${cls}`)).text;
  assert.equal(statValue(overview, 'Aktiv diese Woche'), '0', 'precondition: the class page counts her as not active in this class');
  assert.equal(statValue((await T.get('/start')).text, 'Heute aktiv'), '0', 'the start page agrees with the class page');
});

// ------------------------------------------------------------------ assignment of a removed app

test('Aufgabe zu einer entfernten App: die Schülerin kann sie trotzdem selbst als erledigt markieren', async () => {
  const { T, cls, kids, app } = await world(1);
  const [{ user: kid, b: K }] = kids;
  const x = idOf(await T.post(`/klassen/${cls}/aufgaben`, { app: app.id, titel: 'Mit entfernter App' }));
  assert.equal((await T.post(`/klassen/${cls}/apps/${app.id}/entfernen`)).status, 303);
  const page = (await K.page(`/aufgaben/${x}`)).text;
  assert.ok(page.includes('Diese App ist nicht mehr in der Klasse'), 'precondition: the student is told');
  assert.ok(page.includes('Du kannst sie auch selbst als erledigt markieren'), 'precondition: the page promises it');
  assert.ok(page.includes(`action="/aufgaben/${x}/erledigt"`), 'the button is there');
  assert.equal((await K.post(`/aufgaben/${x}/erledigt`)).status, 303);
  assert.equal(h.hub.ctx.assignments.stateOf({ id: x }, kid.id), 'done');
  assert.ok(!(await K.get('/start')).text.includes('Mit entfernter App'), 'off her start page');
});

// ------------------------------------------------------------------ archived classes are read-only

test('Archivierte Klasse: Rückmeldungen löscht die Lehrkraft dort nicht mehr – die Schülerin ihre eigenen schon', async () => {
  const { T, cls, kids } = await world(2);
  const [{ user: mia, b: M }, { user: ben }] = kids;
  for (const [kid, text] of [[mia, 'FUER-MIA'], [ben, 'FUER-BEN']]) {
    assert.equal((await T.post(`/klassen/${cls}/rueckmeldungen`, { schueler: kid.id, text })).status, 303);
  }
  const id = (text) => h.db.get('SELECT id FROM feedback WHERE body = ?', text)?.id;
  const [toMia, toBen] = [id('FUER-MIA'), id('FUER-BEN')];
  assert.equal((await T.post(`/klassen/${cls}/archivieren`)).status, 303);
  // "Archiviert – nur noch lesbar … niemand kann etwas ändern": the page offers no delete button ...
  const detail = (await T.get('/rueckmeldungen')).text;
  assert.ok(detail.includes('FUER-BEN'), 'precondition: the teacher still reads it');
  assert.ok(!detail.includes(`/rueckmeldungen/${toBen}/loeschen`), 'no delete button in an archived class');
  // ... and the route refuses.
  assert.equal((await T.post(`/rueckmeldungen/${toBen}/loeschen`)).status, 404);
  assert.ok(id('FUER-BEN'), 'the feedback is still there');
  // The student's own data stays hers to delete.
  await M.page('/rueckmeldungen');
  assert.equal((await M.post(`/rueckmeldungen/${toMia}/loeschen`)).status, 303);
  assert.equal(id('FUER-MIA'), undefined);
});
