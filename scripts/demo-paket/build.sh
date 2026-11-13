#!/usr/bin/env bash
# Builds SchulHub-Demo.zip for people who want to try the Hub on their own Mac or Windows PC:
# the COMMITTED source (git archive HEAD - uncommitted changes are not included), the production
# npm packages (all pure JavaScript, so nobody needs `npm install`), and the start files from
# this folder. The packaging scripts themselves are left out.
#
#   scripts/demo-paket/build.sh <target folder>     e.g. scripts/demo-paket/build.sh ../SchulHub-Demo-Paket
set -euo pipefail
if [ $# -ne 1 ]; then echo "Usage: $0 <target folder>" >&2; exit 2; fi
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
mkdir -p "$1"
out="$(cd "$1" && pwd)"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

git -C "$repo" archive --format=tar --prefix=SchulHub-Demo/ HEAD | tar -x -C "$stage"
rm -rf "$stage/SchulHub-Demo/scripts/demo-paket"
(cd "$stage/SchulHub-Demo" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null)
cp "$here/Start-Windows.cmd" "$here/Start-Mac.command" "$here/LIESMICH-ZUERST.txt" "$stage/SchulHub-Demo/"
chmod 755 "$stage/SchulHub-Demo/Start-Mac.command"
rm -f "$out/SchulHub-Demo.zip"
(cd "$stage" && zip -r -X -q "$out/SchulHub-Demo.zip" SchulHub-Demo)
echo "Built $out/SchulHub-Demo.zip ($(git -C "$repo" rev-parse --short HEAD))"
