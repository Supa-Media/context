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
# The desktop .icns is generated here too, into apps/desktop/build, rather than
# by a second script over there. There is one mark, and it is this one — a
# parallel pipeline is how the two drift, and how one of them gets forgotten the
# next time the palette moves. The vector for it lives beside the others for the
# same reason, even though the surface it dresses is not the mobile app.
#
# Requires librsvg and ImageMagick:  brew install librsvg imagemagick
# The .icns additionally needs iconutil, which ships with macOS — on Linux the
# four PNGs are still regenerated and only the .icns step is skipped.
set -euo pipefail
cd "$(dirname "$0")"
out=..
desktop=../../../desktop/build

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

# macOS app icon, for electron-builder's `mac.icon` in apps/desktop.
#
# An .icns is a container, not an image, and macOS picks the member matching the
# surface it is drawing: 16 and 32 for the Finder list and the menu bar, 128 and
# 256 for icon view, 512 and 1024 for the Dock at 2x and Quick Look. Ship one
# 1024 and the Dock is right while the Finder list is a smeared downscale, which
# is the usual way a "working" icns still looks wrong.
#
# Every rung is rendered from the vector at its final size rather than resampled
# from the 1024: at 16px the difference between rasterising the strokes and
# shrinking them is the difference between a readable # and a grey smudge.
if command -v iconutil >/dev/null; then
  iconset="$(mktemp -d)/icon.iconset"
  mkdir -p "$iconset"
  for size in 16 32 128 256 512; do
    rsvg-convert -w "$size" -h "$size" desktop-icon.svg -o "$iconset/icon_${size}x${size}.png"
    rsvg-convert -w "$((size * 2))" -h "$((size * 2))" desktop-icon.svg -o "$iconset/icon_${size}x${size}@2x.png"
  done
  mkdir -p "$desktop"
  iconutil -c icns "$iconset" -o "$desktop/icon.icns"
  icns_members=$(find "$iconset" -name '*.png' | wc -l | tr -d ' ')
  rm -rf "$(dirname "$iconset")"
else
  echo "note: iconutil not found (not macOS) — skipped the desktop .icns" >&2
fi

echo "Regenerated:"
for f in icon adaptive-icon splash favicon; do
  printf '  %-18s ' "$f.png"
  magick identify -format '%wx%h %[channels]\n' "$out/$f.png"
done
if [ -f "$desktop/icon.icns" ]; then
  printf '  %-18s %s members, 16px to 1024px\n' "icon.icns" "${icns_members:-?}"
fi
