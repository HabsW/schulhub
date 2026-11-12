// Small helpers for the school and admin pages. Nothing here decides
// anything - every permission is checked on the server. No text is ever
// inserted as HTML. (Keeping the focus after auto-submitting filters is
// done by hub.js for every page.)
(function () {
  'use strict';

  // ------------------------------------------- downloads started by a form
  // A POST that answers with a file (the backup) leaves the page in place, so
  // the button must not keep spinning; a status line says what is going on.
  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!form.hasAttribute || !form.hasAttribute('data-download') || form.hasAttribute('data-confirm')) return;
    var status = form.querySelector('[role="status"]');
    if (status) status.hidden = false;
    setTimeout(function () {
      var busy = form.querySelector('button.busy');
      if (busy) {
        busy.classList.remove('busy');
        busy.removeAttribute('aria-busy');
      }
    }, 5000);
  });
})();
