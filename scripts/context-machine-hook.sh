#!/bin/sh
# Claude Code's hooks for a cloud session of this repository: the session's VM joins Context as a mail-only device,
# so other agents and Tex can mail it and the session sees the mail at once
# (docs/decisions/texting-assistant/machines.md, "A cloud VM as a mail-only device").
#
#   .claude/settings.json runs: sh scripts/context-machine-hook.sh <SessionStart|UserPromptSubmit|PostToolUse|Stop|SessionEnd>
#
# Only in Claude Code on the web (CLAUDE_CODE_REMOTE=true): a laptop may run a full runner of its own, which this
# must never touch. CONTEXT_MACHINE_HOOKS=off turns it off. On SessionStart it installs the runner if it is missing.
# Whatever happens it exits 0 and prints only what the runner prints: a hook that fails puts an error over the
# person's prompt.
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
[ "${CONTEXT_MACHINE_HOOKS:-on}" = "off" ] && exit 0
event="${1:-}"

bin="$(command -v context-machine 2>/dev/null || true)"
[ -n "$bin" ] || bin="${CONTEXT_MACHINE_DIR:-$HOME/.context-machine}/bin/context-machine"
if [ ! -x "$bin" ] && [ "$event" = "SessionStart" ]; then
  curl -fsSL --max-time 60 https://raw.githubusercontent.com/Supa-Media/context/main/apps/machine-runner/install.sh 2>/dev/null | sh >/dev/null 2>&1 || true
fi
[ -x "$bin" ] || exit 0

"$bin" hook "$event" 2>/dev/null || true
exit 0
