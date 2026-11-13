# The examiner session

The replay gate (`docs/decisions/testing/replay-gate.md`) normally pays for its
model calls with API credits. When there are none, a **separate Claude session,
the examiner**, answers those calls, and CI scores the answers itself (decided
by the owner, 2026-11-13: "Separate examiner session"). This file is the
examiner's instructions. It is read by a session that did **not** write the
change. A session that wrote the change must never act as its examiner.

## What the examiner does for one pull request

1. Check out the pull request's head commit, and add a worktree of
   `origin/main` at `$MAIN`. Pull the held-out cases with
   `pnpm ai gate held-out --dir $HELD` (the benchmark runner's sign-in). A
   session with its own Context connection can instead read
   `@context-lc ai/held-out/<area>.md` and save each note's JSON block as
   `$HELD/<area>.json`.
2. Name the areas with `pnpm ai gate areas --base-sha $(git merge-base origin/main HEAD)`.
   `respond`, `review`, `core` and the four `advisor-*` roles can be examined (`SOCKET_AREAS` in
   `apps/mcp/bench/replayGate.mjs`). If the change reaches another area, stop
   and say so on the pull request. The core area also needs the live setup in
   both trees: run `pnpm ai pull texting-assistant` in each (it uses the
   benchmark runner's sign-in), as the workflow does.
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
5. When the gate exits, publish the answers with
   `pnpm ai socket publish --dir $SOCK --sha <full head sha> --by "<this session's link>"`,
   or, with your own Context connection, write the note that
   `pnpm ai socket note --dir $SOCK --sha <sha> --by "<link>" --out note.md`
   makes to `@context-lc ai/results/examiner/<sha>.md`. Then dispatch **Tex replay** on the branch with `examiner: true`. CI
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
