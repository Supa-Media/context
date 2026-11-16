# Lab runs go to GitHub, on the Dev set only

Decided by the owner, 2026-11-16: the Lab's Run Dev set, Run this chat and Run
node run on GitHub, dispatched by Convex directly ("Convex dispatches directly"
over a GitHub listener), with a Models pick of the AI gateway or Claude Code on
`CLAUDE_CODE_OAUTH_TOKEN`; approved with the mockup
(`P2vQtigdvALrSWyb5CqQ3E`, "Ok go ahead and build everything").

## The rule

- **One record, one workflow.** A run is a `texLabRuns` row
  (`apps/convex/functions/texLabRuns.ts`). Starting one, from the Lab or from
  `tex_dev` `run`, dispatches `.github/workflows/tex-lab-run.yml` on `main` with
  `GH_ADMIN_TOKEN`, the PAT the promote workflow already uses, synced to the
  control plane at deploy. The workflow reports its stage and results back
  with the deploy key (`texLabRuns:report`); the Lab and `tex_dev` `runs` read
  them.
- **The Dev set only.** The workflow runs the bench's node-alone runner
  (`node apps/mcp/bench/run.mjs sets run`) on the repo's Dev conversations
  with the Lab's Dev drafts over them (`scripts/tex-lab-run.mjs`). Never
  Training (a step has seen it as examples) and never the Test set (people
  only, in the eval service; it gates only a Promote's pull request).
- **The draft is the config of that run.** Its graph is written into the
  checkout by the promote script's own check and write, so a draft Promote
  would refuse fails the run with the same reason.
- **The subscription token stays in GitHub Actions.** `cc` answers Claude's
  calls with Claude Code (`apps/mcp/bench/socketAnswerer.mjs`) inside the job;
  the token is never sent to the control plane or the gateway, as its terms
  allow for CI and scripts and not for a product's servers. Clef stays on
  Workers AI either way.
- **Caps:** 3 waiting or running per person, 20 a day. A run still open after
  three hours no longer holds a place.
- **Public logs say counts and ids.** Results go to Convex, never into the log.
- **Promote starts at once.** Asking dispatches `tex-lab-promote.yml`
  straight away (the quarter-hour schedule stays as the fallback) and makes a
  "gate" run, which follows the pull request's **Tex test set** status and
  keeps its counts only.

## What a simplification would cost

Running Lab tests in the gateway on the subscription token would put a plan
credential on a server; running Training or the Test set here would score a
draft on what it was taught or leak the sealed set. `apps/convex/__tests__/controlPlane/texLabRuns.test.ts`
fails if the caps, the finished-stays-finished report, the Dev-only hand-off
or the gate's status reading are dropped; `apps/mcp/test/texDevRuns.test.mjs`
fails if a run could cover a Training chat.
