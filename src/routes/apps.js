'use strict';
// Apps (package B): "Meine Apps", creating an app, the app page for its owner,
// for reviewing teachers and for the admin (versions, upload, classes, history,
// anonymous usage, settings, school-wide release), the source viewer and the
// download. The player and the SDK token route live in routes/player.js, the
// review queue and workbench in routes/review.js.
//
// Every route loads its object and checks it with access.js; every state
// change is a POST with the CSRF token; everything is rendered through html``.

const express = require('express');
const fs = require('node:fs');
const {
  html, raw, page, flash, csrfField, postButton, linkButton, icon, appIcon, badge, pageHead, tabs, sectionHead,
  list, row, stat, stats, barChart, meter, empty, notice, field, formValue, EMOJIS, COLORS, COLOR_NAMES,
} = require('../html');
const { deny, bad, cleanText, formatDate, formatDay, formatAgo, formatBytes, plural, dayKey, newId, HttpError } = require('../util');
const { CATEGORIES } = require('../manifest');
const { isHubFile } = require('../checks');
const V = require('../appViews');

const DAY = 86_400_000;
/** The tab set of the "Bauen" area (package C uses the same on its pages). */
const BAUEN_TABS = [['/apps', 'Meine Apps', 'apps'], ['/entwickeln/vorlagen', 'Vorlagen', 'vorlagen'], ['/entwickeln', 'Anleitung', 'anleitung'], ['/entwickeln/sdk', 'SDK', 'sdk']];
const VIEW_MAX = 400 * 1024; // source viewer: larger text files are offered as download only
const USAGE_MIN_PEOPLE = 5; // usage numbers about fewer people are not shown
const str = (v) => (typeof v === 'string' ? v : '');

/** "7b, 8a und 9c" - at most `max` names, then "und N weitere". */
function names(items, max = 4) {
  if (items.length <= 1) return items.join('');
  if (items.length > max) return `${items.slice(0, max).join(', ')} und ${items.length - max} weitere`;
  return `${items.slice(0, -1).join(', ')} und ${items[items.length - 1]}`;
}

module.exports = (app, ctx) => {
  const { db, config, access, services, uploads, limiter } = ctx;
  const L = config.limits;

  const getApp = (id) => db.get('SELECT * FROM apps WHERE id = ?', String(id));
  /** Owner or admin, else 404. */
  function manageApp(req) {
    const a = getApp(req.params.id);
    if (!a || !access.canManageApp(req.user, a)) throw deny();
    return a;
  }
  /** Owner, admin, or a teacher of a class the app was submitted to - else 404. */
  function reviewApp(req) {
    const a = getApp(req.params.id);
    if (!a || !access.canReviewApp(req.user, a)) throw deny();
    return a;
  }
  const getVersion = (a, id, status = 'ready') => {
    const v = db.get('SELECT * FROM app_versions WHERE id = ? AND app_id = ?', String(id), a.id);
    if (!v || v.status !== status) throw deny();
    return v;
  };
  const getClass = (id) => (typeof id === 'string' && id ? db.get('SELECT * FROM classes WHERE id = ?', id) : null);
  /** A version this user may inspect (see access.canSeeVersion), else 404. */
  function inspectVersion(req, a) {
    const v = getVersion(a, req.params.vid);
    if (!access.canSeeVersion(req.user, a, v.id)) throw deny();
    return v;
  }

  // ------------------------------------------------------------ form parts

  /** Subject and grades from a form; validated against fixed lists. */
  function catalogFields(body) {
    const category = CATEGORIES.includes(body.category) ? body.category : '';
    const grade = (v) => {
      const n = Number.parseInt(str(v), 10);
      return n >= 1 && n <= 13 ? n : null;
    };
    let min = grade(body.grade_min);
    let max = grade(body.grade_max);
    if (min === null) min = max;
    if (max === null) max = min;
    if (min !== null && min > max) throw bad('Bei den Klassenstufen muss „von“ kleiner sein als „bis“.');
    return { category, gradeMin: min, gradeMax: max };
  }

  function emojiPicker(req, current) {
    const sel = formValue(req, 'emoji', current);
    return html`<fieldset><legend>Symbol</legend><div class="choices">${EMOJIS.map((e) => html`<label><input type="radio" name="emoji" value="${e}"${e === sel ? raw(' checked') : ''}><span>${e}</span></label>`)}</div></fieldset>`;
  }
  function colorPicker(req, current) {
    const sel = String(formValue(req, 'color', String(current)));
    return html`<fieldset><legend>Farbe</legend><div class="choices">${Array.from({ length: COLORS }, (_, i) => html`<label class="app-${i}" title="${COLOR_NAMES[i]}"><input type="radio" name="color" value="${i}" aria-label="${COLOR_NAMES[i]}"${String(i) === sel ? raw(' checked') : ''}><span class="swatch"></span></label>`)}</div></fieldset>`;
  }
  function categoryField(req, current) {
    const sel = formValue(req, 'category', current || '');
    return field(req, {
      label: 'Fach', name: 'category',
      control: html`<select id="f-category" name="category"><option value="">Kein bestimmtes Fach</option>${CATEGORIES.map((c) => html`<option value="${c}"${c === sel ? raw(' selected') : ''}>${c}</option>`)}</select>`,
    });
  }
  function gradeField(req, min, max) {
    const a = String(formValue(req, 'grade_min', min ?? ''));
    const b = String(formValue(req, 'grade_max', max ?? ''));
    const options = (sel) => html`<option value="">–</option>${Array.from({ length: 13 }, (_, i) => html`<option value="${i + 1}"${String(i + 1) === sel ? raw(' selected') : ''}>${i + 1}</option>`)}`;
    return html`<fieldset class="apps-grades"><legend>Klassenstufen</legend><div class="apps-grade-row">
      <label for="f-grade_min">von</label><select id="f-grade_min" name="grade_min">${options(a)}</select>
      <label for="f-grade_max">bis</label><select id="f-grade_max" name="grade_max">${options(b)}</select></div></fieldset>`;
  }
  /** Name, description, symbol, colour, subject, grades - for "Neue App" and the settings. */
  function appFormFields(req, a) {
    return html`${field(req, { label: 'Name', name: 'name', value: a ? a.name : '', required: true, attrs: 'minlength="2" maxlength="60" autocomplete="off"' })}
      ${field(req, { label: 'Kurze Beschreibung', name: 'description', type: 'textarea', value: a ? a.description : '', hint: 'Ein, zwei Sätze: Worum geht es? Was übt man? (freiwillig)', attrs: 'maxlength="500" rows="3"' })}
      ${emojiPicker(req, a ? a.emoji : EMOJIS[0])}
      ${colorPicker(req, a ? a.color : 0)}
      <div class="form-row">${categoryField(req, a ? a.category : '')}${gradeField(req, a ? a.grade_min : null, a ? a.grade_max : null)}</div>`;
  }

  // ------------------------------------------------------------ publishing

  /** Classes of this app (active, not removed) and whether the actor teaches there. */
  const planRows = (actor, a) =>
    db.all(
      `SELECT ca.class_id, ca.version_id, c.name, (m.role = 'teacher') AS teaches
         FROM class_apps ca JOIN classes c ON c.id = ca.class_id AND c.archived_at IS NULL
         LEFT JOIN class_members m ON m.class_id = ca.class_id AND m.user_id = ?
        WHERE ca.app_id = ? AND ca.status <> 'removed' ORDER BY c.name COLLATE NOCASE`,
      actor.id, a.id
    );
  /**
   * What publishing this version does, computed like classApps.onPublish and
   * services.publish: classes where the publisher teaches (or the admin
   * publishes) switch at once; elsewhere the new version waits for the teacher.
   */
  function publishPlan(actor, a, versionId, rows = planRows(actor, a)) {
    const now = [];
    const wait = [];
    for (const r of rows) {
      if (actor.role === 'admin' || r.teaches) now.push(r.name);
      else if (r.version_id !== versionId) wait.push(r.name);
    }
    const schoolwide = a.schoolwide_version_id && a.schoolwide_version_id !== versionId ? (actor.role === 'admin' ? 'now' : 'wait') : '';
    return { now, wait, schoolwide };
  }
  function planText(plan) {
    const parts = [];
    if (plan.now.length) parts.push(`Sofort neu in ${names(plan.now)}.`);
    if (plan.wait.length) parts.push(`In ${names(plan.wait)} wartet sie auf die Lehrkraft – bis zur Freigabe läuft dort die bisherige Version.`);
    if (plan.schoolwide === 'now') parts.push('Für die ganze Schule gilt sie sofort.');
    if (plan.schoolwide === 'wait') parts.push('Für die ganze Schule wartet sie auf die Verwaltung.');
    if (!parts.length) parts.push('Sie wird zu der Version, die sich öffnet, wenn jemand die App startet. In Klassen ist die App noch nicht.');
    return parts.join(' ');
  }

  // =================================================================== pages

  // ---------- my apps ----------
  app.get('/apps', (req, res) => {
    const user = req.user;
    const mine = db.all(
      `SELECT a.*, pv.number AS published_number,
              (SELECT COUNT(*) FROM app_versions v WHERE v.app_id = a.id AND v.status = 'ready') AS versions,
              (SELECT COUNT(*) FROM class_apps ca JOIN classes c ON c.id = ca.class_id AND c.archived_at IS NULL
                WHERE ca.app_id = a.id AND ca.status = 'approved') AS classes,
              (SELECT COUNT(*) FROM class_apps ca WHERE ca.app_id = a.id AND ca.request_state = 'waiting') AS waiting,
              (SELECT COUNT(*) FROM class_apps ca WHERE ca.app_id = a.id AND ca.request_state = 'returned') AS returned
         FROM apps a LEFT JOIN app_versions pv ON pv.id = a.published_version_id
        WHERE a.owner_id = ? ORDER BY a.updated_at DESC LIMIT 100`,
      user.id
    );
    const used = uploads.userBytes(user.id);
    const sub = (a) => {
      if (!a.published_number) return a.versions ? `${plural(a.versions, 'Version', 'Versionen')}, noch nicht veröffentlicht` : 'Noch nichts hochgeladen';
      const where = a.classes ? `in ${plural(a.classes, 'Klasse', 'Klassen')}` : a.waiting || a.returned ? '' : 'in keiner Klasse';
      return `Version ${a.published_number} veröffentlicht${where ? ` · ${where}` : ''}`;
    };
    const marks = (a) => (a.waiting || a.returned || a.schoolwide_version_id || a.shared
      ? html`<span class="apps-badges apps-rowbadges">${a.waiting ? badge('wartet', 'wait') : ''}${a.returned ? badge('zurückgegeben', 'danger') : ''}${a.schoolwide_version_id ? badge('schulweit') : ''}${a.shared ? badge('geteilt') : ''}</span>`
      : '');
    const body = html`${pageHead({
      title: 'Meine Apps',
      lead: 'Apps, die du gebaut hast. Lade einen Ordner hoch, bearbeite sie im Editor oder starte mit einer Vorlage.',
      meta: mine.length ? html`<span>${plural(mine.length, 'App', 'Apps')} von höchstens ${L.maxAppsPerUser}</span><span>${formatBytes(used)} von ${formatBytes(L.maxUserBytes)} Speicher belegt</span>` : '',
      actions: linkButton('/apps/neu', 'Neue App', { kind: 'primary', icon: 'plus' }),
      tabs: tabs(BAUEN_TABS, 'apps'),
    })}
    ${mine.length
      ? list(mine.map((a) => row({ href: `/apps/${a.id}`, title: a.name, start: appIcon(a), sub: html`<span>${sub(a)}</span>${marks(a)}` })))
      : empty({
        icon: 'bauen',
        title: 'Noch keine eigene App',
        text: 'Jede Webseite und jedes Web-Spiel aus einem Ordner kann eine App werden. Leg eine neue App an und lade deine Dateien hoch – oder starte mit einer fertigen Vorlage und ändere sie im Editor.',
        actions: html`${linkButton('/apps/neu', 'Neue App anlegen', { kind: 'primary', icon: 'plus' })}${linkButton('/entwickeln/vorlagen', 'Aus Vorlage starten', { icon: 'template' })}`,
      })}`;
    res.send(page(req, { title: 'Meine Apps', body, active: 'bauen', styles: ['css/apps.css'] }));
  });

  // ---------- a new app ----------
  app.get('/apps/neu', (req, res) => {
    const body = html`${pageHead({
      crumbs: [['/apps', 'Meine Apps']],
      title: 'Neue App',
      lead: 'Gib deiner App einen Namen, ein Symbol und eine Farbe. Die Dateien lädst du danach hoch – oder du baust die App im Editor.',
    })}
    <div class="apps-new">
      <form method="post" action="/apps" class="form apps-form">${csrfField(req)}${appFormFields(req, null)}
        <div class="actions"><button class="btn primary">${icon('plus')}<span>App anlegen</span></button>${linkButton('/apps', 'Abbrechen', { kind: 'quiet' })}</div>
      </form>
      <aside class="apps-aside" aria-labelledby="h-vorlage">
        <h2 id="h-vorlage">Lieber nicht bei null anfangen?</h2>
        <p class="muted">Vorlagen sind fertige kleine Apps – ein Quiz, ein Klickspiel, ein Vokabeltrainer. Du änderst sie im Editor zu deiner eigenen.</p>
        ${linkButton('/entwickeln/vorlagen', 'Aus Vorlage starten', { icon: 'template' })}
        <p class="muted">Wie eine App aufgebaut ist, steht in der <a href="/entwickeln">Anleitung</a>.</p>
      </aside>
    </div>`;
    res.send(page(req, { title: 'Neue App', body, active: 'bauen', styles: ['css/apps.css'] }));
  });

  app.post('/apps', (req, res) => {
    // Everything is validated before anything is stored.
    services.appFields(req.body);
    const cat = catalogFields(req.body);
    const id = services.createApp(req.user, req.body);
    db.run('UPDATE apps SET category = ?, grade_min = ?, grade_max = ? WHERE id = ?', cat.category, cat.gradeMin, cat.gradeMax, id);
    flash(req, `„${cleanText(req.body.name, 60)}“ ist angelegt. Lade jetzt die Dateien hoch – oder baue die App im Editor.`);
    res.redirect(303, `/apps/${id}`);
  });

  // ---------- the app page ----------
  app.get('/apps/:id', (req, res) => {
    const a = getApp(req.params.id);
    if (!a) throw deny();
    if (!access.canReviewApp(req.user, a)) {
      // People who may only use the app go straight to it.
      if (access.resolvePlay(req.user, a)) return res.redirect(`/apps/${a.id}/spielen`);
      throw deny();
    }
    if (access.canManageApp(req.user, a)) return res.send(ownerPage(req, a));
    return res.send(reviewerPage(req, a));
  });

  /** Latest "returned" reason per class, with the teacher's name. */
  function returnReasons(appId) {
    const out = new Map();
    for (const r of db.all("SELECT c.class_id, c.body, c.created_at, u.name AS author_name FROM comments c LEFT JOIN users u ON u.id = c.author_id WHERE c.app_id = ? AND c.kind = 'returned' ORDER BY c.created_at DESC LIMIT 200", appId)) {
      if (!out.has(r.class_id)) out.set(r.class_id, r);
    }
    return out;
  }
  const reasonView = (why) => (why ? html`<span class="apps-reason"><span class="pre">„${why.body}“</span><span class="meta">${why.author_name || 'Lehrkraft'}, ${formatAgo(why.created_at)}</span></span>` : '');

  /** Badges and a sentence for an app's state in one class. num(id) gives a version number. */
  function classState(r, num, why) {
    if (r.archived_at) return { marks: badge('archiviert'), sub: 'Die Klasse ist archiviert.' };
    if (r.status === 'removed') return { marks: badge('entfernt'), sub: 'Die App ist nicht mehr in dieser Klasse.' };
    const req = r.requested_version_id ? `Version ${num(r.requested_version_id) ?? '–'}` : '';
    if (r.status === 'approved') {
      const base = `Version ${num(r.version_id) ?? '–'} läuft in der Klasse.`;
      if (r.request_state === 'waiting') return { marks: html`${badge('freigegeben', 'ok')}${badge(`${req} wartet`, 'wait')}`, sub: `${base} ${req} wartet auf die Lehrkraft.` };
      if (r.request_state === 'returned') return { marks: html`${badge('freigegeben', 'ok')}${badge(`${req} zurückgegeben`, 'danger')}`, sub: html`${base} ${req} wurde zurückgegeben:${reasonView(why)}` };
      return { marks: badge('freigegeben', 'ok'), sub: base };
    }
    if (r.request_state === 'returned') return { marks: badge('zurückgegeben', 'danger'), sub: html`${req} wurde zurückgegeben:${reasonView(why)}` };
    return { marks: badge('wartet', 'wait'), sub: `${req} wartet auf die Lehrkraft.` };
  }

  /** Classes the owner may still bring the app into, with the mode access.addToClassMode gives. */
  function submitOptions(user, a, classRows) {
    const taken = new Map(classRows.map((r) => [r.class_id, r]));
    return access
      .visibleClasses(user)
      .slice(0, 100)
      .filter((c) => !taken.has(c.id) || taken.get(c.id).status === 'removed')
      .map((c) => ({ c, mode: access.addToClassMode(user, a, c.id) }))
      .filter((o) => o.mode);
  }

  /** Anonymous usage numbers for the owner (and admin): no names, no per-class numbers, small counts hidden. */
  function usageSection(a) {
    const now = Date.now();
    const since = now - 30 * DAY;
    const days = Array.from({ length: 30 }, (_, i) => dayKey(now - (29 - i) * DAY));
    const counts = new Map(db.all('SELECT day, opens FROM app_usage WHERE app_id = ? AND day >= ?', a.id, days[0]).map((r) => [r.day, r.opens]));
    const bars = days.map((d, i) => ({ label: String(Number(d.slice(8))), value: counts.get(d) || 0, now: i === days.length - 1 }));
    const opens = bars.reduce((s, b) => s + b.value, 0);
    const people = db.get('SELECT COUNT(*) AS n FROM plays WHERE app_id = ? AND last_at >= ?', a.id, since).n;
    const classes = db.get("SELECT COUNT(*) AS n FROM class_apps ca JOIN classes c ON c.id = ca.class_id AND c.archived_at IS NULL WHERE ca.app_id = ? AND ca.status = 'approved'", a.id).n;
    const res = db.get(
      `SELECT COUNT(DISTINCT user_id) AS people, AVG(MIN(MAX(score * 1.0 / max_score, 0), 1)) AS avg
         FROM results WHERE app_id = ? AND created_at >= ? AND score IS NOT NULL AND max_score > 0`,
      a.id, since
    );
    const word = (t) => html`<span class="apps-statword">${t}</span>`;
    return html`<section class="section" id="nutzung" aria-labelledby="h-nutzung">
      ${sectionHead('Nutzung', { id: 'h-nutzung', sub: 'Anonym und grob: ohne Namen, ohne Zahlen einzelner Klassen. Vorschauen zählen nicht.' })}
      ${stats([
        stat({ label: 'Geöffnet', value: opens, sub: 'in 30 Tagen' }),
        stat({ label: 'Personen', value: people < USAGE_MIN_PEOPLE ? word('weniger als 5') : people, sub: 'in 30 Tagen' }),
        stat({ label: 'Klassen', value: classes, sub: 'nutzen die App' }),
        stat({ label: 'Ergebnis im Schnitt', value: res.people >= USAGE_MIN_PEOPLE && res.avg !== null ? `${Math.round(res.avg * 100)} %` : word('zu wenige Daten'), sub: 'in 30 Tagen' }),
      ])}
      <div class="apps-usage">${opens
        ? html`${barChart(bars, { label: 'Öffnungen pro Tag in den letzten 30 Tagen', height: 80 })}<div class="apps-axis" aria-hidden="true"><span>${formatDay(now - 29 * DAY)}</span><span>heute</span></div>`
        : html`<p class="meta">In den letzten 30 Tagen hat niemand die App geöffnet.</p>`}</div>
    </section>`;
  }

  /**
   * One version as a list row. The text gets a wide flex basis, so where the
   * list is narrow the actions move below it instead of squeezing it.
   */
  function versionLine(v, { live = false, marks = '', actions = '' }) {
    return html`<li class="row wrap apps-version"><span class="apps-vnum${live ? ' apps-vnum-live' : ''}" aria-hidden="true">${v.number}</span>
      <div class="row-main apps-vmain"><span class="row-title">Version ${v.number} ${marks}</span><span class="row-sub">${versionSub(v)}</span></div>
      <div class="row-end"><div class="apps-actions">${actions}</div></div></li>`;
  }

  /** Date, size, note and check summary of a version (owner and reviewer lists). */
  function versionSub(v) {
    const parts = [formatDate(v.created_at), plural(v.file_count, 'Datei', 'Dateien'), formatBytes(v.total_bytes)];
    return html`<span class="apps-vmeta">${parts.map((p, i) => html`${i ? ' · ' : ''}<span class="apps-nobr">${p}</span>`)}</span>${v.note ? html`<span class="apps-note">${v.note}</span>` : ''}<span class="apps-check"><a href="/apps/${v.app_id}/versionen/${v.id}/quelltext#pruefbericht">Prüfbericht</a>${V.reportBadges(V.parseReport(v))}</span>`;
  }
  /** Preview, source and download of a version - always the same three, at the end of the row. */
  function versionTools(v, classId = '') {
    return html`${linkButton(`/apps/${v.app_id}/spielen?version=${v.id}${classId ? `&klasse=${classId}` : ''}`, 'Vorschau', { kind: 'quiet', size: 'sm', icon: 'eye' })}${linkButton(`/apps/${v.app_id}/versionen/${v.id}/quelltext`, 'Quelltext', { kind: 'quiet', size: 'sm', icon: 'fileCode' })}${linkButton(`/apps/${v.app_id}/versionen/${v.id}/download`, `Version ${v.number} als ZIP herunterladen`, { kind: 'quiet', size: 'sm', icon: 'download', iconOnly: true })}`;
  }

  function ownerPage(req, a) {
    const user = req.user;
    const isOwner = a.owner_id === user.id;
    const isAdmin = access.isAdmin(user);
    const ownerRow = db.get('SELECT name FROM users WHERE id = ?', a.owner_id);
    const versions = db.all("SELECT * FROM app_versions WHERE app_id = ? AND status = 'ready' ORDER BY number DESC", a.id);
    const byId = new Map(versions.map((v) => [v.id, v]));
    const num = (id) => (byId.has(id) ? byId.get(id).number : null);
    const classRows = db.all('SELECT ca.*, c.name, c.archived_at FROM class_apps ca JOIN classes c ON c.id = ca.class_id WHERE ca.app_id = ? ORDER BY c.name COLLATE NOCASE', a.id);
    const active = classRows.filter((r) => !r.archived_at);
    const reasons = returnReasons(a.id);
    const newest = versions[0] || null;
    const published = a.published_version_id ? byId.get(a.published_version_id) : null;
    const fresh = typeof req.query.neu === 'string' ? byId.get(req.query.neu) : null;
    const rows = planRows(user, a);
    const sourceLink = (v) => (it) => `/apps/${a.id}/versionen/${v.id}/quelltext?datei=${encodeURIComponent(it.file)}${it.line ? `#L${it.line}` : ''}`;

    // ----- head -----
    const target = published || newest;
    // Without any version the main action is the upload right below the head ("Ordner auswählen").
    const primary = published
      ? linkButton(`/apps/${a.id}/spielen`, 'Öffnen', { kind: 'primary', icon: 'play' })
      : newest ? linkButton(`/apps/${a.id}/spielen?version=${newest.id}`, `Vorschau von Version ${newest.number}`, { kind: 'primary', icon: 'eye' }) : '';
    const more = html`<details class="menu apps-more"><summary class="btn icon" aria-label="Weitere Aktionen" title="Weitere Aktionen">${icon('more')}</summary>
      <div class="menu-panel">
        ${target ? html`<a href="/apps/${a.id}/versionen/${target.id}/quelltext">${icon('fileCode')}Quelltext ansehen</a>
          <a href="/apps/${a.id}/versionen/${target.id}/download">${icon('download')}Als ZIP herunterladen</a>` : ''}
        <a href="#klassen">${icon('klassen')}Klassen</a>
        <a href="#nutzung">${icon('chart')}Nutzung</a>
        <a href="#einstellungen">${icon('settings')}Einstellungen</a>
        <hr><a class="danger" href="#loeschen">${icon('trash')}App löschen …</a>
      </div></details>`;
    const head = pageHead({
      crumbs: isOwner ? [['/apps', 'Meine Apps']] : [['/admin/apps', 'Alle Apps']],
      app: a,
      title: a.name,
      lead: a.description,
      meta: html`${isOwner ? '' : html`<span>von ${ownerRow ? ownerRow.name : '–'}</span>`}${a.category ? html`<span>${a.category}</span>` : ''}${a.grade_min ? html`<span>${a.grade_min === a.grade_max ? `Klasse ${a.grade_min}` : `Klasse ${a.grade_min}–${a.grade_max}`}</span>` : ''}${a.shared ? html`<span>${badge('mit Kolleg/innen geteilt')}</span>` : ''}`,
      actions: html`${primary}${linkButton(`/studio/${a.id}`, 'Im Editor bearbeiten', { icon: 'edit' })}${more}`,
    });

    // ----- things that need attention -----
    const notes = [];
    for (const r of active.filter((x) => x.request_state === 'returned')) {
      const why = reasons.get(r.class_id);
      notes.push(notice({
        tone: 'danger', icon: 'undo', title: `In ${r.name} zurückgegeben`,
        text: why ? html`<span class="pre">„${why.body}“</span> <span class="meta">– ${why.author_name || 'Lehrkraft'}</span>` : 'Im Verlauf steht, was noch fehlt.',
        actions: html`${isOwner ? postButton(req, `/apps/${a.id}/einreichen`, 'Erneut einreichen', { size: 'sm', icon: 'send', fields: { klasse: r.class_id } }) : ''}${linkButton('#verlauf', 'Zum Verlauf', { kind: 'quiet', size: 'sm' })}`,
      }));
    }
    const swReq = a.schoolwide_requested_version_id && byId.get(a.schoolwide_requested_version_id);
    if (a.schoolwide_version_id && swReq) {
      notes.push(isAdmin
        ? notice({
          tone: 'wait', icon: 'school', title: `Version ${swReq.number} wartet auf die schulweite Freigabe`,
          text: `Die ganze Schule nutzt bisher Version ${num(a.schoolwide_version_id) ?? '–'}. Sieh dir die neue Version an, bevor du sie freigibst.`,
          actions: html`${postButton(req, `/apps/${a.id}/schulweit`, `Version ${swReq.number} schulweit freigeben`, { kind: 'primary', size: 'sm', icon: 'check', fields: { update: swReq.id }, confirm: `Version ${swReq.number} für die ganze Schule freigeben?\nAlle angemeldeten Personen bekommen sofort die neue Version.`, confirmLabel: 'Freigeben' })}
            ${linkButton(`/apps/${a.id}/spielen?version=${swReq.id}`, 'Vorschau', { size: 'sm', icon: 'eye' })}
            ${linkButton(`/apps/${a.id}/versionen/${swReq.id}/quelltext`, 'Quelltext', { kind: 'quiet', size: 'sm' })}
            ${postButton(req, `/apps/${a.id}/schulweit`, 'Ablehnen', { kind: 'quiet', size: 'sm', fields: { verwerfen: swReq.id }, confirm: `Version ${swReq.number} nicht schulweit freigeben?\nDie Schule behält Version ${num(a.schoolwide_version_id) ?? '–'}. ${ownerRow ? ownerRow.name : 'Die Besitzerin oder der Besitzer'} erfährt es in den Mitteilungen.`, confirmLabel: 'Ablehnen' })}`,
        })
        : notice({ tone: 'wait', icon: 'school', title: `Version ${swReq.number} wartet auf die Verwaltung`, text: `Für die ganze Schule läuft weiter Version ${num(a.schoolwide_version_id) ?? '–'}, bis die Verwaltung die neue Version freigibt.` }));
    }

    // ----- right after an upload: the check report -----
    let freshBlock = '';
    if (fresh) {
      const rep = V.parseReport(fresh);
      const tone = V.reportTone(rep);
      freshBlock = html`<div class="notice ${tone} apps-fresh" id="hochgeladen" role="status">${icon(tone === 'ok' ? 'checkCircle' : tone === 'wait' ? 'warning' : 'alert')}<div class="notice-body">
        <strong>Version ${fresh.number} ist hochgeladen</strong>
        <span>${rep && rep.items.length ? 'Die Prüfung hat etwas gefunden. Sieh es dir an, bevor du die Version veröffentlichst:' : 'Die Prüfung hat nichts gefunden. Probier die Vorschau aus und veröffentliche die Version, wenn alles passt.'}</span>
        ${rep && rep.items.length ? V.reportList(rep, { href: sourceLink(fresh) }) : ''}
        <div class="actions">${linkButton(`/apps/${a.id}/spielen?version=${fresh.id}`, 'Vorschau öffnen', { size: 'sm', icon: 'eye' })}</div></div></div>`;
    }

    // ----- status -----
    const approvedIn = active.filter((r) => r.status === 'approved');
    const waitingIn = active.filter((r) => r.request_state === 'waiting');
    const strip = !versions.length ? '' : html`<div class="apps-strip">${stats([
      stat({ label: 'Veröffentlicht', value: published ? `Version ${published.number}` : '–', sub: published ? formatDay(published.created_at) : 'noch keine Version' }),
      stat({ label: 'Klassen', value: approvedIn.length, sub: waitingIn.length ? `${plural(waitingIn.length, 'Klasse prüft', 'Klassen prüfen')} noch` : approvedIn.length ? 'nutzen die App' : 'noch in keiner', href: '#klassen' }),
      stat({ label: 'Schulweit', value: a.schoolwide_version_id ? `Version ${num(a.schoolwide_version_id) ?? '–'}` : '–', sub: a.schoolwide_version_id ? 'für alle an der Schule' : 'nur in Klassen' }),
      stat({ label: 'Versionen', value: versions.length, sub: `von höchstens ${L.maxVersionsPerApp}`, href: '#versionen' }),
    ])}</div>`;

    // ----- versions -----
    const versionRow = (v, i) => {
      const live = a.published_version_id === v.id;
      const by = (pred) => active.filter(pred);
      const named = (rs, one, many) => (rs.length === 1 ? `${one} ${rs[0].name}` : `${many} ${rs.length} Klassen`);
      const inCls = by((r) => r.status === 'approved' && r.version_id === v.id);
      const wt = by((r) => r.request_state === 'waiting' && r.requested_version_id === v.id);
      const rt = by((r) => r.request_state === 'returned' && r.requested_version_id === v.id);
      const marks = html`<span class="apps-badges">${live ? badge('veröffentlicht', 'ok') : ''}${a.schoolwide_version_id === v.id ? badge('schulweit') : ''}${a.schoolwide_requested_version_id === v.id ? badge('wartet auf Verwaltung', 'wait') : ''}${inCls.length ? badge(named(inCls, 'in', 'in')) : ''}${wt.length ? badge(named(wt, 'wartet in', 'wartet in'), 'wait') : ''}${rt.length ? badge(named(rt, 'zurückgegeben in', 'zurückgegeben in'), 'danger') : ''}</span>`;
      const inUse = live || a.schoolwide_version_id === v.id || a.schoolwide_requested_version_id === v.id || classRows.some((r) => r.version_id === v.id || r.requested_version_id === v.id);
      const plan = live ? null : publishPlan(user, a, v.id, rows);
      // Publishing first; the same three tools always end the row, so they line up from row to row.
      const actions = html`${live ? '' : i === 0
          ? postButton(req, `/apps/${a.id}/veroeffentlichen`, `Version ${v.number} veröffentlichen`, { kind: 'primary', size: 'sm', fields: { version: v.id }, confirm: `Version ${v.number} veröffentlichen?\n${planText(plan)}`, confirmLabel: 'Veröffentlichen' })
          : postButton(req, `/apps/${a.id}/veroeffentlichen`, 'Veröffentlichen', { kind: 'quiet', size: 'sm', fields: { version: v.id }, confirm: `Ältere Version ${v.number} veröffentlichen?\n${published ? `Sie ersetzt Version ${published.number}. ` : ''}${planText(plan)}`, confirmLabel: `Version ${v.number} veröffentlichen` })}
        ${versionTools(v)}
        ${inUse ? html`<span class="apps-iconspace" aria-hidden="true"></span>` : postButton(req, `/apps/${a.id}/versionen/${v.id}/loeschen`, `Version ${v.number} löschen`, { cls: 'btn quiet sm icon danger apps-quietdanger', icon: 'trash', iconOnly: true, confirm: `Version ${v.number} löschen?\nIhre Dateien werden endgültig gelöscht. Das kann nicht rückgängig gemacht werden.`, confirmLabel: 'Löschen' })}`;
      return versionLine(v, { live, marks, actions });
    };
    const versionsSection = html`<section class="section" id="versionen" aria-labelledby="h-versionen">
      ${sectionHead('Versionen', { id: 'h-versionen', count: versions.length ? String(versions.length) : null, sub: 'Jede Version bleibt privat, bis du sie veröffentlichst. Lehrkräfte sehen nur Versionen, die in ihre Klasse eingereicht wurden.' })}
      ${versions.length ? list(versions.map(versionRow)) : empty({ icon: 'layers', title: 'Noch keine Version', text: 'Lade den Ordner deiner App hoch oder baue sie im Editor. Jede hochgeladene Fassung wird eine Version.' })}
    </section>`;

    // ----- upload -----
    const used = uploads.userBytes(a.owner_id);
    const uploadSection = html`<section class="section" id="hochladen" aria-labelledby="h-hochladen">
      ${sectionHead('Neue Version hochladen', { id: 'h-hochladen', sub: 'Ein Ordner oder eine ZIP-Datei mit einer index.html ganz oben.' })}
      <div class="apps-upload" id="upload" data-app="${a.id}" data-max-files="${L.maxFiles}" data-max-file="${L.maxFileBytes}" data-max-total="${L.maxVersionBytes}" data-max-zip="${L.maxZipBytes}">
        <div class="apps-notefield">${field(req, { label: 'Was ist neu? (freiwillig)', name: 'notiz', id: 'upload-note', type: 'textarea', hint: 'Steht bei der Version und hilft der Lehrkraft beim Prüfen. Schreib sie, bevor du die Dateien auswählst.', attrs: 'maxlength="500" rows="2"' })}</div>
        <div class="dropzone" id="dropzone">
          ${icon('upload')}
          <strong class="apps-drop-title"><span class="apps-drop-fine">Ordner oder ZIP-Datei hierher ziehen</span><span class="apps-drop-coarse">Ordner oder ZIP-Datei auswählen</span></strong>
          <div class="actions">
            <label class="btn${versions.length ? '' : ' primary'}">${icon('folder')}<span>Ordner auswählen</span><input class="file-input" type="file" id="pick-folder" webkitdirectory multiple></label>
            <label class="btn">${icon('file')}<span>ZIP-Datei auswählen</span><input class="file-input" type="file" id="pick-zip" accept=".zip,application/zip"></label>
          </div>
          <span class="meta">Höchstens ${plural(L.maxFiles, 'Datei', 'Dateien')}, ${formatBytes(L.maxFileBytes)} pro Datei, ${formatBytes(L.maxVersionBytes)} insgesamt.</span>
        </div>
        <div class="apps-progress" id="upload-status" role="status" aria-live="polite" hidden>
          <p class="apps-progress-text" id="upload-text"></p>
          <progress id="upload-progress" max="1" value="0"></progress>
          <div class="actions">
            <button type="button" class="btn sm" id="upload-cancel">${icon('x')}<span>Abbrechen</span></button>
            <button type="button" class="btn sm" id="upload-retry" hidden>${icon('refresh')}<span>Noch einmal versuchen</span></button>
          </div>
        </div>
        <div class="meter-row apps-quota"><span class="meta">Speicher ${isOwner ? 'deines' : 'des'} Kontos</span><span class="num">${formatBytes(used)} von ${formatBytes(L.maxUserBytes)}</span>${meter(used / L.maxUserBytes, { label: `${formatBytes(used)} von ${formatBytes(L.maxUserBytes)} belegt` })}</div>
        <p class="meta">Hilfe zum Aufbau einer App steht in der <a href="/entwickeln">Anleitung</a>.</p>
      </div>
    </section>`;

    // ----- classes -----
    const options = isOwner && published ? submitOptions(user, a, classRows) : [];
    const classLine = (r) => {
      const st = classState(r, num, reasons.get(r.class_id));
      const open = !r.archived_at && isOwner;
      const acts = [];
      if (open && r.request_state === 'returned') acts.push(postButton(req, `/apps/${a.id}/einreichen`, 'Erneut einreichen', { size: 'sm', icon: 'send', fields: { klasse: r.class_id } }));
      if (open && r.requested_version_id) acts.push(postButton(req, `/apps/${a.id}/zurueckziehen`, 'Zurückziehen', { kind: 'quiet', size: 'sm', fields: { klasse: r.class_id }, confirm: `Einreichung in ${r.name} zurückziehen?\nDie Lehrkraft prüft diese Version dann nicht mehr.${r.status === 'approved' ? ' Die freigegebene Version bleibt in der Klasse.' : ''}`, confirmLabel: 'Zurückziehen' }));
      if (open && r.status === 'approved' && !r.requested_version_id) acts.push(postButton(req, `/apps/${a.id}/aus-klasse`, 'Aus der Klasse nehmen', { cls: 'btn quiet sm danger apps-quietdanger', fields: { klasse: r.class_id }, confirm: `„${a.name}“ aus ${r.name} nehmen?\nDie Klasse kann die App dann nicht mehr öffnen. Ergebnisse bleiben für die Lehrkraft lesbar.`, confirmLabel: 'Herausnehmen' }));
      // Actions sit under the text: the reason a teacher wrote needs the full width.
      return html`<li class="row apps-cls"><span class="tile sm app-7" aria-hidden="true">${icon('school', { cls: 'sm' })}</span>
        <div class="row-main"><span class="row-title">${r.name} <span class="apps-badges">${st.marks}</span></span><span class="row-sub">${st.sub}</span>
          ${acts.length ? html`<div class="apps-actions apps-cls-actions">${acts}</div>` : ''}</div></li>`;
    };
    const submitForm = !isOwner ? ''
      : !published ? (classRows.length ? html`<p class="meta apps-after">Veröffentliche zuerst eine Version – dann kannst du die App in eine Klasse einbringen.</p>` : '')
        : options.length ? html`<form method="post" action="/apps/${a.id}/einreichen" class="apps-submit">${csrfField(req)}
            ${field(req, { label: 'In eine Klasse einbringen', name: 'klasse', control: html`<select id="f-klasse" name="klasse">${options.map((o) => html`<option value="${o.c.id}">${o.c.name} – ${o.mode === 'approve' ? 'gleich in der Klasse' : 'die Lehrkraft prüft zuerst'}</option>`)}</select>` })}
            <button class="btn">${icon('send')}<span>${options.some((o) => o.mode === 'submit') ? 'Einreichen' : 'Hinzufügen'}</span></button></form>`
          : html`<p class="meta apps-after">Du bist in keiner weiteren Klasse, in die du die App einbringen könntest.</p>`;
    const schoolwide = isAdmin
      ? html`<div class="apps-sub"><h3>Für die ganze Schule</h3>
          <p class="meta">${a.schoolwide_version_id ? `Alle angemeldeten Personen können Version ${num(a.schoolwide_version_id) ?? '–'} öffnen.` : 'Bisher nur in Klassen.'}</p>
          <div class="actions">${a.schoolwide_version_id
            ? postButton(req, `/apps/${a.id}/schulweit`, 'Schulweite Freigabe beenden', { size: 'sm', fields: { an: '0' }, confirm: 'Schulweite Freigabe beenden?\nDie App ist danach nur noch in den Klassen, in denen sie freigegeben ist.', confirmLabel: 'Beenden' })
            : published ? postButton(req, `/apps/${a.id}/schulweit`, 'Für die ganze Schule freigeben', { size: 'sm', icon: 'school', fields: { an: '1' }, confirm: `Version ${published.number} für die ganze Schule freigeben?\nAlle angemeldeten Personen – auch Schüler/innen aller Klassen – können sie dann öffnen.`, confirmLabel: 'Freigeben' })
              : html`<span class="meta">Erst möglich, wenn eine Version veröffentlicht ist.</span>`}</div></div>`
      : a.schoolwide_version_id ? html`<p class="meta apps-after">${icon('school', { cls: 'sm' })} Die Verwaltung hat Version ${num(a.schoolwide_version_id) ?? '–'} für die ganze Schule freigegeben.</p>` : '';
    const classSection = html`<section class="section" id="klassen" aria-labelledby="h-klassen">
      ${sectionHead('Klassen', { id: 'h-klassen', count: classRows.length ? String(classRows.length) : null, sub: isOwner && user.role === 'student' ? 'Deine Lehrkraft prüft jede neue Version, bevor die Klasse sie bekommt.' : '' })}
      ${classRows.length ? list(classRows.map(classLine)) : empty({ icon: 'school', title: 'Noch in keiner Klasse', text: published ? 'Bring die App in eine Klasse, damit andere sie benutzen können.' : 'Sobald eine Version veröffentlicht ist, kannst du die App in eine Klasse einbringen.' })}
      ${submitForm}${schoolwide}
    </section>`;

    // ----- history -----
    const hist = V.historyRows(db, a.id);
    const historySection = html`<section class="section" id="verlauf" aria-labelledby="h-verlauf">
      ${sectionHead('Verlauf', { id: 'h-verlauf', sub: 'Einreichungen, Entscheidungen der Lehrkräfte und Kommentare.' })}
      ${hist.more ? html`<p class="meta mb-4">Ältere Einträge werden nicht angezeigt.</p>` : ''}
      ${hist.rows.length ? V.historyTimeline(req, hist.rows, {
        canDelete: (r) => r.kind === 'comment' && (r.author_id === user.id || isAdmin),
        deleteAction: (r) => `/apps/${a.id}/kommentare/${r.id}/loeschen`,
      }) : empty({ icon: 'message', title: 'Noch nichts passiert', text: 'Hier stehen Einreichungen, Freigaben, Rückgaben und Kommentare.' })}
      ${V.commentForm(req, `/apps/${a.id}/kommentare`, { hint: 'Lehrkräfte, die die App prüfen, lesen mit.' })}
    </section>`;

    // ----- settings and danger zone -----
    const settingsSection = html`<section class="section" id="einstellungen" aria-labelledby="h-einstellungen">
      ${sectionHead('Einstellungen', { id: 'h-einstellungen' })}
      <form method="post" action="/apps/${a.id}/bearbeiten" class="form apps-form">${csrfField(req)}${appFormFields(req, a)}
        ${access.canShareApp(user, a) ? html`<input type="hidden" name="shared_field" value="1">
          <label class="switch apps-switch"><span><strong>Mit Kolleg/innen teilen</strong><small>Andere Lehrkräfte können die veröffentlichte Version ansehen und in ihre Klassen holen.</small></span>
          <input type="checkbox" name="shared" value="1"${a.shared ? raw(' checked') : ''}></label>` : ''}
        <div class="actions"><button class="btn">${icon('save')}<span>Änderungen speichern</span></button></div>
      </form>
    </section>`;
    const dangerSection = html`<section class="danger-zone" id="loeschen" aria-labelledby="h-loeschen">
      <h2 id="h-loeschen">App löschen</h2>
      <p class="mt-2 mb-4">${versions.length ? `Löscht die App mit ${plural(versions.length, 'Version', 'Versionen')}, allen Spielständen, Ergebnissen und Kommentaren – für alle Klassen.` : 'Löscht die App mit ihren Einstellungen.'}</p>
      ${postButton(req, `/apps/${a.id}/loeschen`, 'App endgültig löschen', { kind: 'danger', icon: 'trash', confirm: `„${a.name}“ endgültig löschen?\nAlle Versionen, Spielstände, Ergebnisse und Kommentare werden gelöscht – auch in allen Klassen. Das kann nicht rückgängig gemacht werden.`, confirmLabel: 'Endgültig löschen' })}
    </section>`;

    const body = html`${head}${notes.length ? html`<div class="stack mb-6">${notes}</div>` : ''}${freshBlock}${strip}
      ${versions.length ? html`${versionsSection}${uploadSection}` : html`${uploadSection}${versionsSection}`}
      <div class="grid-2"><div>${classSection}${historySection}</div><div>${published ? usageSection(a) : ''}${settingsSection}${dangerSection}</div></div>`;
    return page(req, { title: a.name, body, active: isOwner ? 'bauen' : 'admin', styles: ['css/apps.css'], scripts: ['upload.js'] });
  }

  /** The app page for a teacher who reviews it in one of their classes (not the owner). */
  function reviewerPage(req, a) {
    const user = req.user;
    const owner = db.get('SELECT name FROM users WHERE id = ?', a.owner_id);
    const mine = access.reviewClasses(user, a); // classes where this user teaches and the app is or was
    const reviewIds = new Set(mine.map((c) => c.id));
    const versions = db.all("SELECT * FROM app_versions WHERE app_id = ? AND status = 'ready' ORDER BY number DESC", a.id).filter((v) => access.canSeeVersion(user, a, v.id));
    const byId = new Map(versions.map((v) => [v.id, v]));
    const num = (id) => (byId.has(id) ? byId.get(id).number : null);
    const reasons = returnReasons(a.id);
    const waiting = mine.filter((c) => c.request_state === 'waiting' && !c.archived_at);
    const playable = mine.filter((c) => c.status === 'approved' && !c.archived_at);
    const sinceRows = new Map(db.all("SELECT class_id, MAX(created_at) AS at FROM comments WHERE app_id = ? AND kind = 'submitted' GROUP BY class_id", a.id).map((r) => [r.class_id, r.at]));

    const head = pageHead({
      crumbs: [['/pruefen', 'Prüfen']],
      app: a,
      title: a.name,
      lead: a.description,
      meta: html`<span>von ${owner ? owner.name : '–'}</span>${a.category ? html`<span>${a.category}</span>` : ''}`,
      actions: waiting.length
        ? linkButton(`/pruefen/${waiting[0].id}/${a.id}`, 'Jetzt prüfen', { kind: 'primary', icon: 'listChecks' })
        : playable.length ? linkButton(`/apps/${a.id}/spielen?klasse=${playable[0].id}`, 'Öffnen', { kind: 'primary', icon: 'play' }) : '',
    });
    const notes = waiting.map((c) => notice({
      tone: 'wait', icon: 'clock', title: `Wartet auf deine Prüfung in ${c.name}`,
      text: `Version ${num(c.requested_version_id) ?? '–'}${sinceRows.get(c.id) ? `, eingereicht ${formatAgo(sinceRows.get(c.id))}` : ''}. Im Prüfplatz siehst du Vorschau, Prüfbericht und Änderungen nebeneinander.`,
      actions: linkButton(`/pruefen/${c.id}/${a.id}`, `In ${c.name} prüfen`, { size: 'sm', icon: 'arrowRight' }),
    }));
    const classLine = (c) => {
      const st = classState({ ...c, class_id: c.id }, num, reasons.get(c.id));
      const act = !c.archived_at && c.request_state === 'waiting'
        ? linkButton(`/pruefen/${c.id}/${a.id}`, 'Jetzt prüfen', { size: 'sm', icon: 'arrowRight' })
        : !c.archived_at && c.request_state === 'returned' ? linkButton(`/pruefen/${c.id}/${a.id}`, 'Im Prüfplatz ansehen', { kind: 'quiet', size: 'sm' }) : '';
      return html`<li class="row apps-cls"><span class="tile sm app-7" aria-hidden="true">${icon('school', { cls: 'sm' })}</span>
        <div class="row-main"><span class="row-title"><a href="/klassen/${c.id}">${c.name}</a> <span class="apps-badges">${st.marks}</span></span><span class="row-sub">${st.sub}</span>
          ${act ? html`<div class="apps-actions apps-cls-actions">${act}</div>` : ''}</div></li>`;
    };
    const versionRow = (v) => {
      const inMine = (pred) => mine.filter((c) => !c.archived_at && pred(c));
      const named = (rs, word) => (rs.length === 1 ? `${word} ${rs[0].name}` : `${word} ${rs.length} Klassen`);
      const on = inMine((c) => c.status === 'approved' && c.version_id === v.id);
      const wt = inMine((c) => c.request_state === 'waiting' && c.requested_version_id === v.id);
      const rt = inMine((c) => c.request_state === 'returned' && c.requested_version_id === v.id);
      const ctxClass = (wt[0] || rt[0] || on[0] || {}).id;
      return versionLine(v, {
        marks: html`<span class="apps-badges">${on.length ? badge(named(on, 'in'), 'ok') : ''}${wt.length ? badge(named(wt, 'wartet in'), 'wait') : ''}${rt.length ? badge(named(rt, 'zurückgegeben in'), 'danger') : ''}</span>`,
        actions: versionTools(v, ctxClass),
      });
    };
    const hist = V.historyRows(db, a.id, 80);
    // Teachers see the general conversation and the decisions of their own classes - nothing about other classes.
    const visible = hist.rows.filter((r) => r.class_id === null || reviewIds.has(r.class_id));
    const body = html`${head}${notes.length ? html`<div class="stack mb-6">${notes}</div>` : ''}
      <div class="grid-2"><div>
        <section class="section" id="versionen" aria-labelledby="h-versionen">${sectionHead('Versionen', { id: 'h-versionen', sub: 'Die Versionen, die in deine Klassen eingereicht oder dort freigegeben wurden.' })}
          ${versions.length ? list(versions.map(versionRow)) : empty({ icon: 'layers', title: 'Keine Version für dich', text: 'Sobald eine Version in deine Klasse eingereicht wird, steht sie hier.' })}</section>
        <section class="section" id="verlauf" aria-labelledby="h-verlauf">${sectionHead('Verlauf', { id: 'h-verlauf' })}
          ${visible.length ? V.historyTimeline(req, visible, { canDelete: (r) => r.kind === 'comment' && r.author_id === user.id, deleteAction: (r) => `/apps/${a.id}/kommentare/${r.id}/loeschen` }) : empty({ icon: 'message', title: 'Noch kein Verlauf' })}
          ${V.commentForm(req, `/apps/${a.id}/kommentare`, { hint: `${owner ? owner.name : 'Die Besitzerin oder der Besitzer'} liest mit.` })}</section>
      </div><div>
        <section class="section" id="klassen" aria-labelledby="h-klassen">${sectionHead('Deine Klassen', { id: 'h-klassen' })}
          ${list(mine.map(classLine))}</section>
      </div></div>`;
    return page(req, { title: a.name, body, active: 'klassen', styles: ['css/apps.css'] });
  }

  // ================================================================ changes

  app.post('/apps/:id/bearbeiten', (req, res) => {
    const a = manageApp(req);
    const f = services.appFields(req.body);
    // Forms without these fields (older clients) leave them as they are.
    const cat = Object.hasOwn(req.body, 'category') || Object.hasOwn(req.body, 'grade_min') ? catalogFields(req.body) : { category: a.category, gradeMin: a.grade_min, gradeMax: a.grade_max };
    // Only staff owners may share with colleagues (students' apps always go through review).
    const shared = access.canShareApp(req.user, a) && req.body.shared_field === '1' ? (req.body.shared === '1' ? 1 : 0) : a.shared;
    db.run(
      'UPDATE apps SET name = ?, description = ?, emoji = ?, color = ?, category = ?, grade_min = ?, grade_max = ?, shared = ?, updated_at = ? WHERE id = ?',
      f.name, f.description, f.emoji, f.color, cat.category, cat.gradeMin, cat.gradeMax, shared, Date.now(), a.id
    );
    if (shared !== a.shared) services.audit(req.user, shared ? 'app_geteilt' : 'app_nicht_mehr_geteilt', f.name);
    flash(req, shared !== a.shared ? (shared ? 'Gespeichert. Kolleg/innen können die App jetzt finden.' : 'Gespeichert. Die App ist nicht mehr mit Kolleg/innen geteilt.') : 'Gespeichert.');
    res.redirect(303, `/apps/${a.id}#einstellungen`);
  });

  app.post('/apps/:id/loeschen', (req, res) => {
    const a = manageApp(req);
    services.deleteApp(req.user, a);
    flash(req, `„${a.name}“ wurde gelöscht.`);
    res.redirect(303, '/apps');
  });

  // ---------- uploading a version ----------
  // Folder upload: start -> one request per file -> finish. Zip upload: one request.
  // Both end in uploads.addFile(), which validates every single file. A failed
  // or cancelled folder upload is removed by the client through "abbrechen".

  app.post('/apps/:id/versionen', (req, res) => {
    const a = manageApp(req);
    limiter.guard('uploadVersions', req.user.id);
    const v = services.createVersion(a);
    res.json({ id: v.id, number: v.number });
  });

  app.put('/apps/:id/versionen/:vid/datei', express.raw({ type: 'application/octet-stream', limit: L.maxFileBytes }), (req, res) => {
    const a = manageApp(req);
    limiter.guard('uploadFiles', req.user.id);
    const v = getVersion(a, req.params.vid, 'uploading');
    if (!req.is('application/octet-stream')) throw new HttpError(415, 'Falsches Format.');
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const added = uploads.addFile(v, a.owner_id, req.query.pfad, data);
    res.json({ ok: true, skipped: !added });
  });

  app.post('/apps/:id/versionen/:vid/fertig', (req, res) => {
    const a = manageApp(req);
    const v = getVersion(a, req.params.vid, 'uploading');
    const note = cleanText(req.body && req.body.notiz, 500, { multiline: true });
    if (note) db.run('UPDATE app_versions SET note = ? WHERE id = ?', note, v.id);
    const report = services.finishVersion(req.user, a, v);
    res.json({ ok: true, id: v.id, number: v.number, report });
  });

  /** Throw away an unfinished upload (cancelled or failed). Never touches a finished version. */
  app.post('/apps/:id/versionen/:vid/abbrechen', (req, res) => {
    const a = manageApp(req);
    const v = db.get("SELECT * FROM app_versions WHERE id = ? AND app_id = ? AND status = 'uploading'", String(req.params.vid), a.id);
    if (!v) throw deny();
    services.deleteVersion(null, a, v);
    services.audit(req.user, 'upload_abgebrochen', a.name, `Version ${v.number}`);
    res.json({ ok: true });
  });

  app.post('/apps/:id/versionen/zip', async (req, res) => {
    const a = manageApp(req);
    limiter.guard('uploadVersions', req.user.id);
    if (!req.is('application/zip') && !req.is('application/octet-stream')) throw new HttpError(415, 'Bitte lade eine ZIP-Datei hoch.');
    if (Number(req.headers['content-length']) > L.maxZipBytes) throw new HttpError(413, `Das Archiv ist zu groß (maximal ${Math.round(L.maxZipBytes / 1048576)} MB).`);
    const note = cleanText(str(req.query.notiz), 500, { multiline: true });
    const file = await uploads.receiveToTemp(req, L.maxZipBytes);
    let v = null;
    let report;
    try {
      v = services.createVersion(a);
      if (note) db.run('UPDATE app_versions SET note = ? WHERE id = ?', note, v.id);
      await uploads.addZip(v, a.owner_id, file);
      report = services.finishVersion(req.user, a, v);
    } catch (err) {
      // Nothing of a refused upload is kept.
      if (v && db.get('SELECT 1 AS x FROM app_versions WHERE id = ?', v.id)) services.deleteVersion(null, a, v);
      if (err instanceof HttpError) services.audit(req.user, 'upload_abgelehnt', a.name, err.message);
      throw err;
    } finally {
      fs.rm(file, { force: true }, () => {});
    }
    res.json({ id: v.id, number: v.number, report });
  });

  app.post('/apps/:id/versionen/:vid/loeschen', (req, res) => {
    const a = manageApp(req);
    const v = db.get('SELECT * FROM app_versions WHERE id = ? AND app_id = ?', String(req.params.vid), a.id);
    if (!v) throw deny();
    const inUse = a.published_version_id === v.id || a.schoolwide_version_id === v.id || a.schoolwide_requested_version_id === v.id ||
      db.get('SELECT 1 AS x FROM class_apps WHERE app_id = ? AND (version_id = ? OR requested_version_id = ?)', a.id, v.id, v.id);
    if (inUse) throw bad('Diese Version ist veröffentlicht oder wird in einer Klasse verwendet und kann deshalb nicht gelöscht werden.');
    services.deleteVersion(req.user, a, v);
    flash(req, `Version ${v.number} wurde gelöscht.`);
    res.redirect(303, `/apps/${a.id}#versionen`);
  });

  app.post('/apps/:id/veroeffentlichen', (req, res) => {
    const a = manageApp(req);
    const v = getVersion(a, req.body.version);
    const plan = publishPlan(req.user, a, v.id);
    services.publish(req.user, a, v);
    const tail = [];
    if (plan.now.length) tail.push(`In ${names(plan.now)} gilt sie sofort.`);
    if (plan.wait.length) tail.push(`In ${names(plan.wait)} wartet sie auf die Lehrkraft.`);
    if (plan.schoolwide === 'wait') tail.push('Für die ganze Schule wartet sie auf die Verwaltung.');
    flash(req, `Version ${v.number} ist veröffentlicht.${tail.length ? ` ${tail.join(' ')}` : ''}`);
    res.redirect(303, `/apps/${a.id}`);
  });

  // ---------- the app in classes (owner) ----------
  /** The owner's app and one class it is in (or may go into). */
  function ownerClass(req) {
    const a = manageApp(req);
    if (a.owner_id !== req.user.id) throw deny();
    const cls = getClass(req.body.klasse);
    if (!cls) throw deny();
    return { a, cls };
  }

  /** Owner brings the app into one of their classes (same rules as on the class page). */
  app.post('/apps/:id/einreichen', (req, res) => {
    const { a, cls } = ownerClass(req);
    const mode = access.addToClassMode(req.user, a, cls.id);
    if (!mode) throw deny();
    // First time, or again after the teacher gave it back: the same rules either way.
    const result = ctx.classApps.add(req.user, cls, a, mode);
    flash(req, result === 'approved' ? `„${a.name}“ ist jetzt in der Klasse „${cls.name}“.` : `„${a.name}“ ist in ${cls.name} eingereicht. Deine Lehrkraft schaut sie sich an.`);
    res.redirect(303, `/apps/${a.id}#klassen`);
  });

  /** Owner takes back a waiting or returned request; an approved version stays in the class. */
  app.post('/apps/:id/zurueckziehen', (req, res) => {
    const { a, cls } = ownerClass(req);
    const row = ctx.classApps.get(cls.id, a.id);
    if (!row || !row.requested_version_id || access.isArchived(cls.id)) throw deny();
    ctx.classApps.withdraw(req.user, cls, a);
    flash(req, `Die Einreichung in ${cls.name} ist zurückgezogen.`);
    res.redirect(303, `/apps/${a.id}#klassen`);
  });

  /** Owner takes the app out of a class; results stay readable for the class's teachers. */
  app.post('/apps/:id/aus-klasse', (req, res) => {
    const { a, cls } = ownerClass(req);
    const row = ctx.classApps.get(cls.id, a.id);
    if (!row || row.status === 'removed' || access.isArchived(cls.id)) throw deny();
    ctx.classApps.remove(req.user, cls, a);
    flash(req, `„${a.name}“ ist nicht mehr in ${cls.name}.`);
    res.redirect(303, `/apps/${a.id}#klassen`);
  });

  // ---------- school-wide release (admin only) ----------
  app.post('/apps/:id/schulweit', (req, res) => {
    const a = getApp(req.params.id);
    if (!a || !access.isAdmin(req.user)) throw deny();
    const owner = a.owner_id;
    if (typeof req.body.update === 'string' || typeof req.body.verwerfen === 'string') {
      // Decide on a waiting school-wide update - bound to the exact version that waits.
      const vid = str(req.body.update) || str(req.body.verwerfen);
      if (!a.schoolwide_version_id || !vid || a.schoolwide_requested_version_id !== vid) throw bad('Dieses Update steht nicht (mehr) zur Freigabe. Bitte lade die Seite neu.');
      const v = getVersion(a, vid);
      if (typeof req.body.update === 'string') {
        db.run('UPDATE apps SET schoolwide_version_id = ?, schoolwide_requested_version_id = NULL WHERE id = ? AND schoolwide_requested_version_id = ?', v.id, a.id, v.id);
        services.audit(req.user, 'schulweit_aktualisiert', a.name, `Version ${v.number}`);
        if (owner !== req.user.id) services.notify([owner], 'freigegeben', `Version ${v.number} von „${a.name}“ ist jetzt für die ganze Schule freigegeben.`, `/apps/${a.id}`);
        flash(req, `Version ${v.number} gilt jetzt für die ganze Schule.`);
      } else {
        db.run('UPDATE apps SET schoolwide_requested_version_id = NULL WHERE id = ? AND schoolwide_requested_version_id = ?', a.id, v.id);
        services.audit(req.user, 'schulweit_update_abgelehnt', a.name, `Version ${v.number}`);
        if (owner !== req.user.id) services.notify([owner], 'zurueckgegeben', `Version ${v.number} von „${a.name}“ wurde nicht schulweit freigegeben. Die Schule behält die bisherige Version.`, `/apps/${a.id}`);
        flash(req, `Version ${v.number} wird nicht schulweit freigegeben.`);
      }
      return res.redirect(303, `/apps/${a.id}`);
    }
    const on = req.body.an === '1';
    if (on && !a.published_version_id) throw bad('Diese App ist noch nicht veröffentlicht.');
    db.run('UPDATE apps SET schoolwide_version_id = ?, schoolwide_requested_version_id = NULL WHERE id = ?', on ? a.published_version_id : null, a.id);
    services.audit(req.user, on ? 'schulweit_freigegeben' : 'schulweit_beendet', a.name);
    flash(req, on ? `„${a.name}“ ist jetzt für die ganze Schule freigegeben.` : `„${a.name}“ ist nicht mehr schulweit freigegeben.`);
    res.redirect(303, `/apps/${a.id}`);
  });

  // ================================================================= source

  /** Folders as a tree: { dirs: Map(name -> node), files: [] }. */
  function fileTree(files) {
    const root = { name: '', path: '', dirs: new Map(), files: [] };
    for (const f of files) {
      const parts = f.path.split('/');
      let node = root;
      for (const d of parts.slice(0, -1)) {
        if (!node.dirs.has(d)) node.dirs.set(d, { name: d, path: node.path ? `${node.path}/${d}` : d, dirs: new Map(), files: [] });
        node = node.dirs.get(d);
      }
      node.files.push({ ...f, name: parts[parts.length - 1] });
    }
    return root;
  }

  app.get('/apps/:id/versionen/:vid/quelltext', (req, res) => {
    const a = reviewApp(req);
    const v = inspectVersion(req, a);
    const user = req.user;
    const manage = access.canManageApp(user, a);
    const files = uploads.listFiles(v.id);
    const wanted = typeof req.query.datei === 'string' ? req.query.datei : 'index.html';
    const file = files.find((f) => f.path === wanted); // exact match against the database, never a disk path
    const report = V.parseReport(v);
    const counts = V.reportCounts(report);
    const fileHref = (p) => `/apps/${a.id}/versionen/${v.id}/quelltext?datei=${encodeURIComponent(p)}`;
    const openAll = files.length <= 40;

    const treeView = (node, depth = 0) => html`<ul class="apps-tree${depth ? ' apps-subtree' : ''}" role="list">${[...node.dirs.values()].map((d) => html`<li><details${openAll || (file && file.path.startsWith(`${d.path}/`)) ? raw(' open') : ''}>
        <summary class="apps-folder">${icon('folder', { cls: 'sm' })}<span>${d.name}</span></summary>${treeView(d, depth + 1)}</details></li>`)}${node.files.map((f) => {
        const hub = isHubFile(f.path);
        const text = uploads.isTextFile(f.path);
        const current = file && f.path === file.path;
        return html`<li>${text || hub
          ? html`<a class="apps-file" href="${fileHref(f.path)}"${current ? raw(' aria-current="page"') : ''}>${icon('fileCode', { cls: 'sm' })}<span class="apps-fname">${f.name}</span>${hub ? badge('Hub') : html`<small>${formatBytes(f.size)}</small>`}</a>`
          : html`<span class="apps-file apps-file-bin">${icon('file', { cls: 'sm' })}<span class="apps-fname">${f.name}</span><small>${formatBytes(f.size)}</small></span>`}</li>`;
      })}</ul>`;

    let view;
    let lines = 0;
    if (!file) view = notice({ icon: 'search', text: `Die Datei „${wanted.slice(0, 200)}“ gibt es in Version ${v.number} nicht. Wähle eine Datei aus der Liste.` });
    else if (isHubFile(file.path)) view = notice({ icon: 'lock', title: 'Standard-Datei des Hubs', text: 'Diese Datei stellt der Hub selbst bereit, in seiner aktuellen Fassung. Was unter diesem Namen hochgeladen wurde, wird nie ausgeliefert – deshalb wird es hier auch nicht gezeigt.' });
    else if (!uploads.isTextFile(file.path)) view = notice({ icon: 'file', text: `Diese Datei ist keine Textdatei (${formatBytes(file.size)}). Lade die Version herunter, um sie anzusehen.` });
    else if (file.size > VIEW_MAX) view = notice({ icon: 'file', text: `Diese Datei ist zu groß für die Ansicht (${formatBytes(file.size)}). Lade die Version herunter, um sie zu lesen.` });
    else {
      // Shown as escaped plain text inside <pre>. It is never rendered or run. Line numbers are CSS counters.
      const text = uploads.readBlob(file.sha256).toString('utf8').split('\n');
      if (text.length > 1 && text[text.length - 1] === '') text.pop();
      lines = text.length;
      view = html`<pre class="apps-code" tabindex="0" aria-label="Inhalt von ${file.path}"><code>${text.map((l, i) => html`<span class="apps-line" id="L${i + 1}">${l.endsWith('\r') ? l.slice(0, -1) : l}</span>`)}</code></pre>`;
    }
    const back = manage ? (a.owner_id === user.id ? ['/apps', 'Meine Apps'] : ['/admin/apps', 'Alle Apps']) : ['/pruefen', 'Prüfen'];
    const body = html`${pageHead({
      crumbs: [back, [`/apps/${a.id}`, a.name]],
      eyebrow: `Version ${v.number}`,
      title: 'Quelltext',
      meta: html`<span>${formatDate(v.created_at)}</span><span>${plural(files.length, 'Datei', 'Dateien')} · ${formatBytes(v.total_bytes)}</span>${a.published_version_id === v.id && manage ? badge('veröffentlicht', 'ok') : ''}`,
      actions: html`${linkButton(`/apps/${a.id}/spielen?version=${v.id}`, 'Vorschau', { icon: 'eye' })}${linkButton(`/apps/${a.id}/versionen/${v.id}/download`, 'Als ZIP herunterladen', { kind: 'quiet', icon: 'download' })}`,
    })}
    ${v.note ? html`<p class="apps-vnote"><span class="eyebrow">Was ist neu</span><span class="pre">${v.note}</span></p>` : ''}
    <details class="disclosure apps-reportbox" id="pruefbericht"${counts.error || counts.warning ? raw(' open') : ''}>
      <summary><strong>Prüfbericht</strong>${V.reportBadges(report)}</summary>
      <div class="disclosure-body">${V.reportList(report, { href: (it) => `${fileHref(it.file)}${it.line ? `#L${it.line}` : ''}` })}</div></details>
    <div class="apps-src">
      <details class="apps-srcfiles"><summary class="apps-srcsum">${icon('folder', { cls: 'sm' })}<span>Dateien</span><span class="apps-srccur">${files.length}${file ? ` · ${file.path}` : ''}</span></summary>
        <nav aria-label="Dateien von Version ${v.number}">${treeView(fileTree(files))}</nav></details>
      <div class="apps-srcview">
        ${file ? html`<div class="apps-filehead"><code>${file.path}</code><span class="meta">${formatBytes(file.size)}${lines ? ` · ${plural(lines, 'Zeile', 'Zeilen')}` : ''}</span></div>` : ''}
        ${view}
      </div>
    </div>`;
    res.send(page(req, { title: `Quelltext ${a.name}`, body, active: manage ? (a.owner_id === user.id ? 'bauen' : 'admin') : 'klassen', styles: ['css/apps.css'] }));
  });

  app.get('/apps/:id/versionen/:vid/download', (req, res) => {
    const a = reviewApp(req);
    const v = inspectVersion(req, a);
    res.setHeader('Content-Type', 'application/zip');
    // Fixed, harmless file name; always a download, never shown inside the Hub.
    res.setHeader('Content-Disposition', `attachment; filename="app-version-${v.number}.zip"`);
    return uploads.writeZip(res, uploads.listFiles(v.id));
  });

  // =============================================================== comments

  app.post('/apps/:id/kommentare', (req, res) => {
    const a = reviewApp(req);
    const text = cleanText(req.body.text, 2000, { multiline: true });
    if (!text) throw bad('Der Kommentar ist leer.');
    if (db.get('SELECT COUNT(*) AS n FROM comments WHERE app_id = ?', a.id).n >= L.commentsPerApp) throw bad('Hier gibt es schon sehr viele Kommentare.');
    db.run("INSERT INTO comments (id, app_id, author_id, body, created_at, kind) VALUES (?, ?, ?, ?, ?, 'comment')", newId(), a.id, req.user.id, text, Date.now());
    // Tell the other side: the owner when someone else writes; the reviewing teachers when the owner writes.
    if (a.owner_id !== req.user.id) {
      services.notify([a.owner_id], 'kommentar', `${req.user.name} hat „${a.name}“ kommentiert.`, `/apps/${a.id}#verlauf`);
    } else {
      const teachers = db.all(
        `SELECT DISTINCT m.user_id FROM class_apps ca JOIN classes c ON c.id = ca.class_id AND c.archived_at IS NULL
           JOIN class_members m ON m.class_id = ca.class_id AND m.role = 'teacher'
          WHERE ca.app_id = ? AND ca.request_state IS NOT NULL`,
        a.id
      ).map((r) => r.user_id);
      services.notify(teachers, 'kommentar', `${req.user.name} hat „${a.name}“ kommentiert.`, `/apps/${a.id}#verlauf`);
    }
    flash(req, 'Kommentar gesendet.');
    res.redirect(303, `/apps/${a.id}#verlauf`);
  });

  app.post('/apps/:id/kommentare/:cid/loeschen', (req, res) => {
    const a = reviewApp(req);
    const c = db.get("SELECT * FROM comments WHERE id = ? AND app_id = ? AND kind = 'comment'", String(req.params.cid), a.id);
    if (!c || !(c.author_id === req.user.id || access.isAdmin(req.user))) throw deny();
    db.run('DELETE FROM comments WHERE id = ?', c.id);
    services.audit(req.user, 'kommentar_geloescht', a.name);
    flash(req, 'Kommentar gelöscht.');
    res.redirect(303, `/apps/${a.id}#verlauf`);
  });

  // The player (/apps/:id/spielen) and the SDK token route live in routes/player.js.
};

module.exports.BAUEN_TABS = BAUEN_TABS;
