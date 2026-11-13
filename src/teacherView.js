'use strict';
// What the teachers of a class see of a student's data in the class's apps - ONE text, used where
// students decide (joining a class) and on the privacy page. It has to match the teacher pages
// (routes/results.js, routes/classes.js): results only from that class, but saves, best scores,
// progress, achievements and when / how often the app was opened from anywhere (at home, in
// another class). test/people.test.js checks the text against those pages.

const { html } = require('./html');

const TEACHERS_SEE = [
  'deinen Namen und deine Ergebnisse aus dieser Klasse,',
  'was die App für dich speichert: Spielstände, Bestwerte, Fortschritt und Erfolge – auch wenn du die App zu Hause oder in einer anderen Klasse benutzt hast,',
  'wann und wie oft du die App geöffnet hast.',
];

/** The intro sentence (ending in a colon) and the list. */
const teachersSee = (intro) => html`<p>${intro}</p><ul>${TEACHERS_SEE.map((t) => html`<li>${t}</li>`)}</ul>`;

module.exports = { teachersSee, TEACHERS_SEE };
