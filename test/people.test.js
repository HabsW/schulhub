'use strict';
// Attack tests for fix package P2 ("people and content"), from the final security review:
// a student cannot rename an approved app behind the teacher's back, what students are told
// about teachers is true, planned assignments stay hidden from students until their start,
// and account deletion knows every column that can hold a person's id.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startHub } = require('./helpers');
const { EMOJIS } = require('../src/html');
const { inputDateTime } = require('../src/teachingKit');
const { TEACHERS_SEE } = require('../src/teacherView');

const DAY = 86_400_000;
const teacherClass = (h, userId, name) =>
  h.db.get("SELECT c.id FROM classes c JOIN class_members m ON m.class_id = c.id AND m.user_id = ? AND m.role = 'teacher' WHERE c.name = ?", userId, name).id;
const joinCode = (h, classId) => h.db.get("SELECT code FROM join_codes WHERE class_id = ? AND role = 'student'", classId).code;

test('Name und Beschreibung: eine Schüler-App, die die Klasse sieht, lässt sich nicht still umbenennen', async () => {
  const h = await startHub();
  try {
    const admin = h.addUser('Anna Adler', 'admin');
    const lehmann = h.addUser('Herr Lehmann', 'teacher');
    const max = h.addUser('Max Autor', 'student');
    const lea = h.addUser('Lea Mitschülerin', 'student');
    const [A, L, M, LE] = await Promise.all([admin, lehmann, max, lea].map((u) => h.browser().login(u)));
    await L.post('/klassen', { name: '6a' });
    const cls = teacherClass(h, lehmann.id, '6a');
    for (const b of [M, LE]) await b.post(`/beitreten/${joinCode(h, cls)}`);
    const app = await h.makeApp(M, 'Wortspiel', { 'index.html': 'x' });
    const row = () => ({ ...h.db.get('SELECT name, description, emoji, color FROM apps WHERE id = ?', app.id) });
    const edit = (b, fields) => b.post(`/apps/${app.id}/bearbeiten`, { emoji: EMOJIS[0], color: '0', ...fields });
    const rename = (b) => edit(b, { name: 'Lea ist doof', description: 'Text, den keine Lehrkraft geprüft hat' });

    // In no class yet: the owner names it freely.
    assert.equal((await edit(M, { name: 'Wortspiel', description: 'Wörter raten' })).status, 303);
    // Waiting for review: the teacher is about to look at exactly this text.
    assert.equal((await M.post(`/apps/${app.id}/einreichen`, { klasse: cls })).status, 303);
    const waiting = await rename(M);
    assert.equal(waiting.status, 400, 'waiting in a class: refused');
    assert.match(waiting.text, /Zieh die Einreichung in 6a zurück/, 'the message says what to do');
    // Approved: classmates see it on their class page and start page.
    assert.equal((await L.post(`/pruefen/${cls}/${app.id}/freigeben`, { version: app.published_version_id })).status, 303);
    const refused = await rename(M);
    assert.equal(refused.status, 400, 'approved in a class: refused');
    assert.match(refused.text, /Nimm die App aus 6a heraus/, 'the message says what to do');
    assert.equal((await edit(M, { name: 'Wortspiel', description: 'Ein ganz anderer Text' })).status, 400, 'the description alone is refused too');
    assert.equal((await edit(M, { name: 'Wortspiel', description: '' })).status, 400, 'emptying the description is refused too');
    assert.deepEqual(row(), { name: 'Wortspiel', description: 'Wörter raten', emoji: EMOJIS[0], color: 0 });
    for (const url of [`/klassen/${cls}`, '/start']) assert.ok(!(await LE.get(url)).text.includes('Lea ist doof'), `classmate's ${url}`);

    // The form says so up front: no name field, the reason and the way out instead.
    const own = (await M.get(`/apps/${app.id}`)).text;
    const form = own.slice(own.indexOf(`action="/apps/${app.id}/bearbeiten"`));
    assert.ok(!/name="name"|name="description"/.test(form.slice(0, form.indexOf('</form>'))), 'name and description are not editable in the form');
    assert.match(own, /Name und Beschreibung sind gerade gesperrt/);
    // Symbol and colour come from fixed lists: they still change (the form sends neither name nor description).
    assert.equal((await M.post(`/apps/${app.id}/bearbeiten`, { emoji: EMOJIS[3], color: '4' })).status, 303);
    assert.deepEqual(row(), { name: 'Wortspiel', description: 'Wörter raten', emoji: EMOJIS[3], color: 4 });

    // The admin (and staff owners, below) are not bound.
    assert.equal((await edit(A, { name: 'Wortspiel (geprüft)', description: 'Wörter raten' })).status, 303);
    assert.equal(row().name, 'Wortspiel (geprüft)');

    // The way out: take it out of the class, change it, submit again - the teacher sees the new name.
    assert.equal((await M.post(`/apps/${app.id}/aus-klasse`, { klasse: cls })).status, 303);
    assert.equal((await edit(M, { name: 'Wortspiel 2', description: 'Jetzt mit Bildern' })).status, 303);
    assert.equal(row().name, 'Wortspiel 2');
    assert.equal((await M.post(`/apps/${app.id}/einreichen`, { klasse: cls })).status, 303);
    assert.ok((await L.get(`/pruefen/${cls}/${app.id}`)).text.includes('Wortspiel 2'), 'the review shows the new name');
    // Given back: not in use anywhere, so the owner may fix the name before submitting again.
    assert.equal((await L.post(`/pruefen/${cls}/${app.id}/zurueckgeben`, { version: app.published_version_id, grund: 'Bitte noch Anleitung.' })).status, 303);
    assert.equal((await edit(M, { name: 'Wortspiel 3', description: 'Jetzt mit Anleitung' })).status, 303);

    // School-wide: the whole school sees the name, so it stays too (the admin can still change it).
    assert.equal((await A.post(`/apps/${app.id}/schulweit`, { an: '1' })).status, 303);
    assert.equal((await rename(M)).status, 400, 'released school-wide: refused');
    assert.match((await M.get(`/apps/${app.id}`)).text, /ganze Schule freigegeben/);
    assert.equal(row().name, 'Wortspiel 3');

    // A teacher's own app in their class: staff owners rename freely.
    const quiz = await h.makeApp(L, 'Quiz', { 'index.html': 'x' });
    assert.equal((await L.post(`/klassen/${cls}/apps`, { app: quiz.id })).status, 303);
    assert.equal((await L.post(`/apps/${quiz.id}/bearbeiten`, { name: 'Quiz 7', description: '', emoji: EMOJIS[0], color: '0' })).status, 303);
    assert.equal(h.db.get('SELECT name FROM apps WHERE id = ?', quiz.id).name, 'Quiz 7');
  } finally {
    await h.stop();
  }
});

test('Was Lehrkräfte sehen: Beitrittsseite und Datenschutz sagen dasselbe wie die Lehrer-Seiten', async () => {
  const h = await startHub();
  try {
    const ahorn = h.addUser('Frau Ahorn', 'teacher');
    const birke = h.addUser('Herr Birke', 'teacher');
    const sina = h.addUser('Sina Sorgsam', 'student');
    const [T1, T2, S] = await Promise.all([ahorn, birke, sina].map((u) => h.browser().login(u)));
    await T1.post('/klassen', { name: 'Klasse A' });
    await T2.post('/klassen', { name: 'Klasse B' });
    const A = teacherClass(h, ahorn.id, 'Klasse A');
    const B = teacherClass(h, birke.id, 'Klasse B');
    for (const c of [A, B]) await S.post(`/beitreten/${joinCode(h, c)}`);
    // Frau Ahorn's app, shared with colleagues, in both classes.
    const app = await h.makeApp(T1, 'Tagebuch', { 'index.html': 'x' });
    await T1.post(`/apps/${app.id}/bearbeiten`, { name: 'Tagebuch', emoji: EMOJIS[0], color: '0', shared_field: '1', shared: '1' });
    assert.equal((await T1.post(`/klassen/${A}/apps`, { app: app.id })).status, 303);
    assert.equal((await T2.post(`/klassen/${B}/apps`, { app: app.id })).status, 303);

    // Sina uses it in Herr Birke's class B only.
    const tok = await h.token(S, app, B);
    assert.equal(tok.mode, 'live');
    await S.api(app, tok.token, 'save.set', { key: 'eintrag', value: { text: 'TAGEBUCH-AUS-KLASSE-B' } });
    await S.api(app, tok.token, 'progress.set', { value: 0.7 });
    await S.api(app, tok.token, 'results.add', { title: 'ERGEBNIS-AUS-B', score: 1, maxScore: 1 });

    // What Frau Ahorn (class A) really sees: the save and progress from class B, not the result, never the e-mail.
    const seen = (await T1.get(`/klassen/${A}/apps/${app.id}/ergebnisse/${sina.id}`)).text;
    assert.ok(seen.includes('TAGEBUCH-AUS-KLASSE-B'), 'saves from another class are shown');
    assert.match(seen, /70\s*%/, 'progress from another class is shown');
    assert.match(seen, /1× geöffnet/, 'how often the app was opened is shown');
    assert.ok(!seen.includes('ERGEBNIS-AUS-B'), 'results only from this class');
    assert.ok(!seen.includes(sina.email), 'never the e-mail address');

    // ... and that is what a student is told before joining, and on the privacy page.
    const fresh = await h.browser().login(h.addUser('Neu Neumann', 'student'));
    const join = (await fresh.get(`/beitreten/${joinCode(h, A)}`)).text;
    const privacy = (await fresh.get('/datenschutz')).text;
    for (const [label, text] of [['join page', join], ['privacy page', privacy]]) {
      for (const item of TEACHERS_SEE) assert.ok(text.includes(item), `${label}: ${item}`);
      assert.match(text, /zu Hause oder in einer anderen Klasse/, label);
      assert.match(text, /Deine E-Mail-Adresse sehen sie nie/, label);
      assert.ok(!text.includes('sonst nichts'), `${label}: the old promise is gone`);
    }
    assert.ok(!privacy.includes('Die sehen nur du und die Lehrkräfte der Klasse, in der die App benutzt wird'), 'the old privacy sentence is gone');
    assert.ok(!privacy.includes('damit Lehrkräfte dich erkennen'), 'teachers do not see the e-mail address');
  } finally {
    await h.stop();
  }
});

test('Geplante Aufgaben: vor dem Start sehen Schüler/innen nichts davon – keine Mitteilung, kein Link, kein Titel', async () => {
  const h = await startHub();
  try {
    const admin = h.addUser('Anna Adler', 'admin');
    const lehmann = h.addUser('Herr Lehmann', 'teacher');
    const mia = h.addUser('Mia Schmidt', 'student');
    const paul = h.addUser('Paul Peer', 'student');
    const [A, L, M, P] = await Promise.all([admin, lehmann, mia, paul].map((u) => h.browser().login(u)));
    await L.post('/klassen', { name: '7b' });
    const cls = teacherClass(h, lehmann.id, '7b');
    for (const b of [M, P]) await b.post(`/beitreten/${joinCode(h, cls)}`);
    const quiz = await h.makeApp(L, 'Quiz', { 'index.html': 'x' });
    await L.post(`/klassen/${cls}/apps`, { app: quiz.id });

    const created = await L.post(`/klassen/${cls}/aufgaben`, { app: quiz.id, titel: 'Überraschungstest', notiz: 'Frage 1: LOESUNG-VORAB', start: inputDateTime(Date.now() + 7 * DAY) });
    assert.equal(created.status, 303);
    const x = created.headers.location.split('/').pop();
    const noticesTo = (u) => h.db.get("SELECT COUNT(*) AS n FROM notices WHERE user_id = ? AND href = ?", u.id, `/aufgaben/${x}`).n;
    assert.equal(noticesTo(mia) + noticesTo(paul), 0, 'no notice before the start');

    // Students: the assignment does not exist for them - not to open, not to tick, in no list or count.
    for (const [method, url] of [['GET', `/aufgaben/${x}`], ['POST', `/aufgaben/${x}/erledigt`], ['POST', `/aufgaben/${x}/offen`]]) {
      const res = method === 'GET' ? await M.get(url) : await M.post(url);
      assert.equal(res.status, 404, `${method} ${url}`);
      assert.ok(!res.text.includes('LOESUNG-VORAB') && !res.text.includes('Überraschungstest'), url);
    }
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM assignment_done WHERE assignment_id = ?', x).n, 0);
    for (const url of ['/start', `/klassen/${cls}`, '/mitteilungen', '/rueckmeldungen', '/suche?q=%C3%9Cberraschung']) {
      const text = (await M.get(url)).text;
      assert.ok(!text.includes('Überraschungstest') && !text.includes(x), `student's ${url}`);
    }
    assert.equal(h.hub.ctx.assignments.openFor(mia.id).length, 0, 'not counted as open');
    // A feedback tied to it would carry its title to the student: refused, nothing stored, nobody told.
    const fb = await L.post(`/klassen/${cls}/rueckmeldungen`, { schueler: mia.id, text: 'Viel Glück morgen!', aufgabe: x });
    assert.equal(fb.status, 400);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM feedback WHERE assignment_id = ?', x).n, 0);
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM notices WHERE user_id = ?', mia.id).n, 0);

    // Teachers (and the admin) see and manage it as before.
    for (const b of [L, A]) {
      const page = await b.get(`/aufgaben/${x}`);
      assert.equal(page.status, 200);
      assert.ok(page.text.includes('LOESUNG-VORAB'));
    }
    assert.ok((await L.get(`/klassen/${cls}/aufgaben`)).text.includes('Überraschungstest'));

    // Moved to "now": it starts, so the students are told and can open it.
    assert.equal((await L.post(`/aufgaben/${x}/bearbeiten`, { titel: 'Überraschungstest', notiz: 'Frage 1', start: inputDateTime(Date.now()), faellig: '' })).status, 303);
    assert.equal(noticesTo(mia) + noticesTo(paul), 2, 'told at the start');
    assert.equal((await M.get(`/aufgaben/${x}`)).status, 200);
    // Moved into the future again: hidden again, and the notice about it is gone.
    assert.equal((await L.post(`/aufgaben/${x}/bearbeiten`, { titel: 'Überraschungstest', notiz: 'Frage 1', start: inputDateTime(Date.now() + DAY), faellig: '' })).status, 303);
    assert.equal(noticesTo(mia) + noticesTo(paul), 0, 'the notice went with it');
    assert.equal((await M.get(`/aufgaben/${x}`)).status, 404);
    // Once its start has passed it is there: on the start page, openable.
    h.db.run('UPDATE assignments SET starts_at = ? WHERE id = ?', Date.now() - 1000, x);
    assert.equal((await M.get(`/aufgaben/${x}`)).status, 200);
    assert.ok((await M.get('/start')).text.includes('Überraschungstest'));

    // An assignment that starts at once is announced right away (unchanged).
    const now = await L.post(`/klassen/${cls}/aufgaben`, { app: quiz.id, titel: 'Sofort', notiz: '' });
    const y = now.headers.location.split('/').pop();
    assert.equal(h.db.get('SELECT COUNT(*) AS n FROM notices WHERE href = ?', `/aufgaben/${y}`).n, 2);
    assert.equal((await P.get(`/aufgaben/${y}`)).status, 200);
  } finally {
    await h.stop();
  }
});

test('Konto löschen: jede Spalte, die eine Personen-ID halten kann, ist bedacht', async () => {
  const h = await startHub();
  try {
    const { ID_COLUMNS_SET_NULL, ID_COLUMNS_HANDLED } = require('../src/services');
    const known = new Set([...ID_COLUMNS_SET_NULL.map(([t, c]) => `${t}.${c}`), ...ID_COLUMNS_HANDLED]);
    // A column holds a person when its name says so: …_by, user_id, author_id, owner_id, …
    const personish = /(^|_)(by|user_id|author_id|owner_id|actor_id|subject_id|student_id|teacher_id|creator_id|member_id)$/;
    const unhandled = [];
    for (const { name } of h.db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")) {
      const fks = h.db.all(`PRAGMA foreign_key_list(${name})`).filter((f) => f.table === 'users');
      // A foreign key to users must take the person away with it.
      for (const f of fks) if (!['CASCADE', 'SET NULL'].includes(f.on_delete)) unhandled.push(`${name}.${f.from} (ON DELETE ${f.on_delete})`);
      for (const c of h.db.all(`PRAGMA table_info(${name})`)) {
        if (fks.some((f) => f.from === c.name)) continue;
        if (personish.test(c.name) && !known.has(`${name}.${c.name}`)) unhandled.push(`${name}.${c.name}`);
      }
    }
    assert.deepEqual(unhandled, [], 'every column that can hold a person is cleared by deleteUser');
    for (const key of known) {
      const [table, col] = key.split('.');
      assert.ok(h.db.all(`PRAGMA table_info(${table})`).some((c) => c.name === col), `${key} exists`);
    }
  } finally {
    await h.stop();
  }
});
