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
    okButton.focus();
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

  // ----------------------------------------------------- auto-submit filters
  // <form data-autosubmit>: filters and segmented controls apply on change.
  document.addEventListener('change', function (event) {
    var form = event.target.form;
    if (form && form.hasAttribute('data-autosubmit')) {
      if (form.requestSubmit) form.requestSubmit(); else form.submit();
    }
  });
})();
