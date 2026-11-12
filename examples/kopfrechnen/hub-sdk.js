/*!
 * SchulHub SDK, Version 2
 *
 * Eine Datei, zwei Welten:
 *  - Im Hub:    echte Nutzer, Speichern pro Konto, Klassen, Bestenlisten.
 *  - Lokal:     auf deinem PC (Doppelklick auf index.html oder ein lokaler
 *               Webserver) funktioniert alles genauso - mit einer Testperson,
 *               gespeichert wird im Browser (localStorage).
 *
 * Benutzung:
 *   <script src="hub-sdk.js"></script>
 *   <script>
 *     Hub.connect().then(async (hub) => {
 *       console.log(hub.user.name);
 *       const stand = await hub.save.get('spielstand', { level: 1 });
 *       await hub.save.set('spielstand', { level: stand.level + 1 });
 *       await hub.progress.set(0.4, { label: 'Level 2 von 5' });
 *     });
 *   </script>
 *
 * Lokal als Lehrkraft testen: index.html?lehrkraft  (oder Hub.connect({ local: { isTeacher: true } }))
 * Die vollständige Anleitung steht im Hub unter "Selbst bauen".
 */
(function (global) {
  'use strict';

  var HANDSHAKE_TIMEOUT = 15000;
  var KEY = /^[A-Za-z0-9_.:-]{1,64}$/;

  function HubError(code, message) {
    var e = new Error(message || code);
    e.name = 'HubError';
    e.code = code;
    return e;
  }

  // ---------------------------------------------------------------- im Hub

  /** Talk to the Hub page that embeds us. Messages are only accepted from that exact origin. */
  function hubBackend(hubOrigin) {
    var token = null;
    var waiting = {}; // id -> { resolve, reject }
    var counter = 0;

    global.addEventListener('message', function (event) {
      if (event.origin !== hubOrigin || event.source !== global.parent) return;
      var msg = event.data;
      if (!msg || typeof msg !== 'object' || !waiting[msg.id]) return;
      var w = waiting[msg.id];
      delete waiting[msg.id];
      if (msg.hub === 'error') w.reject(HubError('session_expired', 'Die Sitzung ist abgelaufen. Bitte melde dich neu an.'));
      else w.resolve(msg);
    });

    function ask(type) {
      return new Promise(function (resolve, reject) {
        var id = 'm' + ++counter + '-' + Math.random().toString(36).slice(2);
        var done = false;
        var retry = null;
        var finish = function (fn, value) {
          if (done) return;
          done = true;
          clearInterval(retry);
          clearTimeout(timer);
          delete waiting[id];
          fn(value);
        };
        waiting[id] = { resolve: function (m) { finish(resolve, m); }, reject: function (e) { finish(reject, e); } };
        var post = function () { global.parent.postMessage({ hub: type, id: id }, hubOrigin); };
        post();
        retry = setInterval(post, 400); // the Hub page may still be loading
        var timer = setTimeout(function () { finish(reject, HubError('no_hub', 'Keine Antwort vom Hub.')); }, HANDSHAKE_TIMEOUT);
      });
    }

    function refresh() {
      return ask('refresh').then(function (m) { token = m.token; });
    }

    /** fetch with the current token; one automatic retry with a fresh token after 401. */
    function authed(url, init, retried) {
      init = init || {};
      var headers = init.headers || {};
      headers.Authorization = 'Bearer ' + token;
      init.headers = headers;
      return fetch(url, init).then(function (res) {
        if (res.status === 401 && !retried) return refresh().then(function () { return authed(url, init, true); });
        return res;
      });
    }
    function result(res) {
      return res.json().then(function (data) {
        if (data && data.ok) return data.result;
        var err = (data && data.error) || {};
        throw HubError(err.code || 'error', err.message || 'Fehler');
      });
    }

    function call(method, params) {
      return authed('/_hub/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: method, params: params || {} }),
      }).then(result);
    }

    var files = {
      put: function (name, body, type) {
        return authed('/_hub/files/' + encodeURIComponent(name), { method: 'PUT', headers: { 'Content-Type': type }, body: body }).then(result);
      },
      get: function (name) {
        return authed('/_hub/files/' + encodeURIComponent(name), { method: 'GET' }).then(function (res) {
          if (res.status === 404) return null;
          if (!res.ok) return result(res);
          return res.blob();
        });
      },
    };

    return ask('hello').then(function (welcome) {
      token = welcome.token;
      // get a fresh token shortly before the current one runs out
      setInterval(function () { refresh().catch(function () {}); }, Math.max(60, welcome.expiresIn - 90) * 1000);
      if (welcome.mode === 'preview') consoleTap.start(hubOrigin);
      else consoleTap.stop();
      return { call: call, files: files, mode: welcome.mode, user: welcome.user, class: welcome.class, app: welcome.app, theme: welcome.theme === 'light' || welcome.theme === 'dark' ? welcome.theme : 'auto' };
    });
  }

  /**
   * Console messages and errors of the app, for the Hub's console panel in a
   * preview. Captured from the moment this file loads (inside a frame), so
   * errors before Hub.connect() finishes are not lost; forwarded only once the
   * Hub says this is a preview, otherwise dropped. Text only, capped.
   */
  var consoleTap = (function () {
    var framed = global.parent && global.parent !== global;
    if (!framed || !global.console) return { start: function () {}, stop: function () {} };
    var buffer = [];
    var target = null; // hub origin once forwarding is on
    var sent = 0;
    var originals = {};
    function text(parts) {
      return parts.map(function (p) {
        if (p instanceof Error) return p.name + ': ' + p.message;
        if (typeof p === 'string') return p;
        try { return JSON.stringify(p); } catch (e) { return String(p); }
      }).join(' ').slice(0, 2000);
    }
    function emit(level, parts, where) {
      var msg = { hub: 'log', level: level, text: text(parts), where: where || '' };
      if (target) {
        if (sent >= 300) return;
        sent++;
        try { global.parent.postMessage(msg, target); } catch (e) { /* ignore */ }
      } else if (buffer && buffer.length < 100) buffer.push(msg);
    }
    ['log', 'info', 'warn', 'error'].forEach(function (level) {
      var original = global.console[level];
      if (!original) return;
      originals[level] = original;
      global.console[level] = function () {
        emit(level, Array.prototype.slice.call(arguments));
        return original.apply(global.console, arguments);
      };
    });
    function onError(e) {
      var where = e.filename ? String(e.filename).replace(/^.*\/~[^/]+\//, '') + ':' + e.lineno : '';
      emit('error', [e.message || 'Fehler'], where);
    }
    function onRejection(e) {
      emit('error', ['Unbehandelter Fehler: ', e.reason && e.reason.message ? e.reason.message : String(e.reason)]);
    }
    global.addEventListener('error', onError);
    global.addEventListener('unhandledrejection', onRejection);
    return {
      /** Preview: send what was captured so far, then forward live. */
      start: function (hubOrigin) {
        target = hubOrigin;
        var pending = buffer || [];
        buffer = null;
        pending.forEach(function (m) { if (sent < 300) { sent++; try { global.parent.postMessage(m, hubOrigin); } catch (e) { /* ignore */ } } });
      },
      /** Not a preview (or local mode): stop capturing and put the console back. */
      stop: function () {
        buffer = null;
        Object.keys(originals).forEach(function (k) { global.console[k] = originals[k]; });
        global.removeEventListener('error', onError);
        global.removeEventListener('unhandledrejection', onRejection);
      },
    };
  })();

  // ----------------------------------------------------------------- lokal

  /** Same behaviour as the Hub, but everything lives in this browser. */
  function localBackend(options) {
    var opt = (options && options.local) || {};
    var query = global.location ? global.location.search : '';
    var teacher = opt.isTeacher === true || /[?&](lehrkraft|lehrer|teacher)\b/.test(query);
    var user = { id: 'lokal-1', name: opt.name || (teacher ? 'Test-Lehrkraft' : 'Test-Schüler'), isTeacher: teacher, isOwner: true };
    var prefix = 'hub-lokal:' + (global.location ? global.location.pathname.replace(/[^/]*$/, '') : '') + ':';
    var memory = {};

    function read(k) {
      try {
        var raw = global.localStorage.getItem(prefix + k);
        return raw === null ? (k in memory ? memory[k] : null) : JSON.parse(raw);
      } catch (e) {
        return k in memory ? memory[k] : null;
      }
    }
    function write(k, v) {
      memory[k] = v;
      try {
        if (v === null) global.localStorage.removeItem(prefix + k);
        else global.localStorage.setItem(prefix + k, JSON.stringify(v));
      } catch (e) { /* private mode or full: memory only */ }
    }
    function checkKey(k) {
      if (typeof k !== 'string' || !KEY.test(k)) throw HubError('bad_key', 'Ungültiger Schlüssel (erlaubt: Buchstaben, Ziffern, _ . : -, höchstens 64 Zeichen).');
      return k;
    }
    function store(name) {
      return {
        get: function (p) { var all = read(name) || {}; return checkKey(p.key) in all ? all[p.key] : null; },
        keys: function () { return Object.keys(read(name) || {}).sort(); },
        set: function (p) { var all = read(name) || {}; all[checkKey(p.key)] = JSON.parse(JSON.stringify(p.value)); write(name, all); return true; },
        remove: function (p) { var all = read(name) || {}; delete all[checkKey(p.key)]; write(name, all); return true; },
      };
    }
    var save = store('save');
    var shared = store('shared');
    var cls = store('class');
    var rivals = [['Ada', 0.9], ['Linus', 0.6], ['Grace', 0.35]]; // pretend classmates

    // schulhub.json (achievements, settings): passed in (works on file://), or read from a local web server.
    var manifest = (opt.manifest && typeof opt.manifest === 'object' ? Promise.resolve(opt.manifest) : global.fetch && global.location && /^https?:$/.test(global.location.protocol)
      ? fetch('schulhub.json', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
      : Promise.resolve(null)
    ).then(function (m) {
      if (!m && global.console) console.info('[Hub SDK] Keine schulhub.json gefunden (per Doppelklick geöffnet?). Tipp: Hub.connect({ local: { manifest: {...} } }). Erfolge werden lokal ohne Prüfung angenommen.');
      return m || null;
    });

    var methods = {
      'save.get': save.get, 'save.keys': save.keys, 'save.set': save.set, 'save.remove': save.remove,
      'shared.get': shared.get, 'shared.keys': shared.keys, 'shared.set': shared.set, 'shared.remove': shared.remove,
      'class.get': cls.get, 'class.keys': cls.keys, 'class.set': cls.set, 'class.remove': cls.remove,
      'scores.submit': function (p) {
        var all = read('scores') || {};
        var old = p.board in all ? all[p.board] : null;
        var improved = old === null || (p.lowerIsBetter ? p.score < old : p.score > old);
        if (improved) { all[p.board] = p.score; write('scores', all); }
        return { best: improved ? p.score : old, improved: improved };
      },
      'scores.top': function (p) {
        var all = read('scores') || {};
        var mine = p.board in all ? all[p.board] : null;
        var list = mine === null ? [] : [{ name: user.name, score: mine, me: true }];
        if (mine !== null) rivals.forEach(function (r) {
          list.push({ name: r[0], score: Math.round(p.lowerIsBetter ? mine / r[1] : mine * r[1] + 1), me: false });
        });
        list.sort(function (a, b) { return p.lowerIsBetter ? a.score - b.score : b.score - a.score; });
        list = list.slice(0, p.limit || 10).map(function (e, i) { e.rank = i + 1; return e; });
        return { scope: 'class', entries: list, me: mine === null ? null : { score: mine } };
      },
      'results.add': function (p) {
        var all = read('results') || [];
        all.unshift({ title: String(p.title || 'Ergebnis'), score: typeof p.score === 'number' ? p.score : null, maxScore: typeof p.maxScore === 'number' ? p.maxScore : null, details: p.details === undefined ? null : p.details, at: Date.now() });
        write('results', all.slice(0, 100));
        return true;
      },
      'results.mine': function (p) { return (read('results') || []).slice(0, (p && p.limit) || 20); },
      'progress.set': function (p) {
        if (typeof p.value !== 'number' || !isFinite(p.value)) throw HubError('bad_value', 'Der Fortschritt muss eine Zahl zwischen 0 und 1 sein.');
        write('progress', { value: Math.min(1, Math.max(0, p.value)), label: String(p.label || '').slice(0, 60), at: Date.now() });
        return true;
      },
      'progress.get': function () { return read('progress'); },
      'achievements.list': function () {
        return manifest.then(function (m) {
          var got = read('achievements') || {};
          return ((m && m.achievements) || []).map(function (a) {
            return { id: a.id, title: a.title, description: a.description || '', emoji: a.emoji || '🏅', secret: a.secret === true, unlocked: Boolean(got[a.id]), at: got[a.id] || null };
          });
        });
      },
      'achievements.unlock': function (p) {
        return manifest.then(function (m) {
          var defs = (m && m.achievements) || null;
          var def = defs ? defs.filter(function (a) { return a.id === p.id; })[0] : { id: checkKey(p.id), title: p.id };
          if (!def) throw HubError('unknown_achievement', 'Diesen Erfolg gibt es nicht. Erfolge stehen in schulhub.json unter "achievements".');
          var got = read('achievements') || {};
          var isNew = !got[def.id];
          if (isNew) { got[def.id] = Date.now(); write('achievements', got); }
          return { id: def.id, title: def.title, description: def.description || '', emoji: def.emoji || '🏅', unlocked: true, at: got[def.id], new: isNew };
        });
      },
      'settings.all': function () {
        return manifest.then(function (m) {
          var out = {};
          ((m && m.settings) || []).forEach(function (s) { out[s.key] = s.default === undefined ? null : s.default; });
          var o = opt.settings || {};
          Object.keys(o).forEach(function (k) { out[k] = o[k]; });
          return out;
        });
      },
      'files.list': function () {
        var all = read('files') || {};
        return Object.keys(all).sort().map(function (k) { return { name: k, type: all[k].type, size: all[k].size, updatedAt: all[k].at }; });
      },
      'files.remove': function (p) { var all = read('files') || {}; var had = checkKey(p.name) in all; delete all[p.name]; write('files', all); return had; },
      'room.join': function () { throw HubError('not_available', 'Mehrspieler ist in diesem Hub noch nicht eingeschaltet.'); },
    };

    function call(method, params) {
      return new Promise(function (resolve, reject) {
        if (!methods[method]) return reject(HubError('unknown_method', 'Diese Funktion gibt es nicht.'));
        try { resolve(methods[method](params || {})); } catch (e) { reject(e && e.name === 'HubError' ? e : HubError('bad_value', String(e.message || e))); }
      });
    }

    // Local files: base64 in localStorage (small; the Hub allows more).
    var files = {
      put: function (name, body, type) {
        return new Blob([body]).arrayBuffer().then(function (buf) {
          checkKey(name);
          var bytes = new Uint8Array(buf);
          if (bytes.length > 1024 * 1024) throw HubError('too_large', 'Die Datei ist zu groß (höchstens 1024 KB).');
          var bin = '';
          for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
          var all = read('files') || {};
          all[name] = { type: type, size: bytes.length, data: global.btoa(bin), at: Date.now() };
          write('files', all);
          return { name: name, type: type, size: bytes.length };
        });
      },
      get: function (name) {
        var f = (read('files') || {})[name];
        if (!f) return Promise.resolve(null);
        var bin = global.atob(f.data);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return Promise.resolve(new Blob([bytes], { type: f.type }));
      },
    };

    if (global.console) console.info('[Hub SDK] Lokaler Modus: Testperson "' + user.name + '", Daten liegen nur in diesem Browser.');
    return Promise.resolve({ call: call, files: files, mode: 'local', user: user, class: { id: 'lokal-klasse', name: 'Testklasse' }, app: { name: global.document ? document.title : 'App', version: 0 }, theme: opt.theme === 'light' || opt.theme === 'dark' ? opt.theme : 'auto' });
  }

  // ------------------------------------------------------------------- API

  function buildApi(b) {
    function kv(prefix) {
      return {
        /** Wert lesen. Gibt `fallback` zurück, wenn noch nichts gespeichert ist. */
        get: function (key, fallback) {
          return b.call(prefix + '.get', { key: key }).then(function (v) { return v === null || v === undefined ? (fallback === undefined ? null : fallback) : v; });
        },
        /** Wert speichern (alles, was sich als JSON darstellen lässt). */
        set: function (key, value) { return b.call(prefix + '.set', { key: key, value: value }); },
        remove: function (key) { return b.call(prefix + '.remove', { key: key }); },
        keys: function () { return b.call(prefix + '.keys', {}); },
      };
    }
    function typeOf(data, options) {
      if (options && options.type) return String(options.type);
      if (typeof Blob !== 'undefined' && data instanceof Blob && data.type) return data.type;
      if (typeof data === 'string') return 'text/plain';
      return 'application/octet-stream';
    }
    var settingsCache = null;
    var settings = function () { return (settingsCache = settingsCache || b.call('settings.all', {})); };

    return {
      /** 'live' (im Hub), 'preview' (Vorschau im Hub: nichts wird dauerhaft gespeichert) oder 'local' (auf deinem PC). */
      mode: b.mode,
      /** { id, name, isTeacher, isOwner } - die id ist in jeder App eine andere. */
      user: b.user,
      /** { id, name } der Klasse, aus der die App geöffnet wurde - oder null. */
      class: b.class,
      app: b.app,
      /** Darstellung, die die Person im Hub gewählt hat: 'dark', 'light' oder 'auto' (wie das Gerät). Mit hub-ui.css wird sie automatisch übernommen. */
      theme: b.theme,
      /** Spielstand NUR für diese Person in dieser App. */
      save: kv('save'),
      /** Daten für ALLE, die die App nutzen. Lesen: alle. Schreiben: Besitzer/in der App. */
      shared: kv('shared'),
      /** Daten für EINE Klasse. Lesen: die Klasse. Schreiben: die Lehrkraft der Klasse. */
      classData: kv('class'),
      leaderboard: {
        /** Punktzahl melden. Es zählt immer der beste Wert. { lowerIsBetter: true } für Zeiten. */
        submit: function (board, score, options) {
          return b.call('scores.submit', { board: board, score: score, lowerIsBetter: Boolean(options && options.lowerIsBetter) });
        },
        /** Bestenliste lesen: { entries: [{ rank, name, score, me }], me, scope }. */
        top: function (board, options) {
          var o = options || {};
          return b.call('scores.top', { board: board, limit: o.limit || 10, scope: o.scope, lowerIsBetter: Boolean(o.lowerIsBetter) });
        },
      },
      results: {
        /** Ein Ergebnis festhalten, das auch die Lehrkraft sieht: { title, score, maxScore, details }. */
        add: function (result) { return b.call('results.add', result || {}); },
        mine: function (options) { return b.call('results.mine', options || {}); },
      },
      progress: {
        /** Fortschritt von 0 bis 1 (z. B. 0.4 = 40 %). Erscheint auf der Startseite und bei der Lehrkraft. */
        set: function (value, options) { return b.call('progress.set', { value: value, label: options && options.label }); },
        /** { value, label, at } oder null. */
        get: function () { return b.call('progress.get', {}); },
      },
      achievements: {
        /** Einen Erfolg freischalten, der in schulhub.json steht. Ergebnis: { id, title, emoji, new }. */
        unlock: function (id) { return b.call('achievements.unlock', { id: id }); },
        /** Alle Erfolge dieser App mit { unlocked, at } für diese Person. */
        list: function () { return b.call('achievements.list', {}); },
      },
      settings: {
        /** Alle Einstellungen der Klasse (die Lehrkraft stellt sie im Hub ein; sonst die Standardwerte aus schulhub.json). */
        all: function () { return settings(); },
        /** Eine Einstellung lesen. */
        get: function (key, fallback) {
          return settings().then(function (all) { return all && Object.prototype.hasOwnProperty.call(all, key) && all[key] !== null ? all[key] : (fallback === undefined ? null : fallback); });
        },
      },
      files: {
        /** Datei speichern (PNG, JPEG, WebP, GIF, JSON, Text, CSV; höchstens 1 MB). data: Blob, ArrayBuffer, Uint8Array oder Text. */
        put: function (name, data, options) { return b.files.put(name, data, typeOf(data, options)); },
        /** Datei lesen: ein Blob, oder null. */
        get: function (name) { return b.files.get(name); },
        /** [{ name, type, size, updatedAt }] */
        list: function () { return b.call('files.list', {}); },
        remove: function (name) { return b.call('files.remove', { name: name }); },
      },
      /**
       * Mehrspieler-Raum in der Klasse - VORBEREITET, NOCH NICHT EINGESCHALTET.
       * Geplant: hub.room('runde-1', { maxPlayers: 4 }) -> { me, players, send(data), on('message' | 'join' | 'leave', fn), leave() }.
       * Heute endet der Aufruf immer mit dem Fehlercode 'not_available'.
       */
      room: function (name, options) {
        return b.call('room.join', { name: name, maxPlayers: options && options.maxPlayers }).then(function () {
          throw HubError('not_available', 'Mehrspieler ist in diesem Hub noch nicht eingeschaltet.');
        });
      },
    };
  }

  var connection = null;

  /** Verbindet mit dem Hub - oder startet den lokalen Modus. Gibt immer dasselbe Promise zurück. */
  function connect(options) {
    if (connection) return connection;
    var framed = global.parent && global.parent !== global;
    var detect = framed && typeof fetch === 'function' && /^https?:$/.test(global.location.protocol)
      ? fetch('/_hub/info', { cache: 'no-store' })
          .then(function (res) { return res.ok ? res.json() : null; })
          .catch(function () { return null; })
      : Promise.resolve(null);
    connection = detect
      .then(function (info) {
        if (info && info.hub === true && typeof info.hubOrigin === 'string') return hubBackend(info.hubOrigin);
        consoleTap.stop();
        return localBackend(options);
      })
      .then(buildApi)
      .then(function (hub) {
        // Apps that use the UI kit (body.hub-ui) follow the theme chosen in the Hub.
        var doc = global.document;
        if (doc && doc.body && doc.body.classList.contains('hub-ui') && hub.theme !== 'auto') doc.documentElement.setAttribute('data-theme', hub.theme);
        return hub;
      });
    return connection;
  }

  global.Hub = { connect: connect, version: 2 };
})(typeof window !== 'undefined' ? window : this);
