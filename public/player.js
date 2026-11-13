// Bridge between the Hub page and the app running in the sandboxed frame.
//
// The app (via hub-sdk.js) says "hello"; we answer with a short-lived token
// that the server issued for exactly this user in exactly this app.
// Messages are accepted only from the app's own origin AND only from our frame,
// and answers are sent only to that origin. In a preview, the SDK also sends
// its console messages here; they are shown as plain text (textContent).
//
// Before the app's own code runs, the frame shows the Hub's start page on the
// app's origin (sdk/hub-start.js). It removes what an earlier person left in
// that origin's browser storage and then says where the app is; only then is
// the app loaded. The player keeps its frame in a <template> until this script
// points it at the start page; pages that embed a plain frame (review, editor)
// are sent to the start page by the app origin itself.
(function () {
  'use strict';
  var stage = document.getElementById('stage');
  var hold = document.getElementById('appframe-hold');
  var frame = document.getElementById('appframe');
  var note = document.getElementById('player-note');
  var appOrigin = stage.dataset.origin;
  var csrf = document.querySelector('meta[name="csrf"]').content;
  // True while the frame shows the start page (the player knows it does; elsewhere it may).
  var starting = Boolean(hold);
  if (!frame && hold) {
    frame = document.importNode(hold.content.firstElementChild, true);
    frame.setAttribute('src', hold.getAttribute('data-start'));
  }

  function fetchToken(first) {
    return fetch(stage.dataset.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ klasse: stage.dataset.class || null, version: stage.dataset.version || null, entwurf: stage.dataset.draft === '1', first: first }),
    }).then(function (res) {
      if (!res.ok) throw new Error('token');
      return res.json();
    });
  }

  function showNote() { if (note) note.hidden = false; }
  var current = fetchToken(true);
  current.catch(showNote);

  function reply(message) {
    frame.contentWindow.postMessage(message, appOrigin);
  }

  // ------------------------------------------------------------- console
  var consoleBox = document.getElementById('console');
  var consoleLog = document.getElementById('console-log');
  var toggle = document.getElementById('console-toggle');
  var counter = document.getElementById('console-count');
  var problems = 0;
  var lines = 0;
  var LEVELS = { log: 'log', info: 'info', warn: 'Warnung', error: 'Fehler' };

  function setOpen(open) {
    if (!consoleBox) return;
    consoleBox.hidden = !open;
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  if (toggle) toggle.addEventListener('click', function () { setOpen(consoleBox.hidden); });
  var clear = document.getElementById('console-clear');
  if (clear) clear.addEventListener('click', function () {
    consoleLog.textContent = '';
    problems = 0;
    lines = 0;
    counter.hidden = true;
  });

  function log(msg) {
    if (!consoleLog || lines >= 500) return;
    lines++;
    var level = Object.prototype.hasOwnProperty.call(LEVELS, msg.level) ? msg.level : 'log';
    var li = document.createElement('li');
    li.className = level;
    var lvl = document.createElement('span');
    lvl.className = 'lvl';
    lvl.textContent = LEVELS[level];
    var text = document.createElement('span');
    text.textContent = String(msg.text || '').slice(0, 2000);
    if (msg.where) {
      var where = document.createElement('span');
      where.className = 'where';
      where.textContent = '  ' + String(msg.where).slice(0, 200);
      text.appendChild(where);
    }
    li.append(lvl, text);
    consoleLog.appendChild(li);
    consoleLog.scrollTop = consoleLog.scrollHeight;
    if (level === 'warn' || level === 'error') {
      problems++;
      counter.textContent = String(problems);
      counter.hidden = false;
    }
  }

  // ------------------------------------------------------------ app start
  // The start page reports once the browser storage is ready, with the app's address (and repeats
  // that until the frame moves on). Only an address on this app's origin is loaded - the app could
  // navigate its own frame there anyway. replace(): no extra history entry for the start page.
  var startedBy = '';
  function startApp(msg) {
    if (msg.id === startedBy || typeof msg.next !== 'string') return;
    var url;
    try {
      url = new URL(msg.next, appOrigin);
    } catch (e) {
      return;
    }
    if (url.origin !== appOrigin || url.pathname.indexOf('/~') !== 0) return;
    startedBy = msg.id;
    starting = false;
    frame.contentWindow.location.replace(url.href);
  }

  // ------------------------------------------------------------ messages
  window.addEventListener('message', function (event) {
    if (event.origin !== appOrigin || event.source !== frame.contentWindow) return;
    var msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.hub === 'storage') {
      if (typeof msg.id === 'string' && msg.id.length <= 64) startApp(msg);
      return;
    }
    // The app is talking to us, so it has loaded (the frame's load event can be missed behind big scripts).
    stage.classList.add('ready');

    if (msg.hub === 'log') return log(msg);
    if (typeof msg.id !== 'string' || msg.id.length > 64) return;

    if (msg.hub === 'hello') {
      current.then(
        function (d) { reply({ hub: 'welcome', id: msg.id, token: d.token, expiresIn: d.expiresIn, mode: d.mode, user: d.user, class: d.class, app: d.app, theme: d.theme }); },
        function () { reply({ hub: 'error', id: msg.id }); }
      );
    } else if (msg.hub === 'refresh') {
      current = fetchToken(false);
      current.then(
        function (d) { reply({ hub: 'token', id: msg.id, token: d.token, expiresIn: d.expiresIn }); },
        function () { showNote(); reply({ hub: 'error', id: msg.id }); }
      );
    }
  });

  // The editor reloads the app after saving: <button data-reload-app>.
  document.addEventListener('click', function (event) {
    if (event.target.closest && event.target.closest('[data-reload-app]')) reloadApp();
  });
  function reloadApp() {
    stage.classList.remove('ready');
    starting = Boolean(hold);
    frame.src = frame.src; // the start page again (here or via the app origin)
  }
  window.HubPlayer = { reload: reloadApp };

  // ------------------------------------------------------------- favourite
  // Toggle in place: a page reload would end the round the person is playing.
  var fav = document.getElementById('favourite');
  if (fav && window.fetch) fav.addEventListener('submit', function (event) {
    event.preventDefault();
    var button = fav.querySelector('button');
    fetch(fav.action, { method: 'POST', headers: { Accept: 'application/json', 'X-CSRF-Token': csrf } })
      .then(function (res) { if (!res.ok) throw new Error('favourite'); return res.json(); })
      .then(function (d) {
        button.classList.remove('busy');
        button.removeAttribute('aria-busy');
        button.setAttribute('aria-pressed', d.favourite ? 'true' : 'false');
        button.setAttribute('aria-label', d.favourite ? 'Aus den Favoriten nehmen' : 'Zu den Favoriten');
        button.title = d.favourite ? 'Favorit' : 'Zu den Favoriten';
        var svg = button.querySelector('svg');
        if (svg) svg.classList.toggle('filled', d.favourite);
      })
      .catch(function () { fav.submit(); });
  });

  // ------------------------------------------------------- loading, fullscreen
  // The start page's own load does not count (the overlay fades anyway when it is missed).
  frame.addEventListener('load', function () { if (!starting) stage.classList.add('ready'); });
  setTimeout(function () { stage.classList.add('ready'); }, 4000);
  // Listeners are in place: now the player's frame may start (with the start page).
  if (hold) hold.replaceWith(frame);

  // Pages that embed the stage (review, editor) may leave out the fullscreen button.
  var fs = document.getElementById('fullscreen');
  if (fs) fs.addEventListener('click', function () {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (frame.requestFullscreen) frame.requestFullscreen().catch(function () {});
  });
  document.addEventListener('fullscreenchange', function () {
    if (fs) fs.setAttribute('aria-label', document.fullscreenElement ? 'Vollbild beenden' : 'Vollbild');
  });
})();
