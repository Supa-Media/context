# Desktop — microphone and recording

### The microphone is asked for just-in-time, and never a dialog that points at the wrong place

Found on the owner's first desktop recording, on hardware: macOS granted the
microphone mid-session, capture still could not open an input, and the session
degraded to an empty typed note. The panel's explanation was *"Open the menu
bar to grant it."* The menu bar cannot grant a TCC permission — only System
Settings can — so the one sentence this app showed about the failure sent the
person somewhere that does nothing, and a wrong instruction that looks like an
instruction is worse than none: it reads as followed.

**The just-in-time half of this was already correct**, and is worth stating
rather than re-deriving, because the fix here is narrower than it first looks.
Every real way to start a recording — the tray's Record, the panel's "Take
notes", and the console's `startCapture` — folds through one function,
`beginMeeting`, which calls `MeetingController.begin()`, which calls
`ensureCapturePermissions` and **awaits** it before either the transcriber or
the recorder is ever started (`core/capture/permissions.ts`,
`core/recording/controller.ts`). `not-determined` or an unreadable `unknown`
raises the system dialog and waits for the answer; `granted` proceeds;
`denied` or `restricted` refuses outright, with no dialog, because macOS
ignores a second prompt to a permission it already refused. The state only
ever moves to `recording` — the tray's red dot, the always-on indicator —
*after* that promise resolves and the recorder has actually opened, so there
is no window in which the indicator is on before the input is. A typed
meeting (`capturePlan` answered no channels) asks for nothing at all, which is
the other half of "never start a session that will silently produce an empty
note": a typed meeting is an honest, first-class outcome, never a fallback a
failed capture quietly lands on.

**The actual defect was one string.** `CONSOLE_NOTICES.permissions` in
`main/index.ts` — the sentence `explain()` shows in a message box when
`beginMeeting` reports `why: "permissions"`, and the one `startFromConsole`
throws for the page to render — read *"Open the menu bar to grant it."* It now
reads *"Open System Settings → Privacy & Security → Microphone, enable
Context, and record again."* The last three words are load-bearing rather than
decoration: `ensureCapturePermissions` re-checks `status()` fresh on every
`begin()`, so a person who grants it in System Settings and presses Record
again is not re-asked and is not told to restart the app — the sentence's own
instruction is what actually recovers the session, and `controller.test.mjs`
now checks the other direction of that promise as well: a permission already
`granted` before a session starts raises no dialog either, only
`not-determined` (or `unknown`) ever calls `request`.

Never assembled at the call site, like every sentence in `CONSOLE_NOTICES` and
`PLAN_NOTICES` — both are frozen closed sets for exactly this reason, stated in
`main/index.ts`'s own comment beside them: *"none is assembled here, for the
reason those sets exist."* A message box is exactly where a channel name or a
fragment of a payload ends up if a sentence is built rather than looked up.
`appShell.test.mjs` reads the frozen object as text and checks every key whose
name contains "permission": none may mention the menu bar, all must name
System Settings, all must say "record again". A key added next year for
Screen Recording specifically is covered by the same regex without this file
being edited to know it exists.

**The Mac confirmation**, for the one thing no offline suite can check: a real
TCC prompt, raised at the right moment, on real hardware.

```
tccutil reset Microphone lc.context.desktop
```

then launch the app and press Record. The system dialog must appear before the
tray's dot turns red — never after, and never silently skipped — and answering
it must be what decides whether the dot turns red at all. A build that shows
the red indicator, or reports `recording`, before that dialog has been
answered is the defect this section exists to close, whatever the panel's
copy says.

**A grant that still cannot open is not the same failure as a refusal, and
does not get the same sentence.** The same hardware session that found the
wrong string found a second one once the first was fixed: the app was already
running when macOS recorded the grant, mid-session, and every attempt after it
— for the rest of that process's life — still could not open an input, while
the panel kept showing *"macOS has not granted this app the microphone
yet... record again"*, even though TCC's own answer was `granted`. That
sentence's own instruction is what a person had just done; showing it again
reads as "that didn't work" about an instruction that was never wrong.

`status()` is not the liar here — `getMediaAccessStatus` is asked fresh on
every `begin()`, exactly as the section above describes, and it honestly
answers `granted`. What lags is AVFoundation's own per-process authorization,
which can hold the answer a running process observed the first time it asked
until that process relaunches. So `ensureCapturePermissions` can report `ok`
and the recorder's own `start()` can still throw, and `MeetingController.begin`
now tells the two failures apart by `why`: a refusal is still `"permissions"`,
and its recovery is still System Settings; a grant the recorder still could
not use is `"stale-permission"`, reported with an empty `missing` — nothing is
missing, this process is — and its recovery is `CONSOLE_NOTICES
.staleMicrophoneGrant`, *"Quit and reopen Context to pick up the microphone
permission"*, the one instruction that actually works. Collapsing the two
back into one `why` is the exact regression: `controller.test.mjs` pins it with
a broker whose status flips from `not-determined` to `granted` between two
`begin()` calls on the same process while the recorder keeps refusing to open,
and `appShell.test.mjs` pins the sentence itself, the same way it pins
`permissions`'s.

### Twenty is less than thirty, and every recording died of it

Found on the owner's own hardware, driven by the real Record button over a
27-second meeting, with `globalThis.fetch` patched in the main process. Four
requests, in this order:

```
1. POST /meetings/sessions/mtg_76b6…/transcribe  → 404  error="meeting_forbidden"
2. POST /meetings/sessions                       ← the session row, AFTER the audio
3. POST /meetings/sessions
4. POST /meetings/sessions/mtg_76b6…/finalize
```

One transcribe attempt in twenty-seven seconds, for two chunks of audio. **Every
desktop recording was transcription-dead from its first chunk, on every machine,
deterministically.** Capture itself was perfect: the microphone was live at
48 kHz with real signal, `dataavailable` fired at +24 s carrying 322 kB, the
rotation reopened correctly and the stop chunk assembled in a millisecond. The
audio was captured and then thrown away by the gateway, and the client then
permanently gave up on the meeting.

The whole of it is three numbers in three files:

```
packages/meetings/src/chunks.js   SEGMENT_MS        = 20_000   ← chunks rotate here
core/sync/drain.ts                DRAIN_INTERVAL_MS = 30_000   ← the outbox drains here
main/index.ts                     a session write waited for that timer
```

**20 < 30, always.** So the first chunk of audio reached a gateway that had never
heard of the session, `sessionGone()` answered `404 meeting_forbidden`,
`main/transcribe.ts`'s `permanent()` read the 404 as final, `gatewayTranscriber`
set `givenUp`, and every remaining chunk of the meeting was **silently dropped**
— including all the ones that would have succeeded the moment the row landed at
t≈30 s.

#### Two fixes, and neither is sufficient alone

**The session row does not wait for the timer.** `drainUrgency` in
`core/sync/drain.ts` answers `"now"` for a `session`, `"await"` for a `finalize`
and `"timer"` for the other two, and both writers read it: `MeetingController`
for a meeting the tray started, `writeMeetingFromConsole` for one the page
started. It matters that both do — the one-line version of this fix, in
`main/index.ts` alone, would have left every **tray-only** recording (the reason
the shell exists at all) broken exactly as it was.

**And it hangs off `begin()`, not off the queue call.** Found reviewing this
change rather than while writing it, and it is the reason that line is not the
tidier one inside `#queue`: `#queue("session", …)` also runs from `title()`,
which the notepad calls on **every keystroke of the title field**. A drain
attached there would be one HTTP request per keystroke — the exact failure
`SYNC_THROTTLE_MS` and `reconcileDrain` both exist to avoid, introduced while
fixing a different one. What races the first chunk of audio is the *first*
session write of a meeting, and `begin()` is the only place that happens. **The
test that fails if this is reversed**: `sessionOrder.test.mjs`'s *"TYPING A TITLE
IS NOT A REQUEST PER KEYSTROKE"*, which is green on `main` (nothing drains) and
green now, and red for exactly the one placement in between.

It is a **fire-and-forget** drain rather than an awaited one, and that is the
trade worth naming rather than discovering. Awaiting a network round trip on the
path that starts a meeting would chain behind whatever drain is already in
flight — up to twenty-five requests on a machine that just came back online —
and hold up the press of Record for all of it. Nothing is bought by waiting: the
recorder is already open by then, `drain()` is chained so at most one pass is
ever out, a failure earns the queue's own backoff rather than a storm, and the
page already learns about a parked meeting at the next write it makes. What it
costs, stated: on a long queue the new session entry is at the back of
`nextDrain`'s ordering and may not make it into this pass, in which case it goes
out on the timer as before — which is the case the second fix exists for.

**A 404 is not a permission, and the gateway is not where this gets fixed.**
`sessionGone()` answers the same way for "another workspace's", "never existed"
and "not written yet", and **that is the tenant-isolation guarantee rather than
a defect**: one code for "not yours" and "not there" is what stops a caller
enumerating another workspace's meetings by watching which id answers
differently. `apps/mcp` is untouched by this change and must stay that way. The
ordering belongs on the client, which is the side that knows it sent two
requests.

So: **405 and 501 stay permanent** — 501 is the gateway's own documented "no
transcription service is configured here" and 405 is a route that does not take
a POST, both stable facts about a deployment — and **every 404 is provisional**,
not only the one carrying `meeting_forbidden`. A bare 404 from a proxy, a
gateway too old to have the route, a captive portal answering plausibly: none of
those is worth a meeting when 501 is the answer a deployment without
transcription actually gives. **One unlucky 404 must never discard a meeting.**

`permanent()` therefore answers false for a 404 and `notYet` carries it as its
own fact, so `gatewayTranscriber` can put it on a clock:
`NOT_YET_GRACE_MS = 2 * DRAIN_INTERVAL_MS`, armed by the first such refusal and
**reset by any success**, so an intermittent 404 in a healthy meeting never
accumulates toward it.

**A clock, and not a count of refusals**, which was the first version. A count
is a proxy for time that stops being one the moment anything moves: lengthen
`SEGMENT_MS` and the same count is four minutes, drop chunks at
`MAX_INFLIGHT_CHUNKS` and it is spent with no time passing at all. Two drain
periods is the quantity that actually matters — *long enough that the outbox has
certainly had its turn, twice* — and it is derived from `DRAIN_INTERVAL_MS`
rather than typed out, so it stays true when either number moves.

**What was rejected: "permanent once the session write is known flushed."** It
was the other candidate and it is worse exactly where a bound is needed. It
wants the queue's state inside the recorder — a coupling from `core/capture` to
`core/sync/outbox` that does not exist — and, having paid for it, it is
**unbounded in the case that matters**: a session write that is *parked* (a
grant that cannot file meetings privately, which `postEntry` refuses before the
network) never becomes flushed, so a meeting that will never be known would go
on uploading a full chunk every twenty seconds for its whole length. The case it
would protect — a machine offline long enough for the row not to land — is
already covered, because an offline machine's chunks fail as **network** errors
rather than 404s, and those have never counted against anything.

The bound is a bound rather than an absence for the same reason: "the meeting
really is another workspace's" is a real state, and without a ceiling this
uploads about a minute of audio — three chunks, roughly a megabyte — before it
stops. That is the price of never discarding a meeting on one unlucky reply, and
it is the right way round.

The two fixes are independent by construction, and the checks show it: the
arithmetic fix makes the row *early*, the 404 fix makes a late row *survivable*,
and sabotaging either one alone still reddens `sessionOrder.test.mjs`.

#### The reason nobody could see it, which is the durable part

`CaptureStateUpdate` was `{state, capturing, fault}`. The transcriber raises
`CAPTURE_NOTICES.refused` — *"this meeting is not being transcribed"* — and there
was **no member on the bridge for it to travel on**: the shell said the sentence
to its own tray and its own panel, and the console drew a recording that looked
perfectly healthy. `CaptureStarted.notice` carried the sentence a meeting
*starts* with; nothing carried one it acquired. So the only place this defect
surfaced was an empty transcript, afterwards, and it survived a day of use.

The field is now `notice: string | null`, which is the shell's own
`SessionView.notice` — the same value the panel and the tray have always read,
rather than a second one. **All four sentences cross, not only the refusal**:
the transcriber's `dropped`, `failed` and `refused`, and `capturePlan`'s own
about system audio. They are one field on the shell's `SessionView`, so a field
that carried only the worst of them would be a second decision about which
sentences matter, taken in the wrong process.

A plain string and not a second `CaptureFault`: the recoverable bit would be the
only other thing to carry, nothing in `apps/mobile` reads it, and each of these
sentences already says what it means for the rest of the meeting.

**And it is rendered.** `capture/desktop.ts` reports it once per change — the
shell pushes state on every segment, so reporting it every time would rebuild
the app's snapshot for a sentence that has not moved — the controller puts it on
`captureError`, and `LiveMeetingScreen` draws it as the transcript chip, where it
outranks "Listening". A field nothing displays would repeat this defect one
layer up, so the last link is a check of its own:
`meetingsScreens.test.ts`'s *"a notice from the recorder replaces the transcript
chip"*.

**`BRIDGE_VERSION` moves 3 → 4; `MIN_BRIDGE_VERSION` stays 1.** Both new fields
are absences a normaliser fills in — `null` and `0` — so nothing would break
without the bump, and rows 1–3 of the required-members table are untouched, as
they must be: a shell in somebody's Applications folder answers the number that
was true when it shipped. The number moves anyway because **the ceiling records
what a shell can be asked to say**, and "this build cannot tell you why it
stopped transcribing" is a fact about a shell that somebody staring at an empty
transcript has to be able to read.

#### And the second number, which is what made any of this findable

`RecorderSummary.frames` has been counted in `main/capture.ts` since the
recorder was written. It was read once, for `recordedMs`, and thrown away — so
`CaptureSummary` answered `segments` and nothing else, and **`segments: 0` had
two entirely different meanings with the same shape**: a microphone that
produced nothing, and audio the far end would not take. Different faults,
different fixes, and the only way to tell them apart was patching `globalThis`
`fetch` in the main process by hand. That is how this defect was found, and
nobody should have to do it twice.

So `CaptureSummary` carries `frames` beside `segments`, and the controller
counts them **while the meeting runs** rather than only at `stop()` — the
question "has this produced any audio" is worth being answerable during a
recording, which is when somebody is looking. `end()` reconciles against the
recorder's own count, which wins, because if a future recorder ever drops a
frame between its counter and the sink then the recorder is the one that knows.

What it deliberately does not do is put a sentence on a screen. `frames: 2,
segments: 0` is a diagnosis, and turning it into copy — "audio was recorded but
nothing was transcribed" — is a new user-facing claim in a closed set of
sentences, which is a decision rather than plumbing. The pair is on the payload;
the sentence, if it is wanted, is a separate change.

#### What no existing check could have caught, and the one that now does

**No test in this repository would have failed on any of it**, and that is the
real finding. Every piece was covered and every piece was correct:
`captureWindow.test.mjs` fakes `window.capture`, `controller.test.mjs` drives
`fakeRecorder`, `transcriber.test.mjs` drives a fake `send`, `outbox.test.mjs`
drives the reducer. **Nothing ran two of them against one clock**, and the defect
lived exactly in the seam — the same shape as the census that came to describe a
layer nobody had built: a guard tells you about the code it is pointed at, and
nothing was pointed here.

`test/sessionOrder.test.mjs` composes the real controller, the real queue, the
real drain, the real transcriber and the real `transcribeChunk` against one fake
gateway that records the order of what arrives **and refuses a chunk for a
session it has not been told about**, exactly as the real one does. That last
part is what makes an ordering assertion mean something rather than express a
preference. It also runs the same harness with the fix withheld, so "20 < 30" is
a recorded observation in the suite rather than a claim in this file.

Its centre is the owner's own trace, replayed: a gateway that answers 404 until
the session write lands and 200 afterwards, with the early drain **withheld** so
the race is real rather than arranged away. The property asserted is not "the
transcript is complete" — a chunk refused by a 404 loses its words, and that is
by design, since audio is never queued and there is nothing to retry — it is
that **every chunk reaches the gateway and none is silently skipped.** Skipping
is what `givenUp` did, and it is what turned one unlucky reply into a whole
meeting of silence.

**One gap, stated rather than left implicit.** `writeMeetingFromConsole` — the
*other* writer, the path a meeting the page started takes — lives in
`main/index.ts`, which imports Electron at the top level and which this suite
cannot load. Withholding its drain reddens nothing that can be run. So four
narrow text checks read that file as bytes: that the console path asks
`drainUrgency` rather than naming kinds itself, that all three answers are acted
on, that the shell hands the controller a drain, and that the timer is still the
floor under both. **This is a guard for the accident, not the adversary**, in
the same sense as `consoleBridge.test.mjs`'s census, and it proves the rule is
consulted rather than that it is consulted correctly.

The first version of it was worse than that and is worth recording: a bare
search for `notice: view.notice` over the whole file **passed with
`captureStateUpdate` zeroed out**, because the renderer panel's `UiState` sets
the same field a few hundred lines up. Measured at 0 red. Scoping each check to
the body of the function it is about — `bodyOf`, which answers the empty string
for a name it cannot find rather than throwing, so a rename reddens two checks
and does not take the file down — is what makes them lower bounds instead of
decoration.

And one check holds the comparison itself, because the whole defect is one:

```js
SEGMENT_MS >= DRAIN_INTERVAL_MS || drainUrgency("session") !== "timer"
```

Lengthen a chunk, shorten the timer, or decide a session write can wait like the
other three, and it reddens. **The tests that fail if this is reversed** are that
line and `THE SESSION ROW REACHED THE GATEWAY BEFORE THE FIRST CHUNK OF AUDIO`.
Sabotage, measured, per file. **The race**, in `sessionOrder.test.mjs`:
withholding `requestDrain` reddens **6**, `drainUrgency("session") === "timer"`
**7**, moving the drain from `begin()` into `#queue` **1**, dropping the console
path's own drain **1**, and not handing the controller one **1**. **The 404**:
reading any 404 as permanent again reddens **6** there and **4** in
`transcribeRequest.test.mjs`; believing the deadline on the first answer **6**
and **5** in `transcriber.test.mjs`; removing the deadline entirely **4** and
**2**; not resetting it on a success **1**; taking 405/501 out of `permanent`
**2**; widening `notYet` to 501 **1**. **The payloads**: zeroing the notice in
`captureStateUpdate` **1**, zeroing `frames` in `stopFromConsole` **1**, renaming
`captureStateUpdate` so the text guard cannot find it **1**, dropping `notice`
from the normaliser **2** and `frames` **1** in `consoleBridge.test.mjs`,
dropping the controller's frame count **1** in `controller.test.mjs`, leaving
`BRIDGE_VERSION` at 3 **1** in the bridge package, and dropping the notice at its
consumer **1** in `meetingsDesktop.test.ts`.

Each is a different set of checks, which is what says these are separate
properties rather than one written many times.

`DRAIN_INTERVAL_MS` moved out of `main/index.ts` and into `core/sync/drain.ts` to
make any of that possible: the suite cannot load a file that imports Electron, so
a constant kept there is a constant no check can see. That is the smaller,
transferable rule — **a number that is half of an invariant does not belong in a
file the suite cannot read.**

**What is not verified, and cannot be from here.** Nobody has recorded a meeting
on a signed build with these changes. The end-to-end proof needs a person and a
Mac, and the specific thing to watch for is the first `POST /meetings/sessions`
preceding the first `POST …/transcribe`, followed by segments actually arriving
and a `## Transcript` in the note. It should no longer need a hand-patched
`fetch`: `CaptureSummary` now answers `frames` and `segments` separately, so
"two chunks, no words" is readable from the stopped payload. Everything above is
the suite and a typecheck, which is exactly the class of evidence that was green
while this shipped.

#### What an adversarial review measured, and the one number it moved

Re-run against the merge commit, on a second machine, driving the real
controller, the real outbox, the real drain and the real transcriber. Every
sabotage row above reproduces — `requestDrain` withheld **6**, `drainUrgency`
returning `"timer"` **7**, every 404 permanent again **10** across two files,
the deadline believed at once **11**, no reset **1**, the drain in `#queue`
**1**, the console arm reverted **2**, the normaliser dropping `notice` **2** and
`frames` **1**, `BRIDGE_VERSION` left at 3 **1**. The `main` baseline is **1161**
here, not the 1160 in the change's own count; 1224 with it, and 1228 with the
check below.

**The residual is one missed pass, not an arbitrary queue.** *"On a long queue
the new session entry is at the back of `nextDrain`'s ordering and may not make
it into this pass, in which case it goes out on the timer as before — which is
the case the second fix exists for"* is true once and stops being true twice. A
pass carries at most 25 entries and costs a whole `DRAIN_INTERVAL_MS`, so the
delay is a pass per 25 entries while `NOT_YET_GRACE_MS` is two passes flat.
Measured end to end, one chunk per 20 s against a timer every 30 s:

```
entries already queued when the meeting starts   session row     transcript
   0 –  24                                       t ≈ 0 s         whole meeting
  25 –  74                                       t = 30–60 s     all but the racing chunks
  75 and up                                      t ≥ 90 s        NONE — given up
```

Seventy-five queued writes is not exotic: one earlier meeting recorded offline
queues a `segments` write every twenty seconds. So a person who records
offline, comes back online and starts a second meeting straight away still gets
an empty transcript, by the same mechanism, after this change — and the app says
so, which is new, but says it about a meeting that is already lost.

It is a residual and not a regression — on `main` every meeting failed at any
queue depth — and closing it is a different change: the session row has to
**jump** the queue rather than ride a pass, which is `nextDrain`'s ordering
contract and belongs in its own PR with its own argument. Raising
`NOT_YET_GRACE_MS` is not that fix; it buys one pass per period and costs a
megabyte of audio per period on a meeting that really is refused.
`sessionOrder.test.mjs` pins the side that must keep working — a meeting begun
behind a full pass still gets its transcript — so the deadline can never be
shortened back below the timer it exists to outlast.

**The racing chunks lose their words, and that is the design.** Two checks say
so already and it is worth stating as a property rather than an aside: the 404
deadline saves **the meeting, not the chunk**. `gatewayTranscriber` has no
retry, because audio is never queued, so every chunk cut before the row lands is
words nobody gets — up to two of them on the ordinary path once the row is
early, and the person is told `CAPTURE_NOTICES.failed`, which is true rather
than reassuring.

**What holds under the cases nobody asked about.** Two `begin()` calls in quick
succession write one session row and start one drain — the second is refused by
the state machine, not deduplicated downstream. A meeting begun with no network
records, queues its row, says only the recoverable sentence, and transcribes
from the first chunk after the network returns. And an outage longer than
`NOT_YET_GRACE_MS` does **not** consume the deadline, because a failed `fetch`
is not a 404 and never arms it — which is the property the clock buys over a
count, checked rather than assumed.

#### The residual closes: the session row jumps the queue, and the table above no longer applies

The paragraph above named its own fix and declined to build it: *"closing it is
a different change: the session row has to **jump** the queue rather than ride
a pass, which is `nextDrain`'s ordering contract and belongs in its own PR with
its own argument."* This is that PR. The 74/75 table measured a **selection**
defect — `nextDrain` had no opinion beyond `queuedAt`, so a `session` or
`finalize` head queued after a deep backlog of other sessions' `segments`/
`notes` wrote its position in that backlog rather than in front of it — and a
selection defect has a selection fix: `selectionRank` in `core/sync/outbox.ts`
sorts a `session` or `finalize` head ahead of every `segments`/`notes` head,
before it ever reads `queuedAt`, regardless of how many of the latter are
queued. Nothing is reordered on disk; `nextDrain` simply stops treating the two
tiers as one list.

**The table is retired rather than amended, because there is no threshold left
to put in it.** The old table's whole shape — a queue depth on the left, a
transcript outcome on the right — assumed the delay was a function of position
in a FIFO list, which is exactly what stopped being true. Driven at the depth
that failed and an order of magnitude past it (`sessionOrder.test.mjs`, "A
MEETING BEGUN BEHIND A QUEUE THAT IS ALREADY DEEP"): a session row queued
behind a 120-entry backlog is still the first HTTP request the pass makes, and
so is one queued behind 750. The meeting transcribes from its first chunk with
no race and no notice, at both depths, because the row is no longer competing
for a place in the pass — it is simply asked for before the backlog is.

**Two guarantees the jump must not cost, both checked rather than assumed.**
First, that it is a priority over what is *ready*, never a reason to wait on
what is not: a `session` write this gateway will never accept parks (or backs
off) exactly as before, drops out of `nextDrain`'s ready set the moment it
does, and a lower-priority write behind it goes out on the very next request
rather than waiting on a slot the stuck entry keeps winning — driven in
`outbox.test.mjs` at the reducer level and again in `sessionOrder.test.mjs`
against a real `drainOnce`, both directions (parked and merely backed off).
Second, that the jump is a selection rule and never a reorder: a session's own
`session → segments → notes → finalize` order is untouched, because
`selectionRank` only ever picks among different sessions' *heads* — the
per-session ordering `KIND_ORDER` already enforced never changes — and two
meetings whose writes are woven through each other and through a hundred-entry
backlog each still drain in their own contract order, independent of the
other, independent of the backlog (`sessionOrder.test.mjs`, "TWO MEETINGS BEGIN
WHILE A HUNDRED-ENTRY BACKLOG IS STILL DRAINING").

**Sabotage, measured.** Reverting `nextDrain`'s sort to plain `queuedAt` —
equivalently, making `selectionRank` return the same rank for every kind —
reddens **10** across `outbox.test.mjs` and `sessionOrder.test.mjs`. Removing
only the backoff arm of the readiness filter (`nextAttemptAt <= now`) reddens
**4**: two pre-existing (`outbox.test.mjs`'s own backoff check and
`gateway.test.mjs`'s "a session that cannot send its head does not send its
tail") and two new (the backed-off-entry starvation checks in
`outbox.test.mjs` and `sessionOrder.test.mjs`) — proof the new guard is pinned
by more than this change's own tests. Removing only the parked arm
(`state === "pending"`) reddens **3**: two pre-existing (`outbox.test.mjs`'s
own parking checks) and one new (the parked-entry starvation check). Each
sabotage reddens a different, disjoint set, which is what says the priority,
the backoff exclusion and the park exclusion are three properties rather than
one written three times.

**What this does not change.** `drainUrgency`, `NOT_YET_GRACE_MS` and the 404
grace are exactly as this section already argued — the grace still exists for
the case the jump cannot fix, a gateway that will never accept a session no
matter how promptly it is asked. The jump means the ordinary case (a deep
backlog, an otherwise healthy gateway) no longer needs the grace at all; it
does not shrink the grace or make it redundant for the case it was built for.
