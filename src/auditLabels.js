'use strict';
// Plain German for the audit log. Every action code passed to
// services.audit() anywhere in src/ needs a label here; test/school.test.js
// greps the sources and fails for a code without one. Codes that are not in
// the list (e.g. from an older version) are shown as they are.

const { ROLE_LABEL } = require('./html');

const AUDIT_LABELS = {
  // sign-in
  anmeldung: 'Angemeldet',
  anmeldung_abgelehnt: 'Anmeldung abgelehnt',
  abmeldung: 'Abgemeldet',

  // classes
  klasse_erstellt: 'Klasse angelegt',
  einladung_geloescht: 'Lehrkraft-Einladung gelöscht',
  upload_abgebrochen: 'Upload abgebrochen',
  app_einstellungen_zurueckgesetzt: 'App-Einstellungen der Klasse zurückgesetzt',
  klasse_umbenannt: 'Klasse umbenannt',
  klasse_archiviert: 'Klasse archiviert',
  klasse_wiederhergestellt: 'Klasse wiederhergestellt',
  klasse_geloescht: 'Klasse gelöscht',
  klasse_beigetreten: 'Klasse beigetreten',
  klasse_verlassen: 'Klasse verlassen',
  beitrittscode_erzeugt: 'Beitrittscode erzeugt',
  beitrittscode_abgeschaltet: 'Beitrittscode abgeschaltet',
  beitrittscode_geloescht: 'Beitrittscode abgeschaltet',
  einladung_erzeugt: 'Einladung für Lehrkräfte erzeugt',
  lehrkraft_eingeladen: 'Lehrkraft eingeladen',
  lehrkraft_beigetreten: 'Als Lehrkraft beigetreten',
  lehrkraft_entfernt: 'Lehrkraft aus Klasse entfernt',
  mitglied_entfernt: 'Mitglied aus Klasse entfernt',

  // teaching
  aufgabe_erstellt: 'Aufgabe gestellt',
  aufgabe_geaendert: 'Aufgabe geändert',
  aufgabe_geloescht: 'Aufgabe gelöscht',
  rueckmeldung_gegeben: 'Rückmeldung gegeben',
  rueckmeldung_erstellt: 'Rückmeldung gegeben',
  rueckmeldung_geloescht: 'Rückmeldung gelöscht',
  einstellungen_geaendert: 'App-Einstellungen der Klasse geändert',
  app_einstellungen_geaendert: 'App-Einstellungen der Klasse geändert',
  ergebnisse_exportiert: 'Ergebnisse exportiert',
  appdaten_zurueckgesetzt: 'Daten einer Person in einer App gelöscht',

  // apps and versions
  app_erstellt: 'App angelegt',
  app_aus_vorlage: 'App aus Vorlage angelegt',
  app_bearbeitet: 'App bearbeitet',
  app_geloescht: 'App gelöscht',
  version_hochgeladen: 'Version hochgeladen',
  version_aus_entwurf: 'Version im Editor gespeichert',
  version_geloescht: 'Version gelöscht',
  upload_abgelehnt: 'Upload abgelehnt',
  veroeffentlicht: 'Version veröffentlicht',
  entwurf_verworfen: 'Entwurf verworfen',
  app_geteilt: 'Mit Kolleg/innen geteilt',
  app_nicht_mehr_geteilt: 'Teilen mit Kolleg/innen beendet',
  kommentar_geschrieben: 'Kommentar geschrieben',
  kommentar_geloescht: 'Kommentar gelöscht',

  // apps in classes (review)
  app_zugewiesen: 'App zur Klasse hinzugefügt',
  app_eingereicht: 'App eingereicht',
  app_freigegeben: 'App freigegeben',
  app_zurueckgegeben: 'App zurückgegeben',
  einreichung_zurueckgezogen: 'Einreichung zurückgezogen',
  app_aus_klasse_entfernt: 'App aus Klasse entfernt',
  app_zurueckgeholt: 'App in die Klasse zurückgeholt',
  schulweit_freigegeben: 'Für die ganze Schule freigegeben',
  schulweit_beendet: 'Schulweite Freigabe beendet',
  schulweit_angefragt: 'Schulweite Freigabe angefragt',
  schulweit_aktualisiert: 'Schulweites Update freigegeben',
  schulweit_update_freigegeben: 'Schulweites Update freigegeben',
  schulweit_update_abgelehnt: 'Schulweites Update abgelehnt',

  // accounts
  rolle_geaendert: 'Rolle geändert',
  konto_gesperrt: 'Konto gesperrt',
  konto_entsperrt: 'Konto entsperrt',
  konto_geloescht: 'Konto gelöscht',

  // school and operations
  ankuendigung_erstellt: 'Ankündigung veröffentlicht',
  ankuendigung_geloescht: 'Ankündigung gelöscht',
  aufbewahrung_geaendert: 'Aufbewahrungsfristen geändert',
  sicherung_heruntergeladen: 'Sicherung heruntergeladen',
  datenbank_geprueft: 'Datenbank geprüft',
};

/** German label of an action code; unknown codes are returned unchanged. */
const auditLabel = (code) => (Object.hasOwn(AUDIT_LABELS, code) ? AUDIT_LABELS[code] : String(code));

/** "Anna Adler (admin)" -> "Anna Adler (Admin)": the stored role code becomes the German role. */
function actorLabel(label) {
  const m = /^(.*) \((student|teacher|admin)\)$/s.exec(String(label ?? ''));
  return m ? `${m[1]} (${ROLE_LABEL[m[2]]})` : String(label ?? '');
}

module.exports = { AUDIT_LABELS, auditLabel, actorLabel };
