# Jobs and group retries wake themselves (Dev2, 2026-11-21)

Decided by Dev2, 2026-11-21, with the Tex runtime simplification
(https://claude.ai/artifact/AcEGnAtBKWqeTAcXa1vveX): every box lives in the
gateway, every turn is a network call, and the texting Worker becomes just the
line. Asked how jobs should wake, Dev2 chose **the box's own alarm** over moving
the Workflow code into the gateway.

**What changed.** A background job's object keeps where its run is
(`jobdrive`) and its own alarm runs each pass (`packages/tex/worker/jobDrive.ts`).
A group turn that failed is kept at `gretry:<id>` and tried again by its chat's
alarm, beside the drain (`groupRetry.ts`, `groupTurnRun.ts` `retryDue`). The
`job-run` and `group-turn` Workflows, and the calls a gateway box made back to
the texting Worker to start them (`TexRoutines.jobRun`, `groupTurn`), are no
longer used. The code runs the same in the Worker's `SenderInbox` and the
gateway's `TexChat` and `TexJob`.

**What stayed the same.** A failed job pass and a failed group turn are each
tried four times in all, 10, 20 and 40 s apart, then the chat hears the
couldn't-finish line. A job's overlap waits, its pass cap, its resume after a
crash (`turnResume.js`, `jobProgress.ts`) and its node log (`texJob.js`
`passNext`, the job node) are unchanged. A group turn is still answered first
beside the drain; only a failed one is retried.

**A pass or try that never comes back is still caught.** Before each one runs,
its alarm is set 20 minutes on (longer than a turn's twelve-minute stream), so
a box reset mid-pass, or an alarm that ran out of its own time, is picked up
then and counted as a try. That replaces the Workflow step timeout and the job
watch (`jobWatch.ts`, 2026-11-20), which is deleted.

**What a simplification would cost.** Moving retries back into a Workflow puts
a cross-Worker call in every job part and every group retry, the seam behind
this week's silent jobs. Dropping the watch alarm leaves a job whose box was
reset stuck with nobody told. Tests: `packages/tex/worker/jobDrive.test.ts`,
`groupRetry.test.ts`, `apps/mcp/test/texJob.test.mjs`.

**Transition.** A job stored without `jobdrive`, or a group turn marked started
without `gretry:`, was started by its Workflow before this change: that Workflow
still finishes it, and the alarm leaves it alone. The Workflow classes, their
bindings and the RPC ops are deleted once none is left ("Delete Tex runtime
seams").
