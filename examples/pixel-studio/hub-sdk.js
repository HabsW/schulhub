/*!
 * SchulHub SDK
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
 *     });
 *   </script>
 *
 * Lokal als Lehrkraft testen: index.html?lehrkraft  (oder Hub.connect({ local: { isTeacher: true } }))
 */
(function (global) {
  'use strict';

  var HANDSHAKE_TIMEOUT = 15000;

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

    function call(method, params, retried) {
      return fetch('/_hub/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ method: method, params: params || {} }),
      }).then(function (res) {
        if (res.status === 401 && !retried) return refresh().then(function () { return call(method, params, true); });
        return res.json().then(function (data) {
          if (data && data.ok) return data.result;
          var err = (data && data.error) || {};
          throw HubError(err.code || 'error', err.message || 'Fehler');
        });
      });
    }

    return ask('hello').then(function (welcome) {
      token = welcome.token;
      // get a fresh token shortly before the current one runs out
      setInterval(function () { refresh().catch(function () {}); }, Math.max(60, welcome.expiresIn - 90) * 1000);
      return { call: call, mode: welcome.mode, user: welcome.user, class: welcome.class, app: welcome.app };
    });
  }

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
      } catch (e) { /* private mode: memory only */ }
    }
    function store(name) {
      return {
        get: function (p) { var all = read(name) || {}; return p.key in all ? all[p.key] : null; },
        keys: function () { return Object.keys(read(name) || {}).sort(); },
        set: function (p) { var all = read(name) || {}; all[p.key] = JSON.parse(JSON.stringify(p.value)); write(name, all); return true; },
        remove: function (p) { var all = read(name) || {}; delete all[p.key]; write(name, all); return true; },
      };
    }
    var save = store('save');
    var shared = store('shared');
    var cls = store('class');
    var rivals = [['Ada', 0.9], ['Linus', 0.6], ['Grace', 0.35]]; // pretend classmates

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
    };

    function call(method, params) {
      return new Promise(function (resolve, reject) {
        if (!methods[method]) return reject(HubError('unknown_method', 'Diese Funktion gibt es nicht.'));
        try { resolve(methods[method](params || {})); } catch (e) { reject(HubError('bad_value', String(e.message || e))); }
      });
    }
    if (global.console) console.info('[Hub SDK] Lokaler Modus: Testperson "' + user.name + '", Daten liegen nur in diesem Browser.');
    return Promise.resolve({ call: call, mode: 'local', user: user, class: { id: 'lokal-klasse', name: 'Testklasse' }, app: { name: global.document ? document.title : 'App', version: 0 } });
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
    return {
      /** 'live' (im Hub), 'preview' (private Vorschau im Hub) oder 'local' (auf deinem PC). */
      mode: b.mode,
      /** { id, name, isTeacher, isOwner } - die id ist in jeder App eine andere. */
      user: b.user,
      /** { id, name } der Klasse, aus der die App geöffnet wurde - oder null. */
      class: b.class,
      app: b.app,
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
        return info && info.hub === true && typeof info.hubOrigin === 'string' ? hubBackend(info.hubOrigin) : localBackend(options);
      })
      .then(buildApi);
    return connection;
  }

  global.Hub = { connect: connect, version: 1 };
})(typeof window !== 'undefined' ? window : this);
