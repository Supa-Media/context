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

The WebKit and Collaboration jobs use
`mcr.microsoft.com/playwright:v1.56.1-noble`, which matches the repository's
Playwright version. They do not download browser binaries during the run. A
Playwright version bump must update the package and image together; the CI path
guard pins the image and the shard/report topology.
