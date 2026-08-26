#!/usr/bin/env bash
# Upload the brain skeleton into the R2 bucket. Run once, after `wrangler deploy`.
# Safe to re-run: it only touches the skeleton files themselves.
set -euo pipefail
cd "$(dirname "$0")/brain-skeleton"

find . -type f | sed 's|^\./||' | while read -r f; do
  echo "→ $f"
  npx wrangler r2 object put "brain/$f" --file "$f" --remote
done
echo "done."
