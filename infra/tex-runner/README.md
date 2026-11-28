# The Lab's runner

`context-tex-runner` runs the long `run` job of `.github/workflows/tex-lab-run.yml`
on a GitHub Actions runner of our own: one Cloudflare container per run, with
GitHub's just-in-time configuration for exactly one job. The job waits on model
calls for almost all of its hour, which costs a container a few cents and a
private repository's GitHub minutes much more. Why and how it is held:
[docs/decisions/testing/lab-runner.md](../../docs/decisions/testing/lab-runner.md).

- `src/start.ts`: the one door, `POST /v1/start`, for main's `tex-lab-run.yml`
  by its GitHub OIDC token (audience `context-tex-runner`). Registers the
  runner, starts its container, and answers the job's label once it is online.
- `src/index.ts`: `LabRunner`, one Durable Object and container per label, and
  the alarm that stops it at the job's timeout.
- `Dockerfile`: GitHub's runner image plus what the job's own scripts call.

Turn it on with the repository variable `TEX_LAB_RUNNER=sandbox`. The deploy
(`deploy-tex-runner.yml`, production only) sets the Worker's `GH_RUNNER_TOKEN`
and the `TEX_RUNNER_ORIGIN` repository secret the workflow reads.
