'use strict';
// Landing page, sign-in / sign-out, local test login, the personal start page,
// in-Hub messages (Mitteilungen), announcements on the start page, and the
// privacy page.

const {
  html, page, flash, csrfField, appIcon, appClass, avatar, ROLE_LABEL, icon, linkButton, postButton, badge,
  sectionHead, row, list, appRow, shelf, shelfItem, meter, sparkline, stat, stats, empty, notice, dueChip,
} = require('../html');
const { HttpError, formatAgo, formatDue, formatLongDay, plural, dayKey, isLocalPath } = require('../util');
const { manifestOf } = require('../manifest');
const { teachersSee } = require('../teacherView');

const MOSAIC = [['🔤', 0], ['⭐', 4], ['🎨', 2], ['🧮', 5], ['🌍', 1], ['🔬', 3], ['🎵', 6], ['🧩', 7]];

module.exports = (app, ctx) => {
  const { db, config, auth, services, access, assignments } = ctx;

  // ---------------------------------------------------------------- landing
  app.get('/', (req, res) => {
    if (req.user) return res.redirect('/start');
    const joining = String(req.session.returnTo || '').startsWith('/beitreten/');
    const wanted = !joining && Boolean(req.session.returnTo);
    const devUsers = config.dev ? db.all("SELECT id, name, role FROM users WHERE oid LIKE 'dev-%' ORDER BY CASE role WHEN 'student' THEN 0 WHEN 'teacher' THEN 1 ELSE 2 END, name") : [];
    const body = html`<section class="hero">
      <div class="stack">
        <span class="eyebrow">${config.hubName} · Die App-Plattform unserer Schule</span>
        <h1>Apps von unserer Schule. Für unsere Schule.</h1>
        <p class="lead">Lern-Apps und Spiele, die Lehrkräfte und Schüler/innen selbst bauen. Einmal anmelden – und deine Klassen, deine Apps und dein Fortschritt sind da.</p>
        ${joining ? notice({ tone: 'wait', icon: 'userPlus', text: 'Melde dich an, um der Klasse beizutreten.' }) : ''}
        ${wanted ? notice({ icon: 'lock', text: 'Bitte melde dich an – danach geht es auf der Seite weiter, die du öffnen wolltest.' }) : ''}
        ${req.query.anmelden === '1' ? notice({ icon: 'lock', text: 'Bitte klicke noch einmal auf „Mit Microsoft-Schulkonto anmelden“. Landest du immer wieder hier, erlaube Cookies für diese Seite – ohne sie ist keine Anmeldung möglich.' }) : ''}
        ${req.query.geloescht === '1' ? notice({ tone: 'ok', text: 'Dein Konto und alle Daten dazu sind gelöscht. Wenn du dich wieder anmeldest, beginnt ein neues, leeres Konto.', role: 'status' }) : ''}
        ${auth.enabled
          ? html`<div class="actions">${linkButton('/auth/login', 'Mit Microsoft-Schulkonto anmelden', { kind: 'primary', size: 'lg', icon: 'arrowRight' })}</div>
             <p class="meta">Es gibt keine eigenen Passwörter: Du meldest dich mit deinem Schulkonto an.</p>`
          : html`<p class="meta">Die Microsoft-Anmeldung ist hier nicht eingerichtet (lokaler Testmodus).</p>`}
      </div>
      <div class="mosaic" aria-hidden="true">${MOSAIC.map(([e, c]) => html`<span class="tile app-${c}">${e}</span>`)}</div>
    </section>
    <section class="section" aria-labelledby="how"><h2 id="how" class="visually-hidden">So funktioniert es</h2>
      <ol class="steps across">
        <li><div><strong>Anmelden</strong><span class="muted">Mit dem Microsoft-Schulkonto – ohne neues Passwort.</span></div></li>
        <li><div><strong>Klasse beitreten</strong><span class="muted">Per QR-Code oder Link von deiner Lehrkraft.</span></div></li>
        <li><div><strong>Lernen, spielen, bauen</strong><span class="muted">Die Apps deiner Klasse nutzen – oder selbst eine bauen.</span></div></li>
      </ol></section>
    ${config.dev ? html`<section class="devlogin" aria-labelledby="dev">
      <h2 id="dev">Lokaler Testmodus: als Testperson anmelden</h2>
      <p class="muted">Diese Anmeldung gibt es nur mit <code>npm run dev</code> auf dem eigenen Rechner.</p>
      ${list(devUsers.map((u) => row({
        title: u.name, sub: ROLE_LABEL[u.role], start: avatar(u.name),
        end: html`<form method="post" action="/dev/login">${csrfField(req)}<input type="hidden" name="user" value="${u.id}"><button class="btn sm">Anmelden</button></form>`,
      })))}
    </section>` : ''}`;
    res.send(page(req, { title: 'Willkommen', body }));
  });

  // ---------------------------------------------------------- Microsoft sign-in
  // A whole school signs in through ONE address, so no limit on the way in may be one that anybody
  // there can fill up for everybody else:
  //  - Starting a sign-in is limited per browser session. A real sign-in starts from a Hub page, and
  //    every Hub page has already given the browser its session (the CSRF token lives there).
  //  - A start WITHOUT a session (a direct link on a first visit, or a script) counts per address. Over
  //    that limit it is not refused but sent to the start page, which gives the browser its session.
  //  - A callback is only looked at when this browser really started a sign-in. Failures never block
  //    anyone; their per-address count only keeps a flood of them out of the audit log.
  app.get('/auth/login', async (req, res, next) => {
    if (req.session.csrf) ctx.limiter.guard('loginSession', req.sessionID);
    else if (!ctx.limiter.hit('loginAnon', req.ip)) return res.redirect('/?anmelden=1');
    const url = await auth.loginUrl(req.session);
    req.session.save((err) => (err ? next(err) : res.redirect(url)));
  });

  app.get('/auth/callback', async (req, res, next) => {
    // Not the end of a sign-in this browser started (an old tab, a reload, a forged link): nothing is
    // checked or counted, and Microsoft is not asked.
    if (!req.session.authFlow) {
      if (req.user) return res.redirect('/start');
      return next(new HttpError(400, 'Diese Anmeldung ist abgelaufen. Bitte melde dich noch einmal an. Passiert das immer wieder, erlaube Cookies für diese Seite – ohne sie ist keine Anmeldung möglich.'));
    }
    let user;
    try {
      user = auth.upsertUser(await auth.handleCallback(req.session, req.query));
    } catch (err) {
      if (err instanceof HttpError && ctx.limiter.hit('loginFailAudit', req.ip)) services.audit(null, 'anmeldung_abgelehnt');
      return next(err);
    }
    auth.establishSession(req, user, (err, target) => (err ? next(err) : res.redirect(target)));
  });

  app.post('/auth/logout', (req, res) => {
    if (req.user) services.audit(req.user, 'abmeldung');
    req.session.destroy(() => {
      res.clearCookie(config.https ? '__Host-hub_sid' : 'hub_sid', { path: '/', secure: config.https, httpOnly: true, sameSite: 'lax' });
      res.redirect(303, req.user ? auth.logoutUrl() : '/');
    });
  });

  // ---------- LOCAL TEST MODE ONLY ----------
  // This route does not exist unless the server was started with --dev,
  // which itself refuses to start unless BASE_URL is localhost.
  if (config.dev) {
    app.post('/dev/login', (req, res, next) => {
      const user = db.get("SELECT * FROM users WHERE id = ? AND oid LIKE 'dev-%'", String(req.body.user || ''));
      if (!user) return next(new HttpError(400, 'Diese Testperson gibt es nicht.'));
      if (user.disabled) return next(new HttpError(403, 'Dieses Konto ist gesperrt. Wende dich an die Verwaltung der Schule.'));
      db.run('UPDATE users SET last_login_at = ?, flagged_inactive_at = NULL WHERE id = ?', Date.now(), user.id);
      auth.establishSession(req, user, (err, target) => (err ? next(err) : res.redirect(303, target)));
    });
  }

  // ------------------------------------------------------------ start page
  const firstName = (name) => (name.includes(',') ? name.split(',')[1].trim() : /^(Herr|Frau|Dr\.?)\s/.test(name) ? name : name.split(' ')[0]);

  /** Announcements this person should see now (school-wide and their classes), not dismissed. */
  function announcementsFor(user) {
    return db
      .all(
        `SELECT an.*, c.name AS class_name, u.name AS author_name FROM announcements an
           LEFT JOIN classes c ON c.id = an.class_id LEFT JOIN users u ON u.id = an.author_id
          WHERE (an.expires_at IS NULL OR an.expires_at > ?)
            AND NOT EXISTS (SELECT 1 FROM announcement_dismissed d WHERE d.announcement_id = an.id AND d.user_id = ?)
          ORDER BY an.created_at DESC LIMIT 20`,
        Date.now(), user.id
      )
      .filter((an) => access.canSeeAnnouncement(user, an))
      .slice(0, 3);
  }

  /** Apps the person used recently and can still open, with how to open them. */
  function recentApps(user, limit) {
    const out = [];
    for (const a of db.all('SELECT a.*, p.last_at FROM plays p JOIN apps a ON a.id = p.app_id WHERE p.user_id = ? ORDER BY p.last_at DESC LIMIT 12', user.id)) {
      const play = access.resolvePlay(user, a);
      if (!play) continue;
      const progress = db.get('SELECT value, label FROM progress WHERE app_id = ? AND user_id = ?', a.id, user.id);
      const cls = play.classId ? db.get('SELECT name FROM classes WHERE id = ?', play.classId) : null;
      out.push({ ...a, href: `/apps/${a.id}/spielen${play.classId ? `?klasse=${play.classId}` : ''}`, progress, className: cls ? cls.name : '' });
      if (out.length >= limit) break;
    }
    return out;
  }

  function announcementsBlock(req, user) {
    const items = announcementsFor(user);
    if (!items.length) return '';
    return html`<div class="stack mb-6">${items.map((an) => notice({
      icon: 'megaphone',
      title: an.title,
      text: html`${an.body ? html`<p class="pre">${an.body}</p>` : ''}<p class="meta">${an.class_name ? `${an.class_name} · ` : 'Ganze Schule · '}${an.author_name || 'Verwaltung'} · ${formatAgo(an.created_at)}</p>`,
      actions: postButton(req, `/mitteilungen/ankuendigung/${an.id}/ausblenden`, 'Ausblenden', { kind: 'quiet', size: 'sm' }),
    }))}</div>`;
  }

  function continueBlock(item) {
    if (!item) return '';
    const p = item.progress;
    return html`<article class="continue ${appClass(item)}">${appIcon(item, 'lg')}
      <div class="continue-text"><span class="eyebrow">Weitermachen</span><h3>${item.name}</h3>
        <span class="meta">${item.className ? `${item.className} · ` : ''}zuletzt ${formatAgo(item.last_at)}</span>
        ${p ? html`<div class="meter-row"><span class="meta">${p.label || 'Fortschritt'}</span><span class="num">${Math.round(p.value * 100)} %</span>${meter(p.value, { tone: 'app' })}</div>` : ''}</div>
      <div class="actions">${linkButton(item.href, 'Weiter', { kind: 'primary', icon: 'play' })}</div></article>`;
  }

  function studentStart(req, user) {
    const recent = recentApps(user, 4);
    const tasks = assignments.openFor(user.id, { limit: 6 });
    const feedback = db.all(
      `SELECT f.*, u.name AS author_name, a.name AS app_name FROM feedback f LEFT JOIN users u ON u.id = f.author_id LEFT JOIN apps a ON a.id = f.app_id
        WHERE f.student_id = ? ORDER BY f.created_at DESC LIMIT 3`,
      user.id
    );
    const classes = access.visibleClasses(user);
    const favourites = db.all('SELECT a.* FROM favorites f JOIN apps a ON a.id = f.app_id WHERE f.user_id = ? ORDER BY f.created_at DESC LIMIT 12', user.id).filter((a) => access.resolvePlay(user, a));
    const gallery = db.all(
      `SELECT a.*, MAX(ca.decided_at) AS decided_at, MIN(c.id) AS class_id FROM class_apps ca
         JOIN apps a ON a.id = ca.app_id JOIN users o ON o.id = a.owner_id AND o.role = 'student'
         JOIN class_members m ON m.class_id = ca.class_id AND m.user_id = ?
         JOIN classes c ON c.id = ca.class_id AND c.archived_at IS NULL
        WHERE ca.status = 'approved' AND a.owner_id <> ? GROUP BY a.id ORDER BY decided_at DESC LIMIT 12`,
      user.id, user.id
    );
    const unlocked = db.all(
      `SELECT ach.achievement, ach.unlocked_at, a.id AS app_id, a.name AS app_name, a.published_version_id, a.schoolwide_version_id
         FROM achievements ach JOIN apps a ON a.id = ach.app_id WHERE ach.user_id = ? ORDER BY ach.unlocked_at DESC LIMIT 8`,
      user.id
    ).map((r) => {
      const v = db.get('SELECT manifest FROM app_versions WHERE id = ?', r.published_version_id || r.schoolwide_version_id || '');
      const def = manifestOf(v).achievements.find((x) => x.id === r.achievement);
      return { ...r, title: def ? def.title : r.achievement, emoji: def ? def.emoji : '🏅' };
    });
    const schoolwide = db.all('SELECT * FROM apps WHERE schoolwide_version_id IS NOT NULL ORDER BY updated_at DESC LIMIT 8');
    const submissions = db.all(
      `SELECT a.id, a.name, a.emoji, a.color, c.name AS class_name, ca.request_state FROM class_apps ca JOIN apps a ON a.id = ca.app_id
         JOIN classes c ON c.id = ca.class_id WHERE a.owner_id = ? AND ca.request_state IS NOT NULL ORDER BY ca.created_at DESC LIMIT 5`,
      user.id
    );

    const left = html`
      ${recent.length ? html`<section class="section">${continueBlock(recent[0])}
        ${recent.length > 1 ? html`<div class="mt-4">${list(recent.slice(1).map((a) => appRow(a, {
          href: a.href,
          sub: html`${a.className ? `${a.className} · ` : ''}${formatAgo(a.last_at)}`,
          end: a.progress ? html`<span class="num meta">${Math.round(a.progress.value * 100)} %</span>` : '',
        })))}</div>` : ''}</section>` : ''}

      <section class="section" aria-labelledby="s-tasks">${sectionHead('Aufgaben', { id: 's-tasks', count: tasks.length ? String(tasks.length) : null })}
        ${tasks.length ? list(tasks.map((t) => {
          const due = formatDue(t.due_at);
          return row({
            href: `/aufgaben/${t.id}`, title: t.title, start: dueChip(t.due_at, due.tone),
            sub: html`${t.app_name} · ${t.class_name}`,
            end: html`${due.tone ? badge(due.text, due.tone) : html`<span class="meta hide-phone">${due.text}</span>`}${t.started ? html` ${badge('begonnen')}` : ''}`,
          });
        })) : empty({ icon: 'checkCircle', title: 'Keine offenen Aufgaben', text: 'Wenn deine Lehrkraft eine Aufgabe stellt, steht sie hier – mit Termin.' })}
      </section>

      ${schoolwide.length ? html`<section class="section" aria-labelledby="s-school">${sectionHead('Für die ganze Schule', { id: 's-school', actions: linkButton('/katalog', 'Alle Apps', { kind: 'quiet', size: 'sm' }) })}
        ${shelf(schoolwide.map((a) => shelfItem(a, `/apps/${a.id}/spielen`)), 'Für die ganze Schule')}</section>` : ''}

      ${favourites.length ? html`<section class="section" aria-labelledby="s-fav">${sectionHead('Favoriten', { id: 's-fav' })}
        ${shelf(favourites.map((a) => shelfItem(a, `/apps/${a.id}/spielen`)), 'Favoriten')}</section>` : ''}

      ${gallery.length ? html`<section class="section" aria-labelledby="s-gal">${sectionHead('Von deinen Klassen gebaut', { id: 's-gal', sub: 'Apps, die Schüler/innen aus deinen Klassen gebaut haben.' })}
        ${shelf(gallery.map((a) => shelfItem(a, `/apps/${a.id}/spielen?klasse=${a.class_id}`)), 'Von deinen Klassen gebaut')}</section>` : ''}`;

    const right = html`
      ${feedback.length ? html`<section class="section" aria-labelledby="s-fb">${sectionHead('Rückmeldungen', { id: 's-fb', actions: linkButton('/rueckmeldungen', 'Alle', { kind: 'quiet', size: 'sm' }) })}
        ${list(feedback.map((f) => row({
          href: '/rueckmeldungen', title: f.author_name || 'Lehrkraft', start: avatar(f.author_name || '?', 'sm'),
          sub: html`<span class="row-sub clamp">${f.body}</span>${f.app_name ? html`<span class="meta">${f.app_name} · ${formatAgo(f.created_at)}</span>` : ''}`,
          end: f.read_at ? '' : badge('neu', 'solid'), cls: f.read_at ? '' : 'unread',
        })))}</section>` : ''}

      <section class="section" aria-labelledby="s-cls">${sectionHead('Meine Klassen', { id: 's-cls' })}
        ${classes.length ? list(classes.map((c) => row({
          href: `/klassen/${c.id}`, title: c.name, start: html`<span class="tile sm app-7" aria-hidden="true">${icon('school', { cls: 'sm' })}</span>`,
          sub: plural(db.get("SELECT COUNT(*) AS n FROM class_apps WHERE class_id = ? AND status = 'approved'", c.id).n, 'App', 'Apps'),
        })))
        : empty({ icon: 'userPlus', title: 'Noch in keiner Klasse', text: 'Deine Lehrkraft zeigt dir einen QR-Code oder einen Link. Scanne ihn mit dem Handy oder öffne den Link – schon bist du dabei.', actions: linkButton('/katalog', 'Apps entdecken', { icon: 'apps' }) })}
      </section>

      ${unlocked.length ? html`<section class="section" aria-labelledby="s-ach">${sectionHead('Erfolge', { id: 's-ach', count: String(db.get('SELECT COUNT(*) AS n FROM achievements WHERE user_id = ?', user.id).n) })}
        <div class="achievement-strip">${unlocked.map((u) => html`<span class="achievement" title="${u.app_name} · ${formatAgo(u.unlocked_at)}"><span class="emoji" aria-hidden="true">${u.emoji}</span>${u.title}</span>`)}</div></section>` : ''}

      ${submissions.length ? html`<section class="section" aria-labelledby="s-sub">${sectionHead('Deine eingereichten Apps', { id: 's-sub' })}
        ${list(submissions.map((s) => appRow(s, {
          href: `/apps/${s.id}`, sub: s.class_name,
          end: s.request_state === 'returned' ? badge('zurückgegeben', 'danger') : badge('wartet', 'wait'),
        })))}</section>` : ''}`;

    return html`<div class="grid-2"><div>${left}</div><div>${right}</div></div>`;
  }

  function teacherStart(req, user) {
    const waiting = db.all(
      `SELECT a.id, a.name, a.emoji, a.color, c.id AS class_id, c.name AS class_name, u.name AS owner_name, v.number AS version_number, ca.created_at
         FROM class_apps ca JOIN apps a ON a.id = ca.app_id JOIN classes c ON c.id = ca.class_id AND c.archived_at IS NULL
         JOIN class_members m ON m.class_id = ca.class_id AND m.user_id = ? AND m.role = 'teacher'
         JOIN users u ON u.id = a.owner_id LEFT JOIN app_versions v ON v.id = ca.requested_version_id
        WHERE ca.request_state = 'waiting' ORDER BY ca.created_at LIMIT 20`,
      user.id
    );
    const teaching = access.visibleClasses(user).filter((c) => c.my_role === 'teacher' || user.role === 'admin');
    // The list shows 12; the number and the way to the rest count all of them.
    const classes = teaching.slice(0, 12);
    const now = Date.now();
    const days = [...Array(14)].map((_, i) => dayKey(now - (13 - i) * 86_400_000));
    const activity = (classId) => {
      const counts = new Map(db.all('SELECT created_at FROM results WHERE class_id = ? AND created_at > ?', classId, now - 14 * 86_400_000).reduce((m, r) => m.set(dayKey(r.created_at), (m.get(dayKey(r.created_at)) || 0) + 1), new Map()));
      return days.map((d) => counts.get(d) || 0);
    };
    const studentCount = (classId) => db.get("SELECT COUNT(*) AS n FROM class_members WHERE class_id = ? AND role = 'student'", classId).n;
    const dueSoon = db.all(
      `SELECT x.*, a.name AS app_name, a.emoji, a.color, c.name AS class_name FROM assignments x
         JOIN classes c ON c.id = x.class_id AND c.archived_at IS NULL
         JOIN class_members m ON m.class_id = x.class_id AND m.user_id = ? AND m.role = 'teacher'
         JOIN apps a ON a.id = x.app_id
        WHERE x.due_at IS NOT NULL AND x.due_at > ? ORDER BY x.due_at LIMIT 5`,
      user.id, now - 86_400_000
    );
    const activeToday = db.get(
      `SELECT COUNT(DISTINCT p.user_id) AS n FROM plays p JOIN class_members s ON s.user_id = p.user_id AND s.role = 'student'
         JOIN class_members t ON t.class_id = s.class_id AND t.user_id = ? AND t.role = 'teacher' WHERE p.last_at > ?`,
      user.id, now - 86_400_000
    ).n;
    const recent = recentApps(user, 3);

    return html`
      ${classes.length ? stats([
        stat({ label: 'Warten auf Prüfung', value: waiting.length, tone: waiting.length ? 'wait' : '', href: '/pruefen', sub: waiting.length ? 'Apps von Schüler/innen' : 'Alles geprüft' }),
        stat({ label: 'Klassen', value: teaching.length, href: '/klassen' }),
        stat({ label: 'Heute aktiv', value: activeToday, sub: 'Schüler/innen in deinen Klassen' }),
        stat({ label: 'Aufgaben fällig', value: dueSoon.length, sub: 'in den nächsten Tagen' }),
      ]) : ''}
      <div class="grid-2 mt-6"><div>
        ${waiting.length ? html`<section class="section" aria-labelledby="s-wait">${sectionHead('Wartet auf dich', { id: 's-wait', count: String(waiting.length), actions: linkButton('/pruefen', 'Alle prüfen', { kind: 'quiet', size: 'sm' }) })}
          <div class="list attention">${waiting.slice(0, 6).map((w) => html`<div class="row">${appIcon(w)}<div class="row-main">
            <a class="row-link row-title" href="/pruefen/${w.class_id}/${w.id}">${w.name}</a>
            <span class="row-sub">von ${w.owner_name} · ${w.class_name} · Version ${w.version_number || '–'} · ${formatAgo(w.created_at)}</span></div>
            <div class="row-end">${badge('wartet', 'wait')}${icon('chevronRight', { cls: 'chev' })}</div></div>`)}</div></section>` : ''}

        <section class="section" aria-labelledby="s-cls">${sectionHead('Deine Klassen', { id: 's-cls', actions: classes.length ? linkButton('/klassen/neu', 'Klasse anlegen', { kind: 'quiet', size: 'sm', icon: 'plus' }) : '' })}
          ${classes.length ? list(classes.map((c) => {
            const a = activity(c.id);
            return row({
              href: `/klassen/${c.id}`, title: c.name,
              sub: `${plural(studentCount(c.id), 'Schüler/in', 'Schüler/innen')} · ${plural(a.reduce((s, x) => s + x, 0), 'Ergebnis', 'Ergebnisse')} in 14 Tagen`,
              end: html`<span class="hide-phone">${sparkline(a, { label: `Ergebnisse pro Tag in ${c.name}` })}</span>`,
            });
          }))
          : empty({ icon: 'school', title: 'Noch keine Klasse', text: 'Lege deine erste Klasse an. Deine Schüler/innen treten dann per QR-Code oder Link bei.', actions: linkButton('/klassen/neu', 'Erste Klasse anlegen', { kind: 'primary', icon: 'plus' }) })}
          ${teaching.length > classes.length ? html`<p class="mt-2">${linkButton('/klassen', `Alle ${teaching.length} Klassen`, { kind: 'quiet', size: 'sm' })}</p>` : ''}
        </section>
      </div><div>
        ${dueSoon.length ? html`<section class="section" aria-labelledby="s-due">${sectionHead('Bald fällig', { id: 's-due' })}
          ${list(dueSoon.map((t) => {
            const due = formatDue(t.due_at);
            return row({ href: `/aufgaben/${t.id}`, title: t.title, start: dueChip(t.due_at, due.tone), sub: `${t.class_name} · ${t.app_name}`, end: due.tone ? badge(due.text, due.tone) : '' });
          }))}</section>` : ''}
        ${recent.length ? html`<section class="section" aria-labelledby="s-rec">${sectionHead('Zuletzt geöffnet', { id: 's-rec' })}
          ${list(recent.map((a) => appRow(a, { href: a.href, sub: formatAgo(a.last_at) })))}</section>` : ''}
        <section class="section" aria-labelledby="s-build">${sectionHead('Selbst bauen', { id: 's-build' })}
          <p class="muted mb-4">Eigene Apps für den Unterricht: aus einer Vorlage, im Editor oder als Ordner hochgeladen.</p>
          <div class="actions">${linkButton('/apps', 'Meine Apps', { icon: 'bauen' })}${linkButton('/katalog', 'Apps entdecken', { kind: 'quiet', icon: 'apps' })}</div></section>
      </div></div>`;
  }

  app.get('/start', (req, res) => {
    const user = req.user;
    const staff = access.isStaff(user);
    const body = html`<header class="greeting"><span class="eyebrow">${formatLongDay(Date.now())}</span><h1>Hallo, ${firstName(user.name)}!</h1></header>
      ${announcementsBlock(req, user)}
      ${staff ? teacherStart(req, user) : studentStart(req, user)}`;
    res.send(page(req, { title: 'Start', body, active: 'start' }));
  });

  // ------------------------------------------------------------ Mitteilungen
  app.get('/mitteilungen', (req, res) => {
    const items = db.all('SELECT * FROM notices WHERE user_id = ? ORDER BY id DESC LIMIT 100', req.user.id);
    const unread = items.filter((n) => !n.read_at).length;
    const ICON = { pruefen: 'clock', freigegeben: 'checkCircle', zurueckgegeben: 'undo', aufgabe: 'tasks', rueckmeldung: 'message', ankuendigung: 'megaphone' };
    const body = html`<header class="page-head"><div class="page-head-text"><h1>Mitteilungen</h1>
        <p>Was sich bei dir getan hat. ${unread ? plural(unread, 'neue Mitteilung', 'neue Mitteilungen') + '.' : 'Alles gelesen.'}</p></div>
        ${unread ? html`<div class="actions">${postButton(req, '/mitteilungen/gelesen', 'Alle als gelesen markieren', { kind: 'secondary', icon: 'check' })}</div>` : ''}</header>
      ${items.length ? html`<ul class="list" role="list">${items.map((n) => html`<li class="row notice-row${n.read_at ? '' : ' unread'}">
        <span class="avatar" aria-hidden="true">${icon(ICON[n.kind] || 'bell', { cls: 'sm' })}</span>
        <div class="row-main">${n.href
          ? html`<form method="post" action="/mitteilungen/${n.id}/oeffnen" class="row-form-link">${csrfField(req)}<button class="row-link row-title">${n.text}</button></form>`
          : html`<span class="row-title">${n.text}</span>`}<span class="row-sub">${formatAgo(n.created_at)}</span></div>
        ${n.href ? html`<div class="row-end">${icon('chevronRight', { cls: 'chev' })}</div>` : ''}</li>`)}</ul>`
      : empty({ icon: 'bell', title: 'Noch keine Mitteilungen', text: 'Hier erfährst du zum Beispiel, wenn deine App freigegeben wurde oder eine neue Aufgabe da ist.' })}`;
    res.send(page(req, { title: 'Mitteilungen', body, width: 'narrow' }));
  });

  /** Open one notice: mark it read, then go where it points (only the person's own notices). */
  app.post('/mitteilungen/:id/oeffnen', (req, res) => {
    const n = db.get('SELECT * FROM notices WHERE id = ? AND user_id = ?', Number.parseInt(req.params.id, 10) || 0, req.user.id);
    if (!n) throw new HttpError(404, 'Diese Seite gibt es nicht – oder du hast keinen Zugriff darauf.');
    if (!n.read_at) db.run('UPDATE notices SET read_at = ? WHERE id = ?', Date.now(), n.id);
    res.redirect(303, isLocalPath(n.href) ? n.href : '/mitteilungen');
  });

  app.post('/mitteilungen/gelesen', (req, res) => {
    db.run('UPDATE notices SET read_at = ? WHERE user_id = ? AND read_at IS NULL', Date.now(), req.user.id);
    res.redirect(303, '/mitteilungen');
  });

  /** Hide an announcement for oneself (only one this person may see). */
  app.post('/mitteilungen/ankuendigung/:id/ausblenden', (req, res) => {
    const an = db.get('SELECT * FROM announcements WHERE id = ?', String(req.params.id));
    if (!an || !access.canSeeAnnouncement(req.user, an)) throw new HttpError(404, 'Diese Seite gibt es nicht – oder du hast keinen Zugriff darauf.');
    db.run('INSERT OR IGNORE INTO announcement_dismissed (announcement_id, user_id) VALUES (?, ?)', an.id, req.user.id);
    flash(req, `Die Ankündigung „${an.title}“ ist ausgeblendet.`);
    res.redirect(303, '/start');
  });

  // ---------------------------------------------------------------- privacy
  app.get('/datenschutz', (req, res) => {
    const days = ctx.settings.get('retention.auditDays');
    const body = html`<article class="prose">
    <span class="eyebrow">Datenschutz</span>
    <h1>Welche Daten speichert ${config.hubName}?</h1>
    <p class="lead">So wenig wie möglich. Hier steht alles – in normaler Sprache.</p>
    <h2>Über dich</h2>
    <ul><li><strong>Name und Schul-E-Mail-Adresse</strong> aus deinem Microsoft-Schulkonto. Deinen Namen sehen zum Beispiel deine Lehrkräfte, die E-Mail-Adresse sieht nur die Verwaltung der Schule.</li>
    <li><strong>Eine Kennnummer</strong> von Microsoft, damit dein Konto dasselbe bleibt, auch wenn sich dein Name ändert.</li>
    <li><strong>Deine Rolle</strong> (Schüler/in, Lehrkraft oder Admin) und in welchen Klassen du bist.</li>
    <li>Wann du dich zuletzt angemeldet hast, und wie du ${config.hubName} angezeigt bekommen möchtest (zum Beispiel hell oder dunkel).</li></ul>
    <p>Dein Passwort sieht ${config.hubName} nie. Es werden keine Fotos, Geburtsdaten, Adressen oder Standorte gespeichert, und es gibt keine Werbung und kein Tracking.</p>
    <h2>In den Apps</h2>
    <ul><li><strong>Spielstände und Dateien</strong> (zum Beispiel ein gemaltes Bild), damit du weitermachen kannst.</li>
    <li><strong>Ergebnisse, Bestwerte, Fortschritt und Erfolge</strong>, wenn eine App sie für dich festhält.</li>
    <li><strong>Bestenlisten.</strong> Deinen Namen sehen dort nur Personen aus deinen Klassen. Du kannst einstellen, dass auch dort „Anonym“ steht.</li></ul>
    <p>Apps laufen abgeschottet: Eine App kommt nur an ihre eigenen Daten und kann nichts ins Internet schicken. Apps erfahren deinen Namen, aber nicht deine E-Mail-Adresse. In der Vorschau einer App wird nichts gespeichert.</p>
    <h2>Was Lehrkräfte sehen</h2>
    ${teachersSee('Ist eine App in einer deiner Klassen freigegeben, sehen die Lehrkräfte dieser Klasse:')}
    <p>Deine E-Mail-Adresse sehen sie nie. Die Verwaltung der Schule kann alles sehen, was Lehrkräfte sehen. Schreib deshalb nichts Geheimes in eine App.</p>
    <h2>Von Lehrkräften</h2>
    <ul><li><strong>Aufgaben und Rückmeldungen</strong>, die deine Lehrkraft dir gibt. Rückmeldungen sehen nur du, die Lehrkräfte deiner Klasse und die Schulverwaltung.</li>
    <li><strong>Mitteilungen</strong> im Hub (zum Beispiel „deine App wurde freigegeben“). Es werden keine E-Mails verschickt.</li></ul>
    <h2>Deine Rechte</h2>
    <p>Unter <a href="/meine-daten">Meine Daten</a> kannst du jederzeit alles ansehen, herunterladen und löschen – einzelne App-Daten oder dein ganzes Konto.</p>
    <h2>Wie lange?</h2>
    <p>Wichtige Vorgänge (Anmeldungen, Uploads, Freigaben, Löschungen, Rollenänderungen) werden für die Schulleitung protokolliert und nach ${days} Tagen automatisch gelöscht. Archivierte Klassen werden nach einer Frist gelöscht. Konten werden nie automatisch gelöscht – die Verwaltung sieht nur, welche lange nicht benutzt wurden.</p>
    <p>Für App-Autor/innen zählt ${config.hubName} nur, wie oft eine App pro Tag geöffnet wurde – ohne Namen und ohne Klassen.</p>
    </article>`;
    res.send(page(req, { title: 'Datenschutz', body, width: 'narrow' }));
  });
};
