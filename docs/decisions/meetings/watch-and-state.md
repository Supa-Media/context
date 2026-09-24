# Meetings — watch and state

### The watch is a remote control, never a recorder

Five verbs — `start`, `end`, `pause`, `resume`, `flag` — and one small state
snapshot back. No audio, no transcript, no note content crosses to the wrist.

The verb is `end` rather than `stop` because `MeetingEvent` already calls that
transition `end`, and two words for one transition across a boundary is the
drift the contract exists to prevent. The wrist may still *say* "Stop" to its
wearer; a label is not a protocol.

This is not a scoping decision to be revisited when the hardware improves. The
watch microphone is a wrist-height microphone in a room, the battery does not
survive a forty-minute capture, the transport between watch and phone is
intermittent by design, and Apple's on-device transcription stack is available
on every platform they ship *except* watchOS. A watch that recorded would
produce a worse transcript, at a battery cost the wearer notices, over a link
that drops — and it would need somewhere to put a transcript on a device with no
room for one.

What the wrist is genuinely good at is the thing the phone is bad at: being
reachable without being taken out. Starting before a call, ending one from the
corridor, and marking a moment mid-sentence without breaking eye contact.
`flag` is the verb that only exists because of the wrist, and it is the reason
`WatchState.flags` is a count rather than a list — the wearer needs to know the
press registered, not to read back what they flagged.

**A flag has to reach the note, and its timestamp is taken on the wrist.** The
count was all there was for a while: `WatchCommand` had the verb, `WatchState`
had the number, and there was no `flag` event and no field on the session, so a
press could not reach the note it was pressed for. It is now a `MeetingFlag` —
`at`, and an optional label bounded by `WATCH_FLAG_LABEL_MAX` — folded by the
reducer and rendered by `note.js` as a `> [!flag]` callout beside the turn it
belongs to.

`at` is **milliseconds from the start of the session, computed at press time**,
and that is the whole decision rather than a detail. The transport between a
watch and a phone is intermittent by design, so a queued command drains late;
timestamping on arrival is a minute of drift, and a minute of drift puts the
mark on the wrong sentence — which is the only thing a flag has to get right.
Deduping on `at` is what keeps a replayed log from doubling a press. The checks
are `a flag lands after the turn it was pressed during`,
`the same press folded twice is one flag`, and
`a meeting with flags and no transcript writes the flags`.

The two properties worth holding: **the phone is the authority** — a command is
a request the phone's state machine may refuse per `MEETING_TRANSITIONS`, never
a state change the watch performs — and **`reachable` is a first-class field**,
because a watch that cannot reach the phone must show that rather than showing a
stale timer that looks live. The phone being the authority is why every command
about an existing session **names it**: a watch shows the session it last heard
about, the link drops, the phone starts a second meeting, and the pause pressed
on a stale face would otherwise land on a meeting nobody is looking at. The
checks are `a watch command carries no audio and no transcript` and
`an illegal watch command is refused rather than applied`.

The staged plan, and what a watchOS target actually costs from this Expo app,
is in [watch-companion](../../meetings/watch-companion.md).

### Detection judgement is a pure function, and the desktop app only collects evidence

`DetectionSignals` is deliberately dumb data: process names, window titles and
URLs, whether something else holds the microphone, and the calendar events near
now. The platform-specific code — which is the part that has to be written three
times, in three languages, against three sets of OS APIs — collects that and
nothing else. Every judgement is made by pure functions in
`packages/meetings/src/detect.js`.

The reason is that detection is the part most likely to be wrong in a way that
matters. A false positive records a doctor's appointment. A false negative loses
the meeting the customer bought this for. A flicker — one poll where a window
title changed — must not start a recording, and a two-second network blip must
not end one, which is what `DETECTOR_THRESHOLDS` and `DetectorState` exist for.

Rules that live in the desktop app can only be tested by holding a meeting.
Rules that are a pure function of a signals object can be tested with a fixture
that never runs, and every platform gets the same answer to the same evidence —
which also means a wrong guess can be *replayed*: `DetectionResult.reason` and
the retained `source.app` / `source.url` exist so "why did it think I was in a
meeting" has an answer better than a shrug.

The checks are `a single-poll flicker never starts a recording`,
`a gap shorter than the threshold never ends one`, and
`the same signals produce the same result on every platform`. The last one is
the one a "small platform-specific tweak" breaks first, so it is written as a
shared fixture suite rather than three parallel tests.

### The state table is the client's, and a move it refuses is a client faking one

`MEETING_TRANSITIONS` is the whole of what a meeting may do, and a reducer that
cannot make a move throws rather than guessing. That makes the table a promise
about clients, and a client that needs a move the table does not have does not
stop needing it — it forges the nearest event that gets there. Three of those
were happening, and each was found by a surface reaching for a lie:

- **`idle -> finalizing`.** A meeting nobody recorded is still a meeting. The
  microphone was refused, or there was never anything to capture, and somebody
  typed for forty minutes. Their words are the half of a meeting that cannot be
  regenerated — the summary can always be re-run, the transcript is gone either
  way — so refusing to write them out until a `start` had been forged was the
  product inventing a recording in order to be allowed to save the notes.
- **`finalizing -> recording`.** A finalize the gateway has not answered yet is
  not a finished meeting; the person is still in the room. The alternative was
  the phone sending itself a `fail` to get back, which writes a failure that
  never happened into the record somebody may later read.
- **`failed -> finalizing`.** A recording that dropped mid-meeting holds a
  partial transcript, and a partial transcript is somebody's meeting. Without
  this move the only exit from `failed` is to record again, so a session that
  cannot record again could never be written out at all.

What a "simplification" costs is the reason the table was tight in the first
place, and it is still right: `complete` stays terminal, nothing returns from
it, and every move that changes state still needs the client's own timestamp so
that replaying a log lands where it landed the first time. That is also why
`fail` now carries an `at` like every other state-changing event — without one
the reducer had to recognise a replayed failure by the *reason* it left behind,
which meant `failureReason` had to survive a restart, which meant a session that
had recovered still said why it once failed. With a timestamp, the reason means
exactly one thing: it is why this session is in `failed`, and it is cleared on
the way out. The same timestamp is what lets a failure close the open recording
span honestly — the audio up to the moment the recorder died is counted, and the
minutes until somebody notices are not.

The checks are `a meeting nobody recorded still finalizes`,
`a failed recording can be written out with what it captured`,
`a finalize that has not landed can be taken back to recording`, and
`a fail with no timestamp is refused, like every other state-changing event`.

### `written` is the gateway's word, and a client may never say it

Every other event in the contract is something a client observed. `written` is
not: it says a note exists in the customer's bucket, and the only party that can
know that is the one that wrote it.

A client able to send it could move its own session to `complete` with a
`notePath` pointing at nothing. The meeting would then be, to every surface that
looks, a finished meeting — off the device's "still here" list, out of the sync
queue, drawn as saved — and the recording would be gone in silence. That is the
one outcome this feature exists to prevent, and it is worth more than the tidiness
of a symmetrical event list.

So the union names it as the gateway's, `CLIENT_EVENT_TYPES` is exported from the
contract as the list of everything else, and the gateway checks against *that*
list rather than a copy of its own. A copy is how the rule gets relaxed by
somebody adding an event next year. The check is
`a client cannot send the event that says a note was written`, and it is
sabotage-tested: allow `written` through and two checks fail, one of them the
forged completion of a meeting whose note was never written.

### A meeting route is a reserved name, not somebody's handle

`/meetings/sessions` is where every recorder posts. Usernames and workspace
slugs are the first path segment on the same gateway, so until `meetings` joined
the reserved list, that path parsed as "the context called meetings, at the path
`/sessions`" — and the gateway defended itself by lifting meeting paths out of
the workspace selector before it ran.

That defended the route and left the hole. **The name was still claimable**, and
a name in this namespace is also a mailbox on the apex
([identity-and-access](../identity-and-access.md), *Ingestion is on the apex,
which makes the reserved-name list a security control*): whoever registered
`meetings` would have held `meetings@` the company's own domain, and every
device in the product would have appeared to be addressing their handle. The
route-shaped half is not academic either — a context genuinely called `meetings`
is a context nobody can address by name.

So the segment is reserved in the gateway's own list, reserved in the control
plane's `RESERVED_NAMES`, and the workaround is gone: one rule, enforced where
names are handed out, rather than one route holding a door shut by itself. The
control plane's test reads the gateway's list out of its own source, so a route
added next year fails on the day it is added rather than on the day somebody
claims it. The checks are `a meeting path names no workspace, whatever anybody
registered`, `reserves every gateway route a name could otherwise be`, and
`a workspace registered as `meetings` does not take the ingestion route`.

### An ack says whether the write was conflict-safe, because some buckets are not

Reads return a version and writes pass it back — except that Backblaze B2 and
Wasabi accept `If-Match` and write anyway. The capability is therefore probed
against the actual bucket at connect time and recorded on the binding, and the
rule is that it is **never silently dropped**.

`IngestAck.conflictSafe` is how that rule is kept in front of the client rather
than in a document: every meeting request is answered with whether this
context's bucket can do a conditional write at all. A client on a bucket that
cannot is being written last-writer-wins, and it is told, on every request,
rather than left to assume the guarantee it read about.

The half that made it a lie for a while was one line: the gateway built every
store with the *adapter's* declaration — true, because every adapter sends the
header — and never read the probed answer off the binding. So the ack claimed
conflict safety on exactly the backends that do not have it. The capability is
applied where the store is built, it only ever lowers, and a binding carrying no
probed answer is treated as unproven. The checks are
`a binding whose bucket cannot do a conditional write builds a store that says
that` and `a context on a bucket that ignores If-Match is told so on every ack`.

### Ingestion is idempotent by construction, because losing signal is the normal case

A phone in a basement conference room drops off the network for ten minutes.
This is not an error path; it is Tuesday. So the client keeps its own event log,
replays it on reconnect, and the gateway is built so that replaying is free:

- **The same session id upserts.** Posting session metadata twice is one session.
- **The same segment id replaces.** `TranscriptSegment.id` is client-generated
  and stable, which is why the contract says so in the type's own comment.
  A client that re-sends a whole batch after a timeout it never saw the response
  to must not double the transcript.
- **Finalize on a complete session returns the note path it already wrote.**
  Not a second note, not an error the client will retry forever.

The third one has a trap that is worth naming, because the obvious
implementation walks into it. If the bucket path is derived from the title, and
the human renames the meeting between a failed finalize and its retry, a
title-derived path produces a *second* note and both look correct.

So **the path is composed once and then remembered.** Finalize's first step is a
*claim*: it works out the path, writes it into the session record under a
conditional write, and only then writes the note. Every later finalize —
a retry after a crash, a duplicate from a client that never saw the first
answer, a re-finalize under a new title or a different folder — reads that path
back out of the record and does not compose one. A rename rewrites one note; it
cannot fork one, because after the claim nothing derives a path from anything.

**This paragraph used to say something else, and it was wrong.** It said the
path "carries a stable suffix taken from the session id, and finalize resolves
an existing note **by that suffix** before it composes a new path". The first
half is true — `meetingNotePath` ends the filename with the tail of the session
id — and the second half describes a lookup that does not exist and would be a
worse design: resolving by scanning for a suffix means reading the bucket to
answer a question the record already answers, and it would find a note in the
old folder while the retry named a new one. `unclaimedNotePath` is the only
thing here that looks at an existing key, and its job is the opposite: it
refuses to overwrite a note somebody else's tooling put at the candidate path.

Every `MeetingEvent` in the contract is idempotent or additive for the same
reason: replaying the log must land on the same session.

The checks are `finalizing twice answers with the note that already exists`,
`a phone that lost signal and re-sent duplicates nothing`, and
`a re-finalize with a changed title rewrites one note rather than adding a
second` — the last of which this section cited for a while before it existed,
and which now does: it fails a finalize's note write, renames the meeting, and
asserts the retry lands on the first title's key with no second note in the
bucket.

### The human's words are never rewritten, and the generated half is disposable

`MeetingSession.notes` is what the person typed. `enhanced` is what the model
produced. They are separate fields, they render as separate headings, and the
enhancement pass reads the first and writes the second.

This is the same asymmetry as `index.md` in [gateway-protocol](../gateway-protocol.md):
the generated part can be regenerated, so losing it is never data loss, while
the part only the human can write has no source to rebuild it from. It also
makes "re-run the summary" safe to offer as a one-tap action, which it would not
be if the two shared a heading.

The check is `re-enhancing a meeting leaves the human's notes byte-identical`.
