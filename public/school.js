// Small helpers for the school and admin pages (search, catalogue, settings,
// Verwaltung). Nothing here decides anything - every permission is checked
// on the server. No text is ever inserted as HTML.
(function () {
  'use strict';

  // ------------------------------------------------- focus after filtering
  // Filter forms with data-autosubmit reload the page on every change (hub.js).
  // Put the keyboard focus back on the control that was changed, so arrow keys
  // in a radio group or a select keep working after the reload.
  var KEY = 'schulhub:filterfokus';
  document.addEventListener('change', function (event) {
    var el = event.target;
    if (!el.form || !el.form.hasAttribute('data-autosubmit') || !el.name) return;
    try {
      sessionStorage.setItem(KEY, JSON.stringify({ path: location.pathname, name: el.name, value: el.type === 'radio' ? el.value : null }));
    } catch (e) { /* storage blocked: nothing to restore */ }
  }, true);

  function restoreFocus() {
    var saved = null;
    try {
      saved = JSON.parse(sessionStorage.getItem(KEY) || 'null');
      sessionStorage.removeItem(KEY);
    } catch (e) { return; }
    if (!saved || saved.path !== location.pathname) return;
    var fields = document.getElementsByName(saved.name);
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (f.form && f.form.hasAttribute('data-autosubmit') && (saved.value === null || f.value === saved.value)) {
        f.focus();
        return;
      }
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', restoreFocus);
  else restoreFocus();

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
