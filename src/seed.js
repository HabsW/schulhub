'use strict';
// Demo data for the local test mode: test people, one class, the example apps.
// Only ever called when the server runs with --dev, and only on an empty database.

const path = require('node:path');
const { newId } = require('./util');

const PEOPLE = [
  ['dev-admin', 'Anna Adler', 'admin'],
  ['dev-lehrer', 'Herr Lehmann', 'teacher'],
  ['dev-lehrerin', 'Frau Yilmaz', 'teacher'],
  ['dev-mia', 'Mia Schmidt', 'student'],
  ['dev-ben', 'Ben Hoffmann', 'student'],
  ['dev-lena', 'Lena Wagner', 'student'],
];

function seedDemo(ctx) {
  const { db, services, uploads, config } = ctx;
  if (db.get('SELECT COUNT(*) AS n FROM users').n > 0) return;

  const users = {};
  for (const [oid, name, role] of PEOPLE) {
    const id = newId();
    db.run('INSERT INTO users (id, oid, name, email, role, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, oid, name, `${oid.slice(4)}@schule.example`, role, Date.now());
    users[oid] = db.get('SELECT * FROM users WHERE id = ?', id);
  }
  const teacher = users['dev-lehrer'];
  const mia = users['dev-mia'];

  const classId = services.createClass(teacher, '7b Englisch');
  services.createJoinCode(teacher, classId, 7 * 24 * 60);
  for (const s of ['dev-mia', 'dev-ben']) {
    db.run("INSERT INTO class_members (class_id, user_id, role, joined_at) VALUES (?, ?, 'student', ?)", classId, users[s].id, Date.now());
  }

  /** Upload an example folder through the normal validation, then publish it. */
  function example(owner, folder, fields) {
    const id = services.createApp(owner, fields);
    const app = db.get('SELECT * FROM apps WHERE id = ?', id);
    const version = services.createVersion(app);
    uploads.addDirectory(version, owner.id, path.join(config.root, 'examples', folder));
    services.finishVersion(owner, app, version);
    services.publish(owner, app, version);
    return db.get('SELECT * FROM apps WHERE id = ?', id);
  }
  const add = (app, status, by) =>
    status === 'approved'
      ? db.run("INSERT INTO class_apps (class_id, app_id, status, version_id, added_by, decided_by, decided_at, created_at) VALUES (?, ?, 'approved', ?, ?, ?, ?, ?)", classId, app.id, app.published_version_id, by.id, by.id, Date.now(), Date.now())
      : db.run("INSERT INTO class_apps (class_id, app_id, status, requested_version_id, added_by, created_at) VALUES (?, ?, 'pending', ?, ?, ?)", classId, app.id, app.published_version_id, by.id, Date.now());

  const vocab = example(teacher, 'vokabeltrainer', { name: 'Vokabeltrainer', description: 'Vokabeln üben – die Lehrkraft legt die Wörter für die Klasse fest.', emoji: '🔤', color: '1' });
  const stars = example(teacher, 'sternenfaenger', { name: 'Sternenfänger', description: 'Fang die Sterne, weich den Meteoriten aus. Mit Bestenliste.', emoji: '⭐', color: '4' });
  const pixel = example(mia, 'pixel-studio', { name: 'Pixel-Studio', description: 'Male Pixelbilder. Deine Bilder werden in deinem Konto gespeichert.', emoji: '🎨', color: '2' });
  add(vocab, 'approved', teacher);
  add(stars, 'approved', teacher);
  add(pixel, 'pending', mia); // a student app waiting for the teacher's review

  db.run('INSERT INTO comments (id, app_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)', newId(), pixel.id, mia.id, 'Hallo Herr Lehmann, können wir mein Pixel-Studio in der Klasse benutzen?', Date.now());
  console.log('Demo-Daten angelegt: Testpersonen, Klasse „7b Englisch“ und drei Beispiel-Apps.');
}

module.exports = { seedDemo };
