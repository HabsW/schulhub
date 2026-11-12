// Small helpers for every Hub page. Nothing here decides anything: all
// permissions are checked on the server. Text is only ever set with
// textContent - nothing is interpreted as HTML.
(function () {
  'use strict';

  // ---------------------------------------------------------------- confirm
  // Forms marked with data-confirm ask first, in a real dialog (focus is
  // trapped by <dialog>, Escape cancels). data-confirm-label names the button,
  // data-danger makes it red.
  var dialog = null;
  function confirmDialog(form) {
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.className = 'confirm';
      dialog.setAttribute('aria-labelledby', 'confirm-title');
      var h = document.createElement('h2');
      h.id = 'confirm-title';
      var p = document.createElement('p');
      var actions = document.createElement('div');
      actions.className = 'actions';
      var cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'btn quiet';
      cancel.textContent = 'Abbrechen';
      var ok = document.createElement('button');
      ok.type = 'button';
      actions.append(cancel, ok);
      dialog.append(h, p, actions);
      document.body.append(dialog);
      cancel.addEventListener('click', function () { dialog.close(); });
      dialog.addEventListener('click', function (e) { if (e.target === dialog) dialog.close(); });
    }
    var question = form.getAttribute('data-confirm');
    var title = dialog.querySelector('h2');
    var text = dialog.querySelector('p');
    var okButton = dialog.querySelector('.actions button:last-child');
    var split = question.indexOf('\n');
    title.textContent = split > 0 ? question.slice(0, split) : question;
    text.textContent = split > 0 ? question.slice(split + 1) : '';
    text.hidden = split <= 0;
    okButton.textContent = form.getAttribute('data-confirm-label') || 'Ja';
    okButton.className = form.hasAttribute('data-danger') ? 'btn danger solid' : 'btn primary';
    okButton.onclick = function () {
      dialog.close();
      form.setAttribute('data-confirmed', '1');
      if (form.requestSubmit) form.requestSubmit(); else form.submit();
    };
    dialog.showModal();
    // Start on the safe choice: Enter twice must never delete anything.
    dialog.querySelector('.actions button:first-child').focus();
  }

  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (form.hasAttribute('data-confirm') && !form.hasAttribute('data-confirmed')) {
      event.preventDefault();
      if (typeof HTMLDialogElement === 'function') confirmDialog(form);
      else if (window.confirm(form.getAttribute('data-confirm'))) { form.setAttribute('data-confirmed', '1'); form.submit(); }
      return;
    }
    form.removeAttribute('data-confirmed');
    // Show that something is happening after a form is sent.
    var button = event.submitter || form.querySelector('button');
    if (button && form.method === 'post') setTimeout(function () { button.classList.add('busy'); button.setAttribute('aria-busy', 'true'); }, 0);
  });

  // ------------------------------------------------------------------ menus
  // <details class="menu">: one open at a time, closes on outside click and Escape.
  function closeMenus(except) {
    document.querySelectorAll('details.menu[open]').forEach(function (d) { if (d !== except) d.removeAttribute('open'); });
  }
  document.addEventListener('click', function (event) {
    var inside = event.target.closest('details.menu');
    if (inside && event.target.closest('summary')) closeMenus(inside);
    else if (!inside || event.target === inside) closeMenus(null);
  });
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    var open = document.querySelector('details.menu[open]');
    if (open) { open.removeAttribute('open'); var s = open.querySelector('summary'); if (s) s.focus(); }
  });

  // ------------------------------------------------------------- copy links
  document.addEventListener('click', function (event) {
    var button = event.target.closest('[data-copy]');
    if (!button) return;
    var label = button.querySelector('span') || button;
    var old = label.textContent;
    navigator.clipboard.writeText(button.getAttribute('data-copy')).then(function () {
      label.textContent = 'Kopiert';
      button.classList.add('copied');
      setTimeout(function () { label.textContent = old; button.classList.remove('copied'); }, 1600);
    });
  });
  document.addEventListener('focusin', function (event) {
    if (event.target.matches && event.target.matches('input.copy')) event.target.select();
  });

  // ------------------------------------------------- page transitions
  // Pages that embed an app frame (player, review workbench, editor) get no
  // cross-page transition: its overlay swallowed early taps into the app. The
  // outgoing page skips it, so the incoming page never sees a half transition.
  var FRAME_PAGE = /\/(apps\/[^/]+\/spielen|pruefen\/[^/]+\/[^/]+|studio\/[^/]+)(\?|$)/;
  window.addEventListener('pageswap', function (event) {
    var vt = event.viewTransition;
    if (!vt) return;
    vt.finished.catch(function () {});
    var to = event.activation && event.activation.entry && event.activation.entry.url;
    if (to && FRAME_PAGE.test(new URL(to).pathname + new URL(to).search.slice(0, 1))) vt.skipTransition();
  });
  window.addEventListener('pagereveal', function (event) {
    if (event.viewTransition) { event.viewTransition.finished.catch(function () {}); event.viewTransition.ready.catch(function () {}); }
  });

  // ----------------------------------------------------------- tabs
  // On narrow screens the tab row scrolls sideways: bring the current tab into view.
  document.querySelectorAll('.tabs [aria-current="page"]').forEach(function (tab) {
    var row = tab.parentElement;
    if (row.scrollWidth > row.clientWidth) row.scrollLeft = tab.offsetLeft - (row.clientWidth - tab.offsetWidth) / 2;
  });

  // ----------------------------------------------------- auto-submit filters
  // <form data-autosubmit>: filters and segmented controls apply on change.
  // The page reloads, so remember which control had the keyboard focus and give it back.
  var FOCUS_KEY = 'hub-autosubmit-focus';
  document.addEventListener('change', function (event) {
    var el = event.target;
    var form = el.form;
    if (!form || !form.hasAttribute('data-autosubmit')) return;
    try { sessionStorage.setItem(FOCUS_KEY, JSON.stringify({ path: location.pathname, name: el.name || '', value: el.type === 'radio' || el.type === 'checkbox' ? el.value : '' })); } catch (e) { /* storage blocked */ }
    if (form.requestSubmit) form.requestSubmit(); else form.submit();
  });
  try {
    var kept = JSON.parse(sessionStorage.getItem(FOCUS_KEY) || 'null');
    sessionStorage.removeItem(FOCUS_KEY);
    if (kept && kept.path === location.pathname && kept.name) {
      var candidates = document.querySelectorAll('form[data-autosubmit] [name]');
      for (var i = 0; i < candidates.length; i++) {
        var c = candidates[i];
        if (c.name === kept.name && (!kept.value || c.value === kept.value)) { c.focus({ preventScroll: true }); break; }
      }
    }
  } catch (e) { /* storage blocked or bad value */ }
})();
