#!/usr/bin/env bash
# Builds the SchulHub demo for people who want to try the Hub on their own computer - as an ordinary offline
# program: unzip, double-click, done. Nothing to install, no internet, no Terminal commands.
#
#   SchulHub-Demo-Windows.zip   Windows 10 / 11, 64-bit (ARM PCs run it through Windows' own emulation)
#   SchulHub-Demo-Mac.zip       macOS 13.5 or newer, Apple silicon and Intel
#
# Each holds the COMMITTED source (git archive HEAD - uncommitted changes are not included), the npm packages of
# package-lock.json (all pure JavaScript), the official Node.js runtime for that system and the start file from
# this folder. The packaging scripts themselves are left out.
#
#   scripts/demo-paket/build.sh <target folder>     e.g. scripts/demo-paket/build.sh ../SchulHub-Demo-Paket
#
# Node.js is downloaded once from nodejs.org into ~/.cache/schulhub-demo/ and checked against the SHA-256 sums
# pinned below - taken from SHASUMS256.txt of the release, whose signature was checked with the Node.js release
# keys (github.com/nodejs/release-keys). A file that does not match stops the build.
set -euo pipefail
if [ $# -ne 1 ]; then echo "Usage: $0 <target folder>" >&2; exit 2; fi

NODE_VERSION=v26.13.1
declare -A NODE_SHA256=(
  [win-x64.zip]=e2edda75bfb089654705cf65a13b58933bfd5f57148e8ebda916f58a2474f1f7
  [darwin-arm64.tar.gz]=aec2514ea1ceb2ba52455e9ec65986f6749a06dd759e5db2a72e6889668c9735
  [darwin-x64.tar.gz]=82bb96078a24ca50b9c9a38f2379e6be6d87171fcd400fc14c8934b3bce96e2f
)

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
mkdir -p "$1"
out="$(cd "$1" && pwd)"
cache="${XDG_CACHE_HOME:-$HOME/.cache}/schulhub-demo/$NODE_VERSION"
mkdir -p "$cache"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }

# The Node.js archive for one system (e.g. win-x64.zip): from the cache, else from nodejs.org - always checked.
node_archive() {
  local file="$cache/node-$NODE_VERSION-$1"
  if [ ! -f "$file" ]; then
    curl -fsSL --retry 3 -o "$file.part" "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-$1"
    mv "$file.part" "$file"
  fi
  if [ "$(sha256 "$file")" != "${NODE_SHA256[$1]}" ]; then
    echo "Node.js $1: falsche Prüfsumme – Datei gelöscht, Bau abgebrochen." >&2
    rm -f "$file"
    exit 1
  fi
  echo "$file"
}

# The app, once: committed source + npm packages exactly as in package-lock.json + the read-me.
app="$stage/app/SchulHub-Demo"
mkdir -p "$stage/app"
git -C "$repo" archive --format=tar --prefix=SchulHub-Demo/ HEAD | tar -x -C "$stage/app"
rm -rf "$app/scripts/demo-paket"
(cd "$app" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --prefer-offline >/dev/null)
cp "$here/LIESMICH-ZUERST.txt" "$app/"

# Windows: node.exe in runtime/, the start file with its CRLF line endings.
win="$stage/win/SchulHub-Demo"
mkdir -p "$stage/win"
cp -a "$app" "$win"
mkdir -p "$win/runtime"
unzip -q -j "$(node_archive win-x64.zip)" "node-$NODE_VERSION-win-x64/node.exe" "node-$NODE_VERSION-win-x64/LICENSE" -d "$win/runtime"
cp "$here/SchulHub starten.cmd" "$win/"

# Mac: both runtimes (Apple silicon and Intel); the start file picks the right one.
mac="$stage/mac/SchulHub-Demo"
mkdir -p "$stage/mac"
cp -a "$app" "$mac"
for arch in arm64 x64; do
  mkdir -p "$mac/runtime/mac-$arch"
  tar -xzf "$(node_archive "darwin-$arch.tar.gz")" -C "$mac/runtime/mac-$arch" --strip-components=2 "node-$NODE_VERSION-darwin-$arch/bin/node"
done
tar -xzf "$(node_archive darwin-arm64.tar.gz)" -C "$mac/runtime" --strip-components=1 "node-$NODE_VERSION-darwin-arm64/LICENSE"
cp "$here/SchulHub starten.command" "$mac/"
chmod 755 "$mac/SchulHub starten.command" "$mac/runtime/mac-arm64/node" "$mac/runtime/mac-x64/node"

head="$(git -C "$repo" rev-parse --short HEAD)"
for system in Windows Mac; do
  if [ "$system" = Windows ]; then dir="$stage/win"; else dir="$stage/mac"; fi
  rm -f "$out/SchulHub-Demo-$system.zip"
  (cd "$dir" && zip -r -X -q -9 "$out/SchulHub-Demo-$system.zip" SchulHub-Demo)
  echo "Built $out/SchulHub-Demo-$system.zip ($head, Node.js $NODE_VERSION, $(du -h "$out/SchulHub-Demo-$system.zip" | cut -f1))"
done
