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

## A busy group is answered fast, and only with a reply that still fits (2026-10-30)

From the group review of 2026-10-30 (a "tex, settings" took four minutes, and a
reply about saving a playbook landed after a debugging question), carrying out
two points of the interaction-agent redesign the owner adopted that day: a
message that names Tex skips the pause, and before sending, Tex checks the
reply still answers the latest ask from the right person.

- **A named message never waits on decide.** It is answered whatever decide
  says (code's floor, 2026-10-27), so a burst holding one is chosen by code
  alone (`addressedTurn` in `groupTurn.ts`): every addressed message with what
  joined it, the untagged lines before it as chat, the untagged lines after it
  decided on the next pass. Decide is asked only about bursts of untagged
  messages. This removed up to 15 seconds (`GROUP_DECIDE_MS`) from every tag.
- **A fixed line never waits behind another turn.** While a handed turn holds
  the chat, the drain still answers what code answers alone
  (`groupBeside.ts`): the commands (`groupCommand`, which the control plane
  answers with no grant), a reply to the settings menu, a style choice, an
  SMS group's line. A yes, a 👍, a routine's run and a job's report still
  wait: each is a model turn, and a chat runs one model turn at a time. A
  handed turn's remembered parts are now only the ones under its own
  messages, so a line sent beside it is never taken for one of its parts.
- **A reply drafted for an older ask is looked at again.** When the asker has
  written since the turn started and none of it was folded in, the Worker
  asks `POST /agent-texts/recheck` (CONTRACT.md section 3b, the decision
  model through `withJev` as `textDecide`) whether the draft still answers
  them (`groupRecheck.ts`). Held (below 0.5), the turn ends as a restart does:
  nothing it wrote is sent, its held asks are withdrawn, and one new turn
  answers the old ask and the newer words together. Each ask is held at most
  once. Recheck unreachable or unsure: sent, as before. Somebody else's words
  never trigger it: their tag is their own turn.

What a simplification would cost: putting a named message to decide again
brings back the wait ("a named message never waits on decide" in
`groupFast.test.ts` fails); returning on a handed turn without answering
beside it brings back the four-minute settings menu ("Tex, settings is
answered while another turn runs" fails); sending without the recheck brings
back replies to questions nobody is asking ("a draft for an older ask is held
once…" fails).
