# Tex's warm copy, sealed in the sender's object

Decided by the owner, 2026-10-31 ("how can we completely eliminate storage
calls", then "yeah let's do that" to keeping it in the texting Worker's
per-person Durable Object rather than in Convex tables).

## What it is

A one-to-one "hi Tex" read, before its model ran: the production setup through
the pinned workspace, the learned skills, About me and the jobs list, today's
chat, the chat's event log and the turn record behind each of Tex's events in
it, and the waiting asks. Each storage call took about a second, so the turn
took 50 to 95 seconds around a 3-second model.

Now each answer to a person's own text carries `warm`: what that turn read,
sealed by the gateway (`apps/mcp/src/agent/warmCopy.js`). The sender's
Durable Object keeps it (`apps/agent/src/warm.ts`) and sends it back with the
next text, beside the chat's newest events (`recent`, the same events it
posts to `/agent/events`). A turn with a copy it can open reads none of that
from storage; one without reads as before and starts one.

## Why it is allowed outside the bucket

- **Sealed, key outside the Worker.** AES-GCM under a key derived from
  `GATEWAY_SECRET`, which the texting Worker never holds. The Worker keeps
  bytes it can neither read nor change. The associated data binds the
  workspace, the person and the client, so a copy never opens on another
  person's turn. Same shape as the autofill vault's exception in
  non-negotiable #1.
- **A cache, never the record.** Every note, the chat and its log still live
  in the bucket and are written there as before; export is unchanged.
  Dropping the copy costs one slow turn and nothing else, so it is a
  disposable derivative under non-negotiable #3.
- **Not Convex.** The control plane never holds a note's body
  (non-negotiable #1), and a table read per text still costs a call and adds
  to the database bill.

## How fresh it is

- The setup, learned skills, About me and the jobs list: ten minutes, and a
  turn that called any tool hands back a copy without them.
- The chat: a day, carried forward by each turn with the exchange it kept,
  under the id it is written with (`events.js` `newExchange`). A turn with
  fixed Worker texts (`told`) or files reads the chat again.
- Waiting asks are kept only as "none waited after the last turn". A text
  that may answer an ask (a yes, a no, a tapback) still reads the records:
  that check is the gateway's, never a copy's.
- The Worker drops the copy after a day, when an answer hands none back, when
  it starts a background job, and when a routine texts the person: the chat
  then holds words the copy hasn't seen. A group, a job's turn, a routine and a
  job's report never use or make one.

## Also moved out of the reply's way

- The Worker's event and stale-ask flush runs beside the turn, not before it,
  one at a time per object so a stale ask is never sent twice.
- Pruning old turn records runs after the answer (`loggedTurn.js`
  `recordTurn`); the record itself is still written before it.

## The Worker holds the chat's log (2026-10-31)

Seyi: Tex's Durable Object is the source of truth, and an append-only
transcript beats a file per message. A "hi Tex" at 13:57 made 964 storage
calls, about 400 of them reading the chat's log one event file at a time,
and the reply took 46 s with 3 s in the model.

- Every event of a one-to-one chat already passes through the sender's
  object (`apps/agent/src/events.ts`), and only it writes the bucket's log
  (`POST /agent/events`). It now keeps as much as the gateway reads (400
  events, 120,000 characters, a day), and decide is still shown only its own
  24,000 characters (`TRANSCRIPT_CHARS`).
- The first turn that reads the log from the bucket hands it back (`log`);
  the object keeps it as written and from then on says `holdsLog`, and the
  gateway takes the object's events as the whole log and reads none
  (`warmCopy.js` `events`). The trust is unchanged: the object could already
  write any event to the log, and every event is checked as `/agent/events`
  checks it. A lost object (no `holdsLog`) reads the bucket once and is
  handed the log again.
- The bucket's log is still written: it stays the customer's copy and what
  a group, a job or a routine reads.
- A turn's after-work (the meter, the turn row, the transcript, saving the
  chat, reflection) is queued and started only once its response is ready
  (`deferred.js` `afterTurn`). Started at the call, it took the Worker's six
  connections and the reply's own last reads queued behind it: 10 s.

Tests: `apps/mcp/test/agentWarmCopy.test.mjs`, `apps/mcp/test/agentHeldLog.test.mjs`,
`apps/agent/src/warm.test.ts`, `apps/agent/src/heldLog.test.ts`.
