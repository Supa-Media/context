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

## Per push, a real browser tests only the note editor

_Decided by Dev2, 2026-10-07: "we don't need the browser to test settings
panels etc, only super critical things like the note editor and changes to
that, everything else can use regular unit testing."_

The browser build is made once per configuration and passed to its test jobs as
an artifact. On a pull request or a push to main:

- Note editor in WebKit runs the editor's own specs (`editor`,
  `editorFormatting`, `callouts`, `tables`, `comments`) in one job, and only
  when the editor or what it is built from changed.

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
fixture route are named in `paths`. Replayed over the 110 merges before
2026-10-07, 24 ran it; the old per-push browser trigger ran the full suite on 43.

The scope fails open:

- a workspace package with no `main` to follow counts whole (one with a `main`
  is followed file by file: the editor imports five files of
  `@context/shared`, and claiming all of it ran the editor tests on every
  website change);
- configs, assets and top-level files of the app an entry lives in count; an
  app the walk only passes through (the editor imports the gateway's form
  grammar) counts only the files reached in it;
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
