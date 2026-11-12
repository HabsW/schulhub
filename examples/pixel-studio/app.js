// Pixel-Studio – Beispiel-App für den SchulHub (SDK 2).
//
// Zeigt:  hub.save          drei Leinwände pro Konto, automatisch gespeichert
//         hub.files         "Als Bild speichern": ein echtes PNG pro Leinwand, und die Galerie daraus
//         hub.progress      wie viele Bilder schon in der Galerie sind
//         hub.achievements  Erfolge aus schulhub.json
'use strict';

const SIZE = 16;
const SLOTS = 3;
const COLORS = [
  ['#ffffff', 'Weiß'], ['#2b2118', 'Schwarz'], ['#e03131', 'Rot'], ['#f08c00', 'Orange'], ['#ffd43b', 'Gelb'],
  ['#2f9e44', 'Grün'], ['#1c7ed6', 'Blau'], ['#7048e8', 'Lila'], ['#f783ac', 'Rosa'], ['#8d6e63', 'Braun'],
];
const EXPORT_SCALE = 20; // das PNG wird 320 × 320 Pixel groß

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
const firstName = (name) => (/^(Herr|Frau)\s/.test(name) ? name : name.split(' ')[0]);
const timeText = (ts) => new Date(ts).toLocaleString('de-DE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
let toastTimer = null;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}
const blank = () => new Array(SIZE * SIZE).fill(0);

// ---------- die App ----------
Hub.connect().then(start).catch((e) => {
  $('who').textContent = 'Keine Verbindung zum Hub: ' + e.message;
});

async function start(hub) {
  if (hub.mode === 'preview') ($('mode-note').textContent = 'Vorschau – nichts wird gespeichert.'), $('mode-note').classList.add('preview');
  else if (hub.mode === 'local') $('mode-note').textContent = 'Lokaler Modus – gespeichert wird nur in diesem Browser.';
  $('mode-note').hidden = hub.mode === 'live';
  $('who').textContent = 'Bilder von ' + firstName(hub.user.name);

  const canvas = $('canvas');
  const ctx = canvas.getContext('2d');
  let slot = 1;
  let color = 1;
  let tool = 'stift';
  let pixels = blank();
  let undo = [];
  let saveTimer = null;
  let dirty = false; // ungespeicherte Änderung an der aktuellen Leinwand
  let stroke = null; // { last: index } während gemalt wird
  let cursor = { x: 0, y: 0, visible: false };
  let urls = []; // Objekt-URLs der Galerie, werden wieder freigegeben
  const unlocked = new Set();

  function unlock(id) {
    if (unlocked.has(id)) return;
    unlocked.add(id);
    hub.achievements.unlock(id).then((a) => {
      if (a.new) toast(a.emoji + ' Erfolg: ' + a.title);
      return loadAchievements();
    }).catch(() => {});
  }

  // ----- zeichnen -----
  function resize() {
    const css = canvas.clientWidth;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    canvas.width = Math.round(css * dpr);
    canvas.height = Math.round(css * dpr);
    render();
  }
  function render() {
    const cell = canvas.width / SIZE;
    for (let i = 0; i < pixels.length; i++) {
      ctx.fillStyle = COLORS[pixels[i]] ? COLORS[pixels[i]][0] : COLORS[0][0];
      ctx.fillRect((i % SIZE) * cell, Math.floor(i / SIZE) * cell, Math.ceil(cell), Math.ceil(cell));
    }
    ctx.strokeStyle = 'rgba(0, 0, 0, .08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let n = 1; n < SIZE; n++) {
      const p = Math.round(n * cell) + 0.5;
      ctx.moveTo(p, 0);
      ctx.lineTo(p, canvas.height);
      ctx.moveTo(0, p);
      ctx.lineTo(canvas.width, p);
    }
    ctx.stroke();
    if (cursor.visible) {
      ctx.strokeStyle = '#7048e8';
      ctx.lineWidth = Math.max(2, cell / 8);
      ctx.strokeRect(cursor.x * cell + 1, cursor.y * cell + 1, cell - 2, cell - 2);
    }
  }

  // ----- speichern -----
  function changed() {
    $('state').textContent = hub.mode === 'preview' ? 'Vorschau – nichts wird gespeichert.' : 'Speichert …';
    dirty = true;
    clearTimeout(saveTimer);
    // nicht bei jedem Pixel speichern, sondern kurz nach dem letzten Strich
    saveTimer = setTimeout(flush, 600);
    if (new Set(pixels).size === COLORS.length) unlock('farbenfroh');
  }
  /** Die aktuelle Leinwand jetzt speichern (auch vor dem Wechsel zu einem anderen Bild). */
  async function flush() {
    clearTimeout(saveTimer);
    if (!dirty) return;
    dirty = false;
    try {
      await hub.save.set('bild-' + slot, pixels.slice());
      if (hub.mode !== 'preview') $('state').textContent = 'Gespeichert ✓';
    } catch (e) {
      $('state').textContent = 'Nicht gespeichert: ' + e.message;
    }
  }
  function remember() {
    undo.push(pixels.slice());
    if (undo.length > 30) undo.shift();
    $('undo').disabled = false;
  }

  async function load(n) {
    await flush();
    slot = n;
    for (const b of $('slots').children) b.setAttribute('aria-pressed', String(Number(b.dataset.slot) === n));
    const saved = await hub.save.get('bild-' + n, null);
    pixels = Array.isArray(saved) && saved.length === SIZE * SIZE ? saved.map((v) => (Number.isInteger(v) && COLORS[v] ? v : 0)) : blank();
    undo = [];
    $('undo').disabled = true;
    $('state').textContent = '';
    render();
  }

  // ----- Werkzeuge -----
  function apply(i) {
    if (tool === 'eimer') return fill(i);
    const value = tool === 'radierer' ? 0 : color;
    if (pixels[i] === value) return;
    pixels[i] = value;
    render();
    changed();
  }
  function fill(start) {
    const from = pixels[start];
    if (from === color) return;
    remember();
    const todo = [start];
    while (todo.length) {
      const i = todo.pop();
      if (pixels[i] !== from) continue;
      pixels[i] = color;
      const x = i % SIZE;
      if (x > 0) todo.push(i - 1);
      if (x < SIZE - 1) todo.push(i + 1);
      if (i >= SIZE) todo.push(i - SIZE);
      if (i < SIZE * (SIZE - 1)) todo.push(i + SIZE);
    }
    render();
    changed();
    unlock('ausgemalt');
  }
  /** Alle Zellen auf der Linie zwischen zwei Zellen – damit schnelle Striche keine Lücken haben. */
  function line(a, b) {
    let [x0, y0, x1, y1] = [a % SIZE, Math.floor(a / SIZE), b % SIZE, Math.floor(b / SIZE)];
    const out = [];
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      out.push(y0 * SIZE + x0);
      if (x0 === x1 && y0 === y1) return out;
      const e2 = 2 * err;
      if (e2 >= dy) (err += dy), (x0 += sx);
      if (e2 <= dx) (err += dx), (y0 += sy);
    }
  }
  function cellAt(event) {
    const r = canvas.getBoundingClientRect();
    const x = Math.floor(((event.clientX - r.left) / r.width) * SIZE);
    const y = Math.floor(((event.clientY - r.top) / r.height) * SIZE);
    return x >= 0 && y >= 0 && x < SIZE && y < SIZE ? y * SIZE + x : -1;
  }

  canvas.addEventListener('pointerdown', (e) => {
    const i = cellAt(e);
    if (i < 0) return;
    cursor.visible = false;
    canvas.setPointerCapture(e.pointerId);
    if (tool === 'eimer') return fill(i);
    remember();
    stroke = { last: i };
    apply(i);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!stroke) return;
    const i = cellAt(e);
    if (i < 0 || i === stroke.last) return;
    for (const c of line(stroke.last, i)) apply(c);
    stroke.last = i;
  });
  const endStroke = () => (stroke = null);
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);

  // Tastatur: Cursor mit Pfeiltasten, Leertaste/Enter malt
  canvas.addEventListener('keydown', (e) => {
    const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (moves[e.key]) {
      e.preventDefault();
      cursor.x = Math.max(0, Math.min(SIZE - 1, cursor.x + moves[e.key][0]));
      cursor.y = Math.max(0, Math.min(SIZE - 1, cursor.y + moves[e.key][1]));
      cursor.visible = true;
      render();
      $('cursor-live').textContent = 'Zeile ' + (cursor.y + 1) + ', Spalte ' + (cursor.x + 1) + ': ' + COLORS[pixels[cursor.y * SIZE + cursor.x]][1];
    } else if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      cursor.visible = true;
      if (tool !== 'eimer') remember();
      apply(cursor.y * SIZE + cursor.x);
    }
  });
  canvas.addEventListener('focus', () => {
    cursor.visible = canvas.matches(':focus-visible');
    render();
  });
  canvas.addEventListener('blur', () => {
    cursor.visible = false;
    render();
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      $('undo').click();
    }
  });

  // ----- Bedienelemente -----
  for (let n = 1; n <= SLOTS; n++) {
    $('slots').append(el('button', { type: 'button', class: 'slot', 'data-slot': n, 'aria-pressed': n === 1 ? 'true' : 'false', text: 'Bild ' + n }));
  }
  $('slots').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-slot]');
    if (b) load(Number(b.dataset.slot));
  });

  COLORS.forEach(([hex, name], i) => {
    const b = el('button', { type: 'button', class: 'swatch', role: 'radio', 'aria-checked': i === color ? 'true' : 'false', 'aria-label': name, title: name, 'data-color': i });
    b.style.setProperty('--swatch', hex); // über das Style-Objekt, nicht als style="…"
    $('palette').append(b);
  });
  $('palette').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-color]');
    if (!b) return;
    color = Number(b.dataset.color);
    for (const s of $('palette').children) s.setAttribute('aria-checked', String(s === b));
    if (tool === 'radierer') setTool('stift');
  });
  function setTool(t) {
    tool = t;
    for (const b of $('toolbar').children) b.setAttribute('aria-checked', String(b.dataset.tool === t));
  }
  $('toolbar').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tool]');
    if (b) setTool(b.dataset.tool);
  });
  $('undo').addEventListener('click', () => {
    if (!undo.length) return;
    pixels = undo.pop();
    $('undo').disabled = undo.length === 0;
    render();
    changed();
  });
  $('clear').addEventListener('click', () => {
    if (pixels.every((p) => p === 0)) return;
    remember();
    pixels = blank();
    render();
    changed();
    $('state').textContent = 'Leinwand geleert – „Rückgängig“ holt das Bild zurück.';
  });

  // ----- Als Bild speichern + Galerie (hub.files) -----
  $('export').addEventListener('click', async () => {
    const out = document.createElement('canvas');
    out.width = out.height = SIZE * EXPORT_SCALE;
    const octx = out.getContext('2d');
    pixels.forEach((p, i) => {
      octx.fillStyle = COLORS[p][0];
      octx.fillRect((i % SIZE) * EXPORT_SCALE, Math.floor(i / SIZE) * EXPORT_SCALE, EXPORT_SCALE, EXPORT_SCALE);
    });
    $('export').disabled = true;
    $('state').textContent = 'Speichert das Bild …';
    try {
      const blob = await new Promise((resolve) => out.toBlob(resolve, 'image/png'));
      await hub.files.put('bild-' + slot, blob, { type: 'image/png' });
      $('state').textContent = hub.mode === 'preview' ? 'Vorschau – das Bild verschwindet wieder.' : 'Bild ' + slot + ' ist in der Galerie ✓';
      const count = await loadGallery();
      unlock('erstes-bild');
      if (count >= SLOTS) unlock('volle-galerie');
      hub.progress.set(Math.min(1, count / SLOTS), { label: count + ' von ' + SLOTS + ' Bildern in der Galerie' }).catch(() => {});
    } catch (e) {
      $('state').textContent = 'Nicht gespeichert: ' + e.message;
    } finally {
      $('export').disabled = false;
    }
  });

  async function loadGallery() {
    const files = (await hub.files.list()).filter((f) => /^bild-[1-9]$/.test(f.name) && f.type === 'image/png');
    const items = [];
    for (const f of files) {
      const blob = await hub.files.get(f.name);
      if (blob) items.push({ f, url: URL.createObjectURL(blob) });
    }
    urls.forEach((u) => URL.revokeObjectURL(u));
    urls = items.map((x) => x.url);
    $('gallery').replaceChildren(...items.map(({ f, url }) => {
      const n = f.name.slice(5);
      return el('li', { class: 'shot' },
        el('img', { src: url, alt: 'Bild ' + n, width: 160, height: 160 }),
        el('div', { class: 'shot-meta' }, el('strong', { text: 'Bild ' + n }), el('small', { class: 'hub-muted', text: f.updatedAt ? timeText(f.updatedAt) : '' })),
        el('div', { class: 'shot-actions' },
          el('button', { type: 'button', class: 'hub-btn hub-quiet', 'data-open': n, text: 'Bearbeiten' }),
          el('button', { type: 'button', class: 'hub-btn hub-quiet danger', 'data-remove': f.name, 'aria-label': 'Bild ' + n + ' aus der Galerie löschen', text: 'Löschen' })));
    }));
    $('gallery-empty').hidden = items.length > 0;
    $('gallery-count').textContent = items.length ? items.length + ' von ' + SLOTS : '';
    return items.length;
  }
  $('gallery').addEventListener('click', async (e) => {
    const open = e.target.closest('button[data-open]');
    const remove = e.target.closest('button[data-remove]');
    if (open) {
      await load(Number(open.dataset.open));
      canvas.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
    if (remove && confirm('Das Bild aus der Galerie löschen? Die Leinwand selbst bleibt erhalten.')) {
      try {
        await hub.files.remove(remove.dataset.remove);
        const count = await loadGallery();
        hub.progress.set(count / SLOTS, { label: count + ' von ' + SLOTS + ' Bildern in der Galerie' }).catch(() => {});
        toast('Bild gelöscht');
      } catch (err) {
        toast('Nicht gelöscht: ' + err.message);
      }
    }
  });

  async function loadAchievements() {
    const list = await hub.achievements.list();
    $('achievements').replaceChildren(...list.map((a) =>
      el('li', { class: a.unlocked ? 'on' : '' },
        el('span', { class: 'ach-emoji', 'aria-hidden': 'true', text: a.emoji }),
        el('span', { class: 'ach-text' }, el('strong', { text: a.title }), a.description ? el('small', { text: a.description }) : null),
        el('span', { class: a.unlocked ? 'hub-badge hub-ok' : 'hub-badge', text: a.unlocked ? 'geschafft' : 'offen' }))));
    $('ach-empty').hidden = list.length > 0;
  }

  addEventListener('resize', resize);
  addEventListener('pagehide', flush); // wer die App schließt, verliert den letzten Strich nicht
  resize();
  await load(1);
  try {
    await Promise.all([loadGallery(), loadAchievements()]);
  } catch (e) {
    $('gallery-empty').textContent = e.message;
    $('gallery-empty').hidden = false;
  }
}
