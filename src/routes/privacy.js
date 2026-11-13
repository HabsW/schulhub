'use strict';
// "Meine Daten": everything the Hub stores about the signed-in person, with
// export and delete. Only ever reads and deletes req.user's own rows. Other
// people appear at most by name (e.g. who wrote a piece of feedback), never
// with their e-mail address or anything else.

const {
  html, page, flash, csrfField, postButton, linkButton, appIcon, appClass, jsonView, ROLE_LABEL, icon,
  pageHead, sectionHead, list, row, stat, stats, empty, notice, meter, dataTable, badge, field,
} = require('../html');
const { deny, bad, cleanText, formatDate, formatAgo, formatBytes, plural, isLocalPath, HttpError } = require('../util');
const { manifestOf, KEY } = require('../manifest');
const { auditLabel } = require('../auditLabels');
const { displaySummary } = require('../formKit');
const { writeJson, lazy } = require('../jsonStream');

/** Types a hub.files file can have (src/userFiles.js) -> label and file extension for downloads. */
const FILE_KINDS = {
  'image/png': ['PNG-Bild', 'png'],
  'image/jpeg': ['JPEG-Bild', 'jpg'],
  'image/gif': ['GIF-Bild', 'gif'],
  'image/webp': ['WebP-Bild', 'webp'],
  'application/json': ['JSON-Daten', 'json'],
  'text/plain': ['Text', 'txt'],
  'text/csv': ['Tabelle (CSV)', 'csv'],
};
const fileKind = (type) => FILE_KINDS[type] || ['Datei', 'bin'];

const iso = (ts) => (ts ? new Date(ts).toISOString() : null);
const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

module.exports = (app, ctx) => {
  const { db, config, services, access, userFiles } = ctx;
  const L = config.limits;

  // ------------------------------------------------------------ queries

  /** Apps in which this user has any data, with counts and sizes per kind. */
  const myAppData = (userId) =>
    db.all(
      `SELECT a.id, a.name, a.emoji, a.color,
              (SELECT COUNT(*) FROM saves s WHERE s.app_id = a.id AND s.user_id = ?1) AS saves,
              (SELECT COALESCE(SUM(size), 0) FROM saves s WHERE s.app_id = a.id AND s.user_id = ?1) AS save_bytes,
              (SELECT COUNT(*) FROM results r WHERE r.app_id = a.id AND r.user_id = ?1) AS results,
              (SELECT COUNT(*) FROM scores c WHERE c.app_id = a.id AND c.user_id = ?1) AS scores,
              (SELECT value FROM progress p WHERE p.app_id = a.id AND p.user_id = ?1) AS progress,
              (SELECT COUNT(*) FROM achievements x WHERE x.app_id = a.id AND x.user_id = ?1) AS achievements,
              (SELECT COUNT(*) FROM user_files f WHERE f.app_id = a.id AND f.user_id = ?1) AS files,
              (SELECT COALESCE(SUM(size), 0) FROM user_files f WHERE f.app_id = a.id AND f.user_id = ?1) AS file_bytes,
              (SELECT last_at FROM plays p WHERE p.app_id = a.id AND p.user_id = ?1) AS last_at
         FROM apps a
        WHERE a.id IN (SELECT app_id FROM saves WHERE user_id = ?1 UNION SELECT app_id FROM results WHERE user_id = ?1
                       UNION SELECT app_id FROM scores WHERE user_id = ?1 UNION SELECT app_id FROM plays WHERE user_id = ?1
                       UNION SELECT app_id FROM progress WHERE user_id = ?1 UNION SELECT app_id FROM achievements WHERE user_id = ?1
                       UNION SELECT app_id FROM user_files WHERE user_id = ?1)
        ORDER BY a.name COLLATE NOCASE LIMIT 500`,
      userId
    );

  /** Does this user have anything stored in this app? */
  const hasData = (appId, userId) =>
    Boolean(
      db.get(
        `SELECT 1 AS ok WHERE EXISTS (SELECT 1 FROM saves WHERE app_id = ?1 AND user_id = ?2)
            OR EXISTS (SELECT 1 FROM results WHERE app_id = ?1 AND user_id = ?2) OR EXISTS (SELECT 1 FROM scores WHERE app_id = ?1 AND user_id = ?2)
            OR EXISTS (SELECT 1 FROM plays WHERE app_id = ?1 AND user_id = ?2) OR EXISTS (SELECT 1 FROM progress WHERE app_id = ?1 AND user_id = ?2)
            OR EXISTS (SELECT 1 FROM achievements WHERE app_id = ?1 AND user_id = ?2) OR EXISTS (SELECT 1 FROM user_files WHERE app_id = ?1 AND user_id = ?2)`,
        appId, userId
      )
    );

  /** Counts of everything else that belongs to this person. */
  const inventory = (userId) =>
    db.get(
      `SELECT (SELECT COUNT(*) FROM apps WHERE owner_id = ?1) AS apps,
              (SELECT COUNT(*) FROM comments WHERE author_id = ?1) AS comments,
              (SELECT COUNT(*) FROM favorites WHERE user_id = ?1) AS favorites,
              (SELECT COUNT(*) FROM feedback WHERE student_id = ?1) AS feedback,
              (SELECT COUNT(*) FROM feedback WHERE student_id = ?1 AND read_at IS NULL) AS feedback_new,
              (SELECT COUNT(*) FROM feedback WHERE author_id = ?1) AS feedback_written,
              (SELECT COUNT(*) FROM assignment_done WHERE user_id = ?1) AS done,
              (SELECT COUNT(*) FROM assignments WHERE created_by = ?1) AS assignments,
              (SELECT COUNT(*) FROM notices WHERE user_id = ?1) AS notices,
              (SELECT COUNT(*) FROM notices WHERE user_id = ?1 AND read_at IS NULL) AS notices_new,
              (SELECT COUNT(*) FROM announcements WHERE author_id = ?1) AS announcements,
              (SELECT COUNT(*) FROM announcement_dismissed WHERE user_id = ?1) AS dismissed,
              (SELECT COUNT(*) FROM audit_log WHERE actor_id = ?1) AS audit`,
      userId
    );

  /**
   * What the app's manifests say about achievements and result labels. Looks at
   * the versions this person can have used: published, school-wide and the ones
   * approved in their classes (newest names first).
   */
  function vocabulary(a, userId) {
    const ids = [
      a.published_version_id, a.schoolwide_version_id,
      ...db.all('SELECT ca.version_id FROM class_apps ca JOIN class_members m ON m.class_id = ca.class_id AND m.user_id = ? WHERE ca.app_id = ? AND ca.version_id IS NOT NULL', userId, a.id).map((r) => r.version_id),
    ];
    const achievements = new Map();
    const labels = Object.create(null); // no prototype: keys like "constructor" stay plain keys
    for (const id of [...new Set(ids.filter(Boolean))].slice(0, 10)) {
      const m = manifestOf(db.get('SELECT manifest FROM app_versions WHERE id = ?', id));
      for (const x of m.achievements || []) if (!achievements.has(x.id)) achievements.set(x.id, x);
      for (const [k, v] of Object.entries((m.results && m.results.labels) || {})) if (!(k in labels) && typeof v === 'string') labels[k] = v;
    }
    return { achievements, labels };
  }

  const isLastAdmin = (user) => user.role === 'admin' && db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").n <= 1;

  /** Classes that disappear with this account (it is their only teacher). */
  const soleTeacherClasses = (userId) =>
    db.all(
      `SELECT c.id, c.name FROM classes c JOIN class_members m ON m.class_id = c.id AND m.user_id = ?1 AND m.role = 'teacher'
        WHERE NOT EXISTS (SELECT 1 FROM class_members o WHERE o.class_id = c.id AND o.role = 'teacher' AND o.user_id <> ?1)
        ORDER BY c.name COLLATE NOCASE`,
      userId
    );

  /** "3 Spielstände · 1 Ergebnis · Fortschritt 40 % · 12,3 KB · zuletzt gestern" */
  function dataSummary(a) {
    const parts = [];
    if (a.saves) parts.push(plural(a.saves, 'Spielstand', 'Spielstände'));
    if (a.results) parts.push(plural(a.results, 'Ergebnis', 'Ergebnisse'));
    if (a.scores) parts.push(plural(a.scores, 'Bestwert', 'Bestwerte'));
    if (a.progress !== null && a.progress !== undefined) parts.push(`Fortschritt ${Math.round(a.progress * 100)} %`);
    if (a.achievements) parts.push(plural(a.achievements, 'Erfolg', 'Erfolge'));
    if (a.files) parts.push(plural(a.files, 'Datei', 'Dateien'));
    if (a.save_bytes + a.file_bytes > 0) parts.push(formatBytes(a.save_bytes + a.file_bytes));
    if (!parts.length) parts.push('nur geöffnet');
    if (a.last_at) parts.push(`zuletzt ${formatAgo(a.last_at)}`);
    return parts.join(' · ');
  }

  const deleteAppButton = (req, a, opts = {}) =>
    postButton(req, `/meine-daten/app/${a.id}/loeschen`, opts.label || `Daten in „${a.name}“ löschen`, {
      kind: 'danger', size: 'sm', icon: 'trash', iconOnly: !opts.label,
      confirm: `Alle deine Daten in „${a.name}“ löschen?\nSpielstände, Ergebnisse, Bestwerte, Fortschritt, Erfolge und Dateien in dieser App werden endgültig gelöscht. Die App selbst bleibt.`,
      confirmLabel: 'Endgültig löschen',
    });

  // --------------------------------------------------------- overview

  app.get('/meine-daten', (req, res) => {
    const u = req.user;
    const classes = db.all(
      'SELECT c.id, c.name, c.archived_at, m.role, m.joined_at FROM class_members m JOIN classes c ON c.id = m.class_id WHERE m.user_id = ? ORDER BY c.name COLLATE NOCASE',
      u.id
    );
    const data = myAppData(u.id);
    const n = inventory(u.id);
    const ownApps = db.all('SELECT id, name FROM apps WHERE owner_id = ? ORDER BY name COLLATE NOCASE LIMIT 6', u.id);
    const favourites = db.all('SELECT a.id, a.name FROM favorites f JOIN apps a ON a.id = f.app_id WHERE f.user_id = ? ORDER BY a.name COLLATE NOCASE LIMIT 6', u.id);
    const bytes = data.reduce((sum, a) => sum + a.save_bytes + a.file_bytes, 0);
    // By membership, like services.deleteUser - not by the account's role: a teacher made a student keeps
    // their teacher memberships, and those classes still go with the account.
    const sole = soleTeacherClasses(u.id);
    const staff = access.isStaff(u);

    const classRows = classes.map((c) => {
      const viewable = access.canViewClass(u, c.id);
      const role = c.role === 'teacher' ? 'Lehrkraft' : 'Schüler/in';
      return row({
        href: viewable ? `/klassen/${c.id}` : '',
        title: c.name,
        sub: `${role} · seit ${formatDate(c.joined_at)}`,
        start: html`<span class="tile sm app-7" aria-hidden="true">${icon('school', { cls: 'sm' })}</span>`,
        end: html`${c.archived_at ? badge('archiviert') : ''}${c.role === 'student' && !c.archived_at
          ? postButton(req, `/klassen/${c.id}/verlassen`, 'Verlassen', {
              size: 'sm',
              confirm: `„${c.name}“ verlassen?\nDu siehst die Apps, Aufgaben und Ankündigungen der Klasse dann nicht mehr. Deine Daten in den Apps bleiben. Zurück kommst du nur mit einem neuen QR-Code oder Link deiner Lehrkraft.`,
              confirmLabel: 'Klasse verlassen',
            })
          : ''}`,
        chevron: false,
      });
    });

    const more = (count, text, href = '') => (count ? html`${text}${href ? html` · <a href="${href}">ansehen</a>` : ''}` : html`<span class="muted">keine</span>`);
    const body = html`${pageHead({
      eyebrow: 'Datenschutz',
      title: 'Meine Daten',
      lead: `Hier siehst du alles, was ${config.hubName} über dich speichert. Du kannst es ansehen, herunterladen und löschen.`,
      actions: linkButton('/meine-daten/export', 'Alles herunterladen', { kind: 'primary', icon: 'download' }),
    })}
    ${stats([
      stat({ label: 'Apps mit deinen Daten', value: data.length, href: '#s-apps' }),
      stat({ label: 'Gespeichert', value: formatBytes(bytes), sub: 'Spielstände und Dateien' }),
      stat({ label: 'Klassen', value: classes.length, href: '#s-klassen' }),
      stat({ label: 'Eigene Apps', value: n.apps, href: n.apps ? '/apps' : '' }),
    ])}
    <div class="grid-2 mt-6"><div>
      <section class="section" aria-labelledby="s-konto">${sectionHead('Konto', { id: 's-konto' })}
        <dl class="kv school-kv">
          <div><dt>Name</dt><dd>${u.name}</dd></div>
          <div><dt>E-Mail</dt><dd>${u.email}</dd></div>
          <div><dt>Rolle</dt><dd>${ROLE_LABEL[u.role]}</dd></div>
          <div><dt>Konto angelegt</dt><dd>${formatDate(u.created_at)}</dd></div>
          <div><dt>Letzte Anmeldung</dt><dd>${formatDate(u.last_login_at)}</dd></div>
          <div><dt>Darstellung</dt><dd>${displaySummary(u)} · <a href="/einstellungen">ändern</a></dd></div>
          <div><dt>Bestenlisten</dt><dd>${u.anonymous_scores ? 'Du erscheinst als „Anonym“' : 'Mit deinem Namen (für deine Klassen)'} · <a href="/einstellungen#s-bestenlisten">ändern</a></dd></div>
        </dl>
        <p class="school-note">Name und E-Mail kommen aus deinem Microsoft-Schulkonto. Ein Passwort speichert ${config.hubName} nicht.</p>
      </section>

      <section class="section" aria-labelledby="s-klassen">${sectionHead('Klassen', { id: 's-klassen', count: classes.length ? String(classes.length) : null })}
        ${classes.length ? list(classRows) : empty({ icon: 'klassen', title: 'Du bist in keiner Klasse', text: 'Einer Klasse trittst du per QR-Code oder Link deiner Lehrkraft bei.' })}
      </section>

      <section class="section" aria-labelledby="s-apps">${sectionHead('Daten in Apps', { id: 's-apps', count: data.length ? String(data.length) : null, sub: 'Was Apps für dich gespeichert haben. Tippe auf eine App, um alles im Einzelnen zu sehen und Dateien herunterzuladen.' })}
        ${data.length
          ? list(data.map((a) => row({ href: `/meine-daten/app/${a.id}`, title: a.name, sub: dataSummary(a), start: appIcon(a), end: deleteAppButton(req, a) })))
          : empty({ icon: 'database', title: 'Noch keine App hat etwas für dich gespeichert', text: 'Sobald du eine App benutzt, siehst du hier, was sie speichert – und kannst es löschen.' })}
      </section>

      <section class="section" aria-labelledby="s-weitere">${sectionHead('Weitere Daten über dich', { id: 's-weitere' })}
        <dl class="kv school-kv">
          <div><dt>Eigene Apps</dt><dd>${n.apps ? html`${ownApps.map((a, i) => html`${i ? ', ' : ''}<a href="/apps/${a.id}">${a.name}</a>`)}${n.apps > ownApps.length ? ` und ${n.apps - ownApps.length} weitere` : ''}` : html`<span class="muted">keine</span>`}</dd></div>
          <div><dt>Favoriten</dt><dd>${n.favorites ? html`${favourites.map((a, i) => html`${i ? ', ' : ''}${a.name}`)}${n.favorites > favourites.length ? ` und ${n.favorites - favourites.length} weitere` : ''}` : html`<span class="muted">keine</span>`}</dd></div>
          <div><dt>Kommentare</dt><dd>${more(n.comments, `${plural(n.comments, 'Kommentar', 'Kommentare')} geschrieben`)}</dd></div>
          <div><dt>Rückmeldungen</dt><dd>${more(n.feedback, `${plural(n.feedback, 'Rückmeldung', 'Rückmeldungen')} von Lehrkräften${n.feedback_new ? `, ${n.feedback_new} neu` : ''}`, '/rueckmeldungen')}</dd></div>
          <div><dt>Erledigte Aufgaben</dt><dd>${more(n.done, `${plural(n.done, 'Aufgabe', 'Aufgaben')} als erledigt markiert`)}</dd></div>
          <div><dt>Mitteilungen</dt><dd>${more(n.notices, `${plural(n.notices, 'Mitteilung', 'Mitteilungen')}${n.notices_new ? `, ${n.notices_new} ungelesen` : ''}`, '/mitteilungen')}</dd></div>
          ${staff ? html`<div><dt>Für Klassen geschrieben</dt><dd>${n.announcements + n.assignments + n.feedback_written
            ? [n.announcements && plural(n.announcements, 'Ankündigung', 'Ankündigungen'), n.assignments && plural(n.assignments, 'Aufgabe', 'Aufgaben'), n.feedback_written && plural(n.feedback_written, 'Rückmeldung', 'Rückmeldungen')].filter(Boolean).join(' · ')
            : html`<span class="muted">nichts</span>`}</dd></div>` : ''}
          <div><dt>Ausgeblendet</dt><dd>${more(n.dismissed, plural(n.dismissed, 'Ankündigung', 'Ankündigungen'))}</dd></div>
          <div><dt>Protokoll</dt><dd>${n.audit ? `${plural(n.audit, 'Eintrag', 'Einträge')} (z. B. Anmeldungen), gelöscht nach ${plural(ctx.settings.get('retention.auditDays'), 'Tag', 'Tagen')}` : html`<span class="muted">keine</span>`}</dd></div>
        </dl>
      </section>
    </div><div>
      <section class="section panel" aria-labelledby="s-rechte">${sectionHead('Deine Rechte', { id: 's-rechte' })}
        <ul class="school-rights">
          <li><strong>Ansehen:</strong> Alles steht auf dieser Seite. Tippe auf eine App für alle Einzelheiten.</li>
          <li><strong>Herunterladen:</strong> „Alles herunterladen“ gibt dir eine Datei (JSON) mit Konto, Klassen, App-Daten, Rückmeldungen und Mitteilungen. Bilder und andere Dateien aus Apps lädst du bei der jeweiligen App herunter.</li>
          <li><strong>Löschen:</strong> die Daten einer App oder dein ganzes Konto.</li>
        </ul>
        <p class="school-note"><a href="/datenschutz">Was ${config.hubName} speichert und warum</a></p>
      </section>

      <section class="danger-zone school-danger" aria-labelledby="s-loeschen">
        <h2 id="s-loeschen">Konto löschen</h2>
        <p>Das kann nicht rückgängig gemacht werden. Gelöscht werden sofort:</p>
        <ul class="school-bullets">
          <li>dein Konto${classes.length ? ` und deine Mitgliedschaft in ${plural(classes.length, 'Klasse', 'Klassen')}` : ''}</li>
          <li>alles, was Apps für dich gespeichert haben${data.length ? ` (in ${plural(data.length, 'App', 'Apps')})` : ''}</li>
          ${n.apps ? html`<li>deine ${plural(n.apps, 'eigene App', 'eigenen Apps')} mit allen Versionen – und damit auch alles, was andere darin gespeichert haben</li>` : ''}
          ${sole.length ? html`<li>${sole.length === 1 ? 'die Klasse' : 'die Klassen'} ${sole.map((c, i) => html`${i ? ', ' : ''}„${c.name}“`)}, weil du dort die einzige Lehrkraft bist – mit Aufgaben und Rückmeldungen</li>` : ''}
          <li>deine Kommentare, Favoriten, Mitteilungen und Rückmeldungen an dich</li>
        </ul>
        <p>Im Protokoll steht danach nur noch „Gelöschtes Konto“. Meldest du dich später wieder an, beginnst du mit einem leeren Konto.</p>
        ${isLastAdmin(u)
          ? notice({ tone: 'wait', text: 'Du bist der einzige Admin. Ernenne zuerst in der Verwaltung jemand anderen zum Admin.' })
          : html`<form method="post" action="/meine-daten/konto-loeschen" class="stack mt-4" data-confirm="Dein Konto wirklich löschen?\nAlles oben Genannte wird sofort und endgültig gelöscht." data-confirm-label="Konto löschen" data-danger="1">${csrfField(req)}
            ${field(req, {
              label: 'Tippe zur Bestätigung LÖSCHEN', name: 'bestaetigung', hint: 'In Großbuchstaben, genau dieses Wort.', required: true,
              // The browser checks the word before the confirmation opens; the server checks it again.
              attrs: 'autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="20" pattern="\\s*LÖSCHEN\\s*" title="Bitte tippe genau LÖSCHEN in Großbuchstaben."',
            })}
            <button class="btn danger">Konto endgültig löschen</button></form>`}
      </section>
    </div></div>`;
    res.send(page(req, { title: 'Meine Daten', body, styles: ['css/school.css'] }));
  });

  // ------------------------------------------------------- one app

  /** The app, if this person has data in it or can open it - else 404. */
  function ownAppData(req) {
    const a = db.get('SELECT * FROM apps WHERE id = ?', String(req.params.aid));
    if (!a || !(hasData(a.id, req.user.id) || access.resolvePlay(req.user, a))) throw deny();
    return a;
  }

  app.get('/meine-daten/app/:aid', (req, res) => {
    const u = req.user;
    const a = ownAppData(req);
    const { achievements, labels } = vocabulary(a, u.id);
    const progress = db.get('SELECT value, label, updated_at FROM progress WHERE app_id = ? AND user_id = ?', a.id, u.id);
    const unlocked = db.all('SELECT achievement, unlocked_at FROM achievements WHERE app_id = ? AND user_id = ? ORDER BY unlocked_at DESC', a.id, u.id);
    const resultCount = db.get('SELECT COUNT(*) AS n FROM results WHERE app_id = ? AND user_id = ?', a.id, u.id).n;
    const results = db.all('SELECT title, score, max_score, details, created_at FROM results WHERE app_id = ? AND user_id = ? ORDER BY id DESC LIMIT 200', a.id, u.id);
    const saves = db.all('SELECT key, value, size, updated_at FROM saves WHERE app_id = ? AND user_id = ? ORDER BY key', a.id, u.id);
    const scores = db.all('SELECT board, score, updated_at FROM scores WHERE app_id = ? AND user_id = ? ORDER BY board', a.id, u.id);
    const files = userFiles.list(a.id, u.id);
    const play = db.get('SELECT first_at, last_at, count FROM plays WHERE app_id = ? AND user_id = ?', a.id, u.id);
    const openable = access.resolvePlay(u, a);
    const anything = progress || unlocked.length || results.length || saves.length || scores.length || files.length || play;
    const scoreText = (r) => (r.score === null ? '' : r.max_score === null ? String(r.score) : `${r.score} / ${r.max_score}`);

    const body = html`${pageHead({
      crumbs: [['/meine-daten', 'Meine Daten']],
      app: a,
      eyebrow: 'Deine Daten in',
      title: a.name,
      lead: 'Alles, was diese App für dich gespeichert hat.',
      meta: play ? html`<span>${icon('clock')}zuletzt geöffnet ${formatAgo(play.last_at)}</span>` : '',
      actions: html`${openable ? linkButton(`/apps/${a.id}/spielen`, 'Öffnen', { icon: 'play' }) : ''}${anything ? deleteAppButton(req, a, { label: 'Alles löschen' }) : ''}`,
    })}
    ${anything ? '' : empty({ icon: 'database', title: 'Diese App hat nichts für dich gespeichert', text: 'Wenn du sie benutzt, erscheinen hier deine Spielstände, Ergebnisse und Dateien.' })}

    ${progress ? html`<section class="section" aria-labelledby="s-fortschritt">${sectionHead('Fortschritt', { id: 's-fortschritt' })}
      <div class="panel ${appClass(a)}"><div class="meter-row"><span>${progress.label || 'Fortschritt'}</span><span class="num">${Math.round(progress.value * 100)} %</span>${meter(progress.value, { tone: 'app' })}</div>
      <p class="school-note">Stand ${formatDate(progress.updated_at)}</p></div></section>` : ''}

    ${unlocked.length ? html`<section class="section" aria-labelledby="s-erfolge">${sectionHead('Erfolge', { id: 's-erfolge', count: String(unlocked.length) })}
      ${list(unlocked.map((x) => {
        const def = achievements.get(x.achievement);
        return row({
          title: def ? def.title : x.achievement,
          sub: [def && def.description, `erreicht ${formatAgo(x.unlocked_at)}`].filter(Boolean).join(' · '),
          start: html`<span class="school-emoji" aria-hidden="true">${def ? def.emoji : '🏅'}</span>`,
        });
      }))}</section>` : ''}

    ${results.length ? html`<section class="section" aria-labelledby="s-ergebnisse">${sectionHead('Ergebnisse', { id: 's-ergebnisse', count: String(resultCount), sub: resultCount > results.length ? `Hier stehen die neuesten ${results.length}. Im Download sind alle.` : '' })}
      <div class="school-disclosures">${results.map((r) => html`<details class="disclosure">
        <summary><span class="school-entry"><strong>${r.title}</strong>${scoreText(r) ? html` ${badge(scoreText(r), '', { mono: true })}` : ''}</span><time class="school-entry-time">${formatDate(r.created_at)}</time></summary>
        <div class="disclosure-body">${r.details ? jsonView(parseJson(r.details), labels) : html`<p class="muted">Keine Einzelheiten gespeichert.</p>`}</div></details>`)}</div></section>` : ''}

    ${saves.length ? html`<section class="section" aria-labelledby="s-spielstaende">${sectionHead('Spielstände', { id: 's-spielstaende', count: String(saves.length) })}
      <div class="school-disclosures">${saves.map((s) => html`<details class="disclosure">
        <summary><span class="school-entry"><strong class="school-key">${s.key}</strong><span class="meta">${formatBytes(s.size)}</span></span><time class="school-entry-time">${formatDate(s.updated_at)}</time></summary>
        <div class="disclosure-body">${jsonView(parseJson(s.value), labels)}</div></details>`)}</div></section>` : ''}

    ${scores.length ? html`<section class="section" aria-labelledby="s-bestwerte">${sectionHead('Bestwerte', { id: 's-bestwerte', count: String(scores.length) })}
      ${dataTable({ columns: [{ label: 'Bestenliste', key: 'board', primary: true }, { label: 'Bestwert', key: 'score', num: true }, { label: 'Erreicht', render: (s) => formatDate(s.updated_at) }], rows: scores })}</section>` : ''}

    ${files.length ? html`<section class="section" aria-labelledby="s-dateien">${sectionHead('Dateien', { id: 's-dateien', count: String(files.length), sub: 'Dateien, die die App für dich gespeichert hat, zum Beispiel Bilder.' })}
      ${dataTable({
        columns: [
          { label: 'Name', key: 'name', primary: true },
          { label: 'Art', render: (f) => fileKind(f.type)[0] },
          { label: 'Größe', render: (f) => formatBytes(f.size), num: true },
          { label: 'Gespeichert', render: (f) => formatDate(f.updated_at) },
          { label: 'Herunterladen', actions: true, render: (f) => linkButton(`/meine-daten/app/${a.id}/datei/${encodeURIComponent(f.name)}`, `${f.name} herunterladen`, { size: 'sm', icon: 'download', iconOnly: true }) },
        ],
        rows: files,
      })}</section>` : ''}

    ${play ? html`<section class="section" aria-labelledby="s-nutzung">${sectionHead('Nutzung', { id: 's-nutzung' })}
      <dl class="kv school-kv"><div><dt>Zum ersten Mal geöffnet</dt><dd>${formatDate(play.first_at)}</dd></div>
        <div><dt>Zuletzt geöffnet</dt><dd>${formatDate(play.last_at)}</dd></div>
        <div><dt>Wie oft</dt><dd>${plural(play.count, 'Mal', 'Mal')}</dd></div></dl></section>` : ''}`;
    res.send(page(req, { title: `Meine Daten: ${a.name}`, body, styles: ['css/school.css'] }));
  });

  /** One of the person's own files from an app, always as a download. */
  app.get('/meine-daten/app/:aid/datei/:name', (req, res) => {
    const name = String(req.params.name);
    const f = KEY.test(name) ? userFiles.get(String(req.params.aid), req.user.id, name) : null;
    if (!f) throw deny();
    const ext = fileKind(f.type)[1];
    const filename = name.toLowerCase().endsWith(`.${ext}`) ? name : `${name}.${ext}`;
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/[^A-Za-z0-9_.-]/g, '_')}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(userFiles.read(f));
  });

  app.post('/meine-daten/app/:aid/loeschen', (req, res) => {
    // Deleting only ever touches the person's own rows; the app may be gone from their classes.
    const a = db.get('SELECT id, name FROM apps WHERE id = ?', String(req.params.aid));
    if (!a) throw deny();
    services.deleteAppData(a.id, req.user.id);
    flash(req, `Deine Daten in „${a.name}“ wurden gelöscht.`);
    res.redirect(303, '/meine-daten');
  });

  /** "In Bestenlisten anonym" - the one switch for users.anonymous_scores (also shown on /einstellungen). */
  app.post('/meine-daten/anonym', (req, res) => {
    const on = req.body.anonym === '1';
    db.run('UPDATE users SET anonymous_scores = ? WHERE id = ?', on ? 1 : 0, req.user.id);
    flash(req, on ? 'Gespeichert: In Bestenlisten steht jetzt „Anonym“ statt deines Namens.' : 'Gespeichert: In Bestenlisten sehen deine Klassen wieder deinen Namen.');
    const back = req.body.zurueck === '/einstellungen' ? '/einstellungen' : '/meine-daten';
    res.redirect(303, isLocalPath(back) ? back : '/meine-daten');
  });

  // ---------------------------------------------------------- export
  // The download is written piece by piece (src/jsonStream.js), with the same
  // content and format as one JSON.stringify(…, null, 2): the lists that can be
  // long - results, saves, comments, feedback, the apps - are read a page at a
  // time while the file is sent, so it is never in memory as a whole. One
  // person runs at most L.parallelExports downloads at a time.

  const exporting = new Map(); // user id -> downloads being written

  /**
   * Rows of a long list, a page at a time: first the ordered row ids (small),
   * then `size` rows per query. rowSql takes the ids (JSON) as its first
   * parameter, then `params` again - so every page checks the owner again.
   */
  function* paged(idSql, rowSql, params, size) {
    const ids = db.all(idSql, ...params).map((r) => r.id);
    for (let i = 0; i < ids.length; i += size) yield* db.all(rowSql, JSON.stringify(ids.slice(i, i + size)), ...params);
  }
  function* mapped(rows, fn) {
    for (const r of rows) yield fn(r);
  }

  /** One app in the download: what it stores for this person. Saves and results are lazy. */
  function appExport(a, u, fileUrl) {
    const { achievements } = vocabulary(a, u.id);
    const progress = db.get('SELECT value, label, updated_at FROM progress WHERE app_id = ? AND user_id = ?', a.id, u.id);
    const play = db.get('SELECT first_at, last_at, count FROM plays WHERE app_id = ? AND user_id = ?', a.id, u.id);
    return {
      app: a.name,
      spielstaende: lazy(() => mapped(
        paged('SELECT rowid AS id FROM saves WHERE app_id = ? AND user_id = ? ORDER BY key',
          'SELECT key, value, updated_at FROM saves WHERE rowid IN (SELECT value FROM json_each(?)) AND app_id = ? AND user_id = ? ORDER BY key', [a.id, u.id], 20),
        (s) => ({ schluessel: s.key, wert: parseJson(s.value), geaendert: iso(s.updated_at) })
      )),
      ergebnisse: lazy(() => mapped(
        paged('SELECT id FROM results WHERE app_id = ? AND user_id = ? ORDER BY id',
          'SELECT title, score, max_score, details, created_at FROM results WHERE id IN (SELECT value FROM json_each(?)) AND app_id = ? AND user_id = ? ORDER BY id', [a.id, u.id], 20),
        (r) => ({ titel: r.title, punkte: r.score, maximal: r.max_score, einzelheiten: r.details ? parseJson(r.details) : null, zeitpunkt: iso(r.created_at) })
      )),
      bestwerte: db.all('SELECT board, score, updated_at FROM scores WHERE app_id = ? AND user_id = ? ORDER BY board', a.id, u.id).map((s) => ({ liste: s.board, wert: s.score, erreicht: iso(s.updated_at) })),
      fortschritt: progress ? { wert: progress.value, text: progress.label, geaendert: iso(progress.updated_at) } : null,
      erfolge: db.all('SELECT achievement, unlocked_at FROM achievements WHERE app_id = ? AND user_id = ? ORDER BY unlocked_at', a.id, u.id).map((x) => {
        const def = achievements.get(x.achievement);
        return { id: x.achievement, titel: def ? def.title : x.achievement, erreicht: iso(x.unlocked_at) };
      }),
      dateien: userFiles.list(a.id, u.id).map((f) => ({ name: f.name, art: f.type, groesse: f.size, gespeichert: iso(f.updated_at), herunterladen: fileUrl(a.id, f.name) })),
      nutzung: play ? { zuerst: iso(play.first_at), zuletzt: iso(play.last_at), anzahl: play.count } : null,
    };
  }

  /** Everything about one person, as the download lists it. Short lists are read now, long ones while writing. */
  function exportDoc(u) {
    const fileUrl = (appId, name) => `${config.hubOrigin}/meine-daten/app/${appId}/datei/${encodeURIComponent(name)}`;
    return {
      erstellt: iso(Date.now()),
      hinweis: `Alles, was ${config.hubName} über dich speichert. Andere Personen erscheinen höchstens mit ihrem Namen. Dateien aus Apps sind mit Namen, Art und Größe aufgeführt; herunterladen kannst du sie über den Link.`,
      konto: {
        name: u.name, email: u.email, rolle: ROLE_LABEL[u.role], angelegt: iso(u.created_at), letzteAnmeldung: iso(u.last_login_at),
        anonymInBestenlisten: Boolean(u.anonymous_scores),
        darstellung: { farbschema: u.pref_theme, schriftgroesse: u.pref_text, bewegung: u.pref_motion, kontrast: u.pref_contrast },
      },
      klassen: db.all('SELECT c.name, m.role, m.joined_at FROM class_members m JOIN classes c ON c.id = m.class_id WHERE m.user_id = ? ORDER BY c.name', u.id)
        .map((c) => ({ name: c.name, rolle: c.role === 'teacher' ? 'Lehrkraft' : 'Schüler/in', seit: iso(c.joined_at) })),
      eigeneApps: db.all(`SELECT a.name, a.description, a.created_at, a.published_version_id,
                                 (SELECT COUNT(*) FROM app_versions v WHERE v.app_id = a.id AND v.status = 'ready') AS versions
                            FROM apps a WHERE a.owner_id = ? ORDER BY a.name`, u.id)
        .map((a) => ({ name: a.name, beschreibung: a.description, angelegt: iso(a.created_at), veroeffentlicht: Boolean(a.published_version_id), versionen: a.versions })),
      kommentare: lazy(() => mapped(
        paged('SELECT c.rowid AS id FROM comments c JOIN apps a ON a.id = c.app_id WHERE c.author_id = ? ORDER BY c.created_at, c.rowid',
          'SELECT a.name AS app, c.body, c.kind, c.created_at FROM comments c JOIN apps a ON a.id = c.app_id WHERE c.rowid IN (SELECT value FROM json_each(?)) AND c.author_id = ? ORDER BY c.created_at, c.rowid', [u.id], 200),
        (c) => ({ app: c.app, text: c.body, art: c.kind, zeitpunkt: iso(c.created_at) })
      )),
      favoriten: db.all('SELECT a.name, f.created_at FROM favorites f JOIN apps a ON a.id = f.app_id WHERE f.user_id = ? ORDER BY f.created_at', u.id)
        .map((f) => ({ app: f.name, seit: iso(f.created_at) })),
      // Feedback names its author by name only - never an e-mail address.
      rueckmeldungen: lazy(() => mapped(
        paged('SELECT f.rowid AS id FROM feedback f JOIN classes c ON c.id = f.class_id WHERE f.student_id = ? ORDER BY f.created_at, f.rowid',
          `SELECT f.body, f.created_at, f.read_at, c.name AS class_name, a.name AS app_name, x.title AS assignment, w.name AS author
             FROM feedback f JOIN classes c ON c.id = f.class_id LEFT JOIN apps a ON a.id = f.app_id
             LEFT JOIN assignments x ON x.id = f.assignment_id LEFT JOIN users w ON w.id = f.author_id
            WHERE f.rowid IN (SELECT value FROM json_each(?)) AND f.student_id = ? ORDER BY f.created_at, f.rowid`, [u.id], 200),
        (f) => ({ text: f.body, von: f.author || 'Gelöschtes Konto', klasse: f.class_name, app: f.app_name, aufgabe: f.assignment, zeitpunkt: iso(f.created_at), gelesen: iso(f.read_at) })
      )),
      erledigteAufgaben: db.all(
        `SELECT x.title, c.name AS class_name, a.name AS app_name, d.done_at FROM assignment_done d
           JOIN assignments x ON x.id = d.assignment_id JOIN classes c ON c.id = x.class_id JOIN apps a ON a.id = x.app_id
          WHERE d.user_id = ? ORDER BY d.done_at`, u.id
      ).map((d) => ({ aufgabe: d.title, klasse: d.class_name, app: d.app_name, erledigt: iso(d.done_at) })),
      mitteilungen: db.all('SELECT text, created_at, read_at FROM notices WHERE user_id = ? ORDER BY id', u.id)
        .map((m) => ({ text: m.text, zeitpunkt: iso(m.created_at), gelesen: iso(m.read_at) })),
      ankuendigungen: db.all('SELECT an.title, an.body, an.created_at, an.expires_at, c.name AS class_name FROM announcements an LEFT JOIN classes c ON c.id = an.class_id WHERE an.author_id = ? ORDER BY an.created_at', u.id)
        .map((an) => ({ titel: an.title, text: an.body, fuer: an.class_name || 'Ganze Schule', angelegt: iso(an.created_at), bis: iso(an.expires_at) })),
      ausgeblendeteAnkuendigungen: db.all('SELECT an.title FROM announcement_dismissed d JOIN announcements an ON an.id = d.announcement_id WHERE d.user_id = ?', u.id).map((r) => r.title),
      angelegteAufgaben: db.all('SELECT x.title, x.note, x.due_at, x.created_at, c.name AS class_name, a.name AS app_name FROM assignments x JOIN classes c ON c.id = x.class_id JOIN apps a ON a.id = x.app_id WHERE x.created_by = ? ORDER BY x.created_at', u.id)
        .map((x) => ({ titel: x.title, notiz: x.note, klasse: x.class_name, app: x.app_name, faellig: iso(x.due_at), angelegt: iso(x.created_at) })),
      // Only what happened and when: the details may name other people.
      protokoll: db.all('SELECT action, at FROM audit_log WHERE actor_id = ? ORDER BY id DESC LIMIT 1000', u.id).map((r) => ({ vorgang: auditLabel(r.action), zeitpunkt: iso(r.at) })),
      appDaten: lazy(function* () {
        for (const row of myAppData(u.id)) {
          const a = db.get('SELECT * FROM apps WHERE id = ?', row.id);
          if (a) yield appExport(a, u, fileUrl); // an app deleted while the file is written is left out
        }
      }),
    };
  }

  app.get('/meine-daten/export', async (req, res) => {
    const u = req.user;
    const running = exporting.get(u.id) || 0;
    if (running >= L.parallelExports) throw new HttpError(429, 'Dein Download wird gerade schon erstellt. Warte, bis er fertig ist – dann kannst du ihn noch einmal starten.');
    exporting.set(u.id, running + 1);
    let held = true;
    const release = () => {
      if (!held) return;
      held = false;
      const n = (exporting.get(u.id) || 1) - 1;
      if (n > 0) exporting.set(u.id, n);
      else exporting.delete(u.id);
    };
    res.once('finish', release);
    res.once('close', release);
    const doc = exportDoc(u); // an error here is answered with the usual error page
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="meine-daten.json"');
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.method === 'HEAD') return res.end();
    try {
      await writeJson(res, doc);
    } catch (err) {
      if (!res.headersSent) {
        // Nothing sent yet: the usual error page instead of the download.
        res.removeHeader('Content-Disposition');
        res.removeHeader('Content-Type');
        throw err;
      }
      // Half a file must never look like a whole one: break the connection instead of ending the response.
      console.error(err);
      res.destroy();
    }
  });

  // ------------------------------------------------- delete account

  app.post('/meine-daten/konto-loeschen', (req, res) => {
    // Exactly the word, in capitals (only surrounding spaces and Unicode form are forgiven).
    if (cleanText(req.body.bestaetigung, 40) !== 'LÖSCHEN') throw bad('Bitte tippe zur Bestätigung genau das Wort LÖSCHEN in Großbuchstaben.');
    if (isLastAdmin(req.user)) throw bad('Der einzige Admin kann sein Konto nicht löschen. Ernenne zuerst jemand anderen zum Admin.');
    services.deleteUser(req.user, req.user);
    req.session.destroy(() => {
      res.clearCookie(config.https ? '__Host-hub_sid' : 'hub_sid', { path: '/', secure: config.https, httpOnly: true, sameSite: 'lax' });
      res.redirect(303, '/?geloescht=1');
    });
  });
};
