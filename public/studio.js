// The editor (/studio/:id): file tree, CodeMirror on the app's draft, saving
// through the draft file API, and the live preview (the stage itself is run
// by player.js). Nothing here decides anything - the server checks every
// request. File names and messages are only ever set with textContent; code
// only lives inside CodeMirror's document and runs in the sandboxed preview
// on the app's own origin.
(function () {
  'use strict';
  var root = document.getElementById('studio');
  if (!root || !window.HubEditor) return;

  var $ = function (id) { return document.getElementById(id); };
  var csrf = document.querySelector('meta[name="csrf"]').content;
  var base = '/studio/' + encodeURIComponent(root.dataset.app);
  var tree = $('studio-tree');
  var stateEl = $('studio-state');
  var stateText = stateEl.querySelector('.studio-state-text');
  var stateShort = stateEl.querySelector('.studio-state-short');
  var fileMenu = $('studio-file-menu');
  var fileName = $('studio-file-name');
  var editorBox = $('studio-editor');
  var info = $('studio-info');
  var blank = $('studio-blank');
  var filesPane = $('studio-files');
  var codePane = root.querySelector('.studio-code');
  var previewPane = root.querySelector('.studio-preview');
  var scrim = root.querySelector('.studio-scrim');
  var toasts = $('studio-toasts');
  var icons = $('studio-icons').content;
  var stage = $('stage');
  var frame = $('appframe');

  var EDIT_MAX = 1024 * 1024;
  var TOKEN_MS = 45 * 60 * 1000; // the preview's file token lasts an hour
  var HTML_STARTER = '<!doctype html>\n<html lang="de">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>Neue Seite</title>\n<link rel="stylesheet" href="hub-ui.css">\n</head>\n<body class="hub-ui">\n<main class="hub-page">\n  <h1>Neue Seite</h1>\n</main>\n<script src="hub-sdk.js"></script>\n</body>\n</html>\n';

  var files = [];   // [{ path, size, text }] as the server sent them
  var buffers = {}; // path -> { state: EditorState | null, saved: Text, dirty: bool }
  var current = null;
  var opening = null;
  var saving = null; // the running save (a Promise)
  var leaving = false;
  var tokenAt = Date.now();
  var view = 'code';
  var filesOpen = false;
  var phone = window.matchMedia('(max-width: 719.98px)');
  var wide = window.matchMedia('(min-width: 1200px)');

  // ------------------------------------------------------------- helpers
  function request(method, url, body, type) {
    var headers = { Accept: 'application/json', 'X-CSRF-Token': csrf };
    if (type) headers['Content-Type'] = type;
    return fetch(url, { method: method, headers: headers, body: body, credentials: 'same-origin' }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.ok) return data;
        var err = new Error(res.status === 401
          ? 'Deine Sitzung ist abgelaufen. Kopiere deine Änderungen, lade die Seite neu und melde dich an.'
          : data.error || 'Das hat nicht geklappt. Bitte versuche es noch einmal.');
        err.status = res.status;
        throw err;
      });
    });
  }
  function fileUrl(path, extra) { return base + '/datei?pfad=' + encodeURIComponent(path) + (extra || ''); }
  function postJson(url, data) { return request('POST', url, JSON.stringify(data), 'application/json'); }
  function find(path) {
    for (var i = 0; i < files.length; i++) if (files[i].path === path) return files[i];
    return null;
  }
  function findLoose(path) {
    var lower = path.toLowerCase();
    for (var i = 0; i < files.length; i++) if (files[i].path.toLowerCase() === lower) return files[i];
    return null;
  }
  function icon(name) { return icons.querySelector('[data-icon="' + name + '"] svg').cloneNode(true); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1).replace('.', ',') + ' KB';
    return (n / 1048576).toFixed(1).replace('.', ',') + ' MB';
  }
  function dirtyPaths() { return Object.keys(buffers).filter(function (p) { return buffers[p].dirty; }); }
  function closeMenus() {
    document.querySelectorAll('details.menu[open]').forEach(function (d) { d.removeAttribute('open'); });
  }

  // -------------------------------------------------------------- toasts
  function toast(text, tone) {
    var box = el('div', 'notice studio-toast ' + (tone === 'error' ? 'danger' : 'ok'));
    box.setAttribute('role', tone === 'error' ? 'alert' : 'status');
    box.appendChild(icon(tone === 'error' ? 'alert' : 'checkCircle'));
    var body = el('div', 'notice-body');
    body.appendChild(el('span', '', text));
    box.appendChild(body);
    toasts.appendChild(box);
    dismissLater(box, tone === 'error' ? 12000 : 4000);
  }
  function dismissLater(box, ms) { setTimeout(function () { box.remove(); }, ms); }
  toasts.addEventListener('click', function (event) {
    var box = event.target.closest('.studio-toast');
    if (box) box.remove();
  });
  toasts.querySelectorAll('.studio-toast').forEach(function (box) { dismissLater(box, box.classList.contains('danger') ? 15000 : 6000); });

  // ------------------------------------------------------------- editor
  var editor = window.HubEditor.create(editorBox, {
    doc: '',
    language: 'text',
    ariaLabel: 'Quelltext',
    onChange: function (ed, update) {
      var b = buffers[current];
      if (!b) return;
      var dirty = !update.state.doc.eq(b.saved);
      if (dirty === b.dirty) return; // only redraw the state when it changes
      b.dirty = dirty;
      refreshState();
    },
    onSave: function () { saveQuietly(); },
  });

  /** Keep the open file's editor state (text, undo history, cursor) when switching. */
  function stash() {
    if (current && buffers[current] && !editorBox.hidden) buffers[current].state = editor.view.state;
  }
  function docOf(path) {
    return path === current && !editorBox.hidden ? editor.view.state.doc : buffers[path].state.doc;
  }

  // ---------------------------------------------------------- the state
  var shownState = '';
  function refreshState(busy) {
    var dirty = dirtyPaths().length > 0;
    var text = busy ? 'Speichert …' : dirty ? 'Nicht gespeichert' : 'Gespeichert';
    stateEl.classList.toggle('ok', !busy && !dirty);
    stateEl.classList.toggle('wait', !busy && dirty);
    if (text !== shownState) {
      stateText.textContent = shownState = text;
      stateShort.textContent = busy ? 'Speichert …' : dirty ? 'Geändert' : 'Gespeichert'; // phones: a short word
    }
    tree.querySelectorAll('.studio-file').forEach(function (b) {
      var buf = buffers[b.getAttribute('data-path')];
      b.querySelector('.studio-dot').hidden = !(buf && buf.dirty);
    });
  }

  // --------------------------------------------------------------- tree
  function readTree() {
    files = Array.prototype.map.call(tree.querySelectorAll('.studio-file'), function (b) {
      return { path: b.getAttribute('data-path'), size: Number(b.getAttribute('data-size')) || 0, text: b.getAttribute('data-text') === '1' };
    });
  }

  /** Same markup as the server renders (src/routes/studio.js), built with DOM methods. */
  function renderTree() {
    var top = { dirs: {}, names: [], files: [] };
    files.forEach(function (f) {
      var parts = f.path.split('/');
      var node = top;
      for (var i = 0; i < parts.length - 1; i++) {
        if (!node.dirs[parts[i]]) {
          node.dirs[parts[i]] = { dirs: {}, names: [], files: [] };
          node.names.push(parts[i]);
        }
        node = node.dirs[parts[i]];
      }
      node.files.push({ f: f, name: parts[parts.length - 1] });
    });
    function build(node, list) {
      node.names.forEach(function (name) {
        var li = el('li', 'studio-dir');
        var label = el('span', 'studio-dir-name');
        label.append(icon('folder'), el('span', '', name));
        var sub = el('ul', 'studio-tree studio-subtree');
        sub.setAttribute('role', 'list');
        build(node.dirs[name], sub);
        li.append(label, sub);
        list.appendChild(li);
      });
      node.files.forEach(function (x) {
        var li = el('li');
        var b = el('button', 'studio-file');
        b.type = 'button';
        b.setAttribute('data-path', x.f.path);
        b.setAttribute('data-size', String(x.f.size));
        b.setAttribute('data-text', x.f.text ? '1' : '');
        var dot = el('span', 'studio-dot');
        dot.hidden = true;
        dot.appendChild(el('span', 'visually-hidden', ', nicht gespeichert'));
        b.append(icon(x.f.text ? 'fileCode' : 'file'), el('span', 'studio-file-label', x.name), dot);
        li.appendChild(b);
        list.appendChild(li);
      });
    }
    tree.replaceChildren();
    build(top, tree);
    $('studio-tree-empty').hidden = files.length > 0;
    $('studio-file-count').textContent = files.length === 1 ? '1 Datei' : files.length + ' Dateien';
    $('studio-noindex').hidden = Boolean(find('index.html'));
    markCurrent();
    refreshState();
  }
  function setFiles(list) {
    files = list;
    renderTree();
  }
  function markCurrent() {
    tree.querySelectorAll('.studio-file').forEach(function (b) {
      if (b.getAttribute('data-path') === current) b.setAttribute('aria-current', 'true');
      else b.removeAttribute('aria-current');
    });
    fileName.textContent = current || '';
    fileMenu.hidden = !current;
  }

  // ------------------------------------------------------------ opening
  function show(which) {
    editorBox.hidden = which !== 'editor';
    info.hidden = which !== 'info';
    blank.hidden = which !== 'blank';
  }
  var KINDS = [
    [/\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)$/i, 'Bild', function (p) { return '<img src="' + p + '" alt="">'; }],
    [/\.(mp3|ogg|oga|wav|m4a|flac)$/i, 'Ton', function (p) { return "new Audio('" + p + "').play();"; }],
    [/\.(mp4|webm)$/i, 'Video', function (p) { return '<video src="' + p + '" controls></video>'; }],
    [/\.(woff2?|ttf|otf)$/i, 'Schrift', function (p) { return "@font-face { font-family: 'Meine Schrift'; src: url('" + p + "'); }"; }],
  ];
  function showInfo(f, message) {
    stash();
    current = f.path;
    show('info');
    var kind = null;
    for (var i = 0; i < KINDS.length; i++) if (KINDS[i][0].test(f.path)) kind = KINDS[i];
    $('studio-info-name').textContent = f.path;
    $('studio-info-meta').textContent = (kind ? kind[1] : 'Datei') + ' · ' + formatBytes(f.size);
    $('studio-info-text').textContent = message || (kind
      ? 'Der Editor zeigt nur Text. So bindest du die Datei in deine App ein:'
      : 'Diese Datei kann der Editor nicht anzeigen. Deine App kann sie trotzdem benutzen.');
    var snippet = $('studio-info-snippet');
    snippet.hidden = !kind || Boolean(message);
    snippet.textContent = kind && !message ? kind[2](f.path) : '';
    markCurrent();
  }
  function showEditorFor(path, state) {
    current = path;
    show('editor');
    editor.view.setState(state);
    editor.setLanguage(window.HubEditor.languageFor(path));
    editor.view.dispatch({ scrollIntoView: true });
    markCurrent();
    refreshState();
  }

  /** Open a file. Text files go into the editor (their state is kept), others get an info panel. */
  function open(path, focus) {
    var f = find(path);
    if (!f) return Promise.resolve();
    stash();
    opening = path;
    if (!f.text) return Promise.resolve(showInfo(f));
    if (f.size > EDIT_MAX && !buffers[path]) return Promise.resolve(showInfo(f, 'Diese Datei ist zu groß für den Editor (' + formatBytes(f.size) + '). Bearbeite sie auf deinem PC und lade sie dann hoch.'));
    var b = buffers[path];
    if (b && b.state) {
      showEditorFor(path, b.state);
      if (focus) editor.focus();
      return Promise.resolve();
    }
    return request('GET', fileUrl(path)).then(function (data) {
      if (opening !== path) return;
      editor.setLanguage(window.HubEditor.languageFor(path));
      editor.setValue(data.text);
      buffers[path] = { state: editor.view.state, saved: editor.view.state.doc, dirty: false };
      showEditorFor(path, editor.view.state);
      if (focus) editor.focus();
    }, function (err) {
      if (opening === path) showInfo(f, err.message);
    });
  }
  function openFirst() {
    var wanted = new URLSearchParams(location.search).get('datei');
    var pick = (wanted && find(wanted)) || find('index.html') || files.filter(function (f) { return f.text; })[0] || files[0];
    if (pick) return open(pick.path);
    current = null;
    show('blank');
    markCurrent();
    return Promise.resolve();
  }

  // ------------------------------------------------------------- saving
  /** Save every changed file, then reload the preview. */
  function save() {
    if (saving) return saving;
    stash();
    var paths = dirtyPaths();
    if (!paths.length) {
      reloadPreview(); // "Speichern" always brings the preview up to date
      return Promise.resolve();
    }
    refreshState(true);
    var chain = Promise.resolve();
    paths.forEach(function (path) {
      chain = chain.then(function () {
        if (!buffers[path]) return null;
        var doc = docOf(path);
        return request('PUT', fileUrl(path), new Blob([doc.toString()]), 'application/octet-stream').then(function (data) {
          var b = buffers[path];
          if (!b) return;
          b.saved = doc;
          b.dirty = !docOf(path).eq(doc);
          setFiles(data.files);
        });
      });
    });
    saving = chain.then(function () {
      saving = null;
      refreshState();
      reloadPreview();
    }, function (err) {
      saving = null;
      refreshState();
      toast(err.message, 'error');
      throw err;
    });
    return saving;
  }
  /** For buttons and shortcuts: a failed save is already reported in a toast. */
  function saveQuietly() { return save().catch(function () {}); }

  // ------------------------------------------------------------ preview
  function reloadPreview() {
    if (Date.now() - tokenAt > TOKEN_MS) {
      request('GET', root.getAttribute('data-preview-url')).then(function (d) {
        tokenAt = Date.now();
        stage.classList.remove('ready');
        frame.src = d.src;
      }, function (err) { toast(err.message, 'error'); });
    } else if (window.HubPlayer) {
      window.HubPlayer.reload();
    }
  }
  // Problems in the console also show on the "Vorschau" switch (phones, tablets).
  var counter = $('console-count');
  var problems = $('studio-problems');
  new MutationObserver(function () {
    problems.hidden = counter.hidden;
    problems.textContent = counter.textContent;
  }).observe(counter, { attributes: true, childList: true, characterData: true, subtree: true });

  // ------------------------------------------------------------ dialogs
  var nameDialog = $('studio-name-dialog');
  var nameInput = $('studio-name-input');
  var nameError = $('studio-name-error');
  var nameOk = $('studio-name-ok');
  var nameAction = null;
  function askName(title, okLabel, value, action) {
    closeMenus();
    $('studio-name-title').textContent = title;
    nameOk.textContent = okLabel;
    nameInput.value = value || '';
    nameError.hidden = true;
    nameInput.removeAttribute('aria-invalid');
    nameAction = action;
    nameDialog.showModal();
    nameInput.focus();
    var dot = nameInput.value.lastIndexOf('.');
    var slash = nameInput.value.lastIndexOf('/');
    if (value) nameInput.setSelectionRange(slash + 1, dot > slash + 1 ? dot : nameInput.value.length);
  }
  function nameFailed(message) {
    nameError.textContent = message;
    nameError.hidden = false;
    nameInput.setAttribute('aria-invalid', 'true');
    nameInput.focus();
  }
  $('studio-name-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var value = nameInput.value.trim();
    if (!value) return nameFailed('Bitte gib einen Namen ein.');
    nameOk.disabled = true;
    nameAction(value).then(function () {
      nameDialog.close();
    }, function (err) {
      nameFailed(err.message);
    }).then(function () { nameOk.disabled = false; });
  });

  var confirmDialog = $('studio-confirm-dialog');
  var confirmOk = $('studio-confirm-ok');
  var confirmed = false;
  /** Ask first. Resolves true (confirmed) or false (cancelled, Escape). */
  function confirmBox(title, text, okLabel, danger) {
    closeMenus();
    $('studio-confirm-title').textContent = title;
    $('studio-confirm-text').textContent = text;
    confirmOk.textContent = okLabel;
    confirmOk.className = danger ? 'btn danger solid' : 'btn primary';
    confirmed = false;
    return new Promise(function (resolve) {
      confirmDialog.addEventListener('close', function done() {
        confirmDialog.removeEventListener('close', done);
        resolve(confirmed);
      });
      confirmDialog.showModal();
      confirmOk.focus();
    });
  }
  confirmOk.addEventListener('click', function () {
    confirmed = true;
    confirmDialog.close();
  });
  document.addEventListener('click', function (event) {
    var cancel = event.target.closest('[data-studio-cancel]');
    if (cancel) cancel.closest('dialog').close();
  });

  // ------------------------------------------------------ file actions
  function newFile(name) {
    if (findLoose(name)) return Promise.reject(new Error('Eine Datei mit diesem Namen gibt es schon.'));
    var starter = /\.html?$/i.test(name) ? HTML_STARTER : '';
    return request('PUT', fileUrl(name, '&neu=1'), new Blob([starter]), 'application/octet-stream').then(function (data) {
      setFiles(data.files);
      showPane('code');
      if (data.path === 'index.html') reloadPreview();
      return open(data.path, !phone.matches);
    });
  }

  function rename(from, to) {
    return postJson(base + '/datei/umbenennen', { von: from, nach: to }).then(function (data) {
      var target = data.path;
      if (target !== from && buffers[from]) {
        buffers[target] = buffers[from];
        delete buffers[from];
      }
      setFiles(data.files);
      var f = find(target);
      if (current === from) {
        current = target;
        if (f && !f.text) {
          delete buffers[target];
          showInfo(f);
        } else if (!editorBox.hidden) {
          editor.setLanguage(window.HubEditor.languageFor(target));
        } else if (f) {
          showInfo(f);
        }
        markCurrent();
      }
      refreshState();
      reloadPreview();
      toast('„' + from + '“ heißt jetzt „' + target + '“.');
    });
  }

  function remove(path) {
    postJson(base + '/datei/loeschen', { pfad: path }).then(function (data) {
      delete buffers[path];
      if (current === path) current = null;
      setFiles(data.files);
      if (!current) openFirst();
      refreshState();
      reloadPreview();
      toast('„' + path + '“ wurde gelöscht.');
    }, function (err) { toast(err.message, 'error'); });
  }

  /** Upload chosen files into the top folder of the draft, one after the other. */
  function upload(list) {
    var done = [];
    var chain = Promise.resolve();
    list.forEach(function (file) {
      chain = chain.then(function () {
        var existing = findLoose(file.name);
        var go = function () {
          return request('PUT', fileUrl(file.name, existing ? '' : '&neu=1'), file, 'application/octet-stream').then(function (data) {
            done.push(data.path);
            if (buffers[data.path]) delete buffers[data.path];
            setFiles(data.files);
            if (current === data.path) open(data.path);
          });
        };
        if (!existing) return go();
        return confirmBox('„' + existing.path + '“ ersetzen?', 'Im Entwurf gibt es schon eine Datei mit diesem Namen. Sie wird durch die hochgeladene ersetzt.', 'Ersetzen', false)
          .then(function (yes) { return yes ? go() : null; }); // cancelled: go on with the next file
      });
    });
    chain.then(function () {
      if (!done.length) return;
      toast(done.length === 1 ? '„' + done[0] + '“ ist hochgeladen.' : done.length + ' Dateien sind hochgeladen.');
      reloadPreview();
    }, function (err) {
      toast(err.message, 'error');
      if (done.length) reloadPreview();
    });
  }

  // ------------------------------------------------------------- layout
  /** Below 1200px one pane shows (phones), or code/preview plus a files drawer (tablets). */
  var viewRadios = root.querySelectorAll('input[name="studio-view"]');
  var filesToggle = document.querySelector('[data-studio-files]');
  function layout() {
    var narrow = !wide.matches;
    var cover = phone.matches && filesOpen;
    filesPane.classList.toggle('studio-pane-off', narrow && !filesOpen);
    codePane.classList.toggle('studio-pane-off', narrow && (view !== 'code' || cover));
    previewPane.classList.toggle('studio-pane-off', narrow && (view !== 'vorschau' || cover));
    scrim.hidden = !(narrow && !phone.matches && filesOpen);
    // Phones: "Dateien" is one of the three views. Tablets: the files are a drawer (button in the bar).
    var shown = cover ? 'dateien' : view;
    viewRadios.forEach(function (r) { r.checked = r.value === shown; });
    filesToggle.setAttribute('aria-pressed', filesOpen && !phone.matches ? 'true' : 'false');
  }
  function showPane(which) {
    if (which === 'dateien') filesOpen = phone.matches ? true : !filesOpen;
    else {
      filesOpen = false;
      view = which;
    }
    layout();
    // Keyboard users land in the files they just opened.
    if (which === 'dateien' && filesOpen && !wide.matches) {
      var target = tree.querySelector('[aria-current="true"]') || filesPane.querySelector('button');
      if (target) target.focus();
    }
  }
  root.addEventListener('change', function (event) {
    if (event.target.name === 'studio-view') showPane(event.target.value);
  });
  document.addEventListener('click', function (event) {
    if (event.target.closest('[data-studio-files]')) showPane('dateien');
  });
  root.addEventListener('click', function (event) {
    var b = event.target.closest('.studio-file');
    if (b) {
      var path = b.getAttribute('data-path');
      if (!wide.matches) showPane('code');
      open(path, !phone.matches && path !== current);
    }
  });
  [phone, wide].forEach(function (mq) { mq.addEventListener('change', layout); });

  // ----------------------------------------------------------- controls
  $('studio-save').addEventListener('click', saveQuietly);
  document.addEventListener('click', function (event) {
    var t = event.target;
    if (t.closest('[data-studio-reload]')) {
      if (dirtyPaths().length) saveQuietly();
      else reloadPreview();
    } else if (t.closest('[data-studio-new]')) {
      askName('Neue Datei', 'Anlegen', '', newFile);
    } else if (t.closest('[data-studio-rename]') && current) {
      var from = current;
      askName('Umbenennen oder verschieben', 'Umbenennen', from, function (to) { return to === from ? Promise.resolve() : rename(from, to); });
    } else if (t.closest('[data-studio-delete]') && current) {
      var path = current;
      confirmBox('„' + path + '“ löschen?', 'Die Datei wird aus dem Entwurf gelöscht. Deine Versionen bleiben, wie sie sind.', 'Löschen', true)
        .then(function (yes) { if (yes) remove(path); });
    } else if (t.closest('[data-studio-version]')) {
      closeMenus();
      if (!find('index.html')) return toast('Es fehlt die Datei index.html. Sie ist die Startseite deiner App – lege sie zuerst an.', 'error');
      $('studio-version-dialog').showModal();
    } else if (t.closest('[data-studio-close]')) {
      filesOpen = false;
      layout();
    }
  });
  $('studio-upload').addEventListener('change', function (event) {
    var list = Array.prototype.slice.call(event.target.files);
    event.target.value = '';
    if (list.length) upload(list);
  });

  // Links away from the editor save first; forms that leave on purpose skip the warning.
  document.addEventListener('click', function (event) {
    var link = event.target.closest('a[data-studio-leave]');
    if (!link || !dirtyPaths().length) return;
    event.preventDefault();
    save().then(function () { leaving = true; location.href = link.href; }, function () {});
  });
  var versionForm = $('studio-version-form');
  versionForm.addEventListener('submit', function (event) {
    if (!dirtyPaths().length) {
      leaving = true;
      return;
    }
    event.preventDefault();
    var button = versionForm.querySelector('button.primary');
    save().then(function () {
      leaving = true;
      versionForm.submit();
    }, function () {
      button.classList.remove('busy');
      button.removeAttribute('aria-busy');
    });
  });
  document.addEventListener('submit', function (event) {
    if (event.target.hasAttribute('data-confirmed')) leaving = true; // "Entwurf verwerfen" was confirmed
  }, true);
  window.addEventListener('beforeunload', function (event) {
    if (leaving || !dirtyPaths().length) return;
    event.preventDefault();
    event.returnValue = '';
  });

  document.addEventListener('keydown', function (event) {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && (event.key === 's' || event.key === 'S')) {
      if (event.defaultPrevented) return; // CodeMirror already handled it
      event.preventDefault();
      saveQuietly();
    } else if (event.key === 'Escape' && filesOpen && !phone.matches && !wide.matches) {
      filesOpen = false;
      layout();
    }
  });

  // --------------------------------------------------------------- start
  readTree();
  renderTree();
  layout();
  openFirst();
})();
