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
  answer is wrong). A node that ran once passes when it gets at least as many
  right as main. A node the workflow ran more than once passes unless a test
  is a steady regression: wrong on every trial of the change and right on
  every trial of main, the same rule as the replay gate. The reply reviewer
  is that node. One sample of it is 5/8 or 6/8 on code that did not change
  (`replyJudge.js` included), and a pull request that drew the low sample
  while main drew the high one was failing the gate. The workflow runs it
  three times (`--repeat 3 --repeat-nodes reviewer`). The counts stay the
  majority of the trials, so a noisy sample still shows, and it does not fail
  the gate. A case wrong every time on the change and right every time on
  main still fails it.
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
or the verdict change (a repeated node fails only on a steady regression, and
one run still fails when its count drops);
`apps/mcp/test/texTestSet.test.mjs` if an AI client's
token or a non-editor reaches the conversations, or tex_dev sees a word.

## The Search Test is a second set in the same service

Decided by the owner, 2026-11-21 (Dev2's gate for search): the Search Test
mirrors the Tex Test Set exactly, in the same `TestSet` Durable Object
(`infra/tex-eval`, its own tables `search_cases` and `search_runs`, no new
class or migration). Its cases hold a query, the note address or addresses
that must come back first (`expect`, 1 to 5), and the notes they see; people
write them in the Lab, and main's `search-test-set.yml` and
`search-test-set-seed.yml` take them by OIDC on the `search-run` and
`search-seed` doors, which no other workflow's token opens. The same caps
apply (1 a commit, 10 changes a pull request, 1000 a day), counted on search
runs only. The service scores each run once: a case with no answer is a
miss, and the run passes when the change puts the expected note first at
least as often as main (`searchVerdict`, `src/searchRules.ts`). Counts and
run results carry no words. `src/oidc.test.ts`, `src/testSet.test.ts` and
`src/searchRules.test.ts` fail if a token crosses doors, a cap or the verdict
moves, or a seed overwrites a case.
