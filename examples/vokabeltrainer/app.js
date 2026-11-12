// Vokabeltrainer – Beispiel-App für den SchulHub (SDK 2).
//
// Zeigt:  hub.settings      Wortliste, Richtung und Rundenlänge stellt die Lehrkraft im Hub ein
//         hub.save          was du schon kannst (pro Konto)
//         hub.progress      gelernte Wörter / alle Wörter – sichtbar auf der Startseite und bei der Lehrkraft
//         hub.achievements  Erfolge aus schulhub.json
//         hub.results       jede Runde Wort für Wort für die Lehrkraft
//         hub.leaderboard   richtige Antworten insgesamt
'use strict';

// Standardliste – dieselbe wie "default" in schulhub.json. Sie gilt, solange die
// Lehrkraft nichts eingestellt hat, und wenn die App per Doppelklick ohne Hub läuft.
const STANDARD = [
  ['der Hund', 'dog'], ['die Katze', 'cat'], ['das Haus', 'house'], ['die Schule', 'school'],
  ['der Freund', 'friend'], ['das Buch', 'book'], ['das Wasser', 'water'], ['der Apfel', 'apple'],
  ['die Stadt', 'town / city'], ['das Fenster', 'window'], ['die Uhr', 'clock / watch'], ['der Stuhl', 'chair'],
  ['der Tisch', 'table'], ['der Vogel', 'bird'], ['das Fahrrad', 'bike / bicycle'], ['gehen', 'to go'],
];
const GELERNT_AB = 2; // so oft hintereinander richtig = gelernt

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

function renderBoard(top, unit) {
  $('board').replaceChildren(...top.entries.map((e) =>
    el('li', { class: e.me ? 'hub-me' : '' }, el('span', { text: e.me ? e.name + ' (du)' : e.name }), el('b', { text: e.score + ' ' + unit }))));
  $('board-empty').hidden = top.entries.length > 0;
}

function renderAchievements(list) {
  $('achievements').replaceChildren(...list.map((a) =>
    el('li', { class: a.unlocked ? 'on' : '' },
      el('span', { class: 'ach-emoji', 'aria-hidden': 'true', text: a.emoji }),
      el('span', { class: 'ach-text' }, el('strong', { text: a.title }), a.description ? el('small', { text: a.description }) : null),
      el('span', { class: a.unlocked ? 'hub-badge hub-ok' : 'hub-badge', text: a.unlocked ? 'geschafft' : 'offen' }))));
  $('ach-empty').hidden = list.length > 0;
}

// ---------- Wörter ----------
/** Nur gültige Paare [deutsch, englisch] – Daten aus dem Netz werden nie blind übernommen. */
function cleanPairs(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((p) => Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && typeof p[1] === 'string')
    .map((p) => [p[0].trim().slice(0, 200), p[1].trim().slice(0, 200)])
    .filter((p) => p[0] && p[1]);
}
const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const pairKey = (p) => p[0] + '|' + p[1];

const norm = (s) => String(s).toLowerCase().replace(/[’`´]/g, "'").replace(/[.!?]+$/, '').replace(/\s+/g, ' ').trim();
const ARTIKEL = /^(to|the|a|an|der|die|das|ein|eine) /;
/** Richtig, wenn die Antwort einer der Lösungen entspricht ("town / city"); Artikel und "to" dürfen fehlen. */
function isRight(given, solution) {
  const g = norm(given);
  if (!g) return false;
  return solution.split('/').map(norm).filter(Boolean).some((s) => s === g || s.replace(ARTIKEL, '') === g.replace(ARTIKEL, ''));
}

/**
 * Die Wortliste kommt aus den Einstellungen der Lehrkraft. Version 1 dieser App hat
 * die Liste in hub.classData gespeichert: Solange die Lehrkraft im Hub noch keine
 * eigene Liste eingestellt hat, wird diese alte Liste weiter benutzt.
 */
async function loadWords(hub, settings) {
  const fromSettings = cleanPairs(settings.woerter);
  if (hub.class && (!fromSettings.length || sameList(fromSettings, STANDARD))) {
    try {
      const old = cleanPairs(await hub.classData.get('woerter', null));
      if (old.length) return { words: old, old: true };
    } catch (e) {
      // keine alten Klassendaten – dann eben die Einstellungen
    }
  }
  return { words: fromSettings.length ? fromSettings : STANDARD, old: false };
}

// ---------- die App ----------
Hub.connect().then(start).catch((e) => {
  $('who').textContent = 'Keine Verbindung zum Hub: ' + e.message;
});

async function start(hub) {
  modeNote(hub);
  $('where').textContent = hub.class ? hub.class.name : 'Ohne Klasse';
  $('who').textContent = 'Hallo ' + firstName(hub.user.name) + '!';

  const settings = await hub.settings.all();
  const { words, old } = await loadWords(hub, settings);
  const direction = ['de-en', 'en-de', 'gemischt'].includes(settings.richtung) ? settings.richtung : 'de-en';
  const roundSize = Math.min(words.length, Number.isFinite(settings.runde) ? settings.runde : 10);

  let known = await hub.save.get('gekonnt', {}); // { "der Hund|dog": 2 } = so oft hintereinander richtig
  let streak = await hub.save.get('serie', 0);
  let total = await hub.save.get('richtig-gesamt', 0);
  if (!known || typeof known !== 'object') known = {};

  // Spielstände aus Version 1 hatten nur das englische Wort als Schlüssel.
  const countOf = (p) => (pairKey(p) in known ? known[pairKey(p)] : known[p[1]] || 0);
  const learnedCount = () => words.filter((p) => countOf(p) >= GELERNT_AB).length;

  let round = [];
  let index = 0;
  let log = [];
  let state = 'answer'; // 'answer' | 'wait' (nach einer falschen Antwort: erst "Weiter") | 'locked'
  const unlocked = new Set();

  if (hub.user.isTeacher) {
    $('teacher-note').textContent = old
      ? 'Diese Klasse benutzt noch die Wortliste aus der alten Version der App. Sobald du im Hub bei dieser App unter „Einstellungen“ eine Wortliste speicherst, gilt die neue.'
      : 'Wortliste, Richtung und Rundenlänge stellst du im Hub ein: in der Klasse bei dieser App unter „Einstellungen“.';
    $('teacher-note').hidden = false;
  }

  async function menu(focus) {
    const learned = learnedCount();
    $('learned').textContent = learned;
    $('total').textContent = words.length;
    $('progress').value = words.length ? learned / words.length : 0;
    const dirText = { 'de-en': 'Deutsch → Englisch', 'en-de': 'Englisch → Deutsch', gemischt: 'gemischt' }[direction];
    $('round-info').textContent = roundSize + ' Wörter pro Runde · ' + dirText + ' · gelernt heißt: ' + GELERNT_AB + '× hintereinander richtig';
    $('word-count').textContent = '(' + words.length + ')';
    $('word-list').replaceChildren(...words.map((p) =>
      el('li', { class: countOf(p) >= GELERNT_AB ? 'learned' : '' },
        el('span', { lang: 'de', text: p[0] }), el('span', { lang: 'en', text: p[1] }),
        el('span', { class: 'mark', text: countOf(p) >= GELERNT_AB ? '✓ gelernt' : '' }))));
    show('menu');
    if (focus === true) $('start').focus({ preventScroll: true });
    try {
      renderBoard(await hub.leaderboard.top('richtig', { limit: 5 }), 'richtig');
      renderAchievements(await hub.achievements.list());
    } catch (e) {
      $('board-empty').textContent = e.message;
      $('board-empty').hidden = false;
    }
  }

  function ask() {
    const item = round[index];
    $('count').textContent = 'Wort ' + (index + 1) + ' von ' + round.length;
    $('quiz-progress').value = index / round.length;
    $('ask-label').textContent = item.toEnglish ? 'Wie heißt das auf Englisch?' : 'Wie heißt das auf Deutsch?';
    $('prompt').textContent = item.toEnglish ? item.pair[0] : item.pair[1];
    $('prompt').lang = item.toEnglish ? 'de' : 'en';
    $('answer').lang = item.toEnglish ? 'en' : 'de';
    $('answer').placeholder = item.toEnglish ? 'auf Englisch …' : 'auf Deutsch …';
    $('answer').value = '';
    $('answer').readOnly = false;
    $('check').textContent = 'Prüfen';
    $('feedback').textContent = '';
    $('feedback').className = 'feedback';
    $('streak').textContent = streak >= 3 ? '🔥 ' + streak + ' in Folge' : '';
    state = 'answer';
    $('answer').focus();
  }

  function next() {
    index++;
    if (index < round.length) ask();
    else finish();
  }

  $('start').addEventListener('click', () => {
    // Was noch nicht sitzt, kommt zuerst dran – ein bisschen gemischt.
    round = words
      .map((pair) => ({ pair, sort: countOf(pair) + Math.random() * 1.5 }))
      .sort((a, b) => a.sort - b.sort)
      .slice(0, roundSize)
      .map(({ pair }) => ({ pair, toEnglish: direction === 'de-en' || (direction === 'gemischt' && Math.random() < 0.5) }));
    index = 0;
    log = [];
    show('quiz');
    ask();
  });

  $('answer-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (state === 'wait') return next();
    if (state !== 'answer') return;
    const given = $('answer').value.trim();
    if (!given) return $('answer').focus();
    const item = round[index];
    const solution = item.toEnglish ? item.pair[1] : item.pair[0];
    const right = isRight(given, solution);
    log.push({ wort: item.toEnglish ? item.pair[0] : item.pair[1], antwort: given, loesung: solution, richtig: right });
    known[pairKey(item.pair)] = right ? countOf(item.pair) + 1 : 0;
    streak = right ? streak + 1 : 0;
    if (streak >= 10) unlock('zehn-in-folge');
    $('answer').readOnly = true;
    state = right ? 'locked' : 'wait';
    if (right) {
      $('feedback').textContent = norm(given) === norm(solution) ? '✓ Richtig!' : '✓ Richtig! (' + solution + ')';
      $('feedback').className = 'feedback right';
      setTimeout(next, 700);
    } else {
      $('feedback').textContent = '✗ Leider nicht. Richtig ist: ' + solution;
      $('feedback').className = 'feedback wrong';
      $('check').textContent = 'Weiter';
      $('check').focus();
    }
  });

  $('cancel').addEventListener('click', () => menu(true));
  $('back').addEventListener('click', () => menu(true));
  $('again').addEventListener('click', () => $('start').click());

  /** Einen Erfolg freischalten (pro Sitzung nur einmal fragen) und neu freigeschaltete feiern. */
  async function unlock(id) {
    if (unlocked.has(id)) return;
    unlocked.add(id);
    try {
      const a = await hub.achievements.unlock(id);
      if (a.new) toast(a.emoji + ' Erfolg: ' + a.title);
    } catch (e) {
      // Erfolge sind ein Extra – die Runde geht weiter
    }
  }

  async function finish() {
    const score = log.filter((l) => l.richtig).length;
    const learned = learnedCount();
    total += score;
    $('score').replaceChildren(String(score), el('small', { text: ' von ' + log.length + ' richtig' }));
    $('verdict').textContent = score === log.length ? 'Perfekt – keine einzige falsche Antwort!' : score >= log.length * 0.7 ? 'Stark! Weiter so.' : 'Gut geübt – die falschen Wörter kommen bald wieder dran.';
    $('review').replaceChildren(...log.map((l) =>
      el('li', { class: l.richtig ? 'right' : 'wrong' },
        el('span', { class: 'mark', 'aria-label': l.richtig ? 'richtig' : 'falsch', text: l.richtig ? '✓' : '✗' }),
        el('span', { text: l.wort + ' → ' + l.loesung }),
        l.richtig ? null : el('small', { text: 'deine Antwort: ' + l.antwort }))));
    $('save-state').textContent = hub.mode === 'preview' ? 'Vorschau – nichts wird gespeichert.' : 'Speichert …';
    show('done');
    $('again').focus();
    try {
      await Promise.all([
        hub.save.set('gekonnt', known),
        hub.save.set('serie', streak),
        hub.save.set('richtig-gesamt', total),
        hub.leaderboard.submit('richtig', total),
        // Das sieht die Lehrkraft in der Auswertung – Wort für Wort (Spaltennamen: "results.labels" in schulhub.json).
        hub.results.add({ title: 'Übungsrunde', score, maxScore: log.length, details: log }),
        hub.progress.set(words.length ? learned / words.length : 0, { label: learned + ' von ' + words.length + ' Wörtern gelernt' }),
      ]);
      if (hub.mode !== 'preview') $('save-state').textContent = 'Gespeichert ✓';
    } catch (e) {
      $('save-state').textContent = 'Nicht gespeichert: ' + e.message;
    }
    await unlock('erste-runde');
    if (score === log.length && log.length >= 5) await unlock('fehlerfrei');
    if (learned === words.length) await unlock('alles-gelernt');
  }

  menu();
}
