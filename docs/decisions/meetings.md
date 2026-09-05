# Meetings

_See `docs/decisions/README.md` for the index._

Context records meetings. Not as a separate product with its own account, its own
storage and its own export button, but as a capture surface for the thing this
repository already is: **a meeting becomes plain Markdown in a bucket the
customer owns, and every AI client they have already connected can read it
through the same endpoint, with nothing to integrate.** That sentence is the
entire reason this lives here and not in a new repository. A meeting recorder
that held your meetings would be a competitor to us as much as to anyone else.

The contract every surface agrees to is `packages/meetings/src/protocol.js`.
It is the single source of truth for what a meeting *is*: the session shape, the
state machine, the events, the gateway routes, the detection inputs and the
watch's five verbs. The decisions below are the arguments behind it. Changing
one of them means changing that file, which means changing every client at once
— which is the point of having it.

### One file per meeting, and `read_meeting` is what that costs

A finished meeting is **one note**. The generated summary, the human's own
notes, and the transcript are three headings in one file — `## Summary`,
`## My notes`, `## Transcript` — not two files with a link between them.

The alternative was a sibling `*.transcript.md` with a frontmatter pointer, and
it is genuinely tempting: it keeps the note small, and the expensive half is
only fetched when someone asks for it. It was rejected because a note and its
transcript are one thing to a human and to every tool that is not ours. Two
files means Obsidian shows two entries, search returns both for one query,
moving the note to `1-projects/` orphans the transcript, archiving one archives
half a meeting, and `4-archive/` slowly fills with transcripts whose notes moved
away. Every one of those is a bug report the customer files against *Obsidian*,
because that is where they saw it. The bucket is the vault
([obsidian-plugins](./obsidian-plugins.md)), and a file that only makes sense
to the program that wrote it is exactly what plain-file portability is supposed
to rule out.

**The cost is real and is not hidden here: `read_note` returns whole files.** A
forty-minute transcript is tens of kilobytes, and an agent that opens a meeting
to answer "what did we decide" should not spend a third of its window on
crosstalk. So the mitigation is at the tool boundary rather than in the file
layout:

- **`read_meeting` omits the transcript by default** and returns the frontmatter,
  the summary and the human's notes. It takes `transcript: true` to include it,
  and says in its result that there is one and roughly how big it is, so an
  agent can decide rather than guess.
- **`read_note` on the same path still returns the whole file**, unchanged and
  ungated. `read_meeting` is a convenience over one file, never a second
  visibility rule; a path an agent may not read is refused identically by both.

Reversing the split — making `read_meeting` return everything because "it is
simpler" — puts a transcript into the context of every client that opens a
meeting for any reason. The checks are
`read_meeting omits the transcript unless it is asked for`,
`read_meeting names the transcript it withheld`, and
`read_meeting and read_note refuse the same paths`.

### A meeting note is a note, and `privacy.md` decides it with no bypass

There is no meetings visibility model. A meeting note sits in a folder, the
folder's rule in `privacy.md` applies to it, an exact-note override beats the
folder rule, and `canSee` decides. `list_meetings` is a listing filtered by the
same engine as any other listing, and it is derived from the notes rather than
from a table the gateway keeps — a meeting the caller may not read is not
listed, not counted, and not implied by a gap in a count
([privacy-and-sharing](./privacy-and-sharing.md)).

This is worth stating because a meetings feature is where a bypass would arrive
looking reasonable. The desktop app wants a fast recent-meetings list; the
console wants counts; the mobile app wants a badge. Each is a reason to keep a
meetings index somewhere convenient and read it without going through `canSee`,
and the first one that ships that way makes the privacy engine advisory.

The rule that keeps it honest: **the gateway never learns about a meeting from
anywhere but the bucket.** Session metadata in flight is in-flight state
(see [architecture](../meetings/architecture.md)); a *finished* meeting is a
file, and files are read through the privacy engine, full stop.

The checks are `a private meeting is invisible to a team grant` and
`list_meetings surfaces nothing read_note would refuse`, and the second one is
sabotage-tested: make `list_meetings` read a cached list instead and it must
fail.

### Nothing joins the call

The desktop app captures the system audio the machine is already playing and the
microphone it is already using. It does not authenticate to Zoom, Meet, Teams or
anything else, does not send a participant, and does not appear in the attendee
list. Six people in the meeting see six people.

The bot approach buys things this one cannot have: it records meetings you did
not attend, it survives your laptop going to sleep, and it gets a clean
per-speaker feed from the platform, which is most of why bot-based products have
better diarization than we will. Those are real losses and this document is not
going to pretend otherwise.

What it buys instead is the whole security story. A bot is a third party holding
credentials to the customer's conferencing account, sitting in rooms it was
invited to by an automation rather than by a person, and recording on the
platform's servers before anything of ours touches it. That is a second data
plane, owned by us, in a product whose first non-negotiable is that we do not
hold the customer's data. It is also an integration per platform, each of which
can be revoked by an administrator who never agreed to it.

The check is `no code path authenticates to a conferencing platform`, and it is
a grep-shaped guard with the usual weakness — see
[testing](./testing.md), *a guard nobody has checked is not a guard* — so it is
written against outbound host allowlisting rather than against import names.

### Transcription is cloud on the paid tier and on-device on the free tier, and that seam is disclosed, not glossed

This is the one place where "we never hold your data" needs a footnote, and the
footnote belongs in the product, not only here.

- **Free tier: on-device.** Apple's `SpeechAnalyzer` / `SpeechTranscriber` on
  iOS 26 and macOS 26, WhisperKit elsewhere. Audio never leaves the machine;
  only text is written, and it is written to the customer's own bucket.
- **Paid tier: cloud.** Better punctuation, better handling of distant
  microphones, and diarization that on-device transcription does not provide at
  all. Audio is streamed to a transcription service, is transient there, and is
  never stored by us — but it *does* leave the device, and for the length of the
  request it is in a third party's memory.

The honest statement of the seam, which the marketing copy is not allowed to
soften: **on the paid tier, your meeting audio is processed by a service that is
not you and not us.** What remains true on both tiers is the part that actually
distinguishes this product — the *notes* land in storage you own, we hold no
copy, and revoking our credential leaves you with everything.

Four rules follow, and they are the enforceable part:

1. **Audio is never written to the bucket and never persisted by us.** Not as an
   attachment, not as a cache, not "temporarily" in a queue that has no expiry.
   The note is the artifact; the recording is not. The check is
   `no ingestion path writes an audio content type`.
2. **Every note records how it was made.** `transcription: on-device` or
   `transcription: cloud` in the frontmatter, alongside the device that recorded
   it. A person reading a meeting from eight months ago can tell whether its
   audio ever left their laptop, which is not a question they should have to
   reconstruct from their billing history. The check is
   `a finalized note names the engine that produced it`.

   Four things that follow, because each is a way of writing this key that
   would not keep the promise. **The key is always written**, and a meeting
   nothing transcribed says `transcription: none` — an absent key and an old
   note are the same thing to a reader, so omitting it on the notes-only case
   is the one shape that answers nobody. **`null` is the third legal value and
   is explicit** on `MeetingSession`, never an absent field:
   `TRANSCRIPTION_ENGINES` names the two engines, and "no engine" is the
   absence of a member rather than a member of the list. **An engine nobody
   recognises is refused rather than coerced** — `source.kind` falls back to
   `unknown` and `device.platform` to `web` because those are a detector's
   evidence, while this field has no honest fallback: `null` would claim
   nothing was transcribed and `cloud` would claim something left the machine.
   And **a session's engine is set when it opens and is never rewritten**: it
   may be raised from `none` to an engine, but audio that has been streamed to
   a service cannot un-leave the machine, so a client talking a note out of
   saying `cloud` is refused. `device:` beside it is `name (platform)` when the
   device named itself and the bare platform when it did not — the platform is
   the floor, the name answers "which of my two Macs", and the app version is
   not a device.
3. **The choice is visible before the recording, not in a settings page.** A tier
   that silently upgrades the transcription path is a tier that silently changes
   where the audio goes.
4. **The cloud path is `https`, and a deployment that says otherwise is refused
   rather than obeyed.** The transcription Worker's address is an environment
   variable, so an `http://` typed into it is the one misconfiguration here that
   is both silent and severe: every chunk of every meeting on that deployment
   crosses the public internet in the clear, and nothing complains. We are
   willing to say out loud that the audio is processed by somebody who is not
   you and not us; we are not willing to say it was readable on the way there.
   The single exception is **loopback**, because `wrangler dev` serves plaintext
   on `127.0.0.1` and self-hosting the whole stack locally is a supported path —
   and loopback reaches no network, so there is nothing on it to intercept. It
   is matched on the parsed hostname, never as a substring, because
   `127.0.0.1.attacker.invalid` is an ordinary public name. The checks are
   `an http:// worker is refused, and the audio never leaves`,
   `http on loopback is allowed, because `wrangler dev` is one`, and
   `http on a host that merely looks like loopback is refused`.

Collapsing the two tiers to one cloud engine would be simpler, cheaper to
operate and better at diarization, and it would delete the free tier's actual
claim. Collapsing to on-device only would delete diarization and lock the
product to recent Apple hardware — `SpeechAnalyzer` is iOS/macOS 26 and later,
and on watchOS it does not exist at all.

### The cloud path knows *who* is asking, opaquely, and that is what buys a limit

The cloud tier spends real money per request, and for a while nothing bounded
it. `transcribeChunk` checked `getAuthUserId` and nothing else — deliberately,
since the audio never becomes anything the control plane owns and there is no
workspace to authorize against — but sign-up is open email OTP with no invite
gate, so "a signed-in account" is a barrier of approximately zero. Each call
carries up to 8 MiB of audio. And the body posted to the Worker was
`{ audioBase64, mimeType, durationMs }`: no caller at all, so a surprising bill
had nothing in it to trace.

Two things follow, and they are the enforceable part.

**The limit lives in the Worker, not in the control plane.** `lib/rateLimit.ts`
is the tool everywhere else in Convex and it cannot be used here without
changing what `functions/meetings/transcribe.ts` is: `consumeRateLimit` needs a
`MutationCtx` and writes a `rateLimits` row, and that action deliberately has no
`ctx.db`, `ctx.storage`, `ctx.scheduler` or `ctx.runMutation`, because the row
next to `rateLimits` is the one that would hold a transcript. A test sweeping
every table in the schema exists to keep it that way, and relaxing it to admit
"just the one counter" would be relaxing it. So the limit is Cloudflare's native
rate limiting binding, declared in `wrangler.jsonc`, which provisions **no
account resource at all** — no KV, no D1, no Durable Object. That second
property is not a convenience: the Worker's whole auditability claim is that
there is nowhere in it to keep audio even by accident, and a rate-limit KV would
have been the first storage binding to weaken it. The check runs after the
credential check, so an unauthenticated caller cannot spend somebody else's
allowance, and before the body is read, so a refused caller cannot make the
Worker buffer 8 MiB first. It **fails closed**: a limiter that is absent,
throws, or answers something unreadable refuses the request rather than waving
it through, because a limit that stops applying on a green deploy is the finding
coming back with nothing to say when it started. The checks are
`refuses before the body is read, not after`,
`an unauthenticated caller never touches anybody's bucket`,
`a limiter that throws refuses, it does not wave the caller through` and
`a binding removed from wrangler.jsonc refuses too`.

**The identifier is an HMAC of the user id under the shared worker secret, and
never the user id.** It travels in the `X-Caller-Hash` header — a header, not a
body field, precisely so the Worker can refuse before parsing the audio. Three
properties are being bought at once, and no simpler construction buys all three:
it is *stable*, so it can key a limit at all (anything per-request is a fresh
bucket per request, which is no limit); it is *opaque*, so the Worker, its logs,
and anyone who intercepts the header hold no account identifier — a plain
SHA-256 would not do, because with no secret in the construction anybody holding
a user id can confirm a guess against it; and it is *recomputable by the control
plane*, which holds both the secret and the users table, so the account behind a
bill can actually be named. That last one is the reason it is an HMAC rather
than a random per-user token: a token would need a stored mapping, which is a row
this action must not write.

The inversion is a linear scan over `users`, spelled out on `callerHash` in
`functions/meetings/transcribe.ts`, and it is checked rather than merely
described — the test recomputes it with `node:crypto` independently of the
implementation. **Rotating `TRANSCRIBE_WORKER_SECRET` makes every previously
logged identifier permanently un-attributable.** That is a real cost of rotation
and is written down here so it is a decision somebody takes rather than a
surprise somebody discovers. The checks are
`sends an opaque caller identifier the worker can key a limit by`,
`never sends the user id, in the header, the body, or the URL`,
`is the same for the same account on every call`,
`is different for a different account` and
`is keyed by the worker secret, so it is not derivable without it`.

This is a real, deliberate widening of what the Worker is told. *Nothing joins
the call* and the Worker's own header both say it holds no session, no
workspace, no context id and no position in a recording, and all of that stays
true: it now learns that two chunks came from the same caller, and nothing else
about who that is. The alternative was leaving the budget open, and an
unbounded spend that names nobody is not a stronger privacy position — it is
the same disclosure with a bill attached.

**Two things this does not cover, stated rather than glossed.** The limit is per
*identifier*, so somebody willing to open many accounts gets many buckets: that
is a signup-gate problem — open email OTP with no invite — and it is not this
seam's to solve. And Cloudflare's limiter is per-location and eventually
consistent, so a caller spread across colos gets a multiple of the ceiling; it
bounds a blast radius and is not an accounting system, which Cloudflare says
outright.

### A client-supplied id is bounded where it enters — and, since 2026-09-05, where it lands as well

**Amended.** This section used to end at "where it enters", and its premise was
that `normalizeSegment` in `packages/meetings/src/transcript.js` "accepts an
unbounded segment id: it trims, checks for non-empty, and stores." That is no
longer true, and the reversal is written here rather than left to be discovered
from the code, because a decision record asserting the negation of the shipped
behaviour is worse than no record.

`chunkId` arrives from a recorder and becomes a transcript segment id
(`${chunkId}-${index}`). The bound still belongs on the argument, for the reason
it always did — it is the contract's own input, it arrives from a client, and
every consumer downstream would otherwise have to distrust a value we handed it.
What changed is that the entry bound is no longer the *only* one.

**Why the second bound was added.** `normalizeSegment` is reached by a path the
entry check does not cover: `POST /meetings/sessions/:id/segments` takes segments
from any `context:write` grant directly, without passing through
`transcribeChunk` at all. The gateway caps a segment's text, one request body,
and how many segments a session holds — but never the size of the stored record,
so a padded id was the one field those caps did not reach. The record lives at
`.meetings/sessions/<id>.json`, and `isPlumbing` refuses a dot-prefixed segment
at every tier including the owner's, so the growth is invisible to the person
whose storage bill it lands on. `MAX_SEGMENT_ID_CHARS` = 200 closes it.

**What it is worth, stated honestly.** Roughly 38 MB per session, against a
legitimate ceiling of about 80 MB that those same count limits already permit
(20,000 segments × 4,000 characters of text). So this is a third off a ceiling
that is otherwise unchanged, not a new bound on how large a session may be.
**The larger axis is still open and is deliberately not closed here: nothing
caps how many sessions may exist.** A fresh `mtg_` id mints a new record every
time, each up to that ceiling, all under `.meetings/` and all equally invisible.
That is the same shape at N times the magnitude and it wants its own decision.

**The two bounds are coupled and nothing in the type system says so.**
`MAX_CHUNK_ID_LENGTH` = 128 keeps the longest real id at ~133, comfortably under
200. Raise it past 192 and every segment from the transcription path is refused
at the merge instead — silently, because no client reads the `rejected` count.
`apps/convex/__tests__/meetingTranscribe.test.ts` asserts the relationship, since
the two constants live in packages with separate test runners.

1 to 128 characters of `A-Za-z0-9_-`. The recorders mint `<Date.now()>-<index>`,
around seventeen characters, so the bound is enormously generous against the
real workload while refusing the two shapes that cause trouble: an id large
enough to matter written verbatim into a note, once per segment, in the
customer's own bucket; and characters that mean something to a Markdown
renderer, a path resolver or a shell. The refusal is its own code —
`INVALID_CHUNK_ID`, not the deployment-problem code the other refusals share —
because it is the only one here a *client author* can act on, and it never
quotes the rejected value back, because that is how a refusal becomes a
reflection. It is checked after authentication, like everything else: the shape
of an unauthenticated caller's arguments is not something to tell them about.
The checks are `refuses an id longer than the bound, before spending any
inference`, `refuses characters that mean something to a renderer, a path, or a
shell`, `the refusal names the field without quoting what was sent` and
`an anonymous caller with a bad chunk id is still just anonymous`.
### The device is never waiting on the network, and a backlog is dropped rather than kept

Capture rotates on a fixed wall clock, and the first version of it closed a
chunk, **awaited the transcription round trip**, and only then reopened the
microphone. That is 1.5-4s of every twenty seconds never recorded, cut mid-word,
on both platforms — 8-20% of a meeting — while the offset arithmetic went on
asserting the chunks were contiguous, so the transcript's timestamps claimed
audio that had never existed. On a slow link it was worse than lossy: if a round
trip outran `SEGMENT_MS` the interval kept firing, the backlog grew with no
ceiling, and the offsets diverged from wall clock permanently while the recorder
still reported `state: "recording"`.

So **the send is not on the chain that owns the device.** A rotation closes the
file, reopens recording, and hands the bytes off; segments arrive whenever they
arrive, which costs nothing because a `TranscriptSegment` carries its own id and
`startMs`. Out-of-order arrival is acceptable; silently missing audio is not.

That leaves a bound to choose, and what happens at it is the actual decision:
**at `MAX_INFLIGHT_CHUNKS` a chunk is dropped, with an honest sentence on the
screen, rather than queued.** Queueing means holding somebody's audio past the
moment it would otherwise have been deleted — on the phone, keeping the `.m4a`
in the cache — and "the file dies before the request that carries its contents"
is what makes *audio is never persisted by us* a property of the code rather
than a line in this document. A bounded queue also only moves the same decision
`MAX_INFLIGHT_CHUNKS` chunks later, by which time the backlog is minutes rather
than seconds and nobody has been told anything.

Two rules follow from the same place, and both were wrong before they were
written down. **The offset is session time and it moves whatever else fails** —
a chunk the device would not close, a chunk with nowhere to send, the seconds an
interruption cost: all of it is time that passed, so every later chunk starts
that much further along, and a flag's `at` lands on the sentence it was pressed
during. **A chunk id, conversely, is spent only when there is a request to carry
it**, so a run of bad chunks leaves no gaps in the sequence.

And **releasing the device may never depend on the send.** `stop()` awaited the
last chunk's transcription before releasing, so ending a meeting with no signal
— the ordinary case, not the edge one — left the microphone open: iOS's red bar
for the life of the process, the browser's recording dot for the life of the
tab. The release is unconditional now, and waiting for outstanding sends happens
after it, where it costs a spinner rather than a microphone.

The same rule reaches the other end of a recording. Nothing swept the recording
directory at startup, so a crash or a force-quit mid-chunk left up to
`SEGMENT_MS` of somebody's meeting in the app's cache permanently — while the
code claimed in prose that it could not. The sweep runs when the capture module
is first evaluated, which is the one moment in a runtime where no recorder
exists for it to race.

The checks are `rotation reopens the microphone without waiting for the
answer`, `a backlog is bounded, and what it drops it says`, `a chunk that will
not close does not take the next twenty seconds too`, `an interruption's lost
time lands in the offset`, `a chunk whose path the file system refuses still
releases the device`, and `a recording a previous run left behind is swept at
startup`.

### The recorder is one interface with two implementations, and nothing above it knows which

Both engines sit behind one recorder interface: start, feed audio, emit
`TranscriptSegment`s, stop. The session reducer, the note renderer, the
detection rules and the gateway are written against `TranscriptSegment` and
have no idea what produced one.

The pressure against this is specific rather than hypothetical. Cloud engines
stream partial hypotheses that get revised; on-device engines emit finalized
utterances on their own schedule; one gives you speaker labels and confidence,
the other gives you `null` for both — which is exactly why those two fields are
nullable in the contract rather than optional. It is very easy to let one
engine's shape leak upward "just for now", and then the free tier is a
degraded special case of the paid one instead of a first-class path.

The check is `the session reducer imports no recorder`, and the useful form of
it is a test that drives the whole pipeline from a fixture segment list with
`speaker: null` and `confidence: null` everywhere and still produces a complete,
sensible note.

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
is in [watch-companion](../meetings/watch-companion.md).

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
([identity-and-access](./identity-and-access.md), *Ingestion is on the apex,
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
title-derived path produces a *second* note and both look correct. So the path
carries a stable suffix taken from the session id, and finalize resolves an
existing note **by that suffix** before it composes a new path — a rename
rewrites one note, it does not fork one.

Every `MeetingEvent` in the contract is idempotent or additive for the same
reason: replaying the log must land on the same session.

The checks are `finalizing twice writes one note`,
`re-sending a segment does not duplicate it`, and
`a re-finalize with a changed title rewrites one note rather than adding a second`.

### The human's words are never rewritten, and the generated half is disposable

`MeetingSession.notes` is what the person typed. `enhanced` is what the model
produced. They are separate fields, they render as separate headings, and the
enhancement pass reads the first and writes the second.

This is the same asymmetry as `index.md` in [gateway-protocol](./gateway-protocol.md):
the generated part can be regenerated, so losing it is never data loss, while
the part only the human can write has no source to rebuild it from. It also
makes "re-run the summary" safe to offer as a one-tap action, which it would not
be if the two shared a heading.

The check is `re-enhancing a meeting leaves the human's notes byte-identical`.

### A meeting lands at an ordinary path, and nothing about it is namespaced

`0-inbox/meetings/2026/09/2026-09-05-<slug>-<suffix>.md`, where `<suffix>` is the
stable tail of the session id. It is an ordinary note under the customer's
ordinary folders: no `meetings/` bucket, no tenant prefix, no reserved
directory, nothing to migrate ([non-negotiable 2](../../CLAUDE.md)).

Two consequences that are decisions rather than accidents. The folder is a
**default the customer can change**, because PARA is a suggestion and someone who
files meetings under `2-areas/team/` should keep doing that — and the moment
they move a note, the note *stays* moved, because nothing holds a second copy of
its path. And the date folders exist for humans and for Obsidian, not for us:
nothing in the gateway parses a path to find a meeting, because a path that has
to parse is a path that cannot be moved.

The check is `moving a meeting note does not break reading it`.

### What is deliberately not built

Not built, and none of them foreclosed:

- **Storing audio.** No recordings in the bucket, no recordings with us. The
  moment audio is retained, the product's promise needs a retention policy, a
  deletion path and a legal posture, and the thing being kept is the most
  sensitive artifact in the system.
- **A meetings database.** Recent-meeting lists, counts and calendars are derived
  from notes, like search is derived from files ([search](./search.md)). A
  meetings table would be the second copy that non-negotiable 3 exists to
  prevent, and it would be the copy the privacy engine does not guard.
- **Recording on behalf of someone who is not there.** See *nothing joins the
  call*.
- **Cross-context meeting search ranking.** A shared workspace's meetings are
  reachable exactly the way its notes are, through `context: "@name"`, and that
  is all.

### Consent is the customer's, and the product may never make recording invisible

The one decision here with no mechanical test, stated anyway because leaving it
implicit is how it gets designed away.

Recording law varies by jurisdiction and by who is in the room, and this product
does not know either. It does not announce itself to a call it never joins, and
it will not pretend to have handled a consent question it cannot see. What it
**must** do is make recording obvious to the person doing it: a Live Activity on
the phone, a tray indicator on the desktop, a visible timer, and an end control
that is one tap from wherever they are looking. A recorder with no visible state
is a surveillance tool that happens to have a friendly settings page.

The nearest thing to a test is that a session in `recording` always has a
surface: `a recording session with no visible indicator is a bug, not a mode`.
Detection may *suggest*, and the suggestion is a prompt with a "not now" — a
detector that silently starts recording would be the same product with the
indicator removed.

**"Wherever they are looking" is mounted once, at the root of the app — and so
is everything the recording depends on.** The phone's bar lived inside the
meetings navigator, which made it visible on the
meetings screens and nowhere else — so a person who started a recording and went
to read a note had a microphone open and no indicator, which is precisely the
mode this section says is a bug. It is now mounted beside the `(app)` stack,
above every route; it costs that layout nothing, because the recording lives in
a module-level store rather than a provider and the bar draws nothing when
nothing is live.

Two things follow, and both were found by checking rather than assuming. It is
mounted in **one** place — mounting it in the section layout as well draws two
bars over each other, because that layout renders inside this one. And it
**stacks above whatever floating chrome the screen underneath already has**: the
console's toolbar is a pill of the same height in the same slot, and a recording
bar lying on top of it would take a screen's navigation away for the length of a
meeting. The frame publishes the height it occupies and the bar clears it, which
is also why a screen with no chrome there pays nothing for the possibility.

The half that took longer to see is that **a recording visible from anywhere has
to be *working* from anywhere**, and two of the parts it depends on were still
wired to the navigator that unmounts. The Convex client the recorders ship
chunks through was installed by the meetings layout, so leaving the section
mid-meeting recorded audio, encoded it, deleted it and threw it away while the
bar went on drawing a live timer. And the recorder itself was built inside that
layout's effect, so coming back handed the controller a fresh idle one — End
then stopped that, while the object actually holding the microphone kept its
rotation timer and its listeners forever. A recording outlives those screens, so
anything it depends on is mounted where the bar is, or held across a
reconfiguration.

The checks are `the persistent recording bar is mounted here, and draws nothing
when idle`, `the frame publishes the height of its floating toolbar, and takes
it back`, `with the console's toolbar underneath, it clears it rather than
covering it`, `leaving the meetings section does not switch transcription off`,
and `re-configuring mid-meeting keeps the recorder that is holding the
microphone`.
