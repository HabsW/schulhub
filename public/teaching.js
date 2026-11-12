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
    var poll = function () {
      if (document.hidden) return;
      if (Date.now() > stopAt) { clearInterval(timer); return; }
      fetch(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store' })
        .then(function (res) { if (!res.ok) throw new Error('status'); return res.json(); })
        .then(function (data) {
          if (typeof data.text === 'string' && joined.textContent !== data.text) joined.textContent = data.text;
          if (valid && typeof data.validText === 'string') valid.textContent = data.validText;
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
