#!/usr/bin/env bash
#
# Environment setup for unattended runners — Claude Code on the web, cloud
# sessions, and CI-like agents. Point the environment's "setup script" at this
# file; it is idempotent and safe to re-run.
#
# It does two things a fresh clone cannot do for itself.
#
# ── 1. Install dependencies, authenticated ──────────────────────────────────
#
# @supa-media/* live on GitHub Packages, so `pnpm install` fails without a
# token. `.npmrc` reads ${GITHUB_TOKEN} from the environment; on a runner that
# is usually already present, and locally `gh auth token` supplies it.
#
# ── 2. Make the checked-in permission allowlist actually apply ──────────────
#
# This is the non-obvious half. Project-level `permissions.allow` rules in
# .claude/settings.json are gated behind the workspace-trust dialog, and a
# non-interactive session never shows that dialog. So on a fresh clone the
# allow rules are read and then IGNORED, while deny rules always apply — an
# agent that looks correctly configured spends its run asking for permission
# it was already granted. See:
# https://code.claude.com/docs/en/permissions#project-allow-rules-and-workspace-trust
#
# The fix makes the allowlist effective two independent ways: copy it into
# user-level ~/.claude/settings.json, which is never trust-gated, and pre-seed
# workspace trust for the clone path so the project settings apply as written.
#
# Adapted from the identical script in Supa-Media/events-os and
# togathernyc/togather. If you change the shape here, change it there too —
# or better, push it upstream into supa-framework so new apps inherit it.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> Context setup: $REPO_ROOT"

# ── dependencies ────────────────────────────────────────────────────────────
#
# This whole section is best-effort, and deliberately cannot fail the script.
#
# GitHub Packages requires authentication even for *public* packages, so
# `@supa-media/*` cannot be fetched without a token — there is no anonymous
# fallback to degrade to. On Claude Code on the web there is no `gh` login and
# no ambient GITHUB_TOKEN, so the install fails.
#
# It used to fail the whole script. With `set -e` that meant the permission
# step below never ran and the environment refused to start at all — so the one
# session that could have reported the problem never existed. A session with no
# node_modules is still useful for docs, design and reading code; a session that
# will not start is useful for nothing.
INSTALL_OK=0

if [ -z "${GITHUB_TOKEN:-}" ] && command -v gh >/dev/null 2>&1; then
  if GH_TOKEN_VALUE="$(gh auth token 2>/dev/null)"; then
    export GITHUB_TOKEN="$GH_TOKEN_VALUE"
    echo "    GITHUB_TOKEN sourced from gh"
  fi
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "    SKIP: pnpm not found."
  echo "          corepack enable && corepack prepare pnpm@9.15.4 --activate"
elif [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "    SKIP: GITHUB_TOKEN is unset, so pnpm install cannot succeed."
else
  echo "==> pnpm install"
  # --frozen-lockfile so a runner can never silently resolve different
  # versions than CI did. If this fails, the lockfile genuinely needs updating
  # in a commit, which is a thing a human should see.
  if pnpm install --frozen-lockfile; then
    INSTALL_OK=1
  else
    echo "    pnpm install failed."
  fi
fi

# ── permissions ─────────────────────────────────────────────────────────────
echo "==> Applying the checked-in permission allowlist"

node - "$REPO_ROOT" <<'NODE'
const fs = require('fs');
const os = require('os');
const path = require('path');

const repoRoot = process.argv[2];
const settingsPath = path.join(repoRoot, '.claude', 'settings.json');

let allow = [];
try {
  allow = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).permissions?.allow ?? [];
} catch {
  console.log('    no .claude/settings.json — nothing to apply');
  process.exit(0);
}

// 1. User-level settings are never trust-gated.
const userSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
fs.mkdirSync(path.dirname(userSettingsPath), { recursive: true });
let userSettings = {};
try {
  userSettings = JSON.parse(fs.readFileSync(userSettingsPath, 'utf8'));
} catch {}
userSettings.permissions = userSettings.permissions ?? {};
userSettings.permissions.allow = [
  ...new Set([...(userSettings.permissions.allow ?? []), ...allow]),
];
fs.writeFileSync(userSettingsPath, JSON.stringify(userSettings, null, 2) + '\n');

// 2. Pre-seed workspace trust so the project settings apply as written too.
const claudeJsonPath = path.join(os.homedir(), '.claude.json');
let claudeJson = {};
try {
  claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
} catch {}
claudeJson.projects = claudeJson.projects ?? {};
claudeJson.projects[repoRoot] = {
  ...(claudeJson.projects[repoRoot] ?? {}),
  hasTrustDialogAccepted: true,
};
fs.writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2) + '\n');

console.log(`    ${allow.length} allow rules applied; trusted ${repoRoot}`);
NODE

echo "==> Done."
echo ""

if [ "$INSTALL_OK" -ne 1 ]; then
  echo "  ############################################################"
  echo "  #  DEPENDENCIES ARE NOT INSTALLED — read this before working"
  echo "  ############################################################"
  echo ""
  echo "  node_modules is absent or incomplete, so anything that runs code"
  echo "  will fail: pnpm test, tsc, vitest, jest, wrangler, expo."
  echo "  Reading, writing and reviewing code all still work."
  echo ""
  echo "  Cause: @supa-media/* are hosted on GitHub Packages, which demands"
  echo "  authentication even for public packages. There is no anonymous"
  echo "  fallback, so without a token the install cannot succeed."
  echo ""
  echo "  To fix, give the environment a GITHUB_TOKEN with read:packages:"
  echo "    - Claude Code on the web: add it as a secret in the environment's"
  echo "      configuration. There is no gh login there to fall back to."
  echo "    - Locally: gh auth login   (this script then picks it up)"
  echo "    - CI: it is already passed as secrets.GITHUB_TOKEN"
  echo ""
  echo "  This script exits 0 on purpose. Failing here would stop the session"
  echo "  from starting at all, and a session that cannot start cannot tell"
  echo "  anyone what is wrong."
  echo ""
fi

echo "    Not done here, because each needs a credential this script should"
echo "    not assume it has:"
echo "      npx convex dev        # links a Convex deployment"
echo "      cp .env.example .env.local"
