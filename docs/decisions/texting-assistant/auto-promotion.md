# Auto-promotion and the spend cap

Part of [benchmarks](./benchmarks.md), split out to keep that file short.

## The loop promotes on its own, through a gate, under a spend cap (2026-10-17)

**Decided by Dev2 (2026-10-17)**: "I want the testing loop to work
autonomously without me having to approve things as long as it's under the
budget cap, including running actions and promoting to prod", and, asked to
confirm, "yes add auto promote and the spend cap to the benchmark action".
This replaces the 2026-10-16 rule that only a person promotes. The improver
still never promotes its own draft; a setup goes live only through the gate.

- **The AI Promote Action** (`.github/workflows/ai-promote.yml`,
  `pnpm ai promote`, `bench/promote.mjs`) reads the scored results of AI
  Benchmark runs that already happened, one per test the gate names (core
  and tasks for the texting assistant), each running `production` and the
  candidate side by side. It spends no model money.
- **The gate** (`promotionVerdict`) refuses a round of an earlier live file,
  an earlier candidate or an earlier test version; fewer runs than the test's
  own, or a case left out; a test weakened against the repository's copy
  (`weakenedLines`: a case gone or drafted again, a graded line gone, a lower
  score bar, fewer runs), so a line cut in the app cannot buy a promotion
  and cutting one takes a reviewed commit; a candidate under the loop's bars
  (core 17 of 19 in every run with no gate broken, golden tasks 75%), erring
  more than live, or scoring lower than live on any test; a price or speed
  over its bar and more than a tenth over live's; and a candidate not better
  by more than noise: at least two more cases passing in every run, summed
  over the tests, or the same scores for a tenth less. The same live prompt
  scored 72% and 83% in two core rounds that day, so one case is noise.
  A skill only the candidate's folder has refuses it too.
- **A promotion archives the replaced file** in `@context-lc
  ai/history/<job>/` first, and writes `from`, `came_from`, `proved_by`,
  `why` and `promoted_by` naming the rounds. `revert` puts the newest
  archived file back, archiving the one it replaces, so a revert is undone
  by reverting again.
- **The spend cap** (`bench/spend.mjs`): `@context-lc ai/results/spend.md`
  holds `cap_usd` (Dev2's $20) and a row per round. AI Benchmark refuses a
  round whose expected cost (the dearest a setup has cost on that test
  before, per setup, or $1 for a test never run) would take the total past
  the cap, and records each round's answers' price plus a fifth for the
  judge and the played person. A person raises the cap by editing the note.

**What a simplification would cost:** a gate that trusts the test as it
stands in the app is beaten by deleting the line that fails; one that takes
any higher score promotes noise; one that skips the version check promotes a
file nobody measured; a cap kept by the agent rather than the Action is a
promise, not a limit. Tests (`bench/test/promote.test.mjs`): "a test cut in
the app cannot buy a promotion" (the graded-line check sabotaged, it fails),
"the spend note's total and cap are read back, and a round past the cap is
refused" (the cap check sabotaged, it fails), "a round of an earlier live
file or an earlier candidate proves nothing", "a candidate under the bar,
worse than live, broken on a gate, or no better is refused".
