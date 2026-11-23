#!/usr/bin/env bash
# Local harness, NOT committed: the Areas folder page (List and Chart, desktop
# and phone, light and dark) as PNGs. Writes HTML with scripts/areas-shots.ts,
# then photographs it with scripts/capture-chaos-shots.mjs.
#
#   AREAS_SHOT_DIR=/path PW_EXE=/path/to/chromium scripts/areas-shots.sh
#
# AREAS_SHOT_DIR defaults to /tmp/areas-shots; PNGs land in $AREAS_SHOT_DIR/png.
set -euo pipefail
cd "$(dirname "$0")/.."
DIR="${AREAS_SHOT_DIR:-/tmp/areas-shots}"
mkdir -p "$DIR"
AREAS_SHOT_DIR="$DIR" pnpm exec jest --testMatch '**/scripts/areas-shots.ts' --testPathIgnorePatterns '[]'
PW_EXE="${PW_EXE:-}" node scripts/capture-chaos-shots.mjs "$DIR" "$DIR/png"
