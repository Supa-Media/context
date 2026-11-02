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
- The copy is the only place a turn reads the history from, and it never
  falls behind (Seyi, 2026-10-31: "the saved copy needs to be the only
  source of truth", "if it falls behind that's a bigger issue"). Every write
  to the person's texts reaches it: one made in the turn's own request (the
  Worker's fixed texts, a yes the gateway settles by itself, which now hands a
  copy back too) is added there (`store.chatWrites`, `withWrites`); one made
  by a routine or a check-in comes back with its answer sealed for the
  person's texting turn alone (`sealBeside`, same key and associated data
  with the texting client), the Worker keeps it beside the copy (at most 20,
  a day) and hands it to the next text, which adds it. A text Tex sends
  outside a turn with nothing sealed for it drops the copy instead of leaving
  it behind. A turn that names no texts (a job's report) still hands the
  history on: it used to leave the chat out because it read no log, and every
  text after a report re-read 150 exchange files (2026-10-31 16:57, 7 s).
  A write that only needs to know whether the old whole file must be copied
  in reads nothing when the copy holds the history by id (`priorTurns`).
- The Worker drops the copy after a day, when an answer hands none back, and
  when a turn ends with the gateway unreachable (it may have written and
  never said what). A turn refused before it ran (the daily limit, no model)
  keeps it. A group, a job's turn and a routine never use or make one. A job's
  report to the chat's own turn does (2026-10-31: it re-read 150 exchanges,
  10 s, before the model).
- A turn that starts a background job keeps its copy (2026-10-31: the text
  after a job start re-read 150 exchanges and every skill, 9 s). A job never
  writes the chat itself, it reports through the chat's own turn, but it can
  write task notes, the jobs list or a skill, so while a job runs, and for ten
  minutes after it finishes, About me, the jobs list and the skills are read
  fresh (`warmCopy.js` `jobBusy`).

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
- Tex's transcript note is written once, with the turn's ending, never once
  per step: a long turn's step writes cost ~130 storage calls beside its own
  tools (`transcript.js` `record`).
- A turn's after-work (the meter, the turn row, the transcript, saving the
  chat, reflection) is queued and started only once its response is ready
  (`deferred.js` `afterTurn`). Started at the call, it took the Worker's six
  connections and the reply's own last reads queued behind it: 10 s.

Tests: `apps/mcp/test/agentWarmCopy.test.mjs`, `apps/mcp/test/agentHeldLog.test.mjs`,
`apps/agent/src/warm.test.ts`, `apps/agent/src/heldLog.test.ts`.
