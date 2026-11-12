// Vokabeltrainer - zeigt: Klassen-Daten (Wortliste der Lehrkraft), Spielstand
// pro Konto, Ergebnisse für die Lehrkraft und eine Bestenliste.

const STANDARD = [
  ['der Hund', 'dog'], ['die Katze', 'cat'], ['das Haus', 'house'], ['die Schule', 'school'],
  ['der Freund', 'friend'], ['das Buch', 'book'], ['das Wasser', 'water'], ['der Apfel', 'apple'],
  ['die Stadt', 'town'], ['das Fenster', 'window'], ['die Uhr', 'clock'], ['der Stuhl', 'chair'],
];
const RUNDE = 8;
const $ = (id) => document.getElementById(id);
const show = (id) => ['menu', 'quiz', 'done', 'editor'].forEach((s) => ($(s).hidden = s !== id));

Hub.connect().then(async (hub) => {
  let words = STANDARD;
  let known = await hub.save.get('gekonnt', {}); // { "dog": 3 }  = wie oft richtig
  let round = [];
  let index = 0;
  let log = [];

  $('who').textContent = 'Hallo ' + hub.user.name + (hub.class ? ' · ' + hub.class.name : '');

  async function loadWords() {
    try {
      const list = await hub.classData.get('woerter', null);
      if (Array.isArray(list) && list.length) words = list;
    } catch (e) {
      // ohne Klasse geöffnet: Standardliste
    }
  }

  async function menu() {
    const learned = words.filter((w) => (known[w[1]] || 0) >= 2).length;
    $('progress-text').textContent = learned + ' von ' + words.length + ' Wörtern sicher gekonnt';
    $('progress-bar').style.width = Math.round((learned / words.length) * 100) + '%';
    $('edit').hidden = !(hub.user.isTeacher && hub.class);
    show('menu');
    const top = await hub.leaderboard.top('richtig', { limit: 5 });
    $('board').replaceChildren(...top.entries.map((e) => {
      const li = document.createElement('li');
      li.textContent = e.name + ' – ' + e.score;
      if (e.me) li.className = 'me';
      return li;
    }));
    if (!top.entries.length) $('board').textContent = 'Noch niemand – sei die oder der Erste!';
  }

  function ask() {
    const [de] = round[index];
    $('count').textContent = 'Wort ' + (index + 1) + ' von ' + round.length;
    $('word').textContent = de;
    $('answer').value = '';
    $('feedback').textContent = '';
    $('feedback').className = 'feedback';
    $('answer').focus();
  }

  $('start').onclick = () => {
    // Wörter, die noch nicht sitzen, kommen zuerst dran
    round = [...words].sort((a, b) => (known[a[1]] || 0) - (known[b[1]] || 0) + (Math.random() - 0.5)).slice(0, RUNDE);
    index = 0;
    log = [];
    show('quiz');
    ask();
  };

  $('answer-form').onsubmit = (event) => {
    event.preventDefault();
    const [de, en] = round[index];
    const given = $('answer').value.trim();
    const right = given.toLowerCase() === en.toLowerCase();
    log.push({ Wort: de, Antwort: given, Lösung: en, richtig: right });
    known[en] = right ? (known[en] || 0) + 1 : 0;
    $('feedback').textContent = right ? 'Richtig!' : 'Leider nein – richtig ist: ' + en;
    $('feedback').className = 'feedback ' + (right ? 'right' : 'wrong');
    setTimeout(async () => {
      index++;
      if (index < round.length) return ask();
      await finish();
    }, right ? 600 : 1800);
  };

  async function finish() {
    const score = log.filter((l) => l.richtig).length;
    $('done-title').textContent = score + ' von ' + log.length + ' richtig' + (score === log.length ? ' – perfekt! 🎉' : '');
    $('done-list').replaceChildren(...log.map((l) => {
      const li = document.createElement('li');
      li.textContent = l.Wort + ' → ' + l.Lösung + (l.richtig ? ' ✓' : ' ✗ (deine Antwort: ' + (l.Antwort || '–') + ')');
      li.className = l.richtig ? 'right' : 'wrong';
      return li;
    }));
    show('done');
    const total = (await hub.save.get('richtig-gesamt', 0)) + score;
    await hub.save.set('gekonnt', known);
    await hub.save.set('richtig-gesamt', total);
    await hub.leaderboard.submit('richtig', total);
    // Das sieht die Lehrkraft in der Auswertung - Wort für Wort.
    await hub.results.add({ title: 'Übungsrunde', score: score, maxScore: log.length, details: log });
  }
  $('again').onclick = menu;

  // --- nur für die Lehrkraft: Wortliste der Klasse ---
  $('edit').onclick = () => {
    $('class-name').textContent = hub.class.name;
    $('list').value = words.map((w) => w[0] + ' = ' + w[1]).join('\n');
    $('editor-note').textContent = '';
    show('editor');
  };
  $('cancel-list').onclick = menu;
  $('save-list').onclick = async () => {
    const list = $('list').value.split('\n').map((line) => line.split('=').map((s) => s.trim())).filter((p) => p.length === 2 && p[0] && p[1]);
    if (!list.length) return ($('editor-note').textContent = 'Bitte mindestens ein Wortpaar eingeben.');
    try {
      await hub.classData.set('woerter', list);
      words = list;
      menu();
    } catch (e) {
      $('editor-note').textContent = e.message;
    }
  };

  await loadWords();
  menu();
});
