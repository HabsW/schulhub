'use strict';
// Classes (package A): the class list, creating a class, the class page
// (teachers: Überblick, Aufgaben, Apps, Mitglieder, Einstellungen; students:
// their own view), joining by QR code / link, the projector view, join codes,
// members and the apps of a class. Assignments, feedback, co-teacher
// invitations, archive and per-class app settings live in routes/teaching.js.
// Every permission comes from access.js; everything people wrote is escaped.

const qrcode = require('qrcode-generator');
const {
  html, raw, escapeHtml, page, flash, csrfField, postButton, linkButton, appIcon, appClass, appRow, row, list, pageHead, tabs,
  sectionHead, stats, stat, meter, badge, notice, empty, field, formValue, dataTable, shelf, shelfItem, dueChip, icon, avatar,
} = require('../html');
const { deny, bad, cleanText, formatDate, formatDay, formatAgo, formatDue, plural, safeEqual, HttpError } = require('../util');
const { CATEGORIES, manifestOf } = require('../manifest');
const kit = require('../teachingKit');
const { teachersSee } = require('../teacherView');

/** QR code as SVG, built from our own URL (no user input, no inline styles). */
function qrSvg(text, label = 'QR-Code zum Beitreten') {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 2} ${r + 2}h1v1h-1z`;
  return raw(`<svg viewBox="0 0 ${n + 4} ${n + 4}" role="img" aria-label="${escapeHtml(label)}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`);
}

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
/** 0 = started without a measurable value, 1..5 = how far (monochrome heat). */
const heatLevel = (v) => (v <= 0 ? 0 : Math.min(5, Math.max(1, Math.ceil(v * 5))));
const MATRIX_APPS = 12;
const STYLES = ['css/teaching.css'];

module.exports = (app, ctx) => {
  const { db, config, access, services, limiter, assignments } = ctx;

  const getClass = (id) => db.get('SELECT * FROM classes WHERE id = ?', String(id));
  const viewClass = (req) => kit.loadClass(ctx, req, 'view');
  const manageClass = (req) => kit.loadClass(ctx, req, 'manage');
  const changeClass = (req) => kit.loadClass(ctx, req, 'change');
  const activeCode = (classId, role = 'student') =>
    db.get('SELECT * FROM join_codes WHERE class_id = ? AND role = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 1', classId, role, Date.now());
  const joinUrl = (code) => `${config.hubOrigin}/beitreten/${code}`;

  const teachersOf = (classId) =>
    db.all("SELECT u.id, u.name, m.joined_at FROM class_members m JOIN users u ON u.id = m.user_id WHERE m.class_id = ? AND m.role = 'teacher' ORDER BY u.name COLLATE NOCASE", classId);
  const studentCount = (classId) => db.get("SELECT COUNT(*) AS n FROM class_members WHERE class_id = ? AND role = 'student'", classId).n;
  const studentsOf = (classId) =>
    db.all("SELECT u.id, u.name, m.joined_at FROM class_members m JOIN users u ON u.id = m.user_id WHERE m.class_id = ? AND m.role = 'student' ORDER BY u.name COLLATE NOCASE LIMIT 300", classId);

  /** Submissions of the class: waiting first, then returned ones. */
  const submissionsOf = (classId) =>
    db.all(
      `SELECT a.*, ca.status, ca.version_id, ca.requested_version_id, ca.request_state, u.name AS owner_name,
              v.number AS version_number, cv.number AS current_number,
              (SELECT MAX(c.created_at) FROM comments c WHERE c.app_id = a.id AND c.class_id = ca.class_id AND c.kind = 'submitted') AS submitted_at
         FROM class_apps ca JOIN apps a ON a.id = ca.app_id JOIN users u ON u.id = a.owner_id
         LEFT JOIN app_versions v ON v.id = ca.requested_version_id LEFT JOIN app_versions cv ON cv.id = ca.version_id
        WHERE ca.class_id = ? AND ca.request_state IN ('waiting','returned')
        ORDER BY CASE ca.request_state WHEN 'waiting' THEN 0 ELSE 1 END, submitted_at LIMIT 100`,
      classId
    );
  const submissionSub = (w) =>
    html`von ${w.owner_name} · Version ${w.version_number || '–'}${w.current_number ? ` · die Klasse nutzt weiter Version ${w.current_number}` : ''}${w.submitted_at ? ` · ${formatAgo(w.submitted_at)}` : ''}`;
  const submissionRow = (cls, w) =>
    appRow(w, {
      href: `/pruefen/${cls.id}/${w.id}`,
      sub: w.request_state === 'returned' ? html`von ${w.owner_name} · zurückgegeben, wartet auf eine neue Version` : submissionSub(w),
      end: w.request_state === 'returned' ? badge('zurückgegeben') : badge('wartet', 'wait'),
    });

  // ================================================================ class list

  /** Classes of this user with their numbers, in one query (the list itself comes from access.visibleClasses). */
  function classList(user, archived) {
    const visible = access.visibleClasses(user, { archived }).slice(0, 200);
    if (!visible.length) return [];
    const numbers = new Map(
      db
        .all(
          `SELECT c.id,
                  (SELECT COUNT(*) FROM class_members s WHERE s.class_id = c.id AND s.role = 'student') AS students,
                  (SELECT COUNT(*) FROM class_apps ca WHERE ca.class_id = c.id AND ca.status = 'approved') AS apps,
                  (SELECT COUNT(*) FROM class_apps ca WHERE ca.class_id = c.id AND ca.request_state = 'waiting') AS waiting,
                  (SELECT GROUP_CONCAT(u.name, ', ') FROM class_members t JOIN users u ON u.id = t.user_id WHERE t.class_id = c.id AND t.role = 'teacher') AS teachers
             FROM classes c WHERE c.id IN (SELECT value FROM json_each(?))`,
          JSON.stringify(visible.map((c) => c.id))
        )
        .map((r) => [r.id, r])
    );
    return visible.map((c) => ({ ...c, ...numbers.get(c.id) }));
  }

  app.get('/klassen', (req, res) => {
    const user = req.user;
    const staff = access.canCreateClass(user);
    const classes = classList(user, false);
    const archived = staff ? classList(user, true) : [];
    const teaches = (c) => access.isAdmin(user) || c.my_role === 'teacher';
    // The amber count in the navigation leads here, so the way to the review queue starts here too.
    const waitingTotal = staff
      ? db.get(
          `SELECT COUNT(*) AS n FROM class_apps ca JOIN class_members m ON m.class_id = ca.class_id AND m.user_id = ? AND m.role = 'teacher'
             JOIN classes c ON c.id = ca.class_id AND c.archived_at IS NULL WHERE ca.request_state = 'waiting'`,
          user.id
        ).n
      : 0;

    const classRow = (c) =>
      row({
        href: `/klassen/${c.id}`,
        title: c.name,
        start: kit.classMark(c),
        sub: teaches(c)
          ? [kit.classEyebrow(c), kit.studentsText(c.students), plural(c.apps, 'App', 'Apps')].filter(Boolean).join(' · ')
          : [c.teachers || '', plural(c.apps, 'App', 'Apps'), staff ? 'du bist hier Schüler/in' : ''].filter(Boolean).join(' · '),
        end: c.waiting && teaches(c)
          ? html`<span class="count wait" aria-hidden="true">${c.waiting}</span><span class="visually-hidden">${plural(c.waiting, 'App wartet', 'Apps warten')} auf Prüfung</span>`
          : '',
      });

    const body = html`${pageHead({
      title: 'Klassen',
      lead: staff ? 'Deine Klassen. Schüler/innen treten selbst per QR-Code oder Link bei.' : 'Die Klassen, in denen du bist.',
      actions: staff ? linkButton('/klassen/neu', 'Neue Klasse', { kind: 'primary', icon: 'plus' }) : '',
    })}
    ${waitingTotal ? notice({ tone: 'wait', title: `${plural(waitingTotal, 'App wartet', 'Apps warten')} auf deine Prüfung`, text: 'Apps von Schüler/innen brauchen deine Freigabe, bevor die Klasse sie benutzen kann.', actions: linkButton('/pruefen', 'Jetzt prüfen', { kind: 'secondary', size: 'sm', icon: 'arrowRight' }), cls: 'mb-6' }) : ''}
    ${classes.length
      ? list(classes.map(classRow))
      : staff
        ? empty({ icon: 'school', title: 'Noch keine Klasse', text: 'Lege deine erste Klasse an. Deine Schüler/innen treten dann per QR-Code oder Link bei – niemand muss Namen eintippen.', actions: linkButton('/klassen/neu', 'Erste Klasse anlegen', { icon: 'plus' }) })
        : empty({ icon: 'userPlus', title: 'Noch in keiner Klasse', text: 'Deine Lehrkraft zeigt dir einen QR-Code oder schickt dir einen Link. Scanne den Code mit der Kamera deines Handys oder öffne den Link – dann bist du dabei.' })}
    ${staff && archived.length
      ? html`<details class="disclosure teach-archive"><summary><span class="teach-sumtitle">${icon('archive')}Archiv</span><span class="teach-count">${archived.length}</span></summary>
          <div class="disclosure-body"><p class="meta mb-4">Archivierte Klassen sind schreibgeschützt und für Schüler/innen unsichtbar. Sie werden nach Ablauf der Frist gelöscht.</p>
          ${list(archived.map((c) => row({
            href: `/klassen/${c.id}`,
            title: c.name,
            start: kit.classMark(c),
            sub: `archiviert ${formatDay(c.archived_at)} · wird am ${kit.deletionDay(ctx, c)} gelöscht`,
          })))}</div></details>`
      : ''}`;
    res.send(page(req, { title: 'Klassen', body, active: 'klassen', styles: STYLES }));
  });

  // ------------------------------------------------------------- new class

  const subjectSelect = (req, current) =>
    html`<select id="f-fach" name="fach"><option value="">Kein Fach</option>${CATEGORIES.map((c) => html`<option value="${c}"${c === formValue(req, 'fach', current) ? raw(' selected') : ''}>${c}</option>`)}</select>`;
  const gradeSelect = (req, current) =>
    html`<select id="f-stufe" name="stufe"><option value="">Keine</option>${Array.from({ length: 13 }, (_, i) => String(i + 1)).map((g) => html`<option value="${g}"${g === String(formValue(req, 'stufe', current ?? '')) ? raw(' selected') : ''}>${g}</option>`)}</select>`;
  /** Subject and grade from a form: one of the fixed subjects, a grade 1..13, or empty. */
  function subjectGrade(body) {
    const subject = typeof body.fach === 'string' && CATEGORIES.includes(body.fach) ? body.fach : '';
    if (body.fach && !subject) throw bad('Dieses Fach gibt es nicht.');
    const sent = typeof body.stufe === 'string' ? body.stufe.trim() : '';
    const grade = sent === '' ? null : Number.parseInt(sent, 10);
    if (sent !== '' && !(/^\d{1,2}$/.test(sent) && grade >= 1 && grade <= 13)) throw bad('Die Klassenstufe muss zwischen 1 und 13 liegen.');
    return { subject, grade };
  }

  app.get('/klassen/neu', (req, res) => {
    if (!access.canCreateClass(req.user)) throw deny();
    const body = html`${pageHead({ crumbs: [['/klassen', 'Klassen']], title: 'Neue Klasse', lead: 'Schüler/innen treten danach selbst per QR-Code oder Link bei – niemand muss Namen eintippen.' })}
      <form method="post" action="/klassen" class="form">${csrfField(req)}
        ${field(req, { label: 'Name der Klasse', name: 'name', required: true, hint: 'Zum Beispiel „7b Englisch“. Den Namen sehen alle in der Klasse.', attrs: 'minlength="2" maxlength="60" autocomplete="off"' })}
        <div class="form-row">
          ${field(req, { label: 'Fach (freiwillig)', name: 'fach', control: subjectSelect(req, '') })}
          ${field(req, { label: 'Klassenstufe (freiwillig)', name: 'stufe', control: gradeSelect(req, '') })}
        </div>
        <div class="actions stack-phone"><button class="btn primary">${icon('plus')}<span>Klasse anlegen</span></button>${linkButton('/klassen', 'Abbrechen', { kind: 'quiet' })}</div>
      </form>`;
    res.send(page(req, { title: 'Neue Klasse', body, active: 'klassen', width: 'narrow', styles: STYLES }));
  });

  app.post('/klassen', (req, res) => {
    if (!access.canCreateClass(req.user)) throw deny();
    const name = cleanText(req.body.name, 60);
    if (name.length < 2) throw bad('Bitte gib der Klasse einen Namen.');
    const { subject, grade } = subjectGrade(req.body);
    const mine = db.get("SELECT COUNT(*) AS n FROM class_members WHERE user_id = ? AND role = 'teacher'", req.user.id).n;
    if (mine >= config.limits.classesPerTeacher) throw bad('Du hast sehr viele Klassen. Bitte lösche zuerst alte Klassen.');
    const id = services.createClass(req.user, name);
    if (subject || grade) db.run('UPDATE classes SET subject = ?, grade = ? WHERE id = ?', subject, grade, id);
    services.createJoinCode(req.user, id, 1440);
    flash(req, `„${name}“ ist angelegt. Zeig deiner Klasse jetzt den QR-Code – dann tritt sie bei.`);
    res.redirect(303, `/klassen/${id}`);
  });

  // ============================================================ teacher view

  /** The frame of every teacher tab: head with actions, tabs, archive note. */
  function teacherPage(req, cls, current, body) {
    const user = req.user;
    const archived = Boolean(cls.archived_at);
    const change = access.canChangeClass(user, cls.id);
    const teachers = teachersOf(cls.id);
    const waiting = db.get("SELECT COUNT(*) AS n FROM class_apps WHERE class_id = ? AND request_state = 'waiting'", cls.id).n;
    const base = `/klassen/${cls.id}`;
    const head = pageHead({
      crumbs: [['/klassen', 'Klassen']],
      eyebrow: kit.classEyebrow(cls) || 'Klasse',
      title: cls.name,
      meta: html`<span>${icon('user', { cls: 'sm' })}${teachers.length ? teachers.map((t) => t.name).join(', ') : 'keine Lehrkraft'}</span><span>${kit.studentsText(studentCount(cls.id))}</span>${archived ? badge('archiviert') : ''}`,
      actions: change
        ? html`${linkButton(`${base}/qr`, 'Beitreten lassen', { kind: 'primary', icon: 'qr' })}${linkButton(`${base}/aufgaben/neu`, 'Aufgabe stellen', { icon: 'plus' })}${access.canAnnounce(user, cls.id) ? linkButton(`/ankuendigungen?klasse=${cls.id}`, 'Ankündigung', { kind: 'quiet', icon: 'megaphone' }) : ''}`
        : '',
      tabs: tabs(
        [
          [base, 'Überblick', 'ueberblick'],
          [`${base}/aufgaben`, 'Aufgaben', 'aufgaben'],
          [`${base}/apps`, 'Apps', 'apps', waiting && !archived ? { n: waiting, tone: 'wait' } : null],
          [`${base}/mitglieder`, 'Mitglieder', 'mitglieder'],
          [`${base}/einstellungen`, 'Einstellungen', 'einstellungen'],
        ],
        current,
        'Bereiche der Klasse'
      ),
    });
    const note = archived
      ? notice({
          tone: 'wait',
          icon: 'archive',
          title: 'Archiviert – nur noch lesbar',
          text: `Schüler/innen sehen diese Klasse nicht mehr, und niemand kann etwas ändern. Am ${kit.deletionDay(ctx, cls)} wird sie mit allen Aufgaben und Rückmeldungen gelöscht.`,
          actions: access.canManageClass(user, cls.id) ? postButton(req, `${base}/wiederherstellen`, 'Aus dem Archiv holen', { size: 'sm', icon: 'undo' }) : '',
          cls: 'mb-6',
        })
      : '';
    return page(req, { title: cls.name, body: html`${head}${note}${body}`, active: 'klassen', classId: cls.id, styles: STYLES });
  }

  // ------------------------------------------------------------ Überblick

  /** progress (0..1) or best result in this class, per app and student - three queries for the whole class. */
  function matrixData(cls) {
    const key = (r) => `${r.app_id}:${r.user_id}`;
    const progress = new Map(
      db.all(
        `SELECT p.app_id, p.user_id, p.value FROM progress p
           JOIN class_members m ON m.user_id = p.user_id AND m.class_id = ? AND m.role = 'student'
           JOIN class_apps ca ON ca.app_id = p.app_id AND ca.class_id = m.class_id AND ca.status = 'approved'`,
        cls.id
      ).map((r) => [key(r), r.value])
    );
    const results = new Map(
      db.all(
        `SELECT r.app_id, r.user_id, COUNT(*) AS n, MAX(CASE WHEN r.max_score > 0 THEN r.score * 1.0 / r.max_score END) AS best
           FROM results r
           JOIN class_members m ON m.user_id = r.user_id AND m.class_id = ? AND m.role = 'student'
           JOIN class_apps ca ON ca.app_id = r.app_id AND ca.class_id = m.class_id AND ca.status = 'approved'
          WHERE r.class_id = m.class_id OR r.class_id = ''
          GROUP BY r.app_id, r.user_id`,
        cls.id
      ).map((r) => [key(r), r])
    );
    const played = new Set(
      db.all(
        `SELECT p.app_id, p.user_id FROM plays p
           JOIN class_members m ON m.user_id = p.user_id AND m.class_id = ? AND m.role = 'student'
           JOIN class_apps ca ON ca.app_id = p.app_id AND ca.class_id = m.class_id AND ca.status = 'approved'`,
        cls.id
      ).map(key)
    );
    return (appId, userId) => {
      const k = `${appId}:${userId}`;
      if (progress.has(k)) return { v: clamp01(progress.get(k)), kind: 'progress' };
      const r = results.get(k);
      if (r && r.best !== null) return { v: clamp01(r.best), kind: 'best' };
      if (r || played.has(k)) return { v: 0, kind: 'started' };
      return null;
    };
  }

  function matrixCell(cls, s, a, value) {
    const pct = value ? Math.round(value.v * 100) : 0;
    const text = !value ? 'nicht begonnen' : value.kind === 'started' ? 'begonnen' : value.kind === 'progress' ? `${pct} % geschafft` : `bestes Ergebnis ${pct} %`;
    const measured = value && value.kind !== 'started';
    // not started: dashed outline · started without a percentage: hairline and a dot · measured: heat 1..5
    const level = !value ? 'heat-none' : measured ? `heat-${heatLevel(value.v)}` : 'heat-0 teach-started';
    return html`<a class="teach-cell" href="/klassen/${cls.id}/apps/${a.id}/ergebnisse/${s.id}" aria-label="${s.name}, ${a.name}: ${text}">
      <span class="teach-heat ${level}" aria-hidden="true">${!value ? '' : measured ? pct : '•'}</span>
      <span class="teach-mini" aria-hidden="true">${measured ? html`${meter(value.v)}<span class="teach-mini-text">${pct} %</span>` : html`<span class="teach-mini-none">${text}</span>`}</span></a>`;
  }

  function assignmentCounts(x) {
    const states = assignments.classStates(x);
    return { total: states.length, done: states.filter((s) => s.state === 'done').length, started: states.filter((s) => s.state === 'started').length };
  }

  /** One assignment as a row: date chip, title, app, how many are done (with all three counts in the full list). */
  function assignmentRow(x, now, { counts: showCounts = false } = {}) {
    const counts = assignmentCounts(x);
    const planned = x.starts_at > now;
    const past = x.due_at && x.due_at < now;
    const due = formatDue(x.due_at, now);
    const open = counts.total - counts.done - counts.started;
    return row({
      href: `/aufgaben/${x.id}`,
      title: x.title,
      start: dueChip(x.due_at, past ? '' : due.tone),
      sub: html`<span>${x.app_name} · ${planned ? `beginnt ${formatDay(x.starts_at)}` : past ? `abgelaufen ${formatDay(x.due_at)}` : due.text}</span>${showCounts && counts.total ? html`<span class="teach-counts">${counts.done} erledigt · ${counts.started} begonnen · ${open} offen</span>` : ''}`,
      end: counts.total
        ? html`<span class="teach-done">${meter(counts.done / counts.total, { tone: 'ok', label: `${counts.done} von ${counts.total} erledigt` })}<span class="num">${counts.done}/${counts.total}</span></span>`
        : '',
    });
  }

  function overviewTab(req, cls) {
    const now = Date.now();
    const base = `/klassen/${cls.id}`;
    const change = access.canChangeClass(req.user, cls.id);
    const students = studentsOf(cls.id); // the matrix shows at most 300; the numbers count everybody
    const total = studentCount(cls.id);
    const apps = db.all(
      `SELECT a.*, ca.decided_at FROM class_apps ca JOIN apps a ON a.id = ca.app_id
        WHERE ca.class_id = ? AND ca.status = 'approved' ORDER BY ca.decided_at DESC LIMIT 200`,
      cls.id
    );
    const waiting = submissionsOf(cls.id).filter((w) => w.request_state === 'waiting');
    const wk = kit.weeks(8, now);
    const thisWeek = wk[wk.length - 1].start;
    const perWeek = db.get(
      `SELECT ${kit.weekSums('r.created_at', wk.length)} FROM results r
         JOIN class_members m ON m.user_id = r.user_id AND m.class_id = ? AND m.role = 'student'
         JOIN class_apps ca ON ca.app_id = r.app_id AND ca.class_id = m.class_id AND ca.version_id IS NOT NULL
        WHERE (r.class_id = m.class_id OR r.class_id = '') AND r.created_at >= ?`,
      ...kit.weekParams(wk), cls.id, wk[0].start
    );
    const bars = kit.weekBars(wk, perWeek);
    const active = db.get(
      `SELECT COUNT(DISTINCT p.user_id) AS n FROM plays p
         JOIN class_members m ON m.user_id = p.user_id AND m.class_id = ? AND m.role = 'student'
         JOIN class_apps ca ON ca.app_id = p.app_id AND ca.class_id = m.class_id AND ca.version_id IS NOT NULL
        WHERE p.last_at >= ?`,
      cls.id, thisWeek
    ).n;
    const running = db.all(
      `SELECT x.*, a.name AS app_name FROM assignments x JOIN apps a ON a.id = x.app_id
        WHERE x.class_id = ? AND x.starts_at <= ? AND (x.due_at IS NULL OR x.due_at >= ?)
        ORDER BY CASE WHEN x.due_at IS NULL THEN 1 ELSE 0 END, x.due_at, x.created_at DESC LIMIT 50`,
      cls.id, now, now
    );

    // The matrix: at most 12 apps (the ones added last), sorted by name.
    const shown = apps.slice(0, MATRIX_APPS).sort((a, b) => a.name.localeCompare(b.name, 'de'));
    const value = matrixData(cls);
    const matrix = !students.length
      ? empty({
          icon: 'userPlus',
          title: 'Noch niemand in der Klasse',
          text: change ? 'Zeig den QR-Code an der Tafel oder schick den Link – die Schüler/innen treten selbst bei. Dann siehst du hier, wie weit alle sind.' : 'In dieser Klasse sind keine Schüler/innen.',
          actions: change ? linkButton(`${base}/qr`, 'QR-Code zeigen', { icon: 'qr' }) : '',
        })
      : !shown.length
        ? empty({
            icon: 'apps',
            title: 'Keine Apps in der Klasse',
            text: change ? 'Füge eine App hinzu – dann siehst du hier für jede Person, wie weit sie ist.' : 'Diese Klasse hat keine freigegebenen Apps.',
            actions: change ? linkButton(`${base}/apps#hinzufuegen`, 'App hinzufügen', { icon: 'plus' }) : '',
          })
        : html`${dataTable({
            cls: 'teach-matrix',
            columns: [
              { label: 'Name', primary: true, render: (s) => s.name },
              ...shown.map((a) => ({ label: a.name, render: (s) => matrixCell(cls, s, a, value(a.id, s.id)) })),
            ],
            rows: students,
          })}
          <div class="teach-legend" aria-hidden="true"><span class="teach-legend-item"><span class="teach-swatch heat-none"></span>nicht begonnen</span>
            <span class="teach-legend-item"><span class="teach-swatch teach-started"></span>begonnen, ohne Prozentwert</span>
            <span class="teach-legend-item"><span class="teach-swatch heat-1"></span><span class="teach-swatch heat-3"></span><span class="teach-swatch heat-5"></span>weniger – mehr geschafft</span>
            <span class="teach-legend-item">Zahl = Fortschritt oder bestes Ergebnis in Prozent</span></div>
          ${apps.length > MATRIX_APPS ? html`<p class="meta mt-2">Es werden ${MATRIX_APPS} von ${apps.length} Apps gezeigt (die zuletzt hinzugefügten). Alle Ergebnisse findest du unter <a href="${base}/apps">Apps</a>.</p>` : ''}`;

    return teacherPage(req, cls, 'ueberblick', html`
      ${waiting.length && change ? html`<section class="section teach-first" aria-labelledby="s-wait">${sectionHead('Wartet auf deine Prüfung', { id: 's-wait', count: String(waiting.length) })}
        ${list(waiting.slice(0, 5).map((w) => submissionRow(cls, w)), 'attention')}
        ${waiting.length > 5 ? html`<p class="mt-2">${linkButton(`${base}/apps`, `Alle ${waiting.length} ansehen`, { kind: 'quiet', size: 'sm' })}</p>` : ''}</section>` : ''}
      <section class="section" aria-label="Zahlen dieser Woche">${stats([
        stat({ label: 'Schüler/innen', value: total, href: `${base}/mitglieder` }),
        stat({ label: 'Aktiv diese Woche', value: active, sub: total ? `von ${total} · seit Montag` : 'seit Montag' }),
        stat({ label: 'Ergebnisse diese Woche', value: bars[bars.length - 1].value, sub: `Vorwoche: ${bars[bars.length - 2].value}` }),
        stat({ label: 'Laufende Aufgaben', value: running.length, href: `${base}/aufgaben` }),
      ])}</section>
      <div class="grid-2 even section">
        <section aria-labelledby="s-week">${sectionHead('Ergebnisse pro Woche', { id: 's-week', sub: 'Alle Apps dieser Klasse in den letzten 8 Kalenderwochen.' })}
          <div class="panel">${kit.weekChart(bars, `Ergebnisse pro Woche in ${cls.name}`)}</div></section>
        <section aria-labelledby="s-run">${sectionHead('Laufende Aufgaben', { id: 's-run', actions: running.length ? linkButton(`${base}/aufgaben`, 'Alle', { kind: 'quiet', size: 'sm' }) : '' })}
          ${running.length
            ? list(running.slice(0, 3).map((x) => assignmentRow(x, now)))
            : change
              ? empty({ icon: 'tasks', title: 'Keine laufende Aufgabe', text: 'Stell der Klasse eine Aufgabe: eine App, bis wann – fertig. Wer fertig ist, erkennt der Hub an den Ergebnissen.', actions: linkButton(`${base}/aufgaben/neu`, 'Aufgabe stellen', { icon: 'plus', size: 'sm' }) })
              : html`<p class="muted">Keine laufende Aufgabe.</p>`}</section>
      </div>
      <section class="section" aria-labelledby="s-matrix">${sectionHead('Wer ist wie weit?', { id: 's-matrix', sub: 'Jedes Feld zeigt den Fortschritt oder das beste Ergebnis in dieser Klasse. Tippe auf ein Feld, um die Einzelheiten zu sehen.' })}
        ${matrix}</section>`);
  }

  // ---------------------------------------------------------------- Aufgaben

  function assignmentsTab(req, cls) {
    const now = Date.now();
    const base = `/klassen/${cls.id}`;
    const change = access.canChangeClass(req.user, cls.id);
    const all = req.query.alle === '1';
    const current = db.all(
      `SELECT x.*, a.name AS app_name FROM assignments x JOIN apps a ON a.id = x.app_id
        WHERE x.class_id = ? AND (x.due_at IS NULL OR x.due_at >= ?)
        ORDER BY CASE WHEN x.due_at IS NULL THEN 1 ELSE 0 END, x.due_at, x.created_at DESC LIMIT 100`,
      cls.id, now
    );
    const past = db.all(
      `SELECT x.*, a.name AS app_name FROM assignments x JOIN apps a ON a.id = x.app_id
        WHERE x.class_id = ? AND x.due_at < ? ORDER BY x.due_at DESC LIMIT ?`,
      cls.id, now, all ? 200 : 11
    );
    const running = current.filter((x) => x.starts_at <= now);
    const planned = current.filter((x) => x.starts_at > now);
    const pastShown = all ? past : past.slice(0, 10);

    return teacherPage(req, cls, 'aufgaben', html`
      <section class="section" aria-labelledby="s-run">${sectionHead('Laufende Aufgaben', {
        id: 's-run',
        count: running.length ? String(running.length) : null,
        sub: 'Ob jemand fertig ist, erkennt der Hub an Ergebnissen oder vollem Fortschritt nach dem Start – oder die Person markiert es selbst.',
      })}
        ${running.length
          ? list(running.map((x) => assignmentRow(x, now, { counts: true })))
          : change
            ? empty({ icon: 'tasks', title: 'Keine laufende Aufgabe', text: 'Eine Aufgabe sagt der Klasse, welche App sie bis wann bearbeiten soll. Die Schüler/innen sehen sie auf ihrer Startseite.', actions: linkButton(`${base}/aufgaben/neu`, 'Aufgabe stellen', { icon: 'plus' }) })
            : html`<p class="muted">Keine laufende Aufgabe.</p>`}</section>
      ${planned.length ? html`<section class="section" aria-labelledby="s-plan">${sectionHead('Geplant', { id: 's-plan', count: String(planned.length), sub: 'Diese Aufgaben sehen die Schüler/innen erst ab dem Start – dann stehen sie auf ihrer Startseite. Eine Mitteilung bekommen sie dafür nicht.' })}
        ${list(planned.map((x) => assignmentRow(x, now, { counts: true })))}</section>` : ''}
      ${past.length ? html`<details class="disclosure teach-past"${all ? raw(' open') : ''}><summary><span class="teach-sumtitle">Abgelaufen</span><span class="teach-count">${all ? past.length : past.length > 10 ? 'mehr als 10' : past.length}</span></summary>
        <div class="disclosure-body">${list(pastShown.map((x) => assignmentRow(x, now, { counts: true })))}
        ${!all && past.length > 10 ? html`<p class="mt-4">${linkButton(`${base}/aufgaben?alle=1`, 'Alle abgelaufenen zeigen', { kind: 'quiet', size: 'sm' })}</p>` : ''}</div></details>` : ''}`);
  }

  // -------------------------------------------------------------------- Apps

  function appsTab(req, cls) {
    const user = req.user;
    const base = `/klassen/${cls.id}`;
    const change = access.canChangeClass(user, cls.id);
    const subs = submissionsOf(cls.id);
    const rows = db.all(
      `SELECT a.*, ca.status, ca.version_id, ca.decided_at, u.name AS owner_name, v.number AS version_number, v.manifest AS manifest
         FROM class_apps ca JOIN apps a ON a.id = ca.app_id JOIN users u ON u.id = a.owner_id
         LEFT JOIN app_versions v ON v.id = ca.version_id
        WHERE ca.class_id = ? AND ca.version_id IS NOT NULL ORDER BY a.name COLLATE NOCASE LIMIT 200`,
      cls.id
    );
    const started = new Map(
      db.all(
        `SELECT ca.app_id, COUNT(DISTINCT m.user_id) AS n FROM class_apps ca
           JOIN class_members m ON m.class_id = ca.class_id AND m.role = 'student'
          WHERE ca.class_id = ? AND (EXISTS (SELECT 1 FROM plays p WHERE p.app_id = ca.app_id AND p.user_id = m.user_id)
                 OR EXISTS (SELECT 1 FROM results r WHERE r.app_id = ca.app_id AND r.user_id = m.user_id AND (r.class_id = ca.class_id OR r.class_id = '')))
          GROUP BY ca.app_id`,
        cls.id
      ).map((r) => [r.app_id, r.n])
    );
    const total = studentCount(cls.id);
    const approved = rows.filter((r) => r.status === 'approved');
    // Removed - also when a new submission of it waits or was given back: its results stay readable.
    const removed = rows.filter((r) => r.status !== 'approved');

    const approvedRow = (a) => {
      const hasSettings = manifestOf({ manifest: a.manifest }).settings.length > 0;
      return row({
        href: `${base}/apps/${a.id}/ergebnisse`,
        title: a.name,
        start: appIcon(a),
        sub: `von ${a.owner_name} · Version ${a.version_number || '–'} · ${started.get(a.id) || 0} von ${total} haben begonnen`,
        cls: `wrap ${appClass(a)}`,
        chevron: false,
        // Two groups so the actions wrap cleanly on phones; "Entfernen" sits apart, never next to "Ergebnisse".
        end: html`<div class="teach-actions"><span class="teach-group">${linkButton(`${base}/apps/${a.id}/ergebnisse`, 'Ergebnisse', { size: 'sm', icon: 'chart' })}
          ${change ? linkButton(`${base}/aufgaben/neu?app=${a.id}`, 'Aufgabe stellen', { kind: 'quiet', size: 'sm', icon: 'tasks' }) : ''}</span>
          <span class="teach-group">${change && hasSettings ? linkButton(`${base}/apps/${a.id}/einstellungen`, 'Einstellungen', { kind: 'quiet', size: 'sm', icon: 'sliders' }) : ''}
          ${linkButton(`/apps/${a.id}/spielen?klasse=${cls.id}`, `„${a.name}“ in der Klasse öffnen`, { kind: 'quiet', size: 'sm', icon: 'play', iconOnly: true })}
          ${change ? html`<span class="teach-push">${postButton(req, `${base}/apps/${a.id}/entfernen`, `„${a.name}“ aus der Klasse entfernen`, {
            kind: 'danger', size: 'sm', icon: 'trash', iconOnly: true,
            confirm: `„${a.name}“ aus der Klasse entfernen?\nDie Klasse kann die App dann nicht mehr öffnen. Die Ergebnisse bleiben für dich lesbar, und du kannst die App später zurückholen.`,
            confirmLabel: 'Entfernen',
          })}</span>` : ''}</span></div>`,
      });
    };

    // Apps this teacher may add right away: own, colleagues' shared, school-wide (access.addToClassMode decides).
    const addable = change
      ? db
          .all(
            `SELECT a.*, u.name AS owner_name FROM apps a JOIN users u ON u.id = a.owner_id
              WHERE a.published_version_id IS NOT NULL
                AND (a.owner_id = ? OR a.schoolwide_version_id IS NOT NULL OR (a.shared = 1 AND u.role IN ('teacher','admin')))
                AND NOT EXISTS (SELECT 1 FROM class_apps ca WHERE ca.class_id = ? AND ca.app_id = a.id)
              ORDER BY a.name COLLATE NOCASE LIMIT 150`,
            user.id, cls.id
          )
          .filter((a) => access.addToClassMode(user, a, cls.id) === 'approve')
      : [];
    const groups = [
      ['Meine Apps', addable.filter((a) => a.owner_id === user.id)],
      ['Für die ganze Schule freigegeben', addable.filter((a) => a.owner_id !== user.id && a.schoolwide_version_id)],
      ['Von Kolleg/innen geteilt', addable.filter((a) => a.owner_id !== user.id && !a.schoolwide_version_id)],
    ].filter(([, items]) => items.length);
    const addRow = (a) =>
      appRow(a, {
        sub: a.owner_id === user.id ? undefined : `von ${a.owner_name}`,
        end: postButton(req, `${base}/apps`, 'Hinzufügen', { size: 'sm', icon: 'plus', fields: { app: a.id } }),
      });

    return teacherPage(req, cls, 'apps', html`
      ${subs.length ? html`<section class="section teach-first" aria-labelledby="s-subs">${sectionHead('Eingereicht', {
        id: 's-subs',
        count: String(subs.length),
        sub: 'Apps von Schüler/innen brauchen deine Freigabe, bevor die Klasse sie benutzen kann. Prüfe die App in der Vorschau und im Quelltext.',
      })}
        ${list(subs.map((w) => submissionRow(cls, w)), subs.some((w) => w.request_state === 'waiting') ? 'attention' : '')}</section>` : ''}
      <section class="section" aria-labelledby="s-apps">${sectionHead('Apps der Klasse', { id: 's-apps', count: String(approved.length), actions: change && groups.length ? linkButton('#hinzufuegen', 'App hinzufügen', { size: 'sm', icon: 'plus' }) : '' })}
        ${approved.length
          ? list(approved.map(approvedRow))
          : empty({ icon: 'apps', title: 'Noch keine Apps', text: 'Füge eigene Apps, geteilte Apps von Kolleg/innen oder Apps für die ganze Schule hinzu. Apps von Schüler/innen kommen über eine Einreichung dazu.', actions: change && groups.length ? linkButton('#hinzufuegen', 'App hinzufügen', { icon: 'plus' }) : change ? linkButton('/katalog', 'Apps entdecken', { icon: 'apps' }) : '' })}</section>
      ${change ? html`<section class="section" aria-labelledby="hinzufuegen-h" id="hinzufuegen">${sectionHead('App hinzufügen', { id: 'hinzufuegen-h', sub: 'Diese Apps kannst du sofort für die Klasse freigeben.' })}
        ${groups.length
          ? groups.map(([title, items]) => html`<h3 class="teach-subhead">${title}</h3>${list(items.map(addRow))}`)
          : notice({ icon: 'apps', text: 'Alle Apps, die du sofort freigeben kannst, sind schon in der Klasse. Veröffentliche eine eigene App oder schau, was Kolleg/innen geteilt haben.', actions: html`${linkButton('/apps', 'Meine Apps', { size: 'sm', icon: 'bauen' })}${linkButton('/katalog', 'Apps entdecken', { kind: 'quiet', size: 'sm', icon: 'apps' })}` })}</section>` : ''}
      ${removed.length ? html`<details class="disclosure teach-removed"><summary><span class="teach-sumtitle">Entfernte Apps</span><span class="teach-count">${removed.length}</span></summary>
        <div class="disclosure-body"><p class="meta mb-4">Die Klasse kann diese Apps nicht mehr öffnen. Ihre Ergebnisse bleiben für dich lesbar.</p>
        ${list(removed.map((a) => appRow(a, {
          sub: `von ${a.owner_name} · Version ${a.version_number || '–'}${a.status === 'removed' ? '' : ' · neu eingereicht'}`,
          end: html`<div class="teach-actions">${linkButton(`${base}/apps/${a.id}/ergebnisse`, 'Ergebnisse', { size: 'sm', icon: 'chart' })}${change && a.status === 'removed' ? postButton(req, `${base}/apps/${a.id}/zurueckholen`, 'Zurückholen', { kind: 'quiet', size: 'sm', icon: 'undo' }) : ''}</div>`,
          cls: 'wrap',
        })))}</div></details>` : ''}`);
  }

  // -------------------------------------------------------------- Mitglieder

  function membersTab(req, cls) {
    const user = req.user;
    const base = `/klassen/${cls.id}`;
    const change = access.canChangeClass(user, cls.id);
    const students = db.all(
      `SELECT u.id, u.name, m.joined_at,
              (SELECT MAX(p.last_at) FROM plays p JOIN class_apps ca ON ca.app_id = p.app_id AND ca.class_id = m.class_id AND ca.version_id IS NOT NULL
                WHERE p.user_id = u.id) AS last_at
         FROM class_members m JOIN users u ON u.id = m.user_id
        WHERE m.class_id = ? AND m.role = 'student' ORDER BY u.name COLLATE NOCASE LIMIT 300`,
      cls.id
    );
    const teachers = teachersOf(cls.id);
    const total = studentCount(cls.id); // the table shows at most 300

    return teacherPage(req, cls, 'mitglieder', html`
      <section class="section" aria-labelledby="s-students">${sectionHead('Schüler/innen', {
        id: 's-students',
        count: String(total),
        sub: change ? 'Schüler/innen treten selbst per QR-Code oder Link bei – über „Beitreten lassen“ oben. Niemand wird von Hand hinzugefügt.' : 'Schüler/innen treten selbst per QR-Code oder Link bei. Niemand wird von Hand hinzugefügt.',
      })}
        ${dataTable({
          cls: 'teach-members',
          columns: [
            { label: 'Name', primary: true, render: (s) => html`<span class="teach-person">${avatar(s.name, 'sm')}<span>${s.name}</span></span>` },
            { label: 'Beigetreten', render: (s) => formatDay(s.joined_at) },
            { label: 'Zuletzt aktiv', render: (s) => (s.last_at ? formatAgo(s.last_at) : html`<span class="faint">noch nie</span>`) },
            ...(change
              ? [{
                  label: 'Aktionen',
                  actions: true,
                  render: (s) => postButton(req, `${base}/mitglieder/${s.id}/entfernen`, `${s.name} aus der Klasse entfernen`, {
                    kind: 'danger', size: 'sm', icon: 'trash', iconOnly: true,
                    confirm: `${s.name} aus der Klasse entfernen?\n${s.name} sieht die Klasse, ihre Apps und Aufgaben dann nicht mehr. Spielstände bleiben im Konto. Mit einem neuen QR-Code kann ${s.name} wieder beitreten.`,
                    confirmLabel: 'Entfernen',
                  }),
                }]
              : []),
          ],
          rows: students,
          empty: empty({ icon: 'userPlus', title: 'Noch niemand in der Klasse', text: 'Zeig den QR-Code an der Tafel oder teile den Link. Wer beitritt, erscheint hier.', actions: change ? linkButton(`${base}/qr`, 'QR-Code zeigen', { icon: 'qr' }) : '' }),
        })}
        ${total > students.length ? html`<p class="meta mt-2">Es werden die ersten ${students.length} von ${total} Schüler/innen gezeigt.</p>` : ''}</section>
      <div class="grid-2 even section">
        <section aria-labelledby="s-teachers">${sectionHead('Lehrkräfte', { id: 's-teachers', count: String(teachers.length) })}
          ${list(teachers.map((t) => row({ title: t.name, start: avatar(t.name), sub: `dabei seit ${formatDay(t.joined_at)}`, end: t.id === user.id ? badge('du') : '' })))}</section>
        ${change ? html`<section aria-labelledby="s-invite">${sectionHead('Lehrkraft einladen', { id: 's-invite', sub: 'Eine Kollegin oder ein Kollege führt die Klasse mit dir. Der Link funktioniert nur für Lehrkräfte.' })}
          ${invitePanel(req, cls)}</section>` : ''}
      </div>`);
  }

  function invitePanel(req, cls) {
    const invite = activeCode(cls.id, 'teacher');
    const base = `/klassen/${cls.id}`;
    const durationForm = (label) => html`<form method="post" action="${base}/einladung" class="teach-inline-form">${csrfField(req)}
      <div class="field teach-grow"><label for="f-einladung">Gültig für</label><select id="f-einladung" name="minuten">${Object.entries(kit.DURATIONS).map(([m, l]) => html`<option value="${m}"${m === '1440' ? raw(' selected') : ''}>${l}</option>`)}</select></div>
      <button class="btn">${icon('link')}<span>${label}</span></button></form>`;
    if (!invite) return html`<div class="panel">${durationForm('Einladungslink erzeugen')}</div>`;
    const url = joinUrl(invite.code);
    return html`<div class="panel stack">
      <div class="field"><label for="f-invite-link">Einladungslink für Lehrkräfte</label>
        <div class="teach-copy"><input id="f-invite-link" class="copy" readonly value="${url}"><button class="btn" type="button" data-copy="${url}">${icon('copy')}<span>Kopieren</span></button></div>
        <span class="hint">Gültig bis ${formatDate(invite.expires_at)}. Wer als Lehrkraft beitritt, sieht alle Schüler/innen und Ergebnisse dieser Klasse.</span></div>
      <details class="disclosure teach-qrfold"><summary>Als QR-Code zeigen</summary><div class="disclosure-body"><div class="qr-small">${qrSvg(url, 'QR-Code der Einladung für Lehrkräfte')}</div></div></details>
      <div class="actions">${postButton(req, `${base}/einladung/loeschen`, 'Einladung löschen', { kind: 'danger', size: 'sm', confirm: 'Einladung löschen?\nDer Einladungslink funktioniert dann nicht mehr. Wer schon beigetreten ist, bleibt Lehrkraft der Klasse.', confirmLabel: 'Löschen' })}</div>
      ${durationForm('Neuen Link erzeugen')}</div>`;
  }

  // ----------------------------------------------------------- Einstellungen

  function joinPanel(req, cls) {
    const code = activeCode(cls.id);
    const base = `/klassen/${cls.id}`;
    const newCode = html`<form method="post" action="${base}/code" class="teach-inline-form">${csrfField(req)}
      <div class="field teach-grow"><label for="f-minuten">${code ? 'Neuer Code, gültig für' : 'Code gültig für'}</label><select id="f-minuten" name="minuten">${Object.entries(kit.DURATIONS).map(([m, l]) => html`<option value="${m}"${m === '1440' ? raw(' selected') : ''}>${l}</option>`)}</select></div>
      <button class="btn">${icon('refresh')}<span>Erzeugen</span></button></form>`;
    if (!code) {
      return html`<div class="panel stack">${notice({ icon: 'lock', text: 'Zurzeit kann niemand beitreten. Erzeuge einen Code, wenn neue Schüler/innen dazukommen sollen.' })}${newCode}</div>`;
    }
    const url = joinUrl(code.code);
    return html`<div class="panel teach-join">
      <a class="qr-small teach-join-qr" href="${base}/qr" aria-label="QR-Code groß anzeigen">${qrSvg(url)}</a>
      <div class="teach-join-info"><strong>Gültig bis ${formatDate(code.expires_at)}</strong>
        <span class="meta">Schüler/innen scannen den Code oder öffnen den Link und melden sich mit ihrem Schulkonto an.</span>
        <div class="actions">${linkButton(`${base}/qr`, 'Groß anzeigen', { size: 'sm', icon: 'maximize' })}
          ${postButton(req, `${base}/code/loeschen`, 'Code löschen', { kind: 'danger', size: 'sm', confirm: 'Beitrittscode löschen?\nDer QR-Code und der Link funktionieren dann nicht mehr. Wer schon beigetreten ist, bleibt in der Klasse.', confirmLabel: 'Löschen' })}</div></div>
      <div class="field teach-join-wide"><label for="f-join-link">Link zum Beitreten</label>
        <div class="teach-copy"><input id="f-join-link" class="copy" readonly value="${url}"><button class="btn" type="button" data-copy="${url}">${icon('copy')}<span>Kopieren</span></button></div></div>
      <div class="teach-join-new">${newCode}<p class="meta">Ein neuer Code macht den alten ungültig. Wer per Code beitritt, wird immer Schüler/in – nie mehr.</p></div>
    </div>`;
  }

  function settingsTab(req, cls) {
    const user = req.user;
    const base = `/klassen/${cls.id}`;
    const change = access.canChangeClass(user, cls.id);
    const archived = Boolean(cls.archived_at);
    const role = access.classRole(user, cls.id);
    const days = ctx.settings.get('retention.archivedClassDays');

    const classForm = change
      ? html`<form method="post" action="${base}/bearbeiten" class="form panel">${csrfField(req)}
          ${field(req, { label: 'Name der Klasse', name: 'name', value: cls.name, required: true, attrs: 'minlength="2" maxlength="60" autocomplete="off"' })}
          <div class="form-row">
            ${field(req, { label: 'Fach', name: 'fach', control: subjectSelect(req, cls.subject) })}
            ${field(req, { label: 'Klassenstufe', name: 'stufe', control: gradeSelect(req, cls.grade === null ? '' : String(cls.grade)) })}
          </div>
          <div class="actions"><button class="btn">${icon('save')}<span>Speichern</span></button></div></form>`
      : html`<dl class="kv panel"><div><dt>Name</dt><dd>${cls.name}</dd></div><div><dt>Fach</dt><dd>${cls.subject || '–'}</dd></div><div><dt>Klassenstufe</dt><dd>${cls.grade || '–'}</dd></div></dl>`;

    const leave = role
      ? access.canLeaveClass(user, cls.id)
        ? html`<section class="section" aria-labelledby="s-leave">${sectionHead('Klasse verlassen', { id: 's-leave', sub: 'Die Klasse bleibt für die anderen Lehrkräfte bestehen. Du siehst sie danach nicht mehr.' })}
            ${postButton(req, `${base}/verlassen`, 'Klasse verlassen', { kind: 'danger', icon: 'logout', confirm: `„${cls.name}“ verlassen?\nDu unterrichtest die Klasse dann nicht mehr und siehst ihre Schüler/innen und Ergebnisse nicht mehr. Zurück kommst du nur mit einer neuen Einladung.`, confirmLabel: 'Verlassen' })}</section>`
        : role === 'teacher' && !archived
          ? html`<section class="section" aria-labelledby="s-leave">${sectionHead('Klasse verlassen', { id: 's-leave' })}
              <p class="muted">Du bist die einzige Lehrkraft dieser Klasse und kannst sie deshalb nicht verlassen. Lade eine Kollegin oder einen Kollegen ein (unter <a href="${base}/mitglieder">Mitglieder</a>) – oder archiviere oder lösche die Klasse.</p></section>`
          : ''
      : '';

    return teacherPage(req, cls, 'einstellungen', html`
      <div class="grid-2 even section">
        <section aria-labelledby="s-class">${sectionHead('Klasse', { id: 's-class' })}${classForm}</section>
        ${change ? html`<section aria-labelledby="s-join">${sectionHead('Beitreten per QR-Code oder Link', { id: 's-join' })}${joinPanel(req, cls)}</section>` : ''}
      </div>
      <section class="section" aria-labelledby="s-archive">${sectionHead('Archiv', { id: 's-archive', sub: archived ? '' : `Am Schuljahresende: Die Klasse wird schreibgeschützt und für Schüler/innen unsichtbar. Nach ${days} Tagen wird sie gelöscht – bis dahin kannst du sie zurückholen.` })}
        ${archived
          ? html`<div class="panel stack"><p>Archiviert am ${formatDay(cls.archived_at)}. Wird am ${kit.deletionDay(ctx, cls)} gelöscht.</p>
              <div class="actions">${postButton(req, `${base}/wiederherstellen`, 'Aus dem Archiv holen', { icon: 'undo' })}</div></div>`
          : postButton(req, `${base}/archivieren`, 'Klasse archivieren', { icon: 'archive', confirm: `„${cls.name}“ archivieren?\nSchüler/innen sehen die Klasse dann nicht mehr, und niemand kann etwas ändern. Nach ${days} Tagen wird sie mit allen Aufgaben und Rückmeldungen gelöscht. Bis dahin kannst du sie zurückholen.`, confirmLabel: 'Archivieren' })}</section>
      ${leave}
      <section class="danger-zone" aria-labelledby="s-delete"><h2 id="s-delete">Klasse löschen</h2>
        <p class="mt-2 mb-4">Löscht die Klasse mit allen Aufgaben, Rückmeldungen, Einstellungen und Klassendaten. Die Spielstände der Schüler/innen bleiben in ihren Konten.</p>
        ${postButton(req, `${base}/loeschen`, 'Klasse löschen', { kind: 'danger', icon: 'trash', confirm: `„${cls.name}“ endgültig löschen?\nAlle Aufgaben, Rückmeldungen, Einstellungen und Klassendaten werden gelöscht. Das kann nicht rückgängig gemacht werden.`, confirmLabel: 'Endgültig löschen' })}</section>`);
  }

  // ============================================================ student view

  function studentPage(req, cls) {
    const user = req.user;
    const now = Date.now();
    const teachers = teachersOf(cls.id);
    const tasks = assignments.openFor(user.id, { limit: 200 }).filter((t) => t.class_id === cls.id);
    const apps = db.all(
      `SELECT a.*, u.role AS owner_role, p.value AS progress, p.label AS progress_label
         FROM class_apps ca JOIN apps a ON a.id = ca.app_id JOIN users u ON u.id = a.owner_id
         LEFT JOIN progress p ON p.app_id = a.id AND p.user_id = ?
        WHERE ca.class_id = ? AND ca.status = 'approved' AND ca.version_id IS NOT NULL
        ORDER BY a.name COLLATE NOCASE LIMIT 200`,
      user.id, cls.id
    );
    const classApps = apps.filter((a) => a.owner_role !== 'student');
    const built = apps.filter((a) => a.owner_role === 'student');
    const mine = db.all(
      `SELECT a.*, ca.status, ca.request_state FROM class_apps ca JOIN apps a ON a.id = ca.app_id
        WHERE ca.class_id = ? AND a.owner_id = ? AND (ca.status <> 'approved' OR ca.request_state IS NOT NULL) AND ca.status <> 'removed'
        ORDER BY a.name COLLATE NOCASE`,
      cls.id, user.id
    );
    const submittable = db
      .all('SELECT * FROM apps WHERE owner_id = ? AND published_version_id IS NOT NULL AND id NOT IN (SELECT app_id FROM class_apps WHERE class_id = ?) ORDER BY name COLLATE NOCASE', user.id, cls.id)
      .filter((a) => access.addToClassMode(user, a, cls.id) === 'submit');
    const feedback = db.all(
      `SELECT f.*, u.name AS author_name, a.name AS app_name, x.title AS assignment_title FROM feedback f
         LEFT JOIN users u ON u.id = f.author_id LEFT JOIN apps a ON a.id = f.app_id LEFT JOIN assignments x ON x.id = f.assignment_id
        WHERE f.student_id = ? AND f.class_id = ? ORDER BY f.created_at DESC LIMIT 5`,
      user.id, cls.id
    );
    const play = (a) => `/apps/${a.id}/spielen?klasse=${cls.id}`;
    const progressEnd = (a) =>
      a.progress === null || a.progress === undefined
        ? ''
        : html`<span class="teach-progrow">${meter(a.progress, { tone: 'app', label: `${Math.round(clamp01(a.progress) * 100)} % geschafft` })}<span class="num meta">${Math.round(clamp01(a.progress) * 100)} %</span></span>`;

    const left = html`
      <section class="section" aria-labelledby="s-tasks">${sectionHead('Aufgaben', { id: 's-tasks', count: tasks.length ? String(tasks.length) : null })}
        ${tasks.length
          ? list(tasks.map((t) => {
              const due = formatDue(t.due_at, now);
              return row({ href: `/aufgaben/${t.id}`, title: t.title, start: dueChip(t.due_at, due.tone), sub: html`${t.app_name} · ${due.text}`, end: t.started ? badge('begonnen') : '' });
            }))
          : empty({ icon: 'checkCircle', title: 'Keine offenen Aufgaben', text: 'Wenn deine Lehrkraft in dieser Klasse eine Aufgabe stellt, steht sie hier – mit Termin.' })}</section>
      <section class="section" aria-labelledby="s-apps">${sectionHead('Apps der Klasse', { id: 's-apps', count: classApps.length ? String(classApps.length) : null })}
        ${classApps.length
          ? list(classApps.map((a) => appRow(a, { href: play(a), sub: a.progress_label || undefined, end: progressEnd(a), cls: appClass(a) })))
          : empty({ icon: 'apps', title: 'Noch keine Apps', text: 'Sobald deine Lehrkraft Apps für die Klasse freigibt, findest du sie hier.' })}</section>
      ${built.length ? html`<section class="section" aria-labelledby="s-built">${sectionHead('Von deiner Klasse gebaut', { id: 's-built', sub: 'Apps, die Schüler/innen dieser Klasse gebaut haben.' })}
        ${shelf(built.map((a) => shelfItem(a, play(a), a.owner_id === user.id ? 'Deine App' : '')), 'Von deiner Klasse gebaut')}</section>` : ''}`;

    const right = html`
      <section class="section" aria-labelledby="s-fb">${sectionHead('Rückmeldungen', { id: 's-fb', actions: feedback.length ? linkButton('/rueckmeldungen', 'Alle', { kind: 'quiet', size: 'sm' }) : '' })}
        ${feedback.length
          ? kit.feedbackTimeline(req, ctx, feedback, { back: `/klassen/${cls.id}`, showClass: false })
          : empty({ icon: 'message', title: 'Noch keine Rückmeldung', text: 'Wenn deine Lehrkraft dir etwas zu deiner Arbeit schreibt, steht es hier. Nur du und die Lehrkräfte der Klasse sehen es.' })}</section>
      ${mine.length || submittable.length ? html`<section class="section" aria-labelledby="s-mine">${sectionHead('Deine Apps in dieser Klasse', { id: 's-mine' })}
        ${mine.length ? list(mine.map((a) => appRow(a, {
          href: `/apps/${a.id}`,
          sub: a.request_state === 'returned' || a.status === 'rejected' ? 'Schau nach, was noch fehlt.' : a.request_state === 'waiting' ? 'Deine Lehrkraft schaut sie sich an.' : 'In der Klasse freigegeben.',
          end: a.request_state === 'returned' || a.status === 'rejected' ? badge('zurückgegeben', 'danger') : a.request_state === 'waiting' ? badge('wartet', 'wait') : badge('freigegeben', 'ok'),
        }))) : ''}
        ${submittable.length ? html`<form method="post" action="/klassen/${cls.id}/apps" class="teach-inline-form mt-4">${csrfField(req)}
          <div class="field teach-grow"><label for="f-app">Eigene App einreichen</label><select id="f-app" name="app">${submittable.map((a) => html`<option value="${a.id}">${a.name}</option>`)}</select></div>
          <button class="btn">${icon('send')}<span>Einreichen</span></button></form>
          <p class="meta mt-2">Deine Lehrkraft sieht sich die App an und gibt sie dann für die Klasse frei.</p>` : ''}</section>` : ''}
      ${access.canLeaveClass(user, cls.id) ? html`<section class="section quiet-zone teach-leave" aria-labelledby="s-leave"><h2 id="s-leave">Klasse verlassen</h2>
        <p class="meta mt-2 mb-4">Du siehst die Klasse, ihre Apps und Aufgaben danach nicht mehr. Deine Spielstände bleiben in deinem Konto.</p>
        ${postButton(req, `/klassen/${cls.id}/verlassen`, 'Klasse verlassen', { kind: 'danger', size: 'sm', icon: 'logout', confirm: `„${cls.name}“ verlassen?\nDu siehst die Klasse, ihre Apps und Aufgaben dann nicht mehr. Zurück kommst du nur mit einem neuen QR-Code oder Link deiner Lehrkraft.`, confirmLabel: 'Verlassen' })}</section>` : ''}`;

    const body = html`${pageHead({
      crumbs: [['/klassen', 'Klassen']],
      eyebrow: kit.classEyebrow(cls) || 'Klasse',
      title: cls.name,
      meta: html`<span>${icon('user', { cls: 'sm' })}${teachers.map((t) => t.name).join(', ') || 'keine Lehrkraft'}</span><span>${kit.studentsText(studentCount(cls.id))}</span>`,
    })}
      <div class="grid-2"><div>${left}</div><div>${right}</div></div>`;
    return page(req, { title: cls.name, body, active: 'klassen', classId: cls.id, styles: STYLES });
  }

  // ================================================================== routes

  app.get('/klassen/:id', (req, res) => {
    const cls = viewClass(req);
    res.send(access.canManageClass(req.user, cls.id) ? overviewTab(req, cls) : studentPage(req, cls));
  });
  app.get('/klassen/:id/aufgaben', (req, res) => res.send(assignmentsTab(req, manageClass(req))));
  app.get('/klassen/:id/apps', (req, res) => res.send(appsTab(req, manageClass(req))));
  app.get('/klassen/:id/mitglieder', (req, res) => res.send(membersTab(req, manageClass(req))));
  app.get('/klassen/:id/einstellungen', (req, res) => res.send(settingsTab(req, manageClass(req))));

  // ------------------------------------------------------- projector (QR)

  /** How many students joined - a number, never names. */
  const joinedText = (n) => (n ? `${kit.studentsText(n)} ${n === 1 ? 'ist' : 'sind'} schon dabei` : 'Noch niemand beigetreten');

  /** The "no valid code" view of the projector: a sentence and, for teachers of an active class, a new code. */
  const noCodeView = (req, cls, change, text, { id = '', hidden = false } = {}) =>
    html`<div class="teach-qrempty"${id ? html` id="${id}"` : ''}${hidden ? raw(' hidden') : ''}><p class="lead teach-qrlead"${id ? html` id="${id}-text"` : ''}>${text}</p>
      ${change ? html`<form method="post" action="/klassen/${cls.id}/code" class="teach-inline-form teach-qrform">${csrfField(req)}<input type="hidden" name="zurueck" value="qr">
        <div class="field teach-grow"><label for="f-minuten">Gültig für</label><select id="f-minuten" name="minuten">${Object.entries(kit.DURATIONS).map(([m, l]) => html`<option value="${m}"${m === '60' ? raw(' selected') : ''}>${l}</option>`)}</select></div>
        <button class="btn primary">${icon('qr')}<span>Code erzeugen</span></button></form>` : ''}</div>`;

  app.get('/klassen/:id/qr', (req, res) => {
    const cls = manageClass(req);
    const code = cls.archived_at ? null : activeCode(cls.id);
    const change = access.canChangeClass(req.user, cls.id);
    // The projector has no page frame, so the flash message is shown here.
    const msg = req.session.flash;
    const url = code ? joinUrl(code.code) : '';
    const body = html`<header class="teach-qrbar">
        <a class="btn quiet icon sm" href="/klassen/${cls.id}" aria-label="Zurück zur Klasse" title="Zurück zur Klasse">${icon('arrowLeft')}</a>
        <span class="teach-qrbar-title">${cls.name}<small>Beitreten</small></span>
        <button class="btn quiet icon sm" type="button" id="teach-fullscreen" aria-label="Vollbild" title="Vollbild">${icon('maximize')}</button>
      </header>
      <main class="teach-qrstage" id="main" tabindex="-1">
        ${msg ? notice({ tone: msg.type === 'error' ? 'danger' : 'ok', text: msg.text, role: msg.type === 'error' ? 'alert' : 'status', cls: 'teach-qrflash' }) : ''}
        <section class="projector teach-projector${code ? ' teach-projector-qr' : ''}" id="teach-projector">
          <h1 class="teach-qrtitle">${cls.name}</h1>
          ${code
            ? html`<div class="qr teach-qrcode" id="teach-qr-code">${qrSvg(url)}</div>
              <div class="teach-qrtext" id="teach-qr-live">
                <p class="lead teach-qrlead">Scanne den Code mit der Handykamera und melde dich mit deinem Schulkonto an.</p>
                <p class="teach-qrlink">${url}</p>
                <p class="teach-qrvalid" id="teach-valid">Gültig bis ${formatDate(code.expires_at)}</p>
                <p class="teach-qrcount" id="teach-joined" data-status="/klassen/${cls.id}/qr/status?seit=${code.created_at}" aria-live="polite">${joinedText(studentCount(cls.id))}</p>
              </div>
              ${noCodeView(req, cls, change, 'Es gibt gerade keinen gültigen Beitrittscode.', { id: 'teach-qr-dead', hidden: true })}`
            : noCodeView(req, cls, change, cls.archived_at ? 'Diese Klasse ist archiviert. Niemand kann beitreten.' : 'Es gibt gerade keinen gültigen Beitrittscode.')}
        </section>
      </main>`;
    res.send(page(req, { title: `Beitreten: ${cls.name}`, body, shell: 'player', styles: STYLES, scripts: ['teaching.js'] }));
  });

  const QR_STATE = {
    expired: 'Der Code ist abgelaufen. Niemand kann mehr damit beitreten.',
    deleted: 'Der Code wurde gelöscht. Niemand kann mehr damit beitreten.',
    replaced: 'Es gibt einen neuen Code.',
    archived: 'Diese Klasse ist archiviert. Niemand kann beitreten.',
  };
  /**
   * Live status for the projector: teachers only, a number - never names - and
   * what became of the code the page shows (`seit` = its creation time):
   * valid, expired, deleted, replaced by a newer one, or the class was archived.
   */
  app.get('/klassen/:id/qr/status', (req, res) => {
    const cls = manageClass(req);
    const code = cls.archived_at ? null : activeCode(cls.id);
    const shown = /^\d{1,16}$/.test(String(req.query.seit || '')) ? Number(req.query.seit) : null;
    let state = 'valid';
    if (cls.archived_at) state = 'archived';
    else if (!code) state = shown !== null && db.get("SELECT 1 AS ok FROM join_codes WHERE class_id = ? AND role = 'student' AND created_at = ?", cls.id, shown) ? 'expired' : 'deleted';
    else if (shown !== null && code.created_at !== shown) state = 'replaced';
    const n = studentCount(cls.id);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ joined: n, text: joinedText(n), state, stateText: state === 'valid' ? `Gültig bis ${formatDate(code.expires_at)}` : QR_STATE[state] });
  });

  // ---------------------------------------------------------- join codes

  app.post('/klassen/:id/code', (req, res) => {
    const cls = changeClass(req);
    const minutes = Object.hasOwn(kit.DURATIONS, String(req.body.minuten)) ? Number(req.body.minuten) : 1440;
    services.createJoinCode(req.user, cls.id, minutes);
    services.audit(req.user, 'beitrittscode_erzeugt', cls.name, kit.DURATIONS[minutes]);
    flash(req, `Neuer Beitrittscode, gültig für ${kit.DURATIONS[minutes]}. Der alte Code funktioniert nicht mehr.`);
    res.redirect(303, req.body.zurueck === 'qr' ? `/klassen/${cls.id}/qr` : `/klassen/${cls.id}/einstellungen`);
  });

  app.post('/klassen/:id/code/loeschen', (req, res) => {
    const cls = changeClass(req);
    const done = db.run("DELETE FROM join_codes WHERE class_id = ? AND role = 'student'", cls.id);
    if (done.changes) {
      services.audit(req.user, 'beitrittscode_geloescht', cls.name);
      flash(req, 'Der Beitrittscode ist gelöscht. Niemand kann mehr per QR-Code oder Link beitreten.');
    } else flash(req, 'Es gab keinen Beitrittscode, der gelöscht werden konnte.');
    res.redirect(303, `/klassen/${cls.id}/einstellungen`);
  });

  // ------------------------------------------------------ class settings

  /** Rename only (kept for older forms). */
  app.post('/klassen/:id/umbenennen', (req, res) => {
    const cls = changeClass(req);
    const name = cleanText(req.body.name, 60);
    if (name.length < 2) throw bad('Bitte gib der Klasse einen Namen.');
    db.run('UPDATE classes SET name = ? WHERE id = ?', name, cls.id);
    if (name !== cls.name) services.audit(req.user, 'klasse_umbenannt', name, `vorher: ${cls.name}`);
    flash(req, 'Der Name ist gespeichert.');
    res.redirect(303, `/klassen/${cls.id}/einstellungen`);
  });

  app.post('/klassen/:id/bearbeiten', (req, res) => {
    const cls = changeClass(req);
    const name = cleanText(req.body.name, 60);
    if (name.length < 2) throw bad('Bitte gib der Klasse einen Namen.');
    const { subject, grade } = subjectGrade(req.body);
    db.run('UPDATE classes SET name = ?, subject = ?, grade = ? WHERE id = ?', name, subject, grade, cls.id);
    if (name !== cls.name) services.audit(req.user, 'klasse_umbenannt', name, `vorher: ${cls.name}`);
    flash(req, 'Die Klasse ist gespeichert.');
    res.redirect(303, `/klassen/${cls.id}/einstellungen`);
  });

  app.post('/klassen/:id/loeschen', (req, res) => {
    const cls = manageClass(req);
    services.deleteClass(req.user, cls);
    flash(req, `Die Klasse „${cls.name}“ wurde gelöscht.`);
    res.redirect(303, '/klassen');
  });

  // ------------------------------------------------------------- members

  app.post('/klassen/:id/mitglieder/:uid/entfernen', (req, res) => {
    const cls = changeClass(req);
    const student = db.get("SELECT u.id, u.name FROM class_members m JOIN users u ON u.id = m.user_id WHERE m.class_id = ? AND m.user_id = ? AND m.role = 'student'", cls.id, String(req.params.uid));
    // Only students can be removed here; teachers are never touched by this route.
    if (!student) throw deny();
    db.tx(() => {
      db.run("DELETE FROM class_members WHERE class_id = ? AND user_id = ? AND role = 'student'", cls.id, student.id);
      // Back only with a code made after this moment - the code on the board stays closed to them.
      db.run('INSERT INTO class_removals (class_id, user_id, removed_at) VALUES (?, ?, ?) ON CONFLICT (class_id, user_id) DO UPDATE SET removed_at = excluded.removed_at', cls.id, student.id, Date.now());
      services.audit(req.user, 'mitglied_entfernt', cls.name);
    });
    flash(req, `${student.name} ist nicht mehr in „${cls.name}“.`);
    res.redirect(303, `/klassen/${cls.id}/mitglieder`);
  });

  /** Leave a class: students always; teachers only while another teacher remains (access.canLeaveClass). */
  app.post('/klassen/:id/verlassen', (req, res) => {
    const cls = viewClass(req);
    const role = access.classRole(req.user, cls.id);
    if (!role) throw deny();
    if (!access.canLeaveClass(req.user, cls.id)) {
      throw bad(cls.archived_at
        ? 'Diese Klasse ist archiviert. Hole sie zuerst aus dem Archiv.'
        : 'Du bist die einzige Lehrkraft dieser Klasse. Lade zuerst eine Kollegin oder einen Kollegen ein – oder archiviere oder lösche die Klasse.');
    }
    db.run('DELETE FROM class_members WHERE class_id = ? AND user_id = ? AND role = ?', cls.id, req.user.id, role);
    services.audit(req.user, 'klasse_verlassen', cls.name, role === 'teacher' ? 'Lehrkraft' : 'Schüler/in');
    flash(req, role === 'teacher' ? `Du unterrichtest „${cls.name}“ nicht mehr. Die Klasse bleibt für die anderen Lehrkräfte bestehen.` : `Du hast „${cls.name}“ verlassen.`);
    res.redirect(303, '/klassen');
  });

  // ------------------------------------------------------------- joining
  // The code is the only thing that matters here. A class code can only ever
  // create a 'student' membership; a teacher invitation only works for staff
  // accounts (access.joinRoleFor). Nothing in the request can change that.
  // A wrong code counts once per person and code within the limit's window: a stale join page whose
  // "Ja, beitreten" fails is shown again by the form-error redirect, and that must not count twice -
  // four clicks would otherwise close the teacher's new, valid code for this student for ten minutes.
  const counted = new Map(); // `${person}:${code}` -> until
  function countWrongCode(key, sent) {
    const id = `${key}:${sent.slice(0, 64)}`;
    const now = Date.now();
    if ((counted.get(id) || 0) > now) return;
    if (counted.size > 10_000) for (const [k, until] of counted) if (until <= now) counted.delete(k);
    counted.set(id, now + config.rate.joinFail[1]);
    limiter.hit('joinFail', key);
  }

  /** An expired (still stored) code of a class the person is in and may see: their way back to it. */
  function ownClassOfStaleCode(req) {
    const sent = String(req.params.code || '');
    const row = /^[A-Za-z0-9_-]{32}$/.test(sent) ? db.get('SELECT class_id, code FROM join_codes WHERE code = ? AND expires_at <= ?', sent, Date.now()) : null;
    return row && safeEqual(row.code, sent) && access.classRole(req.user, row.class_id) && access.canViewClass(req.user, row.class_id) ? row.class_id : null;
  }

  function findCode(req) {
    const key = req.user.id;
    // Wrong codes are limited per person only. Codes are 192-bit, so guessing is hopeless anyway, and a
    // per-address limit would let a group at the school's shared address close joining for everybody.
    if (limiter.blocked('joinFail', key)) {
      throw new HttpError(429, 'Zu viele Versuche mit ungültigen Codes. Bitte warte ein paar Minuten.');
    }
    const sent = String(req.params.code || '');
    const found = /^[A-Za-z0-9_-]{32}$/.test(sent) ? db.get('SELECT * FROM join_codes WHERE code = ? AND expires_at > ?', sent, Date.now()) : null;
    // A code of an archived class is refused exactly like a wrong one: whoever holds
    // an old code learns nothing about the class (no name, no teachers).
    if (!found || !safeEqual(found.code, sent) || access.isArchived(found.class_id)) {
      countWrongCode(key, sent);
      throw bad('Dieser Beitrittscode ist ungültig oder abgelaufen. Bitte frag deine Lehrkraft nach einem neuen Code.');
    }
    return { row: found, cls: getClass(found.class_id) };
  }

  /** A teacher invitation for a staff member who once joined this class with its code: it makes them its teacher. */
  const upgrades = (current, role) => current === 'student' && role === 'teacher';

  app.get('/beitreten/:code', (req, res) => {
    // An old link to one's own class (from the class chat) leads to the class - no failed attempt.
    const own = ownClassOfStaleCode(req);
    if (own) {
      delete req.session.returnTo;
      return res.redirect(`/klassen/${own}`);
    }
    const { row: code, cls } = findCode(req);
    delete req.session.returnTo;
    const role = access.joinRoleFor(req.user, code);
    const current = access.classRole(req.user, cls.id);
    if (current && !upgrades(current, role)) return res.redirect(`/klassen/${cls.id}`);
    const invite = code.role === 'teacher';
    if (!role) {
      // Someone this code is not for (a teacher invitation, a student account): no class, no names.
      const refusal = html`${pageHead({ eyebrow: invite ? 'Einladung für Lehrkräfte' : 'Klasse beitreten', title: 'Beitreten nicht möglich' })}
        <div class="panel stack teach-joinpage">${notice({ tone: 'wait', text: invite ? 'Dieser Link ist eine Einladung für Lehrkräfte. Mit einem Schulkonto für Schüler/innen kannst du damit nicht beitreten.' : 'Mit diesem Link kannst du gerade nicht beitreten. Bitte frag deine Lehrkraft nach einem neuen Code.' })}
          <div class="actions">${linkButton('/start', 'Zur Startseite', { icon: 'start' })}</div></div>`;
      return res.send(page(req, { title: 'Klasse beitreten', body: refusal, width: 'narrow', styles: STYLES }));
    }
    const teachers = teachersOf(cls.id);
    const body = html`${pageHead({
      eyebrow: invite ? 'Einladung für Lehrkräfte' : 'Klasse beitreten',
      title: cls.name,
      lead: invite ? 'Du wurdest eingeladen, diese Klasse mitzuführen.' : 'Möchtest du dieser Klasse beitreten?',
    })}
      <div class="panel stack teach-joinpage">
        <dl class="kv">
          <div><dt>${invite ? 'Bisher unterrichtet von' : 'Lehrkraft'}</dt><dd>${teachers.map((t) => t.name).join(', ') || '–'}</dd></div>
          ${kit.classEyebrow(cls) ? html`<div><dt>Fach</dt><dd>${kit.classEyebrow(cls)}</dd></div>` : ''}
        </dl>
        ${role === 'teacher'
          ? html`<p class="muted">Als Lehrkraft siehst du dann die Schüler/innen dieser Klasse und ihre Ergebnisse und kannst die Klasse mitverwalten.</p>`
          : html`<div class="prose muted">${teachersSee('Die Lehrkräfte dieser Klasse sehen in den Apps, die hier freigegeben sind:')}
              <p>Deine E-Mail-Adresse sehen sie nie. Du kannst die Klasse jederzeit wieder verlassen.</p></div>`}
        <form method="post" action="/beitreten/${req.params.code}" class="actions stack-phone">${csrfField(req)}
          <button class="btn primary lg">${icon(role === 'teacher' ? 'userPlus' : 'check')}<span>${role === 'teacher' ? 'Als Lehrkraft beitreten' : 'Ja, beitreten'}</span></button>
          ${linkButton('/start', 'Abbrechen', { kind: 'quiet', size: 'lg' })}</form>
      </div>`;
    res.send(page(req, { title: 'Klasse beitreten', body, width: 'narrow', styles: STYLES }));
  });

  app.post('/beitreten/:code', (req, res) => {
    const own = ownClassOfStaleCode(req);
    if (own) return res.redirect(303, `/klassen/${own}`);
    const { row: code, cls } = findCode(req);
    const role = access.joinRoleFor(req.user, code);
    if (!role) throw bad('Mit diesem Link kannst du dieser Klasse nicht beitreten.');
    // Removed by a teacher: back only with a code made after the removal (what the teacher was told).
    const removed = db.get('SELECT removed_at FROM class_removals WHERE class_id = ? AND user_id = ?', cls.id, req.user.id);
    if (removed && role === 'student' && code.created_at <= removed.removed_at) {
      throw bad('Deine Lehrkraft hat dich aus dieser Klasse genommen. Mit diesem Code kannst du nicht wieder beitreten – frag deine Lehrkraft nach einem neuen.');
    }
    let added = db.run('INSERT OR IGNORE INTO class_members (class_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)', cls.id, req.user.id, role, Date.now());
    // Already a student of the class (a colleague who tried its QR code first): the invitation makes them its teacher.
    // joinRoleFor gave 'teacher', so this is a staff account with a valid invitation; a class code never changes a role.
    if (!added.changes && upgrades(access.classRole(req.user, cls.id), role)) {
      added = db.run("UPDATE class_members SET role = 'teacher' WHERE class_id = ? AND user_id = ? AND role = 'student'", cls.id, req.user.id);
    }
    if (added.changes) {
      db.run('DELETE FROM class_removals WHERE class_id = ? AND user_id = ?', cls.id, req.user.id);
      services.audit(req.user, 'klasse_beigetreten', cls.name, role === 'teacher' ? 'als Lehrkraft' : 'als Schüler/in');
      flash(req, role === 'teacher' ? `Du führst „${cls.name}“ jetzt mit.` : `Willkommen in „${cls.name}“!`);
    } else flash(req, `Du bist schon in „${cls.name}“.`);
    res.redirect(303, `/klassen/${cls.id}`);
  });

  // ------------------------------------------------------- apps in a class
  /**
   * Put an app into a class. Who may add what, and whether it is approved at
   * once or waits for review, is decided by access.addToClassMode.
   */
  app.post('/klassen/:id/apps', (req, res) => {
    const cls = viewClass(req);
    const target = db.get('SELECT * FROM apps WHERE id = ?', String(req.body.app || ''));
    const mode = access.addToClassMode(req.user, target, cls.id);
    if (!mode) throw deny();
    const result = ctx.classApps.add(req.user, cls, target, mode);
    flash(req, result === 'approved' ? `„${target.name}“ ist jetzt in der Klasse „${cls.name}“.` : `„${target.name}“ wurde eingereicht. Deine Lehrkraft schaut sie sich an.`);
    res.redirect(303, mode === 'approve' ? `/klassen/${cls.id}/apps` : `/klassen/${cls.id}`);
  });

  const classApp = (cls, appId) =>
    db.get('SELECT ca.*, a.name AS app_name, a.owner_id FROM class_apps ca JOIN apps a ON a.id = ca.app_id WHERE ca.class_id = ? AND ca.app_id = ?', cls.id, String(appId));
  const appOf = (r) => db.get('SELECT * FROM apps WHERE id = ?', r.app_id);

  app.post('/klassen/:id/apps/:aid/freigeben', (req, res) => {
    const cls = changeClass(req);
    const r = classApp(cls, req.params.aid);
    if (!r) throw deny();
    // Approve exactly the version that was reviewed (sent by the form, checked against the request).
    ctx.classApps.approve(req.user, cls, appOf(r), String(req.body.version || ''), req.body.notiz);
    flash(req, `„${r.app_name}“ ist für ${cls.name} freigegeben.`);
    res.redirect(303, `/apps/${r.app_id}`);
  });

  /** "Zurückgeben": the teacher sends the waiting version back with a reason the student sees. */
  app.post('/klassen/:id/apps/:aid/ablehnen', (req, res) => {
    const cls = changeClass(req);
    const r = classApp(cls, req.params.aid);
    if (!r) throw deny();
    ctx.classApps.giveBack(req.user, cls, appOf(r), String(req.body.version || ''), req.body.grund);
    flash(req, `„${r.app_name}“ wurde zurückgegeben. Deine Begründung steht bei der App.`);
    res.redirect(303, `/apps/${r.app_id}`);
  });

  app.post('/klassen/:id/apps/:aid/entfernen', (req, res) => {
    const cls = viewClass(req);
    const r = classApp(cls, req.params.aid);
    // The class teacher can remove any app; an owner can withdraw their own (access.canRemoveFromClass).
    if (!r || !access.canRemoveFromClass(req.user, cls, r)) throw deny();
    const teacher = access.canChangeClass(req.user, cls.id);
    const a = appOf(r);
    if (!teacher && r.requested_version_id) {
      ctx.classApps.withdraw(req.user, cls, a);
      flash(req, `Die Einreichung von „${a.name}“ ist zurückgezogen.`);
    } else {
      ctx.classApps.remove(req.user, cls, a);
      flash(req, `„${a.name}“ ist nicht mehr in ${cls.name}. Die Ergebnisse bleiben für die Lehrkraft lesbar.`);
    }
    res.redirect(303, teacher ? `/klassen/${cls.id}/apps` : `/apps/${r.app_id}`);
  });

  /** A removed app comes back with the version it had. */
  app.post('/klassen/:id/apps/:aid/zurueckholen', (req, res) => {
    const cls = changeClass(req);
    const r = classApp(cls, req.params.aid);
    if (!r) throw deny();
    ctx.classApps.restore(req.user, cls, appOf(r));
    flash(req, `„${r.app_name}“ ist wieder in ${cls.name}.`);
    res.redirect(303, `/klassen/${cls.id}/apps`);
  });
};
