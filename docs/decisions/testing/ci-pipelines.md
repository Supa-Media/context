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

## Browser groups match the defect they prove

The browser build is made once per configuration and passed to its test jobs as
an artifact. The groups are:

- WebKit smoke: app-shell or packaging changes outside a full-suite owner. It
  boots the built export, walks the real file tree and renders a fixture note.
- Full WebKit: editor, plugin runtime, offline shell, shared runtime and browser
  fixture changes. Two shards run in parallel and produce one merged HTML
  report. Failed shards retain screenshots and traces.
- Offline Chromium: the service-worker reload that Playwright WebKit cannot
  perform while offline. It runs beside either WebKit mode.
- Collaboration Chromium: storage recovery, two-editor convergence, presence,
  offline edits, rename, trash, restart, revocation and stalled connections
  against a local gateway and local R2.

Collaboration Chromium is scoped by file rather than by package, because what
it runs is a few entry points. These are the root layout, the collaboration
fixture, the test Worker and its harness. Their `entries` on the scope step are
followed through imports by `scripts/import-reach.mjs`. A change to a console
screen the fixture never mounts, or to a Convex function the gateway never
imports, does not run it. Replayed over the 100 merges before 2026-09-29, 59
ran it, down from 81.

The scope fails open:

- a workspace package imported by name counts whole;
- configs, assets and top-level files of a reached app count;
- the route and switch that lead to the fixture are named in `paths`.

The path guard pins the entries. The scope self-test fails if the editor ever
falls outside them. Undo this and every app change pays about four and a half
runner-minutes again.

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
