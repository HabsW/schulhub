// SchulHub start page - runs on an app's own origin BEFORE the app's code, each time the Hub
// opens an app (GET /~<file token>/_hub/start, see src/appsHost.js). It is not part of the SDK:
// apps never load it, and an uploaded file of this name is never served in its place.
//
// Browser storage belongs to the app's origin, not to a person. On a shared school PC the next
// pupil would find what the previous one left: localStorage, sessionStorage, IndexedDB (where
// Godot and Unity save), caches, service workers, files and cookies. The page carries a marker
// for the person the Hub opens the app for - made by the server (an HMAC of person and app),
// never a name or an id, and different in every app. If localStorage holds a different marker
// (or none), everything is removed before the app runs. For the same person nothing is touched,
// so a pupil's own device keeps its saves. Then the page tells the Hub page - and only the Hub's
// origin - where the app is, and the Hub page loads it (public/player.js).
(function () {
  'use strict';
  var root = document.documentElement;
  var hubOrigin = root.getAttribute('data-hub');
  var person = root.getAttribute('data-person') || '';
  var next = root.getAttribute('data-next');
  var KEY = 'schulhub:person';
  // A browser API that never answers must not keep the app from starting.
  var LIMIT_MS = 3000;
  var started = Date.now();

  var known = null;
  try {
    known = window.localStorage.getItem(KEY);
  } catch (e) {
    known = null; // no storage here - then clearing is cheap and nothing can be kept anyway
  }
  var same = person !== '' && known === person;

  var work = same ? Promise.resolve(true) : clearAll();
  var limit = new Promise(function (resolve) { setTimeout(function () { resolve(false); }, LIMIT_MS); });
  Promise.race([work, limit]).then(finish, function () { finish(false); });

  function finish(complete) {
    // Only a finished cleanup is remembered; otherwise the next start clears again.
    if (complete === true && !same) {
      try { window.localStorage.setItem(KEY, person); } catch (e) { /* see above */ }
    }
    afterLoad(function () { announce(!same); });
  }

  // After this page's own load event, so the Hub page sees that load before the message.
  function afterLoad(fn) {
    if (document.readyState === 'complete') return void setTimeout(fn, 0);
    window.addEventListener('load', function () { setTimeout(fn, 0); });
  }

  function announce(cleared) {
    var message = { hub: 'storage', id: 's' + Math.random().toString(36).slice(2), next: next, cleared: cleared, ms: Date.now() - started };
    var sent = 0;
    (function send() {
      window.parent.postMessage(message, hubOrigin);
      // The Hub page may not listen yet (its script runs after its HTML); it ignores repeats.
      if (++sent < 120) setTimeout(send, 250);
    })();
  }

  // ------------------------------------------------------------------ clearing
  // Each step ends with true when nothing of an earlier person is left in that store - or when the
  // browser does not offer the store here, so no app could have used it - and false when it could
  // not finish. No step ever throws.

  function clearAll() {
    try { window.localStorage.clear(); } catch (e) { /* not available here */ }
    try { window.sessionStorage.clear(); } catch (e) { /* not available here */ }
    clearCookies();
    return Promise.all([safely(clearDatabases), safely(clearCaches), safely(clearWorkers), safely(clearFiles)]).then(function (done) {
      return done.every(Boolean);
    });
  }

  function safely(step) {
    return new Promise(function (resolve) {
      try {
        Promise.resolve(step()).then(function (ok) { resolve(ok !== false); }, function () { resolve(false); });
      } catch (e) {
        resolve(false);
      }
    });
  }

  // Cookies scripts can see, deleted with every Domain= an app could have used and in the variants
  // a cross-site frame needs. (The Hub never sets cookies on app origins, so all of them come from
  // apps.) Cookies with another path are invisible here - and to the app: its path holds a new token.
  function clearCookies() {
    var names = [];
    try {
      document.cookie.split(';').forEach(function (part) {
        var name = part.split('=')[0].trim();
        if (name && names.indexOf(name) < 0) names.push(name);
      });
    } catch (e) {
      return;
    }
    var labels = location.hostname.split('.');
    var domains = [''];
    for (var i = 0; i < labels.length - 1; i++) domains.push('; domain=' + labels.slice(i).join('.'));
    var variants = ['', '; secure; samesite=none', '; secure; samesite=none; partitioned'];
    names.forEach(function (name) {
      domains.forEach(function (domain) {
        variants.forEach(function (variant) {
          try {
            document.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; max-age=0; path=/' + domain + variant;
          } catch (e) { /* ignored: the next variant may work */ }
        });
      });
    });
  }

  // Names some engines use, for browsers without indexedDB.databases() (Firefox before 126).
  var KNOWN_DATABASES = ['/userfs', '/idbfs', '/home/web_user', 'UnityCache', 'localforage', 'keyval-store'];

  function clearDatabases() {
    var idb;
    try { idb = window.indexedDB; } catch (e) { return true; }
    if (!idb) return true;
    var listed = typeof idb.databases === 'function'
      ? idb.databases().then(function (list) {
          return list.map(function (d) { return d && d.name; }).filter(function (n) { return typeof n === 'string'; });
        }, function () { return KNOWN_DATABASES; })
      : Promise.resolve(KNOWN_DATABASES);
    return listed.then(function (names) {
      return Promise.all(names.map(function (name) {
        return new Promise(function (resolve) {
          var request;
          try {
            request = idb.deleteDatabase(name);
          } catch (e) {
            return resolve(true); // IndexedDB cannot be used here at all
          }
          request.onsuccess = function () { resolve(true); };
          request.onerror = function () { resolve(false); };
          // Still open in another tab: the deletion waits for it - and so does the app's own
          // indexedDB.open(), which never sees the old data. Not finished, so not remembered.
          request.onblocked = function () { resolve(false); };
        });
      }));
    }).then(function (done) { return done.every(Boolean); });
  }

  function clearCaches() {
    var store;
    try { store = window.caches; } catch (e) { return true; }
    if (!store) return true;
    return store.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) { return store.delete(k); })).then(function () { return true; }, function () { return false; });
    }, function () { return true; });
  }

  function clearWorkers() {
    var workers;
    try { workers = navigator.serviceWorker; } catch (e) { return true; }
    if (!workers || typeof workers.getRegistrations !== 'function') return true;
    return workers.getRegistrations().then(function (list) {
      return Promise.all(list.map(function (r) { return r.unregister(); })).then(function () { return true; }, function () { return false; });
    }, function () { return true; });
  }

  // The origin private file system (navigator.storage.getDirectory), used e.g. by SQLite in the browser.
  function clearFiles() {
    var storage = navigator.storage;
    if (!storage || typeof storage.getDirectory !== 'function') return true;
    return storage.getDirectory().then(function (dir) {
      if (typeof dir.keys !== 'function') return true;
      var names = [];
      var entries = dir.keys();
      function more() {
        return entries.next().then(function (step) {
          if (step.done) return null;
          names.push(step.value);
          return more();
        });
      }
      return more().then(function () {
        return Promise.all(names.map(function (name) { return dir.removeEntry(name, { recursive: true }); }));
      }).then(function () { return true; }, function () { return false; });
    }, function () { return true; });
  }
})();
