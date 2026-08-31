#!/usr/bin/env bash
#
# Regenerates every app asset from the vector sources beside this script.
#
# The PNGs in ../ are build outputs. They were once edited and lost: all three
# of icon.png, adaptive-icon.png and splash.png sat corrupt in this repo for
# months, their PNG signature byte 0x89 replaced by U+FFFD with 280 further
# replacement sequences through each body — a UTF-8 text round-trip by a tool
# that treated a binary as text. Nothing caught it, because favicon.png happened
# to survive and web is the only surface that had ever been built.
#
# Vector sources are text. A text round-trip cannot destroy them, and if a PNG
# is ever mangled again it is one command to get it back.
#
# Requires librsvg and ImageMagick:  brew install librsvg imagemagick
set -euo pipefail
cd "$(dirname "$0")"
out=..

need() { command -v "$1" >/dev/null || { echo "missing '$1' — brew install librsvg imagemagick" >&2; exit 1; }; }
need rsvg-convert
need magick

# iOS/App Store icon. Flattened onto the ground and stripped of its alpha
# channel: App Store Connect rejects an icon with transparency, and rsvg emits
# RGBA regardless of whether anything in the drawing is actually translucent.
rsvg-convert -w 1024 -h 1024 icon.svg -o "$out/icon.png"
magick "$out/icon.png" -background "#050506" -alpha remove -alpha off "$out/icon.png"

# Android adaptive foreground. Keeps its alpha — the ground is supplied by
# android.adaptiveIcon.backgroundColor in app.config.js.
rsvg-convert -w 1024 -h 1024 adaptive-icon.svg -o "$out/adaptive-icon.png"

# Splash mark, composited by expo-splash-screen on the per-scheme background.
rsvg-convert -w 512 -h 512 splash.svg -o "$out/splash.png"

# Web favicon.
rsvg-convert -w 256 -h 256 favicon.svg -o "$out/favicon.png"

echo "Regenerated:"
for f in icon adaptive-icon splash favicon; do
  printf '  %-18s ' "$f.png"
  magick identify -format '%wx%h %[channels]\n' "$out/$f.png"
done
