#!/bin/bash
# SchulHub-Demo starten (macOS 13.5 oder neuer, Apple silicon und Intel): Doppelklick genügt.
# Node.js liegt im Ordner "runtime" bei – nichts installieren, kein Internet nötig.
# Startet den lokalen Testmodus und öffnet den Browser. Läuft die Demo schon, öffnet
# ein zweiter Doppelklick nur den Browser.
cd "$(dirname "$0")" || exit 1

IFS=. read -r major minor _ <<< "$(sw_vers -productVersion 2>/dev/null)"
if [ -n "$major" ] && { [ "$major" -lt 13 ] || { [ "$major" -eq 13 ] && [ "${minor:-0}" -lt 5 ]; }; }; then
  echo
  echo "  Diese Demo braucht macOS 13.5 oder neuer – auf diesem Mac läuft macOS $major.${minor:-0}."
  echo
  exit 1
fi

# Was aus dem Internet kommt, markiert macOS ("Quarantäne") und fragt bei jedem Programm darin nach.
# Wer diese Datei startet, hat die Demo erlaubt: Die Markierung wird für diesen Ordner einmal entfernt,
# damit das mitgelieferte Node.js ohne weitere Rückfragen läuft.
xattr -dr com.apple.quarantine . 2>/dev/null || true

if [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = "1" ]; then node="runtime/mac-arm64/node"; else node="runtime/mac-x64/node"; fi
if [ ! -x "$node" ] || [ ! -f src/server.js ]; then
  echo
  echo "  Hier fehlt etwas – bitte SchulHub-Demo-Mac.zip noch einmal entpacken (Doppelklick)"
  echo "  und dann im neuen Ordner \"SchulHub starten.command\" doppelt anklicken."
  echo
  exit 1
fi

echo
echo "  SchulHub-Demo startet … der Browser öffnet sich gleich von selbst."
echo "  Falls nicht: im Browser http://localhost:3000 eingeben."
echo
echo "  Dieses Fenster offen lassen, solange du die Demo benutzt."
echo "  Zum Beenden: dieses Fenster schließen (oder ctrl + C drücken)."
echo
exec "$node" src/server.js --dev --open
