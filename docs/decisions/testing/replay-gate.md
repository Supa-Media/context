# Tex changes merge only through the replay gate

Decided by the owner, 2026-11-13, after a diagnosis of why Tex regressions
felt random: "Let's build everything except for D", "make it strict in the
CI/CD that ... changes to [Tex] can't merge without doing the full replay and
passing and being better", "Can we get each change to be less than $1?", and
"if we can split up the tests into different areas that we know, like the
code only affects that area, that'll be nice."

## Why

Most of the breaks people saw in November were not the model. They were the
code around it: a cached copy that hid Tex's own replies for three days
(#2724, fixed #3042), group texts written to the History hours late after a
deploy (#3224), a group check-in answering a day-old text, a new group's
first turn taking a retired path (#3200). Each had unit tests, each passed,
and none was caught before people saw it, because nothing replayed a chat
across turns, deploys and paths, the benchmark ran only by hand, and a fix
did not have to leave a case behind.

## The rule

1. **Plumbing replays run on every pull request, free.** `apps/mcp/test/replay/`
   holds chats that once went wrong, rewritten with invented people and words.
   Each runs through the real `/agent` pipeline, its stores and its ledger,
   with a scripted model, and checks in plain code what the model was shown
   and what the chat kept. They are in `test/unit.list`, so a failing case
   fails the gateway's tests and blocks the merge like any other.
2. **A Tex change brings its case.** `scripts/check-tex-change-has-case.mjs`
   (in Fast repository guards) fails a pull request that changes Tex's code
   (`apps/mcp/src/agent/`, `apps/agent/src/`, `packages/shared/src/text*`)
   without adding or changing a replay case, a respond or review case, or a
   benchmark question. A change no case can show says why on its own line:
   `No replay case: <why>`.
3. **Model runs only for the area a change touches, capped at $1.** The
   judge's files run the reply-or-quiet cases; the reviewer's run the reviewer
   cases; each of the advisor's four roles runs its own cases, and their
   shared core runs all four ([advisor-roles](./advisor-roles.md)); the front
   door and prompt modules run the core set and simple asks.
   A run must not score below main's on the same cases; a must-pass case main
   passes may never fail. Only failed cases are run again, up to three times,
   to tell a regression from noise. Golden browser tasks run nightly, not per
   change. Measured costs (`@context-lc ai/results/spend.md`, 2026-11-12):
   core x2 $0.13, web facts $0.08, simple asks $0.01.
   **How it runs:** the model runs need production's AI keys, and a workflow
   holding those never runs on a pushed branch by itself
   (`scripts/check-workflow-triggers.mjs`). So the agent that opens a Tex pull
   request dispatches **Tex replay** (`tex-replay.yml`) on its branch. It runs
   `pnpm ai gate` (`apps/mcp/bench/replayGate.mjs`) against main beside it,
   marks the head commit with the status `Tex replay`, and re-runs the pull
   request's check **Tex replay required** (`tex-replay-check.yml`,
   `scripts/tex-replay-required.mjs`), which holds no secret and is red until
   that status is green. The run's summary is the feedback for the change's
   author: which cases regressed and what each expected, held-out ones by cause.
   Main is never run whole: the change answers every case once, only its
   mistakes are run again (twice more on the change, three times on main), and
   a case regressed when it is wrong in most of the change's runs and right in
   most of main's. A case main lacks (the change's own) must pass.
   **The areas** (`replayAreas.mjs`, each with its runner and limits in
   `replayGate.mjs` `RUNNERS` and `AREA_LIMITS`): `respond` (the one judge's
   cases), `review` (the reply reviewer's), and `core` (`coreArea.mjs`): a
   change to `texEntryPoint/`, the turn, the prompt and its modules, the
   production reader, the front door or the advisor runs the core set and the
   simple asks through `pnpm ai run` and `pnpm ai judge` as the live setup
   (pulled into both trees from Context), one case a question, about $0.15
   a change plus its mistakes.
   **One sign-in at a time, nobody dropped:** the workflows that sign in as
   the benchmark runner (AI Benchmark, AI Promote, Tex replay, Tex nightly)
   start with a `wait-turn` job (`scripts/bench-runner-lock.mjs`) that waits
   for every earlier run of them to end, because the runner's refresh token
   rotates on every use. A shared `concurrency` group did this until
   2026-11-13 and cancelled every pending run but one, so replays dispatched
   by several agents cancelled each other and left their checks red. The cheap areas share one $1 pool a change; an
   area whose reruns would pass it is refused. What each replay spent is a row
   in `@context-lc ai/results/spend.md` (`replay-gate`).
5. **Target cases.** A case that captures a bug not yet fixed is a target: a
   bench question's `- target: <cause>` line, or a respond or review case's
   `"target": "<cause>"`. It runs, it is reported apart, and it never blocks a
   merge or fails an area's bar; fixing the bug is removing the line.
6. **Every night, everything.** `tex-nightly.yml` (`pnpm ai nightly`,
   `bench/nightly.mjs`) runs every area three times as the live setup: core
   and simple asks, the golden tasks, the web facts (once that set is on
   main), the one judge's cases and the reviewer's, held-out cases included.
   Each area is checked against `cap_usd` in `spend.md` before it starts and
   refused past it, and its cost is recorded there. It writes one note,
   `@context-lc ai/results/nightly/<date>.md`: pass or fail by each area's own
   bar, the cases that fell short (held-out ones by cause), the target cases,
   the live drift and the live prompt's changes. The run goes red when an area
   falls short, so a morning starts from a number.
7. **Live drift.** `pnpm ai drift` (`bench/drift.mjs`) holds yesterday's
   conversation scores from Tex's self-review
   (`@context-lc areas/tex-reviews/scores/`) against the seven days before,
   weighted by conversations, and the nightly keeps one open `tex-drift` issue
   while they have dropped (1 point in the mean of every measure, or 1.5 in
   one; at least 5 conversations that day and 10 in the week). Numbers only.
8. **The live prompt is watched.** The gateway reads `@context-lc
   ai/production/` on every turn, so an edit there is live at once, with no
   pull request and no replay. AI Promote is the gated way in. The nightly
   fingerprints every production note and names each change since the night
   before as AI Promote's or outside the gate; its runs then score the changed
   prompt within a day. Making the gateway refuse an ungated edit is a
   separate decision for the owner: it would turn a hand fix into a deploy.
4. **Practice cases and held-out cases.** Cases in the repository are practice:
   agents may read them and learn from their failures. Held-out cases live
   outside the repository and are never shown to the agent writing a change;
   a held-out failure is reported by its cause only. They are
   `@context-lc ai/held-out/<area>.md`, each a JSON block of cases with a
   `cause`, pulled at run time into the runner's temp folder. No prompt or judge
   example may be within half its words of any case (`respond.test.mjs`
   already checks this for the judge).

5. **Speed is a case too.** `cases/speed-budgets.mjs` counts the model calls
   and the calls before the first model call for five simple turns against
   `test/replay/speed-budget.json`, both ways (over fails, and so does under
   until the number is lowered); raising one needs `Speed budget raised: <why>`
   in the pull request. Production's wait to the first text is judged hourly.
   See [tex-speed-budgets](../observability/tex-speed-budgets.md).

## What a simplification costs

Dropping rule 2 lets a fix land with no case, and the same break returns
unseen. Running every model set on every change spends dollars on pull
requests that cannot change them. Putting held-out cases in the repository
lets a change pass by fitting the test instead of the cause.

## What fails if it is reversed

`node scripts/check-tex-change-has-case.mjs --self-test`; `apps/mcp/test/replay.test.mjs`
(sabotage: `warmCopy.js` `events` reading the copy's day instead of the ledger
fails `sees-own-reply` and `after-deploy`); `apps/mcp/bench/test/replayGate.test.mjs`
(reruns only the wrong cases, a target never blocks, the shared pool's cap);
`apps/mcp/bench/test/coreArea.test.mjs` (a core question is right only when
every run passed; a target is never held to the bar);
`apps/mcp/bench/test/nightly.test.mjs` (a quiet day is too few to tell; a hand
edit to the live prompt is outside the gate; held-out cases by cause alone).
