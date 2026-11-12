// Spielwiese – ein Knopf für jede Funktion des SDK.
// Jeder Knopf hat ein data-aufruf="…". In AUFRUFE steht, was dabei passiert.
// Das Ergebnis (oder der Fehler) erscheint unter den Knöpfen derselben Karte.

const $ = (id) => document.getElementById(id);

/** Ein kleines Bild auf einer Zeichenfläche malen und als PNG-Blob liefern. */
function malBild() {
  const leinwand = document.createElement('canvas');
  leinwand.width = 64;
  leinwand.height = 64;
  const c = leinwand.getContext('2d');
  c.fillStyle = '#2ec4b6';
  c.fillRect(0, 0, 64, 64);
  c.fillStyle = '#ffffff';
  for (let i = 0; i < 12; i++) {
    c.beginPath();
    c.arc(Math.random() * 64, Math.random() * 64, 2 + Math.random() * 5, 0, Math.PI * 2);
    c.fill();
  }
  return new Promise((fertig) => leinwand.toBlob(fertig, 'image/png'));
}

/** Ergebnis lesbar machen: JSON eingerückt, Blobs mit Typ und Größe. */
async function lesbar(wert) {
  if (wert instanceof Blob) {
    const kopf = 'Blob (' + (wert.type || 'ohne Typ') + ', ' + wert.size + ' Bytes)';
    return wert.type.startsWith('text/') ? kopf + '\n' + (await wert.text()) : kopf;
  }
  if (wert === undefined) return 'undefined';
  return JSON.stringify(wert, null, 2);
}

Hub.connect().then((hub) => {
  const modus = { live: 'Im Hub', preview: 'Vorschau – nichts wird gespeichert', local: 'Lokal: Testmodus in diesem Browser' };
  $('modus').textContent = modus[hub.mode] || hub.mode;
  $('anteil').addEventListener('input', () => { $('anteil-text').textContent = $('anteil').value + ' %'; });

  let bildAdresse = null;

  const AUFRUFE = {
    wer: () => ({ mode: hub.mode, user: hub.user, class: hub.class, app: hub.app }),

    'save-set': async () => hub.save.set('zaehler', (await hub.save.get('zaehler', 0)) + 1),
    'save-get': () => hub.save.get('zaehler', 0),
    'save-keys': () => hub.save.keys(),
    'save-remove': () => hub.save.remove('zaehler'),

    'shared-set': () => hub.shared.set('nachricht', $('nachricht').value),
    'shared-get': () => hub.shared.get('nachricht'),
    'shared-keys': () => hub.shared.keys(),

    'class-get': () => hub.classData.get('wortliste', []),
    'class-set': () => hub.classData.set('wortliste', ['Hund', 'Katze']),
    'class-keys': () => hub.classData.keys(),

    'board-submit': () => hub.leaderboard.submit('punkte', Number($('punkte').value)),
    'board-top': () => hub.leaderboard.top('punkte', { limit: 5 }),

    'results-add': () => hub.results.add({ title: 'Versuch', score: 7, maxScore: 10, details: { versuch: 1, zeit: 12.5 } }),
    'results-mine': () => hub.results.mine({ limit: 5 }),

    'progress-set': () => {
      const wert = Number($('anteil').value) / 100;
      return hub.progress.set(wert, { label: $('anteil').value + ' %' });
    },
    'progress-get': () => hub.progress.get(),

    'ach-list': () => hub.achievements.list(),
    'ach-unlock': () => hub.achievements.unlock('ausprobiert'),
    'ach-secret': () => hub.achievements.unlock('geheim'),
    'ach-unknown': () => hub.achievements.unlock('gibt-es-nicht'),

    'settings-all': () => hub.settings.all(),
    'settings-get': () => hub.settings.get('farbe', 'himmel'),

    'files-put': () => hub.files.put('notiz.txt', $('notiz').value, { type: 'text/plain' }),
    'files-get': () => hub.files.get('notiz.txt'),
    'files-bild': async () => hub.files.put('bild.png', await malBild()),
    'files-zeigen': async () => {
      const blob = await hub.files.get('bild.png');
      if (bildAdresse) URL.revokeObjectURL(bildAdresse);
      bildAdresse = blob ? URL.createObjectURL(blob) : null;
      $('bild').hidden = !blob;
      if (blob) $('bild').src = bildAdresse;
      return blob;
    },
    'files-list': () => hub.files.list(),
    'files-remove': () => hub.files.remove('notiz.txt'),

    room: () => hub.room('runde-1', { maxPlayers: 4 }),
  };

  document.addEventListener('click', async (event) => {
    const knopf = event.target.closest('[data-aufruf]');
    if (!knopf) return;
    const ausgabe = knopf.closest('section').querySelector('.ausgabe');
    const aufruf = knopf.textContent;
    ausgabe.classList.remove('fehler');
    ausgabe.textContent = '→ ' + aufruf + '\n…';
    try {
      const ergebnis = await AUFRUFE[knopf.dataset.aufruf]();
      ausgabe.textContent = '→ ' + aufruf + '\n' + (await lesbar(ergebnis));
    } catch (fehler) {
      // Fehler des SDK haben einen code und eine Nachricht auf Deutsch.
      ausgabe.classList.add('fehler');
      ausgabe.textContent = '→ ' + aufruf + '\nFehler ' + (fehler.code || fehler.name) + ': ' + fehler.message;
    }
  });
});
