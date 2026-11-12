// Kopfrechnen – Beispiel-App für den SchulHub (SDK 2).
//
// Ein Sprint: so schnell wie möglich eine Reihe Aufgaben rechnen. Fünf Stufen mit
// wachsendem Zahlenraum; die Lehrkraft stellt Zahlenraum, Rechenarten und Länge ein.
//
// Zeigt:  hub.settings      Zahlenraum, Rechenarten, Aufgaben pro Sprint
//         hub.leaderboard   Bestzeiten pro Stufe – kleinere Zeit ist besser ({ lowerIsBetter: true })
//         hub.progress      geschaffte Stufen
//         hub.save          Bestzeiten und geschaffte Stufen
//         hub.results       jeder Sprint Aufgabe für Aufgabe für die Lehrkraft
//         hub.achievements  Erfolge aus schulhub.json
'use strict';

const STANDARD = { bis: 100, plus: true, minus: true, mal: true, geteilt: false, aufgaben: 20 }; // wie in schulhub.json
const STUFEN = 5;
const STRAFE = 3; // Sekunden pro Fehler
const ERLAUBTE_FEHLER = 2;
const ZEICHEN = { plus: '+', minus: '−', mal: '·', geteilt: ':' };
const NAMEN = { plus: 'Plus', minus: 'Minus', mal: 'Mal', geteilt: 'Geteilt' };

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
const rnd = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
const decimal = (n, digits = 1) => n.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });
/** 48.2 -> "48,2 s", 65.3 -> "1:05,3 min" */
function timeText(seconds) {
  if (seconds < 60) return decimal(seconds) + ' s';
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return m + ':' + (s < 10 ? '0' : '') + decimal(s) + ' min';
}

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

// ---------- Aufgaben ----------
/** Größte Zahl einer Stufe: Stufe 5 = Einstellung "bis", Stufe 1 fängt bei einem Fünftel an (mindestens 10). */
function rangeOf(level, bis) {
  const lo = Math.min(bis, Math.max(10, Math.round(bis / 5)));
  return Math.round(lo + ((bis - lo) * (level - 1)) / (STUFEN - 1));
}

/** Eine Aufgabe, deren Ergebnis eine ganze Zahl von 0 bis max ist. */
function makeTask(ops, max) {
  const op = ops[rnd(0, ops.length - 1)];
  if (op === 'plus') {
    const c = rnd(Math.max(2, Math.ceil(max / 3)), max);
    const a = rnd(1, c - 1);
    return { op, a, b: c - a, result: c };
  }
  if (op === 'minus') {
    const a = rnd(Math.max(2, Math.ceil(max / 3)), max);
    const b = rnd(1, a - 1);
    return { op, a, b, result: a - b };
  }
  // Mal und geteilt: kleines (bis 100) oder großes Einmaleins (ab 200)
  const top = Math.max(2, Math.min(max >= 200 ? 20 : 10, Math.floor(max / 2)));
  const x = rnd(2, top);
  const y = rnd(2, Math.max(2, Math.min(top, Math.floor(max / x))));
  return op === 'mal' ? { op, a: x, b: y, result: x * y } : { op, a: x * y, b: x, result: y };
}
const taskText = (t) => t.a + ' ' + ZEICHEN[t.op] + ' ' + t.b;

// ---------- die App ----------
Hub.connect().then(start).catch((e) => {
  $('who').textContent = 'Keine Verbindung zum Hub: ' + e.message;
});

async function start(hub) {
  modeNote(hub);
  $('where').textContent = hub.class ? hub.class.name : 'Kopfrechnen';
  $('who').textContent = 'Hallo ' + firstName(hub.user.name) + '!';

  const s = { ...STANDARD, ...(await hub.settings.all()) };
  const bis = Math.min(1000, Math.max(10, Math.round(Number(s.bis) || STANDARD.bis)));
  const count = Math.min(50, Math.max(5, Math.round(Number(s.aufgaben) || STANDARD.aufgaben)));
  let ops = ['plus', 'minus', 'mal', 'geteilt'].filter((op) => s[op] === true);
  if (!ops.length) ops = ['plus'];
  const opsText = ops.map((op) => NAMEN[op]).join(', ');

  if (hub.user.isTeacher) {
    $('teacher-note').textContent = 'Zahlenraum, Rechenarten und Aufgaben pro Sprint stellst du im Hub ein: in der Klasse bei dieser App unter „Einstellungen“.';
    $('teacher-note').hidden = false;
  }

  // { "1": { best: 48.2, passed: true }, ... } – Bestzeit und "geschafft" pro Stufe
  let levels = await hub.save.get('stufen', {});
  if (!levels || typeof levels !== 'object') levels = {};
  const passedCount = () => Object.keys(levels).filter((k) => levels[k] && levels[k].passed).length;
  const unlockedUpTo = () => {
    let n = 1;
    while (n < STUFEN && levels[n] && levels[n].passed) n++;
    return n;
  };
  let level = Math.min(unlockedUpTo(), Math.max(1, Number(await hub.save.get('stufe', 1)) || 1));

  // Sprint-Zustand
  let tasks = [];
  let index = 0;
  let typed = '';
  let log = [];
  let mistakes = 0;
  let t0 = 0;
  let taskStart = 0;
  let clock = null;
  let locked = true;
  let run = 0; // jede Runde bekommt eine Nummer – ein Countdown einer abgebrochenen Runde läuft ins Leere

  async function menu(focus) {
    const done = passedCount();
    $('levels-done').textContent = done + ' von ' + STUFEN + ' geschafft';
    $('progress').value = done / STUFEN;
    $('levels').replaceChildren(...Array.from({ length: STUFEN }, (_, i) => {
      const n = i + 1;
      const info = levels[n];
      const open = n <= unlockedUpTo();
      const status = info && info.passed ? '✓ ' + timeText(info.best) : open ? 'offen' : 'gesperrt';
      return el('li', {},
        el('button', { type: 'button', class: 'level' + (n === level ? ' current' : '') + (info && info.passed ? ' passed' : ''), 'data-level': n, disabled: !open, 'aria-pressed': n === level ? 'true' : 'false' },
          el('span', { class: 'level-num', text: String(n) }),
          el('span', { class: 'level-text' }, el('strong', { text: 'Stufe ' + n }), el('small', { text: 'Zahlen bis ' + rangeOf(n, bis) })),
          el('span', { class: 'level-status', text: status })));
    }));
    $('level-eyebrow').textContent = 'Stufe ' + level + ' von ' + STUFEN;
    $('level-info').textContent = count + ' Aufgaben · Zahlen bis ' + rangeOf(level, bis) + ' · ' + opsText;
    $('level-best').textContent = levels[level] && levels[level].best ? 'Deine Bestzeit: ' + timeText(levels[level].best) : 'Noch keine Bestzeit auf dieser Stufe.';
    $('start').textContent = 'Stufe ' + level + ' starten';
    $('board-sub').textContent = 'Stufe ' + level + ' · weniger Zeit ist besser';
    show('menu');
    if (focus === true) $('start').focus({ preventScroll: true });
    try {
      const top = await hub.leaderboard.top('stufe-' + level, { limit: 5, lowerIsBetter: true });
      $('board').replaceChildren(...top.entries.map((e) =>
        el('li', { class: e.me ? 'hub-me' : '' }, el('span', { text: e.me ? e.name + ' (du)' : e.name }), el('b', { text: timeText(e.score) }))));
      $('board-empty').hidden = top.entries.length > 0;
      renderAchievements(await hub.achievements.list());
    } catch (e) {
      $('board-empty').textContent = e.message;
      $('board-empty').hidden = false;
    }
  }

  $('levels').addEventListener('click', (event) => {
    const b = event.target.closest('button[data-level]');
    if (!b || b.disabled) return;
    level = Number(b.dataset.level);
    hub.save.set('stufe', level).catch(() => {});
    menu();
  });

  // ----- Sprint -----
  const elapsed = () => (Date.now() - t0) / 1000 + mistakes * STRAFE;
  function tick() {
    $('clock').textContent = timeText(elapsed());
  }

  function showTask() {
    const t = tasks[index];
    $('count').textContent = 'Aufgabe ' + (index + 1) + ' von ' + tasks.length;
    $('sprint-progress').value = index / tasks.length;
    $('task').textContent = taskText(t) + ' =';
    typed = '';
    $('typed').textContent = '';
    $('task-card').className = 'task-card';
    $('sprint-feedback').textContent = '';
    taskStart = Date.now();
    locked = false;
  }

  function countdown(n, myRun) {
    if (myRun !== run) return;
    $('task').textContent = n > 0 ? String(n) : 'Los!';
    if (n > 0) setTimeout(() => countdown(n - 1, myRun), 650);
    else {
      t0 = Date.now();
      clock = setInterval(tick, 100);
      showTask();
    }
  }

  function startSprint() {
    const max = rangeOf(level, bis);
    tasks = [];
    while (tasks.length < count) {
      const t = makeTask(ops, max);
      const last = tasks[tasks.length - 1];
      if (!last || taskText(last) !== taskText(t)) tasks.push(t);
    }
    index = 0;
    log = [];
    mistakes = 0;
    locked = true;
    $('count').textContent = 'Aufgabe 1 von ' + tasks.length;
    $('sprint-progress').value = 0;
    $('clock').textContent = timeText(0);
    $('typed').textContent = '';
    $('sprint-feedback').textContent = '';
    $('task-card').className = 'task-card';
    show('sprint');
    countdown(3, ++run);
  }

  function press(key) {
    if (locked) return;
    if (/^[0-9]$/.test(key)) {
      if (typed.length < 6) typed += key;
    } else if (key === 'Backspace') typed = typed.slice(0, -1);
    else if (key === 'Enter') return check();
    $('typed').textContent = typed;
  }

  function check() {
    if (!typed) return;
    const t = tasks[index];
    const given = Number(typed);
    const right = given === t.result;
    log.push({ aufgabe: taskText(t), antwort: given, loesung: t.result, richtig: right, sekunden: Math.round((Date.now() - taskStart) / 100) / 10 });
    locked = true;
    if (right) {
      $('task-card').className = 'task-card right';
      setTimeout(advance, 180, run);
    } else {
      mistakes++;
      $('task-card').className = 'task-card wrong';
      $('sprint-feedback').textContent = '✗ ' + taskText(t) + ' = ' + t.result + ' (+' + STRAFE + ' s)';
      tick();
      setTimeout(advance, 1200, run);
    }
  }

  function advance(myRun) {
    if (myRun !== run) return;
    index++;
    if (index < tasks.length) showTask();
    else finish();
  }

  $('keypad').addEventListener('click', (event) => {
    const b = event.target.closest('button[data-key]');
    if (b) press(b.dataset.key);
  });
  document.addEventListener('keydown', (event) => {
    if (document.querySelector('[data-view="sprint"]').hidden || event.ctrlKey || event.metaKey || event.altKey) return;
    if (/^[0-9]$/.test(event.key) || event.key === 'Backspace' || event.key === 'Enter') {
      event.preventDefault();
      press(event.key);
    } else if (event.key === 'Escape') stopSprint();
  });

  function stopSprint() {
    run++;
    clearInterval(clock);
    locked = true;
    menu(true);
  }
  $('cancel').addEventListener('click', stopSprint);
  $('start').addEventListener('click', startSprint);
  $('back').addEventListener('click', () => menu(true));
  $('again').addEventListener('click', () => {
    if ($('again').dataset.next) {
      level = Number($('again').dataset.next);
      hub.save.set('stufe', level).catch(() => {});
    }
    startSprint();
  });

  async function unlock(id) {
    try {
      const a = await hub.achievements.unlock(id);
      if (a.new) toast(a.emoji + ' Erfolg: ' + a.title);
    } catch (e) {
      // Erfolge sind ein Extra
    }
  }

  async function finish() {
    clearInterval(clock);
    const seconds = Math.round(elapsed() * 10) / 10;
    const right = log.filter((l) => l.richtig).length;
    const passed = mistakes <= ERLAUBTE_FEHLER;
    const old = levels[level] || {};
    const record = passed && (!old.best || seconds < old.best);
    if (passed) levels[level] = { best: record ? seconds : old.best, passed: true };
    const done = passedCount();
    const nextLevel = passed && level < STUFEN ? level + 1 : 0;

    $('done-eyebrow').textContent = 'Stufe ' + level + (passed ? ' geschafft' : ' – nicht geschafft');
    $('time').textContent = timeText(seconds);
    $('time-detail').textContent = right + ' von ' + log.length + ' richtig' + (mistakes ? ' · ' + mistakes + ' Fehler' + ' (+' + mistakes * STRAFE + ' s)' : ' · ohne Fehler');
    $('verdict').textContent = !passed
      ? 'Mehr als ' + ERLAUBTE_FEHLER + ' Fehler – lieber genau als schnell. Gleich noch einmal?'
      : record && old.best ? 'Neue Bestzeit! ' + decimal(old.best - seconds) + ' Sekunden schneller als vorher.'
      : nextLevel ? 'Stufe ' + nextLevel + ' ist jetzt frei.' : 'Stark gerechnet!';
    $('again').textContent = nextLevel ? 'Weiter mit Stufe ' + nextLevel : 'Noch einmal';
    if (nextLevel) $('again').dataset.next = String(nextLevel);
    else delete $('again').dataset.next;
    $('review').replaceChildren(...log.map((l) =>
      el('li', { class: l.richtig ? 'right' : 'wrong' },
        el('span', { class: 'mark', 'aria-label': l.richtig ? 'richtig' : 'falsch', text: l.richtig ? '✓' : '✗' }),
        el('span', { text: l.aufgabe + ' = ' + l.loesung + (l.richtig ? '' : ' (deine Antwort: ' + l.antwort + ')') }),
        el('small', { text: decimal(l.sekunden) + ' s' }))));
    $('save-state').textContent = hub.mode === 'preview' ? 'Vorschau – nichts wird gespeichert.' : 'Speichert …';
    show('done');
    $('again').focus();
    try {
      const calls = [
        hub.save.set('stufen', levels),
        hub.results.add({ title: 'Sprint Stufe ' + level + ' · ' + timeText(seconds), score: right, maxScore: log.length, details: log }),
        hub.progress.set(done / STUFEN, { label: 'Stufe ' + done + ' von ' + STUFEN + ' geschafft' }),
      ];
      // In die Bestenliste kommen nur geschaffte Sprints. Es zählt die kleinste Zeit.
      if (passed) calls.push(hub.leaderboard.submit('stufe-' + level, seconds, { lowerIsBetter: true }));
      await Promise.all(calls);
      if (hub.mode !== 'preview') $('save-state').textContent = 'Gespeichert ✓';
    } catch (e) {
      $('save-state').textContent = 'Nicht gespeichert: ' + e.message;
    }
    await unlock('erster-sprint');
    if (!mistakes) await unlock('fehlerfrei');
    if (levels[3] && levels[3].passed) await unlock('halbzeit');
    if (done === STUFEN) await unlock('alle-stufen');
    if (log.length >= 20 && seconds < 60 && passed) await unlock('blitzrechner');
  }

  menu();
}
