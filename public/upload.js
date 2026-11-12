// Upload of a new app version (folder or zip). The checks here are only for
// friendlier messages - the server validates every file again.
(function () {
  'use strict';
  var panel = document.getElementById('upload');
  if (!panel) return;
  var status = document.getElementById('upload-status');
  var csrf = document.querySelector('meta[name="csrf"]').content;
  var base = '/apps/' + encodeURIComponent(panel.dataset.app) + '/versionen';
  var busy = false;

  function show(text, kind, progress) {
    status.hidden = false;
    status.className = 'status' + (kind ? ' ' + kind : '');
    status.textContent = text;
    if (progress !== undefined) {
      var bar = document.createElement('progress');
      bar.max = 1;
      bar.value = progress;
      status.appendChild(bar);
    }
  }

  function request(method, url, body, type) {
    var headers = { Accept: 'application/json', 'X-CSRF-Token': csrf };
    if (type) headers['Content-Type'] = type;
    return fetch(url, { method: method, headers: headers, body: body }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || 'Der Upload hat nicht geklappt.');
        return data;
      });
    });
  }

  function done(number) {
    show('Version ' + number + ' ist hochgeladen. Die Seite wird neu geladen …', 'ok');
    setTimeout(function () { location.reload(); }, 900);
  }
  function failed(err) {
    busy = false;
    show(err.message || 'Der Upload hat nicht geklappt.', 'error');
  }
  var hidden = function (path) {
    return path.split('/').some(function (s) { return s.charAt(0) === '.' || s === '__MACOSX' || s === 'node_modules' || s === 'Thumbs.db'; });
  };

  document.getElementById('pick-folder').addEventListener('change', function (event) {
    if (busy) return;
    var files = Array.prototype.slice.call(event.target.files).map(function (f) {
      // drop the name of the chosen folder itself: "meinspiel/index.html" -> "index.html"
      var rel = f.webkitRelativePath || f.name;
      return { file: f, path: rel.indexOf('/') >= 0 ? rel.slice(rel.indexOf('/') + 1) : rel };
    }).filter(function (f) { return !hidden(f.path); });
    event.target.value = '';
    if (!files.length) return;

    var total = files.reduce(function (n, f) { return n + f.file.size; }, 0);
    if (!files.some(function (f) { return f.path === 'index.html'; })) return show('In diesem Ordner fehlt die Datei index.html (sie muss ganz oben im Ordner liegen).', 'error');
    if (files.length > Number(panel.dataset.maxFiles)) return show('Der Ordner enthält zu viele Dateien (' + files.length + ').', 'error');
    if (total > Number(panel.dataset.maxTotal)) return show('Der Ordner ist zu groß.', 'error');

    busy = true;
    show('Upload startet …', '', 0);
    request('POST', base, null).then(function (version) {
      var sent = 0;
      var next = 0;
      function worker() {
        if (next >= files.length) return Promise.resolve();
        var item = files[next++];
        return request('PUT', base + '/' + version.id + '/datei?pfad=' + encodeURIComponent(item.path), item.file, 'application/octet-stream').then(function () {
          sent++;
          show('Lade hoch: ' + sent + ' von ' + files.length + ' Dateien', '', sent / files.length);
          return worker();
        });
      }
      // a few uploads at a time
      return Promise.all([worker(), worker(), worker()]).then(function () {
        return request('POST', base + '/' + version.id + '/fertig', null);
      }).then(function (r) { done(r.number); });
    }).catch(failed);
  });

  document.getElementById('pick-zip').addEventListener('change', function (event) {
    if (busy) return;
    var file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    busy = true;
    show('Lade „' + file.name + '“ hoch und prüfe den Inhalt …');
    request('POST', base + '/zip', file, 'application/zip').then(function (r) { done(r.number); }).catch(failed);
  });
})();
