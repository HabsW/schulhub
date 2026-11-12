// Lernkarten – Beispiel-App für den SchulHub (SDK 2).
//
// Karteikarten mit Lernkartei (Leitner-System): fünf Fächer. Gewusst = ein Fach
// weiter, und die Karte kommt erst nach ein paar Tagen wieder. Nicht gewusst =
// zurück in Fach 1. Die Karten legt die Lehrkraft im Hub fest.
//
// Zeigt:  hub.settings      Kartenstapel, Richtung, Rundenlänge
//         hub.save          Fach und nächster Termin für jede Karte
//         hub.progress      Karten im letzten Fach / alle Karten
//         hub.results       jede Lernrunde Karte für Karte für die Lehrkraft
//         hub.achievements  Erfolge aus schulhub.json, einer davon geheim
'use strict';

// Dieselben Werte wie "default" in schulhub.json – für den Start per Doppelklick ohne Hub.
const STANDARD = {
  titel: 'Hauptstädte Europas',
  richtung: 'vorne',
  runde: 12,
  karten: [
    ['Frankreich', 'Paris'], ['Italien', 'Rom'], ['Spanien', 'Madrid'], ['Polen', 'Warschau'], ['Österreich', 'Wien'],
    ['Schweiz', 'Bern'], ['Niederlande', 'Amsterdam'], ['Belgien', 'Brüssel'], ['Dänemark', 'Kopenhagen'], ['Schweden', 'Stockholm'],
    ['Norwegen', 'Oslo'], ['Finnland', 'Helsinki'], ['Portugal', 'Lissabon'], ['Griechenland', 'Athen'], ['Tschechien', 'Prag'],
    ['Ungarn', 'Budapest'], ['Irland', 'Dublin'], ['Kroatien', 'Zagreb'], ['Rumänien', 'Bukarest'], ['Litauen', 'Vilnius'],
  ],
};
const FAECHER = 5;
const PAUSE_TAGE = [0, 0, 1, 3, 7, 14]; // nach dem Umzug in Fach n kommt die Karte nach PAUSE_TAGE[n] Tagen wieder

// ---------- kleine Helfer ----------
const $ = (id) => document.getElementById(id);

/** Element bauen. Text kommt immer über textContent hinein – nie über innerHTML. */
function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}
/** Eine Ansicht zeigen. body[data-screen] erlaubt dem CSS, auf kleinen Bildschirmen beim Spielen Platz zu sparen. */
function show(view) {
  document.querySelectorAll('[data-view]').forEach((s) => (s.hidden = s.dataset.view !== view));
  document.body.dataset.screen = view;
}
const firstName = (name) => (/^(Herr|Frau)\s/.test(name) ? name : name.split(' ')[0]);
const shuffle = (list) => {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
/** Heute als Tageszahl (Tage seit 1970, nach der Uhr dieses Geräts). */
const today = () => {
  const d = new Date();
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
};
const dayText = (day) => new Date(day * 86400000).toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

let toastTimer = null;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

function modeNote(hub) {
  const n = $('mode-note');
  if (hub.mode === 'preview') n.textContent = 'Vorschau – nichts wird gespeichert.';
  else if (hub.mode === 'local') n.textContent = 'Lokaler Modus – gespeichert wird nur in diesem Browser.';
  else return;
  n.classList.toggle('preview', hub.mode === 'preview');
  n.hidden = false;
}

function renderAchievements(list) {
  $('achievements').replaceChildren(...list.map((a) =>
    el('li', { class: a.unlocked ? 'on' : '' },
      el('span', { class: 'ach-emoji', 'aria-hidden': 'true', text: a.emoji }),
      el('span', { class: 'ach-text' }, el('strong', { text: a.title }), a.description ? el('small', { text: a.description }) : null),
      el('span', { class: a.unlocked ? 'hub-badge hub-ok' : 'hub-badge', text: a.unlocked ? 'geschafft' : 'offen' }))));
  $('ach-empty').hidden = list.length > 0;
}

// ---------- Karten ----------
function cleanPairs(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((p) => Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && typeof p[1] === 'string')
    .map((p) => [p[0].trim().slice(0, 200), p[1].trim().slice(0, 200)])
    .filter((p) => p[0] && p[1]);
}
/** Kurzer, fester Name für eine Karte: Ändert die Lehrkraft eine Karte, beginnt nur diese neu. */
function cardId(pair) {
  const text = pair[0] + '\u0000' + pair[1];
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

// ---------- die App ----------
Hub.connect().then(start).catch((e) => {
  $('who').textContent = 'Keine Verbindung zum Hub: ' + e.message;
});

async function start(hub) {
  modeNote(hub);
  $('where').textContent = hub.class ? hub.class.name : 'Lernkarten';
  $('who').textContent = 'Hallo ' + firstName(hub.user.name) + '!';

  const s = await hub.settings.all();
  const titel = typeof s.titel === 'string' && s.titel.trim() ? s.titel.trim() : STANDARD.titel;
  const deck = Array.isArray(s.karten) ? cleanPairs(s.karten) : STANDARD.karten;
  const richtung = ['vorne', 'hinten', 'beide'].includes(s.richtung) ? s.richtung : STANDARD.richtung;
  const roundSize = Math.min(50, Math.max(5, Math.round(Number(s.runde) || STANDARD.runde)));
  const cards = deck.map((pair) => ({ id: cardId(pair), pair }));

  $('title').textContent = titel;
  document.title = titel + ' – Lernkarten';
  if (hub.user.isTeacher) {
    $('teacher-note').textContent = 'Den Kartenstapel, die Richtung und die Rundenlänge stellst du im Hub ein: in der Klasse bei dieser App unter „Einstellungen“.';
    $('teacher-note').hidden = false;
  }

  // Ein Spielstand für alle Karten: { "<Karten-Name>": [Fach, fällig am (Tageszahl)] }
  let state = await hub.save.get('kartei', {});
  if (!state || typeof state !== 'object') state = {};
  let days = await hub.save.get('tage', []);
  if (!Array.isArray(days)) days = [];

  const boxOf = (c) => (Array.isArray(state[c.id]) ? Math.min(FAECHER, Math.max(1, state[c.id][0] | 0)) : 1);
  const dueOf = (c) => (Array.isArray(state[c.id]) ? state[c.id][1] | 0 : 0);
  const isDue = (c) => dueOf(c) <= today();
  const mastered = () => cards.filter((c) => boxOf(c) === FAECHER).length;

  let queue = [];
  let index = 0;
  let flipped = false;
  let log = [];

  async function menu(focus) {
    if (!cards.length) {
      if (hub.user.isTeacher) $('empty-text').textContent = 'Leg im Hub bei dieser App unter „Einstellungen“ Karten an – eine pro Zeile: Vorderseite = Rückseite.';
      return show('empty');
    }
    const due = cards.filter(isDue);
    const learnable = cards.filter((c) => boxOf(c) < FAECHER);
    if (due.length) {
      $('due-text').textContent = due.length === 1 ? '1 Karte ist dran' : due.length + ' Karten sind dran';
      $('due-sub').textContent = 'Eine Runde hat bis zu ' + roundSize + ' Karten.';
    } else {
      const next = Math.min(...cards.map(dueOf));
      $('due-text').textContent = 'Für heute alles gelernt 🎉';
      $('due-sub').textContent = 'Die nächsten Karten sind ' + (next === today() + 1 ? 'morgen' : 'am ' + dayText(next)) + ' dran.';
    }
    $('start').hidden = !due.length;
    $('start').textContent = 'Lernen (' + Math.min(due.length, roundSize) + (Math.min(due.length, roundSize) === 1 ? ' Karte)' : ' Karten)');
    $('extra').hidden = due.length > 0;
    $('extra').textContent = learnable.length ? 'Trotzdem üben' : 'Alles wiederholen';

    const counts = Array.from({ length: FAECHER }, (_, i) => cards.filter((c) => boxOf(c) === i + 1).length);
    const most = Math.max(1, ...counts);
    $('boxes').replaceChildren(...counts.map((n, i) => {
      const fill = el('span', { class: 'box-fill' });
      fill.style.height = Math.round((n / most) * 100) + '%'; // über das Style-Objekt, nicht als style="…"
      return el('li', { class: 'box' + (i + 1 === FAECHER ? ' last' : ''), 'aria-label': 'Fach ' + (i + 1) + ': ' + n + (n === 1 ? ' Karte' : ' Karten') },
        el('span', { class: 'box-bar', 'aria-hidden': 'true' }, fill),
        el('strong', { 'aria-hidden': 'true', text: String(n) }),
        el('small', { 'aria-hidden': 'true', text: 'Fach ' + (i + 1) }));
    }));
    $('mastered').textContent = mastered() + ' von ' + cards.length + ' im letzten Fach';

    $('card-count').textContent = '(' + cards.length + ')';
    $('deck-list').replaceChildren(...cards.map((c) =>
      el('li', {}, el('span', { text: c.pair[0] }), el('span', { text: c.pair[1] }), el('small', { text: 'Fach ' + boxOf(c) }))));
    show('menu');
    if (focus === true) (due.length ? $('start') : $('extra')).focus({ preventScroll: true });
    try {
      renderAchievements(await hub.achievements.list());
    } catch (e) {
      $('ach-empty').textContent = e.message;
      $('ach-empty').hidden = false;
    }
  }

  function begin(list) {
    // Niedrige Fächer zuerst, innerhalb eines Fachs gemischt.
    queue = shuffle(list).sort((a, b) => boxOf(a) - boxOf(b)).slice(0, roundSize)
      .map((c) => ({ card: c, showFront: richtung === 'vorne' || (richtung === 'beide' && Math.random() < 0.5) }));
    index = 0;
    log = [];
    show('learn');
    showCard();
  }

  function showCard() {
    const q = queue[index];
    const [front, back] = q.showFront ? q.card.pair : [q.card.pair[1], q.card.pair[0]];
    flipped = false;
    $('card').classList.remove('flipped');
    $('card').setAttribute('aria-label', 'Karte: ' + front + '. Zum Umdrehen tippen.');
    $('front-label').textContent = q.showFront ? 'Vorderseite' : 'Rückseite';
    $('back-label').textContent = q.showFront ? 'Rückseite' : 'Vorderseite';
    $('front-text').textContent = front;
    $('back-text').textContent = back;
    $('box-tag').textContent = 'Fach ' + boxOf(q.card);
    $('count').textContent = 'Karte ' + (index + 1) + ' von ' + queue.length;
    $('learn-progress').value = index / queue.length;
    $('yes').disabled = true;
    $('no').disabled = true;
    $('card-hint').textContent = 'Tippe auf die Karte (oder Leertaste), um sie umzudrehen.';
    $('announce').textContent = '';
    $('card').focus({ preventScroll: true });
  }

  function flip() {
    if (flipped) return;
    flipped = true;
    $('card').classList.add('flipped');
    $('card').setAttribute('aria-label', 'Lösung: ' + $('back-text').textContent);
    $('announce').textContent = 'Lösung: ' + $('back-text').textContent + '. Gewusst oder nicht?';
    $('yes').disabled = false;
    $('no').disabled = false;
    $('card-hint').textContent = 'Hast du es gewusst? Sei ehrlich – so lernst du am meisten. (Tasten: ← nicht gewusst, → gewusst)';
  }

  function judge(knew) {
    if (!flipped) return;
    const q = queue[index];
    const box = knew ? Math.min(FAECHER, boxOf(q.card) + 1) : 1;
    state[q.card.id] = [box, today() + PAUSE_TAGE[box]];
    log.push({ vorderseite: q.card.pair[0], rueckseite: q.card.pair[1], gewusst: knew, fach: box });
    // Jede Karte wird sofort gespeichert – wer mittendrin aufhört, verliert nichts.
    hub.save.set('kartei', state).catch((e) => toast('Nicht gespeichert: ' + e.message));
    index++;
    if (index < queue.length) showCard();
    else finish();
  }

  $('card').addEventListener('click', flip);
  $('yes').addEventListener('click', () => judge(true));
  $('no').addEventListener('click', () => judge(false));
  document.addEventListener('keydown', (event) => {
    if (document.querySelector('[data-view="learn"]').hidden || event.ctrlKey || event.metaKey || event.altKey) return;
    const k = event.key;
    if ((k === ' ' || k === 'Enter') && !flipped && document.activeElement === $('card')) return; // der Knopf selbst dreht um
    if (k === ' ' && !flipped) {
      event.preventDefault();
      flip();
    } else if (flipped && (k === 'ArrowRight' || k === 'j' || k === 'J')) judge(true);
    else if (flipped && (k === 'ArrowLeft' || k === 'n' || k === 'N')) judge(false);
  });

  $('start').addEventListener('click', () => begin(cards.filter(isDue)));
  $('extra').addEventListener('click', () => {
    const learnable = cards.filter((c) => boxOf(c) < FAECHER);
    begin(learnable.length ? learnable : cards);
  });
  $('cancel').addEventListener('click', () => (log.length ? finish() : menu(true)));
  $('back').addEventListener('click', () => menu(true));

  async function unlock(id) {
    try {
      const a = await hub.achievements.unlock(id);
      if (a.new) toast(a.emoji + ' Erfolg: ' + a.title);
    } catch (e) {
      // Erfolge sind ein Extra
    }
  }

  async function finish() {
    const knew = log.filter((l) => l.gewusst).length;
    const done = mastered();
    if (!days.includes(today())) days = [...days, today()].slice(-30);
    $('score').replaceChildren(String(knew), el('small', { text: ' von ' + log.length + ' gewusst' }));
    $('verdict').textContent = knew === log.length ? 'Alles gewusst – die Karten rücken weiter!' : knew >= log.length / 2 ? 'Gut gemacht! Was du nicht wusstest, kommt bald wieder.' : 'Dranbleiben lohnt sich: Die Karten in Fach 1 kommen gleich wieder.';
    $('review').replaceChildren(...log.map((l) =>
      el('li', { class: l.gewusst ? 'right' : 'wrong' },
        el('span', { class: 'mark', 'aria-label': l.gewusst ? 'gewusst' : 'nicht gewusst', text: l.gewusst ? '✓' : '✗' }),
        el('span', { text: l.vorderseite + ' – ' + l.rueckseite }),
        el('small', { text: '→ Fach ' + l.fach }))));
    $('save-state').textContent = hub.mode === 'preview' ? 'Vorschau – nichts wird gespeichert.' : 'Speichert …';
    show('done');
    $('back').focus();
    try {
      await Promise.all([
        hub.save.set('kartei', state),
        hub.save.set('tage', days),
        hub.results.add({ title: 'Lernrunde: ' + titel, score: knew, maxScore: log.length, details: log }),
        hub.progress.set(cards.length ? done / cards.length : 0, { label: done + ' von ' + cards.length + ' Karten im letzten Fach' }),
      ]);
      if (hub.mode !== 'preview') $('save-state').textContent = 'Gespeichert ✓';
    } catch (e) {
      $('save-state').textContent = 'Nicht gespeichert: ' + e.message;
    }
    await unlock('erste-runde');
    if (done > 0) await unlock('im-ziel');
    if (days.length >= 3) await unlock('drei-tage');
    if (done === cards.length) await unlock('gemeistert');
    if (new Date().getHours() >= 20) await unlock('nachteule');
  }

  menu();
}
