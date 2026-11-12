// Small helpers for the class pages (package A). Nothing here decides
// anything: every permission is checked on the server. Text is only ever set
// with textContent.
(function () {
  'use strict';

  // ------------------------------------------------------------ projector
  // Fullscreen for the beamer, and the live number of students who joined
  // (the server answers with a number and a sentence - never names).
  var full = document.getElementById('teach-fullscreen');
  if (full) {
    full.addEventListener('click', function () {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(function () {});
    });
    document.addEventListener('fullscreenchange', function () {
      full.setAttribute('aria-label', document.fullscreenElement ? 'Vollbild beenden' : 'Vollbild');
      full.setAttribute('title', document.fullscreenElement ? 'Vollbild beenden' : 'Vollbild');
    });
  }

  var joined = document.getElementById('teach-joined');
  if (joined && joined.getAttribute('data-status')) {
    var url = joined.getAttribute('data-status');
    var valid = document.getElementById('teach-valid');
    var stopAt = Date.now() + 3 * 60 * 60 * 1000; // a lesson is long, but not that long
    var timer = null;
    // The code on the screen was deleted, expired or the class archived: stop
    // showing a dead QR code and show the "no valid code" view instead.
    var showDead = function (text, allowNew) {
      var section = document.getElementById('teach-projector');
      var dead = document.getElementById('teach-qr-dead');
      var deadText = document.getElementById('teach-qr-dead-text');
      ['teach-qr-code', 'teach-qr-live'].forEach(function (id) { var el = document.getElementById(id); if (el) el.hidden = true; });
      if (section) section.classList.remove('teach-projector-qr');
      if (!dead) return;
      if (deadText && typeof text === 'string') deadText.textContent = text;
      var form = dead.querySelector('form');
      if (form) form.hidden = !allowNew;
      dead.hidden = false;
    };
    var poll = function () {
      if (document.hidden) return;
      if (Date.now() > stopAt) { clearInterval(timer); return; }
      fetch(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store' })
        .then(function (res) { if (!res.ok) throw new Error('status'); return res.json(); })
        .then(function (data) {
          if (typeof data.text === 'string' && joined.textContent !== data.text) joined.textContent = data.text;
          if (data.state === 'replaced') { window.location.reload(); return; } // a newer code exists: show it
          if (data.state === 'valid') { if (valid && typeof data.stateText === 'string') valid.textContent = data.stateText; return; }
          showDead(data.stateText, data.state !== 'archived');
        })
        .catch(function () { /* the next round tries again */ });
    };
    timer = setInterval(poll, 5000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });
  }

  // ------------------------------------------------------- assignment form
  // The title follows the chosen app until the teacher types their own.
  var select = document.querySelector('select[data-teach-title]');
  if (select) {
    var title = document.getElementById(select.getAttribute('data-teach-title'));
    var nameOf = function () {
      var option = select.options[select.selectedIndex];
      return option ? option.getAttribute('data-name') || '' : '';
    };
    var last = nameOf();
    if (title) {
      select.addEventListener('change', function () {
        if (!title.value.trim() || title.value === last) title.value = nameOf();
        last = nameOf();
      });
    }
  }
})();
