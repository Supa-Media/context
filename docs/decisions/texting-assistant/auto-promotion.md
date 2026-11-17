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
  (core 17 of 19 in every run with no gate broken, golden tasks 75%,
  splitting big asks 10 of 11, added 2026-11-04 so the planner is checked
  in every promotion), erring
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
  Superseded for the cap's shape on 2026-11-17 by the monthly budget below.
  A note that still has only `cap_usd` keeps this all-time check.

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

## The budget is a month, with one month of rollover and a replay-gate line (2026-11-17)

**Decided by Dev2 (2026-11-17):** the all-time cap had reached $62.80 against
$50, and nightly evals were not running. Replace it with $40 a calendar
month, resetting at 00:00 on the 1st in America/New_York. Unused budget
carries into the next month only, and only up to $20, so the most a month
can hold is $60. A day stops at $15, and the next day starts again. The
replay gate has its own line of $10 a month inside that same budget, so it
cannot spend the night's room.

- **Where it lives.** `@context-lc ai/results/spend.md`, read by the AI
  Benchmark Action, the Tex nightly, and Tex replay before a round spends.
  The front matter is `monthly_cap_usd`, `rollover_max_usd`,
  `daily_cap_usd` and `replay_gate_monthly_cap_usd`. A person raises a
  number by editing the note. Rows already written stay as history. The
  total line shows this month against its limit, today against the daily
  cap, and replay-gate against its line.
- **The month's limit.** It walks forward from the earliest row. The first
  month's limit is `monthly_cap_usd`. Each later month, including a month
  with no rows, is `monthly_cap_usd` plus `min(rollover_max_usd, max(0,
  last month's limit minus last month's spend))`. The carry looks back one
  month: two quiet months do not stack past `monthly_cap_usd +
  rollover_max_usd`. That sum is the ceiling ($60 at these numbers). It is
  not a third setting. Spend past a limit does not borrow from the next
  month. An unreadable rollover carries nothing.
- **The day.** A row's date is an America/New_York civil date. A check uses
  the runner's clock in that zone. The day and the month both open at
  00:00, including across the daylight-saving change. A round that would
  pass the day's cap is refused until the next civil day, even when the
  month has room.
- **The replay-gate line.** Rows whose test is `replay-gate` are summed for
  the month and capped by `replay_gate_monthly_cap_usd`, which defaults to
  $10 when the key is absent. The line does not roll over and does not
  shrink the month's limit. A replay-gate round is refused when its
  expected cost would pass that line, or the month's limit, or the day's
  cap. Any other test is refused only by the month and the day, so it can
  spend the part of the line this month has not used. The line only stops
  replay-gate from taking the rest: at these numbers it can take at most
  $10 of a $40 month, and whatever it does not take stays in the month for
  the nightly and the other tests. An unreadable line refuses replay-gate
  and leaves other tests alone. Examiner and Claude Code replays record
  nothing, so they are not refused by the line.
- **What a round is expected to cost** is unchanged: per setup, the most a
  setup has cost on that test, or $1 when the test has never run. Cents
  decide. Landing on a cap is allowed. One cent over is refused. An
  unreadable monthly or daily cap refuses every round.

**What a simplification would cost:** a carry that stacks every quiet month
turns a pause into an unbounded budget; a carry that forgets last month's
limit (and uses the base $40) drops unused room from a $60 month; a
replay-gate line that also shrinks the month withholds the night's room on
a month replay-gate did not spend; a line kept only in the workflow is
skipped by the next caller. Tests (`bench/test/spend.test.mjs`): "a new
month drops last month's spend, and the rollover is last month's unused
limit", "a day resets at midnight in America/New_York, including the
daylight-saving change", "rollover reaches back one month, caps at
rollover_max, and does not stack", "a replay-gate round stops at its
sub-cap, and another test can use the rest of the month", "a replay-gate
round still stops at the month limit and the daily cap", "the replay-gate
sub-cap resets each month and does not grow when the month's limit does",
"a missing replay sub-cap is $10, and an unreadable one refuses replay-gate
only". The all-time note stays covered by "the spend note's total and cap
are read back, and a round past the cap is refused" in
`bench/test/promote.test.mjs`.
