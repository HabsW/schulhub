// Sternenfänger – Beispiel-Spiel für den SchulHub (SDK 2).
//
// Zeigt:  hub.leaderboard   eine Bestenliste pro Schwierigkeit
//         hub.save          Rekord und bestes Level
//         hub.progress      bestes Level von 10 – sichtbar auf der Startseite und bei der Lehrkraft
//         hub.achievements  Erfolge aus schulhub.json, einer davon geheim
//         hub.settings      die Lehrkraft wählt die Schwierigkeit für die Klasse
//         hub.results       jede Runde mit Punkten, Level und Spielzeit
'use strict';

const W = 480; // Breite der Spielwelt; die Höhe passt sich dem Bildschirm an
const LEVELS = 10;
const STARS_PER_LEVEL = 10;
const MODES = {
  leicht: { name: 'Leicht', lives: 5, speed: 0.75, meteors: 0.2, ship: 92 },
  normal: { name: 'Normal', lives: 3, speed: 1, meteors: 0.28, ship: 78 },
  schwer: { name: 'Schwer', lives: 2, speed: 1.3, meteors: 0.36, ship: 66 },
};
const still = matchMedia('(prefers-reduced-motion: reduce)');

// ---------- kleine Helfer ----------
const $ = (id) => document.getElementById(id);
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
let toastTimer = null;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

// ---------- Zeichenfläche ----------
const canvas = $('game');
const ctx = canvas.getContext('2d');
let H = 640;
let backdrop = [];

/** Die Leinwand füllt den Platz – höchstens 3:4 breit und 9:20 hoch – und ist auf jedem Bildschirm scharf. */
function resize() {
  const stage = $('stage');
  let w = stage.clientWidth;
  let h = stage.clientHeight;
  if (w / h > 3 / 4) w = h * (3 / 4);
  if (w / h < 9 / 20) h = w * (20 / 9);
  canvas.style.width = Math.round(w) + 'px';
  canvas.style.height = Math.round(h) + 'px';
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const scale = canvas.width / W;
  H = canvas.height / scale;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  backdrop = Array.from({ length: 70 }, () => ({ x: Math.random() * W, y: Math.random() * H, r: Math.random() * 1.4 + 0.3, v: Math.random() * 14 + 6 }));
}

function drawStar(x, y, r, spin) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = spin + (i * Math.PI) / 5 - Math.PI / 2;
    const rr = i % 2 ? r * 0.45 : r;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fillStyle = '#ffd23f';
  ctx.fill();
  ctx.strokeStyle = '#fff3b0';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function drawMeteor(t) {
  ctx.fillStyle = 'rgba(255, 140, 80, .25)';
  ctx.beginPath();
  ctx.moveTo(t.x - t.r * 0.8, t.y - t.r * 0.2);
  ctx.lineTo(t.x, t.y - t.r * 3.2);
  ctx.lineTo(t.x + t.r * 0.8, t.y - t.r * 0.2);
  ctx.fill();
  ctx.fillStyle = '#8a6b5a';
  ctx.beginPath();
  ctx.arc(t.x, t.y, t.r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#5e463a';
  ctx.beginPath();
  ctx.arc(t.x - t.r * 0.3, t.y - t.r * 0.25, t.r * 0.28, 0, Math.PI * 2);
  ctx.arc(t.x + t.r * 0.35, t.y + t.r * 0.3, t.r * 0.2, 0, Math.PI * 2);
  ctx.fill();
}

function drawHeart(x, y, s, full) {
  ctx.beginPath();
  ctx.moveTo(x, y + s * 0.3);
  ctx.bezierCurveTo(x, y, x - s * 0.5, y, x - s * 0.5, y + s * 0.3);
  ctx.bezierCurveTo(x - s * 0.5, y + s * 0.6, x, y + s * 0.8, x, y + s);
  ctx.bezierCurveTo(x, y + s * 0.8, x + s * 0.5, y + s * 0.6, x + s * 0.5, y + s * 0.3);
  ctx.bezierCurveTo(x + s * 0.5, y, x, y, x, y + s * 0.3);
  ctx.fillStyle = full ? '#f25560' : 'rgba(255,255,255,.18)';
  ctx.fill();
}

// ---------- das Spiel ----------
Hub.connect().then(start).catch((e) => {
  $('message').textContent = 'Keine Verbindung zum Hub: ' + e.message;
});

async function start(hub) {
  const wanted = await hub.settings.get('schwierigkeit', 'normal');
  const modeKey = Object.hasOwn(MODES, wanted) ? wanted : 'normal';
  const mode = MODES[modeKey];
  // "normal" benutzt die Bestenliste aus Version 1 weiter.
  const board = modeKey === 'normal' ? 'punkte' : 'punkte-' + modeKey;

  let records = await hub.save.get('rekorde', null); // { normal: 37, schwer: 12 }
  if (!records || typeof records !== 'object') records = { normal: await hub.save.get('rekord', 0) };
  let bestLevel = await hub.save.get('bestes-level', 1);

  if (hub.mode === 'preview') ($('mode-note').textContent = 'Vorschau – nichts wird gespeichert.'), $('mode-note').classList.add('preview');
  else if (hub.mode === 'local') $('mode-note').textContent = 'Lokaler Modus – gespeichert wird nur in diesem Browser.';
  $('mode-note').hidden = hub.mode === 'live';
  $('where').textContent = hub.class ? hub.class.name : 'Sternenfänger';
  $('difficulty').textContent = mode.name;

  // Spielzustand
  let ship, things, sparks, score, lives, level, caught, hits, lostLife, running = false, paused = false, last = 0, spawn = 0, startedAt = 0, targetX = null;
  const keys = {};
  const unlocked = new Set();

  function reset() {
    ship = { x: W / 2, w: mode.ship };
    things = [];
    sparks = [];
    score = 0;
    lives = mode.lives;
    level = 1;
    caught = 0;
    hits = 0;
    lostLife = false;
    spawn = 0.6;
    targetX = null;
  }

  function unlock(id) {
    if (unlocked.has(id)) return;
    unlocked.add(id);
    hub.achievements.unlock(id).then((a) => a.new && toast(a.emoji + ' Erfolg: ' + a.title)).catch(() => {});
  }

  async function panel(text, focus = true) {
    $('message').textContent = text;
    $('record').textContent = String(records[modeKey] || 0);
    $('best-level').textContent = bestLevel + ' / ' + LEVELS;
    $('panel').hidden = false;
    $('pause').hidden = true;
    $('play').disabled = false;
    if (focus) $('play').focus({ preventScroll: true });
    try {
      const top = await hub.leaderboard.top(board, { limit: 5 });
      $('board').replaceChildren(...top.entries.map((e) =>
        el('li', { class: e.me ? 'hub-me' : '' }, el('span', { text: e.me ? e.name + ' (du)' : e.name }), el('b', { text: String(e.score) }))));
      $('board-empty').hidden = top.entries.length > 0;
      const list = await hub.achievements.list();
      $('achievements').replaceChildren(...list.map((a) =>
        el('li', { class: a.unlocked ? 'on' : '', title: a.description || a.title },
          el('span', { class: 'ach-emoji', 'aria-hidden': 'true', text: a.emoji }),
          el('span', { class: 'ach-text' }, el('strong', { text: a.title }), a.description ? el('small', { text: a.description }) : null),
          el('span', { class: a.unlocked ? 'hub-badge hub-ok' : 'hub-badge', text: a.unlocked ? 'geschafft' : 'offen' }))));
      $('ach-empty').hidden = list.length > 0;
    } catch (e) {
      $('board-empty').textContent = e.message;
      $('board-empty').hidden = false;
    }
  }

  async function gameOver() {
    running = false;
    const seconds = Math.round((performance.now() - startedAt) / 1000);
    const record = score > (records[modeKey] || 0);
    if (record) records[modeKey] = score;
    bestLevel = Math.max(bestLevel, level);
    draw();
    $('save-state').textContent = hub.mode === 'preview' ? 'Vorschau – nichts wird gespeichert.' : 'Speichert …';
    panel('Spiel vorbei – ' + score + (score === 1 ? ' Punkt' : ' Punkte') + (record && score > 0 ? ' · neuer Rekord! 🎉' : '') + ' · Level ' + level);
    $('live').textContent = 'Spiel vorbei. ' + score + ' Punkte.';
    try {
      await Promise.all([
        hub.save.set('rekorde', records),
        hub.save.set('bestes-level', bestLevel),
        hub.leaderboard.submit(board, score),
        hub.progress.set(bestLevel / LEVELS, { label: 'Level ' + bestLevel + ' von ' + LEVELS + ' erreicht' }),
        hub.results.add({ title: 'Spielrunde (' + mode.name + ')', score, details: { punkte: score, level, sterne: caught, meteore: hits, sekunden: seconds, schwierigkeit: mode.name } }),
      ]);
      if (hub.mode !== 'preview') $('save-state').textContent = 'Gespeichert ✓';
      panel($('message').textContent, false);
    } catch (e) {
      $('save-state').textContent = 'Nicht gespeichert: ' + e.message;
    }
  }

  function loseLife() {
    lives--;
    lostLife = true;
    if (lives <= 0) gameOver();
  }

  function update(dt) {
    const speed = 420;
    if (keys.ArrowLeft || keys.a) (ship.x -= speed * dt), (targetX = null);
    if (keys.ArrowRight || keys.d) (ship.x += speed * dt), (targetX = null);
    if (targetX !== null) ship.x += (targetX - ship.x) * Math.min(1, dt * 18);
    ship.x = Math.max(ship.w / 2, Math.min(W - ship.w / 2, ship.x));

    const pace = mode.speed * (1 + (level - 1) * 0.12);
    spawn -= dt;
    if (spawn <= 0) {
      const bad = Math.random() < mode.meteors + (level - 1) * 0.015;
      things.push({ x: 24 + Math.random() * (W - 48), y: -24, v: 170 * pace * (0.85 + Math.random() * 0.45), bad, r: bad ? 15 + Math.random() * 6 : 15, spin: Math.random() * 6 });
      spawn = Math.max(0.3, 0.9 - level * 0.05) / Math.sqrt(mode.speed);
    }
    const shipY = H - 46;
    for (const t of things) {
      t.y += t.v * dt;
      t.spin += dt * (t.bad ? 1 : 2.5);
      const inCatch = t.y + t.r > shipY && t.y - t.r < shipY + 14 && Math.abs(t.x - ship.x) < ship.w / 2 + t.r * 0.6;
      if (inCatch) {
        t.gone = true;
        if (t.bad) {
          hits++;
          loseLife();
        } else {
          score++;
          caught++;
          if (caught === 1) unlock('erster-stern');
          if (score === 100) unlock('hundert');
          if (!still.matches) for (let i = 0; i < 8; i++) sparks.push({ x: t.x, y: shipY, vx: (Math.random() - 0.5) * 220, vy: -Math.random() * 220, life: 0.5 });
        }
      } else if (t.y - t.r > H) {
        t.gone = true;
        if (!t.bad) loseLife();
      }
    }
    things = things.filter((t) => !t.gone);
    for (const p of sparks) (p.x += p.vx * dt), (p.y += p.vy * dt), (p.vy += 500 * dt), (p.life -= dt);
    sparks = sparks.filter((p) => p.life > 0);

    const newLevel = Math.min(LEVELS, 1 + Math.floor(score / STARS_PER_LEVEL));
    if (newLevel > level) {
      level = newLevel;
      $('live').textContent = 'Level ' + level;
      if (level >= 3 && !lostLife) unlock('unberuehrt');
      if (level >= 5) unlock('level-5');
      if (level >= LEVELS) unlock('level-10');
    }
  }

  function draw(dt = 0) {
    ctx.clearRect(0, 0, W, H);
    // Sternenhimmel im Hintergrund (bleibt stehen, wenn weniger Bewegung gewünscht ist)
    ctx.fillStyle = 'rgba(255,255,255,.55)';
    for (const s of backdrop) {
      if (running && !paused && !still.matches) s.y = (s.y + s.v * dt) % H;
      ctx.fillRect(s.x, s.y, s.r, s.r);
    }
    for (const t of things) (t.bad ? drawMeteor(t) : drawStar(t.x, t.y, t.r, t.spin));
    for (const p of sparks) {
      ctx.fillStyle = 'rgba(255, 210, 63,' + Math.max(0, p.life * 2) + ')';
      ctx.fillRect(p.x, p.y, 3, 3);
    }
    // die Schale
    const y = H - 46;
    ctx.fillStyle = '#ffd23f';
    ctx.beginPath();
    ctx.roundRect(ship.x - ship.w / 2, y, ship.w, 14, 7);
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 210, 63, .35)';
    ctx.fillRect(ship.x - ship.w / 2 + 6, y + 16, ship.w - 12, 3);
    // Anzeige
    ctx.fillStyle = '#f4f5f2';
    ctx.font = '700 20px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(String(score), 16, 16);
    ctx.font = '600 13px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(244,245,242,.7)';
    ctx.fillText('Level ' + level, 16, 42);
    for (let i = 0; i < mode.lives; i++) drawHeart(W - 24 - i * 26, 18, 18, i < lives);
  }

  function frame(now) {
    if (!running) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!paused) update(dt);
    if (running) draw(paused ? 0 : dt);
    if (paused) {
      ctx.fillStyle = 'rgba(10,11,12,.6)';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#f4f5f2';
      ctx.font = '700 28px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Pause', W / 2, H / 2 - 20);
      ctx.font = '500 15px system-ui, sans-serif';
      ctx.fillText('Tippen oder P drücken', W / 2, H / 2 + 18);
    }
    requestAnimationFrame(frame);
  }

  function setPaused(p) {
    if (!running) return;
    paused = p;
    $('pause').setAttribute('aria-label', p ? 'Weiter' : 'Pause');
    $('pause').firstElementChild.textContent = p ? '▶' : '❚❚';
    $('live').textContent = p ? 'Pause' : '';
  }

  // Steuerung: Finger/Maus zeigt, wohin die Schale soll; Pfeiltasten (oder A/D) schieben sie.
  function pointer(event) {
    const rect = canvas.getBoundingClientRect();
    targetX = ((event.clientX - rect.left) / rect.width) * W;
  }
  canvas.addEventListener('pointerdown', (e) => {
    if (paused) return setPaused(false);
    canvas.setPointerCapture(e.pointerId);
    pointer(e);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse' || e.buttons) pointer(e);
  });
  addEventListener('keydown', (e) => {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (running && (k === 'p' || k === 'Escape')) return setPaused(!paused);
    if (['ArrowLeft', 'ArrowRight', 'a', 'd'].includes(k)) {
      keys[k] = true;
      if (running) e.preventDefault();
    }
  });
  addEventListener('keyup', (e) => (keys[e.key.length === 1 ? e.key.toLowerCase() : e.key] = false));
  // Wer wegschaut (anderer Tab, Fenster verlassen), pausiert automatisch.
  document.addEventListener('visibilitychange', () => document.hidden && setPaused(true));
  addEventListener('blur', () => setPaused(true));
  $('pause').addEventListener('click', () => setPaused(!paused));

  $('play').addEventListener('click', () => {
    reset();
    $('panel').hidden = true;
    $('pause').hidden = false;
    $('save-state').textContent = '';
    running = true;
    paused = false;
    startedAt = performance.now();
    last = performance.now();
    canvas.focus();
    requestAnimationFrame(frame);
  });

  addEventListener('resize', () => {
    resize();
    if (!running) draw();
  });
  resize();
  reset();
  draw();
  panel('Fang die Sterne, weich den Meteoriten aus! Alle ' + STARS_PER_LEVEL + ' Sterne steigt das Level.', false);
}
