# The examiner session

The replay gate (`docs/decisions/testing/replay-gate.md`) normally pays for its
model calls with API credits. When there are none, a **separate Claude session,
the examiner**, answers those calls, and CI scores the answers itself (decided
by the owner, 2026-11-13: "Separate examiner session"). This file is the
examiner's instructions. It is read by a session that did **not** write the
change. A session that wrote the change must never act as its examiner.

## What the examiner does for one pull request

1. Check out the pull request's head commit, and add a worktree of
   `origin/main` at `$MAIN`. Read `@context-lc ai/held-out/<area>.md` with
   your own Context connection and save each note's JSON block as
   `$HELD/<area>.json`.

   **Never use the benchmark runner's sign-in from an examiner session**
   (`pnpm ai gate held-out`, `pnpm ai pull`, `pnpm ai socket publish`,
   `pnpm ai signin`). Its refresh token rotates on every use and is shared
   with Tex replay in CI: a second user beside a running replay presents a
   retired token and the gateway revokes the whole grant (it happened on
   2026-11-13 and took a person's `pnpm ai connect` to restore).
2. Name the areas with `pnpm ai gate areas --base-sha $(git merge-base origin/main HEAD)`.
   `respond`, `review`, `core` and the four `advisor-*` roles can be examined (`SOCKET_AREAS` in
   `apps/mcp/bench/replayGate.mjs`). If the change reaches another area, stop
   and say so on the pull request. The core area also needs the live setup in
   both trees, as `pnpm ai pull texting-assistant` writes it in CI. Copy it
   with your Context connection into each tree's `apps/mcp/bench/ai/`:
   `@context-lc ai/production/texting-assistant.md` to
   `setups/texting-assistant/production.md`, every note in
   `ai/production/prompt/` to `setups/texting-assistant/prompt/`, every note
   in `ai/production/skills/` to `setups/texting-assistant/skills/`, and every
   note in `ai/tests/` to `tests/` (skip each folder's `about.md`; write each
   note's text only, ending in a newline).
   The `jobs` area stays out of the socket on purpose, and runs only with API
   credits. One run is about 350 long tool-using calls (seven whole jobs, part
   after part, each with Opus's done check), more than an examiner can answer.
3. Start the gate in the background with the socket set:

   ```sh
   BENCH_MODEL_SOCKET=$SOCK pnpm ai gate --base $MAIN --areas <areas> --held-out $HELD --scratch $SCRATCH
   ```

4. Until the gate exits, take the waiting calls with
   `pnpm ai socket next --dir $SOCK` (one JSON line per call). For each one,
   answer **as the model named in `request.model` would**, from
   `request.system`, `request.messages` and any `request.tools` alone, in the
   format that system prompt asks for. Then write the answer with
   `pnpm ai socket answer --dir $SOCK --hash <hash> --text '<answer>'`. A call
   that offers `tools` (the core area's turn, its advisor and job steps) may
   be answered with tool calls instead:
   `--json '{"text": "", "toolCalls": [{"name": "search", "input": {"query": "dentist"}}]}'`
   (or `--json-file <file>`). Each tool runs for real in the bench's world, and
   its result comes back as the next call. The core area's runs hold still
   until each answer is written, so take as long as a call needs. Answer
   each call on its own merits. Don't open the case files, the diff, or the
   pull request while answering, and don't change an answer after you've seen
   a score.
5. When the gate exits, make the note with
   `pnpm ai socket note --dir $SOCK --sha <full head sha> --by "<this session's link>" --out note.md`
   and write it with your Context connection to
   `@context-lc ai/results/examiner/<full head sha>.md`. Then dispatch **Tex replay** on the branch with `examiner: true`. CI
   rebuilds every call from the commit, answers each from the published
   answers (a call with no answer fails the run), and scores and compares
   against main itself.

## The core area through the socket

The core area runs the texting assistant end to end (`pnpm ai run`, then
`pnpm ai judge`), so every Claude call it makes comes to the examiner: the
front door's rounds and tool calls, the advisor, the reply reviewer, the
conversation classifier, the hand-back judge, the played person, and the
judge that grades the answers. With no credits there is no other model to
grade with, so in this area the examiner also answers the judge's calls. A
judge's call shows the checks, but only for answers that were already given.

CI can replay a run only if the run asks exactly the same things both times.
So a socketed run (`steppedRun` in `apps/mcp/bench/clock.mjs`):

- **Holds the clock still.** It reads the test's pinned day at noon, and each
  answer moves the clock on 3 seconds, live and replayed. How long the
  examiner took never counts. A test with no `today:` is refused.
- **Seeds chance,** so each world rolls the same ids.
- **Holds still while it waits,** so a turn's own timers (the reviewer's 8 s,
  the advisor's 40 s) can't run out while the examiner thinks.
- **Finds nothing on the web.** `search_web` is offered and answers with no
  results, because the real web would answer differently in the replay.
- **Uses the scripted stand-in for Workers AI** (search by meaning's
  embeddings, and Clef), because the examiner holds no Cloudflare key.

The last two mean the core area measures questions that need the web or
search by meaning differently from production: there they find less. A call left with no answer fails the
run (`assertAnswered`), rather than letting the turn fall back to another
model and be scored.

## A Tex Architecture Lab version

The Lab (tex.lc/lab) hands a session a version's config: its steps,
models, reading order, changed modules, wires, areas and picked cases (decided
by the owner, 2026-11-13: run a Lab version on the subscription, log every
step, paste the results back). The same examiner procedure runs it, through
`pnpm ai lab` (`apps/mcp/bench/lab.mjs`):

```sh
pnpm ai lab plan --config lab.json      # what runs, what is applied, what needs code, what is skipped
pnpm ai lab apply --config lab.json     # changed setup fields and prompt modules into the bench's copy only
BENCH_MODEL_SOCKET_KINDS=claude,workers-ai \
  pnpm ai lab run --config lab.json --base $MAIN --socket $SOCK --held-out $HELD --scratch $SCRATCH
```

- **Setup changes go into the bench's copy** (`apps/mcp/bench/ai/setups/texting-assistant/`),
  never into `@context-lc ai/production`. Copy the live setup first (step 2
  above). A module the config says came from main's text is checked against
  the copy by its fingerprint, and a drifted copy stops the run.
- **Code changes are built by hand** on a `lab/<version>` branch first; `run`
  refuses a config with code changes on a tree that is still main's.
- **Clef and GLM run for real.** With `workers-ai` in
  `BENCH_MODEL_SOCKET_KINDS`, their calls come to the socket too, and the
  session answers each by calling Context's `manage` action `run_model`
  (`{ model, input }`, the call's own `request.model` and `request.input`) and
  writing back exactly what it returned. The gateway runs the model with its
  own binding; no key is ever in a note or on the session's machine. Only
  owners and editors of `@context-lc` may call it.
- **Every call is logged** to the step log (`BENCH_STEP_LOG`, default
  `$SCRATCH/lab-steps.jsonl`; `apps/mcp/bench/stepLog.mjs`): one JSON line with
  the Lab step (`node`), model, wall ms, estimated tokens in and out, thinking,
  tool calls, output and `side` (`branch` or `main`, since the gate runs both).
  The Lab reads the branch lines and turns a subscription call's output tokens
  into production time.
- **What to paste back:** the `## Lab run` block `run` prints (the gate's
  `## Tex replay` report) and the step log.

A model swap only proves wiring: the examiner answers as the named model.

## Why it is built this way

- **CI recomputes the score.** The examiner only supplies the model's words,
  each keyed by the hash of exactly what the harness sends. If the code
  changes, the hashes change, and stale answers can't pass.
- **The examiner is not the author.** An agent grading the work it wrote is
  the overfitting the held-out split exists to stop. The examiner sees
  held-out cases, because it has to answer them, and it doesn't write the
  change.
- **One answer stands in for the model.** A call asked twice (a rerun, or the
  same case on main) is answered once. So a case regresses when the change's
  call is answered wrong and main's is answered right, and an unchanged case
  can't flip.
- **What this can't prove** is that the answers came from a model at all, or
  that they match production's Haiku. The examiner is a different model from
  production's. Each nightly that has credits asks the real models a sample of
  the same calls and reports how often they agree.

## Proven

2026-11-13, run 43466505830: a comment-only change reaching `advisor-planner`.
The gate ran on the socket in one session, a separate agent answered its three
calls blind, the note went to Context through the connector, and Tex replay
with `examiner: true` marked the commit "Nothing regressed against main
(examiner's answers, scored here)" for $0.
