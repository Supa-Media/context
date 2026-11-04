#!/usr/bin/env bash
# Attaches the Linux AppImages and .debs in the directory $1 to the release the
# Mac job of `deploy-desktop.yml` just created, and refuses if the two jobs
# stamped different versions: a Linux file of one version on another version's
# release is a download that does not match what it says it is.
#
# Reads MAC_VERSION, LINUX_VERSION, GITHUB_REPOSITORY and GH_TOKEN.
set -euo pipefail
dir="$1"
if [ "$MAC_VERSION" != "$LINUX_VERSION" ]; then
  echo "::error::The Mac release is v$MAC_VERSION but the Linux build is v$LINUX_VERSION — not attaching a different version to it."
  exit 1
fi
gh release upload "v$MAC_VERSION" "$dir"/*.AppImage "$dir"/*.deb --repo "$GITHUB_REPOSITORY"
echo "Attached the Linux AppImages and .debs to v$MAC_VERSION."
