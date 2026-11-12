'use strict';
// "Bauen" docs (package C): the guide (/entwickeln), the SDK reference
// generated from src/sdkReference.js (/entwickeln/sdk) and the SDK playground
// (/entwickeln/spielwiese). Everything here is for every signed-in person;
// the only state change is creating (once) one's own playground app.

const { html, raw, page, flash, postButton, linkButton, pageHead, appRow, list, notice } = require('../html');
const { formatAgo } = require('../util');
const { sdkReference } = require('../sdkReference');
const { bauenTabs, templateById, appFromTemplate, draftFromTemplate } = require('../bauen');

const QUICKSTART = `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mein Klickspiel</title>
  <link rel="stylesheet" href="hub-ui.css">
</head>
<body class="hub-ui">
  <main class="hub-page hub-stack">
    <h1 id="hallo">Hallo!</h1>
    <p>Klicks: <span id="zahl">0</span></p>
    <button class="hub-btn hub-primary" id="klick">Klick mich!</button>
  </main>

  <script src="hub-sdk.js"></script>
  <script>
    Hub.connect().then(async (hub) => {
      document.getElementById('hallo').textContent = 'Hallo ' + hub.user.name + '!';

      // Spielstand laden (beim ersten Mal: 0)
      let klicks = await hub.save.get('klicks', 0);
      document.getElementById('zahl').textContent = klicks;

      document.getElementById('klick').onclick = async () => {
        klicks++;
        document.getElementById('zahl').textContent = klicks;
        await hub.save.set('klicks', klicks);            // im Konto speichern
        await hub.leaderboard.submit('klicks', klicks);  // Bestenliste
      };
    });
  </script>
</body>
</html>`;

/**
 * Code with sensible break points: after ".", "(", "," and "{" a line may wrap,
 * never in the middle of a word (each part is escaped; <wbr> is our own markup).
 */
const breakable = (text) => String(text).split(/(?<=[.(,{])/).map((part, i) => html`${i ? raw('<wbr>') : ''}${part}`);
const anchor = (name) => name.replace(/[^A-Za-z0-9]+/g, '-');
/** Inline code. Short names never break (not even after a hyphen, as in hub-sdk.js); longer code wraps at its spaces. */
const code = (text) => html`<code${/\s/.test(text) ? '' : raw(' class="docs-nb"')}>${text}</code>`;
/** Reference text: `backticks` mark code. Every part is escaped; only the <code> element is ours. */
const rich = (text) => (typeof text === 'string' ? text.split('`').map((part, i) => (i % 2 ? code(part) : part)) : text);

/** A table of contents for the side column (sticky on wide screens). */
const toc = (items, label = 'Auf dieser Seite') =>
  html`<nav class="docs-toc" aria-label="${label}"><p class="docs-toc-title">${label}</p><ol>${items.map(([id, text, code]) => html`<li><a href="#${id}">${code ? html`<code>${text}</code>` : text}</a></li>`)}</ol></nav>`;

module.exports = (app, ctx) => {
  const { db, config } = ctx;
  const mb = (n) => `${Math.round(n / 1048576)} MB`;

  // ------------------------------------------------------------------ guide
  app.get('/entwickeln', (req, res) => {
    const L = config.limits;
    const steps = [
      ['lokal', 'Auf deinem PC bauen'],
      ['regeln', 'Die Regeln für Apps'],
      ['hochladen', 'Hochladen oder im Editor bauen'],
      ['vorschau', 'In der Vorschau ausprobieren'],
      ['veroeffentlichen', 'Veröffentlichen'],
      ['klasse', 'In die Klasse bringen'],
      ['lehrkraefte', 'Was Lehrkräfte sehen'],
      ['datenschutz', 'Datenschutz für App-Autor/innen'],
    ];
    const limits = [
      ['Dateien pro Version', String(L.maxFiles)],
      ['Größe einer Datei', mb(L.maxFileBytes)],
      ['Größe einer Version', mb(L.maxVersionBytes)],
      ['Versionen pro App', String(L.maxVersionsPerApp)],
      ['Apps pro Konto', String(L.maxAppsPerUser)],
      ['Speicher pro Konto', mb(L.maxUserBytes)],
      ['Spielstand pro Person und App', mb(L.saveTotalBytes)],
    ];
    const step = (id, title, content) => html`<li class="docs-step" id="${id}"><h2>${title}</h2><div class="prose">${content}</div></li>`;

    const body = html`${pageHead({
        eyebrow: 'Bauen',
        title: 'So baust du eine App',
        lead: `Jede Webseite in einem Ordner kann eine App im ${config.hubName} werden: ein Quiz, ein Spiel, ein Lernprogramm. Konten, Speichern, Klassen und Bestenlisten erledigt der Hub – du brauchst keinen eigenen Server.`,
        actions: html`${linkButton('/entwickeln/vorlagen', 'Mit einer Vorlage starten', { kind: 'primary', icon: 'template' })}${linkButton('/entwickeln/starter.zip', 'Starter-Paket (ZIP)', { icon: 'download' })}`,
        tabs: bauenTabs('anleitung'),
      })}
      <div class="docs-layout">
        ${toc(steps.map(([id, text]) => [id, text]))}
        <ol class="docs-steps" role="list">
        ${step('lokal', 'Auf deinem PC bauen', html`
          <p>Lade das <a href="/entwickeln/starter.zip">Starter-Paket</a> herunter und entpacke es. Darin liegen <code>index.html</code>, <code>app.js</code>, <code>style.css</code> und <code>schulhub.json</code> – dazu das SDK <code>hub-sdk.js</code> und das UI-Kit <code>hub-ui.css</code>, damit deine App aussieht wie der Hub.</p>
          <p>Öffne <code>index.html</code> mit einem Doppelklick. Die App läuft sofort, mit einer Testperson; gespeichert wird nur in deinem Browser. Willst du als Lehrkraft testen, hänge <code>?lehrkraft</code> an die Adresse an.</p>
          <p>Erfolge und Einstellungen aus <code>schulhub.json</code> liest das SDK auf dem PC nur über einen lokalen Webserver (zum Beispiel „Live Server“ in VS Code). Alles andere geht auch per Doppelklick.</p>
          <p>So sieht eine ganze kleine App aus. Dieselbe Datei läuft auf deinem PC und im Hub – du musst nichts umschreiben:</p>
          <pre class="code docs-code">${QUICKSTART}</pre>`)}
        ${step('regeln', 'Die Regeln für Apps', html`
          <ul>
            <li><strong>Alles muss im Ordner liegen.</strong> Apps können nichts aus dem Internet laden und nichts dorthin schicken: keine CDNs, keine Online-Schriften, keine fremden Server. Lade Bibliotheken herunter und lege sie mit in den Ordner.</li>
            <li><strong>Relative Pfade:</strong> <code>bilder/held.png</code>, nicht <code>/bilder/held.png</code>.</li>
            <li><strong><code>index.html</code> liegt ganz oben</strong> im Ordner. Sie ist die Startseite deiner App.</li>
            <li><strong>Erlaubt sind Web-Dateien:</strong> HTML, CSS, JavaScript, JSON, Bilder, Töne, Videos, Schriften, WASM und Daten von Spiele-Engines. Versteckte Dateien (wie <code>.git</code>) und <code>node_modules</code> werden übersprungen.</li>
            <li><strong>Spiele-Engines</strong> funktionieren, wenn sie fürs Web exportieren: zum Beispiel Phaser, p5.js, Godot (ohne Threads), Scratch als HTML oder Unity WebGL.</li>
          </ul>
          <dl class="kv docs-limits">${limits.map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>`)}
        ${step('hochladen', 'Hochladen oder im Editor bauen', html`
          <p>Lege unter <a href="/apps">Meine Apps</a> eine App an. Dann hast du zwei Wege, und du kannst sie mischen:</p>
          <ul>
            <li><strong>Hochladen:</strong> Wähle auf der App-Seite den Ordner deiner App oder eine ZIP-Datei. Jede Datei wird geprüft, und es entsteht eine neue Version.</li>
            <li><strong>Im Editor:</strong> Bearbeite die App direkt im Browser, mit Vorschau und Konsole daneben. Du arbeitest an einem Entwurf; „Als Version speichern“ macht daraus eine neue Version. Am schnellsten geht es mit einer <a href="/entwickeln/vorlagen">Vorlage</a>.</li>
          </ul>
          <p>Eine Version ändert sich danach nie mehr. Das ist wichtig für die Prüfung: Deine Lehrkraft gibt genau die Version frei, die sie gesehen hat.</p>`)}
        ${step('vorschau', 'In der Vorschau ausprobieren', html`
          <p>Die Vorschau zeigt deine App so, wie andere sie sehen werden – aber privat: Nur du siehst sie, und <strong>es wird nichts gespeichert</strong>. Spielstände, Ergebnisse und Bestenlisten bleiben im Arbeitsspeicher und sind nach zwei Stunden weg. <code>hub.mode</code> ist dann <code>'preview'</code>.</p>
          <p>In der Konsole unter der Vorschau stehen die Meldungen deiner App: was du mit <code>console.log()</code> ausgibst, Warnungen und Fehler mit Datei und Zeile.</p>`)}
        ${step('veroeffentlichen', 'Veröffentlichen', html`
          <p>Auf der App-Seite machst du eine Version mit „Veröffentlichen“ zur aktuellen. Du selbst und deine Klassen – wenn du Lehrkraft bist – benutzen dann diese Version.</p>
          <p>Eine neue Version kannst du jederzeit veröffentlichen. Klassen, in denen deine App schon freigegeben ist, behalten die alte, bis die Lehrkraft die neue freigibt.</p>`)}
        ${step('klasse', 'In die Klasse bringen', html`
          <p>Als Schüler/in reichst du deine App auf der App-Seite in einer deiner Klassen ein. Die Lehrkraft probiert sie in der Vorschau aus, liest den Quelltext und gibt sie frei – oder gibt sie dir mit einer Begründung zurück. In beiden Fällen bekommst du eine Mitteilung.</p>
          <p>Jede neue Version braucht wieder eine Freigabe, damit sich nach der Prüfung nichts mehr unbemerkt ändert. Lehrkräfte fügen ihre eigenen Apps direkt zu ihren Klassen hinzu.</p>`)}
        ${step('lehrkraefte', 'Was Lehrkräfte sehen', html`
          <ul>
            <li>Den <strong>Quelltext</strong> jeder Version, die bei ihnen eingereicht wurde, und den Prüfbericht.</li>
            <li>In ihrer Klasse die <strong>Ergebnisse</strong> (<code>hub.results</code>), den <strong>Fortschritt</strong> (<code>hub.progress</code>) und die <strong>Erfolge</strong> ihrer Schüler/innen – ohne dass du dafür etwas bauen musst. Mit <code>results.labels</code> in <code>schulhub.json</code> bekommen die Felder lesbare Namen.</li>
            <li>Die <strong>Einstellungen</strong> aus <code>schulhub.json</code> als Formular, zum Beispiel die Fragen eines Quiz für ihre Klasse.</li>
            <li><strong>Nicht</strong> die Spielstände (<code>hub.save</code>) und Dateien (<code>hub.files</code>) – die gehören der Person, die die App benutzt.</li>
          </ul>`)}
        ${step('datenschutz', 'Datenschutz für App-Autor/innen', html`
          <p>Die meisten, die deine App benutzen, sind minderjährig. Sammle deshalb nur, was deine App wirklich braucht.</p>
          <ul>
            <li>Deine App erfährt den <strong>Namen</strong> der Person und eine <strong>Kennung, die in jeder App anders ist</strong> – nie die E-Mail-Adresse.</li>
            <li>Frag nicht nach Adresse, Telefonnummer, Geburtstag oder Fotos. Texte, die andere lesen, schreiben nur die Lehrkraft (<code>hub.classData</code>) und du als Besitzer/in (<code>hub.shared</code>).</li>
            <li>Deine App kann nichts ins Internet schicken. Jede Person kann unter <a href="/meine-daten">Meine Daten</a> ansehen, herunterladen und löschen, was Apps über sie gespeichert haben.</li>
            <li>Als Besitzer/in siehst du keine Daten anderer in deiner App, nur wie oft sie pro Tag geöffnet wurde – ohne Namen.</li>
            <li>Bestenlisten zeigen Namen nur Personen aus derselben Klasse, alle anderen sehen „Anonym“.</li>
          </ul>`)}
        </ol>
      </div>`;
    res.send(page(req, { title: 'So baust du eine App', body, active: 'bauen', styles: ['css/docs.css'] }));
  });

  // ---------------------------------------------------------- SDK reference
  app.get('/entwickeln/sdk', (req, res) => {
    const ref = sdkReference(config);
    const facts = (rows) => {
      const shown = rows.filter(([, v]) => v && (!Array.isArray(v) || v.length));
      return shown.length ? html`<dl class="docs-facts">${shown.map(([k, v]) => html`<div><dt>${k}</dt><dd>${rich(v)}</dd></div>`)}</dl>` : '';
    };
    const params = (ps) => (ps && ps.length ? html`<ul class="docs-params" role="list">${ps.map(([name, type, text]) => html`<li>${code(name)} <span class="docs-type">${type}</span><span class="docs-param-text">${rich(text)}</span></li>`)}</ul>` : '');
    const codes = (list) => (list && list.length ? html`${list.map((c, i) => html`${i ? ', ' : ''}<a href="#fehler-${c}">${code(c)}</a>`)}` : '');
    const lines = (list) => (Array.isArray(list) ? html`${list.map((l, i) => html`${i ? raw('<br>') : ''}${rich(l)}`)}` : list);
    const chips = (names) => names.split(' · ').map((c, i) => html`${i ? ' ' : ''}<code class="docs-ns">${c}</code>`);

    const member = (m) => html`<article class="docs-member" id="${anchor(m.name)}">
        <h3 class="docs-sig"><code>${breakable(m.sig)}</code>${m.kind === 'property' ? html`<span class="docs-kind">Wert</span>` : ''}</h3>
        <p>${rich(m.text)}</p>
        ${facts([
          ['Parameter', params(m.params)],
          ['Felder', m.fields ? html`<ul class="docs-params" role="list">${m.fields.map(([k, t]) => html`<li>${code(k)}<span class="docs-param-text">${rich(t)}</span></li>`)}</ul>` : ''],
          [m.kind === 'property' ? 'Wert' : 'Ergibt', m.returns],
          ['Grenzen', m.limits ? lines(m.limits) : ''],
          ['Fehler', codes(m.errors)],
          ['In der Vorschau', m.preview],
          ['Lokal', m.local],
        ])}
        <pre class="code docs-code">${m.example}</pre>
      </article>`;

    const body = html`${pageHead({
        eyebrow: 'Bauen',
        title: 'SDK-Referenz',
        lead: 'Alles, was hub-sdk.js kann – mit Beispielen. Jede Funktion gibt ein Promise zurück: benutze await. Nur hub.user, hub.class, hub.mode und hub.app sind sofort da.',
        actions: html`${linkButton('/sdk/hub-sdk.js', 'hub-sdk.js herunterladen', { icon: 'download' })}${linkButton('/entwickeln/spielwiese', 'Spielwiese', { kind: 'quiet', icon: 'play' })}`,
        tabs: bauenTabs('sdk'),
      })}
      <div class="docs-layout">
        ${toc([['modi', 'Drei Umgebungen'], ...ref.groups.map((g) => [g.id, g.title]), ['fehler', 'Fehler'], ['schulhub-json', 'schulhub.json', true], ['hub-ui', 'hub-ui.css', true]], 'Inhalt')}
        <div class="docs-ref">
          <section class="docs-group docs-modes" aria-labelledby="modi">
            <h2 id="modi">Drei Umgebungen, ein Code</h2>
            <dl class="docs-facts">
              <div><dt><code>live</code></dt><dd>Im Hub: echte Konten, gespeichert wird pro Person und App.</dd></div>
              <div><dt><code>preview</code></dt><dd>Vorschau im Hub (im Editor oder bei der Prüfung): Lesen zeigt echte Klassendaten, geschrieben wird nur in den Arbeitsspeicher.</dd></div>
              <div><dt><code>local</code></dt><dd>Auf deinem PC: eine Testperson, gespeichert wird im Browser (localStorage).</dd></div>
            </dl>
          </section>
          ${ref.groups.map((g) => html`<section class="docs-group" aria-labelledby="${g.id}">
            <h2 id="${g.id}">${g.title} ${chips(g.code)}</h2>
            <p class="docs-intro">${rich(g.intro)}</p>
            ${facts([['In der Vorschau', g.preview], ['Lokal', g.local]])}
            ${g.members.map(member)}
          </section>`)}

          <section class="docs-group" aria-labelledby="fehler">
            <h2 id="fehler">Fehler</h2>
            <p class="docs-intro">Geht etwas schief, endet das Promise mit einem Fehler. Er hat einen <code>code</code> für deinen Code und eine <code>message</code> auf Deutsch, die du anzeigen kannst.</p>
            <pre class="code docs-code">try {\n  await hub.save.set('stand', stand);\n} catch (fehler) {\n  if (fehler.code === 'quota') zeige('Dein Speicher ist voll.');\n  else zeige(fehler.message);\n}</pre>
            <dl class="docs-facts docs-errors">${ref.errors.map(([c, t]) => html`<div id="fehler-${c}"><dt>${code(c)}</dt><dd>${rich(t)}</dd></div>`)}</dl>
          </section>

          <section class="docs-group" aria-labelledby="schulhub-json">
            <h2 id="schulhub-json">Die Datei <code class="docs-ns">schulhub.json</code></h2>
            <p class="docs-intro">Mit ihr erklärst du dem Hub, was er für deine App anzeigen soll: Erfolge, Einstellungen für Lehrkräfte, Namen für Ergebnisfelder und Angaben für den Katalog. Sie ist freiwillig.</p>
            <ul class="docs-rules">${ref.manifest.rules.map((r) => html`<li>${rich(r)}</li>`)}</ul>
            <pre class="code docs-code">${ref.manifest.example}</pre>
            <h3 class="docs-sub">Einträge</h3>
            <dl class="docs-facts">${ref.manifest.fields.map(([k, t, text]) => html`<div><dt>${code(k)} <span class="docs-type">${t}</span></dt><dd>${rich(text)}</dd></div>`)}</dl>
            <h3 class="docs-sub">Arten von Einstellungen</h3>
            <dl class="docs-facts">${ref.manifest.settingTypes.map(([k, text]) => html`<div><dt>${code(k)}</dt><dd>${rich(text)}</dd></div>`)}</dl>
            <h3 class="docs-sub">Emojis für Erfolge</h3>
            <p class="docs-emojis" aria-label="Erlaubte Emojis">${ref.manifest.emojis.join(' ')}</p>
          </section>

          <section class="docs-group" aria-labelledby="hub-ui">
            <h2 id="hub-ui">Das UI-Kit <code class="docs-ns">hub-ui.css</code></h2>
            <p class="docs-intro">${rich(ref.ui.intro)}</p>
            <pre class="code docs-code">${ref.ui.example}</pre>
            <h3 class="docs-sub">Klassen</h3>
            <dl class="docs-facts">${ref.ui.classes.map(([k, text]) => html`<div><dt>${code(`.${k}`)}</dt><dd>${rich(text)}</dd></div>`)}</dl>
            <h3 class="docs-sub">Farben</h3>
            <ul class="docs-rules">${ref.ui.variables.map((v) => html`<li>${rich(v)}</li>`)}</ul>
          </section>
        </div>
      </div>`;
    res.send(page(req, { title: 'SDK-Referenz', body, active: 'bauen', styles: ['css/docs.css'] }));
  });

  // ------------------------------------------------------------- playground
  const playground = templateById('spielwiese');
  /** The person's own playground: their oldest app with the template's name (it is reused, never duplicated). */
  const findPlayground = (user) => db.get('SELECT * FROM apps WHERE owner_id = ? AND name = ? ORDER BY created_at LIMIT 1', user.id, playground.appName);

  app.get('/entwickeln/spielwiese', (req, res) => {
    const mine = findPlayground(req.user);
    const body = html`${pageHead({
        crumbs: [['/entwickeln/sdk', 'SDK-Referenz']],
        eyebrow: 'Bauen',
        title: 'SDK-Spielwiese',
        lead: 'Eine App, in der jede Funktion des SDK einen Knopf hat. Drück drauf und sieh sofort, was zurückkommt – und gleich daneben im Editor, wie es gemacht ist.',
        actions: postButton(req, '/entwickeln/spielwiese', mine ? 'Deine Spielwiese öffnen' : 'Spielwiese öffnen', { kind: 'primary', icon: 'play' }),
        tabs: bauenTabs('sdk'),
      })}
      <div class="docs-narrow">
        ${mine ? html`<section class="section" aria-labelledby="s-mine"><h2 id="s-mine" class="docs-h">Deine Spielwiese</h2>
          ${list(appRow(mine, { href: `/studio/${mine.id}`, sub: `In „Meine Apps“ · zuletzt geändert ${formatAgo(mine.updated_at)}` }))}</section>` : ''}
        <div class="prose">
          <h2>So funktioniert sie</h2>
          <p>Beim ersten Mal legt der Knopf oben eine eigene App „${playground.appName}“ für dich an – aus der Vorlage, mit allen Dateien. Danach öffnet er immer diese App im Editor. Du kannst darin alles ändern, Knöpfe dazubauen und ausprobieren, was passiert.</p>
          <h2>Was du ausprobieren kannst</h2>
          <ul>
            <li><code>hub.user</code>, <code>hub.class</code>, <code>hub.mode</code> und <code>hub.app</code>: wer, wo und wie.</li>
            <li>Speichern pro Person (<code>hub.save</code>), für alle (<code>hub.shared</code>) und für die Klasse (<code>hub.classData</code>).</li>
            <li>Bestenliste, Ergebnisse, Fortschritt und Erfolge.</li>
            <li>Die Einstellungen aus <code>schulhub.json</code> – mit einem Beispiel für jede Art von Feld.</li>
            <li>Dateien: eine Notiz und ein gemaltes Bild speichern und wieder lesen.</li>
            <li>Fehler: Was passiert bei einem unbekannten Erfolg oder ohne Klasse? Jeder Fehler hat einen Code und eine Nachricht.</li>
          </ul>
          <h2>Was mit den Daten passiert</h2>
          <p>Im Editor läuft die Spielwiese als Vorschau: Es wird nichts gespeichert, und niemand außer dir sieht sie. <code>hub.classData</code> meldet dort <code>no_class</code>, denn eine Vorschau im Editor gehört zu keiner Klasse.</p>
        </div>
        ${notice({ icon: 'download', title: 'Lieber auf dem PC?', text: 'Die Spielwiese gibt es auch als ZIP. Entpacken, index.html doppelklicken – dann läuft sie im lokalen Testmodus.', actions: linkButton(`/entwickeln/vorlagen/${playground.id}.zip`, 'Spielwiese als ZIP', { size: 'sm', icon: 'download' }) })}
      </div>`;
    res.send(page(req, { title: 'SDK-Spielwiese', body, active: 'bauen', styles: ['css/docs.css'] }));
  });

  /** Open the person's playground; create it from the template the first time. */
  app.post('/entwickeln/spielwiese', (req, res) => {
    let a = findPlayground(req.user);
    if (!a) {
      a = appFromTemplate(ctx, req.user, playground);
      flash(req, 'Deine Spielwiese ist angelegt. Drück auf die Knöpfe in der Vorschau!');
    } else if (!db.get('SELECT 1 AS ok FROM app_drafts WHERE app_id = ?', a.id) && !db.get('SELECT 1 AS ok FROM app_versions WHERE app_id = ?', a.id)) {
      draftFromTemplate(ctx, a, playground);
    }
    res.redirect(303, `/studio/${a.id}`);
  });
};
