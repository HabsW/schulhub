// Bridge between the Hub page and the app running in the sandboxed frame.
//
// The app (via hub-sdk.js) says "hello"; we answer with a short-lived token
// that the server issued for exactly this user in exactly this app.
// Messages are accepted only from the app's own origin AND only from our frame,
// and answers are sent only to that origin.
(function () {
  'use strict';
  var player = document.getElementById('player');
  var frame = document.getElementById('appframe');
  var note = document.getElementById('player-note');
  var appOrigin = player.dataset.origin;
  var csrf = document.querySelector('meta[name="csrf"]').content;

  function fetchToken(first) {
    return fetch(player.dataset.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ klasse: player.dataset.class || null, version: player.dataset.version || null, first: first }),
    }).then(function (res) {
      if (!res.ok) throw new Error('token');
      return res.json();
    });
  }

  var current = fetchToken(true);
  current.catch(function () { note.hidden = false; });

  function reply(message) {
    frame.contentWindow.postMessage(message, appOrigin);
  }

  window.addEventListener('message', function (event) {
    if (event.origin !== appOrigin || event.source !== frame.contentWindow) return;
    var msg = event.data;
    if (!msg || typeof msg !== 'object' || typeof msg.id !== 'string' || msg.id.length > 64) return;

    if (msg.hub === 'hello') {
      current.then(
        function (d) { reply({ hub: 'welcome', id: msg.id, token: d.token, expiresIn: d.expiresIn, mode: d.mode, user: d.user, class: d.class, app: d.app }); },
        function () { reply({ hub: 'error', id: msg.id }); }
      );
    } else if (msg.hub === 'refresh') {
      current = fetchToken(false);
      current.then(
        function (d) { reply({ hub: 'token', id: msg.id, token: d.token, expiresIn: d.expiresIn }); },
        function () { note.hidden = false; reply({ hub: 'error', id: msg.id }); }
      );
    }
  });

  document.getElementById('fullscreen').addEventListener('click', function () {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (frame.requestFullscreen) frame.requestFullscreen();
  });
})();
