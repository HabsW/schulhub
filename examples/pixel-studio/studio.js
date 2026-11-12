// Pixel-Studio - zeigt: mehrere Spielstände pro Konto (drei Bilder), automatisches Speichern.

const SIZE = 16;
const COLORS = ['#ffffff', '#2b2118', '#e03131', '#f08c00', '#ffd43b', '#2f9e44', '#1c7ed6', '#7048e8', '#f783ac', '#8d6e63'];
const $ = (id) => document.getElementById(id);

Hub.connect().then(async (hub) => {
  $('who').textContent = 'Bilder von ' + hub.user.name;
  let slot = 1;
  let color = 1;
  let pixels = [];
  let timer = null;
  let painting = false;

  const cells = [];
  for (let i = 0; i < SIZE * SIZE; i++) {
    const cell = document.createElement('div');
    cell.dataset.i = i;
    $('grid').appendChild(cell);
    cells.push(cell);
  }
  const render = () => cells.forEach((c, i) => (c.style.background = COLORS[pixels[i]] || COLORS[0]));

  async function load(n) {
    slot = n;
    [...$('slots').children].forEach((b, i) => b.classList.toggle('on', i + 1 === n));
    const saved = await hub.save.get('bild-' + n, null);
    pixels = Array.isArray(saved) && saved.length === SIZE * SIZE ? saved : new Array(SIZE * SIZE).fill(0);
    render();
    $('state').textContent = '';
  }

  function changed() {
    $('state').textContent = 'Speichert …';
    clearTimeout(timer);
    // nicht bei jedem Pixel speichern, sondern kurz nach dem letzten Strich
    timer = setTimeout(async () => {
      try {
        await hub.save.set('bild-' + slot, pixels);
        $('state').textContent = 'Gespeichert ✓';
      } catch (e) {
        $('state').textContent = e.message;
      }
    }, 600);
  }

  function paint(event) {
    const el = document.elementFromPoint(event.clientX, event.clientY);
    if (!el || el.dataset.i === undefined) return;
    const i = Number(el.dataset.i);
    if (pixels[i] === color) return;
    pixels[i] = color;
    el.style.background = COLORS[color];
    changed();
  }
  $('grid').addEventListener('pointerdown', (e) => { painting = true; paint(e); });
  $('grid').addEventListener('pointermove', (e) => painting && paint(e));
  addEventListener('pointerup', () => (painting = false));

  for (let n = 1; n <= 3; n++) {
    const b = document.createElement('button');
    b.textContent = 'Bild ' + n;
    b.onclick = () => load(n);
    $('slots').appendChild(b);
  }
  COLORS.forEach((c, i) => {
    const b = document.createElement('button');
    b.style.background = c;
    b.title = 'Farbe ' + (i + 1);
    b.onclick = () => {
      color = i;
      [...$('palette').children].forEach((x, j) => x.classList.toggle('on', j === i));
    };
    if (i === color) b.className = 'on';
    $('palette').appendChild(b);
  });
  $('clear').onclick = () => {
    pixels = new Array(SIZE * SIZE).fill(0);
    render();
    changed();
  };

  load(1);
});
