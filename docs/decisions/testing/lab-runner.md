# The Lab run's long job runs on a runner of our own

Decided by the owner, 2026-11-28, scoping the private Tex repo: the evals move
off GitHub's runners into a Cloudflare Sandbox.

## What

`tex-lab-run.yml`'s `run` job spends almost its whole time (about 58 of 60
minutes on a full Dev set) waiting on model calls. GitHub's runners are free
while this repository is public, and they bill by the minute once the Tex
quality work moves to a private repository: about 30,000 minutes a month at
today's volume, against the 3,000 the Team plan includes.

So that job can run on a GitHub Actions runner of our own, `infra/tex-runner`:
one Cloudflare container per run, started with GitHub's just-in-time runner
configuration, which registers exactly one runner for exactly one job. The
container runs GitHub's own runner image; when the job ends the runner exits
and the container stops. About $10 to $40 a month at the same volume.

The workflow does not change shape. Its jobs, secrets, sealing, artifacts and
what runs on main's checkout against a branch's code stay as they are; only
the host of one job changes. Everything else in the workflow stays on GitHub.

## How it is held

- **Only main's `tex-lab-run.yml` gets a runner.** Its `sandbox` job asks the
  Worker's one door (`POST /v1/start`) with a GitHub OIDC token whose audience
  is `context-tex-runner`; the Worker checks it with the eval service's own
  code (`infra/tex-eval/src/oidc.ts`, door `lab-runner`), so a branch that
  dispatches the workflow on itself, another workflow, or the eval service's
  audience is refused. `infra/tex-runner/src/start.test.ts` fails if any of
  them gets through.
- **One label per run attempt** (`tex-lab-<run>-<attempt>`), so no other job
  can take the runner.
- **The registering token never reaches the container.** `GH_RUNNER_TOKEN`
  (the repository admin PAT, set by `deploy-tex-runner.yml`) lives only in the
  Worker; the container gets the one-runner configuration and nothing else.
  `tex-lab-run.yml` still never names the admin token.
- **It never fails a run.** With `TEX_LAB_RUNNER` not `sandbox`, no origin, no
  token, or a runner that is not online within 150 seconds, the `run` job runs
  on `ubuntu-latest` as before, and a registered runner that did not come
  online is stopped and removed.
- **It never outlives its job.** An alarm stops the container 200 minutes after
  start (the job times out at 180) and removes a runner that never took it.

## The risk it carries while this repository is public

A runner registered on a public repository is one any workflow in it can ask
for by label, a fork's pull request included once its workflows are approved
to run. The label names a run id that the public Actions page shows, so such a
workflow could take one run's runner: it would get a container with the
internet and no secret (the job's secrets come with the job, and the
registering token never leaves the Worker), and that Lab run would wait for a
runner that is gone. GitHub advises against runners of one's own on public
repositories for this reason. It ends when the Lab moves to the private
repository, and until then the switch stays off unless the owner turns it on.

## What reversing it costs

Pointing the job back at `ubuntu-latest` is one repository variable
(`TEX_LAB_RUNNER`), and free while the repository is public. In a private
repository it is the minutes bill above.
