#!/usr/bin/env bash
# Renders store/assets/icon.svg to the PNG sizes the manifest and the store need. Requires ImageMagick.
set -euo pipefail
cd "$(dirname "$0")/.."
for size in 16 32 48 128; do
  magick -background none -density 384 store/assets/icon.svg -resize "${size}x${size}" "extension/icons/icon-${size}.png"
done
cp extension/icons/icon-128.png store/assets/store-icon-128.png
ls -l extension/icons store/assets/store-icon-128.png
