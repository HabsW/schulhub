'use strict';
// The player: the page an app runs in (a sandboxed iframe on the app's own
// origin), the token route its SDK talks through, and favourites.
//
// What may run is decided by access.resolvePlay (or canManageApp for the
// owner's editor draft). The iframe never shares an origin with the Hub.
//
// The app's frame waits in a <template>: public/player.js first points it at
// the Hub's start page on the app's origin, which clears what an earlier
// person left in that origin's browser storage (sdk/hub-start.js), and loads
// the app only when that page says so.

const { html, page, icon, appIcon, appClass, badge, csrfField } = require('../html');
const { deny } = require('../util');
const { sidHash } = require('../sessions');

// Scripts and the app's own origin; no top navigation, no popups.
const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-modals allow-pointer-lock';
const str = (v) => (typeof v === 'string' && v ? v : null);

module.exports = (app, ctx) => {
  const { db, config, tokens, access, services } = ctx;
  const getApp = (id) => db.get('SELECT * FROM apps WHERE id = ?', String(id));

  /**
   * What this request may run: a version (access.resolvePlay) or, for the
   * owner only, the editor draft ({ draft: true }). null = not allowed.
   */
  function decide(user, a, { klasse, version, entwurf }) {
    if (!a) return null;
    if (entwurf) {
      if (!access.canManageApp(user, a) || !db.get('SELECT 1 AS ok FROM app_drafts WHERE app_id = ?', a.id)) return null;
      const classId = klasse && access.canViewClass(user, klasse) ? klasse : null;
      return { draft: true, version: { id: 'draft', number: 0 }, classId, preview: true };
    }
    const play = access.resolvePlay(user, a, { classId: klasse, versionId: version });
    // A school-wide app opened with a class it is not in (e.g. linked from a class page) opens
    // school-wide instead of a dead end. Only for school-wide apps: a link into an archived class
    // or to a removed app must stay closed. Previews never fall back.
    if (!play && klasse && !version && a.schoolwide_version_id) return access.resolvePlay(user, a);
    return play;
  }

  app.get('/apps/:id/spielen', (req, res) => {
    const a = getApp(req.params.id);
    const play = decide(req.user, a, { klasse: str(req.query.klasse), version: str(req.query.version), entwurf: req.query.entwurf === '1' });
    if (!play) throw deny();
    const cls = play.classId ? db.get('SELECT id, name FROM classes WHERE id = ? AND archived_at IS NULL', play.classId) : null;
    // The file token unlocks exactly this version's static files - or the owner's draft.
    // r: 1 - this page opens the app's start page itself before the app (see below), so the app
    // origin does not need to send the frame there first (appsHost.js).
    const fileToken = play.draft
      ? tokens.sign('files', { a: a.id, d: 1, u: req.user.id, r: 1 }, 60 * 60)
      : tokens.sign('files', { a: a.id, v: play.version.id, u: req.user.id, r: 1 }, config.fileTokenSeconds);
    const origin = config.appOrigin(a.origin_key);
    const back = play.draft ? `/studio/${a.id}` : play.preview ? `/apps/${a.id}` : cls ? `/klassen/${cls.id}` : '/start';
    const favourite = Boolean(db.get('SELECT 1 AS ok FROM favorites WHERE user_id = ? AND app_id = ?', req.user.id, a.id));
    const manage = access.canReviewApp(req.user, a);

    const body = html`<div class="playerbar ${appClass(a)}">
        <a class="btn quiet icon sm" href="${back}" aria-label="Zurück" title="Zurück">${icon('arrowLeft')}</a>
        <span class="app-name">${appIcon(a, 'xs')}<span>${a.name}</span>${cls ? html`<small>${cls.name}</small>` : ''}</span>
        ${play.preview ? badge(html`${play.draft ? 'Entwurf' : 'Vorschau'}<span class="label-wide">${play.draft ? ' · nichts wird gespeichert' : ` · Version ${play.version.number}`}</span>`, 'wait') : ''}
        ${play.preview ? html`<button class="btn quiet sm" type="button" id="console-toggle" aria-controls="console" aria-expanded="false">${icon('terminal')}<span class="label-wide">Konsole</span><span class="count wait" id="console-count" hidden>0</span></button>` : ''}
        ${play.preview ? '' : html`<form method="post" action="/apps/${a.id}/favorit" class="inline" id="favourite">${csrfField(req)}
          <input type="hidden" name="zurueck" value="${req.originalUrl}">
          <button class="btn quiet icon sm" aria-pressed="${favourite ? 'true' : 'false'}" aria-label="${favourite ? 'Aus den Favoriten nehmen' : 'Zu den Favoriten'}" title="${favourite ? 'Favorit' : 'Zu den Favoriten'}">${icon('heart', { cls: favourite ? 'filled' : '' })}</button></form>`}
        <button class="btn quiet icon sm" type="button" id="fullscreen" aria-label="Vollbild" title="Vollbild">${icon('maximize')}</button>
        ${manage && !play.draft ? html`<a class="btn quiet icon sm hide-phone" href="/apps/${a.id}" aria-label="App verwalten" title="App verwalten">${icon('settings')}</a>` : ''}
      </div>
      <div class="stage" id="stage" data-origin="${origin}" data-token-url="/apps/${a.id}/token"
           data-class="${play.classId || ''}" data-version="${play.preview && !play.draft ? play.version.id : ''}" data-draft="${play.draft ? '1' : ''}">
        <template id="appframe-hold" data-start="${origin}/~${fileToken}/_hub/start"><iframe id="appframe" title="${a.name}" src="${origin}/~${fileToken}/index.html" sandbox="${SANDBOX}" allow="fullscreen; autoplay; gamepad" referrerpolicy="no-referrer"></iframe></template>
        <div class="loading ${appClass(a)}" aria-hidden="true">${appIcon(a, 'lg')}</div>
        ${play.preview ? html`<section class="console" id="console" aria-label="Konsole" hidden>
          <div class="console-head"><strong>Konsole</strong><span>Meldungen deiner App (nur in der Vorschau)</span>
            <button class="btn quiet sm" type="button" id="console-clear">Leeren</button></div>
          <ol class="console-log" id="console-log" aria-live="polite"></ol></section>` : ''}
        <div id="player-note" class="overlay" hidden>
          <strong>Deine Sitzung ist abgelaufen.</strong>
          <p class="muted">Melde dich neu an – danach geht es hier weiter.</p>
          <a class="btn primary" href="${req.originalUrl}">Neu anmelden</a></div>
      </div>`;
    res.send(page(req, { title: a.name, body, shell: 'player', scripts: ['player.js'], styles: ['css/frames.css'] }));
  });

  /**
   * The player page asks for the short-lived SDK token here (and again before it
   * expires). Permission is checked again on every call. The token is valid only
   * for this user, in this app, in this session - and carries the preview mark.
   */
  app.post('/apps/:id/token', (req, res) => {
    const a = getApp(req.params.id);
    const play = decide(req.user, a, { klasse: str(req.body.klasse), version: str(req.body.version), entwurf: req.body.entwurf === true });
    if (!play) throw deny();
    const user = req.user;
    const cls = play.classId ? db.get('SELECT id, name FROM classes WHERE id = ? AND archived_at IS NULL', play.classId) : null;
    // A preview is not a real use of the app: it is never counted, and its
    // token makes the SDK keep everything in memory (see sdkStore.js).
    if (req.body.first === true && !play.preview) services.recordPlay(a.id, user.id);
    const token = tokens.sign('sdk', { u: user.id, a: a.id, v: play.version.id, c: play.classId, s: sidHash(req.sessionID), p: play.preview ? 1 : 0 }, config.sdkTokenSeconds);
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
      // The display choice only (dark / light / auto) - lets UI-kit apps match the Hub.
      theme: ['dark', 'light'].includes(user.pref_theme) ? user.pref_theme : 'auto',
    });
  });

  /** Favourites: only for apps this person can open. */
  app.post('/apps/:id/favorit', (req, res) => {
    const a = getApp(req.params.id);
    if (!a || !access.resolvePlay(req.user, a)) throw deny();
    const had = db.run('DELETE FROM favorites WHERE user_id = ? AND app_id = ?', req.user.id, a.id).changes > 0;
    if (!had) db.run('INSERT INTO favorites (user_id, app_id, created_at) VALUES (?, ?, ?)', req.user.id, a.id, Date.now());
    if (String(req.headers.accept || '').includes('application/json')) return res.json({ favourite: !had });
    const back = String((req.body && req.body.zurueck) || '');
    res.redirect(303, /^\/(apps|klassen|start|katalog)\b[^\s]*$/.test(back) && !back.startsWith('//') ? back : `/apps/${a.id}/spielen`);
  });
};
