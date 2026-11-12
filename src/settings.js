'use strict';
// Settings the admin can change in the Hub (stored in hub_settings). Every
// setting has a fixed type, a default and an allowed range; anything else is
// refused. Nothing here is ever sent to an app.

const { bad } = require('./util');

const DEFS = {
  'retention.auditDays': {
    label: 'Protokoll aufbewahren',
    unit: 'Tage',
    help: 'Ältere Einträge im Protokoll werden gelöscht.',
    min: 30, max: 3650,
    def: (config) => config.auditRetentionDays,
  },
  'retention.archivedClassDays': {
    label: 'Archivierte Klassen löschen nach',
    unit: 'Tagen',
    help: 'Gerechnet ab dem Archivieren. Danach werden die Klasse und ihre Daten (Aufgaben, Rückmeldungen, Klassendaten) gelöscht.',
    min: 30, max: 3650,
    def: () => 365,
  },
  'retention.inactiveFlagDays': {
    label: 'Inaktive Konten markieren nach',
    unit: 'Tagen ohne Anmeldung',
    help: 'Markierte Konten erscheinen in der Verwaltung. Sie werden nie automatisch gelöscht.',
    min: 90, max: 3650,
    def: () => 456, // about 15 months
  },
};

function createSettings(db, config) {
  const valid = (d, v) => Number.isInteger(v) && v >= d.min && v <= d.max;

  function get(key) {
    const d = DEFS[key];
    if (!d) throw new Error(`unknown setting ${key}`);
    const row = db.get('SELECT value FROM hub_settings WHERE key = ?', key);
    let v = null;
    try {
      v = row ? JSON.parse(row.value) : null;
    } catch {
      v = null;
    }
    return valid(d, v) ? v : d.def(config);
  }

  /** Change one setting. Throws a German message if the value is not allowed. */
  function set(key, raw) {
    const d = DEFS[key];
    if (!d) throw bad('Diese Einstellung gibt es nicht.');
    const v = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? '').trim(), 10);
    if (!valid(d, v)) throw bad(`„${d.label}“ muss zwischen ${d.min} und ${d.max} liegen.`);
    db.run(
      'INSERT INTO hub_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      key, JSON.stringify(v), Date.now()
    );
    return v;
  }

  const all = () => Object.entries(DEFS).map(([key, d]) => ({ key, label: d.label, unit: d.unit, help: d.help, min: d.min, max: d.max, default: d.def(config), value: get(key) }));

  return { get, set, all, DEFS };
}

module.exports = { createSettings };
