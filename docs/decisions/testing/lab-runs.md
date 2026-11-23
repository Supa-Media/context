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
- **What handed-off jobs add is reported beside the score.** A Front door
  test whose turn started a background job runs that job and its report
  (`apps/mcp/bench/jobDelivery.mjs`), and a run's results carry `handoff`:
  jobs run, parts, the job advisor's calls (its done check on each part), their
  spend and the spend per job, already inside `costUsd` (Dev2, 2026-11-18:
  "report how many advisor calls and how much cost a handed-off job adds per
  run ... so Finance can check spend"). The Lab's Runs panel says it after the
  cost.
- **Each row says how many rounds its turns took.** A Front door row's detail
  opens with each texted turn's rounds of its bound (`rounds: 3/12, 12/12 ran
  out`): "reached its end" when it was told to stop gathering, "ran out" when
  its last round still ended on tool calls, "handed off" when the Hand-off node
  took the job from there (`lastRound.js` `roundsField`, the reply's `rounds`).
  A miss is read against running out from this line, never guessed (Dev2,
  2026-11-18: "prove from traces which Training fd misses are round exhaustion
  before wiring").
- **Each run says how it routed.** A Front door row carries its first turn's
  route (`pick`, `sure`, `door`, `fellBack`, the reply's `route`), and the run's
  detail says it after the rounds. The run's "By route" block and tex_dev's
  `runs { id }` `byRoute` are one summary (`packages/tex/src/texRouteSummary.cjs`):
  per-route pass rate and cost per turn, the router's confusion against the set's
  gold `labels.router.route`, the specialist doors' fallback rate, cost per turn.
  Rows that did not run and ambiguous rows are out of it, as out of the score.
- **The Dev set, or Training when asked.** The workflow runs the bench's
  node-alone runner (`node apps/mcp/bench/run.mjs sets run`) on the repo's Dev
  conversations with the Lab's Dev drafts over them (`scripts/tex-lab-run.mjs`).
  A run with `set: "training"` (`tex_dev` `run`) runs the repo's Training
  conversations instead, less any the Lab moved to Dev or removed (Dev2,
  2026-11-18: "prove it on Training ... a scored Lab Training run"). A step has
  seen Training as examples, so a Training score shows a change works where it
  was taught, and Dev is still the score that says it generalizes. Never the
  Test set (people only, in the eval service; it gates only a Promote's pull
  request).
- **The draft is the config of that run.** Its graph is written into the
  checkout by the promote script's own check and write, so a draft Promote
  would refuse fails the run with the same reason.
- **The subscription token stays in GitHub Actions.** `cc` answers Claude's
  calls with Claude Code (`apps/mcp/bench/socketAnswerer.mjs`) inside the job;
  the token is never sent to the control plane or the gateway, as its terms
  allow for CI and scripts and not for a product's servers. Clef stays on
  Workers AI either way.
- **A run can be on a pull request's code** (Dev2, 2026-11-16: "when we run
  things it should run on the PRs code instead of main"). A draft names a
  same-repository pull request (`#3401`) or branch (the Lab's Code field in the
  run menu; `tex_dev` `code`), and a run may name its own (`run { code }`). The
  workflow resolves it to a commit, refuses a fork's pull request, and runs that
  commit's code, its own promote check and its own Dev set, in a job that never
  holds the Convex deploy key: reading the run and reporting back are main's
  code in separate jobs, and the run and its results pass between them as
  artifacts sealed with a key made for that run, which travels only as a job
  output (a public repository's artifacts are anyone's to download). Every
  run records the commit that actually ran, and the Lab and `runs` show it.
  Test chats still run on production's gateway: a Worker with
  Durable Objects gets no per-version preview, so a branch's gateway would be a
  deployment of its own.
- **A quick run tests only what the draft changed** (Seyi, 2026-11-23: "speed
  is the name of the game ... make a change and run loops to know that 1.
  their change fixes the issue, and 2. the change does not regress other
  things ... I want that loop closed to 10 minutes max"). `run { draft,
  quick: true }` is a draft's Dev run, on the AI gateway or on Claude Code
  ($0 on the subscription, while the API key's limit is the constraint). After the draft is
  written into the config, `scripts/tex-lab-run.mjs` `scope` compares the
  config before and after, and when every changed step has unit tests of its
  own, only those run. A changed step with none can reach any tested step's
  run (the Front door's whole turn, or a setting a test reads, as Decide's
  tests read decideWhy), so it runs every step, as does a change no single
  step owns (models, groups, conversation settings). Code from before `scope`
  existed runs every step too. On the AI gateway
  sixteen Front door tests go at once instead of eight, and a quick run skips
  the Claude Code regrade and gold self-check. When main has no Dev run on
  the same models for the set, done or under way, one starts beside it, so the quick
  run's `vsMain` always has a base; the comparison pairs only the rows both
  runs scored.
- **Caps:** 20 waiting or running per person, 300 a day (raised from 3 and 20,
  then 6 and 60, by Dev2, 2026-11-17: every thread of a person runs as them,
  and the caps only guard against a runaway loop; GitHub queues jobs past the
  account's concurrent limit rather than failing them). A run still open after
  three hours no longer holds a place.
- **Public logs say counts and ids.** Results go to Convex, never into the log.
- **A Lab run leases a runner slot, or falls back to the shared runner.** The
  spend check signs in as one of three Lab runner slots (`LAB_RUNNER_1`…`3`):
  each is its own grant of the bench test account, made with
  `pnpm ai connect --lab-slot N`, and a slot's grant rotates its refresh token
  on every use and revokes itself when a retired one is presented. The `lease`
  job (main's checkout, the deploy key) asks
  `functions/labRunnerSlots:acquire` once for a free connected slot
  (`scripts/lab-runner-lease.mjs`). **It never blocks a run** (Dev2,
  2026-11-19, after #3682 stopped every Lab run with "no Lab runner slot is
  connected" and was reverted in #3701): with no slot connected, none free, or
  the pool or the job itself failing, the slot is 0, and the run signs in with
  the shared benchmark runner (`BENCH_RUNNER_*`) behind
  `scripts/bench-runner-lock.mjs` (`wait-turn`, then `--check`), exactly as
  before slots. `tex-lab-run.yml` stays on the lock's list, so the other
  runner workflows wait for any earlier Lab run. A slot is held by one run at a
  time, and a holder whose GitHub run has ended is reclaimed. The lease is
  released by the `release` job after the write, so the next run that takes
  the slot reads the token it wrote. The run job, which checks out the draft,
  seals the rotated token after that sign-in and again after the spend line.
  It does not write the secret. A later job checks out `main` only, opens the
  seal, checks the value is a refresh token (`crt1.…` or the legacy `crt_…`
  form), checks the slot is 0-3, and writes `LAB_RUNNER_<N>_REFRESH_TOKEN`
  (slot 0: `BENCH_RUNNER_REFRESH_TOKEN_LIVE`) in the production environment
  with stdin. Tex replay writes `BENCH_RUNNER_REFRESH_TOKEN_LIVE` the same way.
  A salvage of a Lab run reads the slot from its lease job's log line
  (`Leased Lab runner slot N`, or `Using the shared benchmark runner`).
  `scripts/lab-runner-lease.test.mjs` fails if zero connected slots, a busy
  pool or a failing lease could stop a run, or if the workflow's slot-0 wiring
  (wait-turn, the shared secrets only behind `slot == '0'`, the shared write)
  goes.
  The key is an RSA key made for the run. Its public half is all the branch
  job receives. Its private half is wrapped with AES under
  `BENCH_SECRET_WRITER_TOKEN` and leaves the key job only as ciphertext, as a
  job output. The branch job needs the job that forwards the public half, not
  the key job, and `needs` does not carry outputs through, so the wrapped key
  is not in the branch job's context. A public artifact is the ciphertext of
  the refresh token. The writer token is a fine-grained PAT owned by
  Supa-Media, limited to this repository, with Environments read/write and
  Metadata read. It expires on 2027-11-18. Rotate it before that day.
  The branch already sees the refresh token it just rotated. What it must not
  see is a token that can write production secrets. GitHub-hosted runners have
  passwordless sudo, so a branch can replace `/usr/bin/openssl` after install
  and upload a blob that is not a seal; the writer then fails the write
  instead of storing it. The writer token is only on the key job and the
  writer job, both of which run main's code. An empty writer token fails the
  key job, before sign-in. A refused write fails the writer job. If the seal
  after the run fails, the writer does not store the earlier token: the spend
  line may have rotated it. If the run dies after the first seal and before
  the second, the first seal is what gets written. The workflow stays in
  progress until the writer finishes, so the next run still reads the secret
  after the write.
- **Promote starts at once.** Asking dispatches `tex-lab-promote.yml`
  straight away (the quarter-hour schedule stays as the fallback) and makes a
  "gate" run, which follows the pull request's **Tex test set** status and
  keeps its counts only.

## What a simplification would cost

A quick run that narrowed past a changed step with no tests of its own would pass a draft whose change breaks a whole turn, or Decide's reasons, unseen, and one with no base would end in "no base" instead of a verdict; `apps/mcp/test/texDevRuns.test.mjs` (`quickNodes`, `changedSteps`) and `texLabRuns.test.ts` ("a quick run") fail if either is dropped. Running Lab tests in the gateway on the subscription token would put a plan
credential on a server; running Training or the Test set here would score a
draft on what it was taught or leak the sealed set. `apps/convex/__tests__/controlPlane/texLabRuns.test.ts`
fails if the caps, the finished-stays-finished report, the Dev-only hand-off
or the gate's status reading are dropped; `apps/mcp/test/texDevRuns.test.mjs`
fails if a run could cover a Training chat. Without the deploy key split, a
branch's code could rewrite the files the reporting step runs and act with the
production deploy key; the code tests in `texLabRuns.test.ts` fail if a code
name could be an option, a path climb or another repository's pull request.
Two Lab runs signing in on one slot's grant, or a Lab run that spends the
refresh token and does not write it back, presents a retired token next time
and the gateway revokes the grant; the next Dev run then stops at
`invalid_grant` until someone runs `pnpm ai connect --lab-slot N` again. The
lease is what keeps one run per slot. Putting the writer token back on the
job that checks out the draft, or naming the
repository admin token in `tex-lab-run.yml` or `tex-replay.yml`, lets that
draft's install read a credential that writes production secrets.
`scripts/check-bench-token-writer.mjs` fails on either. Passing `gh secret set`
a flag it does not have exits before the API call. There is no `--body-file`,
so that write never stores the rotated token and the next sign-in revokes the
grant. The write reads the value from stdin or from `--body`. The same script
fails otherwise. The opener writes the token with no trailing
newline; `gh` strips trailing CR/LF from stdin, and a refresh token has
neither, so the stored value is the token. The writer token expires on
2027-11-18; leaving it past that date means the next Lab run and the next
replay cannot store a rotated refresh token, and the following sign-in
revokes the grant.
