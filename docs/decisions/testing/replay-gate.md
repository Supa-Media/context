# Tex changes merge only through the replay gate

Decided by the owner, 2026-11-13, after a diagnosis of why Tex regressions
felt random: "Let's build everything except for D", "make it strict in the
CI/CD that ... changes to [Tex] can't merge without doing the full replay and
passing and being better", "Can we get each change to be less than $1?", and
"if we can split up the tests into different areas that we know, like the
code only affects that area, that'll be nice."

**Since 2026-11-15** the model half gates on the sealed Test Set alone
([test-set-service](./test-set-service.md)); the full replay below is the Dev
Set's, on demand, and the held-out cases moved into the eval service.

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
   (`apps/mcp/src/agent/`, `apps/agent/src/`, `packages/tex/src/text*`)
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
   (`scripts/check-workflow-triggers.mjs`). So **Tex replay** (`tex-replay.yml`) is
   dispatched on the branch: since 2026-11-15 by **Tex replay required** itself
   the moment it goes red on a branch of this repository, with Claude Code
   answering on the subscription (decided by the owner: "some type of webhook"
   instead of an hourly examiner; [examiner](../../testing/examiner.md)), and
   by hand for any other way of answering. It runs
   `pnpm ai gate` (`apps/mcp/bench/replayGate.mjs`) against main beside it,
   marks the head commit with the status `Tex replay`, and re-runs the pull
   request's check **Tex replay required** (`tex-replay-check.yml`,
   `scripts/tex-replay-required.mjs`), which holds no secret and is red until
   that status is green. The run's summary is the feedback for the change's
   author: which cases regressed and what each expected, held-out ones by cause.
   The core area's judged answers (each answer and the judge's reason on every
   line, the change's and main's) are kept in
   `@context-lc ai/results/replay/<sha>/` (`pnpm ai gate records`), never the
   repository or the log, so a regression is read before anything is changed
   or re-run (2026-11-13: core q13 failed 3/3 on a four-word diagram edit and
   nobody could see the answers).
   **An area is reached by its prompts too** (decided by the owner,
   2026-11-13, choosing "Prompt fingerprints": "reordering or changing the
   prompts ... even if it's a letter different, we need to check that"). A
   file rule names an area's own files, and a file it names nowhere (the
   drawing's map, the capability list, a tool's description) still reaches
   every prompt. So **Tex replay required** and **Tex replay** both build every
   area's prompts on main and on the change with no model and no key
   (`apps/mcp/bench/promptFingerprint.mjs`; the socket's fingerprint mode,
   `BENCH_MODEL_FINGERPRINT`: each call hashed as the examiner would name it,
   Claude answered with fixed stand-in words, nothing spent). An area whose
   prompts differ by one byte, one module moved, or one space, is reached, and
   its replay is required; an area whose run built nothing is never read as
   unchanged. The core and jobs areas run on a stand-in setup in production's
   shape (`apps/mcp/bench/fingerprint/setups/`), since the live setup's words
   live in `@context-lc`, not the repository; a change to those words is rule
   8's. It costs about a minute and two installs, only on a change under
   `apps/mcp/`, `apps/agent/` or `packages/`.
   Main is never run whole: the change answers every case once, only its
   mistakes are run again (twice more on the change, three times on main), and
   a case regressed when it is wrong in every one of the change's runs and
   right in every one of main's. A case the model gets right only some of the
   time flips on unchanged code (the first real run, 2026-11-13, flagged three
   in a change that touched no reviewer code under a most-of-three rule), so
   only a steady flip counts. A case main lacks (the change's own) must pass.
   **The areas** (`replayAreas.mjs`, each with its runner and limits in
   `replayGate.mjs` `RUNNERS` and `AREA_LIMITS`): `respond` (the one judge's
   cases), `review` (the reply reviewer's), and `core` (`coreArea.mjs`): a
   change to `texEntryPoint/`, the turn, the prompt and its modules, the
   production reader, the front door or the advisor runs the core set and the
   simple asks through `pnpm ai run` and `pnpm ai judge` as the live setup
   (pulled into both trees from Context), one case a question, about $0.15
   a change plus its mistakes. And `jobs` (`jobTasks.mjs`, `pnpm ai jobs`;
   Dev2, 2026-11-13: "whether the agents are getting tasks done right, like
   creating pages and doing research"): a change to how a job starts, runs,
   is checked and reported, the pages it writes, or the Worker's job runner
   runs seven invented tasks (research pages, page edits, errands on the
   scripted sites) as whole jobs, part after part with the done check after
   each, and grades what each left behind in plain code: the page exists,
   cites its sources, covers every part of the ask, keeps what it should, the
   errand's site step happened, the job ended done. A Haiku judge grades
   quality beside, never deciding. A task is about $0.35, so the area has a
   pool of its own, capped at $5, and a wrong task runs once more on the
   change and once on main (about $2.50 a change, measured).
   **One sign-in at a time, nobody dropped:** the workflows that sign in as
   the benchmark runner (AI Benchmark, AI Promote, Tex replay, Tex nightly)
   start with a `wait-turn` job (`scripts/bench-runner-lock.mjs`) that waits
   for every earlier run of them to end, because the runner's refresh token
   rotates on every use. A shared `concurrency` group did this until
   2026-11-13 and cancelled every pending run but one, so replays dispatched
   by several agents cancelled each other and left their checks red. "Earlier" is by when a run's latest attempt started, and the signing-in job checks again before it signs in (`--check`), refusing rather than waiting: a "Re-run failed jobs" skips a passed `wait-turn`, and on 2026-11-13 one such re-run signed in beside a newer replay, the two rotations raced and the grant was revoked. Dispatch again, or re-run all jobs. The cheap areas share one $1 pool a change; an
   area whose reruns would pass it is refused. What each replay spent is a row
   in `@context-lc ai/results/spend.md` (`replay-gate`).
4. **Practice cases and held-out cases.** Cases in the repository are practice:
   agents may read them and learn from their failures. Held-out cases live
   outside the repository and are never shown to the agent writing a change;
   a held-out failure is reported by its cause only. They are
   `@context-lc ai/held-out/<area>.md`, each a JSON block of cases with a
   `cause`, pulled at run time into the runner's temp folder. No prompt or judge
   example may be within half its words of any case (`respond.test.mjs`
   already checks this for the judge).
5. **Target cases.** A case that captures a bug not yet fixed is a target: a
   bench question's `- target: <cause>` line, or a respond or review case's
   `"target": "<cause>"`. It runs, it is reported apart, and it never blocks a
   merge or fails an area's bar (`blocking()` in `bench/replayGate.mjs`);
   fixing the bug is removing the line. The first targets came from reading
   every Tex chat on 2026-11-13 (`bench/review/from_chats.json` and the
   `audit-1113` reply-or-quiet cases), all invented, each named by its cause.
6. **Each night runs its rotation.** `tex-nightly.yml` (`pnpm ai nightly`,
   `bench/nightly.mjs`) runs the night's areas as the live setup, three times
   each (the job tasks once: a whole job each), held-out cases included.
   Which areas is `NIGHTLY_ROTATION`, beside the area list: web-facts,
   respond and review every night; core also on Monday, Wednesday and
   Friday; on Sunday, tasks in an even ISO week and jobs in an odd one.
   The weekday and the week are the America/New_York civil date, the same
   zone as the spend caps. A manual run's `areas` input (comma-separated,
   or `all`) replaces that list. That override does not touch the budget
   check: each selected area is still checked against the month's limit and
   the day's cap in
   `spend.md` before it starts and refused past either, and its cost is
   recorded there. A replay is checked against that same month and against
   its own monthly line, so it cannot spend the night's room. The nightly writes one note,
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

5. **Speed is a case too.** `cases/speed-budgets.mjs` counts the model calls
   and the calls before the first model call for five simple turns against
   `test/replay/speed-budget.json`, both ways (over fails, and so does under
   until the number is lowered); raising one needs `Speed budget raised: <why>`
   in the pull request. Production's wait to the first text is judged hourly.
   See [tex-speed-budgets](../observability/tex-speed-budgets.md).

9. **Without API credits, an examiner answers** (decided by the owner,
   2026-11-13, choosing "Separate examiner session"). The bench's model socket
   (`bench/modelSocket.mjs`, `BENCH_MODEL_SOCKET` / `BENCH_MODEL_REPLAY`) writes
   each Claude call out by the hash of exactly what would be sent, and a separate
   session that did not write the change answers it
   ([examiner](../../testing/examiner.md)). The answers go to
   `@context-lc ai/results/examiner/<sha>.md`. **Tex replay** dispatched with
   `examiner: true` rebuilds every call from the commit, answers it from that
   note (a call with no answer fails the run), and scores and compares against
   main itself. Only `respond` and `review` are examined so far
   (`SOCKET_AREAS`); a socketed run that reaches another area is refused rather
   than sent to the real model. The judge keeps its real Workers AI model unless
   `BENCH_MODEL_SOCKET_KINDS` names `workers-ai`.

10. **A Tex Architecture Lab version runs on the same path** (decided by the
    owner, 2026-11-13: run a Lab version on the subscription, non-Claude steps
    as real calls, every step logged). `pnpm ai lab` (`bench/lab.mjs`) writes a
    version's setup fields and prompt modules into the bench's copy only,
    refuses a copy that drifted from main's or that the product could not read,
    and runs the gate with a step log (`bench/stepLog.mjs`). Clef and GLM come
    to the socket and the session runs each through Context's staff-only
    `manage` action `run_model` (`src/tools/runModel.js`): owners and editors
    of `@context-lc` only, two models, never offered to Tex, and no key ever on
    the session's machine or in a note.

## What a simplification costs

Dropping rule 2 lets a fix land with no case, and the same break returns
unseen. Running every model set on every change spends dollars on pull
requests that cannot change them. Putting held-out cases in the repository
lets a change pass by fitting the test instead of the cause. Running every
nightly area every night does not fit the $40 month: core every night is
about $32 by itself, and tasks plus jobs every week is about $27.

## What fails if it is reversed

`node scripts/check-tex-change-has-case.mjs --self-test`; `apps/mcp/test/replay.test.mjs`
(sabotage: `warmCopy.js` `events` reading the copy's day instead of the ledger
fails `sees-own-reply` and `after-deploy`); `apps/mcp/bench/test/replayGate.test.mjs`
(reruns only the wrong cases, a target never blocks, the shared pool's cap,
the jobs area's own pool); `apps/mcp/bench/test/jobTasks.test.mjs` (a page
without its sources fails, a part the check says isn't finished is followed by
another on its advice, a job unfinished when its parts run out ends stuck, a
page edit that never saved has no page);
`apps/mcp/bench/test/coreArea.test.mjs` (a core question is right only when
every run passed; a target is never held to the bar);
`apps/mcp/bench/test/nightly.test.mjs` (a quiet day is too few to tell; a hand
edit to the live prompt is outside the gate; held-out cases by cause alone);
`apps/mcp/bench/test/nightlyRotation.test.mjs` (Tuesday is the three cheap
areas; Monday, Wednesday and Friday add core; an even ISO week runs tasks
and an odd week runs jobs, including week 52 on 1 January; 04:30 UTC on a
Monday in winter is still Sunday in New York);
`apps/mcp/bench/test/promptFingerprint.test.mjs` and
`node scripts/tex-replay-required.mjs --self-test` (one changed prompt changes
an area's fingerprint; a changed area with no replay run fails the check;
sabotage on the real trees: one letter of the capability list changed four
areas whose file rules named none of it, and since 2026-11-15 one letter of
the map changes none).
`apps/mcp/bench/test/gateSample.test.mjs` (the reviewer and job samples, a
case the change adds or edits always runs, held-out cases always run).
`apps/mcp/bench/test/lab.test.mjs` (a module path that leaves `ai/production` is
refused; a setup file cannot be written outside the setup folder; a version
that leaves the setup unreadable is refused at apply);
`apps/mcp/bench/test/stepLog.test.mjs` (every step's phrase is in its real
prompt file); `apps/mcp/test/runModel.test.mjs` and
`apps/mcp/test/runModelWorker.test.mjs` (a member, a session without
`@context-lc` and a self-hosted deployment are refused; an editor gets the
model's answer through the whole Worker).

## The jobs area is examinable too (decided by the owner, 2026-11-14)

Since Tex's drawing and what every Tex agent is told about itself are generated
from `packages/tex/src/texConfig.json`
([config-graph](../texting-assistant/config-graph.md)), every config change
reaches every area's prompts, the background jobs' included, and jobs was the
one area only API credits could replay. Its Claude calls (the job's parts and
the quality judge) now go through the model socket like every other area's,
so an examiner session answers them and CI replays the run from those answers;
a run with a call left unanswered fails rather than score the path the code
fell back to. Owner's words, asked whether to wire it: "yeah duh".

**What a simplification would cost:** taking jobs back out of the socket means
every config change waits on a paid run, or merges without the jobs replay.
Test: `apps/mcp/bench/test/jobsSocket.test.mjs`, which fails when a socketed
jobs run with no answers says ok.


## A skip for the config-graph migration, until 2026-11-22 (decided by the owner, 2026-11-14)

Dev2, 2026-11-14: "I think it's fine to bypass the replay checks just for now
because the config changes are so monumental that it doesn't matter. I feel
like the replay should kind of wait for the config change first." Moving Tex
onto its config graph regenerates the map every agent is told, so each of
those pull requests reaches every area, and examining all seven for each one
would hold the migration for hours.

So until 2026-11-22, a pull request whose body has a line starting
`Replay skipped on the owner's call:` followed by a reason passes **Tex replay
required** without a run, and the check's log names the areas it did not
replay (`SKIP_LINE`, `SKIP_ENDS` and `ownerSkip` in
`scripts/tex-replay-required.mjs`). After that date the line does nothing and
the gate is whole again; delete the skip then. Once the graph has landed,
replays are tied to the config they ran on. Test:
`node scripts/tex-replay-required.mjs --self-test` ("the skip ends on its
date").

## A change's replay runs a sample, and the map alone reaches nothing (decided by the owner, 2026-11-15)

Dev2, 2026-11-15: "Is there a way we could cut the big tests to be less big? ...
I'm a little bit more concerned about the speed of things", choosing "Reply
checker and jobs". A full run had grown to about 494 examiner answers
(2026-11-15), mostly the reviewer's 211 cases, one call each with the whole
reviewer prompt, and seven whole background jobs. So a change's first run
took a fixed sample of them (`apps/mcp/bench/gateSample.mjs`; since cut to
20 cases a step, below). Each unit
step ran 20 cases (Dev2, same day: "these nodes should be cut down to 20
questions each"): the reviewer one from every set before a second from any,
about half faults and half good replies, and Decide its "@Tex must still
work" cases, other replies and quiet ones in turn. Jobs runs three tasks, one
of each kind. The Tex Architecture Lab picks the same cases by default
(`gate: false` marks one outside, from `scripts/tex-lab-data.mjs`), and its
All button still picks every one. Every held-out case still
runs, and so does any case the change adds or edits against main's, so a
change still passes the case that proves it. The full sets stay in the
repository and run whole without `--gate-sample` (`pnpm ai review`,
`pnpm ai respond`, `pnpm ai jobs`). The core area and the advisor roles were already small and
are run whole.

And on the map (same day): "I feel like we shouldn't treat this as changing
if the map changes. It's more so the fact that it can see its current
existing map. We're never really going to quiz or test on ... what it knows
about its own map." A fingerprint run also writes each call's hash with
`TEX_MAP` taken out (`maskedHash` in `apps/mcp/bench/modelSocket.mjs`), and
two trees that both wrote them are compared by those, so a change to the map
alone reaches no area. The capability list, a role's own words and every
other prompt byte still count. The examiner's answers are still named by the
whole call, map included, so a replay never reuses an answer made for
another map.

## Every step keeps at most 50 cases (decided by the owner, 2026-11-15; raised 2026-11-17)

Dev2, 2026-11-15, in the Lab: "some of these unit sections have way too many
test cases ... we should have a max of 20 test cases per unit", then chose
"Keep best 20, delete rest" over parking the extras or only capping the
list. The sample above became the bench: the reviewer's sets keep the 20 the
sample took (one from every set before a second, about half faults) and
Decide the 20 it took; the rest left the repository (git history keeps
them). So review and respond run whole again and only the jobs are sampled
(`GATE_SAMPLED`). `scripts/tex-lab-data.mjs` fails (and with it the fast
guards) when any step, a step's own node cases included, holds more than
`UNIT_LIMIT`, and the Lab trades a case in for one out when a step is
full. A cap that only hid the extras, or kept running them unseen, would be
the shadow work the config graph exists to end.

The cap was 20 until 2026-11-17, when every step with cases was full and a
fix could no longer add the case that proves it. Dev2 then asked that limits
be the real ones, money being the only one ("Replay cases, 20 per step -
raise it to what you think makes sense"), so it is 50: the replay is on
demand and its spend stays capped at $1 a change, and a unit step's case is
one small call. The 20 already kept stay; new cases fill the room.

Steps with no area of their own get cases too (Dev2, same day: "a lot of
nodes don't even have test cases listed here. And there's not a way to add
them"). The Lab's form is built from the step's `inSchema` and `outSchema`
in `texConfig.json`, so every step gets the same one: given its inputs, want
each output field exactly (yes/no, a choice, a number, words) or read by a
judge. Promote writes them to `apps/mcp/bench/nodes/<step>.json`, and
`pnpm ai nodes` runs each through the step's own code in `GATEWAY_NODES`
alone. A step that needs its helpers or wires says it cannot run alone
rather than passing. They are not in a pull request's replay yet: a node
calls its model through the gateway, not the examiner socket.

**What a simplification would cost:** running the reviewer and the jobs
whole again puts a change's examiner run back near 500 answers (the reviewer
now has 20, so it no longer can); sampling
without the new-or-edited rule lets a change add a case the gate never runs.
Counting the map again makes every config change a full run of every area.
Tests: `apps/mcp/bench/test/gateSample.test.mjs` and "a change to Tex's map
alone reaches no area" in `apps/mcp/bench/test/promptFingerprint.test.mjs`.
