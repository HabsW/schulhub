'use strict';
// The matrix: every kind of person the Hub meets (a state) × everything one can do in it (an
// action), through the real HTTP routes. "It must simply work, without problems, for students in
// one class, in many classes and in no class."
//
//   STATES   build one person in one situation, fresh: a student in no class, in one, in several,
//            blocked, deleted, with a role changed during the session, a teacher without a class,
//            the class's teacher, a co-teacher, a member of an archived class, the admin.
//   ACTIONS  do one thing through HTTP and say what happened in one word ('ok', '404', 'login',
//            'klasse' …). Each action also checks the visible effect in the database, and that the
//            response shows nothing of other classes and other people (`hidden`).
//   TABLE    what each cell must give, derived from src/access.js, SECURITY.md and README.md.
//
// Every state gets its own class ("world"): Tom's class with the shared app G and the school-wide
// app S, Mara as classmate (a result, a saved state and private feedback from the teacher), Mara's
// app waiting for review, and an assignment. Elsewhere in the Hub: Tom's "Geheimklasse 9z" (Mara has
// a result there that no other class may show) and Frieda's "Zeta-Fremdklasse" with Zora.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startHub } = require('./helpers');

const MARA = 'Mara Mitschülerin';
// Never visible to anyone but the admin: another class of the same teacher, a foreign class, their people and data.
const BASE_HIDDEN = ['Zeta-Fremdklasse', 'Zora Zeta', 'ZORA-ERGEBNIS', 'ZORA-STAND', 'Geheimklasse 9z', 'MARA-GEHEIM'];
// What only the class's teachers see of a classmate: her results, her saved state, private feedback to her.
const CLASSMATE_DATA = ['MARA-ERGEBNIS', 'MARA-SPIELSTAND', 'FEEDBACK-FUER-MARA'];
const ADMIN_PAGES = ['/admin', '/admin/konten', '/admin/klassen', '/admin/apps', '/admin/protokoll', '/admin/aufbewahrung', '/admin/sicherung'];

let h;
let adminUser, tom, mara, frieda, zora;
let AD, T, M, F, Z;
let G, S, MA; // the class app (Tom's, shared with colleagues), the school-wide app (Tom's), Mara's app
let decoy; // Tom's "Geheimklasse 9z"

let seq = 0;
const uniq = (prefix) => `${prefix}-${++seq}`;
const idFrom = (res) => res.headers.location.split('?')[0].split('/').pop();
const joinCode = (classId, role = 'student') => h.db.get('SELECT code FROM join_codes WHERE class_id = ? AND role = ? ORDER BY created_at DESC', classId, role)?.code;
const classRole = (userId, classId) => h.db.get('SELECT role FROM class_members WHERE class_id = ? AND user_id = ?', classId, userId)?.role ?? null;
const classApp = (classId, appId) => h.db.get('SELECT status, version_id, requested_version_id, request_state FROM class_apps WHERE class_id = ? AND app_id = ?', classId, appId) || null;
/** 'login' = sent to the sign-in page; otherwise the HTTP status. */
const code = (res) => (res.status === 302 && res.headers.location === '/' ? 'login' : String(res.status));
const okOr = (res) => (res.status === 200 ? 'ok' : code(res));

async function person(role) {
  const user = h.addUser(uniq({ student: 'Schüler', teacher: 'Lehrkraft', admin: 'Verwaltung' }[role]), role);
  return { user, b: await h.browser().login(user) };
}

/** A fresh class of `Tb` with G and S, Mara in it with a result, her app waiting, feedback to her, an assignment. */
async function classWorld(Tb) {
  const name = `Klasse W${String(++seq).padStart(4, '0')}`;
  const created = await Tb.post('/klassen', { name });
  assert.equal(created.status, 303);
  const id = idFrom(created);
  for (const app of [G, S]) assert.equal((await Tb.post(`/klassen/${id}/apps`, { app: app.id })).status, 303);
  assert.equal((await M.post(`/beitreten/${joinCode(id)}`)).status, 303);
  const mt = await h.token(M, G, id);
  assert.equal((await M.api(G, mt.token, 'results.add', { title: 'MARA-ERGEBNIS', score: 3, maxScore: 4 })).json().ok, true);
  assert.equal((await M.post(`/apps/${MA.id}/einreichen`, { klasse: id })).status, 303);
  assert.equal((await Tb.post(`/klassen/${id}/rueckmeldungen`, { schueler: mara.id, text: 'FEEDBACK-FUER-MARA' })).status, 303);
  const x = await Tb.post(`/klassen/${id}/aufgaben`, { app: G.id, titel: `Aufgabe ${name}` });
  assert.equal(x.status, 303);
  return { id, name, X: idFrom(x) };
}
/** A plain new class of Tom's (for joining). */
async function plainClass(Tb = T) {
  const name = `Klasse J${String(++seq).padStart(4, '0')}`;
  const created = await Tb.post('/klassen', { name });
  return { id: idFrom(created), name };
}
/** Join like a browser: confirm, then follow to the class page (which shows the welcome message once). */
async function join(b, cls, role = 'student') {
  const res = await b.post(`/beitreten/${joinCode(cls.id, role)}`);
  assert.equal(res.status, 303);
  await b.get(res.headers.location);
}
async function invite(Tb, b, cls) {
  assert.equal((await Tb.post(`/klassen/${cls.id}/einladung`, { minuten: '60' })).status, 303);
  await join(b, cls, 'teacher');
}
async function feedbackTo(Tb, cls, user) {
  const text = uniq('FUER-DICH');
  assert.equal((await Tb.post(`/klassen/${cls.id}/rueckmeldungen`, { schueler: user.id, text })).status, 303);
  return text;
}
async function admin(path, fields) {
  assert.equal((await AD.post(path, fields)).status, 303, path);
}
/** SDK tokens taken before the person was blocked or deleted (an app still open in a tab). */
async function openTokens(b, W) {
  return { G: (await h.token(b, G, W.id)).token, S: (await h.token(b, S)).token };
}

/**
 * The context of one state: who acts (b, user), "their" class W, another class W2 (for the
 * school-wide app opened with a class it is not in), and what they must never see.
 *   hidden       never in any response
 *   hiddenPages  not on pages and lists, but allowed in their own data (feedback, export)
 *   tokens       SDK tokens from before the person was blocked/deleted; else tokens are asked for live
 */
function context(o) {
  return { W2: decoy, tokens: null, ownFeedback: null, admin: false, frozen: false, hiddenPages: [], ...o, hidden: o.admin ? [] : [...BASE_HIDDEN, ...(o.hide || [])] };
}

// ------------------------------------------------------------------ states

const studentInWorld = async () => {
  const { user, b } = await person('student');
  const W = await classWorld(T);
  await join(b, W);
  return { user, b, W, ownFeedback: await feedbackTo(T, W, user) };
};

const STATES = {
  ohne: {
    title: 'Schüler/in ohne Klasse',
    async setup() {
      const { user, b } = await person('student');
      const W = await classWorld(T);
      return context({ user, b, W, hide: [W.name, MARA, ...CLASSMATE_DATA] });
    },
  },
  eine: {
    title: 'Schüler/in in einer Klasse',
    setup: async () => context({ ...(await studentInWorld()), hide: CLASSMATE_DATA }),
  },
  mehrere: {
    title: 'Schüler/in in drei Klassen (die App ist nur in einer freigegeben)',
    async setup() {
      const s = await studentInWorld();
      const W2 = await plainClass();
      const W3 = await plainClass();
      await join(s.b, W2);
      await join(s.b, W3);
      return context({ ...s, W2, hide: CLASSMATE_DATA });
    },
  },
  gespA: {
    title: 'gesperrt, noch angemeldet',
    frozen: true,
    async setup() {
      const s = await studentInWorld();
      const tokens = await openTokens(s.b, s.W);
      await admin(`/admin/nutzer/${s.user.id}/sperren`, { an: '1' });
      return context({ ...s, tokens, frozen: true, hide: CLASSMATE_DATA });
    },
  },
  gespN: {
    title: 'gesperrt, meldet sich neu an',
    frozen: true,
    async setup() {
      const s = await studentInWorld();
      const tokens = await openTokens(s.b, s.W);
      await admin(`/admin/nutzer/${s.user.id}/sperren`, { an: '1' });
      const again = h.browser();
      await again.page('/');
      assert.equal((await again.post('/dev/login', { user: s.user.id })).status, 403, 'a blocked account cannot sign in');
      return context({ ...s, b: again, tokens, frozen: true, hide: CLASSMATE_DATA });
    },
  },
  gelo: {
    title: 'gelöschtes Konto mit altem Cookie und altem SDK-Token',
    frozen: true,
    async setup() {
      const s = await studentInWorld();
      const tokens = await openTokens(s.b, s.W);
      await admin(`/admin/nutzer/${s.user.id}/loeschen`, {});
      return context({ ...s, tokens, frozen: true, hide: CLASSMATE_DATA });
    },
  },
  s2l: {
    title: 'Schüler/in wird während der Sitzung Lehrkraft',
    async setup() {
      const s = await studentInWorld();
      await admin(`/admin/nutzer/${s.user.id}/rolle`, { rolle: 'teacher' });
      return context({ ...s, hide: CLASSMATE_DATA });
    },
  },
  l2s: {
    title: 'Lehrkraft (Mitlehrkraft der Klasse) wird während der Sitzung Schüler/in',
    async setup() {
      const { user, b } = await person('teacher');
      const W = await classWorld(T);
      await invite(T, b, W);
      await admin(`/admin/nutzer/${user.id}/rolle`, { rolle: 'student' });
      return context({ user, b, W });
    },
  },
  a2l: {
    title: 'Admin wird während der Sitzung Lehrkraft',
    async setup() {
      const { user, b } = await person('admin');
      const W = await classWorld(T);
      await admin(`/admin/nutzer/${user.id}/rolle`, { rolle: 'teacher' });
      return context({ user, b, W, hide: [W.name, MARA, ...CLASSMATE_DATA] });
    },
  },
  lok: {
    title: 'Lehrkraft ohne Klasse',
    async setup() {
      const { user, b } = await person('teacher');
      const W = await classWorld(T);
      return context({ user, b, W, hide: [W.name, MARA, ...CLASSMATE_DATA] });
    },
  },
  kll: {
    title: 'Lehrkraft der Klasse (einzige)',
    async setup() {
      const { user, b } = await person('teacher');
      return context({ user, b, W: await classWorld(b) });
    },
  },
  col: {
    title: 'Mitlehrkraft (per Einladung beigetreten)',
    async setup() {
      const { user, b } = await person('teacher');
      const W = await classWorld(T);
      await invite(T, b, W);
      return context({ user, b, W });
    },
  },
  ars: {
    title: 'Schüler/in einer archivierten Klasse',
    async setup() {
      const s = await studentInWorld();
      assert.equal((await T.post(`/klassen/${s.W.id}/archivieren`)).status, 303);
      // Archived classes are invisible to students: in their own data (feedback, export) the name may stay.
      return context({ ...s, hide: [MARA, ...CLASSMATE_DATA], hiddenPages: [s.W.name] });
    },
  },
  arl: {
    title: 'Lehrkraft einer archivierten Klasse',
    async setup() {
      const { user, b } = await person('teacher');
      const W = await classWorld(b);
      assert.equal((await b.post(`/klassen/${W.id}/archivieren`)).status, 303);
      return context({ user, b, W });
    },
  },
  adm: {
    title: 'Admin',
    async setup() {
      const { user, b } = await person('admin');
      return context({ user, b, W: await classWorld(T), admin: true });
    },
  },
};

// ------------------------------------------------------------------ actions

/** Nothing hidden, no other person's e-mail address. */
function see(c, res, { ownData = false } = {}) {
  for (const s of c.hidden) if (res.text.includes(s)) throw new Error(`zeigt „${s}“`);
  if (!ownData) for (const s of c.hiddenPages) if (res.text.includes(s)) throw new Error(`zeigt „${s}“`);
  if (!c.admin) for (const m of res.text.match(/[A-Za-z0-9_-]+@schule\.example/g) || []) if (m !== c.user.email) throw new Error(`zeigt die E-Mail-Adresse ${m}`);
  return res;
}
async function look(c, url, opts) {
  const res = await c.b.get(url);
  if (res.status === 200) see(c, res, opts);
  return res;
}
/** An SDK token for app/klasse: the old one for blocked/deleted people, else asked for like the player does. */
async function sdkToken(c, app, klasse) {
  if (c.tokens) return { token: c.tokens[app === G ? 'G' : 'S'] };
  const res = await c.b.send('POST', `/apps/${app.id}/token`, { klasse, first: true });
  if (res.status !== 200) return { refused: code(res) };
  see(c, res);
  return { token: res.json().token, info: res.json() };
}
/** One SDK call: 'ok', the error code, or the HTTP status (401 …). */
async function call(c, app, token, method, params) {
  const res = await c.b.api(app, token, method, params);
  if (res.status !== 200) {
    if (res.status === 500) throw new Error(`500 bei ${method}`);
    return { out: String(res.status) };
  }
  see(c, res);
  const j = res.json();
  return { out: j.ok ? 'ok' : j.error.code, result: j.result };
}
/** Where a stored result landed: 'klasse' (class W), 'ohne' (no class). */
function resultClass(c, title) {
  const row = h.db.get('SELECT class_id FROM results WHERE title = ?', title);
  if (!row) return null;
  return row.class_id === c.W.id ? 'klasse' : row.class_id === null ? 'ohne' : `Klasse ${row.class_id}`;
}
function playerClass(c, res) {
  const bar = res.text.split('class="playerbar')[1].split('</div>')[0];
  const m = /<small>([^<]*)<\/small>/.exec(bar);
  return !m ? 'ohne' : m[1] === c.W.name ? 'klasse' : `Klasse ${m[1]}`;
}
/** An app of the acting person, published - or how creating it was refused. */
async function ownApp(c) {
  const created = await c.b.post('/apps', { name: uniq('Eigene App'), emoji: '🎮', color: '0' });
  if (created.status !== 303) return { refused: code(created) };
  const id = idFrom(created);
  const version = await h.uploadFolder(c.b, id, { 'index.html': '<h1>eigen</h1>' });
  assert.equal((await c.b.post(`/apps/${id}/veroeffentlichen`, { version })).status, 303);
  return { id, version };
}

const ACTIONS = {
  // ---------- pages
  start: async (c) => okOr(await look(c, '/start')),
  klassenliste: async (c) => {
    const res = await look(c, '/klassen');
    return res.status === 200 ? (res.text.includes(c.W.name) ? 'mit' : 'ohne') : code(res);
  },
  klassenseite: async (c) => {
    const res = await look(c, `/klassen/${c.W.id}`);
    if (res.status !== 200) return code(res);
    return res.text.includes(`href="/klassen/${c.W.id}/mitglieder"`) ? 'lehrer' : 'schueler';
  },
  reiter: async (c) => {
    const outs = [];
    for (const tab of ['aufgaben', 'apps', 'mitglieder', 'einstellungen']) outs.push(okOr(await look(c, `/klassen/${c.W.id}/${tab}`)));
    if (new Set(outs).size !== 1) throw new Error(`uneinheitlich: ${outs.join(' ')}`);
    return outs[0];
  },
  ergebnisse: async (c) => {
    const res = await look(c, `/klassen/${c.W.id}/apps/${G.id}/ergebnisse`);
    if (res.status !== 200) return code(res);
    if (!res.text.includes(MARA) || !res.text.includes('MARA-ERGEBNIS')) throw new Error('Maras Ergebnis fehlt');
    return 'ok';
  },
  einzelergebnis: async (c) => {
    const res = await look(c, `/klassen/${c.W.id}/apps/${G.id}/ergebnisse/${mara.id}`);
    if (res.status !== 200) return code(res);
    for (const s of CLASSMATE_DATA) if (!res.text.includes(s)) throw new Error(`${s} fehlt`);
    return 'ok';
  },
  csv: async (c) => {
    const res = await look(c, `/klassen/${c.W.id}/apps/${G.id}/ergebnisse.csv`);
    if (res.status !== 200) return code(res);
    if (!/^text\/csv/.test(res.headers['content-type']) || !res.text.includes('MARA-ERGEBNIS')) throw new Error('keine CSV mit Maras Ergebnis');
    return 'ok';
  },
  // Another class: the student's own second class (several classes), else Tom's other class.
  zweiteKlasse: async (c) => {
    const res = await look(c, `/klassen/${c.W2.id}`);
    if (res.status !== 200) return code(res);
    // Nothing of class W on the page of class W2: not its assignment, not the apps approved only there.
    // (The class switcher lists the person's own classes by name - that is fine.)
    if (c.W2 !== decoy) for (const s of [`Aufgabe ${c.W.name}`, 'Matrix-Quiz', 'Schulweit-Spiel']) if (res.text.includes(s)) throw new Error(`zeigt „${s}“`);
    return res.text.includes(`href="/klassen/${c.W2.id}/mitglieder"`) ? 'lehrer' : 'schueler';
  },
  aufgabeAnsehen: async (c) => okOr(await look(c, `/aufgaben/${c.W.X}`)),
  pruefliste: async (c) => {
    const res = await look(c, '/pruefen');
    return res.status === 200 ? (res.text.includes('Maras App') ? 'mit' : 'ohne') : code(res);
  },
  sucheKlasse: async (c) => {
    const q = c.W.name;
    const res = await c.b.get(`/suche?q=${encodeURIComponent(q)}`);
    if (res.status !== 200) return code(res);
    // The page repeats what was typed; everything else must keep the hidden things hidden.
    see(c, { text: res.text.split(`„${q}“`).join('').split(`value="${q}"`).join('').split(`Suche: ${q}`).join('') });
    return res.text.includes(`href="/klassen/${c.W.id}"`) ? 'mit' : 'ohne';
  },
  suchePerson: async (c) => {
    const res = await look(c, `/suche?q=${encodeURIComponent('Mara Mit')}`);
    return res.status === 200 ? (res.text.includes(MARA) ? 'person' : 'ohne') : code(res);
  },

  // ---------- apps and the SDK (app G opened from class W, like the class page links it)
  spielenMitKlasse: async (c) => {
    const res = await look(c, `/apps/${G.id}/spielen?klasse=${c.W.id}`);
    return res.status === 200 ? playerClass(c, res) : code(res);
  },
  spielenOhneKlasse: async (c) => {
    const res = await look(c, `/apps/${G.id}/spielen`);
    return res.status === 200 ? playerClass(c, res) : code(res);
  },
  token: async (c) => {
    const res = await c.b.send('POST', `/apps/${G.id}/token`, { klasse: c.W.id, first: true });
    if (res.status !== 200) return code(res);
    see(c, res);
    const j = res.json();
    if (j.user.id === c.user.id || 'email' in j.user) throw new Error('das Token verrät die echte Identität');
    return j.class ? (j.class.name === c.W.name ? 'klasse' : `Klasse ${j.class.name}`) : 'ohne';
  },
  speichern: async (c) => {
    const t = await sdkToken(c, G, c.W.id);
    if (t.refused) return t.refused;
    const value = uniq('WERT');
    const set = await call(c, G, t.token, 'save.set', { key: 'mein', value });
    const stored = h.db.get('SELECT user_id FROM saves WHERE app_id = ? AND value = ?', G.id, JSON.stringify(value));
    if (set.out !== 'ok') {
      if (stored) throw new Error('abgelehnt, aber gespeichert');
      return set.out;
    }
    if (!stored || stored.user_id !== c.user.id) throw new Error('nicht im eigenen Konto gespeichert');
    if ((await call(c, G, t.token, 'save.get', { key: 'mein' })).result !== value) throw new Error('save.get liefert etwas anderes');
    return 'ok';
  },
  bestenliste: async (c) => {
    const t = await sdkToken(c, G, c.W.id);
    if (t.refused) return t.refused;
    const sub = await call(c, G, t.token, 'scores.submit', { board: 'punkte', score: 3 });
    if (sub.out !== 'ok') return sub.out;
    const inClass = (await call(c, G, t.token, 'scores.top', { board: 'punkte', scope: 'class' })).result;
    const all = (await call(c, G, t.token, 'scores.top', { board: 'punkte', scope: 'all' })).result;
    const zoraRow = all.entries.find((e) => e.score === 9);
    if (!zoraRow || zoraRow.name !== 'Anonym') throw new Error('Zora (fremde Klasse) ist nicht anonym');
    if (inClass.scope === 'class' && inClass.entries.some((e) => e.score === 9)) throw new Error('Zora steht in der Liste der Klasse');
    const maraRow = all.entries.find((e) => e.score === 7);
    if (!maraRow) throw new Error('Maras Bestwert fehlt');
    return maraRow.name === MARA ? 'namen' : maraRow.name === 'Anonym' ? 'anonym' : `Name ${maraRow.name}`;
  },
  ergebnisSdk: async (c) => {
    const t = await sdkToken(c, G, c.W.id);
    if (t.refused) return t.refused;
    const title = uniq('ERG');
    const add = await call(c, G, t.token, 'results.add', { title, score: 1, maxScore: 2 });
    const where = resultClass(c, title);
    if (add.out !== 'ok') {
      if (where) throw new Error('abgelehnt, aber gespeichert');
      return add.out;
    }
    return where;
  },
  klassendaten: async (c) => {
    const t = await sdkToken(c, G, c.W.id);
    if (t.refused) return t.refused;
    const get = await call(c, G, t.token, 'class.get', { key: 'liste' });
    if (get.out !== 'ok') return get.out;
    const value = uniq('KLASSENDATEN');
    const set = await call(c, G, t.token, 'class.set', { key: 'liste', value });
    const row = h.db.get('SELECT class_id FROM shared_data WHERE app_id = ? AND value = ?', G.id, JSON.stringify(value));
    if (set.out !== 'ok') {
      if (row) throw new Error('abgelehnt, aber gespeichert');
      return set.out;
    }
    if (!row || row.class_id !== c.W.id) throw new Error('nicht bei der Klasse gespeichert');
    return 'ok';
  },
  gemeinsam: async (c) => {
    const t = await sdkToken(c, G, c.W.id);
    if (t.refused) return t.refused;
    const value = uniq('FUER-ALLE');
    const set = await call(c, G, t.token, 'shared.set', { key: 'news', value });
    const row = h.db.get('SELECT class_id FROM shared_data WHERE app_id = ? AND value = ?', G.id, JSON.stringify(value));
    if (set.out !== 'ok') {
      if (row) throw new Error('abgelehnt, aber gespeichert');
      return set.out;
    }
    if (!row || row.class_id !== '') throw new Error('nicht app-weit gespeichert');
    return 'ok';
  },
  schulweitOhneKlasse: async (c) => {
    const t = await sdkToken(c, S, null);
    if (t.refused) return t.refused;
    const title = uniq('SCHULWEIT');
    const add = await call(c, S, t.token, 'results.add', { title });
    const where = resultClass(c, title);
    if (add.out !== 'ok') {
      if (where) throw new Error('abgelehnt, aber gespeichert');
      return add.out;
    }
    return where;
  },
  // The school-wide app with a class it is not in (a stale link): it opens school-wide, without a class.
  schulweitFremdeKlasse: async (c) => {
    const res = await c.b.send('POST', `/apps/${S.id}/token`, { klasse: c.W2.id, first: true });
    if (res.status !== 200) return code(res);
    see(c, res);
    const j = res.json();
    const said = j.class ? (j.class.name === c.W.name ? 'klasse' : `Klasse ${j.class.name}`) : 'ohne';
    const title = uniq('FREMDE-KLASSE');
    assert.equal((await c.b.api(S, j.token, 'results.add', { title })).json().ok, true);
    const where = resultClass(c, title);
    if (where !== said) throw new Error(`das Token sagt ${said}, das Ergebnis landet ${where}`);
    const page = await look(c, `/apps/${S.id}/spielen?klasse=${c.W2.id}`);
    if (page.status !== 200 || playerClass(c, page) !== said) throw new Error('Player und Token sagen Verschiedenes');
    return said;
  },

  // ---------- review and teaching
  einreichen: async (c) => {
    const own = await ownApp(c);
    if (own.refused) return own.refused;
    const res = await c.b.post(`/apps/${own.id}/einreichen`, { klasse: c.W.id });
    const row = classApp(c.W.id, own.id);
    if (res.status !== 303) {
      if (row) throw new Error('abgelehnt, aber in der Klasse');
      return code(res);
    }
    if (row.status === 'approved' && !row.request_state && row.version_id === own.version) return 'freigegeben';
    if (row.request_state === 'waiting' && row.requested_version_id === own.version) return 'wartet';
    throw new Error(`Zustand ${JSON.stringify(row)}`);
  },
  pruefen: async (c) => {
    const version = MA.published_version_id;
    const bench = `/pruefen/${c.W.id}/${MA.id}`;
    const was = JSON.stringify(classApp(c.W.id, MA.id));
    const res = await look(c, bench);
    if (res.status !== 200) {
      const tried = await c.b.post(`${bench}/freigeben`, { version });
      if (tried.status === 303 || JSON.stringify(classApp(c.W.id, MA.id)) !== was) throw new Error('ohne Prüfplatz entschieden');
      return code(res);
    }
    const back = await c.b.post(`${bench}/zurueckgeben`, { version, grund: 'Bitte noch eine Anleitung.' });
    if (back.status !== 303 || classApp(c.W.id, MA.id).request_state !== 'returned') return `zurückgeben ${code(back)}`;
    assert.equal((await M.post(`/apps/${MA.id}/einreichen`, { klasse: c.W.id })).status, 303);
    const ok = await c.b.post(`${bench}/freigeben`, { version });
    const row = classApp(c.W.id, MA.id);
    if (ok.status !== 303 || row.status !== 'approved' || row.version_id !== version) return `freigeben ${code(ok)}`;
    return 'ok';
  },
  aufgabeStellen: async (c) => {
    const titel = uniq('AUFGABE');
    const res = await c.b.post(`/klassen/${c.W.id}/aufgaben`, { app: G.id, titel });
    const row = h.db.get('SELECT class_id FROM assignments WHERE title = ?', titel);
    if (res.status !== 303) {
      if (row) throw new Error('abgelehnt, aber angelegt');
      return code(res);
    }
    if (!row || row.class_id !== c.W.id) throw new Error('nicht in der Klasse angelegt');
    return 'ok';
  },
  erledigt: async (c) => {
    const res = await c.b.post(`/aufgaben/${c.W.X}/erledigt`);
    const who = h.db.all('SELECT user_id FROM assignment_done WHERE assignment_id = ?', c.W.X).map((r) => r.user_id);
    if (res.status !== 303) {
      if (who.length) throw new Error('abgelehnt, aber abgehakt');
      return code(res);
    }
    if (who.join() !== c.user.id) throw new Error(`abgehakt für ${who.join()}`);
    return 'ok';
  },
  rueckmeldungGeben: async (c) => {
    const text = uniq('RUECKMELDUNG');
    const res = await c.b.post(`/klassen/${c.W.id}/rueckmeldungen`, { schueler: mara.id, text });
    const row = h.db.get('SELECT * FROM feedback WHERE body = ?', text);
    if (res.status !== 303) {
      if (row) throw new Error('abgelehnt, aber gespeichert');
      return code(res);
    }
    if (!row || row.student_id !== mara.id || row.class_id !== c.W.id || row.author_id !== c.user.id) throw new Error('falsch gespeichert');
    return 'ok';
  },
  rueckmeldungLesen: async (c) => {
    const res = await look(c, '/rueckmeldungen', { ownData: true });
    if (res.status !== 200) return code(res);
    if (c.ownFeedback && !res.text.includes(c.ownFeedback)) throw new Error('die eigene Rückmeldung fehlt');
    return 'ok';
  },

  // ---------- own data and administration
  meineDaten: async (c) => {
    const res = await look(c, '/meine-daten', { ownData: true });
    if (res.status !== 200) return code(res);
    const exp = await look(c, '/meine-daten/export', { ownData: true });
    if (exp.status !== 200) return `Export ${code(exp)}`;
    if (exp.json().konto.email !== c.user.email) throw new Error('fremdes Konto im Export');
    if (c.ownFeedback && !exp.text.includes(c.ownFeedback)) throw new Error('die eigene Rückmeldung fehlt im Export');
    return 'ok';
  },
  verwaltung: async (c) => {
    const outs = [];
    for (const url of ADMIN_PAGES) outs.push(okOr(await look(c, url)));
    if (new Set(outs).size !== 1) throw new Error(`uneinheitlich: ${outs.join(' ')}`);
    return outs[0];
  },

  // ---------- these change the person's own situation: each runs on a fresh copy of the state
  beitrittLink: async (c) => {
    const J = await plainClass();
    const res = await c.b.get(`/beitreten/${joinCode(J.id)}`);
    if (res.status !== 200) return code(res);
    see(c, res);
    if (!res.text.includes(J.name)) throw new Error('die Bestätigung nennt die Klasse nicht');
    if (classRole(c.user.id, J.id)) throw new Error('schon das Ansehen tritt bei');
    const done = await c.b.post(`/beitreten/${joinCode(J.id)}`);
    if (done.status !== 303) return code(done);
    return { student: 'schueler', teacher: 'lehrer' }[classRole(c.user.id, J.id)] || 'nicht beigetreten';
  },
  einladung: async (c) => {
    const J = await plainClass();
    assert.equal((await T.post(`/klassen/${J.id}/einladung`, { minuten: '60' })).status, 303);
    const inviteCode = joinCode(J.id, 'teacher');
    const res = await c.b.get(`/beitreten/${inviteCode}`);
    if (res.status !== 200) return code(res);
    see(c, res);
    const done = await c.b.post(`/beitreten/${inviteCode}`);
    const role = classRole(c.user.id, J.id);
    if (done.status === 303) return role === 'teacher' ? 'lehrer' : `Rolle ${role}`;
    if (role) throw new Error(`abgelehnt, aber Mitglied als ${role}`);
    if (res.text.includes(J.name) || res.text.includes(tom.name)) throw new Error('die Absage nennt Klasse oder Lehrkraft');
    return code(done);
  },
  verlassen: async (c) => {
    const was = classRole(c.user.id, c.W.id);
    const res = await c.b.post(`/klassen/${c.W.id}/verlassen`);
    const now = classRole(c.user.id, c.W.id);
    if (res.status === 303) {
      if (now) throw new Error('trotzdem noch Mitglied');
      return 'ok';
    }
    if (now !== was) throw new Error('abgelehnt, aber die Mitgliedschaft ist anders');
    return code(res);
  },
  neueKlasse: async (c) => {
    const name = uniq('Neue Klasse');
    const res = await c.b.post('/klassen', { name });
    const row = h.db.get('SELECT id FROM classes WHERE name = ?', name);
    if (res.status !== 303) {
      if (row) throw new Error('abgelehnt, aber angelegt');
      return code(res);
    }
    if (!row || classRole(c.user.id, row.id) !== 'teacher') throw new Error('nicht als Lehrkraft der neuen Klasse');
    return 'ok';
  },
  appDatenLoeschen: async (c) => {
    if (!c.frozen) {
      const t = await sdkToken(c, G, c.W.id);
      if (t.token) await c.b.api(G, t.token, 'save.set', { key: 'weg', value: 'WEG' });
    }
    const res = await c.b.post(`/meine-daten/app/${G.id}/loeschen`);
    const mine = h.db.get('SELECT COUNT(*) AS n FROM saves WHERE app_id = ? AND user_id = ?', G.id, c.user.id).n;
    if (!h.db.get('SELECT 1 AS ok FROM saves WHERE app_id = ? AND user_id = ?', G.id, mara.id)) throw new Error('Maras Spielstand ist weg');
    if (res.status !== 303) return code(res);
    if (mine) throw new Error('eigene Daten sind noch da');
    return 'ok';
  },
  kontoLoeschen: async (c) => {
    const existed = Boolean(h.db.get('SELECT 1 AS ok FROM users WHERE id = ?', c.user.id));
    const res = await c.b.post('/meine-daten/konto-loeschen', { bestaetigung: 'LÖSCHEN' });
    const exists = Boolean(h.db.get('SELECT 1 AS ok FROM users WHERE id = ?', c.user.id));
    if (res.status !== 303) {
      if (exists !== existed) throw new Error('abgelehnt, aber gelöscht');
      return code(res);
    }
    if (exists || res.headers.location !== '/?geloescht=1') throw new Error('nicht gelöscht');
    if (!h.db.get('SELECT 1 AS ok FROM users WHERE id = ?', mara.id)) throw new Error('Mara ist auch weg');
    return 'ok';
  },
};
const FRESH = new Set(['beitrittLink', 'einladung', 'verlassen', 'neueKlasse', 'appDatenLoeschen', 'kontoLoeschen']);

// ------------------------------------------------------------------ the expectations
//
// ohne  no class · eine  one class · mehrere  three classes · gespA blocked, still signed in ·
// gespN blocked, signing in again · gelo deleted (old cookie and token) · s2l student → teacher ·
// l2s co-teacher → student · a2l admin → teacher · lok teacher without class · kll the class's
// (only) teacher · col co-teacher · ars student of an archived class · arl teacher of an archived
// class · adm admin.
//
// login = sent to sign-in · 403 = old cookie, the session is gone (CSRF) · 401 = no session ·
// klasse/ohne = with/without class context (player, token, where a result is filed) ·
// mit/ohne = the class is (not) in the class list · lehrer/schueler = teacher or student view ·
// namen/anonym = Mara's name on the leaderboard · wartet/freigegeben = what submitting does.

const TABLE = `
                       ohne     eine     mehrere  gespA    gespN    gelo     s2l      l2s          a2l      lok      kll          col          ars      arl          adm
start                  ok       ok       ok       login    login    login    ok       ok           ok       ok       ok           ok           ok       ok           ok
klassenliste           ohne     mit      mit      login    login    login    mit      mit          ohne     ohne     mit          mit          ohne     mit          mit
klassenseite           404      schueler schueler login    login    login    schueler lehrer       404      404      lehrer       lehrer       404      lehrer       lehrer
reiter                 404      404      404      login    login    login    404      ok           404      404      ok           ok           404      ok           ok
ergebnisse             404      404      404      login    login    login    404      ok           404      404      ok           ok           404      ok           ok
einzelergebnis         404      404      404      login    login    login    404      ok           404      404      ok           ok           404      ok           ok
csv                    404      404      404      login    login    login    404      ok           404      404      ok           ok           404      ok           ok
zweiteKlasse           404      404      schueler login    login    login    404      404          404      404      404          404          404      404          lehrer
aufgabeAnsehen         404      ok       ok       login    login    login    ok       ok           404      404      ok           ok           404      ok           ok
pruefliste             404      404      404      login    login    login    ohne     404          ohne     ohne     mit          mit          404      ohne         ohne
sucheKlasse            ohne     mit      mit      login    login    login    mit      mit          ohne     ohne     mit          mit          ohne     mit          mit
suchePerson            ohne     ohne     ohne     login    login    login    ohne     ohne         ohne     ohne     person       person       ohne     person       ohne
spielenMitKlasse       404      klasse   klasse   login    login    login    klasse   klasse       404      404      klasse       klasse       404      ohne         klasse
spielenOhneKlasse      404      klasse   klasse   login    login    login    klasse   klasse       404      404      klasse       klasse       404      404          ohne
token                  404      klasse   klasse   403      401      403      klasse   klasse       404      404      klasse       klasse       404      ohne         klasse
speichern              404      ok       ok       401      401      401      ok       ok           404      404      ok           ok           404      ok           ok
bestenliste            404      namen    namen    401      401      401      namen    namen        404      404      namen        namen        404      anonym       anonym
ergebnisSdk            404      klasse   klasse   401      401      401      klasse   klasse       404      404      klasse       klasse       404      ohne         klasse
klassendaten           404      forbidden forbidden 401    401      401      forbidden ok          404      404      ok           ok           404      no_class     ok
gemeinsam              404      forbidden forbidden 401    401      401      forbidden forbidden   404      404      forbidden    forbidden    404      forbidden    ok
schulweitOhneKlasse    ohne     klasse   klasse   401      401      401      klasse   klasse       ohne     ohne     klasse       klasse       ohne     ohne         ohne
schulweitFremdeKlasse  ohne     ohne     ohne     403      401      403      ohne     ohne         ohne     ohne     ohne         ohne         ohne     ohne         ohne
einreichen             404      wartet   wartet   403      401      403      wartet   freigegeben  404      404      freigegeben  freigegeben  404      404          freigegeben
pruefen                404      404      404      login    login    login    404      ok           404      404      ok           ok           404      404          ok
aufgabeStellen         404      404      404      403      401      403      404      ok           404      404      ok           ok           404      404          ok
erledigt               404      ok       ok       403      401      403      ok       404          404      404      404          404          404      404          404
rueckmeldungGeben      404      404      404      403      401      403      404      ok           404      404      ok           ok           404      404          ok
rueckmeldungLesen      ok       ok       ok       login    login    login    ok       ok           ok       ok       ok           ok           ok       ok           ok
meineDaten             ok       ok       ok       login    login    login    ok       ok           ok       ok       ok           ok           ok       ok           ok
verwaltung             404      404      404      login    login    login    404      404          404      404      404          404          404      404          ok
beitrittLink           schueler schueler schueler login    login    login    schueler schueler     schueler schueler schueler     schueler     schueler schueler     schueler
einladung              400      400      400      login    login    login    lehrer   400          lehrer   lehrer   lehrer       lehrer       400      lehrer       lehrer
verlassen              404      ok       ok       403      401      403      ok       ok           404      404      400          ok           404      400          404
neueKlasse             404      404      404      403      401      403      ok       404          ok       ok       ok           ok           404      ok           ok
appDatenLoeschen       ok       ok       ok       403      401      403      ok       ok           ok       ok       ok           ok           ok       ok           ok
kontoLoeschen          ok       ok       ok       403      401      403      ok       ok           ok       ok       ok           ok           ok       ok           ok
`;

const EXPECT = (() => {
  const [head, ...rows] = TABLE.trim().split('\n').map((l) => l.trim().split(/\s+/));
  const out = {};
  for (const [action, ...cells] of rows) {
    assert.ok(ACTIONS[action], `unknown action ${action}`);
    assert.equal(cells.length, head.length, `row ${action}`);
    out[action] = Object.fromEntries(head.map((s, i) => [s, cells[i]]));
  }
  assert.deepEqual(Object.keys(out).sort(), Object.keys(ACTIONS).sort(), 'every action has a row');
  assert.deepEqual([...head].sort(), Object.keys(STATES).sort(), 'every state has a column');
  return out;
})();

// ------------------------------------------------------------------ the shared Hub

before(async () => {
  // Generous limits: one Hub serves every cell (rate limits have their own tests).
  const many = [1e6, 60_000];
  h = await startHub({
    rate: { write: many, submit: many, publish: many, sdk: many, uploadVersions: many, uploadFiles: many },
    limits: { classesPerTeacher: 100_000, maxAppsPerUser: 100_000 },
  });
  adminUser = h.addUser('Anna Admin', 'admin');
  tom = h.addUser('Tom Lehrer', 'teacher');
  mara = h.addUser(MARA, 'student');
  frieda = h.addUser('Frieda Fremd', 'teacher');
  zora = h.addUser('Zora Zeta', 'student');
  [AD, T, M, F, Z] = await Promise.all([adminUser, tom, mara, frieda, zora].map((u) => h.browser().login(u)));

  G = await h.makeApp(T, 'Matrix-Quiz', { 'index.html': '<h1>Quiz</h1>' });
  h.db.run('UPDATE apps SET shared = 1 WHERE id = ?', G.id); // colleagues may add it to their classes
  S = await h.makeApp(T, 'Schulweit-Spiel', { 'index.html': '<h1>Für alle</h1>' });
  assert.equal((await AD.post(`/apps/${S.id}/schulweit`, { an: '1' })).status, 303);
  MA = await h.makeApp(M, 'Maras App', { 'index.html': '<h1>Mara</h1>' });

  // Tom's other class: Mara plays there too. Nothing of it may show anywhere else.
  decoy = { id: idFrom(await T.post('/klassen', { name: 'Geheimklasse 9z' })), name: 'Geheimklasse 9z' };
  assert.equal((await T.post(`/klassen/${decoy.id}/apps`, { app: G.id })).status, 303);
  await join(M, decoy);
  const md = (await h.token(M, G, decoy.id)).token;
  for (const [method, params] of [['results.add', { title: 'MARA-GEHEIM' }], ['save.set', { key: 'stand', value: 'MARA-SPIELSTAND' }], ['scores.submit', { board: 'punkte', score: 7 }]]) {
    assert.equal((await M.api(G, md, method, params)).json().ok, true);
  }

  // A foreign class: Frieda's, with Zora.
  const zeta = idFrom(await F.post('/klassen', { name: 'Zeta-Fremdklasse' }));
  assert.equal((await F.post(`/klassen/${zeta}/apps`, { app: G.id })).status, 303);
  await join(Z, { id: zeta });
  const zt = (await h.token(Z, G, zeta)).token;
  for (const [method, params] of [['results.add', { title: 'ZORA-ERGEBNIS' }], ['save.set', { key: 'stand', value: 'ZORA-STAND' }], ['scores.submit', { board: 'punkte', score: 9 }]]) {
    assert.equal((await Z.api(G, zt, method, params)).json().ok, true);
  }
});
after(() => h.stop());

// ------------------------------------------------------------------ one test per state

for (const [key, state] of Object.entries(STATES)) {
  test(`Matrix: ${state.title} – jede Aktion gibt, was die Regeln sagen`, async () => {
    const shared = await state.setup();
    const wrong = [];
    for (const [action, run] of Object.entries(ACTIONS)) {
      const c = FRESH.has(action) && !state.frozen ? await state.setup() : shared;
      let got;
      try {
        got = await run(c);
      } catch (err) {
        got = `Fehler (${err.message})`;
      }
      const want = EXPECT[action][key];
      if (got !== want) wrong.push(`${action}: erwartet ${want}, bekommen ${got}`);
    }
    // A blocked or deleted person's old token and cookie never wrote anything.
    if (key === 'gelo') {
      for (const table of ['saves', 'results', 'scores', 'progress', 'plays', 'class_members', 'apps', 'feedback']) {
        const col = table === 'apps' ? 'owner_id' : table === 'feedback' ? 'student_id' : 'user_id';
        if (h.db.get(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`, shared.user.id).n) wrong.push(`${table}: Zeilen für das gelöschte Konto`);
      }
    }
    assert.deepEqual(wrong, []);
  });
}
