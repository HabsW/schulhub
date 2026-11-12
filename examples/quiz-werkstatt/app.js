// Quiz-Werkstatt – Beispiel-App für den SchulHub (SDK 2).
//
// Die Lehrkraft schreibt die Fragen im Hub (Einstellungen der Klasse), die App
// macht daraus ein Quiz: mit Auswahl-Antworten oder zum Eintippen.
//
// Zeigt:  hub.settings      Titel, Fragen und Modus
//         hub.results       jede Runde Frage für Frage für die Lehrkraft (+ results.mine für "Deine letzten Runden")
//         hub.progress      dein bestes Ergebnis in diesem Quiz
//         hub.achievements  Erfolge aus schulhub.json, einer davon geheim
'use strict';

// Dieselben Werte wie "default" in schulhub.json – für den Start per Doppelklick ohne Hub.
const STANDARD = {
  titel: 'Allgemeinwissen',
  modus: 'gemischt',
  mischen: true,
  fragen: [
    'Wie viele Kontinente gibt es? | 7 | 5 | 6 | 8',
    'Welches Gas nehmen Pflanzen für die Fotosynthese auf? | Kohlenstoffdioxid | Sauerstoff | Stickstoff | Helium',
    'Wie heißt die Hauptstadt von Kanada? | Ottawa | Toronto | Vancouver | Montreal',
    'Was sind 15 % von 200? | 30 | 15 | 20 | 35',
    'Wie viele Beine hat eine Spinne? | 8',
    'Welche Zahl ist eine Primzahl? | 13 | 9 | 15 | 21',
    'Wie heißt der größte Planet unseres Sonnensystems? | Jupiter',
    'In welchem Jahr fiel die Berliner Mauer? | 1989',
    'Wer malte die „Mona Lisa“? | Leonardo da Vinci | Michelangelo | Raffael | Rembrandt',
    'Was ist das Gegenteil von „laut“? | leise',
  ],
};
const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

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
const show = (view) => document.querySelectorAll('[data-view]').forEach((s) => (s.hidden = s.dataset.view !== view));
const firstName = (name) => (/^(Herr|Frau)\s/.test(name) ? name : name.split(' ')[0]);
const shuffle = (list) => {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const dateText = (ts) => new Date(ts).toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'short' });

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

// ---------- Fragen ----------
/**
 * Eine Zeile "Frage | richtig | falsch | falsch" wird zu { frage, richtig, falsch: [...] }.
 * Zeilen ohne "|" werden übersprungen (und gezählt, damit die Lehrkraft es merkt).
 */
function parseQuestions(lines) {
  const questions = [];
  let skipped = 0;
  for (const line of Array.isArray(lines) ? lines : []) {
    const parts = String(line).split('|').map((s) => s.trim()).filter(Boolean);
    if (parts.length < 2) {
      skipped++;
      continue;
    }
    const [frage, richtig, ...falsch] = parts;
    questions.push({ frage, richtig, falsch: [...new Set(falsch.filter((f) => f !== richtig))].slice(0, 5) });
  }
  return { questions, skipped };
}
const norm = (s) => String(s).toLowerCase().replace(/[„“”"'’`´]/g, '').replace(/[.!?]+$/, '').replace(/\s+/g, ' ').trim();
/** Ein kurzer Fingerabdruck der Fragen: ändert die Lehrkraft das Quiz, beginnt "dein Bestes" neu. */
function fingerprint(text) {
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
  $('where').textContent = hub.class ? hub.class.name : 'Quiz-Werkstatt';
  $('who').textContent = 'Hallo ' + firstName(hub.user.name) + '!';

  const s = await hub.settings.all();
  const titel = typeof s.titel === 'string' && s.titel.trim() ? s.titel.trim() : STANDARD.titel;
  const lines = Array.isArray(s.fragen) ? s.fragen : STANDARD.fragen;
  const typeAll = (s.modus || STANDARD.modus) === 'eingabe';
  const mix = typeof s.mischen === 'boolean' ? s.mischen : STANDARD.mischen;
  const { questions, skipped } = parseQuestions(lines);
  const quizId = fingerprint(titel + '\n' + lines.join('\n'));
  const choiceCount = typeAll ? 0 : questions.filter((q) => q.falsch.length).length;

  $('title').textContent = titel;
  document.title = titel + ' – Quiz-Werkstatt';

  if (hub.user.isTeacher) {
    $('teacher-note').textContent = 'Titel, Fragen und Modus stellst du im Hub ein: in der Klasse bei dieser App unter „Einstellungen“.' +
      (skipped ? ' Achtung: ' + skipped + (skipped === 1 ? ' Zeile hat' : ' Zeilen haben') + ' kein „|“ und ' + (skipped === 1 ? 'wurde' : 'wurden') + ' übersprungen.' : '');
    $('teacher-note').hidden = false;
  }

  let best = await hub.save.get('bestes', null); // { quiz, score, max }
  if (!best || best.quiz !== quizId) best = null;
  let rounds = await hub.save.get('runden', 0);

  let order = [];
  let index = 0;
  let log = [];
  let answered = false;
  let startedAt = 0;

  async function menu(focus) {
    if (!questions.length) {
      if (hub.user.isTeacher) $('empty-text').textContent = 'Trag im Hub bei dieser App unter „Einstellungen“ Fragen ein – eine pro Zeile: Frage | richtige Antwort | falsche Antwort.';
      return show('empty');
    }
    const typed = questions.length - choiceCount;
    $('quiz-info').textContent = questions.length + (questions.length === 1 ? ' Frage' : ' Fragen') +
      (choiceCount && typed ? ' · ' + choiceCount + ' zur Auswahl, ' + typed + ' zum Eintippen' : typed ? ' · Antworten eintippen' : ' · zur Auswahl');
    $('best').textContent = best ? 'Dein bestes Ergebnis: ' + best.score + ' von ' + best.max + ' richtig' : 'Du hast dieses Quiz noch nicht gespielt.';
    show('menu');
    if (focus === true) $('start').focus({ preventScroll: true });
    try {
      const mine = await hub.results.mine({ limit: 5 });
      $('history').replaceChildren(...mine.map((r) =>
        el('li', {}, el('span', { text: String(r.title).replace(/^Quiz: /, '') }), el('span', { class: 'hub-muted', text: dateText(r.at) }),
          el('b', { text: r.maxScore ? r.score + ' / ' + r.maxScore : String(r.score) }))));
      $('history-empty').hidden = mine.length > 0;
      renderAchievements(await hub.achievements.list());
    } catch (e) {
      $('history-empty').textContent = e.message;
      $('history-empty').hidden = false;
    }
  }

  function ask() {
    const q = order[index];
    answered = false;
    $('count').textContent = 'Frage ' + (index + 1) + ' von ' + order.length;
    $('quiz-progress').value = index / order.length;
    $('question').textContent = q.frage;
    $('feedback').textContent = '';
    $('feedback').className = 'feedback';
    $('next').hidden = true;
    const asChoice = !typeAll && q.falsch.length > 0;
    $('choices').hidden = !asChoice;
    $('answer-form').hidden = asChoice;
    if (asChoice) {
      const options = shuffle([q.richtig, ...q.falsch]);
      $('choices').replaceChildren(...options.map((text, i) =>
        el('button', { class: 'choice', type: 'button', 'data-answer': text }, el('span', { class: 'letter', 'aria-hidden': 'true', text: LETTERS[i] }), el('span', { text }))));
      $('keys').textContent = 'Tipp: Tasten ' + LETTERS.slice(0, options.length).join(', ') + ' oder 1–' + options.length + ' wählen eine Antwort.';
      $('question').focus({ preventScroll: true });
    } else {
      $('answer').value = '';
      $('answer').readOnly = false;
      $('keys').textContent = '';
      $('answer').focus();
    }
  }

  function answer(given) {
    if (answered) return;
    answered = true;
    const q = order[index];
    const right = norm(given) === norm(q.richtig);
    log.push({ frage: q.frage, antwort: given, loesung: q.richtig, richtig: right });
    for (const b of $('choices').children) {
      b.disabled = true;
      if (b.dataset.answer === q.richtig) b.classList.add('is-right');
      else if (b.dataset.answer === given) b.classList.add('is-wrong');
    }
    $('answer').readOnly = true;
    $('feedback').textContent = right ? '✓ Richtig!' : '✗ Leider nicht. Richtig ist: ' + q.richtig;
    $('feedback').className = 'feedback ' + (right ? 'right' : 'wrong');
    $('next').textContent = index + 1 < order.length ? 'Nächste Frage' : 'Ergebnis ansehen';
    $('next').hidden = false;
    $('next').focus();
  }

  $('choices').addEventListener('click', (event) => {
    const b = event.target.closest('button.choice');
    if (b) answer(b.dataset.answer);
  });
  $('answer-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (answered) return next();
    if ($('answer').value.trim()) answer($('answer').value.trim());
  });
  document.addEventListener('keydown', (event) => {
    if ($('choices').hidden || answered || event.ctrlKey || event.metaKey || event.altKey) return;
    if (document.querySelector('[data-view="question"]').hidden) return;
    const key = event.key.toUpperCase();
    const i = /^[1-6]$/.test(key) ? Number(key) - 1 : LETTERS.indexOf(key);
    const b = $('choices').children[i];
    if (b) {
      event.preventDefault();
      b.click();
    }
  });

  function next() {
    index++;
    if (index < order.length) ask();
    else finish();
  }
  $('next').addEventListener('click', next);
  $('start').addEventListener('click', () => {
    order = mix ? shuffle(questions) : questions.slice();
    index = 0;
    log = [];
    startedAt = Date.now();
    show('question');
    ask();
  });
  $('again').addEventListener('click', () => $('start').click());
  $('cancel').addEventListener('click', () => menu(true));
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
    const score = log.filter((l) => l.richtig).length;
    const max = log.length;
    const seconds = (Date.now() - startedAt) / 1000;
    rounds++;
    if (!best || score > best.score) best = { quiz: quizId, score, max };
    $('score').replaceChildren(String(score), el('small', { text: ' von ' + max + ' richtig' }));
    $('verdict').textContent = score === max ? 'Volle Punktzahl – großartig!' : score >= max * 0.7 ? 'Sehr gut!' : score >= max * 0.4 ? 'Gar nicht schlecht – noch eine Runde?' : 'Übung macht den Meister – probier es gleich noch einmal.';
    $('review').replaceChildren(...log.map((l) =>
      el('li', { class: l.richtig ? 'right' : 'wrong' },
        el('span', { class: 'mark', 'aria-label': l.richtig ? 'richtig' : 'falsch', text: l.richtig ? '✓' : '✗' }),
        el('span', { class: 'q', text: l.frage }),
        el('small', { text: l.richtig ? l.loesung : 'Richtig: ' + l.loesung + ' · deine Antwort: ' + l.antwort }))));
    $('save-state').textContent = hub.mode === 'preview' ? 'Vorschau – nichts wird gespeichert.' : 'Speichert …';
    show('done');
    $('again').focus();
    try {
      await Promise.all([
        hub.save.set('bestes', best),
        hub.save.set('runden', rounds),
        hub.results.add({ title: 'Quiz: ' + titel, score, maxScore: max, details: log }),
        hub.progress.set(best.score / best.max, { label: 'Bestes Ergebnis: ' + best.score + ' von ' + best.max }),
      ]);
      if (hub.mode !== 'preview') $('save-state').textContent = 'Gespeichert ✓';
    } catch (e) {
      $('save-state').textContent = 'Nicht gespeichert: ' + e.message;
    }
    await unlock('erstes-quiz');
    if (score === max) await unlock('volle-punktzahl');
    if (rounds >= 5) await unlock('dranbleiben');
    if (score === max && max >= 3 && seconds < max * 5) await unlock('blitzmerker');
  }

  menu();
}
