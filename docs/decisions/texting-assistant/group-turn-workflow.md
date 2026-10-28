# A group turn is seen through by a Cloudflare Workflow (Dev2, 2026-10-27)

Decided by Dev2, 2026-10-27, after group texts went unanswered and the turn
that failed was found only by tailing logs.

**What moved.** The chat's Durable Object still accepts messages, asks
decide, chooses the turn and runs it: a turn reads and writes that object's
storage throughout, and a message that lands meanwhile is steered into it
there. What moved to a Workflow (`apps/agent/src/groupTurnWorkflow.ts`, one
instance per turn, named by the turn's id) is the retrying. The workflow asks
the object to answer the turn; when that throws it retries three more times,
from ten seconds with exponential backoff; after the last it asks the object
to tell the chat it couldn't answer. Each turn shows on the Workflows
dashboard with its step, attempts and error. The object starts nothing else
while a turn is handed over, so a chat still answers one turn at a time.

**A retry never repeats what reached the chat.** Each part a handed turn
sends is remembered by turn and position, as the hash of what it was; a
retry skips a part already sent at that position.

**A workflow that will not start is loud, never quiet.** The start is tried
again on the next alarms, three times in all. After that the turn is answered
in the object as before, and `group_turn workflow_unavailable` is logged as an
error, so a broken binding or a Workflows outage shows, and nobody is left
unanswered.

**A turn whose workflow is gone** (no word for two hours, longer than every
attempt can take) is given up on, with the failed line, rather than holding
the chat.

**Rollout.** Every group at once, tested in production, since group chats are
still in beta. The fallback is reverting the change. 1:1 chats are unchanged.

What a simplification would cost: answering a handed turn without the
per-turn part record sends a reply twice whenever a retry follows a partial
send ("a retry sends only what did not reach the chat" in
`groupTurnWorkflow.test.ts` fails); dropping the in-memory guard answers a
turn twice when a retry overlaps its first attempt ("the same turn asked twice
at once is answered once" fails).

## Chat routines and check-ins (Dev2, 2026-10-28)

A chat routine's run and a group check-in (`groupRoutines.ts`, the check-in is the routine path `(check-in)`) already reached the chat's queue as their writer's tag and were answered as a group turn, so they already went through this workflow. Three things changed so each run is its own instance and shows as such:

- The instance is named by the run: `routine-<runId>`. A run handed to the chat again is found by a seen key (`gseen:routine:<runId>:`) and never queued twice, so it never starts a second instance or a second answer.
- A run the gateway could not answer now throws like any turn, so the workflow retries it (3 retries, exponential from 10 seconds). Failing every try reports `failed` to the control plane quietly; the chat is never told. A daily limit or no model is still reported at once, without retrying.
- Every `group_turn` workflow log line of a run carries `kind=routine` or `kind=heartbeat`, and the Tex group alert counts kinds when it reports a turn the workflow could not start or gave up on.

Unchanged: a run answers only while its writer is in the chat, never rebinds the chat (#2318), and waits behind a turn already handed over in the same chat. No new binding: runs use `GROUP_TURN`. The cron still fires runs every minute and the chat's alarm still wakes the queue at once; only the answering moved, as for people's turns.

## A workflow that never starts: the chat is told, not answered here (Dev2, 2026-10-28)

The turn used to be answered inside the chat's object when its workflow could not start after `MAX_STARTS` tries. That kept two paths alive for one turn. Now, after the last failed start, the turn's messages are dropped, `workflow_unavailable` is logged as an error as before, and the chat gets one fixed line, `GROUP_LINES.stuck` ("I'm having trouble answering right now. Try me again in a minute."), once per stuck turn. A routine's or check-in's run reports `failed` quietly and says nothing. A Worker with no Workflows binding at all (tests, a self-hosted deployment without Workflows) still answers in the object, since it has no other path. Test: "a workflow that will not start is tried again, then the chat is told once that Tex is stuck" (`groupTurnWorkflow.test.ts`).


## Background jobs on Workflows (Dev2, 2026-10-28)

A background job (`apps/agent/src/jobRun.ts`) is seen through by its own
Workflow instance, `JobRunWorkflow` (`jobWorkflow.ts`, binding `JOB_RUN`),
named `job-<job id>`, so starting the same job twice runs it once. The job's
object keeps the job's state and runs each pass; a pass no longer sets the
object's alarm but says what comes next (`JobNext`: done, now, or after a
wait), and the instance does the waiting with `step.sleep`. A pass that fails
is retried three more times from ten seconds, exponentially, as a group turn;
a pass that keeps failing ends the job with its "couldn't finish" line. Logs
carry `kind=job`.

Without a `JOB_RUN` binding (a self-hosted Worker, most tests) the object's
alarm drives the passes as before (`armJobNext`).

For one release, a job armed by its object's alarm before this change is
handed to its instance when that alarm fires (`handOverJob`), so no armed job
is lost. That handover is removed in a follow-up once no such alarm can
remain.
