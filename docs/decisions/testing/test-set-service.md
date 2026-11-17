# The Test Set lives only in a sealed eval service

Decided by the owner, 2026-11-15: the Test Set must leave `@context-lc` (a
developing agent reads it) for a locked "Tex eval service", its runs capped;
it is people only, "write and read by hand", editable in the Lab with a clear
warning; and it is "the actual thing that the CI/CD gates on". Built from the
plan in [test-sets](./test-sets.md), piece 4.

## The rule

- **One place.** Test conversations live only in the `TestSet` Durable Object
  of `infra/tex-eval` (Worker `context-tex-eval`). Never in the repository,
  Context, a log, a CI summary or an artifact.
- **No address of its own.** `workers_dev` is off and it has no route; the
  gateway reaches it by two service bindings. `/tex-eval/*` on the gateway is
  passed to its HTTP side untouched, before any session is read.
- **Runs: main's workflow only, by GitHub OIDC, no secret.** A run's token must
  be GitHub's, for audience `context-tex-eval`, repository
  `Supa-Media/context`, `ref` `refs/heads/main` and `job_workflow_ref`
  `.github/workflows/tex-test-set.yml@refs/heads/main` (the seed door:
  `tex-test-set-seed.yml`). The same file dispatched on a branch names the
  branch and is refused, so a branch cannot change the steps that hold the
  conversations.
- **Capped:** 1 run a commit, 10 changes a pull request, 1000 a day (UTC; the day
  cap raised from 10 by Dev2, 2026-11-16; the pull request cap raised from 3 by
  Dev2, 2026-11-17, "increase the caps if they keep getting hit"). A change is
  the patch-id of the pull request's diff from main, so a commit that only
  merges main re-runs on the same change without spending a pull request run;
  it still spends the commit and day caps. A person can
  allow one more for a pull request in the Lab; the same GitHub run asking again
  gets its own run back and spends nothing.
- **Answers pass or fail and counts by node.** The service scores the run's
  answers itself, against the unit tests it handed out at the start (a missing
  answer is wrong), and passes when no node gets fewer right than main.
- **People only.** `/tex-test-set` answers the app's own client
  (`context_console`, never registrable) for owners and editors of
  `@context-lc`; writes are checked against the live config with
  `texSets.check`. tex_dev's `test_set` and the public `/tex-eval/counts` give
  counts and run results, never a word, a title or an id (the one gap in
  Lab = tex_dev parity, by design).

## The gate

"Tex replay required" (`scripts/tex-replay-required.mjs`) passes a change that
reaches a model area only on a successful `Tex test set` status on its head
commit. When the changed files themselves reach a model area,
`scripts/tex-test-set-dispatch.mjs` dispatches `tex-test-set.yml` before the
prompt fingerprints, so the run overlaps the other checks. A reach only the
fingerprints can see (a file the area list does not name, whose prompts
differ) still dispatches when the gate fails. Either way the workflow runs
with ref main and the pull request's number; that run takes the Test Set from
the service, runs it with main's harness on the change's nodes and on main's
(`apps/mcp/bench/setsRun.mjs --tree`, output to /dev/null), has the service
score it, marks the commit and re-runs the check. The pass rule is the same
either way: a successful status, and no budget or threshold moves. The full replay
(`tex-replay.yml`) no longer gates and no longer starts by itself; Training and
Dev never slow CI. The held-out cases that lived in `@context-lc ai/held-out/`
are moved in once by `tex-test-set-seed.yml` (same OIDC rule, seed door), which
then empties and archives those notes.

## What a "simplification" would cost

A read route, a copy in Context, or letting a branch's workflow fetch the cases
hands the judging cases to the agent being judged, and the gate measures
memory, not Tex. Dropping the caps lets an agent tune by retrying.
`infra/tex-eval/src/oidc.test.ts` fails if a branch's token, another workflow,
another repository or another audience gets in; `testSet.test.ts` if the caps
or the verdict change; `apps/mcp/test/texTestSet.test.mjs` if an AI client's
token or a non-editor reaches the conversations, or tex_dev sees a word.
