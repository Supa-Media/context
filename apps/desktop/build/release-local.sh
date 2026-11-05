#!/usr/bin/env bash
# Publish a signed, notarised Mac release from a Mac, without a GitHub runner.
#
#   bash apps/desktop/build/release-local.sh            # build, check, publish
#   bash apps/desktop/build/release-local.sh --dry-run  # build and check only
#
# The same release `deploy-desktop.yml` makes, for the days GitHub has no Mac
# runner to give it (2026-11-04: "not acquired by Runner of type hosted" for
# over an hour). It does the workflow's steps in the workflow's order: refuse
# anything but a clean checkout of origin/main, pick a version newer than every
# release, sign from a throwaway keychain, notarise, open each app with
# `--smoke`, and only then create the GitHub Release that electron-updater
# reads. Installed copies then update themselves; nobody reinstalls.
#
# What it needs on the Mac (each is checked before anything is built):
#   - Xcode command line tools, Node 22+, pnpm, Rust (rustup), gh signed in
#     with write access to the repository.
#   - The 1Password CLI `op` signed in to the account holding the `Context`
#     vault, or OP_SERVICE_ACCOUNT_TOKEN exported for a service account: the
#     five signing values are read from it at run time
#     (op://Context/<NAME>/production) and never written anywhere but a
#     temporary directory deleted on exit. A value already in the environment
#     is used instead of the vault's.
#
# The Linux app is not built here; the next workflow run carries it.
set -euo pipefail

repo="Supa-Media/context"
dry_run=false
[ "${1:-}" = "--dry-run" ] && dry_run=true

say() { printf '\n== %s\n' "$*"; }
die() { printf '\nSTOPPED: %s\n' "$*" >&2; exit 1; }

root="$(git rev-parse --show-toplevel 2>/dev/null)" || die "run this inside a checkout of $repo"
cd "$root"

say "Checking this Mac"
[ "$(uname -s)" = "Darwin" ] || die "this builds the Mac app, so it runs on a Mac"
for tool in node pnpm cargo rustup gh op xcrun security codesign; do
  command -v "$tool" >/dev/null || die "$tool is not installed or not on PATH"
done
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' \
  || die "Node $(node -v) is too old; the desktop app needs 22 or newer"
gh auth status >/dev/null 2>&1 || die "gh is not signed in (run: gh auth login)"
for target in aarch64-apple-darwin x86_64-apple-darwin; do
  rustup target list --installed | grep -qx "$target" || rustup target add "$target"
done

say "Checking the checkout is origin/main, unchanged"
git fetch --quiet origin main
[ -z "$(git status --porcelain)" ] || die "the checkout has uncommitted changes; use a clean clone"
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] \
  || die "HEAD is not origin/main; run: git checkout --detach origin/main"
commit="$(git rev-parse --short HEAD)"

say "Picking the version"
base="$(node -p 'require("./apps/desktop/package.json").version')"
# Only the app's own `v<x.y.z>` tags: GitHub's "latest" can be a machine-runner release.
latest="$( (gh release list --repo "$repo" --limit 100 --json tagName -q '.[].tagName' 2>/dev/null || true) | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1 || true)"
latest="${latest:-v0.0.0}"
version="$(node -e '
  const [base, latest] = process.argv.slice(1);
  const [major, minor] = base.split(".").map(Number);
  const last = latest.replace(/^v/, "").split(".").map(Number);
  const patch = last[0] === major && last[1] === minor ? last[2] + 1 : 0;
  if (![major, minor, patch].every(Number.isInteger)) throw new Error(`cannot derive a version from ${base} and ${latest}`);
  console.log(`${major}.${minor}.${patch}`);
' "$base" "$latest")"
tag="v$version"
gh release view "$tag" --repo "$repo" >/dev/null 2>&1 && die "$tag already has a release"
echo "Latest release $latest; this one will be $tag, from $commit."

work="$(mktemp -d)"
keychain=""
keychains_before="$work/keychains.before"
cleanup() {
  if [ -n "$keychain" ]; then
    # shellcheck disable=SC2046
    [ -s "$keychains_before" ] && /usr/bin/security list-keychains -d user -s $(cat "$keychains_before")
    /usr/bin/security delete-keychain "$keychain" 2>/dev/null || true
  fi
  rm -rf "$work"
  git -C "$root" checkout --quiet -- apps/desktop/package.json 2>/dev/null || true
}
trap cleanup EXIT

say "Installing dependencies"
# Before the signing checks: build/notarize.cjs --check needs @electron/notarize.
pnpm install --filter "@context/desktop..." --frozen-lockfile

say "Reading the signing values from 1Password"
secret() {
  local name="$1"
  if [ -n "${!name:-}" ]; then printf '%s' "${!name}"; return; fi
  op read "op://Context/$name/production" 2>/dev/null \
    || die "op could not read op://Context/$name/production (signed in to the right account? is the item there?)"
}
CSC_LINK="$(secret CSC_LINK)"
CSC_KEY_PASSWORD="$(secret CSC_KEY_PASSWORD)"
ASC_API_KEY_P8="$(secret ASC_API_KEY_P8)"
ASC_KEY_ID="$(secret ASC_KEY_ID)"
ASC_ISSUER_ID="$(secret ASC_ISSUER_ID)"
export ASC_API_KEY_P8 ASC_KEY_ID ASC_ISSUER_ID

say "Making a throwaway keychain to sign from"
# The workflow's reason holds here too: handed CSC_LINK, electron-builder makes
# its own keychain and unlocks it with the wrong password
# (docs/decisions/desktop/signing-and-credentials.md).
p12="$work/signing.p12"
printf '%s' "$CSC_LINK" | tr -d '\r\n' | /usr/bin/openssl base64 -d -A > "$p12" \
  || die "CSC_LINK is not base64 of a .p12"
keychain="$work/signing.keychain-db"
keychain_password="$(/usr/bin/openssl rand -base64 24)"
/usr/bin/security list-keychains -d user | sed -e 's/^[[:space:]]*"//' -e 's/"$//' > "$keychains_before"
/usr/bin/security create-keychain -p "$keychain_password" "$keychain"
/usr/bin/security set-keychain-settings -lut 21600 "$keychain"
/usr/bin/security unlock-keychain -p "$keychain_password" "$keychain"
/usr/bin/security import "$p12" -k "$keychain" -f pkcs12 -P "$CSC_KEY_PASSWORD" \
  -T /usr/bin/codesign -T /usr/bin/security -T /usr/bin/productbuild >/dev/null
/usr/bin/security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain" >/dev/null
# shellcheck disable=SC2046
/usr/bin/security list-keychains -d user -s "$keychain" $(cat "$keychains_before")
rm -f "$p12"
unset CSC_LINK CSC_KEY_PASSWORD
/usr/bin/security find-identity -v -p codesigning "$keychain" | grep -q "Developer ID Application" \
  || die "the certificate imported but is not a Developer ID Application identity macOS will sign with"
(cd apps/desktop && node build/notarize.cjs --check) || die "the App Store Connect key does not check out"

say "Testing, building"
(cd apps/desktop && node -e '
  const fs = require("node:fs");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  pkg.version = process.argv[1];
  fs.writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
' "$version")
(cd apps/desktop && node --experimental-strip-types test/test.mjs && pnpm exec tsc --noEmit)
bash apps/desktop/build/build-machine-runner.sh
(
  cd apps/desktop
  rm -rf release
  # The signed flag is baked into the JavaScript at build time (scripts/build.mjs), so it must be set
  # here, not only for electron-builder: v0.1.71 and v0.1.72 were built without it and cannot update.
  CONTEXT_DESKTOP_SIGNED=true pnpm run build
  grep -q "signed: true" dist/main/index.cjs && ! grep -q "signed: false" dist/main/index.cjs \
    || die "the bundle was not built as a signed release (CONTEXT_DESKTOP_SIGNED)"
  CSC_KEYCHAIN="$keychain" CSC_IDENTITY_AUTO_DISCOVERY=true CONTEXT_DESKTOP_SIGNED=true \
    pnpm exec electron-builder --mac --config electron-builder.yml --publish never 2>&1 \
    | bash build/redact-signing-log.sh
  bash build/mac-update-floor.sh
)

say "Checking what was built"
cd apps/desktop
for app in release/mac-arm64/Context.app release/mac/Context.app; do
  codesign --verify --deep --strict "$app" || die "$app does not verify"
  xcrun stapler validate "$app" >/dev/null || die "$app has no notarisation ticket"
  spctl --assess --type execute "$app" || die "Gatekeeper refuses $app"
done
grep -q "^version: $version\$" release/latest-mac.yml || die "latest-mac.yml does not name $version"

say "Opening the app with --smoke"
log="$work/smoke.log"
env -u ELECTRON_RUN_AS_NODE release/mac-arm64/Context.app/Contents/MacOS/Context --smoke > "$log" 2>&1 &
pid=$!
( sleep 60; kill -9 "$pid" 2>/dev/null ) &
watchdog=$!
status=0
wait "$pid" || status=$?
kill "$watchdog" 2>/dev/null || true
if [ "$status" -ne 0 ] || grep -qE 'Uncaught Exception|A JavaScript error occurred|Dynamic require' "$log"; then
  tail -n 40 "$log" | bash build/redact-signing-log.sh
  die "the built app did not open cleanly (exit $status)"
fi
echo "The app opened and exited cleanly."

if [ "$dry_run" = true ]; then
  say "Dry run: built and checked $tag, published nothing"
  ls -la release/*.dmg release/*.zip release/latest-mac.yml
  exit 0
fi

say "Publishing $tag"
gh release create "$tag" release/*.dmg release/*.zip release/latest-mac.yml \
  --repo "$repo" --target "$(git rev-parse HEAD)" --title "$tag" \
  --notes "Built, signed, notarised and smoke-tested on a Mac by apps/desktop/build/release-local.sh from $commit."
echo "Published $tag. Installed copies pick it up from latest-mac.yml; nobody needs to reinstall."
