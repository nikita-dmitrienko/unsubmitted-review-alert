#!/usr/bin/env bash
# Zips extension/ (manifest at the zip root) into dist/ for upload to the Chrome Web Store.
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(node -p "require('./extension/manifest.json').version")
out="dist/pending-review-nag-${version}.zip"
mkdir -p dist
rm -f "$out"
(cd extension && zip -r -X -q "../$out" . -x '.*' -x '*/.*' -x '__MACOSX/*')
unzip -l "$out"
echo "Wrote $out"
