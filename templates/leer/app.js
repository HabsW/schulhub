// Hier beginnt deine App.
// Hub.connect() verbindet sie mit dem Hub. Auf deinem PC (Doppelklick auf
// index.html) läuft sie im Testmodus: mit einer Testperson, gespeichert wird
// nur in diesem Browser. Als Lehrkraft testen: index.html?lehrkraft

const $ = (id) => document.getElementById(id);

Hub.connect().then(async (hub) => {
  $('hallo').textContent = 'Hallo, ' + hub.user.name + '!';
  if (hub.mode === 'local') $('wo').textContent = 'Testmodus auf deinem PC – gespeichert wird nur in diesem Browser.';
  else if (hub.mode === 'preview') $('wo').textContent = 'Vorschau – hier wird nichts dauerhaft gespeichert.';
  else if (hub.class) $('wo').textContent = 'Klasse ' + hub.class.name;

  // Spielstand laden. Beim ersten Mal gibt es noch keinen: dann 0.
  let klicks = await hub.save.get('klicks', 0);
  $('zahl').textContent = klicks;
  // Die Knöpfe sind in index.html ausgeschaltet (disabled), bis die App bereit ist.
  $('klick').disabled = false;
  $('zurueck').disabled = false;

  $('klick').addEventListener('click', async () => {
    klicks++;
    $('zahl').textContent = klicks;
    await hub.save.set('klicks', klicks); // im Konto speichern
    if (klicks === 1) await hub.achievements.unlock('erster-klick'); // steht in schulhub.json
  });

  $('zurueck').addEventListener('click', async () => {
    klicks = 0;
    $('zahl').textContent = klicks;
    await hub.save.remove('klicks');
  });
});
