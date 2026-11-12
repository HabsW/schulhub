// Upload of a new app version (package B): a folder or a zip, chosen with the
// keyboard-reachable file inputs or dropped on the drop zone; progress, cancel
// and retry. The checks here only give friendlier messages earlier - the server
// validates every file again. A failed or cancelled folder upload is removed on
// the server ("abbrechen"), so no unfinished version stays behind.
// Text is only ever set with textContent.
(function () {
  'use strict';

  // The "more" menu in the page head: following a link to a section closes it.
  document.addEventListener('click', function (event) {
    var link = event.target.closest && event.target.closest('.apps-more a[href^="#"]');
    if (link) {
      var menu = link.closest('details');
      if (menu) menu.removeAttribute('open');
    }
  });

  var panel = document.getElementById('upload');
  if (!panel) return;
  var zone = document.getElementById('dropzone');
  var statusBox = document.getElementById('upload-status');
  var statusText = document.getElementById('upload-text');
  var bar = document.getElementById('upload-progress');
  var cancelButton = document.getElementById('upload-cancel');
  var retryButton = document.getElementById('upload-retry');
  var noteField = document.getElementById('upload-note');
  var pickFolder = document.getElementById('pick-folder');
  var pickZip = document.getElementById('pick-zip');
  var csrf = document.querySelector('meta[name="csrf"]').content;
  var appId = panel.dataset.app;
  var base = '/apps/' + encodeURIComponent(appId) + '/versionen';
  var LIMIT = {
    files: Number(panel.dataset.maxFiles),
    file: Number(panel.dataset.maxFile),
    total: Number(panel.dataset.maxTotal),
    zip: Number(panel.dataset.maxZip),
  };
  var JUNK = ['__MACOSX', 'node_modules', 'Thumbs.db', 'desktop.ini'];

  var job = null; // the last upload that was started, for "Noch einmal versuchen"
  var run = null; // the upload in progress: { aborted, controller, xhr, versionId }

  // ----------------------------------------------------------------- helpers
  function mb(n) {
    var v = n / 1048576;
    return (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10).toString().replace('.', ',') + ' MB';
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function isJunk(path) {
    return path.split('/').some(function (s) { return s.charAt(0) === '.' || JUNK.indexOf(s) >= 0; });
  }
  function note() { return noteField ? noteField.value.slice(0, 500) : ''; }

  function show(text, state, progress) {
    statusBox.hidden = false;
    statusBox.className = 'apps-progress' + (state ? ' apps-progress-' + state : '');
    statusText.textContent = text;
    if (progress === null || progress === undefined) {
      bar.removeAttribute('value'); // indeterminate: "working"
    } else {
      bar.value = Math.max(0, Math.min(1, progress));
    }
    bar.hidden = state === 'error' || state === 'stopped';
  }

  function setBusy(on) {
    zone.classList.toggle('busy', on);
    [pickFolder, pickZip].forEach(function (input) {
      input.disabled = on;
      var label = input.closest('label');
      if (label) label.setAttribute('aria-disabled', on ? 'true' : 'false');
    });
    cancelButton.hidden = !on;
    retryButton.hidden = true;
    window.onbeforeunload = on ? function () { return true; } : null;
  }

  function request(method, url, body, type, signal) {
    var headers = { Accept: 'application/json', 'X-CSRF-Token': csrf };
    if (type) headers['Content-Type'] = type;
    return fetch(url, { method: method, headers: headers, body: body, signal: signal }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || 'Der Upload hat nicht geklappt.');
        return data;
      });
    });
  }

  function stopped() {
    var e = new Error('Upload abgebrochen.');
    e.name = 'AbortError';
    return e;
  }

  // ------------------------------------------------------------ the checks
  function checkFolder(files) {
    if (!files.length) return 'In diesem Ordner sind keine Dateien.';
    if (!files.some(function (f) { return f.path === 'index.html'; })) return 'In diesem Ordner fehlt die Datei index.html. Sie muss ganz oben im Ordner liegen, nicht in einem Unterordner.';
    if (files.length > LIMIT.files) return 'Der Ordner enthält zu viele Dateien (' + files.length + ', höchstens ' + LIMIT.files + ').';
    var big = files.filter(function (f) { return f.file.size > LIMIT.file; })[0];
    if (big) return '„' + big.path + '“ ist zu groß (' + mb(big.file.size) + ', höchstens ' + mb(LIMIT.file) + ' pro Datei).';
    var total = files.reduce(function (n, f) { return n + f.file.size; }, 0);
    if (total > LIMIT.total) return 'Der Ordner ist zu groß (' + mb(total) + ', höchstens ' + mb(LIMIT.total) + ').';
    return '';
  }
  function checkZip(file) {
    if (!/\.zip$/i.test(file.name)) return 'Bitte wähle eine ZIP-Datei (Endung .zip).';
    if (file.size > LIMIT.zip) return 'Das Archiv ist zu groß (' + mb(file.size) + ', höchstens ' + mb(LIMIT.zip) + ').';
    return '';
  }

  // ---------------------------------------------------------- the uploads
  function start(next) {
    if (run) return;
    var problem = next.kind === 'zip' ? checkZip(next.file) : checkFolder(next.files);
    job = next;
    if (problem) {
      show(problem, 'error');
      retryButton.hidden = true;
      cancelButton.hidden = true;
      return;
    }
    setBusy(true);
    if (next.kind === 'zip') uploadZip(next.file);
    else uploadFolder(next.files);
  }

  function uploadFolder(files) {
    var state = (run = { aborted: false, controller: new AbortController(), xhr: null, versionId: null });
    var signal = state.controller.signal;
    var total = files.reduce(function (n, f) { return n + f.file.size; }, 0);
    var sent = 0;
    var bytes = 0;
    var next = 0;
    show('Upload startet …', '', 0);
    request('POST', base, null, null, signal)
      .then(function (version) {
        state.versionId = version.id;
        function worker() {
          if (state.aborted) return Promise.reject(stopped());
          if (next >= files.length) return Promise.resolve();
          var item = files[next++];
          return request('PUT', base + '/' + encodeURIComponent(version.id) + '/datei?pfad=' + encodeURIComponent(item.path), item.file, 'application/octet-stream', signal).then(function () {
            sent++;
            bytes += item.file.size;
            show('Lade hoch: ' + sent + ' von ' + plural(files.length, 'Datei', 'Dateien'), '', total ? bytes / total : sent / files.length);
            return worker();
          });
        }
        // a few files at a time
        return Promise.all([worker(), worker(), worker()])
          .then(function () {
            show('Alle Dateien sind da. Die App wird geprüft …', '', null);
            return request('POST', base + '/' + encodeURIComponent(version.id) + '/fertig', JSON.stringify({ notiz: note() }), 'application/json', signal);
          })
          .then(function (result) { state.versionId = null; done(state, result); });
      })
      .catch(function (err) { failed(state, err); });
  }

  function uploadZip(file) {
    var state = (run = { aborted: false, controller: null, xhr: new XMLHttpRequest(), versionId: null });
    var xhr = state.xhr;
    show('Lade „' + file.name + '“ hoch …', '', 0);
    xhr.open('POST', base + '/zip?notiz=' + encodeURIComponent(note()));
    xhr.setRequestHeader('Content-Type', 'application/zip');
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.setRequestHeader('X-CSRF-Token', csrf);
    xhr.upload.onprogress = function (e) {
      if (e.lengthComputable) show('Lade „' + file.name + '“ hoch: ' + Math.round((e.loaded / e.total) * 100) + ' %', '', e.loaded / e.total);
    };
    xhr.upload.onload = function () { show('Die ZIP-Datei ist da. Sie wird entpackt und geprüft …', '', null); };
    xhr.onload = function () {
      var data = {};
      try { data = JSON.parse(xhr.responseText); } catch (e) { data = {}; }
      if (xhr.status >= 200 && xhr.status < 300) done(state, data);
      else failed(state, new Error(data.error || 'Der Upload hat nicht geklappt.'));
    };
    xhr.onerror = function () { failed(state, new Error('Die Verbindung ist abgebrochen. Bitte versuch es noch einmal.')); };
    xhr.onabort = function () { failed(state, stopped()); };
    xhr.send(file);
  }

  function done(state, result) {
    if (state !== run) return;
    run = null;
    window.onbeforeunload = null;
    cancelButton.hidden = true;
    show('Version ' + result.number + ' ist hochgeladen. Der Prüfbericht wird geladen …', 'ok', 1);
    // The page shows the new version with its check report.
    location.assign('/apps/' + encodeURIComponent(appId) + '?neu=' + encodeURIComponent(result.id) + '#hochgeladen');
  }

  function failed(state, err) {
    if (state !== run) return;
    run = null;
    if (state.controller) state.controller.abort();
    // An unfinished version is thrown away on the server (the zip route does this itself).
    if (state.versionId) request('POST', base + '/' + encodeURIComponent(state.versionId) + '/abbrechen', null).catch(function () {});
    setBusy(false);
    var aborted = state.aborted || (err && err.name === 'AbortError');
    show(aborted ? 'Upload abgebrochen. Es wurde nichts gespeichert.' : (err && err.message) || 'Der Upload hat nicht geklappt.', aborted ? 'stopped' : 'error');
    retryButton.hidden = !job;
  }

  cancelButton.addEventListener('click', function () {
    if (!run) return;
    run.aborted = true;
    if (run.controller) run.controller.abort();
    if (run.xhr) run.xhr.abort();
    else failed(run, stopped());
  });
  retryButton.addEventListener('click', function () { if (job && !run) start(job); });

  // ---------------------------------------------------- choosing the files
  pickFolder.addEventListener('change', function (event) {
    var chosen = Array.prototype.slice.call(event.target.files || []);
    event.target.value = '';
    if (!chosen.length) return;
    var files = chosen.map(function (f) {
      // drop the name of the chosen folder itself: "meinspiel/index.html" -> "index.html"
      var rel = f.webkitRelativePath || f.name;
      return { file: f, path: rel.indexOf('/') >= 0 ? rel.slice(rel.indexOf('/') + 1) : rel };
    }).filter(function (f) { return !isJunk(f.path); });
    start({ kind: 'folder', files: files });
  });

  pickZip.addEventListener('change', function (event) {
    var file = event.target.files[0];
    event.target.value = '';
    if (file) start({ kind: 'zip', file: file });
  });

  // ------------------------------------------------------- drag and drop
  function hasFiles(event) {
    var types = event.dataTransfer && event.dataTransfer.types;
    return Boolean(types) && Array.prototype.indexOf.call(types, 'Files') >= 0;
  }
  ['dragenter', 'dragover'].forEach(function (type) {
    zone.addEventListener(type, function (event) {
      if (!hasFiles(event) || run) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      zone.classList.add('over');
    });
  });
  zone.addEventListener('dragleave', function (event) {
    if (!zone.contains(event.relatedTarget)) zone.classList.remove('over');
  });

  /** Read a dropped folder (entries API) into { file, path } items, skipping hidden folders. */
  function readEntry(entry, prefix, out) {
    return new Promise(function (resolve, reject) {
      if (out.length > LIMIT.files || isJunk(prefix + entry.name)) return resolve();
      if (entry.isFile) {
        entry.file(function (f) { out.push({ file: f, path: prefix + entry.name }); resolve(); }, reject);
        return;
      }
      if (!entry.isDirectory) return resolve();
      readChildren(entry).then(function (children) {
        var chain = Promise.resolve();
        children.forEach(function (child) {
          chain = chain.then(function () { return readEntry(child, prefix + entry.name + '/', out); });
        });
        return chain;
      }).then(resolve, reject);
    });
  }
  function readChildren(dir) {
    var reader = dir.createReader();
    var all = [];
    return new Promise(function (resolve, reject) {
      (function batch() {
        reader.readEntries(function (list) {
          if (!list.length || all.length > LIMIT.files) return resolve(all);
          all = all.concat(Array.prototype.slice.call(list));
          batch();
        }, reject);
      })();
    });
  }

  zone.addEventListener('drop', function (event) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    zone.classList.remove('over');
    if (run) return;
    var dt = event.dataTransfer;
    var entries = [];
    if (dt.items && dt.items.length && typeof dt.items[0].webkitGetAsEntry === 'function') {
      for (var i = 0; i < dt.items.length; i++) {
        var entry = dt.items[i].webkitGetAsEntry();
        if (entry) entries.push(entry);
      }
    }
    var plain = Array.prototype.slice.call(dt.files || []);
    // One zip file: upload it as a zip.
    if (plain.length === 1 && /\.zip$/i.test(plain[0].name) && !(entries[0] && entries[0].isDirectory)) {
      start({ kind: 'zip', file: plain[0] });
      return;
    }
    if (!entries.length) {
      start({ kind: 'folder', files: plain.map(function (f) { return { file: f, path: f.name }; }).filter(function (f) { return !isJunk(f.path); }) });
      return;
    }
    show('Lese den Ordner …', '', null);
    var out = [];
    // One folder dropped: its content is the app. Several things dropped: they are the app's top level.
    var chain = entries.length === 1 && entries[0].isDirectory
      ? readChildren(entries[0]).then(function (children) {
        var c = Promise.resolve();
        children.forEach(function (child) { c = c.then(function () { return readEntry(child, '', out); }); });
        return c;
      })
      : entries.reduce(function (c, en) { return c.then(function () { return readEntry(en, '', out); }); }, Promise.resolve());
    chain.then(function () { start({ kind: 'folder', files: out }); }, function () {
      show('Der Ordner ließ sich nicht lesen. Wähle ihn bitte mit „Ordner auswählen“.', 'error');
    });
  });
})();
