'use strict';
// Everything served from an app's own origin (<key>.<apps domain>):
//
//   GET  /~<file token>/<path>   static files of one version (uploaded, untrusted)
//   GET  /_hub/info              tells the SDK that it runs inside the Hub
//   POST /_hub/api               the data API behind the SDK (Bearer token)
//
// No Hub cookies ever reach this host, and uploaded files are only ever sent
// as static bytes with strict headers - nothing uploaded runs on the server.

const fs = require('node:fs');
const path = require('node:path');
const { appHeaders } = require('./security');
const { cleanText } = require('./util');
const { ApiError, liveStore, createPreviewStores } = require('./sdkStore');
const { FileError } = require('./userFiles');
const { manifestOf, parseManifest, effectiveSettings } = require('./manifest');

const KEY = /^[A-Za-z0-9_.:-]{1,64}$/;
// Fonts the Hub's UI kit (hub-ui.css) may load from an app origin. Fixed list.
const UI_FONTS = new Set(['atkinson-next-latin.woff2', 'atkinson-next-latin-ext.woff2', 'atkinson-mono-latin.woff2', 'atkinson-mono-latin-ext.woff2']);

function createAppsHost(ctx) {
  const { db, config, tokens, uploads, limiter, access, userFiles } = ctx;
  const L = config.limits;
  // Previews write only to memory (see sdkStore.js).
  const previewStores = (ctx.previewStores = createPreviewStores());
  // Files the Hub itself provides on every app origin, whatever was uploaded under these names.
  const hubAssets = {
    'hub-sdk.js': { file: path.join(config.root, 'sdk', 'hub-sdk.js'), type: 'text/javascript; charset=utf-8' },
    'hub-ui.css': { file: path.join(config.root, 'sdk', 'hub-ui.css'), type: 'text/css; charset=utf-8' },
  };
  const assetCache = new Map();
  const hubAsset = (file) => {
    if (config.dev || !assetCache.has(file)) assetCache.set(file, fs.existsSync(file) ? fs.readFileSync(file) : null);
    return assetCache.get(file);
  };

  const clientIp = (req) => (config.trustProxy && req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',').pop().trim() : req.socket.remoteAddress);

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { ...appHeaders(config), 'Cache-Control': 'no-store', ...headers });
    res.end(body);
  }
  const sendText = (res, status, text) => send(res, status, text, { 'Content-Type': 'text/plain; charset=utf-8' });
  const sendJson = (res, status, data) => send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8' });

  // ---------- static files ----------
  function serveFile(req, res, appRow, rest) {
    if (!limiter.hit('appFiles', clientIp(req))) return sendText(res, 429, 'Zu viele Anfragen.');
    // Apps only run inside the Hub's sandboxed frame, never as a page of their own.
    if (req.headers['sec-fetch-dest'] === 'document') return sendText(res, 403, 'Diese App kann nur im Hub geöffnet werden.');
    const slash = rest.indexOf('/');
    const payload = tokens.verify('files', slash < 0 ? rest : rest.slice(0, slash));
    if (!payload || payload.a !== appRow.id) return sendText(res, 403, 'Der Link ist abgelaufen. Bitte öffne die App neu im Hub.');
    let rel;
    try {
      rel = decodeURIComponent(slash < 0 ? '' : rest.slice(slash + 1));
    } catch {
      return sendText(res, 400, 'Ungültige Adresse.');
    }
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';

    // The Hub always provides its own, current SDK and UI kit - whatever was uploaded under those names.
    const base = rel.slice(rel.lastIndexOf('/') + 1);
    if (Object.hasOwn(hubAssets, base)) {
      const body = hubAsset(hubAssets[base].file);
      if (!body) return sendText(res, 404, 'Datei nicht gefunden.');
      return send(res, 200, req.method === 'HEAD' ? undefined : body, { 'Content-Type': hubAssets[base].type });
    }
    const font = /(?:^|\/)hub-ui-fonts\/([a-z0-9-]+\.woff2)$/.exec(rel);
    if (font && UI_FONTS.has(font[1])) {
      const body = hubAsset(path.join(config.root, 'public', 'fonts', font[1]));
      if (!body) return sendText(res, 404, 'Datei nicht gefunden.');
      return send(res, 200, req.method === 'HEAD' ? undefined : body, { 'Content-Type': 'font/woff2', 'Cache-Control': 'private, max-age=86400' });
    }
    // Looked up by exact name in the database; the disk path comes from the content hash.
    // A draft token (the owner's editor preview) reads the app's mutable draft instead of a version.
    const draft = payload.d === 1;
    const file = draft ? uploads.findDraftFile(appRow.id, rel) : uploads.findFile(payload.v, rel);
    if (!file) return sendText(res, 404, 'Datei nicht gefunden.');

    const headers = {
      'Content-Type': uploads.contentType(file.path),
      'Cache-Control': draft ? 'no-store' : 'private, max-age=600',
      ETag: `"${file.sha256}"`,
      'Accept-Ranges': 'bytes',
    };
    if (req.headers['if-none-match'] === headers.ETag) return send(res, 304, undefined, headers);

    let start = 0;
    let end = file.size - 1;
    let status = 200;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && file.size > 0 && (range[1] || range[2])) {
      start = range[1] ? Number(range[1]) : Math.max(0, file.size - Number(range[2]));
      end = range[1] && range[2] ? Math.min(Number(range[2]), file.size - 1) : file.size - 1;
      if (start > end || start >= file.size) return send(res, 416, undefined, { 'Content-Range': `bytes */${file.size}` });
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${file.size}`;
    }
    headers['Content-Length'] = file.size === 0 ? 0 : end - start + 1;
    res.writeHead(status, { ...appHeaders(config), ...headers });
    if (req.method === 'HEAD' || file.size === 0) return res.end();
    const stream = fs.createReadStream(uploads.blobPath(file.sha256), { start, end });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  // ---------- data API ----------
  function readJson(req, max) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size <= max) return chunks.push(c);
        // Too big: answer politely, but cut the connection if the sender keeps going.
        chunks.length = 0;
        reject(new ApiError('too_large', 'Der Wert ist zu groß.', 413));
        if (size > max * 4) req.destroy();
      });
      req.on('error', () => reject(new ApiError('bad_request', 'Ungültige Anfrage.', 400)));
      req.on('end', () => {
        if (size > max) return;
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new ApiError('bad_request', 'Ungültige Anfrage.', 400));
        }
      });
    });
  }

  /** Who is calling? The token must be valid, made for THIS app, and its session must still exist. */
  function authenticate(req, appRow) {
    const header = String(req.headers.authorization || '');
    const t = header.startsWith('Bearer ') ? tokens.verify('sdk', header.slice(7)) : null;
    const denied = new ApiError('unauthorized', 'Nicht angemeldet.', 401);
    if (!t || t.a !== appRow.id) throw denied;
    const session = db.get('SELECT 1 AS ok FROM sessions WHERE sid_hash = ? AND user_id = ? AND expires_at > ?', String(t.s), String(t.u), Date.now());
    const user = session && db.get('SELECT * FROM users WHERE id = ? AND disabled = 0', String(t.u));
    if (!user) throw denied;
    // Class context only counts while the user really is in that class.
    const classId = typeof t.c === 'string' && access.canViewClass(user, t.c) ? t.c : null;
    // The preview flag is part of the signed token: an app cannot switch it off.
    return { user, classId, preview: t.p === 1, versionId: String(t.v), sid: String(t.s) };
  }

  const key = (params) => {
    if (!params || typeof params.key !== 'string' || !KEY.test(params.key)) throw new ApiError('bad_key', 'Ungültiger Schlüssel (erlaubt: Buchstaben, Ziffern, _ . : -, höchstens 64 Zeichen).');
    return params.key;
  };
  function encode(value, max) {
    const json = value === undefined ? undefined : JSON.stringify(value);
    if (json === undefined) throw new ApiError('bad_value', 'Dieser Wert kann nicht gespeichert werden.');
    const size = Buffer.byteLength(json);
    if (size > max) throw new ApiError('too_large', 'Der Wert ist zu groß.');
    return { json, size };
  }
  const decode = (json) => (json === null || json === undefined ? null : JSON.parse(json));
  const number = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  /** Key-value data shared by all users of the app (scope '') or of one class (scope = class id). */
  function sharedApi(store, scope, mayWrite) {
    const write = () => {
      if (!mayWrite) throw new ApiError('forbidden', 'Das dürfen nur die Lehrkraft bzw. die Besitzerin oder der Besitzer der App.');
    };
    return {
      get: (p) => decode(store.sharedGet(scope, key(p))),
      keys: () => store.sharedKeys(scope),
      set(p) {
        write();
        const k = key(p);
        const { json, size } = encode(p.value, L.saveValueBytes);
        const other = store.sharedUsage(scope, k);
        if (other.bytes + size > L.sharedTotalBytes || other.n >= L.saveKeys) throw new ApiError('quota', 'Der Speicher für gemeinsame Daten ist voll.');
        store.sharedPut(scope, k, json, size);
        return true;
      },
      remove(p) {
        write();
        store.sharedDelete(scope, key(p));
        return true;
      },
    };
  }

  /**
   * The validated schulhub.json of the code that is running: a version's stored
   * copy, or - for the owner's editor preview - the draft's file, parsed now.
   */
  function manifestFor(appRow, versionId) {
    if (versionId === 'draft') {
      const f = uploads.findDraftFile(appRow.id, 'schulhub.json');
      return f && f.size <= 64 * 1024 ? parseManifest(uploads.readBlob(f.sha256).toString('utf8')).manifest || manifestOf(null) : manifestOf(null);
    }
    return manifestOf(db.get('SELECT manifest FROM app_versions WHERE id = ? AND app_id = ?', versionId, appRow.id));
  }

  /**
   * All methods. Permissions are decided here; `store` only keeps data and is
   * always limited to this app (live tables, or memory during a preview).
   */
  function methods(appRow, user, classId, store, versionId) {
    const shared = sharedApi(store, '', appRow.owner_id === user.id || access.isAdmin(user));
    const needClass = () => {
      if (!classId) throw new ApiError('no_class', 'Die App wurde nicht aus einer Klasse heraus geöffnet.');
      return sharedApi(store, classId, access.canManageClass(user, classId));
    };
    let manifestCache = null;
    const manifest = () => (manifestCache = manifestCache || manifestFor(appRow, versionId));
    const achievementDef = (id) => manifest().achievements.find((a) => a.id === id);
    const publicAchievement = (def, at) =>
      def.secret && !at
        ? { id: def.id, title: 'Geheimer Erfolg', description: '', emoji: '❔', secret: true, unlocked: false, at: null }
        : { id: def.id, title: def.title, description: def.description, emoji: def.emoji, secret: def.secret, unlocked: Boolean(at), at: at || null };
    const fileName = (p) => {
      if (!p || typeof p.name !== 'string' || !KEY.test(p.name)) throw new ApiError('bad_key', 'Ungültiger Dateiname (erlaubt: Buchstaben, Ziffern, _ . : -, höchstens 64 Zeichen).');
      return p.name;
    };
    return {
      // ----- progress: one number 0..1 per person and app, shown to them and their teachers -----
      'progress.set': (p) => {
        const v = number(p && p.value);
        if (v === null) throw new ApiError('bad_value', 'Der Fortschritt muss eine Zahl zwischen 0 und 1 sein.');
        store.progressPut(Math.min(1, Math.max(0, v)), cleanText(p.label, 60));
        return true;
      },
      'progress.get': () => {
        const r = store.progressGet();
        return r ? { value: r.value, label: r.label, at: r.updated_at } : null;
      },

      // ----- achievements: only those declared in schulhub.json can be unlocked -----
      'achievements.list': () => {
        const unlocked = new Map(store.achievementsUnlocked().map((r) => [r.achievement, r.unlocked_at]));
        return manifest().achievements.map((def) => publicAchievement(def, unlocked.get(def.id)));
      },
      'achievements.unlock': (p) => {
        const id = p && typeof p.id === 'string' ? p.id : '';
        const def = KEY.test(id) && achievementDef(id);
        if (!def) throw new ApiError('unknown_achievement', 'Diesen Erfolg gibt es nicht. Erfolge stehen in schulhub.json unter "achievements".');
        const isNew = store.achievementPut(def.id);
        return { ...publicAchievement(def, Date.now()), new: isNew };
      },

      // ----- per-class settings: the teacher edits them in the Hub; apps only read -----
      'settings.all': () => {
        const row = classId ? db.get('SELECT value FROM class_app_settings WHERE class_id = ? AND app_id = ?', classId, appRow.id) : null;
        return effectiveSettings(manifest(), row ? JSON.parse(row.value) : null);
      },

      // ----- files (content travels through PUT/GET /_hub/files/<name>; these are the small calls) -----
      'files.list': () => store.fileList().map((f) => ({ name: f.name, type: f.type, size: f.size, updatedAt: f.updated_at })),
      'files.remove': (p) => store.fileDelete(fileName(p)),

      // ----- multiplayer: PREPARED, NOT ENABLED (see SECURITY.md "Still open") -----
      // The permission rule exists (access.canJoinRoom); a transport does not.
      'room.join': () => {
        throw new ApiError('not_available', 'Mehrspieler ist in diesem Hub noch nicht eingeschaltet.');
      },

      'save.get': (p) => decode(store.saveGet(key(p))),
      'save.keys': () => store.saveKeys(),
      'save.set': (p) => {
        const k = key(p);
        const { json, size } = encode(p.value, L.saveValueBytes);
        const other = store.saveUsage(k);
        if (other.bytes + size > L.saveTotalBytes || other.n >= L.saveKeys) throw new ApiError('quota', 'Dein Speicherplatz in dieser App ist voll.');
        store.savePut(k, json, size);
        return true;
      },
      'save.remove': (p) => {
        store.saveDelete(key(p));
        return true;
      },

      'shared.get': shared.get, 'shared.keys': shared.keys, 'shared.set': shared.set, 'shared.remove': shared.remove,
      'class.get': (p) => needClass().get(p), 'class.keys': () => needClass().keys(),
      'class.set': (p) => needClass().set(p), 'class.remove': (p) => needClass().remove(p),

      'scores.submit': (p) => {
        const board = key({ key: p && p.board });
        const score = number(p.score);
        if (score === null) throw new ApiError('bad_value', 'Die Punktzahl muss eine Zahl sein.');
        const old = store.scoreGet(board);
        if (old === null && !store.boardExists(board) && store.boardCount() >= L.boardsPerApp) throw new ApiError('quota', 'Diese App hat zu viele Bestenlisten.');
        const improved = old === null || (p.lowerIsBetter === true ? score < old : score > old);
        if (improved) store.scorePut(board, score);
        return { best: improved ? score : old, improved };
      },
      'scores.top': (p) => {
        const board = key({ key: p && p.board });
        const limit = Math.min(Math.max(Number.parseInt(p.limit, 10) || 10, 1), 100);
        const inClass = classId && p.scope !== 'all';
        const rows = store.top(board, { order: p.lowerIsBetter === true ? 'ASC' : 'DESC', limit, classId: inClass ? classId : '' });
        const mine = store.scoreGet(board);
        // Minors: a name is shown only to people who share a class with that
        // person, and only if they did not choose to be anonymous. Everyone
        // else (other classes, other teachers, the whole school) sees "Anonym".
        const nameFor = (r) => (r.user_id === user.id ? r.name : r.shares_class && !r.anonymous_scores ? r.name : 'Anonym');
        return {
          scope: inClass ? 'class' : 'all',
          entries: rows.map((r, i) => ({ rank: i + 1, name: nameFor(r), score: r.score, me: r.user_id === user.id })),
          me: mine === null ? null : { score: mine },
        };
      },

      'results.add': (p) => {
        const title = cleanText(p && p.title, 120) || 'Ergebnis';
        const details = p.details === undefined || p.details === null ? null : encode(p.details, L.resultBytes).json;
        store.resultAdd({ title, score: number(p.score), maxScore: number(p.maxScore), details, classId }, L.resultsPerUser);
        return true;
      },
      'results.mine': (p) => {
        const limit = Math.min(Math.max(Number.parseInt(p && p.limit, 10) || 20, 1), 100);
        return store
          .resultsMine(limit)
          .map((r) => ({ title: r.title, score: r.score, maxScore: r.max_score, details: r.details ? JSON.parse(r.details) : null, at: r.created_at }));
      },
    };
  }

  /** Who is calling, and which store their data goes to (memory for previews). */
  function caller(req, appRow) {
    // Same-origin calls only: a foreign page cannot use this API even with a stolen token header.
    const origin = req.headers.origin;
    if (origin && origin !== config.appOrigin(appRow.origin_key)) throw new ApiError('forbidden', 'Nicht erlaubt.', 403);
    const who = authenticate(req, appRow);
    if (!limiter.hit('sdk', `${who.user.id}:${appRow.id}`)) throw new ApiError('rate_limited', 'Zu viele Anfragen. Bitte kurz warten.', 429);
    const store = who.preview
      ? previewStores.previewStore(db, appRow, who.user, `${who.sid}:${appRow.id}:${who.versionId}`, L)
      : liveStore(db, appRow, who.user, { userFiles });
    return { ...who, store };
  }
  function apiFailure(res, err) {
    if (err instanceof ApiError || err instanceof FileError) return sendJson(res, err.status === 200 ? 200 : err.status, { ok: false, error: { code: err.code, message: err.message } });
    console.error(err);
    sendJson(res, 500, { ok: false, error: { code: 'server_error', message: 'Da ist etwas schiefgegangen.' } });
  }

  async function api(req, res, appRow) {
    try {
      const { user, classId, versionId, store } = caller(req, appRow);
      const body = await readJson(req, L.saveValueBytes + 4096);
      const table = methods(appRow, user, classId, store, versionId);
      const fn = body && typeof body.method === 'string' && Object.hasOwn(table, body.method) ? table[body.method] : null;
      if (!fn) throw new ApiError('unknown_method', 'Diese Funktion gibt es nicht.');
      const params = body.params && typeof body.params === 'object' ? body.params : {};
      sendJson(res, 200, { ok: true, result: fn(params) });
    } catch (err) {
      apiFailure(res, err);
    }
  }

  /** Raw request body, refused beyond `max` bytes. */
  function readBody(req, max) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size <= max) return chunks.push(c);
        chunks.length = 0;
        reject(new ApiError('too_large', `Die Datei ist zu groß (höchstens ${Math.round(max / 1024)} KB).`, 413));
        if (size > max * 4) req.destroy();
      });
      req.on('error', () => reject(new ApiError('bad_request', 'Ungültige Anfrage.', 400)));
      req.on('end', () => (size > max ? undefined : resolve(Buffer.concat(chunks))));
    });
  }

  /**
   * hub.files content: PUT /_hub/files/<name> stores one file for the calling
   * person, GET returns it. Same token, origin and rate rules as the API. The
   * stored type comes from a fixed list and is always sent with nosniff.
   */
  async function filesApi(req, res, appRow, rawName) {
    try {
      let name;
      try {
        name = decodeURIComponent(rawName);
      } catch {
        throw new ApiError('bad_key', 'Ungültiger Dateiname.');
      }
      if (!KEY.test(name)) throw new ApiError('bad_key', 'Ungültiger Dateiname (erlaubt: Buchstaben, Ziffern, _ . : -, höchstens 64 Zeichen).');
      const { user, store } = caller(req, appRow);
      if (req.method === 'PUT') {
        if (!limiter.hit('sdkFiles', `${user.id}:${appRow.id}`)) throw new ApiError('rate_limited', 'Zu viele Dateien in kurzer Zeit. Bitte kurz warten.', 429);
        const body = await readBody(req, L.fileBytes);
        return sendJson(res, 200, { ok: true, result: store.filePut(name, req.headers['content-type'], body) });
      }
      const f = store.fileGet(name);
      if (!f) return sendJson(res, 404, { ok: false, error: { code: 'not_found', message: 'Diese Datei gibt es nicht.' } });
      send(res, 200, f.data(), { 'Content-Type': f.type, 'Content-Disposition': 'attachment', 'Content-Length': f.size });
    } catch (err) {
      apiFailure(res, err);
    }
  }

  // ---------- entry point ----------
  return function handle(req, res, label) {
    try {
      const appRow = /^a[0-9a-f]{20}$/.test(label) ? db.get('SELECT * FROM apps WHERE origin_key = ?', label) : null;
      if (!appRow) return sendText(res, 404, 'Nicht gefunden.');
      const pathname = String(req.url).split('?')[0];
      if (pathname === '/_hub/info' && req.method === 'GET') return sendJson(res, 200, { hub: true, hubOrigin: config.hubOrigin });
      if (pathname === '/_hub/api' && req.method === 'POST') return void api(req, res, appRow);
      if (pathname.startsWith('/_hub/files/') && (req.method === 'GET' || req.method === 'PUT')) return void filesApi(req, res, appRow, pathname.slice(12));
      if (pathname.startsWith('/~') && (req.method === 'GET' || req.method === 'HEAD')) return serveFile(req, res, appRow, pathname.slice(2));
      return sendText(res, 404, 'Nicht gefunden.');
    } catch (err) {
      console.error(err);
      if (!res.headersSent) sendText(res, 500, 'Da ist etwas schiefgegangen.');
      else res.destroy();
    }
  };
}

module.exports = { createAppsHost };
