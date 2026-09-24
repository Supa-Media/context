# Meetings — capture plumbing

### Pressing Record is the same yes, and the blocklist sees less of it

Detection cannot see two people at a table: an in-person conversation is not a
process, a window title or a calendar event. So the desktop offers *Record a
meeting*, and it mints its own consent episode — pressing it is the same
sentence the panel asks for, given first rather than in answer.

One consequence is uncomfortable and is written here rather than left to be
discovered. **The blocklist can only refuse what the detector is currently
reporting.** Blocked apps are stripped out of the signals before `detect()` sees
them — that is the stronger half of the promise, and it is why a blocked app
never becomes a source, a tooltip, an evidence line or a log entry — so on the
manual path there is nothing to match against. Press Record during a call in a
blocked app and the recording starts.

That is the trade rather than a gap to close later: the blocklist means *never
record this app for me, automatically*, and it cannot also mean *refuse an
instruction I gave with the app in front of me* without watching the app it
promised not to watch. Closing it would require observing blocked apps, which is
the one thing the setting exists to prevent.

`captureEnabled` is the switch that does apply to both paths, and it had no way
to become true — nothing in the app set it, so every route to a recording was
closed on a fresh install. Connecting a machine turns it on, in the dialog where
somebody says this machine records their meetings.

### A microphone is never opened for a meeting nothing will transcribe

The desktop has two states in which it cannot produce a transcript: no grant on
the machine, and on-device chosen with no on-device engine built. In both, the
app records **nothing** — no `getUserMedia`, no permission dialog — and says
which one it is in a sentence naming the fix. The notes still become a note.

This is the phone's own answer (`notesOnlyRecorder`) rather than a second one,
and the argument is the same twice over: a meeting recorded with no transcriber
is a meeting somebody thinks they have and does not, and it is also somebody's
audio held open for no purpose. It has a third consequence here that the phone
does not have — macOS remembers a refusal, so raising the microphone dialog for
a session that will not open a microphone spends the one prompt a person ever
gets.

System audio is the same rule at a smaller scale. An unsigned build asks macOS
for the loopback tap and gets nothing; that is not a failure, it is mic-only,
and the panel says the far side of a call on headphones will not be in the
transcript. The probe *is* the attempt — there is no API that answers the
question without asking it — so the answer is remembered for the rest of the
launch and deliberately not persisted, because a signed build installed over an
unsigned one would otherwise inherit the old answer forever.

A "simplification" that opened the microphone anyway and let the transcript come
out empty would fail `an unconnected machine opens NO audio at all`,
`NO PERMISSION IS REQUESTED FOR A MEETING THAT OPENS NO MICROPHONE` and
`a build macOS will not give system audio to still records`.

### A chunk of audio is a whole file, and every recorder cuts on the same clock

`MediaRecorder.start(timeslice)` emits a blob every interval and only the first
one carries the container's headers. Every chunk after it is a fragment no
decoder and no transcription engine can read — so a recorder that streams
timeslices produces audio that looks fine in a log and transcribes to nothing.
The desktop capture window did exactly that, and nothing had noticed because
there was no transcriber on the other end yet; it would have transcribed the
first second of every meeting and silence after.

So a chunk is a whole recording — stop, hand over, start again — and the cost is
the few milliseconds of somebody still talking between the two, which is the
smaller one. Both mobile recorders already worked this way; the desktop now
does, and `SEGMENT_MS`, `MAX_INFLIGHT_CHUNKS`, `chunkIdFor` and `segmentIdFor`
moved to `@context/meetings/chunks` so there is one copy. An offset is the sum
of the durations before a chunk, so a second `SEGMENT_MS` on the laptop would be
a transcript whose `startMs` means something different from the phone's — the
kind of drift nobody sees until two clients disagree about when something was
said.

The checks are `packages/meetings/test/chunks.test.mjs` and, on the client side,
`its id is derived from the chunk, never taken from the answer` and
`a second chunk goes out while the first is still unanswered` — plus
`apps/desktop/test/captureWindow.test.mjs`, which drives the real capture module
against a fake browser, because this is a bug that hides: the fragments look
fine in a log and the failure presents later as "the first twenty seconds
transcribe and then it goes quiet". `A RECORDER IS STARTED WITH NO TIMESLICE`,
`EACH CHUNK IS A WHOLE RECORDING` and `OFFSETS ARE CONTIGUOUS ARITHMETIC` are
the three that fail if it comes back.

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
`.context/meetings/sessions/<id>.json`, and `isPlumbing` refuses a dot-prefixed segment
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
200. Raise it past 168 and every segment from the transcription path is refused
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

**Amended 2026-09-18: the second half of this title is reversed.** A backlog is
now *kept*, on the device, and the section that says so — *Audio nobody has
transcribed yet is kept on the device*, next — records what that costs. The
first half stands: the send is still off the chain that owns the microphone,
and everything below about offsets, chunk ids and releasing the device is
unchanged. The paragraph that argues for dropping is left as the record of the
decision that was reversed, not as current behaviour.

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

### Audio nobody has transcribed yet is kept on the device

The owner's call, 2026-09-18: **offline audio is spooled, never dropped.** A
meeting recorded in a basement, on a train, or on one bar of signal came out of
the app with a transcript full of holes, because every chunk sent without a
connection failed once and was gone — its file had been deleted *before* the
request that carried it, which was the point — and past
`MAX_INFLIGHT_CHUNKS` the recorder dropped chunks outright with a sentence
saying so. Losing signal is the ordinary case (*Ingestion is idempotent by
construction*, above), and the words a meeting recorder most needs to keep are
the ones it could not send.

**What is built.** Every chunk a phone records is written into a spool before
it is sent — `apps/mobile/features/meetings/capture/spool.ts`, one file per
chunk under the app's *documents* directory, named
`<index>_<offsetMs>_<durationMs>.<wav|m4a>` in a folder per meeting, so the
file name is the whole index and there is no manifest to disagree with it. A
chunk is sent when there is a connection and fewer than `MAX_INFLIGHT_CHUNKS`
already out; otherwise it waits. It is deleted only once the transcriber has
answered for it **and** its words have been handed to its meeting (and, on the
drain's path, written down on the device). What waits is sent by
`spoolDrain.ts` — on launch, on reconnect, on returning to the foreground, and
after End — sequentially, oldest meeting first, in index order, through the
same `transcribeChunk` with the same chunk id, offset and duration.

- **`MAX_INFLIGHT_CHUNKS` is about network concurrency and nothing else now.**
  Chunks in the spool are not in flight. Recording goes on for as long as the
  meeting does, offline, with no bound.
- **Offline, nothing is dispatched.** `ConvexReactClient.action()` has no
  timeout: offline it holds its arguments — here twenty seconds of base64 — until
  the socket returns. Sending anyway would put an hour of a meeting in the heap.
  The reachability hook's "offline" is mirrored into `capture/connectivity.ts`.
- **The note waits for its audio.** `sync()` does not finalize a meeting while
  its audio is still waiting, because `complete` refuses every later segment
  (`acceptsTranscript`) and the words would arrive to a note that can no longer
  take them. `recoverStaleFinalizes` skips such a meeting (it is waiting, not
  stuck), and End no longer calls a meeting whose only content is kept audio
  `empty`, which is terminal.
- **Idempotency is the chunk id's, and needs no server change.**
  `transcribeChunk` derives every segment id from the chunk id and the
  segment's position, so the same chunk answers with the same ids
  (`two identical calls produce identical segments`), and the meeting upserts
  by id. Making the server "remember" a chunk would mean the control plane
  holding a transcript, which non-negotiable #1 forbids. The one residual:
  Whisper re-run on the same audio could split it into a different number of
  segments, and then a re-sent chunk whose first answer *was* folded in leaves
  the extra rows of the longer answer. That needs an answer to be folded and
  its chunk then re-sent — a crash in the milliseconds between the two — and
  the drain orders it so that is the only way.
- **A send that outlives its meeting leaves its chunk for the drain.** The
  recorder emits only to a listener for the meeting a chunk names; a send that
  answers after End's wait, or after the next meeting has started, leaves the
  chunk where it is and the drain delivers it by id. The same change made End
  hold its listener until its wait is over, which fixes an older loss: the last
  seconds of every meeting were emitted after the controller had stopped
  listening.
- **One bad chunk cannot hold a note forever.** A chunk the transcriber refuses
  on its own merits (`TRANSCRIPTION_FAILED`, `INVALID_CHUNK_ID`) is set aside
  after `MAX_REFUSALS` in one process: it stops holding its meeting, stays on the
  device, and is counted on the screen as kept and not transcribed. A network
  failure, a rate limit or an expired session is never counted against a chunk.
- **Somebody's content, not a cache** — the rule the offline layer already keeps
  for a queued write. Nothing sweeps the spool, nothing bounds it, nothing ages
  it out. A chunk leaves because its words arrived, because the person
  discarded its meeting, or because they signed out: `forgetLocalCopies` wipes
  it first (it needs no store, so a failing store cannot stand in front of it),
  after `endSession()`, and re-counts rather than trusts. Every write carries the
  epoch the recording started under and is checked on both sides of the write,
  so a recorder still running behind a sign-out writes nothing and a write the
  sign-out overtook is taken back. **And the person is asked first**: the
  sign-out question counts meetings with audio on the phone
  (`unsentMeetingAudio`) beside unsent note edits and says *"1 meeting's audio
  has not been transcribed yet — signing out deletes it from this phone"*;
  without it, sign-out was a silent way to lose exactly what the spool exists to
  keep. `asks first, naming the meeting whose audio would be deleted`
  (`signOutHygiene.test.ts`) fails if the spool is left out of the count.
- **Written beside, then moved in.** Bytes go to `<name>.part` and are renamed
  when whole; a crash mid-write leaves a `.part` that is never listed or sent.
  A refused write removes its own `.part`.

**What the person sees.** Recording offline, the live screen's chip says
*"Offline — recording is saved on this phone and will be transcribed when
you're back online"* with the count waiting, and it outranks a capture error
(offline, that error is the same fact said worse). The recording bar, which has
room for two words, shows *On phone · N* with the whole sentence as its label.
An ended meeting whose audio is waiting says the note is written once the
pieces are in; the transcript says *Incomplete — N pieces of audio on this
phone are not in this transcript yet*; set-aside audio is said to be on the
phone and not in the note. All of it is one pure module, `keptAudio.ts`.

**A browser keeps nothing, and says so.** `spoolDevice.web.ts` is `null`. Holding
minutes of somebody's meeting in IndexedDB on a machine that may be shared,
under a quota the browser evicts without asking, is a different decision from
the phone's and was not taken. Offline, `audio.web.ts` no longer dispatches
into a socket that will not answer; it says once that this stretch is not being
transcribed, that typed notes are still saved, and that the phone keeps audio.
Browser *dictation* offline now names the computer's own dictation (macOS and
Windows both have it) instead of "the words cannot be made right now", and
checks `navigator.onLine` before it opens the microphone.

**What it costs, stated.** The audio of a meeting now exists on the phone for as
long as it takes to reach the transcriber — minutes normally, days if the phone
stays offline — which is exactly the property the old design existed to rule
out, and "audio is transient" is now true of everything *except* the
customer's own device. On iOS the documents directory is included in the
person's device backup, and this `expo-file-system` has no way to exclude a
file; it is their backup of their meeting, and a chunk is gone from the device
the moment its words land. A note waits for its audio, so a meeting recorded
offline is not in the bucket until the phone has been back online long enough
to send it — twenty chunks a minute, so an hour offline is about nine minutes
of sending. And uncompressed 16 kHz audio is about 115 MB an hour on a phone
that has no signal to send it.

**What a "simplification" would cost.** Deleting the file before the send again
is the transcript full of holes this reversed. Bounding the spool, or sweeping
it by age, is a meeting silently losing its middle on the day somebody was
offline longest. Finalizing without waiting for the spool writes the note
without the words and then refuses them when they arrive. Dropping the epoch
checks puts one person's meeting audio on the device after they signed out, for
the next person to have sent under their own session.

**The tests that fail if it is reversed**, each sabotaged and seen to fail:
`a send that fails keeps its chunk, and says it is kept rather than lost`,
`offline, nothing is sent and every chunk is kept, well past the in-flight
bound`, `with the sends backed up, the rest are kept rather than dropped` and
`an answer that arrives after its meeting has moved on leaves the chunk for the
drain` (`meetingsCapture.test.ts`); `a meeting is not written while its audio is
still on the phone`, `audio on the phone and nothing else is still a meeting`,
`waiting on audio is not mistaken for a stuck finalize`, `a chunk sent twice is
in the transcript once`, `words that come back while End waits reach the
meeting` and `sign-out takes the audio with it` (`meetingsKeptAudio.test.ts`);
`a chunk is let go only after its words are written down`, `a lost connection
stops the pass and sets nothing aside` and `a sign-out during the round trip
delivers nothing and confirms nothing` (`meetingsSpoolDrain.test.ts`); `a write
that a sign-out overtook is taken back`, `a wipe that did not land says so` and
`only whole chunks are listed` (`meetingsAudioSpool.test.ts`).

**Not verified by any of this: a device.** Every test drives fakes of
`expo-audio` and `expo-file-system`. Before this is trusted, on a real iPhone
and a real Android phone: record in airplane mode for at least three minutes
(locked for part of it), and confirm the chunk files under
`Documents/meeting-audio/<meetingId>/` grow and the live chip says the audio is
saved; end the meeting offline and confirm the note says it is waiting; turn
the network back on and confirm the transcript fills in order, the files go,
and the note is written once; kill the app mid-meeting offline, relaunch online
and confirm the failed meeting still gets its words; sign out with audio
waiting and confirm the folder is gone.

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
