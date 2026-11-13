'use strict';
// School (package D): display settings, search, the app catalogue ("Entdecken")
// and announcements. Every list here comes from the permission-filtered
// queries in access.js (visibleApps, visibleClasses) or is checked row by row
// with access.js, so nobody ever finds what they could not open anyway.

const {
  html, raw, page, flash, csrfField, postButton, linkButton, appIcon, avatar, icon, badge, meter,
  pageHead, sectionHead, list, row, empty, notice, field,
} = require('../html');
const { deny, bad, cleanText, newId, formatAgo, formatDay, plural, dayKey } = require('../util');
const { CATEGORIES } = require('../manifest');
const {
  queryText, queryChoice, pageNumber, pager, selectControl, segmented, filterPanel, likePattern, parseDay, dayStart, DISPLAY_PREFS,
} = require('../formKit');

const DAY = 86_400_000;
const STYLES = ['css/school.css'];
const GRADES = Array.from({ length: 13 }, (_, i) => i + 1);

module.exports = (app, ctx) => {
  const { db, config, access, services } = ctx;

  // ================================================================ settings

  app.get('/einstellungen', (req, res) => {
    const u = req.user;
    const body = html`${pageHead({
      eyebrow: 'Einstellungen',
      title: 'Darstellung und Barrierefreiheit',
      lead: `So zeigt sich ${config.hubName} dir – auf jedem Gerät, auf dem du angemeldet bist.`,
    })}
    <div class="grid-2"><div>
      <section class="section" aria-labelledby="s-darstellung">${sectionHead('Darstellung', { id: 's-darstellung' })}
        <form method="post" action="/einstellungen" class="form school-settings">${csrfField(req)}
          ${DISPLAY_PREFS.map((p) => segmented({ name: p.field, legend: p.legend, options: p.options, value: u[p.column], hint: p.hint }))}
          <div class="actions"><button class="btn primary">Speichern</button></div>
        </form>
      </section>
      <section class="section" aria-labelledby="s-bestenlisten">${sectionHead('Bestenlisten', { id: 's-bestenlisten' })}
        <form method="post" action="/meine-daten/anonym" class="panel school-switch-form" data-autosubmit>${csrfField(req)}
          <input type="hidden" name="zurueck" value="/einstellungen">
          <label class="switch"><span class="school-switch-text"><strong>In Bestenlisten anonym erscheinen</strong>
            <small>Dann steht dort „Anonym“ statt deines Namens – auch für deine Klassen. Du selbst siehst deinen Namen weiter.</small></span>
            <input type="checkbox" name="anonym" value="1"${u.anonymous_scores ? raw(' checked') : ''}></label>
          <div class="actions"><button class="btn sm">Speichern</button></div>
        </form>
      </section>
    </div>
    <aside class="section" aria-labelledby="s-vorschau">${sectionHead('Vorschau', { id: 's-vorschau', sub: 'So sehen Texte und Bedienelemente mit deinen gespeicherten Einstellungen aus.' })}
      <div class="panel school-preview" aria-hidden="true">
        <div class="school-preview-head"><span class="tile app-1">🔤</span><div class="school-preview-text"><span class="eyebrow">Weitermachen</span>
          <strong class="school-preview-title">Vokabeltrainer</strong><span class="meta">7b Englisch · zuletzt gestern</span></div></div>
        <p>Übe die Wörter der Woche. Klare Schrift und deutliche Kontraste helfen beim Lesen.</p>
        <div class="meter-row app-1"><span class="meta">12 von 20 Wörtern</span><span class="num">60 %</span>${meter(0.6, { tone: 'app' })}</div>
        <div class="school-preview-badges">${badge('erledigt', 'ok')}${badge('heute fällig', 'wait')}${badge('überfällig', 'danger')}</div>
        <div class="actions"><span class="btn primary">Weiter</span><span class="btn">Später</span></div>
      </div>
    </aside></div>`;
    res.send(page(req, { title: 'Darstellung', body, styles: STYLES }));
  });

  /** Saves only the signed-in person's own display settings; every value must be one of the fixed ones. */
  app.post('/einstellungen', (req, res) => {
    const u = req.user;
    const next = {};
    for (const p of DISPLAY_PREFS) {
      const v = req.body[p.field];
      if (v === undefined) continue; // not sent: stays as it is
      if (typeof v !== 'string' || !p.options.some(([o]) => o === v)) throw bad(`Diese Auswahl gibt es nicht (${p.legend}).`);
      next[p.column] = v;
    }
    if (!Object.keys(next).length) throw bad('Es wurde nichts ausgewählt.');
    const value = (col) => next[col] ?? u[col];
    db.run('UPDATE users SET pref_theme = ?, pref_text = ?, pref_motion = ?, pref_contrast = ? WHERE id = ?', value('pref_theme'), value('pref_text'), value('pref_motion'), value('pref_contrast'), u.id);
    flash(req, `Gespeichert. So sieht ${config.hubName} jetzt für dich aus – auf allen deinen Geräten.`);
    res.redirect(303, '/einstellungen');
  });

  // ================================================================ apps: shared

  /** Owners, class names and favourites for a list of visible apps, in three queries. */
  function catalogInfo(user, apps) {
    const ids = JSON.stringify(apps.map((a) => a.id));
    const owners = new Map(db.all('SELECT id, name, role FROM users WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify([...new Set(apps.map((a) => a.owner_id))])).map((o) => [o.id, o]));
    const classNames = new Map();
    for (const r of db.all(
      `SELECT ca.app_id, c.name FROM class_apps ca JOIN class_members m ON m.class_id = ca.class_id AND m.user_id = ?
         JOIN classes c ON c.id = ca.class_id AND c.archived_at IS NULL
        WHERE ca.status = 'approved' AND ca.app_id IN (SELECT value FROM json_each(?)) ORDER BY c.name COLLATE NOCASE`,
      user.id, ids
    )) {
      if (!classNames.has(r.app_id)) classNames.set(r.app_id, []);
      classNames.get(r.app_id).push(r.name);
    }
    const favorites = new Set(db.all('SELECT app_id FROM favorites WHERE user_id = ?', user.id).map((r) => r.app_id));
    return { owners, classNames, favorites };
  }

  /**
   * "Englisch · Klasse 5–7 · Aus 7b Englisch". A student's name is only shown to
   * people who share a class with the app (they see it on the class page anyway);
   * everywhere else a student-made app just says so.
   */
  function appMeta(a, info) {
    const parts = [];
    if (a.category) parts.push(a.category);
    if (a.grade_min) parts.push(a.grade_max && a.grade_max !== a.grade_min ? `Klasse ${a.grade_min}–${a.grade_max}` : `Klasse ${a.grade_min}`);
    const owner = info.owners.get(a.owner_id);
    const classes = info.classNames.get(a.id) || [];
    if (a.mine) parts.push('Deine App');
    else if (classes.length) parts.push(`Aus ${classes.slice(0, 2).join(', ')}${classes.length > 2 ? ' …' : ''}`);
    else if (a.shared_staff && owner) parts.push(`Geteilt von ${owner.name}`);
    else if (a.schoolwide) parts.push('Für die ganze Schule');
    if (!a.mine && owner && owner.role === 'student') parts.push(classes.length ? `von ${owner.name}` : 'von Schüler/innen gebaut');
    return parts.join(' · ');
  }

  /**
   * One app in a list: the whole row opens it; buttons at the end stay separate. A row comes from
   * access.visibleApps, which says how the person may open it: a colleague's shared app that is
   * not theirs, in one of their classes or school-wide opens as a preview of its published version
   * (access.resolvePlay) - nothing is stored, and the colleague can try it before adding it.
   */
  function appListRow(a, info, end = '') {
    const desc = String(a.description || '').split('\n')[0].slice(0, 160);
    const fav = info.favorites.has(a.id) ? html`<span class="school-fav" title="Favorit">${icon('heart', { cls: 'sm filled', label: 'Favorit' })}</span>` : '';
    // Only a row with buttons wraps on phones; otherwise the chevron stays beside the text.
    return html`<li class="row school-app-row${end ? ' wrap' : ''}">${appIcon(a)}<div class="row-main">
      <a class="row-link row-title" href="/apps/${a.id}/spielen">${a.name}</a>
      ${desc ? html`<span class="row-sub clamp">${desc}</span>` : ''}
      <span class="school-meta">${appMeta(a, info)}</span></div>
      <div class="row-end${end ? ' school-app-end' : ''}">${fav}${end}${icon('chevronRight', { cls: 'chev' })}</div></li>`;
  }

  // ================================================================ search

  /** Students in classes this staff member teaches whose name matches (bounded). */
  function findStudents(user, q) {
    return db
      .all(
        `SELECT u.id, u.name, c.id AS class_id, c.name AS class_name, c.archived_at
           FROM class_members t JOIN classes c ON c.id = t.class_id
           JOIN class_members s ON s.class_id = t.class_id AND s.role = 'student'
           JOIN users u ON u.id = s.user_id
          WHERE t.user_id = ? AND t.role = 'teacher' AND u.name LIKE ? ESCAPE '\\'
          ORDER BY u.name COLLATE NOCASE, c.name COLLATE NOCASE LIMIT 41`,
        user.id, likePattern(q)
      )
      .filter((r) => access.canManageClass(user, r.class_id) && access.isStudentOf(r.class_id, r.id));
  }

  /**
   * The search shows an app only if the query starts a word of its name or
   * description, so a short, name-like query ("Ben") does not find an app
   * because its text says "üben". Longer queries also match inside words
   * (German compounds: "trainer" finds "Vokabeltrainer").
   */
  function appMatches(a, q) {
    const at = new RegExp(`(?:^|[^\\p{L}\\p{N}])${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'iu');
    const has = (text) => String(text || '').toLocaleLowerCase('de').includes(q.toLocaleLowerCase('de'));
    return at.test(a.name) || at.test(a.description || '') || (q.length >= 5 && has(a.name)) || (q.length >= 6 && has(a.description));
  }

  app.get('/suche', (req, res) => {
    const u = req.user;
    const staff = access.isStaff(u);
    const q = queryText(req, 'q', 60);
    const searching = q.length >= 2;
    // visibleApps decides what may be shown; appMatches only narrows its text match.
    const apps = searching ? access.visibleApps(u, { q, limit: 200 }).filter((a) => appMatches(a, q)) : [];
    const classes = searching ? [...access.visibleClasses(u, { q }), ...access.visibleClasses(u, { q, archived: true })] : [];
    const people = searching && staff ? findStudents(u, q) : [];
    const info = catalogInfo(u, apps.slice(0, 12));
    const total = apps.length + classes.length + people.length;
    const roleText = (c) => (c.my_role === 'teacher' ? 'Du unterrichtest' : c.my_role === 'student' ? 'Du bist Schüler/in' : 'Verwaltung');

    const results = html`
      <p class="school-summary" role="status">${plural(total, 'Treffer', 'Treffer')} für „${q}“</p>
      ${apps.length ? html`<section class="section" aria-labelledby="s-apps">${sectionHead('Apps', { id: 's-apps', count: apps.length >= 200 ? '200+' : String(apps.length), actions: apps.length > 12 ? linkButton(`/katalog?q=${encodeURIComponent(q)}`, 'Alle im Katalog', { kind: 'quiet', size: 'sm' }) : '' })}
        ${list(apps.slice(0, 12).map((a) => appListRow(a, info)))}</section>` : ''}
      ${classes.length ? html`<section class="section" aria-labelledby="s-klassen">${sectionHead('Klassen', { id: 's-klassen', count: String(classes.length) })}
        ${list(classes.slice(0, 12).map((c) => row({
          href: `/klassen/${c.id}`, title: c.name, sub: roleText(c),
          start: html`<span class="tile sm app-7" aria-hidden="true">${icon('school', { cls: 'sm' })}</span>`,
          end: c.archived_at ? badge('archiviert') : '',
        })))}
        ${classes.length > 12 ? html`<p class="school-note">Es werden die ersten 12 gezeigt – gib mehr vom Namen ein.</p>` : ''}</section>` : ''}
      ${people.length ? html`<section class="section" aria-labelledby="s-personen">${sectionHead('Schüler/innen', { id: 's-personen', count: people.length > 40 ? '40+' : String(people.length), sub: 'Aus Klassen, die du unterrichtest.' })}
        ${list(people.slice(0, 20).map((p) => row({
          href: `/klassen/${p.class_id}`, title: p.name, start: avatar(p.name),
          sub: p.archived_at ? `${p.class_name} · archiviert` : p.class_name,
        })))}
        ${people.length > 20 ? html`<p class="school-note">Es werden die ersten 20 gezeigt – gib mehr vom Namen ein.</p>` : ''}</section>` : ''}
      ${access.isAdmin(u) ? html`<p class="school-note">Verwaltung: <a href="/admin/konten?q=${encodeURIComponent(q)}">„${q}“ in allen Konten suchen</a></p>` : ''}
      ${total ? '' : empty({
        icon: 'search', title: `Nichts gefunden für „${q}“`,
        text: staff ? 'Gesucht wird in Apps, die du öffnen kannst, in deinen Klassen und unter den Schüler/innen deiner Klassen. Prüfe die Schreibweise oder versuche einen kürzeren Begriff.'
          : 'Gesucht wird in Apps, die du öffnen kannst, und in deinen Klassen. Prüfe die Schreibweise oder versuche einen kürzeren Begriff.',
        actions: linkButton('/katalog', 'Alle Apps entdecken', { icon: 'apps' }),
      })}`;

    const body = html`${pageHead({ title: 'Suchen', lead: staff ? 'Apps, Klassen und Schüler/innen deiner Klassen.' : 'Apps und deine Klassen.' })}
      <form method="get" action="/suche" role="search" class="school-search">
        <label class="visually-hidden" for="suche-q">Suchbegriff</label>
        <input id="suche-q" type="search" name="q" value="${q}" maxlength="60" placeholder="${staff ? 'App, Klasse, Person' : 'App oder Klasse'}" autocomplete="off"${searching ? '' : raw(' autofocus')}>
        <button class="btn primary">${icon('search')}<span>Suchen</span></button>
      </form>
      ${searching ? results : q.length === 1 ? notice({ text: 'Bitte gib mindestens 2 Zeichen ein.' }) : html`<p class="school-note">Gib oben einen Suchbegriff ein – mindestens 2 Zeichen. ${staff ? 'Schüler/innen findest du nur aus Klassen, die du unterrichtest.' : ''}</p>`}`;
    res.send(page(req, { title: q ? `Suche: ${q}` : 'Suchen', body, width: 'narrow', styles: STYLES }));
  });

  // ================================================================ catalogue

  /** Own active classes in which this person may put an app at once (access.addToClassMode === 'approve'). */
  function addTargets(user) {
    if (!access.isStaff(user)) return null;
    const classes = db.all(
      `SELECT c.id, c.name FROM classes c JOIN class_members m ON m.class_id = c.id AND m.user_id = ? AND m.role = 'teacher'
        WHERE c.archived_at IS NULL ORDER BY c.name COLLATE NOCASE LIMIT 100`,
      user.id
    );
    // Already playable or waiting for review there: nothing to add.
    const present = new Set(db.all(
      `SELECT ca.class_id || '/' || ca.app_id AS k FROM class_apps ca JOIN class_members m ON m.class_id = ca.class_id AND m.user_id = ? AND m.role = 'teacher'
        WHERE ca.status IN ('approved', 'pending')`,
      user.id
    ).map((r) => r.k));
    return (a) => classes.filter((c) => !present.has(`${c.id}/${a.id}`) && access.addToClassMode(user, a, c.id) === 'approve');
  }

  function addControl(req, a, targets) {
    if (!targets || !targets.length) return '';
    // Long class names must wrap instead of pushing the row wider than a phone.
    const cls = 'btn sm school-wrap-btn';
    if (targets.length === 1) {
      const t = targets[0];
      return postButton(req, `/klassen/${t.id}/apps`, `Zu ${t.name} hinzufügen`, { cls, icon: 'plus', fields: { app: a.id } });
    }
    return html`<details class="school-add"><summary class="btn sm">${icon('plus')}<span>Zur Klasse hinzufügen</span></summary>
      <div class="school-add-panel"><span class="school-hint">Sofort freigegeben in:</span>
        ${targets.map((t) => postButton(req, `/klassen/${t.id}/apps`, t.name, { cls, fields: { app: a.id } }))}</div></details>`;
  }

  app.get('/katalog', (req, res) => {
    const u = req.user;
    const staff = access.isStaff(u);
    const sources = [['', 'Alle'], ['favoriten', 'Favoriten'], ['klassen', 'Aus deinen Klassen'], ['schule', 'Ganze Schule'], ['schueler', 'Von Schüler/innen'], ...(staff ? [['kollegium', 'Von Kolleg/innen']] : [])];
    const q = queryText(req, 'q', 60);
    const fach = queryChoice(req, 'fach', CATEGORIES);
    const stufe = Number(queryChoice(req, 'stufe', GRADES.map(String))) || null;
    const zeige = queryChoice(req, 'zeige', sources.map(([v]) => v).filter(Boolean));
    const filtered = Boolean(q || fach || stufe || zeige);

    const visible = access.visibleApps(u, { q, category: fach, limit: 200 });
    const info = catalogInfo(u, visible);
    const apps = visible.filter((a) => {
      if (stufe && !(a.grade_min && a.grade_min <= stufe && (a.grade_max || a.grade_min) >= stufe)) return false;
      switch (zeige) {
        case 'favoriten': return info.favorites.has(a.id);
        case 'klassen': return Boolean(a.in_class);
        case 'schule': return Boolean(a.schoolwide);
        case 'schueler': return info.owners.get(a.owner_id)?.role === 'student';
        case 'kollegium': return Boolean(a.shared_staff) && !a.mine;
        default: return true;
      }
    });
    const per = 24;
    const pages = Math.max(1, Math.ceil(apps.length / per));
    const pageNo = Math.min(pageNumber(req), pages);
    const shown = apps.slice((pageNo - 1) * per, pageNo * per);
    const targetsFor = addTargets(u);

    const active = [q && `„${q}“`, fach, stufe && `Klasse ${stufe}`, zeige && sources.find(([v]) => v === zeige)[1]].filter(Boolean);
    const filters = html`<form method="get" action="/katalog" class="school-filters school-filters-fold" data-autosubmit aria-label="Apps filtern">
      ${filterPanel({
        summary: active.length ? active.join(' · ') : 'Alle Apps',
        open: req.query.offen === '1',
        body: html`<div class="school-filter-grid">
          <div class="field school-filter-q"><label for="f-q">Suchen</label>
            <div class="school-inline"><input id="f-q" type="search" name="q" value="${q}" maxlength="60" placeholder="Name oder Beschreibung" autocomplete="off">
            <button class="btn icon school-search-btn" aria-label="Suchen" title="Suchen">${icon('search')}</button></div></div>
          <div class="field"><label for="f-fach">Fach</label>${selectControl(req, { name: 'fach', options: [['', 'Alle Fächer'], ...CATEGORIES.map((c) => [c, c])], value: fach })}</div>
          <div class="field"><label for="f-stufe">Klassenstufe</label>${selectControl(req, { name: 'stufe', options: [['', 'Alle Stufen'], ...GRADES.map((g) => [String(g), `Klasse ${g}`])], value: stufe ? String(stufe) : '' })}</div>
        </div>
        ${segmented({ name: 'zeige', legend: 'Zeigen', options: sources, value: zeige, scroll: true })}`,
      })}
    </form>`;

    const body = html`${pageHead({
      title: 'Entdecken',
      lead: staff ? 'Alle Apps, die du öffnen kannst: aus deinen Klassen, für die ganze Schule und von Kolleg/innen geteilt.' : 'Alle Apps, die du öffnen kannst: aus deinen Klassen und für die ganze Schule.',
    })}
    ${filters}
    <section class="section" aria-labelledby="s-ergebnis">
      ${sectionHead(apps.length === 1 ? '1 App' : `${apps.length >= 200 ? '200+' : apps.length} Apps`, { id: 's-ergebnis', actions: filtered ? linkButton('/katalog', 'Filter zurücksetzen', { kind: 'quiet', size: 'sm', icon: 'x' }) : '' })}
      ${visible.length >= 200 ? notice({ text: 'Es werden höchstens 200 Apps durchsucht. Grenze mit Fach oder Suchbegriff weiter ein.', cls: 'mb-4' }) : ''}
      ${shown.length ? list(shown.map((a) => appListRow(a, info, addControl(req, a, targetsFor && targetsFor(a)))))
        : filtered ? empty({ icon: 'search', title: 'Keine App passt zu diesen Filtern', text: 'Lass einen Filter weg oder suche nach einem anderen Begriff.', actions: linkButton('/katalog', 'Filter zurücksetzen') })
          : empty({
            icon: 'apps', title: 'Noch keine Apps für dich',
            text: staff ? 'Hier erscheinen Apps aus deinen Klassen, Apps für die ganze Schule und Apps, die Kolleg/innen teilen. Oder du baust selbst eine.'
              : 'Hier erscheinen die Apps deiner Klassen und Apps für die ganze Schule. Tritt einer Klasse bei – oder bau selbst eine App.',
            actions: linkButton('/apps', 'Eigene App bauen', { icon: 'bauen' }),
          })}
      ${pager({ base: '/katalog', params: { q, fach, stufe: stufe || '', zeige }, page: pageNo, pages })}
    </section>`;
    res.send(page(req, { title: 'Entdecken', body, active: 'entdecken', styles: STYLES }));
  });

  // ================================================================ announcements

  /** Classes this person may write to (access.canAnnounce): their own active classes; for the admin all of them. */
  function announceTargets(user) {
    const candidates = access.isAdmin(user)
      ? db.all('SELECT id, name FROM classes WHERE archived_at IS NULL ORDER BY name COLLATE NOCASE LIMIT 500')
      : db.all(
          `SELECT c.id, c.name FROM classes c JOIN class_members m ON m.class_id = c.id AND m.user_id = ? AND m.role = 'teacher'
            WHERE c.archived_at IS NULL ORDER BY c.name COLLATE NOCASE`,
          user.id
        );
    return candidates.filter((c) => access.canAnnounce(user, c.id));
  }

  /** "2026-11-20" -> the end of that day in school time; '' -> null. */
  function parseEnd(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    const day = parseDay(value);
    if (!day) throw bad('Das Datum ist ungültig.');
    const end = dayStart({ ...day, d: day.d + 1 });
    if (end <= Date.now()) throw bad('Das Datum liegt in der Vergangenheit.');
    if (end > Date.now() + 366 * DAY) throw bad('Eine Ankündigung kann höchstens ein Jahr lang sichtbar sein.');
    return end;
  }

  app.get('/ankuendigungen', (req, res) => {
    const u = req.user;
    if (!access.isStaff(u)) throw deny();
    const admin = access.isAdmin(u);
    const targets = announceTargets(u);
    const wanted = queryText(req, 'klasse', 40);
    const preselect = targets.some((c) => c.id === wanted) ? wanted : admin ? 'schule' : targets[0] ? targets[0].id : '';
    const items = (admin
      ? db.all(`SELECT an.*, c.name AS class_name, w.name AS author_name, (SELECT COUNT(*) FROM announcement_dismissed d WHERE d.announcement_id = an.id) AS hidden
                  FROM announcements an LEFT JOIN classes c ON c.id = an.class_id LEFT JOIN users w ON w.id = an.author_id
                 ORDER BY an.created_at DESC LIMIT 100`)
      : db.all(`SELECT an.*, c.name AS class_name, w.name AS author_name, (SELECT COUNT(*) FROM announcement_dismissed d WHERE d.announcement_id = an.id) AS hidden
                  FROM announcements an JOIN classes c ON c.id = an.class_id LEFT JOIN users w ON w.id = an.author_id
                 WHERE an.class_id IN (SELECT class_id FROM class_members WHERE user_id = ? AND role = 'teacher')
                 ORDER BY an.created_at DESC LIMIT 100`, u.id)
    ).filter((an) => access.canDeleteAnnouncement(u, an));
    const now = Date.now();
    const today = dayKey(now);
    const maxDay = dayKey(now + 365 * DAY);

    const form = targets.length || admin
      ? html`<form method="post" action="/ankuendigungen" class="form panel">${csrfField(req)}
          ${field(req, { label: 'Für', name: 'ziel', control: selectControl(req, { name: 'ziel', value: preselect, options: [...(admin ? [['schule', 'Ganze Schule']] : []), { group: 'Klassen', options: targets.map((c) => [c.id, c.name]) }] }) })}
          ${field(req, { label: 'Titel', name: 'titel', required: true, hint: 'Kurz und klar, höchstens 120 Zeichen.', attrs: 'maxlength="120" autocomplete="off"' })}
          ${field(req, { label: 'Text (freiwillig)', name: 'text', type: 'textarea', hint: 'Höchstens 1000 Zeichen. Der Text erscheint genau so, wie du ihn schreibst – ohne Links oder Formatierung.', attrs: 'maxlength="1000" rows="4"' })}
          ${field(req, { label: 'Sichtbar bis (freiwillig)', name: 'bis', type: 'date', hint: 'Danach verschwindet sie von den Startseiten. Ohne Datum bleibt sie, bis sie gelöscht wird.', attrs: `min="${today}" max="${maxDay}"` })}
          <div class="actions"><button class="btn primary">${icon('megaphone')}<span>Veröffentlichen</span></button></div>
        </form>`
      : empty({ icon: 'megaphone', title: 'Du unterrichtest noch keine Klasse', text: 'Ankündigungen schreibst du für deine eigenen Klassen. An die ganze Schule schreibt die Verwaltung.', actions: linkButton('/klassen', 'Zu den Klassen') });

    const body = html`${pageHead({
      title: 'Ankündigungen',
      lead: admin
        ? 'Kurze Nachrichten an die ganze Schule oder an eine Klasse. Sie stehen oben auf der Startseite, bis sie ablaufen, gelöscht oder ausgeblendet werden.'
        : 'Kurze Nachrichten an deine Klassen. Sie stehen oben auf der Startseite deiner Schüler/innen, bis sie ablaufen, gelöscht oder ausgeblendet werden.',
    })}
    <div class="school-ann-grid">
      <section class="section" aria-labelledby="s-neu">${sectionHead('Neue Ankündigung', { id: 's-neu' })}${form}</section>
      <section class="section" aria-labelledby="s-liste">${sectionHead(admin ? 'Alle Ankündigungen' : 'Ankündigungen deiner Klassen', { id: 's-liste', count: items.length ? String(items.length) : null })}
        ${items.length ? list(items.map((an) => {
          const expired = an.expires_at && an.expires_at <= now;
          // Everything about the announcement sits in the text column; the row end holds only the delete button.
          const meta = [an.class_name || 'Ganze Schule', an.author_name || 'Gelöschtes Konto', formatAgo(an.created_at),
            expired ? 'abgelaufen' : an.expires_at ? `sichtbar bis ${formatDay(an.expires_at - 1)}` : '',
            an.hidden ? `von ${an.hidden} ausgeblendet` : ''].filter(Boolean).join(' · ');
          return html`<li class="row school-announcement${expired ? ' dim' : ''}"><span class="school-icon" aria-hidden="true">${icon('megaphone')}</span>
            <div class="row-main"><span class="row-title">${an.title}</span>
              ${an.body ? html`<span class="row-sub pre clamp">${an.body}</span>` : ''}
              <span class="school-meta">${meta}</span></div>
            <div class="row-end">${postButton(req, `/ankuendigungen/${an.id}/loeschen`, `„${an.title}“ löschen`, {
              kind: 'danger', size: 'sm', icon: 'trash', iconOnly: true,
              confirm: `Ankündigung „${an.title}“ löschen?\nSie verschwindet sofort von allen Startseiten.`, confirmLabel: 'Löschen',
            })}</div></li>`;
        })) : empty({ icon: 'megaphone', title: 'Noch keine Ankündigungen', text: 'Was du hier veröffentlichst, erscheint oben auf der Startseite.' })}
      </section>
    </div>`;
    // Teachers reach announcements from their classes, the admin from the Verwaltung.
    res.send(page(req, { title: 'Ankündigungen', body, active: admin ? 'admin' : 'klassen', styles: STYLES }));
  });

  app.post('/ankuendigungen', (req, res) => {
    const u = req.user;
    if (!access.isStaff(u)) throw deny();
    const ziel = typeof req.body.ziel === 'string' ? req.body.ziel : '';
    if (!ziel) throw bad('Bitte wähle, für wen die Ankündigung ist.');
    const cls = ziel === 'schule' ? null : db.get('SELECT id, name FROM classes WHERE id = ?', ziel);
    if ((ziel !== 'schule' && !cls) || !access.canAnnounce(u, cls ? cls.id : null)) throw deny();
    const title = cleanText(req.body.titel, 2000);
    if (title.length < 2) throw bad('Bitte gib der Ankündigung einen Titel.');
    if (title.length > 120) throw bad('Der Titel darf höchstens 120 Zeichen lang sein.');
    const text = cleanText(req.body.text, 5000, { multiline: true });
    if (text.length > 1000) throw bad('Der Text darf höchstens 1000 Zeichen lang sein.');
    const expires = parseEnd(req.body.bis);
    const id = newId();
    db.tx(() => {
      db.run('INSERT INTO announcements (id, class_id, author_id, title, body, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, cls ? cls.id : null, u.id, title, text, Date.now(), expires);
      services.audit(u, 'ankuendigung_erstellt', title, cls ? cls.name : 'Ganze Schule');
      // Class members get an in-Hub notice; a school-wide one is on every start page anyway.
      if (cls) {
        const members = db.all('SELECT user_id FROM class_members WHERE class_id = ? AND user_id <> ?', cls.id, u.id).map((r) => r.user_id);
        services.notify(members, 'ankuendigung', `Neue Ankündigung in ${cls.name}: ${title}`, services.announcementLink(id));
      }
    });
    flash(req, cls ? `Veröffentlicht. Die Ankündigung steht jetzt auf der Startseite von „${cls.name}“.` : 'Veröffentlicht. Die Ankündigung steht jetzt auf allen Startseiten.');
    res.redirect(303, '/ankuendigungen');
  });

  app.post('/ankuendigungen/:id/loeschen', (req, res) => {
    const an = db.get('SELECT an.*, c.name AS class_name FROM announcements an LEFT JOIN classes c ON c.id = an.class_id WHERE an.id = ?', String(req.params.id));
    if (!an || !access.canDeleteAnnouncement(req.user, an)) throw deny();
    db.tx(() => {
      db.run('DELETE FROM announcements WHERE id = ?', an.id);
      // Its notice quotes the title: a title written by mistake must not stay in every member's Mitteilungen.
      db.run('DELETE FROM notices WHERE href = ?', services.announcementLink(an.id));
    });
    services.audit(req.user, 'ankuendigung_geloescht', an.title, an.class_name || 'Ganze Schule');
    flash(req, `Die Ankündigung „${an.title}“ wurde gelöscht.`);
    res.redirect(303, '/ankuendigungen');
  });
};
