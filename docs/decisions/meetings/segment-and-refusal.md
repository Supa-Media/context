# Meetings — segment ids and refusal

## A segment id names its own meeting, and both sides check it

A recorder derives every segment id from the session it was minted for —
`segmentId(sessionId, index)` in the desktop transcriber, and
`chunkIdFor(`${sessionId}-${channel}`, n)` through `segmentIdFor` on the cloud
path. That was done so a re-send merges rather than doubling a transcript, and
it has a second property nobody was reading: **the id says whose words these
are, independently of the envelope carrying them.**

The evening that made that matter: `MeetingsController.listenToRecorder`
subscribed a fresh `onSegment` handler on every `start()` and discarded the
unsubscribe the recorder returned, and the recorder outlives a meeting on
purpose (`retainedRecorder`). So the handlers accumulated — one per meeting ever
started in the process, each closing over its own `meetingId` — and every
segment of the meeting being recorded now was folded into the projection of
every meeting recorded before it. Eight of the owner's meetings ended the night
with a `segments` write full of a *later* meeting's transcript, addressed
correctly, by a sync layer that had no way to know. Each was refused 400 and
parked, and the refusal said `gateway answered 400` and nothing else.

**The refusal was a coincidence, not a defence.** `appendSegments` refuses a
batch on a `complete` session because that meeting is a note now; every stale
session that night happened to be complete. A stale id pointing at a session
still *open* — two meetings close together, a finalize that had not drained
because the laptop was offline — would have been accepted, and one meeting's
words would have been rendered into another meeting's note in the customer's
bucket. Nothing downstream could have caught it: by the time a segment is a turn
under `## Transcript` there is no id left to check.

So the rule is: **a segment whose id names a meeting other than the session it
is being written to is refused, on both sides, loudly and by name.**

- `segmentSessionId` and `foreignSegmentSessions` in
  `packages/meetings/src/protocol.js` are the one implementation of "which
  meeting does this id name".
- The gateway refuses at both doors — `appendSegments` and the replay path in
  `foldLog` — with `meeting_invalid` naming the meetings involved and nothing
  of the text.
- The clients refuse before enqueueing: `queueWrite` in the desktop's outbox
  strips foreign rows (in the reducer, so no enqueue can skip it), and the
  mobile controller's `apply` drops a misaddressed event and logs the two ids.
- `applyMeetingEvent`'s `segment` and `segments` cases now consult the session
  state like their neighbours, so a `complete` projection refuses transcript
  whatever sends it — which is what stops a client queueing a write its own
  gateway will refuse.

**An id that names no meeting is accepted.** The phone's recorders key their
chunks on `String(Date.now())`, so their ids name nothing, and a client this
contract has not met is in the same position. Unaddressed is not misaddressed. A
guard on somebody's transcript may only fail in the direction of accepting what
it cannot prove wrong; the alternative is a gateway that silently stops taking
words the day a recorder changes how it mints ids.

**The whole batch is refused, not the offending rows.** `countUnusable`'s "store
forty-nine of fifty" is right for a row the merge cannot read and wrong here: a
batch with somebody else's words in it was addressed by something that does not
know whose words it is holding, and the rest of it is no more trustworthy than
the part that gave it away.

**What a "simplification" of this costs.** Dropping the check leaves the
correctness of every transcript resting on every client keeping its
subscriptions straight, forever, with the only symptom of a mistake being a
refusal about *state* — which is what sent three people down three wrong
diagnoses before anybody read a segment id. Accepting segments on a `complete`
session, which was the tempting fix while this looked like a late transcription
tail, would have turned the same defect into cross-meeting contamination in the
bucket.

**The tests that fail if it is reversed:** in
`apps/mcp/test/meetings.test.mjs`, post a batch whose ids carry another
meeting's id to an **open** session and expect 400; in
`apps/mobile/__tests__/meetingsController.test.ts`, start a meeting, end it,
start a second, emit one segment and expect the first meeting's transcript to
be empty and the recorder to hold exactly one subscriber; in
`apps/desktop/test/outbox.test.mjs`, queue a foreign batch and expect nothing
of it stored.

## The phone had one barrier where the desktop has four, and both halves are named

An adversarial review of the section above named an asymmetry the section
itself did not: contamination is *impossible* on the desktop path — the
gateway door at the bottom of it is one no client can talk past — and was
merely *prevented, and not independently guarded,* on the phone's. Two
separate reasons, and they get two separate answers.

### Reason one: a phone chunk id named no meeting, so the identity check waved it through

`capture/audio.ts` and `capture/audio.web.ts` keyed every chunk on
`sessionKey = String(Date.now())`. That id is stable across a re-send of the
same chunk — which is all `chunkIdFor`'s own idempotency test ever checked —
but it names no meeting, so `segmentSessionId` read every phone segment as
**unaddressed**, and `foreignSegmentSessions` built on it could never answer
anything but "nothing foreign here", whatever the segment actually was. That
is not a smaller guarantee than the desktop's check; it is the same check with
nothing for it to check. Three places lean on that function and all three were
therefore inert on this path, silently, for exactly the reason a wrong
envelope defeated them on the desktop: the check only catches what an id
*says*, and a phone id said nothing.

- `apps/mcp/src/meetings/state.js`'s `assertSegmentsAddressed` — the gateway
  door — never had a phone id to refuse, because this app's meetings never
  reach it at all (reason two, below).
- `apps/mobile/features/meetings/controller.ts`'s `apply` — the mobile
  controller's own mirror of the same check, added in the same change that
  fixed the desktop's leaked subscription — was live in the sense that it ran,
  and inert in the sense that a phone id could never fail it: unaddressed is
  accepted by design, and every phone id was unaddressed.
- `apps/mobile/features/meetings/convexGateway.ts`'s finalize path had no
  check at all until this change (see reason two).

**Fixed by minting the id the same deterministic way the desktop already
does.** `capture/audio.ts` and `capture/audio.web.ts` now take the meeting id
from `CaptureOptions.sessionId` — the controller's own `newMeetingId()`,
already threaded through every `recorder.start()` call — and build every
chunk id as `${meetingId}-${index}` through the same `chunkIdFor` the desktop
calls with its own session id. `segmentSessionId` now reads a phone segment's
own meeting back out of it, so `foreignSegmentSessions` is live on `apply`
exactly where it was inert, and would be live at the gateway door too on any
future path that reached it.

**A missing id is refused rather than answered with a clock reading.** Both
recorders throw before opening the microphone if `CaptureOptions.sessionId` is
absent — `desktop.ts`'s own `requireSessionId`, restated in each — because a
generated fallback here is exactly how this guard goes back to being inert,
quietly, the day some caller forgets to pass it. `controller.ts` always does;
a caller that does not has a bug, and it is loud on the first press rather
than found in the next contamination review.

**What happens to a segment already stored under a timestamp-shaped id.**
Nothing, and that is the safe answer rather than an oversight. `chunkId`
minted before this change is not rewritten by it — an id is fixed the moment a
chunk is minted, and nothing here revisits a chunk after the fact — so it
stays exactly the shape `foreignSegmentSessions` already treats as
**unaddressed, never misaddressed**: a client this contract has not met names
none either, and the two are answered identically on purpose (see the
section above). A device mid-recording when this ships keeps minting from
whatever `sessionKey` its already-running capture opened with, which does not
change until the next `start()`; the meeting after that mints addressed ids
from its first chunk. A batch mixing old-shaped and new-shaped ids for the
*same* meeting merges by id exactly as it always has and is refused by nothing
new — the guard only ever fails in the direction of accepting what it cannot
prove wrong, and an old id proves nothing wrong about itself. There is no
migration to run and nothing to backfill: the fix changes what a client mints
from here on, not what a contract remembers about a chunk already sent.

### Reason two: the phone's note write passes no gateway door at all

The desktop's fourth barrier is `apps/mcp`'s `appendSegments` and `foldLog` —
a door no client can talk past, because the gateway is the only party that can
put a note in the customer's bucket on that path. The phone has no such door.
`convexGateway.ts`'s own header already says why: this app holds a
control-plane session, not an MCP grant, so `finalize` renders the transcript
itself and writes it with `files.writeNote` — the same generic action every
note save uses, which has never heard of a meeting and could not refuse one on
its own terms if it wanted to.

**Two ways to close that, one of them a larger change than this one.**

- **Route the phone's transcript through the same door the desktop uses.**
  That means the phone acquiring an MCP grant — the OAuth client registration
  flow `packages/hook` ships and the desktop already runs — instead of, or
  alongside, its control-plane session. *The desktop is an OAuth client of the
  gateway, and it asks for the tier its meetings are filed at* (above) argues
  at length for why that credential shape is not one to hand a phone lightly:
  a control-plane session already reaches every context its owner is a member
  of, and a phone able to *also* mint a narrower, revocable grant is two
  credentials doing one job with no clean story for which one a given
  request used, which is exactly the two-credentials defect
  `docs/decisions/desktop.md` had to close for the *desktop* shell before its
  own meetings could be trusted. Building that story correctly for the phone —
  deciding whether it replaces the control-plane path, when it is minted, how
  it is revoked independently, what a phone with no grant yet does with a
  meeting it already recorded — is a real project, not a guard, and this
  document says so plainly rather than reaching for a shortcut that repeats a
  mistake this repository has already paid to fix once.
- **Add the identity check where the phone actually writes.** Chosen. It is
  not the gateway's guard — nothing stops a rebuilt client from skipping a
  function call the way nothing stops it from skipping any other client-side
  check — but it is the strongest one available without the change above, and
  it closes the gap the leaked-subscription bug actually demonstrated: a
  transcript built from foreign words by an honest client with a bug in it,
  not a hostile client rewritten to lie.

**What was built.** `convexGateway.ts`'s `finalize` now calls
`assertOwnTranscript` before it renders or writes anything:
`foreignSegmentSessions(session.id, session.transcript)`, the same function
the gateway and the controller's own `apply` already use, run once more
against the *whole* transcript at the last moment before it becomes a note.
`apply` already keeps a foreign segment out of `session.transcript` on the way
in (reason one, now live); this is what catches one that reached
`session.transcript` some other way — a record restored from disk, a future
code path that folds a segment without going through `apply`. A transcript
that fails it is refused with `meeting_invalid` and nothing is written; the
refusal names no meeting and quotes no word of the transcript, the same
restraint `assertSegmentsAddressed` and `apply` already hold to.

**Stated exactly, because a reader should not have to infer it from the
fix's shape:** contamination on the phone path is now **prevented by two
independent guards** — the identity check on the way a segment is folded in
(now live, per reason one) and the identity check on the way the transcript
is written out — where the desktop has four, one of which is a boundary no
client can cross. It is **not impossible** on the phone the way it is on the
desktop, and the difference is *who* enforces each guard. `appendSegments` on
the gateway is enforced by a party other than the client making the
request — the customer's own credential reaches a Worker this repository
operates, and no rewrite of the client's own code changes what that Worker
checks before it writes. Both of the phone's guards, `apply`'s and
`assertOwnTranscript`'s, are enforced by the same binary that is asking to be
trusted: a build of this app that dropped either call would still hold a
valid session, `files.writeNote` would still take whatever it was handed, and
nothing on the far end would know a check was ever supposed to run. That is
the honest cost of not making the larger change above, named here rather than
left for the next adversarial review to find.

**The checks are** `a chunk's id names the meeting it was recorded for, and
only that one` (`apps/mobile/__tests__/meetingsCapture.test.ts` and its
`meetingsCaptureWeb.test.ts` sibling), `a recorder given no meeting id refuses
to start, rather than inventing one` (same two files), `a transcript carrying
another meeting's words is refused, not written` and `a transcript whose ids
name no meeting at all is not contamination`
(`apps/mobile/__tests__/meetingsConvexWriter.test.ts`).

## The count is a kind, not a number, and every one of these guards reads an id

A post-merge adversarial review of the section above accepted its argument and
corrected two of its sentences. Both corrections are about the same thing:
what these guards are actually made of.

### Three client-side barriers on the phone, not two, and that is not the point

The section above counts **two** for the phone against the desktop's four. On
like-for-like terms it is three, because the desktop's four include one the
phone has had all along: `applyMeetingEvent`'s `acceptsTranscript` check, which
refuses transcript folded into a terminal session whatever sends it, is one of
the four *A segment id names its own meeting* lists, and it is in
`features/meetings/session.ts` — the phone's own reducer. So the phone has
`acceptsTranscript`, `apply`'s identity check and `assertOwnTranscript`, and
the desktop has those three plus `queueWrite`'s strip in the shell's outbox and
the gateway's `assertSegmentsAddressed`.

Counting it correctly makes the real asymmetry easier to see rather than
harder, which is why it is worth correcting: **the difference between the two
paths was never the count.** Every guard on the phone's list is enforced by the
binary asking to be trusted. Exactly one guard on the desktop's list is not.
Adding a fourth and a fifth client-side check to the phone would not move it
one step toward the desktop's position, and the section above is right that the
only thing that would is the OAuth-grant project it declines. A number invites
the reading that the gap is three guards wide; it is one *kind* wide.

### An id that says nothing is accepted at every door, the gateway's included

`segmentSessionId` answers `null` for an id whose first token is not a meeting
id, and every check built on it — `apply`, `assertOwnTranscript`,
`queueWrite`, and `assertSegmentsAddressed` at the gateway — treats `null` as
*addressed correctly*. That is deliberate and argued above. What follows from
it, and is not said above, is that **a client is not stopped by any of these
guards if it simply stops naming meetings in its ids.** It does not need to lie
about whose words it is holding; it only needs to stop saying. The desktop's
gateway door refuses the same batch a client sends with a foreign name on it,
and accepts it with no name on it.

So *"a boundary no client can talk past"* is exact about **misaddressed** words
and not about **unaddressed** ones, and "contamination is impossible on the
desktop path" should be read as: impossible for a client that names its
meetings at all. Every client in this repository does, and the guard is what
catches the bug this repository has actually had — a leaked subscription
inside an honest client, which goes on minting correct ids while routing them
to the wrong session. Against a client rewritten to lie the guard was never the
defence, and against one rewritten to say nothing it is not either.

**And the acceptance stays.** The tempting narrowing is to refuse an
unaddressed transcript once a client is known to address its ids — by the
record's own version, or by refusing a transcript that mixes addressed and
unaddressed rows. Neither is worth what it costs:

- The marker that would separate genuinely old data from a client that stopped
  addressing has to be written by the same binary whose honesty is in question.
  A build that drops `assertOwnTranscript` drops a version stamp just as
  easily, so it buys nothing at all against the case it is aimed at.
- Against the case that is *not* aimed at — an honest client whose transcriber
  stops deriving segment ids from the chunk id, which is a change somebody
  could make in `capture/transcriber.ts` without ever thinking about meetings
  — it would refuse to write real meetings that are nobody's but their own.
  That is a refusal in the one direction this contract says a guard on a
  transcript may not fail in: *refuse what is provably somebody else's, wave
  through what you cannot know*.

The narrowing that would genuinely close it is the one already named and
declined: a party other than the client deciding what a meeting's words are.
Until that exists, "prevented, not impossible" is the honest description of the
phone — and of the desktop too, one degree further out.

### One device records one meeting, said out loud

The same review found the one place the phone's new ids changed a silent
failure into a different silent failure. `MeetingsListScreen` hides its record
button while a meeting is live; the console's own Record key
(`ConsoleBottomBar`, in `app/(app)/console/_layout.tsx`) is drawn whether or
not one is, so `controller.start()` really can be called for a second meeting
while the first is still recording. Both phone recorders answered that by
returning silently — right for the *same* meeting twice, since a double press
is one start — and went on minting chunk ids for the meeting they opened with.
Before the ids named a meeting that was contamination with no name on it: the
first meeting's audio landed in the second meeting's transcript, at the first
meeting's offsets. Now that they name one, `apply` refuses every one of those
segments, correctly, and the second meeting records **nothing at all** and says
nothing about it.

So the recorder refuses instead: a `start()` for a meeting other than the one
it is recording throws `ALREADY_RECORDING`, which `controller.start` already
handles the way it handles a denied microphone — the session stays, the notepad
keeps working, and the sentence goes on the live screen. A `start()` for the
meeting already running is still one start, unchanged. The recorder is the only
place that knows both meetings' names, which is why the guard is there rather
than in the screen that drew the button; a screen that also stopped offering it
would be an improvement to the same situation and not a substitute for this.

### A refusal is a sentence somebody's log file keeps

The same review looked again at `describeEventType`, added above to stop
`foldLog` echoing an unrecognised `event.type` back unbounded. The bound was on
the length and not on the shape, and the reason the bound exists is that this
sentence is written to a customer's log by `apps/desktop` as the *tail of one
line*: `meeting_write_refused session=… kind=… status=… code=…: <sentence>`. A
newline forges a second line in that file in one character, and an escape
sequence rewrites the line already printed in four — neither of which forty
characters is any defence against.

So the shape is checked before the length: an event type in this contract is an
identifier, so one that is not is described (`non-identifier`) rather than
quoted, and one that is keeps being named and truncated as before, because
naming it is the one thing a client author can act on. This is
`assertSafeEtag`'s rule in `src/store/index.js` — a value about to be
interpolated into a line with structure gets its charset checked, not its
length — applied to the one refusal in this file that carries a client's own
text.

**The checks are** `a second meeting is refused rather than recorded under the
first one's name` and `...and starting the meeting that is already running is
still a no-op` (`apps/mobile/__tests__/meetingsCapture.test.ts` and its
`meetingsCaptureWeb.test.ts` sibling), `acceptsTranscript reads the table,
rather than agreeing with today's copy of it`
(`apps/mobile/__tests__/meetingsSession.test.ts` — the zero-failure sabotage
row above, made to fail), `the terminal states ingest.js names by hand are
exactly the table's own` and `an event type carrying a newline is described
rather than echoed into a log line` (`apps/mcp/test/meetings.test.mjs`).

## A refusal is shown with the reason the gateway gave for it

`postEntry` read a `message` field off an error body. The gateway's meeting
routes answer `{error, error_description}` and have never sent `message`, so
for the whole life of the desktop app every refusal — in the tray, in the
console, in the queue file on disk — read `gateway answered 400`. The sentence
explaining it was on the wire, parsed, and thrown away one line from where it
was needed, and eight parked meetings were eventually diagnosed by reading a
JSON file off somebody's laptop.

Three things follow, and each is a rule rather than a fix:

- **The client reads the field the gateway sends**, keeps the status in the
  sentence (so a captive portal's reply is still tellable apart from a refusal
  this gateway composed), and carries the status as a number for a log line.
- **A drain reports its refusals** (`DrainReport.refusals`) and the shell logs
  each one: session id, kind, status, contract code and the gateway's own
  sentence — never a segment, a note, a title or the credential. The queue
  entry's `lastError` is the right place for a *person* to read it and the
  wrong place for anybody to find it, because an entry that is later accepted
  takes its own explanation with it.
- **No screen shows a person an HTTP status.** `rejectionNotice` maps the codes
  whose recovery is something a person does, and falls back to the gateway's
  own words — deliberately, because a refusal this app has never seen before is
  exactly the one worth quoting.

**And a refusal never un-says a note that landed.** The meeting detail page
checked `record.rejection` before `session.notePath`, so one refused *later*
write made a meeting whose note had been in the bucket for ten minutes read
"This meeting has not left the device — gateway answered 400". Two contradictory
claims about one meeting, and the newer one was the false one. The path decides
which sentence is true; a refusal is said underneath it, and content still
waiting on the device is said underneath that. **The test that fails if this is
reversed** is `A REFUSAL AFTER THE NOTE LANDED DOES NOT UN-SAY THE PATH` in
`apps/mobile/__tests__/meetingsScreens.test.ts`.

### The folder is a setting; the question is not

Mail, calendars and Chat each carry an editable destination per connection.
A meeting carried `MEETINGS_FOLDER` — a constant — interpolated into a
paragraph on the settings panel, with no control beside it and no setter
anywhere in the codebase. Somebody who files meetings under `2-areas/meetings`
had to move every note by hand, forever.

The panel's own docstring defended that absence, and the argument it used was
right about something else: the destination is **asked for every time, before
the microphone opens, precisely so that no remembered setting can answer it
silently**. That is a rule about *which context* a meeting lands in, and it is
untouched — the first offer is still always the person's own workspace, the page
they are standing on is still offered second with its audience named, and the
sheet still opens. What was neither asked nor settable is *which folder the
first offer points at*. Two decisions; conflating them is why the setting did
not exist for as long as it did.

So `workspaces.meetingsFolder` is optional, `setMeetingsFolder` is owner-only
and personal-only (only the personal-inbox offer reads it, so on a shared
workspace it would be a control with no effect), and the value rides to the
sheet on `DestinationContext` — where it belongs, because `ownPersonalContext`
already finds the one context the setting is about, and a parallel argument
would be a second thing every caller has to keep pointed at the same row.

Three things hold it honest:

- **The validator is the gateway's own.** `setMeetingsFolder` runs
  `normalizeMeetingFolder`, the same function that decides whether a folder a
  client asked for is one the write will accept. Validating any other way would
  let somebody save a folder the gateway then refuses — a setting that appears
  to work and files somewhere else, which is verbatim the defect
  `features/meetings/destination.ts` exists to prevent, arriving through
  settings instead of through a request.
- **A stored folder this build would not file into is treated as absent.**
  `inboxFolderOf` falls back to `INBOX_FOLDER` rather than offering it. An
  offer with no `refusal` on it is a promise, and a row written by a newer
  control plane — or one predating a rule this bundle ships — must not produce
  a destination whose write is rejected. The phone cannot import
  `packages/meetings`, so the check is `fileableFolder`, the restatement this
  module already keeps, and the agreement test is what holds the two together.
- **Clearing stores nothing, not the default's spelling.** A stored
  `0-inbox/meetings` would stop following the default if it ever moved, pinning
  somebody who never expressed a preference to a decision they did not make.

**What a "simplification" would cost**: honouring the stored value without the
fileable check turns a settings typo into meetings that never land, with the
failure surfacing at the write rather than at the field. Dropping the
personal-only gate puts a control on a workspace that nothing reads. Letting
the setting answer *which context* — rather than which folder — drops a
transcript of a conversation somebody has not read yet into a bucket their
colleagues are watching, which is the one thing this whole seam was built to
stop.

**The tests that fail if any of it is reversed**: `where the first offer points
is the workspace's own setting` in `apps/mobile/__tests__/meetingsDestination.test.ts`
(seven checks, including every folder the real `normalizeMeetingFolder`
refuses), `apps/convex/__tests__/meetingsFolder.test.ts`, and
`apps/mobile/__tests__/meetingsFolderPanel.test.ts` for the panel's own gating.
