'use strict';
// Apps: create, upload versions, preview, publish, review (source, comments,
// download) and the player page that embeds an app in a sandboxed frame.

const express = require('express');
const fs = require('node:fs');
const { html, raw, page, flash, csrfField, postButton, appIcon, EMOJIS, COLORS } = require('../html');
const { deny, bad, cleanText, formatDate, formatBytes, newId, HttpError } = require('../util');
const { sidHash } = require('../sessions');

const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-modals allow-pointer-lock';

module.exports = (app, ctx) => {
  const { db, config, access, services, uploads, limiter, tokens } = ctx;
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

  function appForm(req, a) {
    return html`${csrfField(req)}
      <label>Name<input name="name" required minlength="2" maxlength="60" value="${a ? a.name : ''}"></label>
      <label>Kurze Beschreibung<textarea name="description" maxlength="500" rows="2">${a ? a.description : ''}</textarea></label>
      <fieldset class="picker"><legend>Symbol</legend>${EMOJIS.map((e, i) => html`<label><input type="radio" name="emoji" value="${e}"${(a ? a.emoji === e : i === 0) ? raw(' checked') : ''}><span>${e}</span></label>`)}</fieldset>
      <fieldset class="picker"><legend>Farbe</legend>${Array.from({ length: COLORS }, (_, i) => html`<label><input type="radio" name="color" value="${i}"${(a ? a.color === i : i === 0) ? raw(' checked') : ''}><span class="swatch c${i}"></span></label>`)}</fieldset>`;
  }

  // ---------- my apps ----------
  app.get('/apps', (req, res) => {
    const mine = db.all('SELECT a.*, (SELECT COUNT(*) FROM app_versions v WHERE v.app_id = a.id AND v.status = \'ready\') AS versions FROM apps a WHERE a.owner_id = ? ORDER BY a.updated_at DESC', req.user.id);
    const body = html`<h1>Meine Apps</h1>
    ${mine.length ? html`<div class="grid">${mine.map((a) => html`<a class="card app" href="/apps/${a.id}">${appIcon(a)}<span class="grow"><strong>${a.name}</strong>
      <small>${a.published_version_id ? 'Veröffentlicht' : a.versions ? 'Noch nicht veröffentlicht' : 'Noch nichts hochgeladen'} · ${a.versions} Version${a.versions === 1 ? '' : 'en'}</small></span></a>`)}</div>`
      : html`<div class="empty"><p><strong>Du hast noch keine eigene App.</strong></p><p>Jede Webseite oder jedes Web-Spiel in einem Ordner kann eine App werden. <a href="/entwickeln">So geht’s</a>.</p></div>`}
    <section class="panel"><h2>Neue App anlegen</h2>
      <form method="post" action="/apps" class="stack">${appForm(req, null)}<button class="btn primary">App anlegen</button></form></section>`;
    res.send(page(req, { title: 'Meine Apps', body, active: 'apps' }));
  });

  app.post('/apps', (req, res) => {
    const id = services.createApp(req.user, req.body);
    res.redirect(303, `/apps/${id}`);
  });

  // ---------- app page (owner view and reviewer view) ----------
  app.get('/apps/:id', (req, res) => {
    const a = getApp(req.params.id);
    if (!a) throw deny();
    if (!access.canReviewApp(req.user, a)) {
      // People who may only use the app go straight to it.
      if (access.resolvePlay(req.user, a)) return res.redirect(`/apps/${a.id}/spielen`);
      throw deny();
    }
    const user = req.user;
    const manage = access.canManageApp(user, a);
    const owner = db.get('SELECT name FROM users WHERE id = ?', a.owner_id);
    const versions = db.all("SELECT * FROM app_versions WHERE app_id = ? AND status = 'ready' ORDER BY number DESC", a.id).filter((v) => access.canSeeVersion(user, a, v.id));
    const byId = new Map(versions.map((v) => [v.id, v]));
    const label = (id) => (byId.has(id) ? `Version ${byId.get(id).number}` : '–');
    const reviewing = access.reviewClasses(user, a); // classes where this user decides
    const reviewIds = new Set(reviewing.map((c) => c.id));
    // Class rows are shown to the owner (all of them) and to teachers (their own classes only).
    const classRows = db
      .all('SELECT ca.*, c.name FROM class_apps ca JOIN classes c ON c.id = ca.class_id WHERE ca.app_id = ? ORDER BY c.name', a.id)
      .filter((r) => manage || reviewIds.has(r.class_id));
    const submittable = db.all(
      `SELECT c.id, c.name FROM classes c JOIN class_members m ON m.class_id = c.id AND m.user_id = ?
        WHERE c.id NOT IN (SELECT class_id FROM class_apps WHERE app_id = ?) ORDER BY c.name`,
      user.id, a.id
    );
    const comments = db.all('SELECT c.id, c.body, c.created_at, c.author_id, u.name, u.role FROM comments c LEFT JOIN users u ON u.id = c.author_id WHERE c.app_id = ? ORDER BY c.created_at', a.id);
    const used = uploads.userBytes(a.owner_id);

    const body = html`<p class="crumbs">${manage ? html`<a href="/apps">Meine Apps</a> ›` : html`<a href="/start">Start</a> ›`}</p>
    <div class="apphead">${appIcon(a, 'lg')}<div><h1>${a.name}</h1>
      <p class="muted">von ${owner ? owner.name : '–'}${a.schoolwide_version_id ? html` · <span class="badge ok">Für die ganze Schule</span>` : ''}</p>
      ${a.description ? html`<p class="pre">${a.description}</p>` : ''}</div></div>

    ${reviewing.filter((c) => c.requested_version_id).map((c) => html`<section class="panel attention"><h2>Freigabe für ${c.name}</h2>
      <p><strong>${label(c.requested_version_id)}</strong> wurde eingereicht${c.version_id ? html` (bisher freigegeben: ${label(c.version_id)})` : ''}.
      Probiere die App aus und sieh dir den Quelltext an, bevor du sie freigibst.</p>
      <p class="actions"><a class="btn" href="/apps/${a.id}/spielen?version=${c.requested_version_id}&amp;klasse=${c.id}">Vorschau öffnen</a>
      <a class="btn" href="/apps/${a.id}/versionen/${c.requested_version_id}/quelltext">Quelltext ansehen</a>
      ${postButton(req, `/klassen/${c.id}/apps/${a.id}/freigeben`, 'Für die Klasse freigeben', { cls: 'btn primary', fields: { version: c.requested_version_id } })}
      ${postButton(req, `/klassen/${c.id}/apps/${a.id}/ablehnen`, 'Ablehnen', { cls: 'btn ghost' })}</p></section>`)}

    <section><h2>Versionen</h2>
    ${versions.length ? html`<div class="scroll"><table class="data"><thead><tr><th>Version</th><th>Hochgeladen</th><th>Inhalt</th><th></th></tr></thead><tbody>
      ${versions.map((v) => html`<tr><td><strong>Version ${v.number}</strong>
          ${a.published_version_id === v.id ? html` <span class="badge ok">Veröffentlicht</span>` : ''}
          ${a.schoolwide_version_id === v.id ? html` <span class="badge">Schulweit</span>` : ''}</td>
        <td>${formatDate(v.created_at)}</td><td>${v.file_count} Dateien · ${formatBytes(v.total_bytes)}</td>
        <td class="right actions"><a class="btn small" href="/apps/${a.id}/spielen?version=${v.id}">Vorschau</a>
          <a class="btn small" href="/apps/${a.id}/versionen/${v.id}/quelltext">Quelltext</a>
          <a class="btn small" href="/apps/${a.id}/versionen/${v.id}/download">Herunterladen</a>
          ${manage && a.published_version_id !== v.id ? postButton(req, `/apps/${a.id}/veroeffentlichen`, 'Veröffentlichen', { cls: 'btn small primary', fields: { version: v.id }, confirm: `Version ${v.number} veröffentlichen?` }) : ''}
          ${manage && a.published_version_id !== v.id ? postButton(req, `/apps/${a.id}/versionen/${v.id}/loeschen`, 'Löschen', { cls: 'btn small ghost', confirm: `Version ${v.number} endgültig löschen?` }) : ''}</td></tr>`)}
      </tbody></table></div>
      <p class="muted">${manage ? 'Die Vorschau ist privat: Nur du kannst jede Version öffnen. Lehrkräfte sehen nur Versionen, die du in ihre Klasse eingebracht hast. Erst „Veröffentlichen“ macht eine Version zur aktuellen.'
        : 'Du siehst die Versionen, die für deine Klassen eingereicht oder freigegeben wurden.'}</p>`
      : html`<p class="muted">Noch keine Version hochgeladen.</p>`}
    </section>

    ${manage ? html`<section class="panel" id="upload" data-app="${a.id}" data-max-files="${L.maxFiles}" data-max-file="${L.maxFileBytes}" data-max-total="${L.maxVersionBytes}">
      <h2>Neue Version hochladen</h2>
      <p>Wähle den <strong>Ordner</strong> deiner App oder eine <strong>ZIP-Datei</strong>. Im Ordner muss ganz oben eine <code>index.html</code> liegen.</p>
      <p class="actions"><label class="btn primary filebtn">Ordner auswählen<input type="file" id="pick-folder" webkitdirectory multiple hidden></label>
      <label class="btn filebtn">ZIP-Datei auswählen<input type="file" id="pick-zip" accept=".zip,application/zip" hidden></label></p>
      <div id="upload-status" class="status" role="status" aria-live="polite" hidden></div>
      <p class="muted">Speicher dieses Kontos: ${formatBytes(used)} von ${formatBytes(L.maxUserBytes)} belegt. <a href="/entwickeln">Hilfe zum Bauen von Apps</a></p>
    </section>` : ''}

    <section class="panel"><h2>Klassen</h2>
      ${classRows.length ? classRows.map((r) => html`<div class="rowline"><span class="grow"><strong>${r.name}</strong>
        <small>${r.status === 'approved' ? `Freigegeben: ${label(r.version_id)}` : r.status === 'rejected' ? 'Nicht freigegeben' : 'Wartet auf Freigabe'}${r.requested_version_id && r.status === 'approved' ? ` · ${label(r.requested_version_id)} wartet auf Freigabe` : ''}</small></span>
        ${manage || reviewIds.has(r.class_id) ? postButton(req, `/klassen/${r.class_id}/apps/${a.id}/entfernen`, manage && !reviewIds.has(r.class_id) ? 'Zurückziehen' : 'Aus Klasse entfernen', { cls: 'btn small ghost', confirm: 'Die App aus dieser Klasse entfernen?' }) : ''}</div>`)
        : html`<p class="muted">Diese App ist noch in keiner Klasse.</p>`}
      ${manage && a.owner_id === user.id && a.published_version_id && submittable.length ? html`<form method="post" action="/apps/${a.id}/einreichen" class="row">${csrfField(req)}
        <label class="grow">In Klasse einbringen<select name="klasse">${submittable.map((c) => html`<option value="${c.id}">${c.name}</option>`)}</select></label>
        <button class="btn">Einreichen</button></form>` : ''}
      ${manage && !a.published_version_id ? html`<p class="muted">Veröffentliche zuerst eine Version, dann kannst du die App in eine Klasse einbringen.</p>` : ''}
      ${access.isAdmin(user) && a.published_version_id ? html`<p>${a.schoolwide_version_id
        ? postButton(req, `/apps/${a.id}/schulweit`, 'Schulweite Freigabe beenden', { cls: 'btn ghost', fields: { an: '0' } })
        : postButton(req, `/apps/${a.id}/schulweit`, 'Für die ganze Schule freigeben', { cls: 'btn', fields: { an: '1' }, confirm: 'Die veröffentlichte Version für alle angemeldeten Personen freigeben?' })}</p>` : ''}
    </section>

    <section><h2>Kommentare</h2>
      ${comments.length ? comments.map((c) => html`<div class="comment"><p class="meta"><strong>${c.name || 'Gelöschtes Konto'}</strong>${c.role && c.role !== 'student' ? html` <span class="badge">Lehrkraft</span>` : ''} · ${formatDate(c.created_at)}
        ${c.author_id === user.id || access.isAdmin(user) ? postButton(req, `/apps/${a.id}/kommentare/${c.id}/loeschen`, 'Löschen', { cls: 'link', confirm: 'Kommentar löschen?' }) : ''}</p>
        <p class="pre">${c.body}</p></div>`) : html`<p class="muted">Noch keine Kommentare. Hier können Lehrkraft und Besitzer/in über die App sprechen.</p>`}
      <form method="post" action="/apps/${a.id}/kommentare" class="stack">${csrfField(req)}
        <label>Kommentar schreiben<textarea name="text" required maxlength="2000" rows="3"></textarea></label>
        <button class="btn">Kommentar senden</button></form>
    </section>

    ${manage ? html`<section class="panel quiet"><h2>Einstellungen</h2>
      <form method="post" action="/apps/${a.id}/bearbeiten" class="stack">${appForm(req, a)}<button class="btn">Speichern</button></form>
      ${postButton(req, `/apps/${a.id}/loeschen`, 'App löschen', { cls: 'btn danger', confirm: `„${a.name}“ mit allen Versionen und allen Spielständen endgültig löschen?` })}</section>` : ''}`;
    res.send(page(req, { title: a.name, body, active: a.owner_id === user.id ? 'apps' : '', scripts: manage ? ['upload.js'] : [] }));
  });

  app.post('/apps/:id/bearbeiten', (req, res) => {
    const a = manageApp(req);
    const f = services.appFields(req.body);
    db.run('UPDATE apps SET name = ?, description = ?, emoji = ?, color = ?, updated_at = ? WHERE id = ?', f.name, f.description, f.emoji, f.color, Date.now(), a.id);
    flash(req, 'Gespeichert.');
    res.redirect(303, `/apps/${a.id}`);
  });

  app.post('/apps/:id/loeschen', (req, res) => {
    const a = manageApp(req);
    services.deleteApp(req.user, a);
    flash(req, `„${a.name}“ wurde gelöscht.`);
    res.redirect(303, '/apps');
  });

  // ---------- uploading a version ----------
  // Folder upload: start -> one request per file -> finish. Zip upload: one request.
  // Both end in uploads.addFile(), which validates every single file.

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
    services.finishVersion(req.user, a, v);
    res.json({ ok: true, number: v.number });
  });

  app.post('/apps/:id/versionen/zip', async (req, res) => {
    const a = manageApp(req);
    limiter.guard('uploadVersions', req.user.id);
    if (!req.is('application/zip') && !req.is('application/octet-stream')) throw new HttpError(415, 'Bitte lade eine ZIP-Datei hoch.');
    if (Number(req.headers['content-length']) > L.maxZipBytes) throw new HttpError(413, `Das Archiv ist zu groß (maximal ${Math.round(L.maxZipBytes / 1048576)} MB).`);
    const file = await uploads.receiveToTemp(req, L.maxZipBytes);
    let v = null;
    try {
      v = services.createVersion(a);
      await uploads.addZip(v, a.owner_id, file);
      services.finishVersion(req.user, a, v);
    } catch (err) {
      // Nothing of a refused upload is kept.
      if (v && db.get('SELECT 1 AS x FROM app_versions WHERE id = ?', v.id)) services.deleteVersion(null, a, v);
      if (err instanceof HttpError) services.audit(req.user, 'upload_abgelehnt', a.name, err.message);
      throw err;
    } finally {
      fs.rm(file, { force: true }, () => {});
    }
    res.json({ id: v.id, number: v.number });
  });

  app.post('/apps/:id/versionen/:vid/loeschen', (req, res) => {
    const a = manageApp(req);
    const v = db.get('SELECT * FROM app_versions WHERE id = ? AND app_id = ?', String(req.params.vid), a.id);
    if (!v) throw deny();
    const inUse = a.published_version_id === v.id || a.schoolwide_version_id === v.id ||
      db.get('SELECT 1 AS x FROM class_apps WHERE app_id = ? AND (version_id = ? OR requested_version_id = ?)', a.id, v.id, v.id);
    if (inUse) throw bad('Diese Version ist veröffentlicht oder wird in einer Klasse verwendet und kann deshalb nicht gelöscht werden.');
    services.deleteVersion(req.user, a, v);
    res.redirect(303, `/apps/${a.id}`);
  });

  app.post('/apps/:id/veroeffentlichen', (req, res) => {
    const a = manageApp(req);
    const v = getVersion(a, req.body.version);
    services.publish(req.user, a, v);
    flash(req, `Version ${v.number} ist jetzt veröffentlicht.`);
    res.redirect(303, `/apps/${a.id}`);
  });

  /** Owner brings the app into one of their classes (same rules as on the class page). */
  app.post('/apps/:id/einreichen', (req, res) => {
    const a = manageApp(req);
    if (a.owner_id !== req.user.id) throw deny();
    const cls = db.get('SELECT * FROM classes WHERE id = ?', String(req.body.klasse || ''));
    if (!cls || !access.canViewClass(req.user, cls.id)) throw deny();
    ctx.addAppToClass(req, cls, a);
    res.redirect(303, `/apps/${a.id}`);
  });

  app.post('/apps/:id/schulweit', (req, res) => {
    const a = getApp(req.params.id);
    if (!a || !access.isAdmin(req.user)) throw deny();
    const on = req.body.an === '1';
    if (on && !a.published_version_id) throw bad('Diese App ist noch nicht veröffentlicht.');
    db.run('UPDATE apps SET schoolwide_version_id = ? WHERE id = ?', on ? a.published_version_id : null, a.id);
    services.audit(req.user, on ? 'schulweit_freigegeben' : 'schulweit_beendet', a.name);
    res.redirect(303, `/apps/${a.id}`);
  });

  // ---------- review tools ----------
  /** A version this user may inspect (see access.canSeeVersion), else 404. */
  function inspectVersion(req, a) {
    const v = getVersion(a, req.params.vid);
    if (!access.canSeeVersion(req.user, a, v.id)) throw deny();
    return v;
  }

  app.get('/apps/:id/versionen/:vid/quelltext', (req, res) => {
    const a = reviewApp(req);
    const v = inspectVersion(req, a);
    const files = uploads.listFiles(v.id);
    const wanted = typeof req.query.datei === 'string' ? req.query.datei : 'index.html';
    const file = files.find((f) => f.path === wanted); // exact match against the database, never a disk path
    let view = html`<p class="muted">Wähle links eine Datei.</p>`;
    if (file) {
      if (!uploads.isTextFile(file.path)) view = html`<p class="muted">Diese Datei ist keine Textdatei (${formatBytes(file.size)}). Du kannst die Version herunterladen, um sie anzusehen.</p>`;
      else if (file.size > 400 * 1024) view = html`<p class="muted">Diese Datei ist zu groß für die Ansicht (${formatBytes(file.size)}). Lade die Version herunter, um sie zu lesen.</p>`;
      // The content is shown as escaped plain text inside <pre>. It is never rendered or run.
      else view = html`<pre class="code source">${uploads.readBlob(file.sha256).toString('utf8')}</pre>`;
    }
    const body = html`<p class="crumbs"><a href="/apps/${a.id}">${a.name}</a> ›</p>
      <h1>Quelltext · Version ${v.number}</h1>
      <div class="source-layout"><nav class="filelist" aria-label="Dateien">${files.map((f) => html`<a href="/apps/${a.id}/versionen/${v.id}/quelltext?datei=${encodeURIComponent(f.path)}"${file && f.path === file.path ? raw(' class="on"') : ''}>${f.path}<small>${formatBytes(f.size)}</small></a>`)}</nav>
      <div class="fileview">${file ? html`<h2>${file.path}</h2>` : ''}${view}</div></div>`;
    res.send(page(req, { title: `Quelltext ${a.name}`, body, active: a.owner_id === req.user.id ? 'apps' : '' }));
  });

  app.get('/apps/:id/versionen/:vid/download', (req, res) => {
    const a = reviewApp(req);
    const v = inspectVersion(req, a);
    res.setHeader('Content-Type', 'application/zip');
    // Fixed, harmless file name; always a download, never shown inside the Hub.
    res.setHeader('Content-Disposition', `attachment; filename="app-version-${v.number}.zip"`);
    uploads.writeZip(res, uploads.listFiles(v.id));
  });

  app.post('/apps/:id/kommentare', (req, res) => {
    const a = reviewApp(req);
    const text = cleanText(req.body.text, 2000, { multiline: true });
    if (!text) throw bad('Der Kommentar ist leer.');
    if (db.get('SELECT COUNT(*) AS n FROM comments WHERE app_id = ?', a.id).n >= L.commentsPerApp) throw bad('Hier gibt es schon sehr viele Kommentare.');
    db.run('INSERT INTO comments (id, app_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)', newId(), a.id, req.user.id, text, Date.now());
    res.redirect(303, `/apps/${a.id}`);
  });

  app.post('/apps/:id/kommentare/:cid/loeschen', (req, res) => {
    const a = reviewApp(req);
    const c = db.get('SELECT * FROM comments WHERE id = ? AND app_id = ?', String(req.params.cid), a.id);
    if (!c || !(c.author_id === req.user.id || access.isAdmin(req.user))) throw deny();
    db.run('DELETE FROM comments WHERE id = ?', c.id);
    services.audit(req.user, 'kommentar_geloescht', a.name);
    res.redirect(303, `/apps/${a.id}`);
  });

  // ---------- player ----------
  const str = (v) => (typeof v === 'string' && v ? v : null);

  app.get('/apps/:id/spielen', (req, res) => {
    const a = getApp(req.params.id);
    const play = access.resolvePlay(req.user, a, { classId: str(req.query.klasse), versionId: str(req.query.version) });
    if (!play) throw deny();
    const cls = play.classId ? db.get('SELECT id, name FROM classes WHERE id = ?', play.classId) : null;
    // The file token only unlocks the static files of exactly this version.
    const fileToken = tokens.sign('files', { a: a.id, v: play.version.id }, config.fileTokenSeconds);
    const origin = config.appOrigin(a.origin_key);
    const back = play.preview ? `/apps/${a.id}` : cls ? `/klassen/${cls.id}` : '/start';
    const body = html`<div id="player" data-origin="${origin}" data-token-url="/apps/${a.id}/token"
        data-class="${play.classId || ''}" data-version="${play.preview ? play.version.id : ''}">
      <div class="playerbar"><a class="btn small ghost" href="${back}">‹ Zurück</a>
        ${appIcon(a, 'sm')}<strong>${a.name}</strong>${cls ? html`<span class="muted">${cls.name}</span>` : ''}
        ${play.preview ? html`<span class="badge warn">Vorschau · Version ${play.version.number}</span>` : ''}
        <span class="grow"></span>
        ${access.canReviewApp(req.user, a) ? html`<a class="btn small ghost" href="/apps/${a.id}">Verwalten</a>` : ''}
        <button class="btn small" id="fullscreen" type="button">Vollbild</button></div>
      <iframe id="appframe" title="${a.name}" src="${origin}/~${fileToken}/index.html" sandbox="${SANDBOX}" allow="fullscreen; autoplay; gamepad" referrerpolicy="no-referrer"></iframe>
      <div id="player-note" class="overlay" hidden><p>Deine Sitzung ist abgelaufen.</p><p><a class="btn primary" href="/">Neu anmelden</a></p></div>
    </div>`;
    res.send(page(req, { title: a.name, body, bare: true, scripts: ['player.js'] }));
  });

  /**
   * The player page asks for the short-lived SDK token here (and again before it
   * expires). Permission is checked again on every call. The token is valid only
   * for this user, in this app, in this session.
   */
  app.post('/apps/:id/token', (req, res) => {
    const a = getApp(req.params.id);
    const play = access.resolvePlay(req.user, a, { classId: str(req.body.klasse), versionId: str(req.body.version) });
    if (!play) throw deny();
    const user = req.user;
    const cls = play.classId ? db.get('SELECT id, name FROM classes WHERE id = ?', play.classId) : null;
    if (req.body.first === true) {
      db.run(
        `INSERT INTO plays (app_id, user_id, first_at, last_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (app_id, user_id) DO UPDATE SET last_at = excluded.last_at, count = count + 1`,
        a.id, user.id, Date.now(), Date.now()
      );
    }
    const token = tokens.sign('sdk', { u: user.id, a: a.id, v: play.version.id, c: play.classId, s: sidHash(req.sessionID) }, config.sdkTokenSeconds);
    res.json({
      token,
      expiresIn: config.sdkTokenSeconds,
      mode: play.preview ? 'preview' : 'live',
      // Apps get a name and an id that is different in every app - no e-mail, no global id.
      user: {
        id: tokens.pseudonym('user', `${a.id}:${user.id}`),
        name: user.name,
        isTeacher: Boolean(play.classId) && access.canManageClass(user, play.classId),
        isOwner: a.owner_id === user.id,
      },
      class: cls ? { id: tokens.pseudonym('class', `${a.id}:${cls.id}`), name: cls.name } : null,
      app: { name: a.name, version: play.version.number },
    });
  });
};
