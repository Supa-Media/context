#!/usr/bin/env bash
# "Let Tex use this Mac": the Rust runner (`apps/machine-runner`), built for
# both Mac CPUs and joined into one binary that electron-builder carries as
# `Resources/machine-runner/context-machine` (`electron-builder.yml`,
# `extraResources`) and signs with the app. `deploy-desktop.yml` runs this
# only once the runner exists in the tree; a build without it ships the
# switch as unavailable rather than failing (`src/core/machine/runner.ts`).
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
manifest="$root/apps/machine-runner/Cargo.toml"
out="$root/apps/desktop/resources/machine-runner"
rustup target add aarch64-apple-darwin x86_64-apple-darwin
for target in aarch64-apple-darwin x86_64-apple-darwin; do
  cargo build --release --locked --manifest-path "$manifest" --target "$target"
done
mkdir -p "$out"
lipo -create -output "$out/context-machine" \
  "$root/apps/machine-runner/target/aarch64-apple-darwin/release/context-machine" \
  "$root/apps/machine-runner/target/x86_64-apple-darwin/release/context-machine"
chmod 755 "$out/context-machine"
lipo -info "$out/context-machine"
