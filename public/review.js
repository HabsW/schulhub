// Review workbench (package B): the screen width of the live preview and the
// two decision sheets. Nothing here decides anything - the server checks every
// decision against the exact waiting version. No inline styles: only classes.
(function () {
  'use strict';

  // ------------------------------------------------- preview: Handy / Tablet / Voll
  var device = document.getElementById('review-device');
  var buttons = Array.prototype.slice.call(document.querySelectorAll('.review-devbtn'));
  var SIZES = ['phone', 'tablet', 'full'];
  buttons.forEach(function (button) {
    button.addEventListener('click', function () {
      var size = button.getAttribute('data-device');
      if (!device || SIZES.indexOf(size) < 0) return;
      SIZES.forEach(function (s) { device.classList.toggle('review-device-' + s, s === size); });
      buttons.forEach(function (b) { b.setAttribute('aria-pressed', b === button ? 'true' : 'false'); });
    });
  });

  // ------------------------------------------------- decision sheets
  // One open at a time; its text field gets the focus; Escape closes.
  var sheets = Array.prototype.slice.call(document.querySelectorAll('details.review-act'));
  sheets.forEach(function (sheet) {
    sheet.addEventListener('toggle', function () {
      if (!sheet.open) return;
      sheets.forEach(function (other) { if (other !== sheet) other.open = false; });
      var text = sheet.querySelector('textarea');
      if (text) text.focus();
    });
  });
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    sheets.forEach(function (sheet) {
      if (!sheet.open) return;
      sheet.open = false;
      var summary = sheet.querySelector('summary');
      if (summary) summary.focus();
    });
  });
})();
