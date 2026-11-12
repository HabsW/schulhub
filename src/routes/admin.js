'use strict';
// Verwaltung (admin only): overview, accounts, classes, apps, the audit log,
// retention and backups. One gate guards the whole area: for everybody else
// every /admin URL answers 404, exactly like a page that does not exist.

const {
  html, page, flash, csrfField, postButton, linkButton, appIcon, icon, badge, ROLE_LABEL,
  pageHead, tabs, sectionHead, list, row, stat, stats, empty, notice, dataTable, field,
} = require('../html');
const { deny, bad, isLocalPath, formatDate, formatDay, formatAgo, formatBytes, plural, dayKey } = require('../util');
const { auditLabel, actorLabel } = require('../auditLabels');
const { queryText, queryChoice, pageNumber, listUrl, pager, selectControl, segmented, filterPanel, likePattern, parseDay, dayStart } = require('../formKit');
const backup = require('../backup');

const DAY = 86_400_000;
const PER_PAGE = 50;
const STYLES = ['css/school.css', 'css/admin.css'];

/** "3 Tage, 4 Stunden" */
function duration(seconds) {
  const m = Math.floor(seconds / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d) return `${plural(d, 'Tag', 'Tage')}, ${plural(h % 24, 'Stunde', 'Stunden')}`;
  if (h) return `${plural(h, 'Stunde', 'Stunden')}, ${plural(m % 60, 'Minute', 'Minuten')}`;
  return plural(Math.max(m, 1), 'Minute', 'Minuten');
}

const stampFmt = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin', dateStyle: 'short', timeStyle: 'short' });
/** "schulhub-sicherung-2026-11-12-2030.zip" (school time). */
const backupName = (ts = Date.now()) => `schulhub-sicherung-${stampFmt.format(new Date(ts)).replace(' ', '-').replace(':', '')}.zip`;

/** What each role may do - shown where the admin changes a role. */
const ROLE_HELP = {
  student: 'Nutzt die Apps der eigenen Klassen und baut eigene Apps. Apps von Schüler/innen prüft die Lehrkraft, bevor die Klasse sie sieht.',
  teacher: 'Legt Klassen an, sieht die Ergebnisse der eigenen Schüler/innen und bringt Apps ohne Prüfung in die eigenen Klassen.',
  admin: 'Sieht und ändert alles: Konten und Rollen, alle Klassen und Apps, das Protokoll, Fristen und Sicherungen mit allen Daten.',
};

module.exports = (app, ctx) => {
  const { db, config, access, services, uploads, settings } = ctx;

  // One gate for the whole area. Non-admins get the same 404 as for any unknown page.
  app.use('/admin', (req, res, next) => (access.isAdmin(req.user) ? next() : next(deny())));

  const admins = () => db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").n;
  const target = (req) => {
    const u = db.get('SELECT * FROM users WHERE id = ?', String(req.params.uid));
    if (!u) throw deny();
    return u;
  };
  /** Where to go after an action: a page of the admin area named by the form, else the fallback. */
  const back = (req, fallback) => {
    const z = req.body && req.body.zurueck;
    return typeof z === 'string' && isLocalPath(z) && /^\/admin(?:[/?]|$)/.test(z) ? z : fallback;
  };
  const pendingUpdates = () =>
    db.get('SELECT COUNT(*) AS n FROM apps WHERE schoolwide_requested_version_id IS NOT NULL AND schoolwide_requested_version_id IS NOT schoolwide_version_id').n;

  function adminTabs(current) {
    const flagged = db.get('SELECT COUNT(*) AS n FROM users WHERE flagged_inactive_at IS NOT NULL').n;
    const updates = pendingUpdates();
    return tabs([
      ['/admin', 'Übersicht', 'start'],
      ['/admin/konten', 'Konten', 'konten'],
      ['/admin/klassen', 'Klassen', 'klassen'],
      ['/admin/apps', 'Apps', 'apps', updates ? { n: updates, tone: 'wait' } : null],
      ['/admin/protokoll', 'Protokoll', 'protokoll'],
      ['/admin/aufbewahrung', 'Aufbewahrung', 'aufbewahrung', flagged ? { n: flagged, tone: 'wait' } : null],
      ['/admin/sicherung', 'Sicherung', 'sicherung'],
    ], current, 'Verwaltung');
  }

  function adminPage(req, { title, tab = '', lead = '', actions = '', crumbs = null, body }) {
    const head = pageHead({ crumbs: crumbs || [], eyebrow: crumbs ? '' : 'Verwaltung', title, lead, actions, tabs: tab ? adminTabs(tab) : '' });
    return page(req, { title: `${title} · Verwaltung`, active: 'admin', styles: STYLES, scripts: ['school.js'], body: html`${head}${body}` });
  }

  // ================================================================ overview

  async function overviewData() {
    const byRole = Object.fromEntries(db.all('SELECT role, COUNT(*) AS n FROM users GROUP BY role').map((r) => [r.role, r.n]));
    const people = db.get('SELECT COUNT(*) AS n, COALESCE(SUM(disabled), 0) AS blocked, COALESCE(SUM(flagged_inactive_at IS NOT NULL), 0) AS flagged FROM users');
    const classes = db.get('SELECT COALESCE(SUM(archived_at IS NULL), 0) AS active, COALESCE(SUM(archived_at IS NOT NULL), 0) AS archived FROM classes');
    const apps = db.get('SELECT COUNT(*) AS n, COALESCE(SUM(published_version_id IS NOT NULL), 0) AS published, COALESCE(SUM(schoolwide_version_id IS NOT NULL), 0) AS schoolwide FROM apps');
    const waiting = db.get("SELECT COUNT(*) AS n FROM class_apps ca JOIN classes c ON c.id = ca.class_id AND c.archived_at IS NULL WHERE ca.request_state = 'waiting'").n;
    // Bytes per person: app code they own (versions + drafts, as counted for the quota) and their personal data.
    const topUsers = db.all(
      `SELECT u.id, u.name, u.role, t.code, t.data FROM (
         SELECT uid, SUM(code) AS code, SUM(data) AS data FROM (
           SELECT a.owner_id AS uid, f.size AS code, 0 AS data FROM app_files f JOIN app_versions v ON v.id = f.version_id JOIN apps a ON a.id = v.app_id
           UNION ALL SELECT a.owner_id, d.size, 0 FROM draft_files d JOIN apps a ON a.id = d.app_id
           UNION ALL SELECT user_id, 0, size FROM saves
           UNION ALL SELECT user_id, 0, size FROM user_files
         ) GROUP BY uid ORDER BY SUM(code) + SUM(data) DESC LIMIT 10
       ) t JOIN users u ON u.id = t.uid ORDER BY t.code + t.data DESC`
    );
    const topApps = db.all(
      `SELECT a.id, a.name, a.emoji, a.color, o.name AS owner_name, t.code, t.data FROM (
         SELECT aid, SUM(code) AS code, SUM(data) AS data FROM (
           SELECT v.app_id AS aid, f.size AS code, 0 AS data FROM app_files f JOIN app_versions v ON v.id = f.version_id
           UNION ALL SELECT app_id, size, 0 FROM draft_files
           UNION ALL SELECT app_id, 0, size FROM saves
           UNION ALL SELECT app_id, 0, size FROM shared_data
           UNION ALL SELECT app_id, 0, size FROM user_files
         ) GROUP BY aid ORDER BY SUM(code) + SUM(data) DESC LIMIT 10
       ) t JOIN apps a ON a.id = t.aid JOIN users o ON o.id = a.owner_id ORDER BY t.code + t.data DESC`
    );
    const store = await backup.storeStats(config.dataDir);
    return { byRole, people, classes, apps, waiting, updates: pendingUpdates(), topUsers, topApps, store, last: backup.lastBackupAt(db) };
  }

  app.get('/admin', async (req, res) => {
    // The old account search lived here.
    if (typeof req.query.q === 'string' && req.query.q) return res.redirect(listUrl('/admin/konten', { q: queryText(req, 'q', 60) }));
    const d = await overviewData();
    const { byRole, people, store } = d;
    const backupOld = !d.last || Date.now() - d.last > 7 * DAY;
    const todo = [
      d.updates ? row({ href: '/admin/apps?filter=update', title: d.updates === 1 ? 'Ein schulweites Update wartet auf dich' : `${d.updates} schulweite Updates warten auf dich`, sub: 'Neue Versionen von Apps für die ganze Schule. Erst nach deiner Freigabe sehen alle sie.', start: html`<span class="school-icon school-icon-wait" aria-hidden="true">${icon('clock')}</span>` }) : '',
      people.flagged ? row({ href: '/admin/aufbewahrung', title: `${plural(people.flagged, 'Konto', 'Konten')} lange nicht benutzt`, sub: 'Prüfen und bei Bedarf löschen. Automatisch wird nie ein Konto gelöscht.', start: html`<span class="school-icon school-icon-wait" aria-hidden="true">${icon('user')}</span>` }) : '',
      backupOld ? row({ href: '/admin/sicherung', title: d.last ? `Letzte Sicherung ${formatAgo(d.last)}` : 'Noch keine Sicherung heruntergeladen', sub: 'Lade regelmäßig eine Sicherung herunter und bewahre sie sicher auf.', start: html`<span class="school-icon school-icon-wait" aria-hidden="true">${icon('hardDrive')}</span>` }) : '',
    ].filter(Boolean);
    const total = store.db + store.blobs.bytes + store.userfiles.bytes;

    const body = html`${stats([
      stat({ label: 'Konten', value: people.n, sub: `${plural(byRole.student || 0, 'Schüler/in', 'Schüler/innen')} · ${plural(byRole.teacher || 0, 'Lehrkraft', 'Lehrkräfte')} · ${plural(byRole.admin || 0, 'Admin', 'Admins')}`, href: '/admin/konten' }),
      stat({ label: 'Klassen', value: d.classes.active, sub: `${d.classes.archived} archiviert`, href: '/admin/klassen' }),
      stat({ label: 'Apps', value: d.apps.n, sub: `${d.apps.published} veröffentlicht · ${d.apps.schoolwide} schulweit`, href: '/admin/apps' }),
      stat({ label: 'Warten auf Prüfung', value: d.waiting, tone: d.waiting ? 'wait' : '', sub: 'in allen Klassen' }),
      stat({ label: 'Schulweite Updates', value: d.updates, tone: d.updates ? 'wait' : '', sub: d.updates ? 'warten auf dich' : 'nichts offen', href: '/admin/apps?filter=update' }),
      stat({ label: 'Inaktiv markiert', value: people.flagged, tone: people.flagged ? 'wait' : '', sub: `${people.blocked} gesperrt`, href: '/admin/konten?status=inaktiv' }),
    ])}
    <div class="grid-2 mt-6"><div>
      <section class="section" aria-labelledby="s-todo">${sectionHead('Zu erledigen', { id: 's-todo', count: todo.length ? String(todo.length) : null })}
        ${todo.length ? list(todo) : empty({ icon: 'checkCircle', title: 'Alles erledigt', text: 'Keine wartenden Updates, keine lange unbenutzten Konten, die Sicherung ist aktuell.' })}
      </section>
      <section class="section" aria-labelledby="s-speicher">${sectionHead('Speicher', { id: 's-speicher', count: formatBytes(total), sub: 'Belegung des Datenordners auf dem Server.' })}
        <dl class="kv school-kv">
          <div><dt>Datenbank</dt><dd>${formatBytes(store.db)}</dd></div>
          <div><dt>App-Dateien</dt><dd>${formatBytes(store.blobs.bytes)} · ${plural(store.blobs.files, 'Datei', 'Dateien')}</dd></div>
          <div><dt>Dateien aus Apps</dt><dd>${formatBytes(store.userfiles.bytes)} · ${plural(store.userfiles.files, 'Datei', 'Dateien')}</dd></div>
        </dl>
        <h3 class="admin-subhead">Die 10 größten Konten</h3>
        ${dataTable({
          columns: [
            { label: 'Konto', primary: true, render: (u) => html`<a href="/admin/konten/${u.id}">${u.name}</a>` },
            { label: 'Rolle', render: (u) => ROLE_LABEL[u.role] },
            { label: 'Eigene Apps', num: true, render: (u) => formatBytes(u.code) },
            { label: 'Persönliche Daten', num: true, render: (u) => formatBytes(u.data) },
          ],
          rows: d.topUsers,
          empty: html`<p class="school-note">Noch nichts gespeichert.</p>`,
        })}
        <h3 class="admin-subhead">Die 10 größten Apps</h3>
        ${dataTable({
          columns: [
            { label: 'App', primary: true, render: (a) => html`<a class="admin-app" href="/apps/${a.id}">${appIcon(a, 'xs')}<span>${a.name}</span></a>` },
            { label: 'Von', key: 'owner_name' },
            { label: 'Code', num: true, render: (a) => formatBytes(a.code) },
            { label: 'Daten darin', num: true, render: (a) => formatBytes(a.data) },
          ],
          rows: d.topApps,
          empty: html`<p class="school-note">Noch keine Apps.</p>`,
        })}
      </section>
    </div><div>
      <section class="section" aria-labelledby="s-zustand">${sectionHead('Zustand', { id: 's-zustand' })}
        <dl class="kv school-kv">
          <div><dt>Läuft seit</dt><dd>${duration(process.uptime())}</dd></div>
          <div><dt>Node.js</dt><dd class="mono">${process.version}</dd></div>
          <div><dt>Arbeitsspeicher</dt><dd>${formatBytes(process.memoryUsage().rss)}</dd></div>
          <div><dt>Datenbank</dt><dd>Version ${db.get('PRAGMA user_version').user_version}</dd></div>
          <div><dt>Letzte Sicherung</dt><dd>${d.last ? formatDate(d.last) : 'noch nie'}${backupOld ? html` ${badge(d.last ? 'älter als 7 Tage' : 'fehlt', 'wait')}` : ''}</dd></div>
        </dl>
        <div class="actions mt-4">${postButton(req, '/admin/datenbank-pruefen', 'Datenbank prüfen', { icon: 'database' })}${linkButton('/admin/sicherung', 'Sicherung', { kind: 'quiet', icon: 'hardDrive' })}</div>
        <p class="school-note">„Datenbank prüfen“ sucht nach beschädigten Seiten in der Datenbankdatei. Bei großen Datenbanken dauert das ein paar Sekunden.</p>
      </section>
      <section class="section" aria-labelledby="s-schule">${sectionHead('Für die ganze Schule', { id: 's-schule' })}
        ${list([
          row({ href: '/ankuendigungen', title: 'Ankündigung schreiben', sub: 'Erscheint oben auf allen Startseiten oder auf denen einer Klasse.', start: html`<span class="school-icon" aria-hidden="true">${icon('megaphone')}</span>` }),
          row({ href: '/admin/apps?filter=schulweit', title: 'Apps für die ganze Schule', sub: `${plural(d.apps.schoolwide, 'App', 'Apps')} freigegeben`, start: html`<span class="school-icon" aria-hidden="true">${icon('apps')}</span>` }),
          row({ href: '/admin/aufbewahrung', title: 'Aufbewahrungsfristen', sub: 'Wie lange Protokoll und archivierte Klassen bleiben.', start: html`<span class="school-icon" aria-hidden="true">${icon('calendar')}</span>` }),
        ])}
      </section>
    </div></div>`;
    res.send(adminPage(req, { title: 'Übersicht', tab: 'start', body }));
  });

  app.post('/admin/datenbank-pruefen', (req, res) => {
    const rows = db.all('PRAGMA quick_check').map((r) => String(Object.values(r)[0]));
    const ok = rows.length === 1 && rows[0] === 'ok';
    services.audit(req.user, 'datenbank_geprueft', '', ok ? 'in Ordnung' : rows.slice(0, 3).join('; '));
    flash(req, ok ? 'Die Datenbank ist in Ordnung.' : `Die Prüfung hat Probleme gefunden: ${rows.slice(0, 3).join('; ')}. Spiele die letzte Sicherung ein oder wende dich an die IT.`, ok ? 'ok' : 'error');
    res.redirect(303, '/admin');
  });

  // ================================================================ accounts

  const ROLES = ['student', 'teacher', 'admin'];
  const STATUS = ['gesperrt', 'inaktiv'];

  app.get('/admin/konten', (req, res) => {
    const q = queryText(req, 'q', 60);
    const rolle = queryChoice(req, 'rolle', ROLES);
    const status = queryChoice(req, 'status', STATUS);
    const where = `WHERE (?1 = '' OR u.name LIKE ?2 ESCAPE '\\' OR u.email LIKE ?2 ESCAPE '\\') AND (?3 = '' OR u.role = ?3)
                     AND (?4 = '' OR (?4 = 'gesperrt' AND u.disabled = 1) OR (?4 = 'inaktiv' AND u.flagged_inactive_at IS NOT NULL))`;
    const args = [q, likePattern(q), rolle, status];
    const total = db.get(`SELECT COUNT(*) AS n FROM users u ${where}`, ...args).n;
    const pages = Math.max(1, Math.ceil(total / PER_PAGE));
    const pageNo = Math.min(pageNumber(req), pages);
    const users = db.all(`SELECT u.* FROM users u ${where} ORDER BY u.name COLLATE NOCASE, u.id LIMIT ?5 OFFSET ?6`, ...args, PER_PAGE, (pageNo - 1) * PER_PAGE);
    const filtered = Boolean(q || rolle || status);

    const roleOptions = [['', 'Alle Rollen'], ['student', 'Schüler/innen'], ['teacher', 'Lehrkräfte'], ['admin', 'Admins']];
    const statusOptions = [['', 'Alle'], ['gesperrt', 'Gesperrt'], ['inaktiv', 'Inaktiv markiert']];
    const active = [q && `„${q}“`, rolle && roleOptions.find(([v]) => v === rolle)[1], status && statusOptions.find(([v]) => v === status)[1]].filter(Boolean);
    const body = html`<form method="get" action="/admin/konten" class="school-filters school-filters-fold" data-autosubmit aria-label="Konten filtern">
        ${filterPanel({
          summary: active.length ? active.join(' · ') : 'Alle Konten',
          open: req.query.offen === '1',
          body: html`<div class="school-filter-grid">
            <div class="field school-filter-q"><label for="f-q">Name oder E-Mail</label>
              <div class="school-inline"><input id="f-q" type="search" name="q" value="${q}" maxlength="60" autocomplete="off">
              <button class="btn icon school-search-btn" aria-label="Suchen" title="Suchen">${icon('search')}</button></div></div>
            <div class="field"><label for="f-rolle">Rolle</label>${selectControl(req, { name: 'rolle', value: rolle, options: roleOptions })}</div>
            <div class="field"><label for="f-status">Status</label>${selectControl(req, { name: 'status', value: status, options: statusOptions })}</div>
          </div>`,
        })}
      </form>
      <section class="section" aria-labelledby="s-konten">
        ${sectionHead(plural(total, 'Konto', 'Konten'), { id: 's-konten', sub: pages > 1 ? `Seite ${pageNo} von ${pages}, sortiert nach Name.` : '', actions: filtered ? linkButton('/admin/konten', 'Filter zurücksetzen', { kind: 'quiet', size: 'sm', icon: 'x' }) : '' })}
        ${dataTable({
          columns: [
            { label: 'Name', primary: true, render: (u) => html`<a class="admin-name" href="/admin/konten/${u.id}">${u.name}</a><span class="admin-mail">${u.email}</span>` },
            { label: 'Rolle', render: (u) => ROLE_LABEL[u.role] },
            { label: 'Letzte Anmeldung', render: (u) => (u.last_login_at ? formatAgo(u.last_login_at) : 'nie') },
            {
              // An account without a special state is simply "aktiv" (phones show every label, so never leave it empty).
              label: 'Status', render: (u) => html`<span class="admin-badges">${u.id === req.user.id ? badge('Du') : ''}${u.disabled ? badge('gesperrt', 'danger') : ''}${u.flagged_inactive_at
                ? html`${badge('inaktiv markiert', 'wait')}<span class="admin-mail">seit ${formatDay(u.flagged_inactive_at)}</span>` : ''}${!u.disabled && !u.flagged_inactive_at ? html`<span class="muted">aktiv</span>` : ''}</span>`,
            },
            { label: 'Verwalten', actions: true, render: (u) => linkButton(`/admin/konten/${u.id}`, 'Verwalten', { size: 'sm' }) },
          ],
          rows: users,
          empty: empty({ icon: 'user', title: filtered ? 'Kein Konto passt zu diesen Filtern' : 'Noch keine Konten', text: filtered ? 'Lass einen Filter weg oder suche nach einem anderen Namen.' : 'Konten entstehen bei der ersten Anmeldung mit dem Schulkonto.' }),
        })}
        ${pager({ base: '/admin/konten', params: { q, rolle, status }, page: pageNo, pages })}
      </section>`;
    res.send(adminPage(req, { title: 'Konten', tab: 'konten', lead: 'Rollen ändern, Konten sperren oder löschen. Konten entstehen nur durch die Anmeldung mit dem Schulkonto.', body }));
  });

  app.get('/admin/konten/:uid', (req, res) => {
    const u = target(req);
    const self = u.id === req.user.id;
    const n = db.get(
      `SELECT (SELECT COUNT(*) FROM apps WHERE owner_id = ?1) AS apps,
              (SELECT COALESCE(SUM(size), 0) FROM saves WHERE user_id = ?1) + (SELECT COALESCE(SUM(size), 0) FROM user_files WHERE user_id = ?1) AS data`,
      u.id
    );
    const classes = db.all('SELECT c.id, c.name, c.archived_at, m.role FROM class_members m JOIN classes c ON c.id = m.class_id WHERE m.user_id = ? ORDER BY m.role DESC, c.name COLLATE NOCASE LIMIT 40', u.id);
    const teaching = classes.filter((c) => c.role === 'teacher');
    const sole = db.all(
      `SELECT c.name FROM classes c JOIN class_members m ON m.class_id = c.id AND m.user_id = ?1 AND m.role = 'teacher'
        WHERE NOT EXISTS (SELECT 1 FROM class_members o WHERE o.class_id = c.id AND o.role = 'teacher' AND o.user_id <> ?1)`,
      u.id
    );
    const lastAdmin = u.role === 'admin' && !u.disabled && admins() <= 1;
    const here = `/admin/konten/${u.id}`;

    const roleConfirm = (r) => {
      const who = self ? 'Du' : u.name;
      const lines = {
        admin: `${self ? 'Dich' : u.name} zum Admin machen?\n${who} ${self ? 'siehst' : 'sieht'} dann alle Konten, Klassen, Apps und das Protokoll und ${self ? 'kannst' : 'kann'} alles ändern und löschen – auch Sicherungen mit allen Daten herunterladen. Das gilt sofort.`,
        teacher: `${self ? 'Dich' : u.name} zur Lehrkraft machen?\n${ROLE_HELP.teacher}${u.role === 'admin' ? ' Die Admin-Rechte enden sofort.' : ' Das gilt sofort.'}`,
        student: `${self ? 'Dich' : u.name} zur Schülerin / zum Schüler machen?\nDie Rechte als ${ROLE_LABEL[u.role]} enden sofort.${teaching.length ? ` In ${plural(teaching.length, 'Klasse', 'Klassen')} bleibt ${self ? 'dein' : 'der'} Eintrag als Lehrkraft bestehen.` : ''}`,
      };
      return lines[r] + (self && u.role === 'admin' ? ' Du verlierst sofort den Zugang zur Verwaltung.' : '');
    };

    const body = html`<div class="grid-2"><div>
      <section class="section" aria-labelledby="s-fakten">${sectionHead('Konto', { id: 's-fakten' })}
        <dl class="kv school-kv">
          <div><dt>E-Mail</dt><dd>${u.email}</dd></div>
          <div><dt>Rolle</dt><dd>${ROLE_LABEL[u.role]}</dd></div>
          <div><dt>Status</dt><dd>${u.disabled ? badge('gesperrt', 'danger') : badge('aktiv', 'ok')}${u.flagged_inactive_at ? html` ${badge(`inaktiv markiert seit ${formatDay(u.flagged_inactive_at)}`, 'wait')}` : ''}</dd></div>
          <div><dt>Konto angelegt</dt><dd>${formatDate(u.created_at)}</dd></div>
          <div><dt>Letzte Anmeldung</dt><dd>${u.last_login_at ? formatDate(u.last_login_at) : 'nie'}</dd></div>
          <div><dt>Klassen</dt><dd>${classes.length
            ? html`<ul class="admin-classes">${classes.map((c) => html`<li><a href="/klassen/${c.id}">${c.name}</a><span class="admin-mail">${[c.role === 'teacher' ? 'Lehrkraft' : 'Schüler/in', c.archived_at ? 'archiviert' : ''].filter(Boolean).join(' · ')}</span></li>`)}</ul>`
            : html`<span class="muted">keine</span>`}</dd></div>
          <div><dt>Eigene Apps</dt><dd>${n.apps ? html`${plural(n.apps, 'App', 'Apps')} · ${formatBytes(uploads.userBytes(u.id))}` : html`<span class="muted">keine</span>`}</dd></div>
          <div><dt>Persönliche Daten</dt><dd>${n.data ? `${formatBytes(n.data)} in Apps` : html`<span class="muted">keine</span>`}</dd></div>
        </dl>
      </section>
      <section class="section" aria-labelledby="s-rolle">${sectionHead('Rolle', { id: 's-rolle', sub: lastAdmin ? 'Das ist das einzige aktive Admin-Konto. Ernenne zuerst ein weiteres Konto zum Admin, bevor du diese Rolle änderst.' : 'Eine neue Rolle gilt sofort, ohne neue Anmeldung.' })}
        ${list(ROLES.map((r) => row({
          title: ROLE_LABEL[r],
          sub: ROLE_HELP[r],
          end: r === u.role ? badge('aktuelle Rolle')
            : lastAdmin ? ''
              : postButton(req, `/admin/nutzer/${u.id}/rolle`, 'Diese Rolle geben', { size: 'sm', fields: { rolle: r }, confirm: roleConfirm(r), confirmLabel: `Zu ${ROLE_LABEL[r]} ändern` }),
          cls: 'wrap',
        })))}
      </section>
    </div><div>
      <section class="section" aria-labelledby="s-sperren">${sectionHead(u.disabled ? 'Gesperrt' : 'Sperren', { id: 's-sperren' })}
        ${self ? html`<p class="school-note">Dich selbst kannst du nicht sperren.</p>`
          : u.disabled ? html`<p class="muted mb-4">${u.name} kann sich nicht anmelden. Alle Daten sind erhalten.</p>
              ${postButton(req, `/admin/nutzer/${u.id}/sperren`, 'Entsperren', { icon: 'lock', fields: { an: '0', zurueck: here }, confirm: `${u.name} entsperren?\n${u.name} kann sich danach wieder mit dem Schulkonto anmelden.` })}`
            : html`<p class="muted mb-4">Ein gesperrtes Konto wird sofort überall abgemeldet und kann sich nicht mehr anmelden. Alle Daten bleiben erhalten.</p>
              ${postButton(req, `/admin/nutzer/${u.id}/sperren`, 'Konto sperren', { icon: 'lock', fields: { an: '1', zurueck: here }, confirm: `${u.name} sperren?\n${u.name} wird sofort abgemeldet und kann sich nicht mehr anmelden, bis du das Konto entsperrst. Alle Daten bleiben erhalten.`, confirmLabel: 'Sperren' })}`}
      </section>
      <section class="danger-zone school-danger" aria-labelledby="s-loeschen">
        <h2 id="s-loeschen">Konto löschen</h2>
        ${self ? html`<p>Dein eigenes Konto löschst du unter <a href="/meine-daten">Meine Daten</a>.</p>` : html`
          <p>Löscht das Konto mit allem, was dazugehört. Das kann nicht rückgängig gemacht werden.</p>
          <ul class="school-bullets">
            <li>Mitgliedschaften, Spielstände, Ergebnisse, Dateien, Kommentare und Mitteilungen</li>
            ${n.apps ? html`<li>${plural(n.apps, 'eigene App', 'eigene Apps')} mit allen Versionen – und was andere darin gespeichert haben</li>` : ''}
            ${sole.length ? html`<li>${sole.length === 1 ? 'die Klasse' : 'die Klassen'} ${sole.map((c, i) => html`${i ? ', ' : ''}„${c.name}“`)}, weil ${u.name} dort die einzige Lehrkraft ist</li>` : ''}
          </ul>
          <p class="school-note">Das Protokoll nennt danach nur noch „Gelöschtes Konto“. Meldet sich die Person wieder an, entsteht ein neues, leeres Konto – zum Aussperren „Sperren“ benutzen.</p>
          ${postButton(req, `/admin/nutzer/${u.id}/loeschen`, 'Konto endgültig löschen', {
            kind: 'danger', icon: 'trash', fields: { zurueck: '/admin/konten' },
            confirm: `${u.name} endgültig löschen?\nKonto, App-Daten${n.apps ? `, ${plural(n.apps, 'eigene App', 'eigene Apps')}` : ''}${sole.length ? ` und ${plural(sole.length, 'Klasse', 'Klassen')}` : ''} werden sofort gelöscht. Das kann nicht rückgängig gemacht werden.`,
            confirmLabel: 'Endgültig löschen',
          })}`}
      </section>
    </div></div>`;
    res.send(adminPage(req, {
      title: u.name,
      crumbs: [['/admin', 'Verwaltung'], ['/admin/konten', 'Konten']],
      lead: `${ROLE_LABEL[u.role]}${self ? ' · Das bist du' : ''}`,
      body,
    }));
  });

  app.post('/admin/nutzer/:uid/rolle', (req, res) => {
    const u = target(req);
    const role = String(req.body.rolle);
    if (!Object.hasOwn(ROLE_LABEL, role)) throw bad('Unbekannte Rolle.');
    if (u.role === 'admin' && role !== 'admin' && admins() <= 1) throw bad('Es muss mindestens einen Admin geben. Ernenne zuerst ein weiteres Konto zum Admin.');
    if (u.role !== role) {
      db.run('UPDATE users SET role = ? WHERE id = ?', role, u.id);
      services.audit(req.user, 'rolle_geaendert', u.name, `${ROLE_LABEL[u.role]} → ${ROLE_LABEL[role]}`);
      flash(req, `${u.name} ist jetzt ${ROLE_LABEL[role]}.`);
    }
    // Someone who just gave away their own admin role cannot see the admin area any more.
    res.redirect(303, u.id === req.user.id && role !== 'admin' ? '/start' : `/admin/konten/${u.id}`);
  });

  app.post('/admin/nutzer/:uid/sperren', (req, res) => {
    const u = target(req);
    if (u.id === req.user.id) throw bad('Du kannst dich nicht selbst sperren.');
    const on = req.body.an === '1';
    db.run('UPDATE users SET disabled = ? WHERE id = ?', on ? 1 : 0, u.id);
    if (on) db.run('DELETE FROM sessions WHERE user_id = ?', u.id); // signed out everywhere, immediately
    services.audit(req.user, on ? 'konto_gesperrt' : 'konto_entsperrt', u.name);
    flash(req, on ? `${u.name} ist gesperrt und wurde überall abgemeldet.` : `${u.name} kann sich wieder anmelden.`);
    res.redirect(303, back(req, `/admin/konten/${u.id}`));
  });

  app.post('/admin/nutzer/:uid/loeschen', (req, res) => {
    const u = target(req);
    if (u.id === req.user.id) throw bad('Dein eigenes Konto löschst du unter „Meine Daten“.');
    services.deleteUser(req.user, u);
    flash(req, `Das Konto von ${u.name} wurde gelöscht.`);
    res.redirect(303, back(req, '/admin/konten'));
  });

  // ================================================================ classes

  function adminClass(req) {
    const c = db.get('SELECT * FROM classes WHERE id = ?', String(req.params.id));
    if (!c || !access.canManageClass(req.user, c.id)) throw deny();
    return c;
  }

  app.get('/admin/klassen', (req, res) => {
    const archiv = queryChoice(req, 'archiv', ['1']) === '1';
    const q = queryText(req, 'q', 60);
    const counts = db.get('SELECT COALESCE(SUM(archived_at IS NULL), 0) AS active, COALESCE(SUM(archived_at IS NOT NULL), 0) AS archived FROM classes');
    const where = "WHERE (c.archived_at IS NOT NULL) = ?1 AND (?2 = '' OR c.name LIKE ?3 ESCAPE '\\')";
    const args = [archiv ? 1 : 0, q, likePattern(q)];
    const total = db.get(`SELECT COUNT(*) AS n FROM classes c ${where}`, ...args).n;
    const pages = Math.max(1, Math.ceil(total / PER_PAGE));
    const pageNo = Math.min(pageNumber(req), pages);
    const rows = db.all(
      `SELECT c.id, c.name, c.created_at, c.archived_at,
              (SELECT GROUP_CONCAT(u.name, ', ') FROM class_members m JOIN users u ON u.id = m.user_id WHERE m.class_id = c.id AND m.role = 'teacher') AS teachers,
              (SELECT COUNT(*) FROM class_members m WHERE m.class_id = c.id AND m.role = 'student') AS students,
              (SELECT COUNT(*) FROM class_apps ca WHERE ca.class_id = c.id AND ca.status = 'approved') AS apps
         FROM classes c ${where} ORDER BY c.name COLLATE NOCASE, c.id LIMIT ?4 OFFSET ?5`,
      ...args, PER_PAGE, (pageNo - 1) * PER_PAGE
    );
    const keepDays = settings.get('retention.archivedClassDays');
    const here = listUrl('/admin/klassen', { archiv: archiv ? '1' : '', q, seite: pageNo });

    const body = html`<form method="get" action="/admin/klassen" class="school-filters" data-autosubmit aria-label="Klassen filtern">
        <div class="school-filter-grid">
          <div class="field school-filter-q"><label for="f-q">Name der Klasse</label>
            <div class="school-inline"><input id="f-q" type="search" name="q" value="${q}" maxlength="60" autocomplete="off">
            <button class="btn icon school-search-btn" aria-label="Suchen" title="Suchen">${icon('search')}</button></div></div>
        </div>
        ${segmented({ name: 'archiv', legend: 'Zeigen', value: archiv ? '1' : '', options: [['', `Aktiv (${counts.active})`], ['1', `Archiviert (${counts.archived})`]] })}
      </form>
      <section class="section" aria-labelledby="s-klassen">
        ${sectionHead(archiv ? `${plural(total, 'archivierte Klasse', 'archivierte Klassen')}` : plural(total, 'aktive Klasse', 'aktive Klassen'), {
          id: 's-klassen',
          sub: archiv ? `Archivierte Klassen sind schreibgeschützt und werden ${keepDays} Tage nach dem Archivieren automatisch gelöscht.` : 'Archivieren am Schuljahresende: Schüler/innen sehen die Klasse dann nicht mehr, Lehrkräfte lesen weiter.',
        })}
        ${dataTable({
          cls: 'school-records',
          columns: [
            { label: 'Klasse', primary: true, render: (c) => html`<a href="/klassen/${c.id}">${c.name}</a>` },
            { label: 'Lehrkräfte', render: (c) => c.teachers || html`<span class="muted">keine</span>` },
            { label: 'Schüler/innen', num: true, key: 'students' },
            { label: 'Apps', num: true, key: 'apps' },
            archiv
              ? { label: 'Archiviert', render: (c) => html`${formatDay(c.archived_at)}<span class="admin-mail">wird am ${formatDay(c.archived_at + keepDays * DAY)} gelöscht</span>` }
              : { label: 'Angelegt', render: (c) => formatDay(c.created_at) },
            {
              label: 'Aktionen', actions: true, render: (c) => html`${c.archived_at
                ? postButton(req, `/admin/klassen/${c.id}/wiederherstellen`, 'Wiederherstellen', { size: 'sm', icon: 'undo', fields: { zurueck: here }, confirm: `„${c.name}“ wiederherstellen?\nDie Klasse ist danach wieder aktiv: Schüler/innen sehen sie, Lehrkräfte können wieder ändern. Zum Beitreten braucht es einen neuen Code.` })
                : postButton(req, `/admin/klassen/${c.id}/archivieren`, 'Archivieren', { size: 'sm', icon: 'archive', fields: { zurueck: here }, confirm: `„${c.name}“ archivieren?\nDie Klasse wird schreibgeschützt: Schüler/innen sehen sie nicht mehr, niemand kann beitreten, Lehrkräfte lesen die Ergebnisse weiter. Nach ${keepDays} Tagen wird sie automatisch gelöscht.`, confirmLabel: 'Archivieren' })}
                ${postButton(req, `/admin/klassen/${c.id}/loeschen`, `„${c.name}“ löschen`, {
                  kind: 'danger', size: 'sm', icon: 'trash', iconOnly: true, fields: { zurueck: here },
                  confirm: `„${c.name}“ endgültig löschen?\nMitgliedschaften, Aufgaben, Rückmeldungen, Ankündigungen und Klassendaten werden gelöscht. Die Apps und die Spielstände der Schüler/innen bleiben. Das kann nicht rückgängig gemacht werden.`,
                  confirmLabel: 'Endgültig löschen',
                })}`,
            },
          ],
          rows,
          empty: empty({ icon: 'school', title: q ? 'Keine Klasse mit diesem Namen' : archiv ? 'Keine archivierten Klassen' : 'Noch keine Klassen', text: archiv ? 'Klassen, die archiviert werden, erscheinen hier bis zu ihrer Löschung.' : 'Lehrkräfte legen Klassen unter „Klassen“ an.' }),
        })}
        ${pager({ base: '/admin/klassen', params: { archiv: archiv ? '1' : '', q }, page: pageNo, pages })}
      </section>`;
    res.send(adminPage(req, { title: 'Klassen', tab: 'klassen', body }));
  });

  app.post('/admin/klassen/:id/archivieren', (req, res) => {
    const c = adminClass(req);
    if (c.archived_at) throw bad('Diese Klasse ist schon archiviert.');
    db.tx(() => {
      db.run('UPDATE classes SET archived_at = ? WHERE id = ?', Date.now(), c.id);
      db.run('DELETE FROM join_codes WHERE class_id = ?', c.id); // nobody joins an archived class
      services.audit(req.user, 'klasse_archiviert', c.name);
    });
    flash(req, `„${c.name}“ ist archiviert. Sie wird nach ${settings.get('retention.archivedClassDays')} Tagen automatisch gelöscht.`);
    res.redirect(303, back(req, '/admin/klassen'));
  });

  app.post('/admin/klassen/:id/wiederherstellen', (req, res) => {
    const c = adminClass(req);
    if (!c.archived_at) throw bad('Diese Klasse ist nicht archiviert.');
    db.run('UPDATE classes SET archived_at = NULL WHERE id = ?', c.id);
    services.audit(req.user, 'klasse_wiederhergestellt', c.name);
    flash(req, `„${c.name}“ ist wieder aktiv.`);
    res.redirect(303, back(req, '/admin/klassen?archiv=1'));
  });

  app.post('/admin/klassen/:id/loeschen', (req, res) => {
    const c = adminClass(req);
    services.deleteClass(req.user, c);
    flash(req, `Die Klasse „${c.name}“ wurde gelöscht.`);
    res.redirect(303, back(req, '/admin/klassen'));
  });

  // ================================================================ apps

  const APP_FILTERS = ['schulweit', 'update', 'entwurf'];

  app.get('/admin/apps', (req, res) => {
    const filter = queryChoice(req, 'filter', APP_FILTERS);
    const q = queryText(req, 'q', 60);
    const where = `WHERE (?1 = '' OR a.name LIKE ?2 ESCAPE '\\' OR o.name LIKE ?2 ESCAPE '\\')
                     AND (?3 = '' OR (?3 = 'schulweit' AND a.schoolwide_version_id IS NOT NULL)
                          OR (?3 = 'update' AND a.schoolwide_requested_version_id IS NOT NULL AND a.schoolwide_requested_version_id IS NOT a.schoolwide_version_id)
                          OR (?3 = 'entwurf' AND a.published_version_id IS NULL))`;
    const args = [q, likePattern(q), filter];
    const total = db.get(`SELECT COUNT(*) AS n FROM apps a JOIN users o ON o.id = a.owner_id ${where}`, ...args).n;
    const pages = Math.max(1, Math.ceil(total / PER_PAGE));
    const pageNo = Math.min(pageNumber(req), pages);
    const since = dayKey(Date.now() - 29 * DAY);
    const apps = db.all(
      `SELECT a.*, o.name AS owner_name, o.role AS owner_role,
              (SELECT COUNT(*) FROM class_apps ca WHERE ca.app_id = a.id AND ca.status = 'approved') AS classes,
              (SELECT COALESCE(SUM(opens), 0) FROM app_usage x WHERE x.app_id = a.id AND x.day >= ?4) AS opens,
              (SELECT number FROM app_versions v WHERE v.id = a.published_version_id) AS pub_number,
              (SELECT number FROM app_versions v WHERE v.id = a.schoolwide_version_id) AS sw_number,
              (SELECT number FROM app_versions v WHERE v.id = a.schoolwide_requested_version_id) AS req_number
         FROM apps a JOIN users o ON o.id = a.owner_id ${where}
        ORDER BY (a.schoolwide_requested_version_id IS NOT NULL AND a.schoolwide_requested_version_id IS NOT a.schoolwide_version_id) DESC, a.updated_at DESC, a.id
        LIMIT ?5 OFFSET ?6`,
      ...args, since, PER_PAGE, (pageNo - 1) * PER_PAGE
    );
    const counts = db.get(
      `SELECT COUNT(*) AS n, COALESCE(SUM(schoolwide_version_id IS NOT NULL), 0) AS sw,
              COALESCE(SUM(schoolwide_requested_version_id IS NOT NULL AND schoolwide_requested_version_id IS NOT schoolwide_version_id), 0) AS upd,
              COALESCE(SUM(published_version_id IS NULL), 0) AS draft FROM apps`
    );
    const waitingUpdate = (a) => a.schoolwide_requested_version_id && a.schoolwide_requested_version_id !== a.schoolwide_version_id;

    const body = html`<form method="get" action="/admin/apps" class="school-filters" data-autosubmit aria-label="Apps filtern">
        <div class="school-filter-grid">
          <div class="field school-filter-q"><label for="f-q">App oder Besitzer/in</label>
            <div class="school-inline"><input id="f-q" type="search" name="q" value="${q}" maxlength="60" autocomplete="off">
            <button class="btn icon school-search-btn" aria-label="Suchen" title="Suchen">${icon('search')}</button></div></div>
        </div>
        ${segmented({ name: 'filter', legend: 'Zeigen', value: filter, scroll: true, options: [['', `Alle (${counts.n})`], ['schulweit', `Schulweit (${counts.sw})`], ['update', `Update wartet (${counts.upd})`], ['entwurf', `Unveröffentlicht (${counts.draft})`]] })}
      </form>
      <section class="section" aria-labelledby="s-apps">
        ${sectionHead(plural(total, 'App', 'Apps'), { id: 's-apps', sub: '„Geöffnet“ zählt die letzten 30 Tage. Schulweite Updates gibst du auf der Seite der App frei – dort siehst du Vorschau und Quelltext der neuen Version.' })}
        ${dataTable({
          cls: 'school-records',
          columns: [
            {
              label: 'App', primary: true,
              render: (a) => html`<a class="admin-app" href="/apps/${a.id}">${appIcon(a, 'xs')}<span>${a.name}</span></a><span class="admin-mail">von ${a.owner_name} (${ROLE_LABEL[a.owner_role]}) · geändert ${formatAgo(a.updated_at)}</span>`,
            },
            {
              label: 'Stand', render: (a) => html`<span class="admin-badges">${a.schoolwide_version_id ? badge(`schulweit · V${a.sw_number}`, 'ok') : a.published_version_id ? badge(`veröffentlicht · V${a.pub_number}`) : badge('unveröffentlicht')}
                ${waitingUpdate(a) ? badge(`V${a.req_number} wartet`, 'wait') : ''}</span>`,
            },
            { label: 'Klassen', num: true, key: 'classes' },
            { label: 'Geöffnet', num: true, key: 'opens' },
            {
              label: 'Aktionen', actions: true, render: (a) => html`${waitingUpdate(a) ? linkButton(`/apps/${a.id}`, 'Update prüfen', { size: 'sm', icon: 'eye' }) : ''}
                ${a.schoolwide_version_id
                  ? postButton(req, `/apps/${a.id}/schulweit`, 'Schulweit beenden', { size: 'sm', fields: { an: '0' }, confirm: `Schulweite Freigabe von „${a.name}“ beenden?\nWer die App nur über die Schule öffnet, sieht sie nicht mehr. In Klassen, die sie benutzen, bleibt sie.`, confirmLabel: 'Beenden' })
                  : a.published_version_id ? postButton(req, `/apps/${a.id}/schulweit`, 'Schulweit freigeben', { size: 'sm', fields: { an: '1' }, confirm: `„${a.name}“ für die ganze Schule freigeben?\nAlle angemeldeten Personen können dann Version ${a.pub_number} öffnen. Spätere Versionen warten auf deine Freigabe.`, confirmLabel: 'Freigeben' }) : ''}`,
            },
          ],
          rows: apps,
          empty: empty({ icon: 'apps', title: filter || q ? 'Keine App passt zu diesen Filtern' : 'Noch keine Apps', text: filter === 'update' ? 'Es wartet kein schulweites Update auf dich.' : '' }),
        })}
        ${pager({ base: '/admin/apps', params: { filter, q }, page: pageNo, pages })}
      </section>`;
    res.send(adminPage(req, { title: 'Apps', tab: 'apps', body }));
  });

  // ================================================================ audit log

  app.get('/admin/protokoll', (req, res) => {
    const codes = db.all('SELECT DISTINCT action FROM audit_log').map((r) => r.action).sort((a, b) => auditLabel(a).localeCompare(auditLabel(b), 'de'));
    const action = queryChoice(req, 'aktion', codes);
    const person = queryText(req, 'person', 60);
    const vonDay = parseDay(queryText(req, 'von', 10));
    const bisDay = parseDay(queryText(req, 'bis', 10));
    const from = vonDay ? dayStart(vonDay) : null;
    const to = bisDay ? dayStart({ ...bisDay, d: bisDay.d + 1 }) : null;
    const vor = Number.parseInt(queryText(req, 'vor', 20), 10);
    const before = Number.isInteger(vor) && vor > 0 ? vor : null;
    const rows = db.all(
      `SELECT * FROM audit_log
        WHERE (?1 IS NULL OR id < ?1) AND (?2 = '' OR action = ?2)
          AND (?3 = '' OR actor_label LIKE ?4 ESCAPE '\\' OR target LIKE ?4 ESCAPE '\\')
          AND (?5 IS NULL OR at >= ?5) AND (?6 IS NULL OR at < ?6)
        ORDER BY id DESC LIMIT ?7`,
      before, action, person, likePattern(person), from, to, PER_PAGE + 1
    );
    const more = rows.length > PER_PAGE;
    const shown = rows.slice(0, PER_PAGE);
    const params = { aktion: action, person, von: vonDay ? queryText(req, 'von', 10) : '', bis: bisDay ? queryText(req, 'bis', 10) : '' };
    const filtered = Boolean(action || person || from || to);
    const days = settings.get('retention.auditDays');

    const range = from && to ? `${formatDay(from)} – ${formatDay(to - 1)}` : from ? `ab ${formatDay(from)}` : to ? `bis ${formatDay(to - 1)}` : '';
    const active = [action && auditLabel(action), person && `„${person}“`, range].filter(Boolean);
    const body = html`<form method="get" action="/admin/protokoll" class="school-filters school-filters-fold" data-autosubmit aria-label="Protokoll filtern">
        ${filterPanel({
          summary: active.length ? active.join(' · ') : 'Alle Einträge',
          open: req.query.offen === '1',
          body: html`<div class="school-filter-grid">
            <div class="field"><label for="f-aktion">Vorgang</label>${selectControl(req, { name: 'aktion', value: action, options: [['', 'Alle Vorgänge'], ...codes.map((c) => [c, auditLabel(c)])] })}</div>
            <div class="field"><label for="f-person">Person</label><input id="f-person" type="search" name="person" value="${person}" maxlength="60" autocomplete="off" placeholder="Wer oder für wen"></div>
            <div class="field"><label for="f-von">Von</label><input id="f-von" type="date" name="von" value="${params.von}"></div>
            <div class="field"><label for="f-bis">Bis</label><input id="f-bis" type="date" name="bis" value="${params.bis}"></div>
          </div>`,
        })}
      </form>
      <section class="section" aria-labelledby="s-log">
        ${sectionHead(before ? 'Ältere Einträge' : 'Neueste Einträge', {
          id: 's-log',
          sub: `Wichtige Vorgänge der letzten ${days} Tage; ältere werden automatisch gelöscht.`,
          actions: filtered ? linkButton('/admin/protokoll', 'Filter zurücksetzen', { kind: 'quiet', size: 'sm', icon: 'x' }) : '',
        })}
        ${dataTable({
          columns: [
            { label: 'Vorgang', primary: true, render: (r) => auditLabel(r.action) },
            { label: 'Wer', render: (r) => actorLabel(r.actor_label) },
            { label: 'Betrifft', key: 'target' },
            { label: 'Einzelheiten', key: 'detail' },
            { label: 'Zeitpunkt', render: (r) => html`<time class="nowrap">${formatDate(r.at)}</time>` },
          ],
          rows: shown,
          cls: 'admin-log',
          empty: empty({ icon: 'scroll', title: filtered ? 'Keine Einträge für diese Filter' : 'Das Protokoll ist leer', text: filtered ? 'Lass einen Filter weg oder wähle einen anderen Zeitraum.' : '' }),
        })}
        ${before || more ? html`<nav class="school-pager" aria-label="Seiten">
          ${before ? html`<a class="btn sm" href="${listUrl('/admin/protokoll', params)}">${icon('chevronLeft')}<span>Neueste</span></a>` : html`<span></span>`}
          <span></span>
          ${more ? html`<a class="btn sm" href="${listUrl('/admin/protokoll', { ...params, vor: shown[shown.length - 1].id })}"><span>Ältere Einträge</span>${icon('chevronRight')}</a>` : html`<span></span>`}
        </nav>` : ''}
      </section>`;
    res.send(adminPage(req, { title: 'Protokoll', tab: 'protokoll', body }));
  });

  // ================================================================ retention

  app.get('/admin/aufbewahrung', (req, res) => {
    const defs = settings.all();
    const flagged = db.all('SELECT * FROM users WHERE flagged_inactive_at IS NOT NULL ORDER BY flagged_inactive_at, name COLLATE NOCASE LIMIT 101');
    const flaggedTotal = db.get('SELECT COUNT(*) AS n FROM users WHERE flagged_inactive_at IS NOT NULL').n;

    const body = html`<div class="grid-2"><div>
      <section class="section" aria-labelledby="s-fristen">${sectionHead('Fristen', { id: 's-fristen', sub: 'Gilt ab der nächsten täglichen Prüfung (spätestens in 24 Stunden).' })}
        <form method="post" action="/admin/aufbewahrung" class="form panel">${csrfField(req)}
          ${defs.map((d) => field(req, {
            label: `${d.label} (${d.unit})`, name: d.key, type: 'number', value: String(d.value),
            hint: `${d.help} Erlaubt: ${d.min} bis ${d.max}. Standard: ${d.default}.`,
            attrs: `min="${d.min}" max="${d.max}" step="1" inputmode="numeric" required`,
            id: `f-${d.key.replace(/\W/g, '-')}`,
          }))}
          <div class="actions"><button class="btn primary">Fristen speichern</button></div>
        </form>
      </section>
      <section class="section" aria-labelledby="s-fest">${sectionHead('Feste Fristen', { id: 's-fest' })}
        <dl class="kv school-kv">
          <div><dt>Mitteilungen im Hub</dt><dd>180 Tage</dd></div>
          <div><dt>Abgelaufene Ankündigungen</dt><dd>30 Tage nach Ablauf</dd></div>
          <div><dt>Anonyme Nutzungszahlen</dt><dd>400 Tage</dd></div>
          <div><dt>Anmeldung (Sitzung)</dt><dd>8 Stunden</dd></div>
        </dl>
      </section>
    </div><div>
      <section class="section" aria-labelledby="s-inaktiv">${sectionHead('Lange nicht benutzt', {
        id: 's-inaktiv', count: flaggedTotal ? String(flaggedTotal) : null,
        sub: `Konten ohne Anmeldung seit ${settings.get('retention.inactiveFlagDays')} Tagen werden nur markiert – gelöscht wird nie automatisch. Entscheide selbst; mit der nächsten Anmeldung verschwindet die Markierung.`,
      })}
        ${flagged.length ? list(flagged.slice(0, 100).map((u) => row({
          href: `/admin/konten/${u.id}`,
          title: u.name,
          sub: `${ROLE_LABEL[u.role]} · zuletzt angemeldet: ${u.last_login_at ? formatDay(u.last_login_at) : 'nie'} · markiert seit ${formatDay(u.flagged_inactive_at)}`,
          start: html`<span class="school-icon school-icon-wait" aria-hidden="true">${icon('user')}</span>`,
          chevron: false,
          end: u.id === req.user.id ? '' : postButton(req, `/admin/nutzer/${u.id}/loeschen`, `${u.name} löschen`, {
            kind: 'danger', size: 'sm', icon: 'trash', iconOnly: true, fields: { zurueck: '/admin/aufbewahrung' },
            confirm: `${u.name} endgültig löschen?\nDas Konto mit allen Daten, eigenen Apps und Klassen, in denen es die einzige Lehrkraft ist, wird sofort gelöscht. Das kann nicht rückgängig gemacht werden.`,
            confirmLabel: 'Endgültig löschen',
          }),
        }))) : empty({ icon: 'checkCircle', title: 'Keine markierten Konten', text: 'Alle Konten wurden in letzter Zeit benutzt.' })}
        ${flaggedTotal > 100 ? html`<p class="school-note">Es werden die 100 ältesten gezeigt. <a href="/admin/konten?status=inaktiv">Alle markierten Konten</a></p>` : ''}
      </section>
    </div></div>`;
    res.send(adminPage(req, { title: 'Aufbewahrung', tab: 'aufbewahrung', lead: 'Wie lange der Hub Daten aufbewahrt. So wenig wie nötig – die Nutzer/innen sind Kinder und Jugendliche.', body }));
  });

  app.post('/admin/aufbewahrung', (req, res) => {
    const changes = [];
    // All values or none: settings.set refuses values outside the allowed range.
    db.tx(() => {
      for (const d of settings.all()) {
        if (!Object.hasOwn(req.body, d.key)) continue;
        const v = settings.set(d.key, req.body[d.key]);
        if (v !== d.value) changes.push(`${d.label}: ${d.value} → ${v} ${d.unit}`);
      }
    });
    if (changes.length) services.audit(req.user, 'aufbewahrung_geaendert', '', changes.join('; '));
    flash(req, changes.length ? 'Gespeichert. Die neuen Fristen gelten ab der nächsten täglichen Prüfung.' : 'Es wurde nichts geändert.');
    res.redirect(303, '/admin/aufbewahrung');
  });

  // ================================================================ backup

  app.get('/admin/sicherung', async (req, res) => {
    const store = await backup.storeStats(config.dataDir);
    const last = backup.lastBackupAt(db);
    const history = db.all("SELECT at, actor_label, detail FROM audit_log WHERE action = 'sicherung_heruntergeladen' ORDER BY id DESC LIMIT 5");
    const total = store.db + store.blobs.bytes + store.userfiles.bytes;

    const body = html`${!last || Date.now() - last > 7 * DAY ? notice({ tone: 'wait', title: last ? `Letzte Sicherung: ${formatAgo(last)}` : 'Es gibt noch keine Sicherung', text: 'Lade regelmäßig eine Sicherung herunter, zum Beispiel jede Woche, und bewahre sie an einem sicheren Ort auf.', cls: 'mb-6' }) : ''}
    <div class="grid-2"><div>
      <section class="section" aria-labelledby="s-download">${sectionHead('Sicherung herunterladen', { id: 's-download' })}
        <div class="panel">
          <p class="mb-4">Eine ZIP-Datei mit allem, was der Hub gespeichert hat: Konten, Klassen, Apps mit allen Versionen, Spielstände, Ergebnisse und Dateien. Der Hub läuft dabei weiter.</p>
          <dl class="kv school-kv mb-4">
            <div><dt>Datenbank</dt><dd>${formatBytes(store.db)}</dd></div>
            <div><dt>App-Dateien</dt><dd>${plural(store.blobs.files, 'Datei', 'Dateien')} · ${formatBytes(store.blobs.bytes)}</dd></div>
            <div><dt>Dateien aus Apps</dt><dd>${plural(store.userfiles.files, 'Datei', 'Dateien')} · ${formatBytes(store.userfiles.bytes)}</dd></div>
            <div><dt>Zusammen</dt><dd>etwa ${formatBytes(total)} (gepackt meist weniger)</dd></div>
            <div><dt>Zuletzt</dt><dd>${last ? `${formatDate(last)} (${formatAgo(last)})` : 'noch nie'}</dd></div>
          </dl>
          ${notice({ icon: 'lock', title: 'Die Sicherung enthält alle personenbezogenen Daten', text: 'Speichere sie verschlüsselt und nur dort, wo nur Befugte Zugriff haben – nicht in privaten Cloud-Ordnern. Lösche alte Sicherungen nach den Vorgaben der Schule.' })}
          <form method="post" action="/admin/sicherung" class="admin-backup mt-4" data-download>${csrfField(req)}
            <button class="btn primary">${icon('download')}<span>Sicherung herunterladen</span></button>
            <p class="school-hint admin-backup-status" role="status" hidden>Die Sicherung wird erstellt und heruntergeladen. Bei vielen Apps kann das einige Minuten dauern – lass diese Seite so lange offen.</p>
          </form>
        </div>
      </section>
      <section class="section" aria-labelledby="s-verlauf">${sectionHead('Letzte Sicherungen', { id: 's-verlauf' })}
        ${history.length ? list(history.map((h) => row({ title: formatDate(h.at), sub: `${actorLabel(h.actor_label)}${h.detail ? ` · ${h.detail}` : ''}`, start: html`<span class="school-icon" aria-hidden="true">${icon('hardDrive')}</span>` })))
          : empty({ icon: 'hardDrive', title: 'Noch keine Sicherung heruntergeladen', text: 'Jede heruntergeladene Sicherung steht hier und im Protokoll.' })}
      </section>
    </div><div>
      <section class="section" aria-labelledby="s-zurueck">${sectionHead('Wiederherstellen', { id: 's-zurueck', sub: 'Nur auf dem Server, über die Kommandozeile. Über den Browser lässt sich nichts zurückspielen.' })}
        <ol class="steps admin-steps">
          <li><div><strong>Hub stoppen</strong><span class="muted">Sonst schreibt er weiter in die alten Daten.</span></div></li>
          <li><div><strong>Sicherung einspielen</strong><span class="muted">Im Ordner des Hubs:</span>
            <pre class="code admin-code">npm run restore -- ${backupName()}</pre>
            <dl class="admin-options">
              <div><dt><code>--force</code></dt><dd>wenn der Datenordner nicht leer ist. Die vorhandenen Daten werden nach <code>data/vor-wiederherstellung-…</code> verschoben, nicht gelöscht.</dd></div>
              <div><dt><code>--data &lt;ordner&gt;</code></dt><dd>ein anderer Datenordner als <code>data</code></dd></div>
            </dl></div></li>
          <li><div><strong>Hub starten</strong><span class="muted">Alle melden sich neu an. Prüfe kurz die Übersicht.</span></div></li>
        </ol>
        <p class="school-note">Die Wiederherstellung prüft das Archiv vorher vollständig: nur erlaubte Dateinamen, keine Verknüpfungen, Prüfsummen jeder Datei und eine gültige SchulHub-Datenbank. Aus dem Archiv wird nie etwas ausgeführt.</p>
      </section>
    </div></div>`;
    res.send(adminPage(req, { title: 'Sicherung', tab: 'sicherung', body }));
  });

  /** The backup itself: POST (with the CSRF token) so no link or image can start it. */
  app.post('/admin/sicherung', async (req, res) => {
    const b = await backup.createBackup(ctx);
    res.once('close', () => {
      b.cleanup(); // also when the download is cancelled
      // writeZip waits for 'drain' when the client is slow; after a cancelled
      // download that never comes. Wake it up so it notices and stops.
      if (!res.writableFinished) res.emit('drain');
    });
    try {
      services.audit(req.user, 'sicherung_heruntergeladen', '', `${plural(b.counts.blobs + b.counts.userfiles, 'Datei', 'Dateien')}, ${formatBytes(b.bytes)}`);
      res.once('finish', () => backup.setLastBackupAt(db, Date.now()));
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${backupName()}"`);
      res.setHeader('Cache-Control', 'no-store');
      await uploads.writeZip(res, b.entries);
    } finally {
      b.cleanup();
    }
  });
};
