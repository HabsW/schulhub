'use strict';
// Review (package B): the queue of waiting submissions in my classes, the
// review workbench (live preview next to "what is new", the check report, the
// diff to the version approved before, what the app declares and stores, the
// history) and the decision.
//
// Permission for the workbench and its forms: access.reviewRequest - the user
// may change the class (teacher or admin, class not archived) and the app's
// request there is waiting (or was returned: then read-only). Everything else
// answers 404. Decisions go through ctx.classApps, bound to the exact version.

const { html, page, flash, csrfField, linkButton, icon, appIcon, appClass, pageHead, list, row, empty, notice, field } = require('../html');
const { deny, bad, cleanText, formatAgo, formatDate, formatBytes, plural, newId } = require('../util');
const { manifestOf } = require('../manifest');
const { diffVersions } = require('../versionDiff');
const V = require('../appViews');

// Exactly like the player (routes/player.js): scripts and the app's own origin, no top navigation, no popups.
const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-modals allow-pointer-lock';
const str = (v) => (typeof v === 'string' ? v : '');

module.exports = (app, ctx) => {
  const { db, config, access, uploads, tokens, services } = ctx;
  const L = config.limits;

  /**
   * Waiting requests in the classes this user teaches (active classes only),
   * oldest first. Never anything from other classes.
   */
  function queue(user, limit) {
    return db.all(
      `SELECT ca.class_id, ca.app_id, ca.version_id, ca.requested_version_id,
              COALESCE((SELECT MAX(cm.created_at) FROM comments cm
                         WHERE cm.app_id = ca.app_id AND cm.class_id = ca.class_id AND cm.kind = 'submitted'), ca.created_at) AS since,
              a.name, a.emoji, a.color, u.name AS owner_name, c.name AS class_name,
              v.number AS version_number, v.note, v.report
         FROM class_apps ca
         JOIN classes c ON c.id = ca.class_id AND c.archived_at IS NULL
         JOIN class_members m ON m.class_id = ca.class_id AND m.user_id = ? AND m.role = 'teacher'
         JOIN apps a ON a.id = ca.app_id
         JOIN users u ON u.id = a.owner_id
         JOIN app_versions v ON v.id = ca.requested_version_id AND v.status = 'ready'
        WHERE ca.request_state = 'waiting'
        ORDER BY since, a.name COLLATE NOCASE
        LIMIT ?`,
      user.id, limit
    );
  }
  /** The queue without one item (the one just decided or shown). */
  const others = (user, classId, appId, limit = 101) => queue(user, limit + 1).filter((q) => !(q.class_id === classId && q.app_id === appId)).slice(0, limit);

  /** Load the request for the workbench, or 404. */
  function loadReview(req) {
    const classId = str(req.params.classId);
    const appId = str(req.params.appId);
    const request = access.reviewRequest(req.user, classId, appId);
    if (!request) throw deny();
    const a = db.get('SELECT * FROM apps WHERE id = ?', appId);
    const cls = db.get('SELECT * FROM classes WHERE id = ?', classId);
    const version = db.get("SELECT * FROM app_versions WHERE id = ? AND app_id = ? AND status = 'ready'", request.requested_version_id, appId);
    if (!a || !cls || !version || !access.canSeeVersion(req.user, a, version.id)) throw deny();
    return { a, cls, request, version, readOnly: request.request_state !== 'waiting' };
  }

  /** Did the last form on this page come back with an error for this field? (keeps a sheet open) */
  const kept = (req, name) => Boolean(req.session && req.session.formState && req.session.formState.path === req.path && Object.hasOwn(req.session.formState.fields, name));

  // ------------------------------------------------------------------ queue
  app.get('/pruefen', (req, res) => {
    if (!access.isStaff(req.user)) throw deny();
    const items = queue(req.user, 101);
    const shown = items.slice(0, 100);
    const body = html`${pageHead({
      title: 'Prüfen',
      lead: 'Apps aus deinen Klassen, die auf deine Freigabe warten – die älteste zuerst. Im Prüfplatz siehst du die App, den Prüfbericht und die Änderungen nebeneinander.',
      meta: shown.length ? html`<span>${plural(shown.length, 'App wartet', 'Apps warten')}${items.length > 100 ? ' (die ersten 100)' : ''}</span>` : '',
      actions: shown.length ? linkButton(`/pruefen/${shown[0].class_id}/${shown[0].app_id}`, 'Mit der ältesten beginnen', { kind: 'primary', icon: 'arrowRight' }) : '',
    })}
    ${shown.length
      ? list(shown.map((q) => row({
        href: `/pruefen/${q.class_id}/${q.app_id}`,
        start: appIcon(q),
        title: q.name,
        cls: 'wrap',
        sub: html`<span>von ${q.owner_name} · ${q.class_name} · Version ${q.version_number}${q.version_id ? ' (Update)' : ' (neu)'} · eingereicht ${formatAgo(q.since)}</span>${q.note ? html`<span class="apps-note">${q.note}</span>` : ''}`,
        end: V.reportBadges(V.parseReport(q)),
      })))
      : empty({ icon: 'checkCircle', title: 'Alles geprüft', text: 'Wenn jemand eine App in eine deiner Klassen einreicht oder eine neue Version veröffentlicht, steht sie hier.', actions: linkButton('/klassen', 'Zu deinen Klassen') })}`;
    res.send(page(req, { title: 'Prüfen', body, active: 'klassen', styles: ['css/apps.css', 'css/review.css'] }));
  });

  // -------------------------------------------------------------- workbench
  app.get('/pruefen/:classId/:appId', (req, res) => {
    const { a, cls, request, version, readOnly } = loadReview(req);
    const user = req.user;
    const owner = (db.get('SELECT name FROM users WHERE id = ?', a.owner_id) || {}).name || 'Gelöschtes Konto';
    const submittedAt = db.get("SELECT MAX(created_at) AS at FROM comments WHERE app_id = ? AND class_id = ? AND kind = 'submitted' AND version_id = ?", a.id, cls.id, version.id).at || request.created_at;
    const rest = others(user, cls.id, a.id);
    const next = rest[0] || null;

    // The version approved in this class before - the diff compares against it. Both must be visible.
    const base = request.version_id && request.version_id !== version.id
      ? db.get("SELECT * FROM app_versions WHERE id = ? AND app_id = ? AND status = 'ready'", request.version_id, a.id) : null;
    const baseVisible = Boolean(base) && access.canSeeVersion(user, a, base.id);
    const diff = baseVisible ? diffVersions(uploads, base.id, version.id) : null;
    const report = V.parseReport(version);
    const sourceHref = (p) => `/apps/${a.id}/versionen/${version.id}/quelltext?datei=${encodeURIComponent(p)}`;
    const fileLink = (p) => `${sourceHref(p)}#datei`; // opens the source viewer at the code

    // ----- preview: embedded exactly like the player -----
    const fileToken = tokens.sign('files', { a: a.id, v: version.id, u: req.user.id }, config.fileTokenSeconds);
    const origin = config.appOrigin(a.origin_key);
    const preview = html`<section class="review-preview" aria-label="Vorschau von Version ${version.number}">
      <div class="review-toolbar">
        <div class="review-devices" role="group" aria-label="Bildschirmbreite der Vorschau">
          <button type="button" class="btn quiet sm review-devbtn" data-device="phone" aria-pressed="false" title="So breit wie ein Handy (390 Pixel)">${icon('smartphone')}<span>Handy</span><small class="review-devw" aria-hidden="true">390</small></button>
          <button type="button" class="btn quiet sm review-devbtn" data-device="tablet" aria-pressed="false" title="So breit wie ein Tablet (820 Pixel)">${icon('tablet')}<span>Tablet</span><small class="review-devw" aria-hidden="true">820</small></button>
          <button type="button" class="btn quiet sm review-devbtn" data-device="full" aria-pressed="true" title="So breit wie diese Spalte">${icon('monitor')}<span>Voll</span><small class="review-devw" id="review-fitw" aria-hidden="true"></small></button>
        </div>
        <div class="review-tools">
          <button class="btn quiet sm" type="button" id="console-toggle" aria-controls="console" aria-expanded="false">${icon('terminal')}<span>Konsole</span><span class="count wait" id="console-count" hidden>0</span></button>
          <button class="btn quiet sm icon" type="button" data-reload-app aria-label="App neu laden" title="App neu laden">${icon('refresh')}</button>
          <button class="btn quiet sm icon" type="button" id="fullscreen" aria-label="Vollbild" title="Vollbild">${icon('maximize')}</button>
        </div>
      </div>
      <div class="review-viewport">
        <div class="review-device review-device-full" id="review-device">
          <div class="stage review-stage" id="stage" data-origin="${origin}" data-token-url="/apps/${a.id}/token" data-class="${cls.id}" data-version="${version.id}" data-draft="">
            <iframe id="appframe" title="${a.name} – Vorschau" src="${origin}/~${fileToken}/index.html" sandbox="${SANDBOX}" allow="fullscreen; autoplay; gamepad" referrerpolicy="no-referrer"></iframe>
            <div class="loading ${appClass(a)}" aria-hidden="true">${appIcon(a, 'lg')}</div>
            <section class="console" id="console" aria-label="Konsole" hidden>
              <div class="console-head"><strong>Konsole</strong><span>Meldungen der App (nur in der Vorschau)</span>
                <button class="btn quiet sm" type="button" id="console-clear">Leeren</button></div>
              <ol class="console-log" id="console-log" aria-live="polite"></ol></section>
            <div id="player-note" class="overlay" hidden>
              <strong>Deine Sitzung ist abgelaufen.</strong>
              <p class="muted">Melde dich neu an – danach geht es hier weiter.</p>
              <a class="btn primary" href="/pruefen/${cls.id}/${a.id}">Neu anmelden</a></div>
          </div>
        </div>
      </div>
      <p class="review-hint">${icon('info', { cls: 'sm' })}<span>Vorschau von Version ${version.number}: Was du hier ausprobierst, wird nicht gespeichert.<span class="review-scale" id="review-scale" aria-live="polite"></span></span></p>
    </section>`;

    // ----- what is new -----
    let changes;
    if (diff) {
      const t = diff.totals;
      const parts = [];
      if (t.changedFiles) parts.push(plural(t.changedFiles, 'Datei geändert', 'Dateien geändert'));
      if (t.addedFiles) parts.push(plural(t.addedFiles, 'neue Datei', 'neue Dateien'));
      if (t.removedFiles) parts.push(plural(t.removedFiles, 'Datei entfernt', 'Dateien entfernt'));
      changes = parts.length ? html`${parts.join(', ')} <span class="review-count"><span class="review-plus">+${t.added}</span><span class="review-minus">−${t.removed}</span></span>` : 'keine Änderungen an den Dateien';
    } else changes = `${plural(version.file_count, 'Datei', 'Dateien')}, ${formatBytes(version.total_bytes)}`;
    const whatsNew = html`<section class="review-block" aria-labelledby="h-neu">
      <h2 id="h-neu">Was ist neu</h2>
      ${version.note ? html`<p class="review-quote pre">${version.note}</p>` : html`<p class="meta">Zu dieser Version gibt es keine Notiz.</p>`}
      <dl class="kv review-facts">
        <div><dt>Bisher freigegeben</dt><dd>${base ? `Version ${base.number} vom ${formatDate(base.created_at)}` : request.version_id === version.id ? 'Diese Version war hier schon freigegeben.' : 'Noch keine – erste Einreichung in dieser Klasse'}</dd></div>
        <div><dt>Eingereicht</dt><dd>${formatAgo(submittedAt)} von ${owner}</dd></div>
        <div><dt>${diff ? 'Änderungen' : 'Umfang'}</dt><dd>${changes}</dd></div>
      </dl>
    </section>`;

    const reportBlock = html`<section class="review-block" id="bericht" aria-labelledby="h-bericht">
      <div class="review-blockhead"><h2 id="h-bericht">Prüfbericht</h2>${V.reportBadges(report)}</div>
      ${V.reportList(report, { href: (it) => `${sourceHref(it.file)}${it.line ? `#L${it.line}` : '#datei'}` })}
    </section>`;

    const changesBlock = html`<section class="review-block" id="aenderungen" aria-labelledby="h-aenderungen">
      <div class="review-blockhead"><h2 id="h-aenderungen">${diff ? `Änderungen seit Version ${base.number}` : 'Dateien'}</h2>${diff && diff.unchanged ? html`<span class="meta">${plural(diff.unchanged, 'Datei', 'Dateien')} unverändert</span>` : ''}</div>
      ${diff ? V.diffView(diff, { sourceHref: fileLink })
        : html`<p class="meta mb-4">${base && !baseVisible ? 'Die bisher freigegebene Version kannst du nicht ansehen.'
          : request.version_id === version.id ? `Genau diese Version war in ${cls.name} schon freigegeben – es gibt nichts zu vergleichen.`
            : `Erste Einreichung in ${cls.name} – es gibt noch nichts zum Vergleichen.`} Diese Dateien gehören zur Version:</p>
          ${V.fileListView(uploads.listFiles(version.id), { sourceHref: fileLink, isText: uploads.isTextFile })}`}
    </section>`;

    const declaredBlock = html`<section class="review-block" aria-labelledby="h-erklaert">
      <h2 id="h-erklaert">Was die App erklärt und speichert</h2>
      ${V.declaredView(manifestOf(version), report)}
    </section>`;

    const hist = V.historyRows(db, a.id, 80);
    // The general conversation and this class's decisions - nothing about other classes.
    const visible = hist.rows.filter((r) => r.class_id === null || r.class_id === cls.id);
    const historyBlock = html`<section class="review-block" id="verlauf" aria-labelledby="h-verlauf">
      <h2 id="h-verlauf">Verlauf</h2>
      ${visible.length ? V.historyTimeline(req, visible, { canDelete: (r) => access.canDeleteComment(user, r), deleteAction: (r) => `/apps/${a.id}/kommentare/${r.id}/loeschen` }) : html`<p class="meta">Noch keine Einträge.</p>`}
      ${V.commentForm(req, `/pruefen/${cls.id}/${a.id}/kommentar`, { label: `Kommentar an ${owner}`, hint: 'Eine Frage oder ein Tipp, ohne schon zu entscheiden.' })}
    </section>`;

    // ----- the decision -----
    let top = '';
    if (readOnly) {
      const why = db.get("SELECT c.body, c.created_at, u.name FROM comments c LEFT JOIN users u ON u.id = c.author_id WHERE c.app_id = ? AND c.class_id = ? AND c.kind = 'returned' ORDER BY c.created_at DESC LIMIT 1", a.id, cls.id);
      top = notice({
        tone: 'danger', icon: 'undo',
        title: `Version ${version.number} wurde zurückgegeben${why ? ` – ${why.name || 'Lehrkraft'}, ${formatAgo(why.created_at)}` : ''}`,
        text: html`${why ? html`<span class="pre">„${why.body}“</span> ` : ''}Sobald ${owner} eine neue Version einreicht, kannst du hier wieder entscheiden.`,
        cls: 'mb-6',
      });
    }
    const decide = readOnly ? '' : html`<div class="review-decide" id="entscheiden">
      <p class="review-decide-what">Version ${version.number} <span class="meta">für</span> <strong>${cls.name}</strong></p>
      <div class="review-decide-actions">
        <details class="review-act"${kept(req, 'grund') ? html` open` : ''}>
          <summary class="btn danger review-act-btn">${icon('undo')}<span>Zurückgeben</span></summary>
          <form method="post" action="/pruefen/${cls.id}/${a.id}/zurueckgeben" class="review-sheet">${csrfField(req)}
            <input type="hidden" name="version" value="${version.id}">
            ${field(req, { label: 'Was fehlt noch?', name: 'grund', type: 'textarea', required: true, hint: `${owner} liest das und kann die App verbessern.`, attrs: 'minlength="3" maxlength="2000" rows="4"' })}
            <div class="actions"><button class="btn danger">${icon('undo')}<span>Version ${version.number} zurückgeben</span></button></div>
          </form>
        </details>
        <details class="review-act"${kept(req, 'notiz') ? html` open` : ''}>
          <summary class="btn primary review-act-btn">${icon('check')}<span>Freigeben</span></summary>
          <form method="post" action="/pruefen/${cls.id}/${a.id}/freigeben" class="review-sheet">${csrfField(req)}
            <input type="hidden" name="version" value="${version.id}">
            ${field(req, { label: 'Notiz (freiwillig)', name: 'notiz', type: 'textarea', hint: 'Zum Beispiel ein Lob. Sie steht im Verlauf.', attrs: 'maxlength="2000" rows="3"' })}
            <div class="actions"><button class="btn primary">${icon('check')}<span>Für ${cls.name} freigeben</span></button></div>
          </form>
        </details>
      </div>
    </div>`;

    const head = pageHead({
      crumbs: [['/pruefen', 'Prüfen'], [`/klassen/${cls.id}`, cls.name]],
      app: a,
      eyebrow: readOnly ? `Zurückgegeben · ${cls.name}` : `Prüfen · ${cls.name}`,
      title: a.name,
      meta: html`<span>von ${owner}</span><span>Version ${version.number}${request.version_id && !readOnly ? ' (Update)' : ''}</span><span>eingereicht ${formatAgo(submittedAt)}</span>${rest.length ? html`<span>${plural(rest.length, 'weitere App wartet', 'weitere Apps warten')}</span>` : ''}`,
      actions: html`${linkButton(`/apps/${a.id}/versionen/${version.id}/quelltext`, 'Quelltext', { kind: 'quiet', icon: 'fileCode' })}${next ? linkButton(`/pruefen/${next.class_id}/${next.app_id}`, 'Überspringen', { kind: 'quiet', icon: 'arrowRight' }) : ''}`,
    });

    // The decision bar opens the panel: from 1200px it stays at the top of the panel, next to the
    // preview's toolbar; below that it is fixed at the bottom of the screen (see review.css).
    const body = html`${head}${top}
      <div class="review-bench">
        ${preview}
        <div class="review-panel${readOnly ? '' : ' review-panel-decide'}">${decide}${whatsNew}${reportBlock}${changesBlock}${declaredBlock}${historyBlock}</div>
      </div>`;
    res.send(page(req, {
      title: `Prüfen: ${a.name}`, body, active: 'klassen', width: 'wide', classId: cls.id,
      styles: ['css/apps.css', 'css/review.css', 'css/frames.css'], scripts: ['player.js', 'review.js'],
    }));
  });

  // -------------------------------------------------------------- decisions
  /** After a decision: the next waiting app in MY classes, or the queue with "Alles geprüft". */
  function afterDecision(req, res, a, cls, text) {
    const next = others(req.user, cls.id, a.id, 1)[0];
    if (next) {
      flash(req, `${text} Weiter mit der nächsten App.`);
      return res.redirect(303, `/pruefen/${next.class_id}/${next.app_id}`);
    }
    flash(req, `${text} Alles geprüft!`);
    return res.redirect(303, '/pruefen');
  }

  app.post('/pruefen/:classId/:appId/freigeben', (req, res) => {
    const { a, cls } = loadReview(req);
    // Exactly the version that was reviewed (sent by the form, checked against the waiting request).
    ctx.classApps.approve(req.user, cls, a, str(req.body.version), req.body.notiz);
    afterDecision(req, res, a, cls, `„${a.name}“ ist für ${cls.name} freigegeben.`);
  });

  app.post('/pruefen/:classId/:appId/zurueckgeben', (req, res) => {
    const { a, cls } = loadReview(req);
    ctx.classApps.giveBack(req.user, cls, a, str(req.body.version), req.body.grund);
    afterDecision(req, res, a, cls, `„${a.name}“ ist zurückgegeben – mit deiner Begründung.`);
  });

  /** A comment from the workbench: tied to this class and version, visible to the owner and this class's teachers. */
  app.post('/pruefen/:classId/:appId/kommentar', (req, res) => {
    const { a, cls, version } = loadReview(req);
    const text = cleanText(req.body.text, 2000, { multiline: true });
    if (!text) throw bad('Der Kommentar ist leer.');
    if (db.get('SELECT COUNT(*) AS n FROM comments WHERE app_id = ?', a.id).n >= L.commentsPerApp) throw bad('Hier gibt es schon sehr viele Kommentare.');
    db.run(
      "INSERT INTO comments (id, app_id, author_id, body, created_at, kind, version_id, class_id) VALUES (?, ?, ?, ?, ?, 'comment', ?, ?)",
      newId(), a.id, req.user.id, text, Date.now(), version.id, cls.id
    );
    if (a.owner_id !== req.user.id) services.notify([a.owner_id], 'kommentar', `${req.user.name} hat „${a.name}“ kommentiert.`, `/apps/${a.id}#verlauf`, { subjectId: req.user.id });
    flash(req, 'Kommentar gesendet.');
    res.redirect(303, `/pruefen/${cls.id}/${a.id}#verlauf`);
  });
};
