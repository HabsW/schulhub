// Small helpers for every Hub page. Nothing here decides anything:
// all permissions are checked on the server.
(function () {
  'use strict';

  // Ask before dangerous actions (forms marked with data-confirm).
  document.addEventListener('submit', function (event) {
    var text = event.target.getAttribute('data-confirm');
    if (text && !window.confirm(text)) event.preventDefault();
  });

  // "Link kopieren" buttons.
  document.addEventListener('click', function (event) {
    var button = event.target.closest('[data-copy]');
    if (!button) return;
    navigator.clipboard.writeText(button.getAttribute('data-copy')).then(function () {
      var old = button.textContent;
      button.textContent = 'Kopiert ✓';
      setTimeout(function () { button.textContent = old; }, 1500);
    });
  });

  // Tables become stacked records on phones: give every cell the label of its column.
  // (Text only, via setAttribute - nothing is interpreted as HTML.)
  document.querySelectorAll('table.data').forEach(function (table) {
    var heads = table.querySelectorAll('thead th');
    if (!heads.length) return;
    table.querySelectorAll('tbody tr').forEach(function (row) {
      Array.prototype.forEach.call(row.children, function (cell, i) {
        var label = heads[i] ? heads[i].textContent.trim() : '';
        if (label) cell.setAttribute('data-label', label);
      });
    });
    table.classList.add('labelled');
  });

  // Buttons show that something is happening after a form is sent.
  document.addEventListener('submit', function (event) {
    if (event.defaultPrevented) return;
    var button = event.submitter || event.target.querySelector('button');
    if (button && event.target.method === 'post') setTimeout(function () { button.classList.add('busy'); button.setAttribute('aria-busy', 'true'); }, 0);
  });

  // Select the whole link when clicking into a copy field.
  document.addEventListener('focusin', function (event) {
    if (event.target.matches('input.copy')) event.target.select();
  });
})();
