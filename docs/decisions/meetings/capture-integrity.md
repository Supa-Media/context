# Meetings — capture integrity

### A session that captured nothing is not filed

The owner's other bug report, found on the same machine the same day: four
empty notes in the bucket, one per recording attempt where the microphone was
never granted, each "0 min, typed session" with no transcript and no typed
notes. The write path was faithfully filing nothing — `finalizing -> complete`
had no floor under it, so a session with literally no content in it produced a
note exactly the way a real one does, placeholders and all.

`hasNothingCaptured` in `packages/meetings/src/session.js` is the one rule:
`session.transcript.length === 0 && session.notes.trim() === ""`. Both halves,
because either one alone is a real meeting — a transcript with no typed notes,
or typed notes with no audio at all (`a meeting nobody recorded still
finalizes`, above), are both meetings this product exists to capture. Only the
conjunction is nothing.

**A session that qualifies moves to a new terminal state, `empty`, rather than
being refused, silently dropped, or read as `failed`.** Each of the
alternatives was wrong for a different reason: refusing the finalize forges a
retry loop against a client that did nothing wrong; dropping it silently is
the exact "appears to work and does nothing" defect this repository keeps
finding elsewhere; and `failed` already means something specific — a capture
problem a retry might fix — which a session with nothing in it is not: there
is nothing to retry, only a meeting to record again. `MEETING_TRANSITIONS`
gained `finalizing -> empty`, terminal like `complete`, and `MeetingSession`
gained `emptyReason`, on the same rule `failureReason` follows (null in every
other state, set on the way in, and never rewritten).

**The gateway decides, never the client alone, and the check is re-run rather
than trusted.** `finalize -> empty` is a `GATEWAY_EVENT_TYPES` member, beside
`written`, and for the same shape of reason: a client able to assert `empty`
unchecked could make a real transcript disappear as easily as report an
honestly empty one. Unlike `written`, though, there is no asymmetric knowledge
here — a client holds the same transcript and the same notes the gateway does
— so `applyEvent`'s `empty` case re-derives `hasNothingCaptured` from the
session it is actually folded onto and refuses the event outright if the
session has content, rather than trusting whoever sent it. That is what makes
it safe for a client to fold *and* for the gateway to fold, from the same
function, with the same guarantee either way.

**The reason is the client's to give and the gateway's to accept or replace.**
`FinalizeBody.emptyReason` is an optional hint — "microphone not granted" reads
better on a badge than a sentence the gateway would otherwise invent — capped
at `REASON_MAX` and never a trigger: a client naming a reason on a session that
turns out to have content is simply not read, because `hasNothingCaptured`
decided the outcome before the reason was ever looked at.

**Where each surface stops it, and why it is not the same layer twice.** The
gateway (`apps/mcp/src/meetings/ingest.js`, `finalizeSession`) is the one
choke point for the desktop app's HTTP path and is authoritative regardless of
what any client does or fails to do — a future client that never learns this
rule still cannot write an empty note. The phone's Convex path
(`apps/mobile/features/meetings/convexGateway.ts`) has no gateway process of
its own to be authoritative *for* — this app composes the note directly, the
way `docs/decisions/meetings.md`'s "A meeting is written the way a note is"
section already describes — so `controller.end()` (`apps/mobile/features/
meetings/controller.ts`) checks `hasNothingCaptured` locally, before `sync()`
ever runs, and `convexGateway.finalize()` checks it again as a backstop in
case that first check is ever bypassed. Neither is redundant: the controller's
check is what stops the request from ever being made, and the gateway's is
what stops the request from ever succeeding if it is.

**Nothing about `.meetings/` records changes.** `finalizeSession`'s claim step
is skipped entirely for an empty session — no path is ever reserved, so there
is nothing for `releaseClaim` to give back — and the session record itself
becomes the answer, the same way a completion receipt is for a written note.
`upsertSession`, `appendSegments` and `replaceNotes` all treat `empty` as
terminal, the same as `complete`: a stray segment or a note typed after the
fact is refused rather than silently reopening a meeting that has already been
decided to have nothing in it.

**Nothing is written, and nothing is filed — but nothing is forgotten either.**
No `0-inbox/meetings/*.md` is created. The session record persists (on the
gateway path) or lives on the device (on the Convex path) with `state: empty`
and `emptyReason` readable back, so the console shows "Nothing was captured:
`<reason>`" and offers Record again — `apps/mobile/features/meetings/
MeetingNoteScreen.tsx`'s `Landing` component, checked before the generic
`notePath === null` branch so an empty session is never told "Not in your
bucket yet, sent as soon as your context answers", which would be a promise
this session can never keep.

**Nothing is deleted, because there is nothing of a recording left to delete.**
The question a review has to ask of a rule that files no note is whether it
throws away a recording, and the answer is a property of the product rather
than of this code: *audio is never persisted by us* — no adapter writes audio to
the bucket, a chunk kept on the phone is kept only until its words land (*Audio
nobody has transcribed yet is kept on the device*, above; a meeting with any of
it waiting is never `empty`), and `empty` writes and
deletes nothing at all: no note, no claim, and the session record itself stays
readable with its reason. So the case that looks like data loss — a meeting
whose audio was captured and whose transcription failed on every chunk, which
is a defect this repository has had — is a meeting whose audio was already gone
under every version of this rule. What `empty` costs it is the note that would
have recorded that the meeting happened at all, and what it buys is that the
person is told, in the app, instead of finding a blank file in their bucket.

The one thing that must not survive that is a wrong sentence. A device's
`emptyReason` is a guess about its own microphone, and on the path where **this
gateway took the audio** it is a guess that is wrong in the direction somebody
acts on — they go and check a permission for a recording that really happened.
`transcribedChunks` is spent before a byte is forwarded, so the gateway knows,
and its own sentence replaces the hint: `Audio was recorded, but none of it
could be transcribed.` The check is `...but it is not told the microphone was
the problem, because this gateway took the audio`.

The checks are `hasNothingCaptured` and the `empty` event's own guard in
`packages/meetings/test/session.test.mjs` (both halves required; a transcript
alone or typed notes alone are real meetings; the event is refused on a
session that captured something; the reason is capped, not rejected; replay is
idempotent), the gateway's in `apps/mcp/test/meetings.test.mjs` (no note
written, the reason round-trips through a `GET`, a re-finalize answers with
the same reason, a stray segment or note after the fact is refused, and a
client-named reason on a session that turns out to have content is not what
decides the outcome), and the phone's in
`apps/mobile/__tests__/meetingsController.test.ts` and
`__tests__/meetingsScreens.test.ts` (the gateway is never asked at all, the
device's own capture reason is used when there is one and a generic sentence
when there is not, and the screen never claims "not saved yet" about a session
that will never be saved). **The test that fails if this is reversed:** record
a session with no transcript and no typed notes and finalize it — with the
rule, `state` is `empty` and the bucket gains nothing; reversed, a fourth empty
note lands beside the three the owner already found.

### A recording that has outlived its own capture is failed, not counted

Found the same way the two decisions above were: on the owner's own Mac, after
a reinstall and a relaunch. The app came back showing a live recording bar
counting **2 hours 41 minutes**, no capture window behind it anywhere, and the
meeting row itself sitting as a Draft. Two defects, the same shape as the level
meter that always read zero and the failure label that always blamed the
microphone: an indicator that says the same thing whether or not the thing it
describes is happening.

**The first was in the console's own boot path, and it is the more serious of
the two.** `MeetingsController.configure()` — "the phone's nearest thing to a
launch," in the same sense `recoverStaleFinalizes` already reads that sentence
— restores whatever `loadMeetings` finds on disk and, until this fix, believed
a record that read `recording` or `paused`. `elapsedMs` in `session.js` is
`recordedMs` plus `now - runningSince`: honest while a real recorder is
feeding it, and simply wrong once the process that opened that recorder is
gone, because nothing ever told the restored session so. A relaunch is
therefore not merely *a* moment this can happen, it is **the only** moment it
can: every `MeetingRecorder` this app can hand `configure()` —
`capture/audio.ts`, `capture/audio.web.ts`, `capture/desktop.ts`,
`capture/notesOnly.ts` — is a fresh object that starts at `"idle"`, and none of
them has an OS API to ask "is something already recording session X". So a
`live` record surviving into a fresh `configure()` is proof, not suspicion,
that whatever process was capturing it is gone.

**The second was in the desktop shell's own tray-path recorder, and it is the
subtler one: `MeetingController.elapsedMs()` in `apps/desktop/src/core/
recording/controller.ts` was `now - startedAtMs`, unconditionally — the exact
sentence `core/tray/presentation.ts`'s own `TrayInput.elapsedMs` docblock used
to carry, word for word: "wall clock since the recording started."** That is
correct only as long as nothing can stop capturing without saying so, and
something could: `main/capture.ts`'s hidden capture window can crash
(`render-process-gone`) or be torn down by anything other than this class's
own `stop()`, and until this fix nothing told the controller when it did.
`MeetingController.fail()` already existed — `MEETING_TRANSITIONS.failed` has
allowed `recording -> failed` and `paused -> failed` since the finalize-
deadline work above needed them — but **nothing in the whole app ever called
it**. A capture that died mid-meeting left `#capturing` on the recorder
answering `false` (honest) beside an elapsed clock climbing from a timestamp
regardless (not), which is a machine that already knew the truth and an
interface that declined to ask it.

**The choice, for both: `fail`, never a silent reset and never an automatic
finalize.** Three options were on the table and two of them cost something
specific.

- **Silently resetting to `idle`** erases the transcript and the notes already
  captured — the same loss `hasNothingCaptured` already refuses to manufacture
  by writing a blank note, arriving one state earlier and by omission instead
  of by commission. A person who typed for ten minutes before a restart would
  find nothing anywhere.
- **Finalizing it automatically, unasked,** writes a note under a title and to
  a destination the person never confirmed as final while the meeting might
  merely have been *interrupted* by the restart rather than *over*. This
  product's whole complaint about a meetings feature that decides things on
  its own is `docs/decisions/meetings.md`'s own "the human's words are never
  rewritten" — deciding a meeting is finished is a bigger claim than that.
- **`fail`**, which is what shipped, does neither. It closes the open interval
  at the moment of discovery — `session.js`'s `fail` case already does this
  exactly right, via `closed()`, and the desktop controller's `fail()` now
  matches it by stopping the recorder for an authoritative count rather than
  trusting its own bookkeeping — so `elapsedMs`/`recordedMs` read precisely
  what was captured and no more. It keeps the transcript and the notes
  untouched. It is visible: `meetingBadge` in `apps/mobile/features/meetings/
  format.ts` already renders `failed` as "Failed — `<reason>`" rather than
  "Draft", which is the fix a reader sees without reading a line of this file.
  And `failed -> finalizing` already existed for the stuck-finalize case above,
  so **a recovered session reaches finalize through the same door a stuck one
  does** — `retryFinalize` on the phone, and pressing End again in the
  desktop's own notepad (`end()`'s `this.#moveTo("finalizing")` accepts
  `failed` the same as `recording`) — composing with the finalize-deadline and
  nothing-captured rules rather than a second mechanism beside them. A session
  reconciled this way with nothing in it still reaches `empty`, not a blank
  note, through the exact same `hasNothingCaptured` check every other path
  already goes through.

**The reason is the device's, not the meeting's**, the same distinction
`captureError` already draws on the phone: nothing about the conversation
failed, this app's own process ending mid-recording is what stopped capturing
it — `INTERRUPTED_RECORDING_REASON` on the phone, the recorder's own crash
message on the desktop (`"the capture window's renderer stopped (<reason>)"`
or `"...closed unexpectedly"`), never a sentence that reads as the meeting's
fault.

**Deliberately not run from `sync()`, and not on the fast-path `configure()`
that keeps a live recorder.** `MeetingsController.configure()`'s existing
same-workspace branch — the one `retainedRecorder` exists for, because a
recording has to survive a screen remounting — returns before the
reconciliation runs, on purpose: the guarantee above ("a fresh recorder is
always idle") holds only at the one moment a *fresh* recorder was actually
handed in, and running this on every remount would fail every meeting the app
is legitimately still recording the instant a screen unmounts and remounts.
`recoverInterruptedRecordings` is therefore a sibling of
`recoverStaleFinalizes` with a narrower trigger, not a periodic check: it runs
once, at the boot branch only.

**On the desktop side, the tray gained a sixth state to say this honestly.**
`core/tray/presentation.ts`'s `TrayState` gained `"failed"`, with the
indicator **off** — the one state whose whole point is that nothing is
capturing any more — rather than reusing `recording`'s presentation with a
frozen number, which would have kept claiming a microphone was open the moment
after this fix taught the controller it was not.

**What a Mac cannot confirm, stated rather than assumed.** `main/capture.ts`'s
crash listener (`render-process-gone`, and `closed` guarded against the
window's own `stop()`) is reasoned from Electron's documented events and
verified by the launch smoke test starting for real, not independently unit
tested — the same limitation this file's own header already states about
system audio and the loopback tap: driving a real `BrowserWindow` needs a real
Electron process. What *is* tested, and is the layer that actually matters —
`MeetingController` never knows or cares whether `onDied` came from a real
crash or a test's `fakeRecorder().kill()` — is the full state machine this
signal drives: `apps/desktop/test/controller.test.mjs`'s "the app cannot claim
to be recording when it is not" block. Somebody has to crash the real hidden
window on a Mac and watch the tray go to `failed` rather than freeze.

The checks are `apps/mobile/__tests__/meetingsController.test.ts`'s "the app
being killed mid-meeting" describe block (a relaunch never resumes a running
timer, closed with exactly what was captured; a paused session is reconciled
the same way; a genuinely still-finalizing session is untouched; the
same-workspace fast path never fails a meeting that really is recording; what
was captured survives and Retry reaches a finished note) and
`apps/desktop/test/controller.test.mjs`'s new block (elapsed counts only while
audio is actually captured and freezes across a pause; a typed meeting keeps
plain wall clock, having nothing to lie about; a capture that dies mid-meeting
moves to `failed` with the frame already captured kept, the clock frozen, and
the indicator honest; a death with nothing captured yet is still `failed`
rather than silently `idle`; a `fail()` arriving after the meeting is already
`complete` is ignored rather than resurrecting it) and `apps/desktop/
test/tray.test.mjs`'s indicator sweep, widened to the sixth state.
**Sabotage, measured**: removing the mobile reconciliation call from the
boot branch of `configure()` — 3; running it on the same-workspace fast path
instead of only at boot — 1; reverting the desktop controller's `elapsedMs()`
to plain wall clock — 3; leaving `onDied` unwired in `begin()` so a died
capture is never reported at all — 6; dropping `fail()`'s own transition guard
so a message arriving after `complete` resurrects the session — 1; flipping
the tray's `failed` presentation to `indicator: true` — 2.
