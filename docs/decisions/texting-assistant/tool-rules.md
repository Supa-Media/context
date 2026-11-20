# Four rules for Tex's tools, held in CI and watched in the Lab (2026-11-20)

The owner adopted four rules for every tool a model is shown, and asked for
them in CI and "surfaced and monitored in the Tools tab in the lab":

1. **One fixed tool list.** Never add or remove a tool between turns; a tool
   that can't run right now stays listed and answers with a clear error.
2. **Each tool's description and schema under 4,000 characters.**
3. **State through dedicated tools, never a shell or a plain file write.**
4. **Every error says what to do next.**

An audit that day (Context note `projects/tex/tool-rules-audit.md` in the
team workspace) found Tex's own tools far off: 61 different tool lists across
253 production model calls, `send` alone shown in 47 forms; 1:1 `send` at
about 25,000 characters; four of Tex's state files written as plain notes;
and 29% of tool failures were calls to a tool or action the turn didn't hold.
The Context MCP's own tools passed rules 1 and 2.

**The rules are one module:** `packages/shared/src/toolRules.cjs` (the limit,
how a tool's size is counted, how an error is rated actionable, partial or
not, and which files are Tex's state). The gateway, Convex and the CI check
all read it, so the Lab and CI never disagree on a rating.

**CI is a ratchet** (`apps/mcp/test/toolRules.test.mjs`, baseline
`apps/mcp/test/toolRules/baseline.json`, measured through the replay harness
by `apps/mcp/test/toolRules/report.mjs`): no surface may gain a tool list or
a differing tool, no tool may grow past `max(4000, its baseline)`, no shell
tool or new generic state file, and no source file may gain a
non-actionable error. A fix lowers the baseline with
`node scripts/tool-rules.mjs --write` in the same pull request.

**Production is measured, never estimated.** Every turn logs the tool list its
model was shown (a fingerprint of the list and each tool's name, size and
fingerprint) and which state file a plain write touched. The Lab's Tools tab
draws the "Tool rules" panel from that, and tex_dev `tool_stats` returns the
same numbers under `rules`. A turn from before this was logged counts for
nothing.

**What it would cost to drop:** without the ratchet, each feature adds a
conditional tool or a long description again, and cache misses and calls to
tools a turn didn't hold come back unseen. `toolRules.test.mjs` fails when any
number grows; `apps/convex/__tests__/texLabToolStats.test.ts` fails when the
report miscounts.
