# Meeting capture: how the pieces fit

_The shape of the system, and the one question it is not yet able to answer._

The decisions are in [decisions/meetings](../decisions/meetings.md); this is the
map. Four capture surfaces, one contract they all agree to, one gateway, storage
the customer owns, and a control plane that never sees a word of a meeting.

```
  Capture                       Contract                Gateway & storage
┌──────────────────────┐      ┌──────────────┐       ┌───────────────────────┐
│ iOS / Android        │      │              │       │  MCP gateway          │
│  notepad, mic,       │─────▶│  packages/   │──────▶│  (Cloudflare Worker)  │
│  Live Activity       │      │  meetings    │       │  ingest, grant check, │
│                      │      │              │       │  enhance, write       │
│ Desktop web          │─────▶│  protocol.js │       └───────────┬───────────┘
│  same Expo build,    │      │  session.js  │                   │
│  typed notes only    │      │  detect.js   │                   ▼
│                      │      │  note.js     │       ┌───────────────────────┐
│ Native desktop       │─────▶│              │       │  The customer's       │
│  detects, captures   │      │  zero deps   │       │  bucket               │
│  system audio + mic  │      │  JSDoc ESM   │       │  the folder they chose│
│                      │      │              │       │  plain Markdown       │
│ Apple Watch          │─────▶│              │       └───────────┬───────────┘
│  start/pause/end/    │      └──────────────┘                   │
│  flag — never records│                                         │
└──────────────────────┘      ┌──────────────┐                   ▼
                              │ Control plane│       ┌───────────────────────┐
                              │ (Convex)     │       │ Every AI client they  │
                              │ accounts,    │       │ already connected —   │
                              │ workspaces,  │       │ the meeting is in     │
                              │ bindings,    │       │ their context with no │
                              │ grants,audit │       │ integration to build  │
                              │ METADATA ONLY│       └───────────────────────┘
                              └──────────────┘
```

## The four capture surfaces

**iOS and Android** — the notepad. The human types while the microphone runs;
nothing on the screen moves under their cursor while transcription happens
behind it. It holds an event log locally, queues when offline, and replays on
reconnect, which is why every `MeetingEvent` in the contract is idempotent or
additive. It owns the Live Activity, and through Smart Stack mirroring that is
also the watch's mid-meeting surface ([watch-companion](./watch-companion.md)).

Platform reality, and it is a hard limit rather than a to-do: **neither phone OS
lets a third-party app capture another app's call audio.** On iOS there is no
cross-app audio capture for this purpose at all; on Android, playback capture is
restricted to media-usage audio from apps that opted in, which conferencing
audio is not. The phone therefore records **the room** — in-person meetings,
where it is the best tool anyone has — and a call taken on the phone is captured
as one microphone in one room, honestly labelled as such.

**Desktop web** — the same Expo build, in a browser. Typed notes, meeting list,
review and re-run of the summary. No system audio, because a browser tab cannot
have it. This surface is not a degraded recorder; it is the reading and writing
surface, and it is where most people will actually re-read a meeting.

**Native desktop** — the one that earns the product. It watches for a meeting
(see *detection* below), asks before it records, and captures system audio and
the microphone **locally**. It joins nothing: no bot, no participant, no
credentials to a conferencing platform. Audio is captured and transcribed on the
machine or streamed to the transcription service for the paid tier, and in
neither case is it stored.

**Apple Watch** — five verbs and a state snapshot. Never a recorder.

## The contract: `packages/meetings`

Zero dependencies, plain ESM with JSDoc types, so the Workers bundle, Metro and
a desktop build all import it unchanged — the gateway's dependency-free rule is
not negotiable and this package lives inside it.

- **`protocol.js`** — the only file that says what a meeting *is*: session shape,
  `MEETING_TRANSITIONS`, the event union, session-id format, the gateway routes,
  the error codes, the detection input types, `WatchCommand` / `WatchState`.
  It exists so that a change to the meaning of a meeting is one diff every
  surface has to agree to, rather than four drifting implementations.
- **`session.js`** — `applyEvent`, the reducer. One place decides whether a
  transition is legal, and it refuses rather than guessing. The same reducer
  serves a button in the app, a command from the watch, and a replayed log from
  a client that was offline.
- **`detect.js`** — pure functions over `DetectionSignals` with hysteresis
  (`DETECTOR_THRESHOLDS`). The platform code collects evidence; this file makes
  every judgement, so the rules are testable without holding a meeting and give
  the same answer on every platform.
- **`note.js`** — the Markdown a meeting becomes, and the bucket path it lands
  at. One file per meeting, `## Summary` / `## My notes` / `## Transcript`.

Everything above is deliberately free of I/O. Nothing in this package opens a
socket, reads a file, or knows what a bucket is.

## The gateway

`apps/mcp` gains the meeting routes from `ROUTES`, and nothing about how it
already works changes:

- **The grant decides.** A meeting write is a write to the caller's workspace,
  authorised by the same grant machinery as any other write; a session id that
  belongs to another workspace is `meeting_forbidden` and is indistinguishable
  from one that never existed.
- **Writes are conflict-safe.** Reads return a version, writes pass it back;
  a lost conditional put is `meeting_conflict` and the client re-reads and
  retries. Where the customer's provider does not support conditional writes
  reliably, the gateway degrades honestly rather than silently.
- **Ingestion is idempotent end to end.** Same session upserts, same segment id
  replaces, finalize on a complete session returns the note path it already
  wrote.
- **The audit trail records the acting identity**, and it records paths and
  allow-listed details — never note content, never a transcript fragment.
- **`list_meetings` and `read_meeting` are ordinary MCP tools** over ordinary
  notes, filtered by the same privacy engine as everything else.

## The customer's bucket

`<folder>/2026/09/2026-09-05-<slug>-<suffix>.md`, one file, plain Markdown, in
the folders their vault already uses. `<folder>` is `0-inbox/meetings` by
default and is **whatever the person recording chose**: the destination sheet
asks before the microphone opens and the finalize carries the answer
([meetings](../decisions/meetings.md), *A meeting lands at an ordinary path*).
Nothing namespaced, nothing to migrate, nothing that only our reader can open.
Obsidian opens it, `rclone` copies it, and every AI client they have connected
reads it through the endpoint they already added — with one limit worth knowing:
`list_meetings` reads the default folder, so a meeting filed elsewhere is
reached like any other note rather than through that tool, and the tool says so
in its own description. Revoke our credential and the meetings are still there.

## The control plane

Accounts, workspaces, storage bindings, OAuth clients and grants, audit events.
A meeting adds **nothing** to that list. There is no meetings table, no
transcript column, no "recent meetings" cache in Convex. Recent-meeting lists
are derived from the bucket the way search is derived from files.

---

## The open question: where an in-flight session lives

State it plainly, because it is the first thing the gateway work has to settle
and everything else here is already decided.

A meeting is forty minutes long. For those forty minutes there is a growing
transcript that is not yet a note. **A transcript is note content**, so the
control plane cannot hold it — non-negotiable 1 is not a guideline. But a
session in flight is also not a file yet, and writing it as one has its own
costs. Four candidates, with what each buys and what it costs:

**(a) The client holds everything; the gateway sees nothing until finalize.**
Cleanest against the non-negotiable: no in-flight content anywhere but the
device that captured it. Costs: the `segments` route in the contract has almost
nothing to do — it becomes one large upload at the end rather than a stream;
cross-device stops working (the watch mirrors the phone's own state, fine, but a
session started on the desktop cannot be ended from the phone); and a crash or a
lost laptop loses forty minutes with nothing recoverable anywhere.

**(b) A durable per-session object in the gateway, discarded at finalize.**
On Cloudflare this is the natural shape: one object per session id, holding the
event log, flushed into the bucket and deleted when the meeting ends. Buys
streaming ingestion, multi-device, and recovery from a dead client. Costs: for
those forty minutes, note content is durably held on infrastructure we operate.
That is a **different claim** from the one the product makes today — the gateway
handles note content on every single write, but it *transits* it; storing it,
even briefly, is storage. It needs an explicit TTL, an explicit promise that
nothing survives finalize, encryption at rest, and it needs to be said out loud
in the privacy copy rather than discovered by a customer reading the source.

**(c) Append into the customer's bucket as it goes.** The note grows in place;
the transcript accumulates under its heading. The invariant holds absolutely:
content only ever exists on the device and in storage the customer owns. Costs:
many small conditional writes against a provider that may not support them
reliably (B2 and Wasabi, per the engineering standards); Obsidian sync churn on
a file that changes every few seconds; a half-written note visible to every
connected agent mid-meeting, which is a surprising thing to find in a search
result; and a failed meeting leaves a partial note rather than nothing.

**(d) Hybrid: the client is authoritative, the gateway keeps a bounded
write-behind buffer** used only to serve the surfaces that need to see a session
they did not capture, flushed and dropped at finalize. This is (b) with a
smaller blast radius and a harder-to-state promise.

**What decides it is not a technical preference.** It is whether a durable
per-session object in the gateway counts, for the purposes of the promise this
company makes, as *us holding the customer's data*. The reading that favours (b)
is that the non-negotiable names the **control plane** and the gateway already
decrypts credentials and streams Markdown on every write. The reading that
favours (a) or (c) is that "transits" and "stores for forty minutes" are
different words in every privacy policy ever written, and the product's entire
claim is that it is the kind of company that notices the difference.

That is the owner's call, not an implementation detail to be settled by whoever
writes the route first. Until it is made, build (a): it is the only option that
cannot become the wrong answer, the contract already supports it — a client
replaying its log on reconnect is exactly this shape — and the routes stay
identical either way, because idempotent ingestion means a client that uploads
everything at the end and a client that streams are the same client with a
different flush interval.

## Detection, in one paragraph, because it lives in two places at once

The desktop app polls every `DETECTOR_THRESHOLDS.pollMs` and hands
`detect.js` a `DetectionSignals` object: process names, window titles and browser
URLs, whether another app holds the microphone, and calendar events near now
(from `calendarLeadMs` before the start to `calendarTrailMs` after the end).
`detect.js` returns a `DetectionResult` with a confidence, a source, a
`suggestedTitle`, suggested attendees, and a `reason` in words. The app shows a
prompt with the reason and a "not now"; it does not start recording on its own.
The judgement is in the shared package so that all three platforms answer the
same evidence the same way, and so that a wrong guess can be explained rather
than argued about.
