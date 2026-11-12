// Bridge between the Hub page and the app running in the sandboxed frame.
//
// The app (via hub-sdk.js) says "hello"; we answer with a short-lived token
// that the server issued for exactly this user in exactly this app.
// Messages are accepted only from the app's own origin AND only from our frame,
// and answers are sent only to that origin. In a preview, the SDK also sends
// its console messages here; they are shown as plain text (textContent).
(function () {
  'use strict';
  var stage = document.getElementById('stage');
  var frame = document.getElementById('appframe');
  var note = document.getElementById('player-note');
  var appOrigin = stage.dataset.origin;
  var csrf = document.querySelector('meta[name="csrf"]').content;

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

  // ------------------------------------------------------------ messages
  window.addEventListener('message', function (event) {
    if (event.origin !== appOrigin || event.source !== frame.contentWindow) return;
    var msg = event.data;
    if (!msg || typeof msg !== 'object') return;

    if (msg.hub === 'log') return log(msg);
    if (typeof msg.id !== 'string' || msg.id.length > 64) return;

    if (msg.hub === 'hello') {
      current.then(
        function (d) { reply({ hub: 'welcome', id: msg.id, token: d.token, expiresIn: d.expiresIn, mode: d.mode, user: d.user, class: d.class, app: d.app }); },
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
    frame.src = frame.src;
  }
  window.HubPlayer = { reload: reloadApp };

  // ------------------------------------------------------- loading, fullscreen
  frame.addEventListener('load', function () { stage.classList.add('ready'); });
  setTimeout(function () { stage.classList.add('ready'); }, 4000);

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
