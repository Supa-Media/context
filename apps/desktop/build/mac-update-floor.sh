#!/usr/bin/env bash
# Keep older Macs off a build they cannot open.
#
# Every copy already installed checks release/latest-mac.yml on launch, and its
# electron-updater skips a release whose `minimumSystemVersion` is above the
# running system. It compares that value with `os.release()`, the Darwin kernel
# version, not the macOS version: 21.0.0 is macOS 12, the floor for the
# Electron this app ships (see `minimumSystemVersion` in electron-builder.yml).
# electron-builder does not write the key for a mac zip, so the release
# workflow runs this after the build and before anything is published. Without
# it, a Mac on macOS 11 would install an update that cannot launch. Only the
# yml changes; the sha512 it carries is the zip's.
set -euo pipefail
feed="${1:-release/latest-mac.yml}"
[ -f "$feed" ] || exit 0
grep -q '^minimumSystemVersion:' "$feed" || echo 'minimumSystemVersion: 21.0.0' >> "$feed"
grep '^minimumSystemVersion:' "$feed"
