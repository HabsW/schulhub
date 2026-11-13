#!/bin/bash
# SchulHub-Demo starten (macOS). Startet den lokalen Testmodus und öffnet den Browser.
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js ist auf diesem Mac nicht installiert."
  echo "  Bitte die LTS-Version von https://nodejs.org installieren und dann noch einmal starten."
  echo
  exit 1
fi
echo
echo "  SchulHub-Demo startet … der Browser öffnet sich gleich von selbst."
echo "  Falls nicht: im Browser http://localhost:3000 eingeben."
echo "  Zum Beenden: dieses Fenster schließen (oder ctrl + C drücken)."
echo
exec node src/server.js --dev --open
