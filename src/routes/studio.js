'use strict';
// Building (package C): the in-browser editor on an app's draft, its JSON
// file API, and the app templates (list, new app from a template, ZIP).
//
// Permissions: everything under /studio/:appId is for access.canManageApp
// (the owner, or the admin) and answers 404 to everybody else. The editor
// only ever writes the app's mutable draft; versions stay immutable and are
// made from the draft by services.versionFromDraft. Every file write goes
// through uploads.putDraftFile (path, type, size, file-count and quota
// checks). Draft code is shown as text inside CodeMirror and runs only on the
// app's own origin, in the sandboxed preview frame.

const express = require('express');
const {
  html, raw, page, flash, csrfField, postButton, linkButton, icon, appIcon, appClass, badge,
  pageHead, sectionHead, row, list, notice, empty, field,
} = require('../html');
const { deny, bad, HttpError, formatDate, formatBytes, plural } = require('../util');
const { normalizePath } = require('../uploads');
const { bauenTabs, TEMPLATES, templateById, zipEntries, appFromTemplate, draftFromTemplate } = require('../bauen');

// Same sandbox as the player (src/routes/player.js).
const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-modals allow-pointer-lock';
const PREVIEW_TOKEN_SECONDS = 3600;
const EDIT_MAX_BYTES = 1024 * 1024; // larger text files are not opened in the editor

module.exports = (app, ctx) => {
  const { db, config, access, services, uploads, limiter, tokens } = ctx;
  const L = config.limits;

  // ------------------------------------------------------------- helpers

  /** The app from the URL if this user may manage it (owner or admin), else 404. */
  function ownApp(req) {
    const a = db.get('SELECT * FROM apps WHERE id = ?', String(req.params.appId));
    if (!a || !access.canManageApp(req.user, a)) throw deny();
    return a;
  }
  const hasDraft = (a) => Boolean(db.get('SELECT 1 AS ok FROM app_drafts WHERE app_id = ?', a.id));
  /** ownApp + the draft must exist (the file API never creates a draft by accident). */
  function draftApp(req) {
    const a = ownApp(req);
    if (!hasDraft(a)) throw new HttpError(409, 'Es gibt gerade keinen Entwurf. Lade den Editor neu.');
    return a;
  }
  const pathParam = (v) => {
    if (typeof v !== 'string' || !v) throw bad('Bitte gib einen Dateinamen an.');
    return v;
  };
  const fileList = (a) => uploads.listDraftFiles(a.id).map((f) => ({ path: f.path, size: f.size, text: uploads.isTextFile(f.path) }));
  const previewSrc = (a, userId) => `${config.appOrigin(a.origin_key)}/~${tokens.sign('files', { a: a.id, d: 1, u: userId }, PREVIEW_TOKEN_SECONDS)}/index.html`;
  const nextVersion = (a) => db.get('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM app_versions WHERE app_id = ?', a.id).n;
  const templateRow = (tpl, end) =>
    row({
      title: tpl.name,
      start: appIcon(tpl, 'lg'),
      sub: html`${tpl.description}<span class="studio-tpl-meta">${tpl.category ? `${tpl.category} · ` : ''}${plural(tpl.files.length, 'Datei', 'Dateien')}</span>`,
      end,
      cls: 'wrap studio-tpl',
    });

  /** Nested file tree; folders first. The browser re-renders the same markup after changes (public/studio.js). */
  function treeHtml(files) {
    const rootNode = { dirs: new Map(), files: [] };
    for (const f of files) {
      const parts = f.path.split('/');
      let node = rootNode;
      for (const dir of parts.slice(0, -1)) {
        if (!node.dirs.has(dir)) node.dirs.set(dir, { dirs: new Map(), files: [] });
        node = node.dirs.get(dir);
      }
      node.files.push({ ...f, name: parts[parts.length - 1] });
    }
    const render = (node) => html`${[...node.dirs.entries()].map(([name, sub]) => html`<li class="studio-dir"><span class="studio-dir-name">${icon('folder', { cls: 'sm' })}<span>${name}</span></span><ul class="studio-tree studio-subtree" role="list">${render(sub)}</ul></li>`)}${node.files.map((f) => {
      const text = uploads.isTextFile(f.path);
      return html`<li><button type="button" class="studio-file" data-path="${f.path}" data-size="${f.size}" data-text="${text ? '1' : ''}">${icon(text ? 'fileCode' : 'file', { cls: 'sm' })}<span class="studio-file-label">${f.name}</span><span class="studio-dot" hidden><span class="visually-hidden">, nicht gespeichert</span></span></button></li>`;
    })}`;
    return render(rootNode);
  }

  // ------------------------------------------------------------ the editor

  function editorPage(req, a) {
    const files = uploads.listDraftFiles(a.id);
    // The player shell has no flash area: the message is shown here instead.
    const flashMsg = req.session.flash;
    const next = nextVersion(a);
    const origin = config.appOrigin(a.origin_key);
    const hasIndex = files.some((f) => f.path === 'index.html');

    const body = html`<header class="playerbar studio-bar ${appClass(a)}">
        <a class="btn quiet icon sm studio-tool" href="/apps/${a.id}" aria-label="Zurück zur App" title="Zurück zur App">${icon('arrowLeft')}</a>
        <button type="button" class="btn quiet icon sm studio-tool studio-tablet-only" data-studio-files aria-pressed="false" aria-controls="studio-files" aria-label="Dateien" title="Dateien">${icon('panelLeft')}</button>
        <span class="app-name studio-app">${appIcon(a, 'xs')}<span>${a.name}</span></span>
        <div class="studio-current">
          <details class="menu studio-file-menu" id="studio-file-menu" hidden>
            <summary class="studio-file-summary"><span class="studio-file-name" id="studio-file-name"></span><span class="visually-hidden"> – Datei umbenennen oder löschen</span>${icon('chevronDown', { cls: 'sm' })}</summary>
            <div class="menu-panel studio-file-panel">
              <button type="button" data-studio-rename>${icon('pencil')}Umbenennen oder verschieben</button>
              <button type="button" class="studio-menu-danger" data-studio-delete>${icon('trash')}Datei löschen</button>
            </div>
          </details>
          <span class="badge ok studio-state" id="studio-state" role="status"><span class="studio-state-short" aria-hidden="true">Gespeichert</span><span class="studio-state-text">Gespeichert</span></span>
        </div>
        <div class="studio-tools">
          <button class="btn quiet sm studio-tool studio-hide-phone" type="button" data-studio-reload aria-label="Vorschau neu laden" title="Vorschau neu laden">${icon('refresh')}<span class="studio-wide" aria-hidden="true">Vorschau neu laden</span></button>
          <button class="btn primary sm studio-tool" type="button" id="studio-save" aria-label="Speichern" aria-keyshortcuts="Control+S Meta+S" title="Speichern (Strg+S)">${icon('save')}<span class="studio-save-label" aria-hidden="true">Speichern</span></button>
          <button class="btn sm studio-tool studio-hide-phone" type="button" data-studio-version>${icon('layers')}<span class="studio-wide">Als Version speichern</span><span class="studio-narrow">Version</span></button>
          <details class="menu studio-more">
            <summary class="studio-more-btn" aria-label="Weitere Aktionen" title="Weitere Aktionen">${icon('more')}</summary>
            <div class="menu-panel">
              <button type="button" class="studio-phone-only" data-studio-version>${icon('layers')}Als Version speichern</button>
              <a href="/apps/${a.id}/spielen?entwurf=1" data-studio-leave>${icon('maximize')}Vorschau im Vollbild</a>
              <a href="/apps/${a.id}" data-studio-leave>${icon('settings')}Zur App-Seite</a>
              <a href="/entwickeln/sdk" data-studio-leave>${icon('book')}SDK-Referenz</a>
              <hr>
              ${postButton(req, `/studio/${a.id}/verwerfen`, 'Entwurf verwerfen', {
                cls: 'studio-menu-danger', icon: 'trash',
                confirm: 'Entwurf verwerfen?\nAlle Änderungen im Editor seit der letzten Version gehen verloren. Deine Versionen bleiben, wie sie sind.',
                confirmLabel: 'Entwurf verwerfen',
              })}
            </div>
          </details>
        </div>
      </header>

      <div class="studio" id="studio" data-app="${a.id}" data-view="code" data-files="closed" data-preview-url="/studio/${a.id}/vorschau">
        <div class="segmented studio-switch" role="radiogroup" aria-label="Ansicht">
          <label class="studio-seg-files">${icon('folder')}<span class="studio-seg-label">Dateien</span><input type="radio" name="studio-view" value="dateien"></label>
          <label>${icon('fileCode')}<span class="studio-seg-label">Code</span><input type="radio" name="studio-view" value="code" checked></label>
          <label>${icon('play')}<span class="studio-seg-label">Vorschau</span><span class="count wait studio-problems" id="studio-problems" hidden></span><input type="radio" name="studio-view" value="vorschau"></label>
        </div>

        <aside class="studio-files studio-pane-off" id="studio-files" aria-labelledby="studio-files-title">
          <div class="studio-head"><h2 id="studio-files-title">Dateien</h2><span class="studio-count" id="studio-file-count">${plural(files.length, 'Datei', 'Dateien')}</span></div>
          <div class="studio-file-actions">
            <button type="button" class="btn sm" data-studio-new>${icon('plus')}<span>Neue Datei</span></button>
            <label class="btn sm">${icon('upload')}<span>Hochladen</span><input type="file" class="file-input" id="studio-upload" multiple></label>
          </div>
          <nav class="studio-tree-wrap" aria-label="Dateien im Entwurf"><ul class="studio-tree" id="studio-tree" role="list">${treeHtml(files)}</ul>
            <p class="studio-tree-empty" id="studio-tree-empty"${files.length ? raw(' hidden') : ''}>Noch keine Dateien. Lege eine <code class="studio-nb">index.html</code> an.</p></nav>
          <p class="studio-hint">Bilder und Töne lädst du hoch und bindest sie im Code mit ihrem Namen ein, zum Beispiel <code class="studio-nb">bilder/held.png</code>. Verschieben: umbenennen.</p>
        </aside>

        <section class="studio-code" aria-label="Code">
          <div class="studio-editor" id="studio-editor"></div>
          <div class="studio-info" id="studio-info" hidden>
            <span class="studio-info-icon">${icon('file')}</span>
            <h2 class="studio-info-name" id="studio-info-name"></h2>
            <p class="muted" id="studio-info-meta"></p>
            <p id="studio-info-text"></p>
            <pre class="code studio-info-snippet" id="studio-info-snippet" hidden></pre>
            <div class="actions">
              <button type="button" class="btn sm" data-studio-rename>${icon('pencil')}<span>Umbenennen</span></button>
              <button type="button" class="btn danger sm" data-studio-delete>${icon('trash')}<span>Löschen</span></button>
            </div>
          </div>
          <div class="studio-blank" id="studio-blank" hidden>${empty({ icon: 'fileCode', title: 'Keine Datei geöffnet', text: 'Wähle links eine Datei aus oder lege eine neue an.' })}</div>
        </section>

        <section class="studio-preview studio-pane-off" aria-labelledby="studio-preview-title">
          <div class="studio-head">
            <h2 class="studio-preview-title" id="studio-preview-title">Vorschau</h2>
            ${badge('nichts wird gespeichert', 'wait')}
            <button class="btn quiet sm studio-console-btn" type="button" id="console-toggle" aria-controls="console" aria-expanded="false">${icon('terminal')}<span>Konsole</span><span class="count wait" id="console-count" hidden>0</span></button>
            <button class="btn quiet icon sm studio-phone-only" type="button" data-studio-reload aria-label="Vorschau neu laden" title="Vorschau neu laden">${icon('refresh')}</button>
          </div>
          <div class="stage studio-stage" id="stage" data-origin="${origin}" data-token-url="/apps/${a.id}/token" data-class="" data-version="" data-draft="1">
            <iframe id="appframe" title="Vorschau: ${a.name}" src="${previewSrc(a, req.user.id)}" sandbox="${SANDBOX}" allow="fullscreen; autoplay; gamepad" referrerpolicy="no-referrer"></iframe>
            <div class="loading ${appClass(a)}" aria-hidden="true">${appIcon(a, 'lg')}</div>
            <section class="console" id="console" aria-label="Konsole" hidden>
              <div class="console-head"><strong>Konsole</strong><span>Meldungen deiner App (nur in der Vorschau)</span>
                <button class="btn quiet sm" type="button" id="console-clear">Leeren</button></div>
              <ol class="console-log" id="console-log" aria-live="polite"></ol></section>
            <div id="player-note" class="overlay" hidden>
              <strong>Deine Sitzung ist abgelaufen.</strong>
              <p class="muted">Melde dich neu an – danach geht es hier weiter.</p>
              <a class="btn primary" href="/studio/${a.id}">Neu anmelden</a></div>
            <div class="overlay" id="studio-noindex"${hasIndex ? raw(' hidden') : ''}>
              <strong>Es gibt noch keine index.html.</strong>
              <p class="muted">Sie ist die Startseite deiner App. Lege sie an – dann erscheint hier die Vorschau.</p></div>
          </div>
        </section>
        <div class="studio-scrim" data-studio-close hidden></div>
      </div>

      <dialog class="confirm studio-dialog" id="studio-name-dialog" aria-labelledby="studio-name-title">
        <form method="dialog" id="studio-name-form" novalidate>
          <h2 id="studio-name-title">Neue Datei</h2>
          <div class="field"><label for="studio-name-input">Dateiname</label>
            <input id="studio-name-input" name="name" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="240" aria-describedby="studio-name-hint">
            <span class="hint" id="studio-name-hint">Zum Beispiel <code class="studio-nb">spiel.js</code> oder <code class="studio-nb">bilder/held.png</code> – Ordner trennst du mit /.</span>
            <span class="error-text" id="studio-name-error" role="alert" hidden></span></div>
          <div class="actions"><button type="button" class="btn quiet" data-studio-cancel>Abbrechen</button><button class="btn primary" id="studio-name-ok">Anlegen</button></div>
        </form>
      </dialog>

      <dialog class="confirm studio-dialog" id="studio-confirm-dialog" aria-labelledby="studio-confirm-title" aria-describedby="studio-confirm-text">
        <h2 id="studio-confirm-title"></h2>
        <p id="studio-confirm-text"></p>
        <div class="actions"><button type="button" class="btn quiet" data-studio-cancel>Abbrechen</button><button type="button" class="btn primary" id="studio-confirm-ok"></button></div>
      </dialog>

      <dialog class="confirm studio-dialog" id="studio-version-dialog" aria-labelledby="studio-version-title">
        <form method="post" action="/studio/${a.id}/version" id="studio-version-form">${csrfField(req)}
          <h2 id="studio-version-title">Als Version ${next} speichern</h2>
          <p>Der Entwurf wird zu Version ${next}. Versionen ändern sich danach nicht mehr. Veröffentlichen kannst du sie auf der App-Seite – erst dann sehen andere die Änderungen.</p>
          ${field(req, { label: 'Was ist neu? (freiwillig)', name: 'notiz', type: 'textarea', attrs: 'maxlength="500" rows="3"', id: 'studio-note' })}
          <div class="actions"><button type="button" class="btn quiet" data-studio-cancel>Abbrechen</button><button class="btn primary">Version ${next} speichern</button></div>
        </form>
      </dialog>

      <template id="studio-icons">${['fileCode', 'file', 'folder'].map((n) => html`<span data-icon="${n}">${icon(n, { cls: 'sm' })}</span>`)}${['checkCircle', 'alert'].map((n) => html`<span data-icon="${n}">${icon(n)}</span>`)}</template>
      <div class="studio-toasts" id="studio-toasts" aria-live="polite">${flashMsg ? notice({ tone: flashMsg.type === 'error' ? 'danger' : 'ok', text: flashMsg.text, role: flashMsg.type === 'error' ? 'alert' : 'status', cls: 'studio-toast' }) : ''}</div>`;

    return page(req, {
      title: `Editor · ${a.name}`,
      body,
      shell: 'player',
      styles: ['css/studio.css', 'css/frames.css'],
      // the small player first: the preview starts while the large editor bundle is still being parsed
      scripts: ['player.js', 'vendor/codemirror.js', 'studio.js'],
    });
  }

  // ------------------------------------------------- without a draft yet

  function startPage(req, a) {
    const versions = db.all("SELECT * FROM app_versions WHERE app_id = ? AND status = 'ready' ORDER BY number DESC", a.id);
    const preferred = versions.find((v) => v.id === a.published_version_id) || versions[0];
    const versionRow = (v) =>
      row({
        title: `Version ${v.number}`,
        start: html`<span class="tile sm app-7" aria-hidden="true">${icon('layers', { cls: 'sm' })}</span>`,
        sub: html`${formatDate(v.created_at)} · ${plural(v.file_count, 'Datei', 'Dateien')} · ${formatBytes(v.total_bytes)}${v.note ? html`<span class="studio-version-note">${v.note}</span>` : ''}`,
        end: html`${v.id === a.published_version_id ? badge('veröffentlicht', 'ok') : ''}${v === preferred ? '' : postButton(req, `/studio/${a.id}/entwurf`, 'Hier starten', { size: 'sm', fields: { version: v.id } })}`,
        cls: 'wrap',
      });

    const body = html`${pageHead({
        crumbs: [['/apps', 'Meine Apps'], [`/apps/${a.id}`, a.name]],
        app: a,
        eyebrow: 'Editor',
        title: a.name,
        lead: versions.length
          ? 'Im Editor änderst du deine App direkt im Browser, mit der Vorschau gleich daneben. Du arbeitest dabei an einem Entwurf: Deine Versionen bleiben, wie sie sind, bis du den Entwurf als neue Version speicherst.'
          : 'Im Editor baust du deine App direkt im Browser, mit der Vorschau gleich daneben. Fang mit einer Vorlage an – du kannst alles darin ändern.',
        actions: preferred ? postButton(req, `/studio/${a.id}/entwurf`, `Entwurf aus Version ${preferred.number} starten`, { kind: 'primary', icon: 'edit', fields: { version: preferred.id } }) : '',
      })}
      ${versions.length
        ? html`<section class="section" aria-labelledby="s-versions">${sectionHead('Versionen', { id: 's-versions', sub: 'Der Entwurf beginnt als Kopie der Version, die du wählst.' })}
            ${list(versions.map(versionRow))}</section>`
        : html`<section class="section" aria-labelledby="s-tpl">${sectionHead('Mit einer Vorlage beginnen', { id: 's-tpl', sub: 'Die Dateien der Vorlage kommen in deinen Entwurf. Der Name und das Symbol deiner App bleiben.' })}
            ${list(TEMPLATES.map((t) => templateRow(t, postButton(req, `/studio/${a.id}/vorlage`, 'Damit beginnen', { size: 'sm', fields: { vorlage: t.id } }))))}</section>
          ${notice({ icon: 'upload', title: 'Schon auf dem PC gebaut?', text: 'Dann lade den Ordner auf der App-Seite hoch. Danach kannst du jede Version hier im Editor weiterbauen.', actions: linkButton(`/apps/${a.id}`, 'Zur App-Seite', { size: 'sm' }) })}`}`;
    return page(req, { title: `Editor · ${a.name}`, body, active: 'bauen', styles: ['css/studio.css'] });
  }

  app.get('/studio/:appId', (req, res) => {
    const a = ownApp(req);
    res.send(hasDraft(a) ? editorPage(req, a) : startPage(req, a));
  });

  /** Start the draft as a copy of one version. An existing draft is only replaced on purpose (ersetzen=1). */
  app.post('/studio/:appId/entwurf', (req, res) => {
    const a = ownApp(req);
    const v = db.get("SELECT * FROM app_versions WHERE id = ? AND app_id = ? AND status = 'ready'", String(req.body.version || ''), a.id);
    if (!v) throw deny();
    if (hasDraft(a) && req.body.ersetzen !== '1') {
      flash(req, 'Es gibt schon einen Entwurf – du arbeitest an ihm weiter.');
      return res.redirect(303, `/studio/${a.id}`);
    }
    uploads.draftFromVersion(a, v);
    flash(req, `Entwurf aus Version ${v.number} gestartet. Speichere ihn als Version, wenn du so weit bist.`);
    res.redirect(303, `/studio/${a.id}`);
  });

  /** Start a missing draft from a template (every file through putDraftFile). */
  app.post('/studio/:appId/vorlage', (req, res) => {
    const a = ownApp(req);
    const tpl = templateById(String(req.body.vorlage || ''));
    if (!tpl) throw deny();
    if (hasDraft(a)) {
      flash(req, 'Es gibt schon einen Entwurf – du arbeitest an ihm weiter.');
      return res.redirect(303, `/studio/${a.id}`);
    }
    draftFromTemplate(ctx, a, tpl);
    flash(req, `Entwurf mit der Vorlage „${tpl.name}“ gestartet.`);
    res.redirect(303, `/studio/${a.id}`);
  });

  app.post('/studio/:appId/verwerfen', (req, res) => {
    const a = ownApp(req);
    uploads.deleteDraft(a);
    flash(req, 'Der Entwurf wurde verworfen. Deine Versionen sind unverändert.');
    res.redirect(303, `/studio/${a.id}`);
  });

  /** "Als Version speichern": a new, immutable version from the draft (needs index.html). */
  app.post('/studio/:appId/version', (req, res) => {
    const a = draftApp(req);
    limiter.guard('uploadVersions', req.user.id);
    const v = services.versionFromDraft(req.user, a, typeof req.body.notiz === 'string' ? req.body.notiz : '');
    let problems = 0;
    try {
      problems = JSON.parse(v.report || '{}').items.filter((i) => i.level === 'error').length;
    } catch {
      problems = 0;
    }
    flash(req, problems
      ? `Version ${v.number} gespeichert. Der Prüfbericht meldet ${plural(problems, 'Fehler', 'Fehler')} – sieh ihn dir an, bevor du veröffentlichst.`
      : `Version ${v.number} gespeichert – jetzt veröffentlichen?`);
    res.redirect(303, `/apps/${a.id}`);
  });

  // ------------------------------------------------------- draft file API
  // JSON for public/studio.js. CSRF is checked globally (X-CSRF-Token header).

  /** A fresh preview address (the file token in it lasts an hour). */
  app.get('/studio/:appId/vorschau', (req, res) => {
    const a = draftApp(req);
    res.set('Cache-Control', 'no-store');
    res.json({ src: previewSrc(a, req.user.id) });
  });

  /** Read one text file of the draft. Looked up by exact name in the database - never a disk path. */
  app.get('/studio/:appId/datei', (req, res) => {
    const a = ownApp(req);
    const wanted = typeof req.query.pfad === 'string' ? req.query.pfad : '';
    const f = wanted ? uploads.findDraftFile(a.id, wanted) : null;
    if (!f) throw new HttpError(404, 'Diese Datei gibt es im Entwurf nicht.');
    if (!uploads.isTextFile(f.path)) throw new HttpError(415, 'Diese Datei ist keine Textdatei. Bilder und Töne siehst du in der Vorschau.');
    if (f.size > EDIT_MAX_BYTES) throw new HttpError(413, `Diese Datei ist zu groß für den Editor (${formatBytes(f.size)}). Bearbeite sie auf deinem PC und lade sie dann hoch.`);
    const data = uploads.readBlob(f.sha256);
    const text = data.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(data)) throw new HttpError(415, 'Diese Datei ist nicht als UTF-8-Text gespeichert und kann im Editor nicht bearbeitet werden.');
    res.set('Cache-Control', 'no-store');
    res.json({ path: f.path, size: f.size, text });
  });

  // Permission first, then the rate limit - and only then is the body read.
  const draftOwner = (req, res, next) => {
    req.studioApp = draftApp(req);
    limiter.guard('draftWrites', req.user.id);
    next();
  };

  /** ?neu=1 never replaces: is there a file with this name (any case) already? */
  const taken = (req, a) => req.query.neu === '1' && Boolean(db.get('SELECT 1 AS x FROM draft_files WHERE app_id = ? AND path_lower = ?', a.id, normalizePath(pathParam(req.query.pfad)).toLowerCase()));

  /**
   * Before a file body is read: permission, rate limit, format, name, "neu", then
   * uploads.admitDraftFile (declared size against the file limit, the draft and
   * the account; at most a few bodies per person at once). A refusal is answered
   * without reading the body and closes the connection.
   */
  function draftUpload(req, res, next) {
    try {
      const a = draftApp(req);
      limiter.guard('draftWrites', req.user.id);
      if (!req.is('application/octet-stream')) throw new HttpError(415, 'Falsches Format.');
      const wanted = pathParam(req.query.pfad);
      if (taken(req, a)) throw new HttpError(409, 'Eine Datei mit diesem Namen gibt es schon.');
      uploads.admitDraftFile(req, res, a, req.user.id, wanted);
      req.studioApp = a;
      next();
    } catch (err) {
      res.set('Connection', 'close');
      next(err);
    }
  }

  /** Create or replace one draft file (editor saves and uploads). ?neu=1 refuses to replace. */
  app.put('/studio/:appId/datei', draftUpload, express.raw({ type: 'application/octet-stream', limit: L.maxFileBytes }), (req, res) => {
    const a = req.studioApp;
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (taken(req, a)) throw new HttpError(409, 'Eine Datei mit diesem Namen gibt es schon.'); // again: another save may have come first
    const p = uploads.putDraftFile(a, req.query.pfad, data); // all path, type, size and quota checks - again, after reading
    res.json({ ok: true, path: p, files: fileList(a) });
  });

  app.post('/studio/:appId/datei/loeschen', draftOwner, (req, res) => {
    const a = req.studioApp;
    if (!uploads.deleteDraftFile(a, pathParam(req.body.pfad))) throw new HttpError(404, 'Diese Datei gibt es im Entwurf nicht.');
    res.json({ ok: true, files: fileList(a) });
  });

  /** Rename or move: the content is written under the new name through putDraftFile, then the old row goes. */
  app.post('/studio/:appId/datei/umbenennen', draftOwner, (req, res) => {
    const a = req.studioApp;
    const old = uploads.findDraftFile(a.id, pathParam(req.body.von));
    if (!old) throw new HttpError(404, 'Diese Datei gibt es im Entwurf nicht.');
    const target = normalizePath(pathParam(req.body.nach));
    if (target !== old.path) {
      const clash = db.get('SELECT path FROM draft_files WHERE app_id = ? AND path_lower = ?', a.id, target.toLowerCase());
      if (clash && clash.path !== old.path) throw new HttpError(409, `Eine Datei „${clash.path.slice(0, 80)}“ gibt es schon.`);
      const data = uploads.readBlob(old.sha256);
      db.tx(() => {
        const written = uploads.putDraftFile(a, target, data);
        // A rename that only changes upper/lower case has already replaced the old row.
        if (written !== old.path) uploads.deleteDraftFile(a, old.path);
      });
    }
    res.json({ ok: true, path: target, files: fileList(a) });
  });

  // -------------------------------------------------------------- templates

  app.get('/entwickeln/vorlagen', (req, res) => {
    const body = html`${pageHead({
        eyebrow: 'Bauen',
        title: 'Vorlagen',
        lead: 'Fang nicht bei null an: Jede Vorlage ist eine fertige kleine App, die du im Editor nach deinen Ideen umbaust – oder als ZIP auf deinem PC.',
        tabs: bauenTabs('vorlagen'),
      })}
      <section class="section" aria-labelledby="s-tpl"><h2 id="s-tpl" class="visually-hidden">Alle Vorlagen</h2>
        ${list(TEMPLATES.map((t) => templateRow(t, html`${postButton(req, `/entwickeln/vorlagen/${t.id}/anlegen`, 'Neue App aus Vorlage', { size: 'sm', icon: 'plus' })}${linkButton(`/entwickeln/vorlagen/${t.id}.zip`, 'Als ZIP herunterladen', { size: 'sm', kind: 'quiet', icon: 'download' })}`)))}
      </section>
      <div class="grid-2 even">
        <section class="panel" aria-labelledby="s-pc"><h2 id="s-pc">Auf dem eigenen PC bauen</h2>
          <p class="muted">Im ZIP liegen die Dateien der Vorlage, das SDK (<code class="studio-nb">hub-sdk.js</code>) und das UI-Kit (<code class="studio-nb">hub-ui.css</code>) mit Schrift. Entpacken, <code class="studio-nb">index.html</code> doppelklicken – fertig. Die leere Vorlage gibt es auch als Starter-Paket.</p>
          <div class="actions mt-4">${linkButton('/entwickeln/starter.zip', 'Starter-Paket (ZIP)', { size: 'sm', icon: 'download' })}${linkButton('/entwickeln', 'Zur Anleitung', { size: 'sm', kind: 'quiet' })}</div></section>
        <section class="panel" aria-labelledby="s-wiese"><h2 id="s-wiese">SDK ausprobieren</h2>
          <p class="muted">Auf der Spielwiese hat jede Funktion des SDK einen Knopf. Du siehst sofort, was zurückkommt – und im Editor, wie es gemacht ist.</p>
          <div class="actions mt-4">${linkButton('/entwickeln/spielwiese', 'Zur Spielwiese', { size: 'sm' })}</div></section>
      </div>`;
    res.send(page(req, { title: 'Vorlagen', body, active: 'bauen', styles: ['css/studio.css'] }));
  });

  /** A new app from a template, with every template file in its draft. Opens the editor. */
  app.post('/entwickeln/vorlagen/:id/anlegen', (req, res) => {
    const tpl = templateById(req.params.id);
    if (!tpl) throw deny();
    const a = appFromTemplate(ctx, req.user, tpl);
    flash(req, `„${a.name}“ ist angelegt. Probiere den Entwurf in der Vorschau aus und speichere ihn als Version, wenn du so weit bist.`);
    res.redirect(303, `/studio/${a.id}`);
  });

  /** The template as a ZIP that runs offline: its files + SDK + UI kit + fonts. Fixed file names only. */
  function sendTemplateZip(res, tpl, name) {
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    return uploads.writeZip(res, zipEntries(tpl));
  }
  app.get('/entwickeln/vorlagen/:id.zip', (req, res) => {
    const tpl = templateById(req.params.id);
    if (!tpl) throw deny();
    return sendTemplateZip(res, tpl, `${tpl.id}.zip`);
  });
  app.get('/entwickeln/starter.zip', (req, res) => sendTemplateZip(res, templateById('leer'), 'starter.zip'));
};
