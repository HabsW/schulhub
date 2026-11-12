// Quiz – zeigt: Einstellungen der Lehrkraft (hub.settings), Ergebnisse mit
// jeder einzelnen Antwort für die Lehrkraft (hub.results), Fortschritt
// (hub.progress) und Erfolge (hub.achievements).
//
// Die Fragen legt die Lehrkraft im Hub fest (siehe "settings" in schulhub.json).
// Ohne Klasse und auf deinem PC gelten diese Standardfragen:
const STANDARD = [
  ['Wie viele Beine hat eine Spinne?', 'Acht'],
  ['Wie heißt die Hauptstadt von Frankreich?', 'Paris'],
  ['Welcher Planet ist der größte im Sonnensystem?', 'Jupiter'],
  ['Wie heißt das Ergebnis einer Multiplikation?', 'Produkt'],
  ['In welchem Jahr fiel die Berliner Mauer?', '1989'],
  ['Welches chemische Zeichen hat Gold?', 'Au'],
  ['Wie heißt „Schmetterling“ auf Englisch?', 'butterfly'],
  ['Welcher Fluss fließt durch Köln?', 'Rhein'],
];

const $ = (id) => document.getElementById(id);
const zeige = (id) => ['start', 'frage-box', 'ende'].forEach((s) => { $(s).hidden = s !== id; });

/** Eine Liste zufällig mischen (Fisher-Yates). */
function mischen(liste) {
  const a = liste.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Kurze Meldung unten am Rand (Klasse hub-toast aus hub-ui.css). */
function meldung(text) {
  const t = document.createElement('div');
  t.className = 'hub-toast';
  t.setAttribute('role', 'status');
  t.textContent = text;
  document.body.append(t);
  setTimeout(() => t.remove(), 3200);
}

Hub.connect().then(async (hub) => {
  const fragen = await hub.settings.get('fragen', STANDARD);
  const proRunde = Math.min(await hub.settings.get('pro-runde', 5), fragen.length);
  // Fragen, die schon einmal richtig beantwortet wurden (nur die aktuellen zählen)
  let gekonnt = (await hub.save.get('gekonnt', [])).filter((f) => fragen.some(([q]) => q === f));
  let runden = await hub.save.get('runden', 0);

  let runde = [];
  let nr = 0;
  let protokoll = [];

  if (hub.class) $('klasse').textContent = 'Quiz · ' + hub.class.name;
  $('lehrkraft').hidden = !hub.user.isTeacher;

  function zeigeStand() {
    const n = fragen.filter(([q]) => gekonnt.includes(q)).length;
    $('stand').textContent = n + ' von ' + fragen.length + ' Fragen schon richtig beantwortet';
    $('fortschritt').value = fragen.length ? n / fragen.length : 0;
    return n;
  }

  async function zeigeErfolge() {
    const liste = await hub.achievements.list();
    $('erfolge').replaceChildren(...liste.map((a) => {
      const li = document.createElement('li');
      li.className = a.unlocked ? 'erfolg' : 'erfolg offen';
      const emoji = document.createElement('span');
      emoji.className = 'emoji';
      emoji.textContent = a.emoji;
      const text = document.createElement('span');
      text.textContent = a.title + (a.description ? ' – ' + a.description : '');
      li.append(emoji, text);
      return li;
    }));
    $('erfolge-box').hidden = liste.length === 0;
  }

  async function freischalten(id) {
    const a = await hub.achievements.unlock(id);
    if (a.new) meldung(a.emoji + ' Neuer Erfolg: ' + a.title);
  }

  function startseite() {
    zeigeStand();
    if (!fragen.length) {
      $('start-text').textContent = 'Noch keine Fragen. Die Lehrkraft legt sie im Hub fest.';
      $('los').hidden = true;
    } else {
      $('start-text').textContent = 'Eine Runde hat ' + proRunde + ' Fragen. Wähle jeweils die richtige Antwort.';
    }
    zeige('start');
    zeigeErfolge();
  }

  function stelleFrage() {
    const [text, richtig] = runde[nr];
    $('zaehler').textContent = 'Frage ' + (nr + 1) + ' von ' + runde.length;
    $('frage').textContent = text;
    $('rueckmeldung').textContent = '';
    $('weiter').hidden = true;
    // Drei falsche Antworten aus den anderen Fragen
    const falsch = mischen([...new Set(fragen.map(([, a]) => a).filter((a) => a !== richtig))]).slice(0, 3);
    $('antworten').replaceChildren(...mischen([richtig, ...falsch]).map((a) => {
      const knopf = document.createElement('button');
      knopf.className = 'hub-btn antwort';
      knopf.textContent = a;
      knopf.addEventListener('click', () => antworte(a, knopf));
      return knopf;
    }));
    zeige('frage-box');
    $('antworten').firstElementChild.focus();
  }

  function antworte(gegeben, knopf) {
    const [text, richtig] = runde[nr];
    const ok = gegeben === richtig;
    for (const b of $('antworten').children) {
      b.disabled = true;
      if (b.textContent === richtig) b.classList.add('richtig');
    }
    if (!ok) knopf.classList.add('falsch');
    $('rueckmeldung').textContent = ok ? 'Richtig!' : 'Leider falsch. Richtig ist: ' + richtig;
    protokoll.push({ frage: text, antwort: richtig, gegeben: gegeben, richtig: ok });
    if (ok && !gekonnt.includes(text)) gekonnt.push(text);
    $('weiter').textContent = nr + 1 < runde.length ? 'Nächste Frage' : 'Zur Auswertung';
    $('weiter').hidden = false;
    $('weiter').focus();
  }

  async function auswertung() {
    const punkte = protokoll.filter((p) => p.richtig).length;
    runden++;
    $('ende-titel').textContent = punkte + ' von ' + runde.length + ' richtig';
    $('ende-liste').replaceChildren(...protokoll.map((p) => {
      const li = document.createElement('li');
      const marke = document.createElement('span');
      marke.className = p.richtig ? 'marke ok' : 'marke falsch';
      marke.textContent = p.richtig ? '✓' : '✗';
      const text = document.createElement('span');
      text.textContent = p.frage + ' – ' + p.antwort;
      li.append(marke, text);
      return li;
    }));
    zeige('ende');
    $('nochmal').focus();
    try {
      // Das Ergebnis sieht auch die Lehrkraft – mit jeder einzelnen Antwort.
      await hub.results.add({ title: 'Quiz-Runde', score: punkte, maxScore: runde.length, details: protokoll });
      await hub.save.set('gekonnt', gekonnt);
      await hub.save.set('runden', runden);
      const n = zeigeStand();
      await hub.progress.set(fragen.length ? n / fragen.length : 0, { label: n + ' von ' + fragen.length + ' Fragen' });
      await freischalten('erste-runde');
      if (punkte === runde.length) await freischalten('alles-richtig');
      if (runden >= 5) await freischalten('dranbleiben');
      zeigeErfolge();
    } catch (fehler) {
      meldung('Nicht gespeichert: ' + fehler.message);
    }
  }

  $('los').addEventListener('click', () => {
    runde = mischen(fragen).slice(0, proRunde);
    nr = 0;
    protokoll = [];
    stelleFrage();
  });
  $('weiter').addEventListener('click', () => {
    nr++;
    if (nr < runde.length) stelleFrage();
    else auswertung();
  });
  $('nochmal').addEventListener('click', startseite);

  startseite();
});
