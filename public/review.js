// Review workbench (package B): the screen width of the live preview and the
// two decision sheets. Nothing here decides anything - the server checks every
// decision against the exact waiting version. No inline styles: only classes.
(function () {
  'use strict';

  // ------------------------------------------------- preview: Handy / Tablet / Voll
  // Each size names the width the app gets: 390, 820, or the column ("Voll").
  // Where the column is narrower than a size, CSS draws it smaller (zoom); the
  // note under the preview says so, so "Voll" and "Tablet" never look alike.
  var device = document.getElementById('review-device');
  var viewport = document.querySelector('.review-viewport');
  var fitWidth = document.getElementById('review-fitw');
  var scaleNote = document.getElementById('review-scale');
  var buttons = Array.prototype.slice.call(document.querySelectorAll('.review-devbtn'));
  var SIZES = ['phone', 'tablet', 'full'];
  var NAMES = { phone: 'Handy', tablet: 'Tablet', full: 'Voll' };
  var current = 'full';
  function describe() {
    if (!device || !viewport) return;
    var style = getComputedStyle(viewport);
    var inner = viewport.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 2;
    if (fitWidth) fitWidth.textContent = String(Math.max(0, Math.round(inner)));
    var zoom = parseFloat(getComputedStyle(device).zoom) || 1;
    if (scaleNote) scaleNote.textContent = zoom < 0.995 ? ' ' + NAMES[current] + '-Breite, verkleinert auf ' + Math.round(zoom * 100) + ' %.' : '';
  }
  buttons.forEach(function (button) {
    button.addEventListener('click', function () {
      var size = button.getAttribute('data-device');
      if (!device || SIZES.indexOf(size) < 0) return;
      current = size;
      SIZES.forEach(function (s) { device.classList.toggle('review-device-' + s, s === size); });
      buttons.forEach(function (b) { b.setAttribute('aria-pressed', b === button ? 'true' : 'false'); });
      describe();
    });
  });
  if (viewport && typeof ResizeObserver === 'function') new ResizeObserver(describe).observe(viewport);
  describe();

  // ------------------------------------------------- decision sheets
  // One open at a time; its text field gets the focus; Escape closes.
  var sheets = Array.prototype.slice.call(document.querySelectorAll('details.review-act'));
  sheets.forEach(function (sheet) {
    sheet.addEventListener('toggle', function () {
      if (!sheet.open) return;
      sheets.forEach(function (other) { if (other !== sheet) other.open = false; });
      // The sheet opens right at the bar, so it is already in view: never scroll the page for it.
      var text = sheet.querySelector('textarea');
      if (text) text.focus({ preventScroll: true });
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
