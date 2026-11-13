'use strict';
// Teaching tools (package A): assignments, private feedback from a teacher to
// one student, co-teacher invitations, archive / restore of a class, and the
// per-class settings of an app (declared in its schulhub.json).
// Every permission comes from access.js: canAssign, canSeeAssignment,
// canManageAssignment, canMarkDone, canGiveFeedback, canReadFeedback,
// canDeleteFeedback, canMarkFeedbackRead, canManageClass, canChangeClass,
// canEditAppSettings. Everything people wrote is shown as escaped text.

const {
  html, raw, page, flash, csrfField, postButton, linkButton, appIcon, appClass, row, list, pageHead, sectionHead, stats, stat,
  badge, notice, empty, field, formValue, dataTable, dueChip, icon,
} = require('../html');
const { deny, bad, cleanText, newId, formatDate, formatDay, formatLongDay, formatAgo, formatDue, plural } = require('../util');
const { manifestOf, validateSettings, effectiveSettings } = require('../manifest');
const kit = require('../teachingKit');

const STYLES = ['css/teaching.css'];
const STATE = { done: ['erledigt', 'ok'], started: ['begonnen', ''], open: ['offen', ''] };
const FILTERS = { offen: 'open', begonnen: 'started', erledigt: 'done' };
const settingName = (key) => `s-${key}`;

module.exports = (app, ctx) => {
  const { db, config, access, services, assignments } = ctx;

  const getClass = (id) => db.get('SELECT * FROM classes WHERE id = ?', String(id));
  const studentIds = (classId) => db.all("SELECT user_id FROM class_members WHERE class_id = ? AND role = 'student'", classId).map((r) => r.user_id);
  const classAppsOf = (classId) =>
    db.all("SELECT a.* FROM class_apps ca JOIN apps a ON a.id = ca.app_id WHERE ca.class_id = ? AND ca.status = 'approved' ORDER BY a.name COLLATE NOCASE LIMIT 200", classId);

  // ============================================================ assignments

  /** The assignment in req.params.id if the user may see it (access.canSeeAssignment), else 404. */
  function loadAssignment(req) {
    const x = db.get(
      `SELECT x.*, a.name AS app_name, a.emoji, a.color, c.name AS class_name, c.archived_at, u.name AS author_name
         FROM assignments x JOIN apps a ON a.id = x.app_id JOIN classes c ON c.id = x.class_id LEFT JOIN users u ON u.id = x.created_by
        WHERE x.id = ?`,
      String(req.params.id)
    );
    if (!x || !access.canSeeAssignment(req.user, x)) throw deny();
    return x;
  }

  /**
   * Title, note, start and due date from the form (school time).
   * Returns { values, errors } with every message keyed by its field.
   * `floor` is the moment the assignment came into existence (now, when it is
   * created): a start before it – "now", the current minute or the past –
   * becomes exactly that moment, so results from before the assignment existed
   * never count for it.
   */
  function readAssignment(body, appName, floor) {
    const now = Date.now();
    const errors = {};
    if (typeof body.notiz === 'string' && body.notiz.trim().length > 1000) errors.notiz = 'Höchstens 1000 Zeichen.';
    const title = cleanText(body.titel, 120) || appName;
    const note = cleanText(body.notiz, 1000, { multiline: true });
    const startText = typeof body.start === 'string' ? body.start.trim() : '';
    let starts = startText ? kit.schoolDateTime(startText) : floor;
    if (starts === null) {
      errors.start = 'Das ist kein gültiges Datum mit Uhrzeit.';
      starts = floor;
    } else if (starts - now > 365 * kit.DAY) errors.start = 'Der Start darf höchstens ein Jahr in der Zukunft liegen.';
    starts = Math.max(starts, floor);
    const dueDay = typeof body.faellig === 'string' ? body.faellig.trim() : '';
    const dueTime = typeof body.faellig_zeit === 'string' && body.faellig_zeit.trim() ? body.faellig_zeit.trim() : '23:59';
    let due = null;
    if (dueDay) {
      if (kit.schoolTime('2000-01-01', dueTime) === null) errors.faellig_zeit = 'Das ist keine gültige Uhrzeit.';
      else if ((due = kit.schoolTime(dueDay, dueTime)) === null) errors.faellig = 'Das ist kein gültiges Datum.';
      else if (due <= starts) errors.faellig = 'Die Aufgabe muss nach dem Start fällig sein.';
      else if (due - starts > 366 * kit.DAY) errors.faellig = 'Eine Aufgabe kann höchstens ein Jahr laufen.';
    }
    return { values: { title, note, starts, due }, errors };
  }
  const ASSIGNMENT_FIELDS = ['app', 'titel', 'notiz', 'start', 'faellig', 'faellig_zeit'];
  /** Back to the assignment form: each message at its field, what the teacher typed kept. */
  function assignmentErrors(req, res, path, errors) {
    const fields = {};
    for (const k of ASSIGNMENT_FIELDS) if (typeof req.body[k] === 'string') fields[k] = req.body[k].slice(0, 5000);
    kit.backToForm(req, res, { path, key: 'assignmentErrors', errors, fields });
  }

  function assignmentForm(req, { cls, apps = [], x = null, chosen = '', errors = {} }) {
    const now = Date.now();
    const action = x ? `/aufgaben/${x.id}/bearbeiten` : `/klassen/${cls.id}/aufgaben`;
    const selected = formValue(req, 'app', chosen || (apps[0] ? apps[0].id : ''));
    const firstName = (apps.find((a) => a.id === selected) || apps[0] || {}).name || '';
    const appField = x
      ? html`<div class="field"><span class="label">App</span><span class="teach-fixedapp">${appIcon(x, 'sm')}<span>${x.app_name}</span></span></div>`
      : field(req, {
          label: 'App',
          name: 'app',
          control: html`<select id="f-app" name="app" required data-teach-title="f-titel">${apps.map((a) => html`<option value="${a.id}" data-name="${a.name}"${a.id === selected ? raw(' selected') : ''}>${a.name}</option>`)}</select>`,
        });
    return html`<form method="post" action="${action}" class="form">${csrfField(req)}
      ${appField}
      ${field(req, { label: 'Titel', name: 'titel', value: x ? x.title : firstName, hint: 'Ohne eigenen Titel heißt die Aufgabe wie die App.', attrs: 'maxlength="120" autocomplete="off"' })}
      ${field(req, { label: 'Was zu tun ist (freiwillig)', name: 'notiz', type: 'textarea', value: x ? x.note : '', hint: 'Zum Beispiel: „Spiel drei Runden und versuch, über 80 % zu kommen.“ Höchstens 1000 Zeichen.', error: errors.notiz, attrs: 'maxlength="1000" rows="3"' })}
      <div class="teach-start">${field(req, { label: 'Start', name: 'start', type: 'datetime-local', value: kit.inputDateTime(x ? x.starts_at : now), hint: 'Vorher sehen die Schüler/innen die Aufgabe nicht. Es zählen nur Ergebnisse ab dem Start.', error: errors.start, attrs: 'required' })}</div>
      <div class="form-row teach-dates">
        ${field(req, { label: 'Fällig am (freiwillig)', name: 'faellig', type: 'date', value: x && x.due_at ? kit.inputDate(x.due_at) : '', error: errors.faellig })}
        ${field(req, { label: 'Uhrzeit', name: 'faellig_zeit', type: 'time', value: x && x.due_at ? kit.inputTime(x.due_at) : '', hint: 'Ohne Uhrzeit: bis 23:59 Uhr.', error: errors.faellig_zeit })}
      </div>
      <div class="actions stack-phone"><button class="btn primary">${icon(x ? 'save' : 'send')}<span>${x ? 'Speichern' : 'Aufgabe stellen'}</span></button>
        ${linkButton(x ? `/aufgaben/${x.id}` : `/klassen/${cls.id}/aufgaben`, 'Abbrechen', { kind: 'quiet' })}</div>
    </form>`;
  }

  app.get('/klassen/:id/aufgaben/neu', (req, res) => {
    const cls = kit.loadClass(ctx, req, 'change');
    const apps = classAppsOf(cls.id);
    const chosen = apps.some((a) => a.id === req.query.app) ? String(req.query.app) : '';
    const n = studentIds(cls.id).length;
    const body = html`${pageHead({
      crumbs: [['/klassen', 'Klassen'], [`/klassen/${cls.id}/aufgaben`, cls.name]],
      eyebrow: 'Aufgabe stellen',
      title: 'Neue Aufgabe',
      lead: `Eine App, ein Termin – fertig. ${n ? `Beginnt die Aufgabe sofort, bekommen ${kit.studentsText(n)} eine Mitteilung. Eine geplante Aufgabe sehen sie erst ab dem Start.` : 'Noch ist niemand in der Klasse.'} Wer fertig ist, erkennt der Hub an den Ergebnissen.`,
    })}
      ${apps.length
        ? assignmentForm(req, { cls, apps, chosen, errors: kit.takeFieldErrors(req, 'assignmentErrors') })
        : empty({ icon: 'apps', title: 'Noch keine App in der Klasse', text: 'Eine Aufgabe gehört immer zu einer App der Klasse. Füge zuerst eine App hinzu.', actions: linkButton(`/klassen/${cls.id}/apps#hinzufuegen`, 'App hinzufügen', { icon: 'plus' }) })}`;
    res.send(page(req, { title: 'Neue Aufgabe', body, active: 'klassen', classId: cls.id, width: 'narrow', styles: STYLES, scripts: ['teaching.js'] }));
  });

  app.post('/klassen/:id/aufgaben', (req, res) => {
    const cls = kit.loadClass(ctx, req, 'change');
    const target = db.get('SELECT * FROM apps WHERE id = ?', String(req.body.app || ''));
    if (!target || !access.canAssign(req.user, cls.id, target.id)) throw deny();
    const now = Date.now();
    const { values: f, errors } = readAssignment(req.body, target.name, now);
    if (Object.keys(errors).length) return assignmentErrors(req, res, `/klassen/${cls.id}/aufgaben/neu`, errors);
    const id = newId();
    db.run(
      'INSERT INTO assignments (id, class_id, app_id, title, note, starts_at, due_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, cls.id, target.id, f.title, f.note, f.starts, f.due, req.user.id, now
    );
    services.audit(req.user, 'aufgabe_erstellt', f.title, cls.name, { appId: target.id });
    // A planned assignment stays hidden from students until its start (access.canSeeAssignment):
    // no notice now - from the start it is on their start page.
    if (f.starts > now) {
      flash(req, `Die Aufgabe „${f.title}“ ist geplant. Die Schüler/innen sehen sie ab ${formatDate(f.starts)} auf ihrer Startseite.`);
      return res.redirect(303, `/aufgaben/${id}`);
    }
    const told = notifyStart(cls, { id, title: f.title, due_at: f.due });
    flash(req, `Die Aufgabe „${f.title}“ ist gestellt.${told ? ` ${kit.studentsText(told)} ${told === 1 ? 'hat' : 'haben'} eine Mitteilung bekommen.` : ''}`);
    res.redirect(303, `/aufgaben/${id}`);
  });

  /** "Neue Aufgabe" to every student of the class - only for an assignment that has started. Returns how many. */
  function notifyStart(cls, x) {
    const students = studentIds(cls.id);
    // The notice is read later (tomorrow, after the weekend): the date itself, never "morgen fällig".
    const due = x.due_at ? ` (fällig ${formatDay(x.due_at)}, ${kit.inputTime(x.due_at)} Uhr)` : '';
    services.notify(students, 'aufgabe', `Neue Aufgabe in ${cls.name}: „${x.title}“${due}`, `/aufgaben/${x.id}`);
    return students.length;
  }

  app.get('/aufgaben/:id', (req, res) => {
    const x = loadAssignment(req);
    res.send(access.canManageClass(req.user, x.class_id) ? teacherAssignment(req, x) : studentAssignment(req, x));
  });

  function teacherAssignment(req, x) {
    const now = Date.now();
    const user = req.user;
    const manage = access.canManageAssignment(user, x);
    const states = assignments.classStates(x);
    const manual = new Set(db.all('SELECT user_id FROM assignment_done WHERE assignment_id = ?', x.id).map((r) => r.user_id));
    const since = new Map(
      db.all(
        `SELECT r.user_id, COUNT(*) AS n, MAX(CASE WHEN r.max_score > 0 THEN r.score * 1.0 / r.max_score END) AS best
           FROM results r JOIN class_members m ON m.user_id = r.user_id AND m.class_id = ? AND m.role = 'student'
          WHERE r.app_id = ? AND (r.class_id = ? OR r.class_id = '') AND r.created_at >= ? GROUP BY r.user_id`,
        x.class_id, x.app_id, x.class_id, x.starts_at
      ).map((r) => [r.user_id, r])
    );
    const counts = { done: 0, started: 0, open: 0 };
    for (const s of states) counts[s.state]++;
    const stand = typeof req.query.stand === 'string' && Object.hasOwn(FILTERS, req.query.stand) ? req.query.stand : '';
    const filter = stand ? FILTERS[stand] : '';
    const shown = filter ? states.filter((s) => s.state === filter) : states;
    const due = formatDue(x.due_at, now);
    const past = x.due_at && x.due_at < now;
    const results = access.canSeeClassResults(user, x.class_id, x.app_id);
    // Before the start the students do not see the assignment, so nothing may be written to them about it.
    const planned = x.starts_at > now;
    const canFeedback = access.canChangeClass(user, x.class_id) && !planned;
    const here = `/aufgaben/${x.id}`;
    const stateBadge = (s) => (s.state === 'open' && past ? badge('nicht erledigt', 'danger') : s.state === 'open' && due.tone === 'wait' ? badge('offen', 'wait') : badge(STATE[s.state][0], STATE[s.state][1]));
    const feedback = db
      .all(
        `SELECT f.*, u.name AS author_name, s.name AS student_name, a.name AS app_name, NULL AS assignment_title FROM feedback f
           LEFT JOIN users u ON u.id = f.author_id LEFT JOIN users s ON s.id = f.student_id LEFT JOIN apps a ON a.id = f.app_id
          WHERE f.assignment_id = ? ORDER BY f.created_at DESC LIMIT 50`,
        x.id
      )
      .filter((f) => access.canReadFeedback(user, f));
    const seg = (key, label, n) => html`<a href="${here}${key ? `?stand=${key}` : ''}"${key === stand ? html` aria-current="page"` : ''}>${label} <span class="teach-seg-n">${n}</span></a>`;

    const body = html`${pageHead({
      crumbs: [['/klassen', 'Klassen'], [`/klassen/${x.class_id}/aufgaben`, x.class_name]],
      eyebrow: `Aufgabe · ${x.class_name}`,
      title: x.title,
      meta: html`<span class="teach-metaapp">${appIcon(x, 'xs')}${x.app_name}</span>
        <span>${x.starts_at > now ? `beginnt ${formatDate(x.starts_at)}` : `seit ${formatDay(x.starts_at)}`}</span>
        ${x.due_at ? (past ? html`<span>abgelaufen ${formatDate(x.due_at)}</span>` : due.tone ? badge(due.text, due.tone) : html`<span>${due.text}</span>`) : html`<span>ohne Termin</span>`}
        ${x.author_name ? html`<span>von ${x.author_name}</span>` : ''}`,
      actions: manage
        ? html`${linkButton(`${here}/bearbeiten`, 'Bearbeiten', { icon: 'pencil' })}${kit.headPostButton(req, `${here}/loeschen`, 'Löschen', { kind: 'danger', icon: 'trash', confirm: `Aufgabe „${x.title}“ löschen?\nDie Aufgabe verschwindet für alle Schüler/innen. Ihre Ergebnisse in der App bleiben erhalten.`, confirmLabel: 'Löschen' })}`
        : '',
    })}
    ${planned ? notice({ tone: 'wait', icon: 'calendar', title: 'Geplant', text: `Die Schüler/innen sehen diese Aufgabe erst ab ${formatDate(x.starts_at)}. Dann steht sie auf ihrer Startseite – eine Mitteilung bekommen sie dafür nicht.`, cls: 'mb-6' }) : ''}
    ${x.note ? html`<div class="panel teach-note mb-6"><p class="pre">${x.note}</p></div>` : ''}
    <section class="section" aria-label="Stand der Klasse">
      <div class="stats teach-stats3">${[
        stat({ label: 'Erledigt', value: counts.done, sub: `von ${states.length}`, tone: states.length && counts.done === states.length ? 'ok' : '' }),
        stat({ label: 'Begonnen', value: counts.started }),
        stat({ label: past ? 'Nicht erledigt' : 'Offen', value: counts.open, tone: past && counts.open ? 'danger' : '' }),
      ]}</div>
    </section>
    <section class="section" aria-labelledby="s-people">${sectionHead('Schüler/innen', {
      id: 's-people',
      sub: 'Erledigt heißt: ein Ergebnis oder voller Fortschritt in der App seit dem Start – oder selbst als erledigt markiert.',
    })}
      <div class="teach-filterbar"><nav class="teach-seg" aria-label="Filter">${seg('', 'Alle', states.length)}${seg('offen', 'Offen', counts.open)}${seg('begonnen', 'Begonnen', counts.started)}${seg('erledigt', 'Erledigt', counts.done)}</nav></div>
      ${dataTable({
        cls: 'teach-states',
        columns: [
          { label: 'Name', primary: true, render: (s) => (results ? html`<a href="/klassen/${x.class_id}/apps/${x.app_id}/ergebnisse/${s.id}">${s.name}</a>` : s.name) },
          { label: 'Stand', render: (s) => html`${stateBadge(s)}${manual.has(s.id) ? html` <span class="faint">selbst markiert</span>` : ''}` },
          {
            label: 'Seit dem Start',
            render: (s) => {
              const r = since.get(s.id);
              return r ? html`${plural(r.n, 'Ergebnis', 'Ergebnisse')}${r.best !== null ? html` <span class="faint teach-nowrap">· bestes ${Math.round(Math.max(0, Math.min(1, r.best)) * 100)}\u00a0%</span>` : ''}` : '';
            },
          },
          ...(canFeedback ? [{ label: 'Aktionen', actions: true, render: (s) => linkButton(`${here}?an=${s.id}#rueckmeldung`, 'Rückmeldung', { kind: 'quiet', size: 'sm', icon: 'message' }) }] : []),
        ],
        rows: shown,
        empty: empty({ icon: filter === 'done' ? 'tasks' : 'checkCircle', title: states.length ? 'Niemand in dieser Auswahl' : 'Noch niemand in der Klasse', text: states.length ? 'Wähle oben eine andere Auswahl.' : 'Wer der Klasse beitritt, bekommt die Aufgabe automatisch.' }),
      })}</section>
    <section class="section teach-narrow" aria-labelledby="s-fb" id="rueckmeldung">${sectionHead('Rückmeldungen zu dieser Aufgabe', { id: 's-fb', count: feedback.length ? String(feedback.length) : null })}
      ${canFeedback && states.length ? kit.feedbackForm(req, ctx, { cls: { id: x.class_id }, students: states, chosen: String(req.query.an || ''), appId: x.app_id, assignmentId: x.id, back: here }) : ''}
      ${feedback.length ? html`<div class="mt-6">${kit.feedbackTimeline(req, ctx, feedback, { back: here, showStudent: true, showClass: false })}</div>` : canFeedback && states.length ? '' : html`<p class="muted">${planned ? 'Rückmeldungen zu dieser Aufgabe schreibst du ab dem Start.' : 'Noch keine Rückmeldungen.'}</p>`}</section>`;
    return page(req, { title: x.title, body, active: 'klassen', classId: x.class_id, styles: STYLES });
  }

  function studentAssignment(req, x) {
    const user = req.user;
    const now = Date.now();
    const state = assignments.stateOf(x, user.id);
    const manual = db.get('SELECT done_at FROM assignment_done WHERE assignment_id = ? AND user_id = ?', x.id, user.id);
    const target = db.get('SELECT * FROM apps WHERE id = ?', x.app_id);
    const playable = Boolean(access.resolvePlay(user, target, { classId: x.class_id }));
    const begun = x.starts_at <= now;
    const due = formatDue(x.due_at, now);
    const canDone = access.canMarkDone(user, x) && begun;
    const feedback = db.all(
      `SELECT f.*, u.name AS author_name, a.name AS app_name, NULL AS assignment_title FROM feedback f
         LEFT JOIN users u ON u.id = f.author_id LEFT JOIN apps a ON a.id = f.app_id
        WHERE f.assignment_id = ? AND f.student_id = ? ORDER BY f.created_at DESC LIMIT 20`,
      x.id, user.id
    );
    const here = `/aufgaben/${x.id}`;
    const body = html`${pageHead({
      crumbs: [['/klassen', 'Klassen'], [`/klassen/${x.class_id}`, x.class_name]],
      eyebrow: `Aufgabe · ${x.class_name}`,
      title: x.title,
      meta: html`${state === 'done' ? badge('erledigt', 'ok') : state === 'started' ? badge('begonnen') : badge('offen', due.tone)}${x.author_name ? html`<span>von ${x.author_name}</span>` : ''}`,
      // Marking it done does not need the app: when it left the class, this is the student's way to close the task.
      actions: begun && (playable || (state !== 'done' && canDone))
        ? html`${playable ? linkButton(`/apps/${x.app_id}/spielen?klasse=${x.class_id}`, 'Öffnen', { kind: 'primary', icon: 'play', size: 'lg' }) : ''}
          ${state !== 'done' && canDone ? kit.headPostButton(req, `${here}/erledigt`, 'Als erledigt markieren', { icon: 'check', size: 'lg' }) : ''}`
        : '',
    })}
    <div class="grid-2">
      <div>
        ${begun ? '' : notice({ tone: 'wait', icon: 'calendar', title: `Beginnt ${formatDate(x.starts_at)}`, text: 'Bis dahin kannst du die Aufgabe nur ansehen.', cls: 'mb-6' })}
        ${begun && !playable ? notice({ tone: 'wait', text: 'Diese App ist nicht mehr in der Klasse. Frag deine Lehrkraft, was du tun sollst.', cls: 'mb-6' }) : ''}
        <section class="section" aria-labelledby="s-what">${sectionHead('Was zu tun ist', { id: 's-what' })}
          <ul class="list" role="list">${row({
            href: begun && playable ? `/apps/${x.app_id}/spielen?klasse=${x.class_id}` : '',
            title: x.app_name,
            start: appIcon(x),
            sub: 'In dieser App',
            cls: appClass(x),
          })}</ul>
          ${x.note ? html`<div class="panel teach-note mt-4"><p class="pre">${x.note}</p></div>` : ''}
          <div class="teach-due mt-4">${dueChip(x.due_at, due.tone)}<div>${x.due_at
            ? html`<strong>Fällig ${formatLongDay(x.due_at)}, ${kit.inputTime(x.due_at)} Uhr</strong>${due.tone ? html`<span class="meta">${due.text}</span>` : ''}`
            : html`<strong>Ohne Termin</strong><span class="meta">Mach sie, wenn es passt.</span>`}</div></div>
        </section>
        <section class="section" aria-labelledby="s-done">${sectionHead('Wann ist sie erledigt?', { id: 's-done' })}
          <p class="muted">Sobald du in der App ein Ergebnis speicherst oder sie ganz geschafft hast, gilt die Aufgabe als erledigt. Du kannst sie auch selbst als erledigt markieren.</p>
          ${state === 'done'
            ? html`${notice({ tone: 'ok', title: 'Erledigt', text: manual ? `Du hast die Aufgabe ${formatAgo(manual.done_at)} als erledigt markiert.` : 'Der Hub hat dein Ergebnis gesehen. Gut gemacht!', cls: 'mt-4' })}
              ${manual && canDone ? html`<div class="actions mt-4">${postButton(req, `${here}/offen`, 'Doch nicht erledigt', { kind: 'quiet', size: 'sm', icon: 'undo' })}</div>` : ''}`
            : ''}</section>
      </div>
      <div>
        <section class="section" aria-labelledby="s-fb">${sectionHead('Rückmeldungen', { id: 's-fb' })}
          ${feedback.length
            ? kit.feedbackTimeline(req, ctx, feedback, { back: here, showClass: false })
            : html`<p class="muted">Noch keine Rückmeldung zu dieser Aufgabe.</p>`}</section>
      </div>
    </div>`;
    return page(req, { title: x.title, body, active: 'klassen', classId: x.class_id, styles: STYLES });
  }

  /** Load an assignment the user may change (its class's teachers, class not archived). */
  function manageAssignment(req) {
    const x = loadAssignment(req);
    if (!access.canManageAssignment(req.user, x)) throw deny();
    return x;
  }

  app.get('/aufgaben/:id/bearbeiten', (req, res) => {
    const x = manageAssignment(req);
    const body = html`${pageHead({
      crumbs: [['/klassen', 'Klassen'], [`/klassen/${x.class_id}/aufgaben`, x.class_name], [`/aufgaben/${x.id}`, x.title]],
      title: 'Aufgabe bearbeiten',
    })}${assignmentForm(req, { cls: { id: x.class_id }, x, errors: kit.takeFieldErrors(req, 'assignmentErrors') })}`;
    res.send(page(req, { title: 'Aufgabe bearbeiten', body, active: 'klassen', classId: x.class_id, width: 'narrow', styles: STYLES }));
  });

  app.post('/aufgaben/:id/bearbeiten', (req, res) => {
    const x = manageAssignment(req);
    const { values: f, errors } = readAssignment(req.body, x.app_name, x.created_at);
    if (Object.keys(errors).length) return assignmentErrors(req, res, `/aufgaben/${x.id}/bearbeiten`, errors);
    db.run('UPDATE assignments SET title = ?, note = ?, starts_at = ?, due_at = ? WHERE id = ?', f.title, f.note, f.starts, f.due, x.id);
    services.audit(req.user, 'aufgabe_geaendert', f.title, x.class_name, { appId: x.app_id });
    // A planned assignment that now starts at once is new for the students: they are told now.
    // One moved into the future is hidden again - so is the notice they got about it.
    const now = Date.now();
    const told = x.starts_at > now && f.starts <= now ? notifyStart({ id: x.class_id, name: x.class_name }, { id: x.id, title: f.title, due_at: f.due }) : 0;
    if (x.starts_at <= now && f.starts > now) db.run("DELETE FROM notices WHERE kind = 'aufgabe' AND href = ?", `/aufgaben/${x.id}`);
    flash(req, `Die Aufgabe ist gespeichert.${told ? ` ${kit.studentsText(told)} ${told === 1 ? 'hat' : 'haben'} eine Mitteilung bekommen.` : ''}`);
    res.redirect(303, `/aufgaben/${x.id}`);
  });

  app.post('/aufgaben/:id/loeschen', (req, res) => {
    const x = manageAssignment(req);
    db.tx(() => {
      db.run('DELETE FROM assignments WHERE id = ?', x.id);
      // "Neue Aufgabe" would now lead nowhere (404) and still quote its title.
      db.run("DELETE FROM notices WHERE kind = 'aufgabe' AND href = ?", `/aufgaben/${x.id}`);
      services.audit(req.user, 'aufgabe_geloescht', x.title, x.class_name, { appId: x.app_id });
    });
    flash(req, `Die Aufgabe „${x.title}“ ist gelöscht.`);
    res.redirect(303, `/klassen/${x.class_id}/aufgaben`);
  });

  /** A student marks THEIR OWN assignment as done (nothing in the request names a person). */
  app.post('/aufgaben/:id/erledigt', (req, res) => {
    const x = loadAssignment(req);
    if (!access.canMarkDone(req.user, x)) throw deny();
    if (x.starts_at > Date.now()) throw bad('Diese Aufgabe hat noch nicht begonnen.');
    db.run('INSERT OR IGNORE INTO assignment_done (assignment_id, user_id, done_at) VALUES (?, ?, ?)', x.id, req.user.id, Date.now());
    flash(req, 'Super! Die Aufgabe ist als erledigt markiert.');
    res.redirect(303, `/aufgaben/${x.id}`);
  });

  app.post('/aufgaben/:id/offen', (req, res) => {
    const x = loadAssignment(req);
    if (!access.canMarkDone(req.user, x)) throw deny();
    db.run('DELETE FROM assignment_done WHERE assignment_id = ? AND user_id = ?', x.id, req.user.id);
    flash(req, assignments.stateOf(x, req.user.id) === 'done' ? 'Deine Markierung ist weg – die Aufgabe bleibt erledigt, weil du schon ein Ergebnis hast.' : 'Die Aufgabe ist wieder offen.');
    res.redirect(303, `/aufgaben/${x.id}`);
  });

  // =============================================================== feedback

  const FEEDBACK_SQL = `SELECT f.*, u.name AS author_name, s.name AS student_name, c.name AS class_name, a.name AS app_name, x.title AS assignment_title
      FROM feedback f JOIN classes c ON c.id = f.class_id LEFT JOIN users u ON u.id = f.author_id LEFT JOIN users s ON s.id = f.student_id
      LEFT JOIN apps a ON a.id = f.app_id LEFT JOIN assignments x ON x.id = f.assignment_id`;

  /** Teacher -> one student of their (active) class, privately (access.canGiveFeedback). */
  app.post('/klassen/:id/rueckmeldungen', (req, res) => {
    const cls = getClass(req.params.id);
    if (!cls || !access.canChangeClass(req.user, cls.id)) throw deny();
    const studentId = typeof req.body.schueler === 'string' ? req.body.schueler : '';
    if (!studentId) throw bad('Bitte wähle aus, an wen die Rückmeldung geht.');
    if (!access.canGiveFeedback(req.user, cls.id, studentId)) throw deny();
    const max = config.limits.feedbackChars;
    if (typeof req.body.text === 'string' && req.body.text.trim().length > max) throw bad(`Die Rückmeldung ist zu lang (höchstens ${max} Zeichen).`);
    const text = cleanText(req.body.text, max, { multiline: true });
    if (!text) throw bad('Die Rückmeldung ist leer.');
    // Optional links to an app or assignment - only ones of this class.
    const assignmentId = typeof req.body.aufgabe === 'string' && req.body.aufgabe ? req.body.aufgabe : null;
    const x = assignmentId ? db.get('SELECT * FROM assignments WHERE id = ? AND class_id = ?', assignmentId, cls.id) : null;
    if (assignmentId && !x) throw deny();
    // The feedback (and its notice) would show the title of an assignment the student may not see yet.
    if (x && x.starts_at > Date.now()) throw bad('Diese Aufgabe hat noch nicht begonnen, die Schüler/innen sehen sie noch nicht. Schreib die Rückmeldung nach dem Start – oder ohne Bezug zur Aufgabe.');
    const appId = typeof req.body.app === 'string' && req.body.app ? req.body.app : x ? x.app_id : null;
    if (appId && !access.wasApprovedIn(cls.id, appId)) throw deny();
    const student = db.get('SELECT id, name FROM users WHERE id = ?', studentId);
    const appName = appId ? db.get('SELECT name FROM apps WHERE id = ?', appId).name : '';
    db.run(
      'INSERT INTO feedback (id, class_id, student_id, author_id, app_id, assignment_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      newId(), cls.id, student.id, req.user.id, appId, x ? x.id : null, text, Date.now()
    );
    services.notify([student.id], 'rueckmeldung', `Neue Rückmeldung von ${req.user.name}${x ? ` zu „${x.title}“` : appName ? ` zu „${appName}“` : ''} (${cls.name})`, '/rueckmeldungen', { subjectId: req.user.id });
    flash(req, `Deine Rückmeldung an ${student.name} ist gesendet.`);
    res.redirect(303, kit.backTo(req.body.zurueck, `/klassen/${cls.id}`));
  });

  /** Students: all feedback to them, newest first. Teachers: the feedback they wrote. */
  app.get('/rueckmeldungen', (req, res) => {
    const user = req.user;
    const all = req.query.alle === '1';
    const limit = all ? 500 : 50;
    const received = db.all(`${FEEDBACK_SQL} WHERE f.student_id = ? ORDER BY f.created_at DESC LIMIT ?`, user.id, limit + 1).filter((f) => access.canReadFeedback(user, f));
    const written = access.isStaff(user) ? db.all(`${FEEDBACK_SQL} WHERE f.author_id = ? ORDER BY f.created_at DESC LIMIT ?`, user.id, limit + 1).filter((f) => access.canReadFeedback(user, f)) : [];
    const unread = received.filter((f) => !f.read_at).length;
    const more = received.length > limit || written.length > limit;
    const staff = access.isStaff(user);

    const body = html`${pageHead({
      title: 'Rückmeldungen',
      lead: staff
        ? 'Was du Schüler/innen zurückgemeldet hast. Jede Rückmeldung sehen nur die Person selbst und die Lehrkräfte ihrer Klasse.'
        : 'Was deine Lehrkräfte dir zu deiner Arbeit schreiben. Das sehen nur du, die Lehrkräfte deiner Klasse und die Schulverwaltung.',
      meta: unread ? html`<span>${plural(unread, 'neue Rückmeldung', 'neue Rückmeldungen')}</span>` : '',
      actions: unread ? kit.headPostButton(req, '/rueckmeldungen/gelesen', 'Alle als gelesen markieren', { icon: 'check' }) : '',
    })}
    ${received.length || !staff
      ? html`<section class="section" aria-labelledby="s-recv">${staff ? sectionHead('An dich', { id: 's-recv' }) : html`<h2 class="visually-hidden" id="s-recv">An dich</h2>`}
          ${received.length
            ? kit.feedbackTimeline(req, ctx, received.slice(0, limit), { back: '/rueckmeldungen' })
            : empty({ icon: 'message', title: 'Noch keine Rückmeldung', text: 'Wenn eine Lehrkraft dir etwas zu deiner Arbeit in einer App schreibt, steht es hier. Du bekommst dann auch eine Mitteilung.' })}</section>`
      : ''}
    ${staff
      ? html`<section class="section" aria-labelledby="s-written">${sectionHead('Von dir geschrieben', { id: 's-written', count: written.length ? String(Math.min(written.length, limit)) : null })}
          ${written.length
            ? kit.feedbackTimeline(req, ctx, written.slice(0, limit), { back: '/rueckmeldungen', showStudent: true })
            : empty({ icon: 'message', title: 'Noch keine Rückmeldung geschrieben', text: 'Rückmeldungen schreibst du bei den Ergebnissen einer Schülerin oder eines Schülers oder bei einer Aufgabe.', actions: linkButton('/klassen', 'Zu den Klassen', { icon: 'klassen' }) })}</section>`
      : ''}
    ${more && !all ? html`<p>${linkButton('/rueckmeldungen?alle=1', 'Ältere anzeigen', { kind: 'quiet' })}</p>` : ''}`;
    res.send(page(req, { title: 'Rückmeldungen', body, width: 'narrow', styles: STYLES }));
  });

  /** One feedback the user may read (access.canReadFeedback), else 404. */
  function loadFeedback(req) {
    const f = db.get('SELECT * FROM feedback WHERE id = ?', String(req.params.id));
    if (!f || !access.canReadFeedback(req.user, f)) throw deny();
    return f;
  }

  app.post('/rueckmeldungen/gelesen', (req, res) => {
    const done = db.run('UPDATE feedback SET read_at = ? WHERE student_id = ? AND read_at IS NULL', Date.now(), req.user.id);
    flash(req, done.changes ? 'Alle Rückmeldungen sind als gelesen markiert.' : 'Es gab keine ungelesenen Rückmeldungen.');
    res.redirect(303, '/rueckmeldungen');
  });

  app.post('/rueckmeldungen/:id/gelesen', (req, res) => {
    const f = loadFeedback(req);
    if (!access.canMarkFeedbackRead(req.user, f)) throw deny();
    db.run('UPDATE feedback SET read_at = COALESCE(read_at, ?) WHERE id = ?', Date.now(), f.id);
    flash(req, 'Als gelesen markiert.');
    res.redirect(303, kit.backTo(req.body.zurueck, '/rueckmeldungen'));
  });

  app.post('/rueckmeldungen/:id/loeschen', (req, res) => {
    const f = loadFeedback(req);
    if (!access.canDeleteFeedback(req.user, f)) throw deny();
    db.run('DELETE FROM feedback WHERE id = ?', f.id);
    flash(req, 'Die Rückmeldung ist gelöscht.');
    res.redirect(303, kit.backTo(req.body.zurueck, '/rueckmeldungen'));
  });

  // ============================================== co-teachers (invitation)

  app.post('/klassen/:id/einladung', (req, res) => {
    const cls = kit.loadClass(ctx, req, 'change');
    const minutes = Object.hasOwn(kit.DURATIONS, String(req.body.minuten)) ? Number(req.body.minuten) : 1440;
    services.createJoinCode(req.user, cls.id, minutes, 'teacher');
    services.audit(req.user, 'lehrkraft_eingeladen', cls.name, kit.DURATIONS[minutes]);
    flash(req, `Einladungslink erzeugt, gültig für ${kit.DURATIONS[minutes]}. Schick ihn deiner Kollegin oder deinem Kollegen.`);
    res.redirect(303, `/klassen/${cls.id}/mitglieder`);
  });

  app.post('/klassen/:id/einladung/loeschen', (req, res) => {
    const cls = kit.loadClass(ctx, req, 'change');
    const done = db.run("DELETE FROM join_codes WHERE class_id = ? AND role = 'teacher'", cls.id);
    if (done.changes) services.audit(req.user, 'einladung_geloescht', cls.name);
    flash(req, done.changes ? 'Die Einladung ist gelöscht. Der Link funktioniert nicht mehr.' : 'Es gab keine Einladung, die gelöscht werden konnte.');
    res.redirect(303, `/klassen/${cls.id}/mitglieder`);
  });

  // ======================================================= archive, restore

  app.post('/klassen/:id/archivieren', (req, res) => {
    const cls = kit.loadClass(ctx, req, 'manage');
    if (cls.archived_at) throw bad('Diese Klasse ist schon archiviert.');
    const now = Date.now();
    db.tx(() => {
      db.run('UPDATE classes SET archived_at = ? WHERE id = ?', now, cls.id);
      // As when the admin archives: the codes go, so that an old QR code does not work again after a restore.
      db.run('DELETE FROM join_codes WHERE class_id = ?', cls.id);
      services.audit(req.user, 'klasse_archiviert', cls.name);
    });
    flash(req, `„${cls.name}“ ist archiviert und wird am ${kit.deletionDay(ctx, { ...cls, archived_at: now })} gelöscht. Bis dahin kannst du sie zurückholen.`);
    res.redirect(303, `/klassen/${cls.id}`);
  });

  app.post('/klassen/:id/wiederherstellen', (req, res) => {
    const cls = kit.loadClass(ctx, req, 'manage');
    if (!cls.archived_at) throw bad('Diese Klasse ist nicht archiviert.');
    db.run('UPDATE classes SET archived_at = NULL WHERE id = ?', cls.id);
    services.audit(req.user, 'klasse_wiederhergestellt', cls.name);
    flash(req, `„${cls.name}“ ist wieder aktiv. Die Schüler/innen sehen sie wieder.`);
    res.redirect(303, `/klassen/${cls.id}`);
  });

  // ================================================ per-class app settings

  /** Teacher of the (active) class, app approved there (access.canEditAppSettings); fields from the version the class uses. */
  function loadAppSettings(req) {
    const cls = getClass(req.params.id);
    const a = db.get('SELECT * FROM apps WHERE id = ?', String(req.params.aid));
    if (!cls || !a || !access.canEditAppSettings(req.user, cls.id, a.id)) throw deny();
    const ca = db.get('SELECT version_id FROM class_apps WHERE class_id = ? AND app_id = ?', cls.id, a.id);
    if (!ca) throw deny();
    const version = db.get('SELECT number, manifest FROM app_versions WHERE id = ?', ca.version_id || '');
    const stored = db.get(
      'SELECT s.value, s.updated_at, u.name AS updated_by_name FROM class_app_settings s LEFT JOIN users u ON u.id = s.updated_by WHERE s.class_id = ? AND s.app_id = ?',
      cls.id, a.id
    );
    let saved = null;
    try {
      saved = stored ? JSON.parse(stored.value) : null;
    } catch {
      saved = null;
    }
    return { cls, a, version, manifest: manifestOf(version), stored, saved };
  }

  /** One form control per setting type; values come back after an error (formValue). */
  function settingField(req, f, value, error, sent) {
    const name = settingName(f.key);
    const id = `f-${name}`;
    // The manifest's own help text if it has one, otherwise our generic hint - never both.
    const help = (generic) => f.help || generic;
    switch (f.type) {
      case 'boolean': {
        const on = sent ? formValue(req, name, '') === '1' : value === true;
        return html`<div class="field"><label class="switch teach-switch" for="${id}"><span class="teach-switch-text">${f.label}${f.help ? html`<small>${f.help}</small>` : ''}</span>
          <input type="checkbox" id="${id}" name="${name}" value="1"${on ? raw(' checked') : ''}></label>${error ? html`<span class="error-text">${error}</span>` : ''}</div>`;
      }
      case 'choice': {
        const current = sent ? formValue(req, name, '') : value;
        const radio = (o) => html`<input type="radio" name="${name}" value="${o.value}"${o.value === current ? raw(' checked') : ''}>`;
        const foot = html`${f.help ? html`<span class="hint">${f.help}</span>` : ''}${error ? html`<span class="error-text">${error}</span>` : ''}`;
        // Short labels: one segmented control. Longer ones: radio buttons whose text wraps (a select would cut it off on phones).
        if (f.options.length <= 4 && f.options.every((o) => o.label.length <= 18)) {
          return html`<fieldset class="field"><legend>${f.label}</legend><div class="segmented teach-choice">${f.options.map((o) => html`<label>${radio(o)}${o.label}</label>`)}</div>${foot}</fieldset>`;
        }
        if (f.options.length <= 6) {
          return html`<fieldset class="field"><legend>${f.label}</legend><div class="teach-radios">${f.options.map((o) => html`<label class="check teach-radio">${radio(o)}<span>${o.label}</span></label>`)}</div>${foot}</fieldset>`;
        }
        return field(req, { label: f.label, name, hint: f.help, error, control: html`<select id="${id}" name="${name}">${f.options.map((o) => html`<option value="${o.value}"${o.value === current ? raw(' selected') : ''}>${o.label}</option>`)}</select>` });
      }
      case 'number': {
        const range = f.min !== null && f.max !== null ? `Zwischen ${f.min} und ${f.max}.` : f.min !== null ? `Mindestens ${f.min}.` : f.max !== null ? `Höchstens ${f.max}.` : '';
        const attrs = [f.min !== null ? `min="${Number(f.min)}"` : '', f.max !== null ? `max="${Number(f.max)}"` : '', `step="${Number(f.step) || 'any'}"`, 'inputmode="decimal"'].filter(Boolean).join(' ');
        return field(req, { label: f.label, name, type: 'number', value: String(value), hint: help(range), error, attrs });
      }
      case 'list':
        return field(req, { label: f.label, name, type: 'textarea', value: (value || []).join('\n'), hint: help(`Ein Eintrag pro Zeile, höchstens ${f.maxItems}.`), error, attrs: `rows="${Math.min(14, Math.max(4, (value || []).length + 1))}" spellcheck="false"` });
      case 'pairs':
        return field(req, {
          label: f.label,
          name,
          type: 'textarea',
          value: (value || []).map(([l, r]) => `${l} = ${r}`).join('\n'),
          hint: help(`Ein Paar pro Zeile: „${f.columns[0]} = ${f.columns[1]}“, höchstens ${f.maxItems}.`),
          error,
          attrs: `rows="${Math.min(16, Math.max(5, (value || []).length + 1))}" spellcheck="false"`,
        });
      default: // text
        return f.multiline
          ? field(req, { label: f.label, name, type: 'textarea', value: String(value ?? ''), hint: help(`Höchstens ${f.maxLength} Zeichen.`), error, attrs: `maxlength="${Number(f.maxLength)}" rows="4"` })
          : field(req, { label: f.label, name, value: String(value ?? ''), hint: f.help, error, attrs: `maxlength="${Number(f.maxLength)}"` });
    }
  }

  app.get('/klassen/:id/apps/:aid/einstellungen', (req, res) => {
    const { cls, a, version, manifest, stored, saved } = loadAppSettings(req);
    const here = `/klassen/${cls.id}/apps/${a.id}/einstellungen`;
    const values = effectiveSettings(manifest, saved);
    const kept = kit.takeFieldErrors(req, 'settingsErrors');
    const sent = formValue(req, 'gesendet', '') === '1';
    const body = html`${pageHead({
      crumbs: [['/klassen', 'Klassen'], [`/klassen/${cls.id}/apps`, cls.name]],
      eyebrow: `Einstellungen · ${cls.name}`,
      title: a.name,
      app: a,
      lead: 'Diese Einstellungen gelten nur in dieser Klasse. Die App liest sie beim nächsten Öffnen.',
      meta: html`<span>Version ${version ? version.number : '–'}</span>${stored ? html`<span>zuletzt geändert ${formatAgo(stored.updated_at)}${stored.updated_by_name ? ` von ${stored.updated_by_name}` : ''}</span>` : html`<span>Standardwerte der App</span>`}`,
    })}
    ${manifest.settings.length
      ? html`${kept._all ? notice({ tone: 'danger', text: kept._all, role: 'alert', cls: 'mb-6' }) : ''}
        <form method="post" action="${here}" class="form">${csrfField(req)}<input type="hidden" name="gesendet" value="1">
          ${manifest.settings.map((f) => settingField(req, f, values[f.key], kept[f.key] || '', sent))}
          <div class="actions stack-phone"><button class="btn primary">${icon('save')}<span>Speichern</span></button>${linkButton(`/klassen/${cls.id}/apps`, 'Abbrechen', { kind: 'quiet' })}</div>
        </form>
        ${stored ? html`<section class="section quiet-zone teach-reset mt-6" aria-labelledby="s-reset"><h2 id="s-reset">Standardwerte</h2>
          <p class="meta mt-2 mb-4">Löscht die Einstellungen dieser Klasse. Die App nutzt dann wieder ihre eigenen Standardwerte.</p>
          ${postButton(req, `${here}/zuruecksetzen`, 'Auf Standard zurücksetzen', { kind: 'danger', size: 'sm', icon: 'undo', confirm: 'Einstellungen zurücksetzen?\nDie Einstellungen dieser Klasse werden gelöscht. Die App nutzt dann wieder ihre Standardwerte.', confirmLabel: 'Zurücksetzen' })}</section>` : ''}`
      : empty({ icon: 'sliders', title: 'Diese App hat keine Einstellungen', text: 'Apps können in ihrer schulhub.json Einstellungen erklären, die Lehrkräfte hier pro Klasse ändern – zum Beispiel eine Wörterliste.', actions: linkButton(`/klassen/${cls.id}/apps`, 'Zurück zu den Apps', { icon: 'arrowLeft' }) })}`;
    res.send(page(req, { title: `Einstellungen ${a.name}`, body, active: 'klassen', classId: cls.id, width: 'narrow', styles: STYLES }));
  });

  app.post('/klassen/:id/apps/:aid/einstellungen', (req, res) => {
    const { cls, a, manifest } = loadAppSettings(req);
    const here = `/klassen/${cls.id}/apps/${a.id}/einstellungen`;
    if (!manifest.settings.length) throw bad('Diese App hat keine Einstellungen.');
    const input = {};
    const typed = { gesendet: '1' };
    for (const f of manifest.settings) {
      const sentValue = req.body[settingName(f.key)];
      const one = Array.isArray(sentValue) ? sentValue[sentValue.length - 1] : sentValue;
      if (f.type === 'boolean') input[f.key] = one === '1';
      else if (typeof one === 'string') input[f.key] = one;
      if (typeof one === 'string') typed[settingName(f.key)] = one.slice(0, 20000);
    }
    const { values, errors } = validateSettings(manifest, input);
    if (Object.keys(errors).length) {
      // Back to the form with every field's message and what the teacher typed.
      return kit.backToForm(req, res, { path: here, key: 'settingsErrors', errors, fields: typed });
    }
    db.run(
      `INSERT INTO class_app_settings (class_id, app_id, value, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (class_id, app_id) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      cls.id, a.id, JSON.stringify(values), req.user.id, Date.now()
    );
    services.audit(req.user, 'app_einstellungen_geaendert', a.name, cls.name, { appId: a.id });
    flash(req, 'Gespeichert. Die App nutzt die neuen Einstellungen beim nächsten Öffnen.');
    res.redirect(303, here);
  });

  app.post('/klassen/:id/apps/:aid/einstellungen/zuruecksetzen', (req, res) => {
    const { cls, a } = loadAppSettings(req);
    const done = db.run('DELETE FROM class_app_settings WHERE class_id = ? AND app_id = ?', cls.id, a.id);
    if (done.changes) services.audit(req.user, 'app_einstellungen_zurueckgesetzt', a.name, cls.name, { appId: a.id });
    flash(req, 'Die Einstellungen stehen wieder auf den Standardwerten der App.');
    res.redirect(303, `/klassen/${cls.id}/apps/${a.id}/einstellungen`);
  });
};
