# The examiner session

The replay gate (`docs/decisions/testing/replay-gate.md`) normally pays for its
model calls with API credits. When there are none, a **separate Claude session,
the examiner**, answers those calls, and CI scores the answers itself (decided
by the owner, 2026-11-13: "Separate examiner session"). This file is the
examiner's instructions. It is read by a session that did **not** write the
change. A session that wrote the change must never act as its examiner.

## What the examiner does for one pull request

1. Check out the pull request's head commit, and add a worktree of
   `origin/main` at `$MAIN`. Sign in as the benchmark runner
   (`pnpm ai signin`), and pull the held-out cases with
   `pnpm ai gate held-out --dir $HELD`.
2. Name the areas with `pnpm ai gate areas --base-sha $(git merge-base origin/main HEAD)`.
   Only `respond` and `review` can be examined so far (`SOCKET_AREAS` in
   `apps/mcp/bench/replayGate.mjs`). If the change reaches another area, stop
   and say so on the pull request.
3. Start the gate in the background with the socket set:

   ```sh
   BENCH_MODEL_SOCKET=$SOCK pnpm ai gate --base $MAIN --areas <areas> --held-out $HELD --scratch $SCRATCH
   ```

4. Until the gate exits, take the waiting calls with
   `pnpm ai socket next --dir $SOCK` (one JSON line per call). For each one,
   answer **as the model named in `request.model` would**, from
   `request.system` and `request.messages` alone, in the format that system
   prompt asks for. Then write the answer with
   `pnpm ai socket answer --dir $SOCK --hash <hash> --text '<answer>'`. Answer
   each call on its own merits. Don't open the case files, the diff, or the
   pull request while answering, and don't change an answer after you've seen
   a score.
5. When the gate exits, publish the answers with
   `pnpm ai socket publish --dir $SOCK --sha <full head sha> --by "<this session's link>"`,
   then dispatch **Tex replay** on the branch with `examiner: true`. CI
   rebuilds every call from the commit, answers each from the published
   answers (a call with no answer fails the run), and scores and compares
   against main itself.

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
