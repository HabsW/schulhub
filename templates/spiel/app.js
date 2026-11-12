// Apfelernte – ein kleines Spiel auf einer Zeichenfläche (Canvas).
// Zeigt: Bestenliste (hub.leaderboard), Ergebnisse, Erfolge und eine
// Einstellung der Lehrkraft (Sekunden pro Runde).
//
// Gerechnet wird in einem festen Feld von 300 x 400 Einheiten. Die
// Zeichenfläche wird nur beim Zeichnen auf die echte Größe skaliert.

const W = 300;
const H = 400;
const KORB_Y = H - 36; // Oberkante des Korbs

const $ = (id) => document.getElementById(id);
const feld = $('feld');
const c = feld.getContext('2d');

function meldung(text) {
  const t = document.createElement('div');
  t.className = 'hub-toast';
  t.setAttribute('role', 'status');
  t.textContent = text;
  document.body.append(t);
  setTimeout(() => t.remove(), 3200);
}

Hub.connect().then(async (hub) => {
  const SEKUNDEN = await hub.settings.get('sekunden', 30);

  let korb = { x: W / 2, breite: 64 };
  let aepfel = [];
  let punkte = 0;
  let rest = SEKUNDEN;
  let naechster = 0;
  let gold = false;
  let laeuft = false;
  let zuletzt = 0;
  let zielX = null; // wohin Maus oder Finger zeigen
  const tasten = { links: false, rechts: false };
  let skala = 1;

  // Die Zeichenfläche scharf auf jedem Bildschirm (auch mit hoher Pixeldichte)
  function groesse() {
    const dpr = window.devicePixelRatio || 1;
    feld.width = Math.round(feld.clientWidth * dpr);
    feld.height = Math.round(feld.clientHeight * dpr);
    skala = feld.width / W;
    zeichne();
  }

  function zeichne() {
    c.setTransform(skala, 0, 0, skala, 0, 0);
    c.clearRect(0, 0, W, H);
    c.fillStyle = '#3d5a2a'; // Wiese
    c.fillRect(0, H - 14, W, 14);
    for (const a of aepfel) {
      c.fillStyle = a.gold ? '#f5b83d' : '#e5484d';
      c.beginPath();
      c.arc(a.x, a.y, a.r, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = '#4cc76e'; // Blatt
      c.beginPath();
      c.ellipse(a.x + 4, a.y - a.r - 1, 5, 2.5, -0.5, 0, Math.PI * 2);
      c.fill();
    }
    const b = korb.breite;
    c.fillStyle = '#b07a3b';
    c.beginPath();
    c.moveTo(korb.x - b / 2, KORB_Y);
    c.lineTo(korb.x + b / 2, KORB_Y);
    c.lineTo(korb.x + b / 2 - 9, KORB_Y + 22);
    c.lineTo(korb.x - b / 2 + 9, KORB_Y + 22);
    c.closePath();
    c.fill();
  }

  function zeigeWerte() {
    $('punkte').textContent = punkte === 1 ? '1 Punkt' : punkte + ' Punkte';
    $('zeit').textContent = Math.ceil(Math.max(rest, 0)) + ' s';
  }

  function schritt(dt) {
    rest -= dt;
    // Korb: Pfeiltasten oder Maus/Finger
    if (tasten.links) korb.x -= 280 * dt;
    if (tasten.rechts) korb.x += 280 * dt;
    if (zielX !== null && !tasten.links && !tasten.rechts) korb.x += (zielX - korb.x) * Math.min(1, dt * 14);
    korb.x = Math.max(korb.breite / 2, Math.min(W - korb.breite / 2, korb.x));

    // Neue Äpfel, mit der Zeit immer schneller
    naechster -= dt;
    if (naechster <= 0) {
      const tempo = 95 + Math.random() * 55 + (SEKUNDEN - rest) * 3;
      aepfel.push({ x: 14 + Math.random() * (W - 28), y: -14, r: 11, v: tempo, gold: Math.random() < 0.08 });
      naechster = 0.45 + Math.random() * 0.45;
    }
    for (const a of aepfel) a.y += a.v * dt;

    // Gefangen? Der Apfel berührt die Oberkante des Korbs.
    aepfel = aepfel.filter((a) => {
      const imKorb = a.y + a.r >= KORB_Y && a.y - a.r <= KORB_Y + 12 && Math.abs(a.x - korb.x) <= korb.breite / 2;
      if (imKorb) {
        punkte += a.gold ? 3 : 1;
        if (a.gold) gold = true;
        return false;
      }
      return a.y - a.r < H; // unten raus: weg
    });
    if (rest <= 0) ende();
  }

  function bild(t) {
    if (!laeuft) return;
    const dt = Math.min(0.05, (t - zuletzt) / 1000); // nach einer Pause nicht springen
    zuletzt = t;
    schritt(dt);
    zeichne();
    zeigeWerte();
    if (laeuft) requestAnimationFrame(bild);
  }

  function start() {
    korb = { x: W / 2, breite: 64 };
    aepfel = [];
    punkte = 0;
    rest = SEKUNDEN;
    naechster = 0;
    gold = false;
    laeuft = true;
    $('schild').hidden = true;
    zeigeWerte();
    feld.focus();
    zuletzt = performance.now();
    requestAnimationFrame(bild);
  }

  async function freischalten(id) {
    const a = await hub.achievements.unlock(id);
    if (a.new) meldung(a.emoji + ' Neuer Erfolg: ' + a.title);
  }

  async function ende() {
    laeuft = false;
    $('schild-titel').textContent = punkte === 1 ? '1 Punkt' : punkte + ' Punkte';
    $('schild-text').textContent = 'Runde vorbei.';
    $('start').textContent = 'Nochmal';
    $('schild').hidden = false;
    $('start').focus();
    try {
      const r = await hub.leaderboard.submit('punkte', punkte); // es zählt der beste Wert
      $('schild-text').textContent = r.improved ? 'Neuer Rekord!' : 'Dein Rekord: ' + r.best + ' Punkte';
      await hub.results.add({ title: 'Spielrunde', score: punkte });
      await freischalten('erste-runde');
      if (punkte >= 10) await freischalten('zehn');
      if (punkte >= 30) await freischalten('dreissig');
      if (gold) await freischalten('gold');
      await zeigeBestenliste();
    } catch (fehler) {
      meldung('Nicht gespeichert: ' + fehler.message);
    }
  }

  async function zeigeBestenliste() {
    const top = await hub.leaderboard.top('punkte', { limit: 5 });
    $('bestenliste').replaceChildren(...top.entries.map((e) => {
      const li = document.createElement('li');
      if (e.me) li.className = 'hub-me';
      const name = document.createElement('span');
      name.textContent = e.name;
      const wert = document.createElement('b');
      wert.textContent = e.score;
      li.append(name, wert);
      return li;
    }));
    $('leer').hidden = top.entries.length > 0;
  }

  // ---------- Steuerung ----------
  const taste = (e, an) => {
    if (e.key === 'ArrowLeft' || e.key === 'a') tasten.links = an;
    else if (e.key === 'ArrowRight' || e.key === 'd') tasten.rechts = an;
    else return;
    if (laeuft) e.preventDefault(); // die Seite soll nicht mitscrollen
  };
  document.addEventListener('keydown', (e) => taste(e, true));
  document.addEventListener('keyup', (e) => taste(e, false));
  const zeigen = (e) => {
    const r = feld.getBoundingClientRect();
    zielX = ((e.clientX - r.left) / r.width) * W;
  };
  feld.addEventListener('pointermove', zeigen);
  feld.addEventListener('pointerdown', zeigen);
  feld.addEventListener('pointerleave', () => { zielX = null; });
  $('start').addEventListener('click', start);
  window.addEventListener('resize', groesse);

  groesse();
  zeigeWerte();
  $('start').disabled = false; // bereit
  zeigeBestenliste().catch(() => {});
});
