# CI pipelines

_Decided 2026-09-28. See [testing and guards](../testing.md) for the broader
test policy._

## Pull-request checks report broadly and work narrowly

Every pull-request workflow still starts on every base branch. Package jobs use
the local `ci-scope` action after checkout, then guard setup, installation and
tests on its `affected` output. The action derives each package's recursive
workspace dependencies from the manifests. Root dependency files, the action,
and the scope checker fan out to every job. An unavailable base commit fails
open and runs the job. Pushes to `main` run as an unconditional backstop.

This keeps required check names present while removing unrelated work. A
router-only pull request runs the router suite and shared repository guards. It
does not install the gateway, desktop, CLI, email, transcription, egress,
Sentry or control-plane test graphs. `scripts/check-ci-path-gates.mjs` names
every scoped job, requires its owning packages and workflow file, and rejects
any expensive step after the detector without the shared condition.

A pull request's scope is the diff between its test merge
(`refs/pull/N/merge`, what every job checks out) and that merge's first parent,
the base branch as it is now. It is not `pull_request.base.sha`: that is the
base as it stood when the pull request was opened or last pushed, so diffing it
against today's merge also counted every pull request merged in between. On
2026-10-14 a phone-only change ran the gateway suite, the Convex typecheck and
the bundle rebuilds for that reason. The `ci-change-scope` self-test pins the
first-parent rule. `ci / Lint` follows the reusable workflow's `mobile` filter
(`lint-filter`), so a pull request that touches no app code does not lint.

## The Convex suite watches the gateway files Convex reaches

_Decided 2026-10-20, from the owner's ask that a texting-assistant change ship
in seconds rather than minutes._ `ci / Test Convex Backend` (about four minutes
across three shards) and the Convex deploy typecheck used to watch all of
`apps/mcp/**`, so every Tex fix under `apps/mcp/src/agent/` paid for both,
although nothing in `apps/convex` imports it. They now watch the gateway files
`scripts/convex-gateway-reads.mjs` derives: every `apps/mcp` file reached by
imports out of any file in `apps/convex`, and every one a Convex file names by a
relative or straight-quoted path. `check-ci-path-gates.mjs` fails when either list stops covering that
set, so a new Convex import of a gateway file is a red guard, not a silent
skip. The Convex tests that read the gateway whole (a glob or directory read:
the privacy engine is declared once, privacy state is read only through its
accessors) are the exception the filter cannot express; Gateway Contracts runs
them on every gateway change, in about ten seconds.

Reversing it to `apps/mcp/**` costs every gateway-only pull request four
minutes. Dropping the derivation in favour of a hand list is the failure the
guard exists for. Sabotage: deleting `apps/mcp/src/privacy/**` from the filter,
or importing an agent module from a Convex test, fails the path-gates check;
declaring `canSee` in an agent module fails `privacyEngine/portParity.test.ts`
in Gateway Contracts.

## The gateway suite runs as two jobs, and its slow file in shards

_Decided 2026-10-20, from the same ask._ `Test Gateway` ran every
`test/run.mjs` entry on one runner, and `test/test.mjs` alone took 85 seconds
because about seventy suites that build worlds of their own ran one after
another behind the shared fixture. Those now live in `test/isolated.mjs`, which
`run.mjs` runs as three shards beside a `test.mjs` that keeps only what reads
the shared fixture; within a shard suites still run one at a time, so a suite
that swaps `globalThis.fetch` still owns it alone. And the `node --test` half
(`test/unit.list`) runs as `Test Gateway units`, on its own runner, because
the entries together were bound by four cores, not by the slowest one.
`pnpm test` locally still runs everything.

Folding the suites back into `test.mjs` costs every gateway pull request about
a minute. A suite that reads the shared fixture (`call`, `contextStore`,
`controlPlane` from `harness.mjs`) belongs in `test.mjs`; in a shard it would
read an unseeded fixture and fail, which is the signal. Sabotage: a suite in a
shard that throws fails `run.mjs integration` with a non-zero exit.

## The gateway's unit files run in six slices

_Decided 2026-11-02, from the owner's ask that CI for a Tex change be "super
super quick"._ After the split above, `Test Gateway units` was the longest
check on every gateway pull request: about 110 seconds of `node --test` over
358 files on one four-core runner, against 65 for `Test Gateway`. It ran as
three slices, about 40 seconds of tests each at the time.

_Amended 2026-11-17._ The last 30 pull requests measured about 90 to 110
seconds of tests on each of those three slices, and the summary check's wall
time was 2m41 at the median and 4m40 at the 90th. Six slices,
`Test Gateway units (1/6)` to `(6/6)`, each `pnpm test:unit INDEX/6`, halve
the files on a runner. One job still named `Test Gateway units` is red unless
every slice passed. `pnpm test` and `pnpm test:unit` with no slice still run
everything. The required check stays `Test Gateway`, which is the integration
suite, not a slice name.

Dropping a slice, or folding them back onto fewer runners, puts those files
on the queue in front of the required checks. `check-ci-path-gates.mjs`
(`assertUnitSlices`) fails when the matrix is not 1 to N, when the run or the
name does not say `/N`, or when the summary job stops waiting for the slices,
because any of those runs some files nowhere.

## A Worker's secrets go up in one request

_Decided 2026-11-02, from the same ask._ The production gateway deploy spent
about 24 of its 70 seconds in ten `wrangler secret put` calls, each its own
Wrangler start and its own new Worker version. The gateway, its screenshot
Worker and Tex's texting Worker, on staging and production, now send theirs as
one `wrangler secret bulk`, fed by `scripts/worker-secrets.mjs` (`NAME`
required, `?NAME` optional, `!NAME` optional with a warning, `TARGET=SOURCE`
renamed). Values go through the environment and a pipe, never argv or a log.
`deploy-plan.mjs` counts that script as an input of those components.

The secrets are sent on every deploy, not only when they change (the owner
asked, 2026-11-02): Cloudflare returns secret names, never values, so finding
out whether anything changed costs a call as long as sending them (about three
seconds), and skipping would leave a secret changed or lost in Cloudflare
wrong until the next change here. `check-workflow-secret-order.mjs` treats
`secret bulk` as a push, and `check-wrangler-vars-not-secrets.mjs` reads the
names off the `worker-secrets.mjs` line; each self-test has a case for it.

## Per push, a real browser tests only the note editor

_Decided by Dev2, 2026-10-07: "we don't need the browser to test settings
panels etc, only super critical things like the note editor and changes to
that, everything else can use regular unit testing."_

The browser build is made once per configuration and passed to its test jobs as
an artifact. On a pull request or a push to main:

- Note editor in WebKit runs the editor's own specs (`editor`,
  `editorFormatting`, `callouts`, `tables`, `comments`) in one job, and only
  when the editor or what it is built from changed.
- The CSP candidate runs in two jobs on the same scope, side by side: Script
  policy enforced in WebKit (production's headers, then `script-src`
  enforced) and Style nonce enforced in WebKit (the whole policy with a style
  nonce per response, its offline replay, and the diagram page's own policy).
  They were one job until 2026-11-05, when it ran five and a half minutes and
  was the longest check on any pull request that reached the editor; split,
  each runs in about two and a half. `Editor in WebKit` requires both, and
  `scripts/check-ci-path-gates.mjs` fails if it stops requiring either or if
  their specs drift from the scope.

Once a day (and on demand):

- Full WebKit runs every spec in two shards with one merged HTML report.
  Settings, panels, plugins, casts, phone screens and the rest are proven here
  and by their unit tests, not per push.
- Offline Chromium proves the service-worker reload Playwright WebKit cannot
  perform offline.
- Collaboration Chromium (collaboration.yml) covers storage recovery,
  two-editor convergence, presence, offline edits, rename, trash, restart,
  revocation and stalled connections against a local gateway and local R2.

The editor job is scoped by file. Its scope step's `entries` are the web
editor, the native one in its WebView and that WebView's entry, followed
through imports by `scripts/import-reach.mjs`. The specs, their harness and the
fixture route are named in `paths`. A push to main is diffed against the
commit it replaced (`push-diff`), so a merge that does not touch the editor
runs no browser at all either (Dev2: "there should be NO browser test when we
aren't touching the editor"). Replayed over the 111 merges before 2026-10-07,
22 ran it, most of them real editor changes; the rest were a dependency bump
or a change to the CI scope tooling itself. The old per-push trigger ran the
full suite on 43.

A type-only import (`import type … from`, `export type … from`) is not
followed, since it is erased before anything runs. Until 2026-11-05 it was:
the editor's context menu named `MenuItem` from the file tree's menu by type
alone, which pulled the tree menu, folder jobs and the folder icon list into
the editor's scope (280 files, now 228). #3038 changed two lines of that icon
list and ran the editor's browser tests for it (Dev2: "why would a tex change
trigger a browser job?"). `ci-change-scope.mjs --self-test` fails if the icon
list comes back into the editor scope.

The scope fails open:

- a workspace package with no `main` to follow counts whole (one with a `main`
  is followed file by file: the editor imports five files of
  `@context/shared`, and claiming all of it ran the editor tests on every
  website change);
- top-level build configs of the app an entry lives in count (`metro`,
  `babel`, `app.config`, `package.json`), but not its lint, test-runner or
  store configs, and not an asset nothing imports; an app the walk only passes
  through (the editor imports the gateway's form grammar) counts only the
  files reached in it;
- root dependency files and the scope tooling count everywhere.

The path guard pins the entries, the trigger, the daily gate on the full and
offline jobs, and that the editor job runs exactly the specs its scope watches.
The scope self-test fails if a shared file the editor does not import matches.

The WebKit and Collaboration jobs use
`mcr.microsoft.com/playwright:v1.56.1-noble`, which matches the repository's
Playwright version. They do not download browser binaries during the run. A
Playwright version bump must update the package and image together; the CI path
guard pins the image and the shard/report topology.

## Measured browser baseline and runner decision

The first three full Browser CI runs on GitHub's standard public-repository
runner started after 4, 18 and 42 seconds. Their build-plus-two-shard critical
path was 4m04s, 4m14s and 4m36s. In the latest of those runs the two actual
WebKit test phases were 71s and 90s; the rest was checkout, dependency restore,
the single export, container startup and report handling. Three samples are not
an adoption benchmark, but they show both remaining facts: the tests are now
bounded, and standard-runner queue time still misses the 15-second p90 target.

Do not move the required checks from GitHub Actions yet. On 2026-09-28 the
organization API reported that GitHub-hosted larger runners are unsupported,
and the repository reported zero self-hosted runners. Neither Blacksmith nor
Depot is installed, so an identical live comparison is not possible without an
organization owner granting a new GitHub App access and accepting its billing.
Marketing numbers are not substituted for measurements.

The candidates, once that access exists, are:

- GitHub's 8-vCPU larger runner. It is the lowest-migration-risk control, but
  [larger runners require Team or Enterprise and are billed even for public
  repositories](https://docs.github.com/en/actions/concepts/runners/larger-runners).
- `blacksmith-8vcpu-ubuntu-2404`. Blacksmith documents sub-three-second Linux
  microVM boot, an 8-vCPU label and a colocated Actions cache in its
  [runner reference](https://docs.blacksmith.sh/blacksmith-runners/overview).
- `depot-ubuntu-24.04-8`. Depot documents the 8-vCPU shape and pricing in its
  [runner reference](https://depot.dev/docs/github-actions/runner-types), while
  its own [troubleshooting guide](https://depot.dev/docs/github-actions/troubleshooting)
  says startup commonly takes 10–45 seconds. That queue range must be measured,
  not assumed to meet this repository's target.

Benchmark the same commit and the same Browser CI workload five cold and five
warm times per candidate. Record request-to-start queue, install/cache restore,
export, test, total critical path and flakes. Adopt a paid runner only if its
median critical path is at least 40% lower than the standard runner, p90 queue
is below 15 seconds, and it introduces no additional failure. Until then the
free 4-vCPU/16-GB public-repository runner remains the baseline; those specs and
free public use are in GitHub's
[hosted-runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

## A pull request of only Tex config and data runs only the Tex checks

_Decided by the owner, 2026-11-17._ Promoting a Lab draft edits
`texConfig.json` and regenerates files inside the gateway, the app and the
shared package, so a config-only pull request looked like code to every job
and ran about 45 of them while the org had 20 runners. `TEX_DATA` in
`scripts/ci-change-scope.mjs` names Tex's config, node shelf, prompts,
Training and test-set data and their generated files. When those are all a
pull request changes, every `ci-scope` gate skips unless its job sets
`tex-data: "true"` (the gateway suite and units, the agent Worker tests, the
generated-bundle check); the app typecheck, native bundles and Mac jobs skip;
and the framework's lint, mobile and Convex jobs skip through its
`skip-when-only` input, which must list exactly `TEX_DATA` (the self-test
checks). The fast guards, the Tex replay check and the Tex test set run as
before, and pushes to `main` run everything. The three mobile shards still
skip, and with them `apps/mobile/__tests__/texLab*.test.ts`, which check that
the Lab still draws the config those files were generated from. A Lab Promote
is config-only, so that wiring was proved only after merge (#3443). `Tex Lab
wiring` runs just those tests, and only on a config-only pull request.
Reversing the skip puts config pull requests back in the queue behind every
suite; the `ci-change-scope` self-test fails if the rule, the list, or that
job drifts.

## Mac jobs are decided on Linux

The org has five macOS runners. The desktop launch smoke test and the Messages
extension compile used to run their path filter on a Mac, so every pull
request asked for two Macs to decide to skip; on 2026-11-17 both sat 19 to 22
minutes with no runner and were cancelled. A Linux job, `Which checks this
change needs`, runs the filters, and the Mac jobs start only when they match.
A job skipped by its `if:` reports success, so no required check waits.

## The fast checks run locally before a push

_Decided 2026-11-17, from the open-to-live measurement._ Five of the six pull
requests that took over 30 minutes to reach production had a red-CI fix loop:
the fast guards, the app typecheck, or the architecture check failed after
the push (#3544 failed typecheck and `ci / Architecture check`; #3538 and
#3532 failed Fast repository guards). `pnpm precheck`
(`scripts/precheck.mjs`) runs those three the way CI does. The guard steps
are every `run:` step of `.github/workflows/fast-guards.yml` except the Node
version line, so the Tex diagram check is in there. Three of those steps also
run `git fetch --no-tags --depth=1 origin "$BASE_SHA"`. CI needs that fetch,
because its checkout is already shallow. Precheck has already resolved that
commit as the merge-base, and the same fetch on a full clone writes
`.git/shallow` and cuts history there, so a line that is only that fetch
becomes `:` (an empty `then` is a bash syntax error) and the rest of the
step runs, while a `git fetch` of `$BASE_SHA` with another command chained
after it fails the self-test instead of discarding that command or
shallowing the clone. The app
typecheck is the `mobile-typecheck` job: `pnpm typecheck` with
`working-directory: apps/mobile` and `--max-old-space-size=6144`
(`pnpm --dir apps/mobile typecheck` locally). The architecture check is
`architecture-check: true` on the supa-framework workflow `ci.yml` calls. The
command itself, `pnpm exec supa-architecture-check --base origin/<base>`,
lives in that workflow; precheck runs it against `origin/main` (or `main`
when that is the ref that exists). It needs `pnpm install` already. CLAUDE.md
requires it before a push.

The script is the main module only when `fileURLToPath(import.meta.url)` is
`realpathSync` of `process.argv[1]`. Comparing `import.meta.url` to
`` `file://${argv}` `` is false for a symlink or a path with a space, and the
script then exits 0 having checked nothing.

Dropping it, or letting the steps drift from the workflow, puts the fix loop
back. Fast repository guards run `node scripts/precheck.mjs --self-test`. It
fails if a guard `run:` is skipped for any reason other than `node --version`,
if a guard line changes for any reason other than replacing a bare
`git fetch` of `$BASE_SHA` with `:`, if a `git fetch` of `$BASE_SHA` is
not only that fetch, if `mobile-typecheck` stops running `pnpm typecheck` in
`apps/mobile` with `--max-old-space-size=6144`, or if `ci.yml` stops passing
`architecture-check: true`.

## The Tex test set starts with the other checks

_Decided 2026-11-17._ On about 30% of pull requests the replay check failed
first, then started the Tex test set and re-ran itself. That check took
4.8–6.5 minutes, and it finished a median 1.9 minutes (5.1 on #3541) after
the rest of CI, which is how long the Test Set waited before it even began.
`scripts/tex-test-set-dispatch.mjs --early` dispatches it before the prompt
fingerprints when the changed files reach a model area. A reach only the
fingerprints can see still starts when the gate fails, and the two paths
cannot both start. The gate's pass rule is untouched: a successful `Tex test
set` status, the same caps, no budget and no eval threshold moved. A second
run that the cap refuses does not replace a pass already on the commit.

Starting it for a change that reaches no model area would spend a capped run
on work the gate does not ask for. `tex-test-set-dispatch.mjs --self-test`
fails if a file area waits for the fingerprints, if a prompt-only reach starts
early, or if an existing status starts another run.

## A description edit re-runs checks only when the skip line changes

_Decided 2026-11-17._ Fast repository guards and Tex replay required listened
for `edited`, so rewriting a pull request's description cancelled the
in-progress run and spent both checks again (measured on #3520). They no
longer do. `pr-description.yml` listens for `edited` and re-runs those two
only when `Replay skipped on the owner's call:` changed. The re-run reads the
live description, because a re-run otherwise keeps the body from the original
event. "No replay case:", "Tex diagram: unchanged because" and "Speed budget
raised:" are read on the next push, and on a re-run the skip line caused.

Re-running on every description edit spends the replay check (up to about six
minutes) and can cancel a green run that was still in progress.
`check-workflow-triggers.mjs` allows `types: [edited]` on
`pr-description.yml` only; the same filter on any other workflow fails its
self-test. `pr-description.mjs --self-test` fails if prose around an unchanged
skip line would re-run, or if a changed skip line would not.

## The mobile suite runs in six shards

_Decided 2026-11-17._ `ci / Test Mobile App` was three shards. On the pull
requests that ran it, shard 1 spent about 78 seconds in tests and the other
two 42 and 57, and `ci / Test Summary` waits for the slowest. Six is the
most the reusable workflow's matrix allows (`mobile-test-shards`). The
summary check's name does not change. The Convex suite is already at that
cap of six; raising it is a change in supa-framework, which this repository
calls at `@main`.

Folding the mobile suite back to one runner puts about three minutes of Jest
in front of `ci / Test Summary` on every app change.
