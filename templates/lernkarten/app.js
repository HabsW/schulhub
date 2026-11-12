// Lernkarten – zeigt: Karten aus den Einstellungen der Lehrkraft (hub.settings,
// Typ "pairs"), den Lernstand pro Person (hub.save), den Fortschritt
// (hub.progress), Ergebnisse für die Lehrkraft und Erfolge.
//
// Jede Karte hat eine Stufe von 0 bis 3. "Gewusst" hebt sie um eins,
// "Noch nicht" setzt sie auf 0. Ab Stufe 2 gilt eine Karte als sicher.
const STANDARD = [
  ['der Hund', 'the dog'],
  ['die Katze', 'the cat'],
  ['das Haus', 'the house'],
  ['die Schule', 'the school'],
  ['der Freund', 'the friend'],
  ['das Buch', 'the book'],
  ['das Fenster', 'the window'],
  ['der Apfel', 'the apple'],
];
const PRO_RUNDE = 10;
const SICHER = 2;

const $ = (id) => document.getElementById(id);

function mischen(liste) {
  const a = liste.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function meldung(text) {
  const t = document.createElement('div');
  t.className = 'hub-toast';
  t.setAttribute('role', 'status');
  t.textContent = text;
  document.body.append(t);
  setTimeout(() => t.remove(), 3200);
}

Hub.connect().then(async (hub) => {
  const karten = await hub.settings.get('karten', STANDARD);
  const umgedreht = await hub.settings.get('umgedreht', false);
  // Lernstand: { "der Hund": 2, … } – Schlüssel ist die Vorderseite
  const stufen = await hub.save.get('stufen', {});

  let stapel = [];
  let nr = 0;
  let gewusst = 0;

  if (hub.class) $('klasse').textContent = 'Lernkarten · ' + hub.class.name;
  $('lehrkraft').hidden = !hub.user.isTeacher;

  const stufe = (karte) => stufen[karte[0]] || 0;
  const vorne = (karte) => (umgedreht ? karte[1] : karte[0]);
  const hinten = (karte) => (umgedreht ? karte[0] : karte[1]);

  function zeigeStand() {
    const sicher = karten.filter((k) => stufe(k) >= SICHER).length;
    $('stand').textContent = sicher + ' von ' + karten.length + ' Karten sitzen sicher';
    $('fortschritt').value = karten.length ? sicher / karten.length : 0;
    return sicher;
  }

  function neueRunde() {
    // Karten, die noch nicht sitzen, kommen zuerst
    stapel = mischen(karten).sort((a, b) => stufe(a) - stufe(b)).slice(0, PRO_RUNDE);
    nr = 0;
    gewusst = 0;
    $('fertig').hidden = true;
    $('lernen').hidden = false;
    zeigeKarte();
  }

  function zeigeKarte() {
    const karte = stapel[nr];
    $('zaehler').textContent = 'Karte ' + (nr + 1) + ' von ' + stapel.length;
    $('seite').textContent = 'Vorderseite';
    $('text').textContent = vorne(karte);
    $('karte').classList.remove('umgedreht');
    $('vorne').hidden = false;
    $('hinten').hidden = true;
    $('umdrehen').focus();
  }

  function bewerte(ok) {
    const karte = stapel[nr];
    stufen[karte[0]] = ok ? Math.min(stufe(karte) + 1, 3) : 0;
    if (ok) gewusst++;
    // Nach jeder Karte speichern – im Hintergrund, damit die nächste Karte sofort kommt.
    hub.save.set('stufen', stufen).catch((fehler) => meldung('Nicht gespeichert: ' + fehler.message));
    if (ok) {
      hub.achievements.unlock('erste-karte').then((a) => {
        if (a.new) meldung(a.emoji + ' Neuer Erfolg: ' + a.title);
      }, () => {});
    }
    zeigeStand();
    nr++;
    if (nr < stapel.length) zeigeKarte();
    else rundeFertig();
  }

  async function rundeFertig() {
    $('lernen').hidden = true;
    $('fertig').hidden = false;
    $('fertig-titel').textContent = gewusst + ' von ' + stapel.length + ' gewusst';
    const sicher = zeigeStand();
    $('fertig-text').textContent = sicher === karten.length ? 'Alle Karten sitzen. Stark!' : 'Die Karten, die noch nicht sitzen, kommen in der nächsten Runde zuerst.';
    $('weiter').focus();
    try {
      await hub.results.add({ title: 'Lernrunde', score: gewusst, maxScore: stapel.length });
      await hub.progress.set(karten.length ? sicher / karten.length : 0, { label: sicher + ' von ' + karten.length + ' Karten' });
      if (karten.length && sicher === karten.length) {
        const a = await hub.achievements.unlock('alle-karten');
        if (a.new) meldung(a.emoji + ' Neuer Erfolg: ' + a.title);
      }
    } catch (fehler) {
      meldung('Nicht gespeichert: ' + fehler.message);
    }
  }

  $('umdrehen').addEventListener('click', () => {
    $('seite').textContent = 'Rückseite';
    $('text').textContent = hinten(stapel[nr]);
    $('karte').classList.add('umgedreht');
    $('vorne').hidden = true;
    $('hinten').hidden = false;
    $('gewusst').focus();
  });
  $('gewusst').addEventListener('click', () => bewerte(true));
  $('nochmal').addEventListener('click', () => bewerte(false));
  $('weiter').addEventListener('click', neueRunde);

  zeigeStand();
  if (karten.length) neueRunde();
  else {
    $('lernen').hidden = true;
    $('stand').textContent = 'Noch keine Karten. Die Lehrkraft legt sie im Hub fest.';
  }
});
