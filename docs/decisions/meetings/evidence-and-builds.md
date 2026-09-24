# Meetings — evidence and builds

## The seventh key became a row in the `+`, and the route it guarded did not move

Everything above about "the seventh key" describes a microphone at the end of the
phone's bottom row. On 2026-09-19 the owner removed it: *"we no longer need a
dedicated mic button on the bottom row, just a plus button that opens different
options"*. The row is six keys, the separator that marked the key off is gone
with it, and **recording a meeting is a row in the sheet the `+` raises**
(`CreatePrompt`, driven by `files/createSheet.ts` — see
[app-and-console](../app-and-console.md), *Nothing is named before it is written,
and the phone's `+` is the only key*, and *The corner makes five things* above
it, which is where the corner's own list is argued).

What that costs and does not cost, because this file spent a lot of words on that
key:

- **The route survives.** Everything argued above rests on the phone having *a*
  way into capture and on the only route to a finished meeting hanging off the
  sheet that way raises. The `+` raises the same flow (`startMeetingFlow`), so
  both still hold — one press deeper, and now beside the four other things
  somebody starts.
- **The "one microphone" rule survives, and was never about the glyph.**
  `NoteEditor`'s `microphoneElsewhere` still stands the floating microphone down
  while the bottom row is on the glass, and the floating one still returns with
  the keyboard accessory bar, at exactly the moment there is a caret. The
  condition is unchanged because what it protects is *the corner* — one floating
  control at a time — and the row's `+` is that control now.
- **The `+` had to stop being gated on `canEdit`.** It was, while it meant
  *note*. A meeting is something a member of somebody else's context can still
  start, so that gate would have taken capture off every shared context somebody
  reads — which is the hole this file's own argument exists to keep shut. The
  read-only rule moved a row lower: the sheet draws no Note, Drawing or Folder
  without `canEdit`, and `canCreateAnything` hides the key only when the sheet
  would have no rows at all.
- **The width argument gets easier, not harder.** Seven targets plus the rule
  needed 309pt and spent the pill's padding and part of the sliver at 375 and
  below. Six need less, and `bottomRowWidth.test.ts` keeps the seven-key solve as
  a probe of `BottomBar` — the shape the geometry must survive if a destination
  is ever added back — separately from `CONSOLE_KEYS`, which is what the product
  draws.

**The tests that fail if it is reversed**: `is six keys, ending at Save, with no
separator and no microphone` in `apps/mobile/__tests__/bottomRowWidth.test.ts`,
`the app's other place is a row in the + sheet, and choosing it records` in
`apps/mobile/__tests__/consoleChrome.test.ts` (driven through the real row, to a
real refusal from a console with no controller behind it), and the four states of
`apps/mobile/__tests__/oneMicrophone.test.ts`, every one of which is unchanged by
this — which is the point.

## A permanent, correct refusal is not the same fact as a transient one, and must not share its sentence

Verified on hardware: a meeting killed mid-recording with real audio recovers
on Retry in about seven seconds and files correctly; the same kill with
nothing captured — no transcript, no typed notes — cannot file, and should
not. Both are the intended behaviour. What was wrong was what the second one
was told: `markSyncFailed` parked every record that failed to reach the
gateway six times behind one sentence — *"This meeting has failed to reach
your context several times. It is still on this device — try again, or copy
your notes out."* — regardless of whether the record held anything a retry
could ever send or a copy could ever find.

Six transient failures is a fact about the **connection**. It says nothing
about whether *this* meeting has content worth fighting for, and a session
`hasNothingCaptured` has none: there is no request a retry could make succeed,
and there are no notes to copy out. Telling somebody to try again for a
meeting that will never file, or to copy notes that do not exist, is the same
shape of lying instrument as a level meter that always reads zero — technically
produced by real code, answering a question nobody asked instead of the one in
front of them.

**The fix is a classification, not a new behaviour, and `markSyncFailed` now
makes it explicitly:** the same trigger (`MAX_SYNC_ATTEMPTS` transient
failures), a different sentence depending on `hasNothingCaptured(record.session)` —
the honest, permanent "nothing to send and nothing to copy out" for an empty
session, and the original retry framing — now carrying the refusal's own last
reason rather than a bare count of attempts — for everything else. This is a
backstop rather than the primary fix: `end()` and `recoverInterruptedRecordings`
both keep a session with nothing captured out of the sync queue in the first
place by folding it straight to `empty`, and `MeetingNoteScreen`'s `Landing`
checks `session.state === "empty"` before it ever reads `record.rejection` — so
a session that took either path never reaches this message. It exists for the
same reason `convexGateway.finalize`'s own defensive `hasNothingCaptured` check
does: a bug in an earlier step should not turn into a false "try again" here,
any more than it should turn into a real, empty note in somebody's bucket.

**The primary fix was `recoverInterruptedRecordings`, which had not been taught
the check `end()` already makes.** A killed-mid-recording session found
`recording` or `paused` at the next launch was folded to `failed` with
`INTERRUPTED_RECORDING_REASON` — *"This device restarted while recording, so
the rest of this meeting was not captured. What was recorded is kept
below."` — unconditionally, whether or not there was a "rest" or anything "kept
below". For a recording killed within the first few seconds, before a word was
typed or transcribed, that sentence asserts content the session never had, and
`failed` itself reads as transient — Retry is right there — when the true fact
is permanent: `MEETING_TRANSITIONS` puts `empty` only behind `finalizing`, the
same two-event path (`end`, then `empty`) `end()` already takes, so this is
that same path reaching the one caller of `fail` that had been left out of it.
A session with nothing captured now closes the same way whichever door it
came through — the ordinary end of a meeting, or a relaunch that finds one
still open — and `INTERRUPTED_RECORDING_REASON` is left to say what remains
true of it: a session that captured *something* before the device restarted.

**`hasNothingCaptured` is not the whole question, and the fold has to ask the
other half.** It reads the session — no transcript, no typed notes — and a
meeting recorded entirely offline satisfies it while holding everything it
has on disk: no chunk has reached a transcriber yet, and the person was
listening rather than typing. `empty` is terminal, so folding such a session
to `empty` refuses every word that audio later comes back as, which is
precisely why `end()` asks `hasNothingCaptured` **and** whether the spool is
holding anything for this meeting before it folds. Recovery at launch is a
second caller of the same question and needs the same second half of it;
counting only the session is a guard holding the right rule against the wrong
field. The counts are already taken by `configure` before recovery runs — for
`recoverStaleFinalizes`, which needs them for its own reason — so this costs
nothing but the condition. **The test that fails if it is reversed** is `a
meeting killed with only its audio is failed, not called empty` in
`apps/mobile/__tests__/meetingsKeptAudio.test.ts`, beside the typed-a-line
case it was hiding behind.

`markSyncFailed`'s copy is the one place that still asks the session alone,
and it is left that way deliberately: `record.ts` is pure and holds no view
of the spool, threading one in to reach a backstop behind two folds that
already check it buys a sentence, not a word of transcript. The residue is
therefore exact and small — a meeting whose only audio has been *set aside*
after three refusals is not `audioHeld`, so it can still reach this path and
be told "nothing was captured" while a chunk of it sits on the device. The
screen says otherwise right beside it (`endedAudioLine` counts set-aside
audio), and the state it is in is not terminal, so nothing is lost; it is a
wrong sentence, not a wrong fold. Worth fixing the day `record.ts` has a
reason to know about audio, and not before.

**What is not changed.** No code path that had a retry worth making loses it:
a `failed` session with real content still gets `INTERRUPTED_RECORDING_REASON`
and its Retry, unchanged. The finalize deadline (`checkFinalizeTimeout`,
`FINALIZE_TIMEOUT_MS`) is untouched; this is a different caller of `fail`, and
`recoverStaleFinalizes` was not audited to need the same check because a
session that reached `finalizing` at all had a `start`/`resume` behind it and
`pendingSteps` would already have queued real content ahead of any finalize.

The checks are `six failed reconnections on a meeting with nothing in it
never say 'try again'` and `six failed reconnections park a meeting and say
so, carrying the real reason` in `apps/mobile/__tests__/meetingsSync.test.ts`,
and `a recording killed within seconds — nothing captured — is empty, not
failed` in `apps/mobile/__tests__/meetingsController.test.ts`.

## The engine's own evidence travels to the recorder, because a Worker's log is not a place a person can read

The silence refusal above works and does not finish the job. Measured on the
signed build, in the same room, with nobody speaking:

```
before the refusal:  166 words / 90s = 1.84 words/sec
after  the refusal:   29 words / 45s = 0.64 words/sec
```

A threefold cut and a meeting still filed, so `hasNothingCaptured` is still
unreachable and the acceptance — record silence, expect no note at all — still
fails. The next move depends entirely on one question: **do the surviving
segments sit just past the thresholds, or far from them?** Just past means the
threshold is wrong and moving it is cheap. Far from them means the engine
decoded silence *confidently*, no threshold reaches it, and the answer has to
come from somewhere else.

**Nobody could answer it, and that is the defect this section is about.** The
three numbers that decide it — `no_speech_prob`, `avg_logprob`,
`transcription_info.duration_after_vad` — were read inside
`infra/transcribe-worker`, used for control flow, and dropped on the floor. The
transcript segment that reaches the customer's bucket carries exactly
`id, startMs, endMs, text, speaker, channel, confidence`, and measured across
every segment of every meeting, the distinct set of `confidence` values is
`[null]` — not a low number, `null`, because **the deployed model does not emit
a field called `confidence` at all** and this repository refuses to manufacture
one. So the one numeric field on the wire is structurally empty, and the three
fields that are not empty were invisible.

### First: the provider does return them

This was established before anything was built, because the alternative finding
— that the fields are absent — would have made plumbing them a waste and the
correct answer would have been to say so loudly.

- **The published output schema of `@cf/openai/whisper-large-v3-turbo` carries
  them**: `segments[].{start, end, text, temperature, avg_logprob,
  compression_ratio, no_speech_prob, words[]}` and
  `transcription_info.{language, language_probability, duration,
  duration_after_vad}`. It carries no `confidence`, which is why that field is
  `null` everywhere and always will be on this model.
- **They demonstrably arrive**, which is stronger than a schema. Rule 1 cannot
  fire on this deployment at all — `vad_filter` defaults to `false`, so
  `duration_after_vad` equals `duration` and the rule has no opinion — so the
  threefold reduction measured on hardware was produced *entirely* by rule 2,
  which reads both `no_speech_prob` and `avg_logprob` and fires only when both
  are present. A rule that cannot fire without two fields, firing repeatedly on
  real audio, is those two fields arriving.

So the finding is that the evidence is real and was being discarded, and the fix
is to carry it rather than to declare it missing.

### Where it lives, and the two places it may not

**On the segment: no.** A segment is written into the customer's note and
rendered at a person. A `no_speech_prob` beside a sentence is a number whose
meaning its reader has no way to know, attached to their own words, in storage
they own — and `A CONFIDENCE IS NEVER INVENTED` exists precisely to keep numbers
that look like judgements about somebody's speech out of that file.

**In a log the transcription service keeps: no**, and this is the one the defect
proves. That Worker's logs are in an account the person diagnosing a recording
does not have. Tonight that person was on the machine that made the recording,
holding the app and the bucket, and the numbers were two hops away in a place
they could not reach. A diagnostic in an inaccessible place is not a diagnostic.

**So: a per-chunk summary, on the wire, to the recorder that posted the audio.**
`SpeechEvidence` is counts and readings — how many segments came back, how many
stated each field, the extremes over the kept population and over the refused
one, and the two `transcription_info` durations. The gateway carries it beside
`refusedSegments`, reading it key by key and judging nothing, exactly as it
already carries the count. The desktop writes one structured line per answered
chunk, `meeting_speech_evidence chunk=… kept=… refused=… …`, in the process the
person diagnosing already has in front of them.

Four properties, each load-bearing:

- **It is a summary, never a per-segment array.** A number beside each utterance
  could be joined to what was said, and would eventually be rendered at
  somebody. Counts and extremes cannot be joined to anything.
- **It carries no text, no timings and no ids of anybody's words.** Every value
  is a number or `null`; the only string in the log line is the client's own
  `chunkId`, which names a meeting and a channel and no content. Both the
  gateway and the desktop rebuild the object from keys they declare rather than
  forwarding what arrived, so a field the far end grew does not ride along.
- **`null` means the engine did not say, and `0` is never substituted for it.**
  This is the whole point: a `no_speech_prob` of `0` reads as "the decoder was
  certain somebody was talking", and an engine that stated nothing must never
  produce that sentence. The line prints `absent`, which cannot be misread as a
  measurement. A whole answer with no evidence prints `evidence=absent`.
- **Nothing is put in front of a person.** The sentence a person needs already
  exists and is words rather than numbers — `CAPTURE_NOTICES.silent`, said only
  when a whole chunk came back empty. No screen and no note gains a number here.

The extremes are **independent per axis**, and that is how they must be read:
`keptNoSpeechMax` and `keptLogprobMin` may belong to different segments. They
bound the surviving population rather than describing one member of it, which is
exactly the question being asked — did anything survive anywhere near the
cutoff, or is the whole population far from it.

### What is deliberately not plumbed

**The control plane's path.** The phone and the browser transcribe through
`apps/convex/functions/meetings/transcribe.ts`, which carries `refusedSegments`
and could carry this too. It does not, for the reason that decided everything
above: nothing on the phone can read a log line, so the evidence would land in
Convex's logs — the same inaccessible place, one provider along — and a field
nobody reads is plumbing that rots. The desktop is the recorder being
diagnosed, and it is where the numbers can actually be looked at. When the phone
grows somewhere to put one, the field crosses the same way.

**Any use of the evidence in code.** Nothing branches on it, on any hop. The
refusal stays exactly where it is, on the engine's own fields, in the one place
every recorder's audio passes through. This is a diagnostic and must not quietly
become a second threshold in a client.

### The cost, stated

One short line per answered chunk, so roughly three a minute per open channel,
in the desktop's log for the life of a recording. Always on rather than behind a
flag, deliberately: the evidence is wanted *after* a recording turns out wrong,
and a diagnostic somebody has to switch on beforehand is one nobody has when it
matters.

**The test that fails if this is reversed:** `reporting the evidence the refusal
acted on` in `infra/transcribe-worker/src/transcribe.test.ts`, `the engine's own
evidence reaches the recorder` in `apps/mcp/test/meetings.test.mjs`, and the
evidence block in `apps/desktop/test/transcriber.test.mjs`. Filling a `null`
reading with `0` reddens six checks in the Worker alone.

## A build is what shipped, not what merged — two "the fix did not work" reports were one build

Two defects were reported against the signed build the owner installed on
2026-09-08, and both dissolve into the same fact.

- **The eight parked outbox rows did not clear**, though `dropMisaddressed` runs
  over the queue as it is read off disk and drops exactly those rows.
- **Every segment was delivered to the page more than once**, at a ratio equal
  to the meeting's index in the run — one subscription leaking per meeting.

The build is workflow run `34181715875`, whose `head_sha` is `fd0081e` (#351,
the silence refusal), started at `02:55:14Z`. `dropMisaddressed` and the
controller's detach both landed in `7bc99ca` (#353), which merged at `03:00:52Z`
— **five minutes and thirty-eight seconds after that build started**. Neither
fix was in the binary. The dispatch message named #353 as carried because it was
sent after the merge was requested and before it landed.

Both reports are therefore correct observations of the *old* code, and both were
reproduced against `fd0081e` and shown absent on `main`: three meetings driven
through the real controller against the old commit deliver meeting N's segments
N times and leave each meeting's record holding every later meeting's words; the
same run on `main` delivers each exactly once and leaves the recorder's
subscription count back at zero between meetings.

Two rules follow, and the first is the durable one:

- **A fix is confirmed against the binary that was installed, never against the
  branch that was checked out.** The report that confirmed #353's leak fixed did
  so by reading `controller.ts` in a working tree — on a machine running a build
  that did not contain it. Reading the source proves what will ship; only the
  build proves what did. A dispatched workflow's `head_sha` is the fact, and it
  is one API call.
- **The queue is the evidence either way.** "No new parked entry appeared" was
  read as the leak being fixed, and "the outbox stayed at 8" as the drop not
  working. On the build that actually ran, those are one sentence — nothing
  dropped them because the code was not there — and the pair should have been
  read together rather than as two findings.

**What clears the parked rows:** any build cut from `7bc99ca` or later. They are
dropped once, on the way in, the first time that build reads the queue, and it
logs `meeting_segments_misaddressed_dropped rows=<n>`. Nothing is lost — each of
those rows also went out under the meeting that produced it and was acknowledged
there.

### The leak's third instance, and the guard the comment described

The recorder-to-bridge attachment in `apps/mobile/features/meetings/capture/
desktop.ts` is **correct, and was**. Its own `attach()` docblock states the
hazard in the words the third report used — *"a recorder is created per
configuration and `stop()` must genuinely detach, or a second meeting is fed by
two subscriptions and every segment is emitted twice"* — and the only check
standing on it ran **one** meeting, which is the single length at which a
per-meeting leak is invisible. A comment describing the failure it sits above,
with no test at that length, is how the same shape gets reported three times.

So the guard is now where the comment is: three meetings in one run, each
segment delivered exactly once, and the recorder's subscription count asserted
back at its baseline after every `stop()` — the stricter half, because a fix
that halved a leak passes a delivery count and fails a baseline. The overlapping
`start()` race is checked too, which is the one path where `attach()`'s opening
`detach?.()` is reachable at all; deleting that line failed nothing in the app's
whole suite before it.

**Three instances of one shape** — controller-to-recorder (#353), the phone's
equivalent, and this comment's hazard — say the answer may be structural rather
than three fixes: one attach/detach helper that owns a subscription set, or a
check that every subscription taken in this subsystem is released. That is a
larger change than the pull request making this note, and it is proposed here
rather than built.

### A meeting that stops saves itself, and says so where somebody is looking (2026-09-21)

**Reverses "a note the person never agreed was over"**, decided by the owner
after losing one: *"if a meeting ever stops it should IMMEDIATELY be saved, no
button press needed"*, and *"it should be very LOUD and dramatic if something
went wrong so the user can resume/restart"*.

**What was lost, and how.** A 31-minute meeting, ended normally. The gateway
*accepted* the finalize and answered with no note path — a real state, "I have
it, the bucket does not yet", while an enhancement runs. That ack sets
`acked.finalized`, so `pendingSteps` correctly offers no finalize step, and
`sync.ts` recorded that the path "arrives through the list". Nothing in this app
has ever called `gateway.list()`. The only thing left that could ask again was
`recoverStaleFinalizes`'s retry branch, and it went through `retrySync`, which
returns the record **unchanged** when there is no `rejection`. Ten minutes of
nothing, ten more, then `failed` — parked forever, with the words on the device
and a note that may well have been written. The console panel's one flat
sentence about it was the last link in the chain, not the defect.

So: `reopenFinalize` is the one place that question is asked, and it clears the
ack. `retryFinalize` already had that half and said in its own header that
without it the method "does nothing at all in the case it exists for"; the
automatic retry beside it never got it. **Two callers of one question is the
shape of this defect**, and the rule it leaves behind is that a recovery path
and the button beside it are the same function or they will drift.

**Why `fail` became `end` for an interrupted recording.** The old argument was
symmetrical-sounding and is not: *finalizing unasked writes a note the person
never agreed was over* versus *parking it leaves a meeting reachable by
nothing*. A note is editable, movable and deletable the moment it lands, and it
is in the customer's own storage where every other thing they own already is. A
parked meeting is behind a Retry nobody knew to press. The costs are not
comparable, and the reported failure is the second one. The other half of the
old argument — "a meeting merely interrupted may well continue" — is answered by
*resuming* the meeting, not by withholding the note in the meantime.

This is strictly better for the offline case, which was not the point but is
worth recording: `sync()` already holds a `finalizing` meeting while its audio
is on the device, so a recording killed with nothing but audio on disk now waits
for its words and is filed **with** them. Under `failed` that same audio landed
in a session nothing was ever going to file.

**`interrupted` is client-local and is never written into the note.** "Your
phone restarted" is a fact about our software on a particular evening, not about
somebody's meeting, and they should not have to delete it out of their own file.
The app says it; the note does not.

**Loud is a bar, not a toast, and it has no dismiss.** `Toast` is eight seconds,
tuned for an undo somebody is already looking at. A meeting that did not save is
still not saved eight seconds later, and a notice that removes itself can be
missed by being in another room. `StrandedBar` is up while the meeting is
stranded and goes when it is filed or discarded — the two things that make it
untrue. **The Retry is on the bar itself**: the whole failure is a person who
did not know there was anything to press, and putting the press three screens
behind a notice is the same bug with a sentence in front of it.

It stands down while anything is recording. `RecordingBar` holds that exact slot
and `zIndex` cannot arbitrate between two stacking contexts — and somebody
recording *now* is the one person who must not be pulled away from it. A meeting
that failed an hour ago will still have failed when they stop.

**What "stranded" means is derived, not re-decided.** `meetingNeedsAttention` is
`meetingLanding(record)?.retry != null` — "somebody has to do something" and
"there is something for them to do" are the same fact. A meeting on its way is
not stranded, or the bar would be up after every meeting anybody records; a
session that captured nothing is not stranded either, because nothing was lost.
The list badge takes the same answer: a refused meeting keeps `finalizing`, so
the list used to spell it "Finalizing" in the warning tone, identical to one a
second from landing.

**What a "simplification" would cost.** Reading `stranded` as "has no note path"
puts the bar up after every recording and teaches people to ignore it. Routing
both Retries to `meetings.retry` sends a sync retry at a finalize that never
completed. Dropping the stand-down draws two bars in one 66pt of glass. Going
back to `retrySync` in the recovery path restores the defect this section
opens with, and the check that fails is `the retry actually asks the gateway
again, rather than stamping a clock`.

**Resolved by the next section (2026-09-23), and the paragraph kept for the
argument:** resuming a meeting into the
same note. The client state table allows `failed -> recording` and nothing emits
it; the gateway short-circuits a finalize on an already-complete session rather
than rewriting the claimed path, which is what keeps a crash-retry from forking
somebody's bucket into near-duplicates. Continuing a meeting therefore needs a
way to tell a retry from a continuation, and that is a gateway decision with the
customer's bucket on the other side of it.

## A resumed meeting is a new part spliced into the note it already has (2026-09-23)

Somebody stops a meeting for a break, its note lands, and the meeting starts
again. The design (the resume offer on the note, a floating bar, the recording
view) asked for one file and one meeting out of that. What was built, and why
each piece is the shape it is:

**A part is a new session, not the old one reopened.** The paragraph above
names the trap: the gateway short-circuits a finalize on a `complete` session so
a crash-retry cannot fork the bucket, and the client state table never emits
`complete -> recording`. Reopening would mean weakening the one guard that
keeps retries idempotent. So `complete` stays terminal, and a part is a fresh
session with its own id and clock, carrying `MeetingRecord.continues`: the
note's path, the meeting it continues (the first part's `meeting-id`), how much
was already recorded (`offsetMs`), when it stopped, and which part this is.
`continues` is client-local like `destination` and is validated on the way back
off disk (`parseContinuation`: a safe `.md` path, a real meeting id, a
non-negative offset, a part of at least 2).

**The part is spliced into the note, never re-rendered over it.** The note has
been the customer's since it landed: they may have corrected the summary,
retitled it, or typed under `## My notes`. `continueMeetingNote`
(`packages/meetings/src/note.js`) is a pure function of the current text and the
part. It rewrites only `updated`, `ended` and `duration`, and only if those
lines are still there, because a key somebody deleted stays deleted. It appends
the part's notes after the last line of `## My notes` and its transcript after a
seam at the end of `## Transcript`, with clocks and flags moved by `offsetMs` so
the meeting reads as one. The seam line,
`_Resumed 2026-09-21 14:14:03 UTC, 18m after it stopped._`, is also the
idempotency marker. This write is an overwrite by design, so the create-only
rule that makes a first finalize safe does not apply. A part whose seam is
already in the note is a part whose write landed and whose answer was lost, and
`continuesMeetingNote` answers that without writing again.

**Read, splice, write back with the etag that was read.** The phone's writer
(`convexGateway.continueInto`) reads the note through `files.readNote`, which
follows the forwarding ledger, so a note that was moved is still found. It
writes through `files.writeNote` with `expectedEtag`, which merges through the
collaboration engine from that exact base. Somebody typing into the note
between the read and the write turns the write into a `CONFLICT`, and the
writer reads and splices again, three times, then hands the part back to the
queue as `unavailable` with a sentence of its own (`noteBusy`). It never
overwrites.

**When there is no note to add to, the part is filed as its own note.** That
covers a note that was deleted, is encrypted, is read-only to this person, or
whose `meeting-id` is not this meeting. It is worse than one file and still
acceptable: the part is somebody's meeting, and a missing destination is never a
reason to lose it. The id comparison is the guard against splicing one meeting
into another note that took its path.

**Only a writer that can do this offers it.** `MeetingsGateway.canContinue` is
true on the phone and web writer (`convexGateway`, when it was given
`readNote`). The desktop shell and the HTTP gateway do not continue notes yet,
say so, and nothing offers Resume over them, because an offer that says "same
file, one meeting" over a writer that would file a second note is a false
claim. A part that reaches such a writer anyway is filed as its own note.

**One set of rules for every surface** (`features/meetings/resume.ts`). A
meeting is offered back only when it is saved, nothing is recording, no part of
the same meeting is still on its way or stuck, and the writer can continue.
A part in flight belongs to the red bar and its Retry, and a second part on top
of an unlanded first would splice out of order. The next part continues from
the newest part that landed. From the note itself, the offset and part number
are read off the file (`meetingNoteFacts`), because another device may have
added a part this one never saw.

**Two places: the meeting and the `+` (redesigned 2026-09-23).** The first
version offered Resume on five surfaces: a floating teal bar, a teal band in
the note, buttons on the meeting page and in the panel, and a "Part N" chip on
the recording view. The owner called it "SO ugly", and the rule that came out
of that is in [app-and-console](../app-and-console.md): no UI ships without a
design audit first. The audit found one verb drawn five times, the accent used
as a status colour, the hero button used four times, the undo glyph standing
in for recording, and copy about parts and files. Resume now lives in two
places, both built from existing parts:

- **The meeting itself.** On a phone, the meeting's page carries the same
  record disc as the meetings list (`RecordButton`), standing down while
  anything is stranded. In the console's Meetings panel, a past meeting has
  the live card's own button pair: "Open the note" and a quiet "Resume" marked
  with the red record dot. Stop & save leaves the panel on the meeting that
  just ended, so Resume sits one row below where Stop was.
- **The `+`.** A "Resume meeting" row sits directly above New meeting in both
  `+`s (the console menu and the phone sheet), because the failure it prevents
  is pressing New meeting and getting a second note. When the open note is a
  meeting note that may be continued, the row says "Adds to this note." and
  continues that note, which also covers a meeting another device recorded.
  Otherwise it names the newest meeting on this device, within
  `RESUME_RECENT_WINDOW_MS` (two hours, a default picked for "a break in the
  middle of a meeting", not decided by the owner). `resumeRowFor` decides.

Nothing is drawn until somebody goes to record, so nothing needs dismissing,
and `resumeDismissed` is gone (old records carrying it still load). Continuity
is shown rather than explained: a resumed meeting's clock, and the stamps on
notes typed during it, run on the meeting's time (`meetingElapsedMs`), so part
two opens at 31:04 and not 0:00. The word "part" is never on screen. While a
part records, its title is not editable, because the heading it lands under
is the note's.

The meetings list and the panel's Recent list show one row per meeting
(`oneRowPerMeeting`), the newest part, with the whole meeting's length.

**Still open:** a later part's own page shows only that part's summary and
transcript; the desktop and HTTP writers do not continue.

**What a "simplification" would cost.** Re-rendering the note from the device's
records instead of splicing erases every edit the person made between parts.
Dropping `expectedEtag` makes the write create-only and every resume fails.
Skipping the seam check adds the part twice on every lost answer. Dropping
`continues` from the controller's event fold, the bug this change first shipped
with in its own branch, files every part as a second note.
`meetingsResume.test.ts` and `continuation.test.mjs` fail for each of these.
