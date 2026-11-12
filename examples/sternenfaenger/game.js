// Sternenfänger - zeigt: Bestenliste und gespeicherter Rekord pro Konto.

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const W = canvas.width;
const H = canvas.height;
const $ = (id) => document.getElementById(id);

Hub.connect().then(async (hub) => {
  let best = await hub.save.get('rekord', 0);
  let ship, things, score, lives, running = false, last = 0, spawn = 0;
  const keys = {};

  function reset() {
    ship = { x: W / 2, w: 70 };
    things = [];
    score = 0;
    lives = 3;
    spawn = 0;
  }

  async function showPanel(text) {
    $('message').textContent = text;
    $('best').textContent = 'Dein Rekord: ' + best;
    $('panel').hidden = false;
    const top = await hub.leaderboard.top('punkte', { limit: 5 });
    $('board').replaceChildren(...top.entries.map((e) => {
      const li = document.createElement('li');
      li.textContent = e.name + ' – ' + e.score;
      if (e.me) li.className = 'me';
      return li;
    }));
    if (!top.entries.length) $('board').textContent = 'Noch niemand – sei die oder der Erste!';
  }

  async function gameOver() {
    running = false;
    if (score > best) {
      best = score;
      await hub.save.set('rekord', best);
    }
    await hub.leaderboard.submit('punkte', score);
    await hub.results.add({ title: 'Spielrunde', score: score });
    showPanel('Spiel vorbei – ' + score + ' Punkte' + (score === best && score > 0 ? ' · neuer Rekord!' : ''));
  }

  function update(dt) {
    if (keys.ArrowLeft) ship.x -= 420 * dt;
    if (keys.ArrowRight) ship.x += 420 * dt;
    ship.x = Math.max(ship.w / 2, Math.min(W - ship.w / 2, ship.x));
    spawn -= dt;
    if (spawn <= 0) {
      const speed = 170 + score * 4;
      things.push({ x: 20 + Math.random() * (W - 40), y: -20, v: speed * (0.8 + Math.random() * 0.5), bad: Math.random() < 0.28 });
      spawn = Math.max(0.28, 0.85 - score * 0.012);
    }
    for (const t of things) {
      t.y += t.v * dt;
      const caught = t.y > H - 60 && t.y < H - 25 && Math.abs(t.x - ship.x) < ship.w / 2 + 10;
      if (caught) {
        t.gone = true;
        if (t.bad) lives--;
        else score++;
      } else if (t.y > H + 20) {
        t.gone = true;
        if (!t.bad) lives--;
      }
    }
    things = things.filter((t) => !t.gone);
    if (lives <= 0) gameOver();
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    ctx.font = '28px system-ui';
    ctx.textAlign = 'center';
    for (const t of things) ctx.fillText(t.bad ? '☄️' : '⭐', t.x, t.y);
    ctx.fillStyle = '#ffd43b';
    ctx.beginPath();
    ctx.roundRect(ship.x - ship.w / 2, H - 46, ship.w, 16, 8);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = '18px system-ui';
    ctx.textAlign = 'left';
    ctx.fillText('Punkte: ' + score, 12, 26);
    ctx.textAlign = 'right';
    ctx.fillText('❤️'.repeat(Math.max(0, lives)), W - 12, 26);
  }

  function frame(now) {
    if (!running) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    update(dt);
    draw();
    requestAnimationFrame(frame);
  }

  function pointer(event) {
    const rect = canvas.getBoundingClientRect();
    ship.x = ((event.clientX - rect.left) / rect.width) * W;
  }
  canvas.addEventListener('pointermove', pointer);
  canvas.addEventListener('pointerdown', pointer);
  addEventListener('keydown', (e) => (keys[e.key] = true));
  addEventListener('keyup', (e) => (keys[e.key] = false));

  $('play').onclick = () => {
    reset();
    $('panel').hidden = true;
    running = true;
    last = performance.now();
    requestAnimationFrame(frame);
  };

  reset();
  draw();
  showPanel('Fang die Sterne, weich den Meteoriten aus!');
});
