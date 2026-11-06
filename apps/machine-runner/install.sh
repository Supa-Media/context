#!/bin/sh
# Installs context-machine from its GitHub Release. No sudo: it goes in your home.
#
#   curl -fsSL https://raw.githubusercontent.com/Supa-Media/context/main/apps/machine-runner/install.sh | sh
#   sh install.sh --version 0.1.0
#
# It asks GitHub for the newest release whose tag starts with machine-runner-v,
# because "latest" belongs to whichever release was made last in this repository.
# CONTEXT_MACHINE_VERSION (or --version) pins one; CONTEXT_MACHINE_DIR changes the
# install root (default: $HOME/.context-machine).
set -eu

REPO="Supa-Media/context"
TAG_PREFIX="machine-runner-v"
INSTALL_DIR="${CONTEXT_MACHINE_DIR:-$HOME/.context-machine}"
BIN_DIR="$INSTALL_DIR/bin"
VERSION="${CONTEXT_MACHINE_VERSION:-}"

die() {
  echo "install.sh: $*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version)
      [ $# -ge 2 ] || die "--version needs a value, e.g. --version 0.1.0"
      VERSION="$2"
      shift 2
      ;;
    --version=*)
      VERSION="${1#--version=}"
      shift
      ;;
    -h|--help)
      echo "usage: install.sh [--version X]   (X is 0.1.0 or machine-runner-v0.1.0)"
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

command -v curl >/dev/null 2>&1 || die "curl is required"

# Work out the release tag: pinned, or the newest machine-runner-v* release.
if [ -n "$VERSION" ]; then
  case "$VERSION" in
    "$TAG_PREFIX"*) TAG="$VERSION" ;;
    *) TAG="${TAG_PREFIX}${VERSION}" ;;
  esac
else
  TAG="$(curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=30" \
    | grep '"tag_name"' \
    | sed -e 's/.*"tag_name": *"\([^"]*\)".*/\1/' \
    | grep "^$TAG_PREFIX" \
    | head -n 1 || true)"
  [ -n "$TAG" ] || die "no machine-runner release found in the last 30 releases"
fi

# The tag goes into a URL, so only accept what a release tag can look like.
case "$TAG" in
  "$TAG_PREFIX"[0-9]*) ;;
  *) die "not a machine-runner release tag: $TAG" ;;
esac
case "$TAG" in
  *[!A-Za-z0-9._+-]*) die "not a machine-runner release tag: $TAG" ;;
esac

# Pick the target triple this build is published under.
os="$(uname -s)"
machine="$(uname -m)"
case "$machine" in
  x86_64|amd64) arch="x86_64" ;;
  arm64|aarch64) arch="aarch64" ;;
  *) die "unsupported architecture: $machine" ;;
esac
case "$os" in
  Linux) target="$arch-unknown-linux-musl" ;;
  Darwin) target="$arch-apple-darwin" ;;
  *) die "unsupported operating system: $os" ;;
esac

ARCHIVE="context-machine-$target.tar.gz"
BASE="https://github.com/$REPO/releases/download/$TAG"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cd "$tmp"

echo "Downloading context-machine $TAG for $target..."
curl -fsSL -o "$ARCHIVE" "$BASE/$ARCHIVE" || die "could not download $BASE/$ARCHIVE"
curl -fsSL -o "$ARCHIVE.sha256" "$BASE/$ARCHIVE.sha256" || die "could not download the checksum"

# Refuse anything that does not match the published digest.
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum -c "$ARCHIVE.sha256" >/dev/null 2>&1 || die "checksum mismatch; refusing to install"
elif command -v shasum >/dev/null 2>&1; then
  shasum -a 256 -c "$ARCHIVE.sha256" >/dev/null 2>&1 || die "checksum mismatch; refusing to install"
else
  die "need sha256sum or shasum to verify the download"
fi

tar -xzf "$ARCHIVE" context-machine || die "the archive does not contain context-machine"
[ -f context-machine ] || die "the archive does not contain context-machine"

mkdir -p "$BIN_DIR"
cp context-machine "$BIN_DIR/context-machine.new"
chmod 0755 "$BIN_DIR/context-machine.new"
mv -f "$BIN_DIR/context-machine.new" "$BIN_DIR/context-machine"

echo "Installed $BIN_DIR/context-machine"
echo
echo "Next:"
echo "  context-machine pair"
echo "  context-machine service install"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo
    echo "$BIN_DIR is not on your PATH. Add this line to your shell profile:"
    echo "  export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac
