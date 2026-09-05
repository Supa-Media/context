# Meeting capture: roadmap

_Where this is today, what ships in what order, and which four things are
genuinely hard._

Staging is honest here rather than optimistic: three of the five stages below
are mostly integration work, and two of them contain a problem nobody solves in
an afternoon. The hard parts are listed separately at the end, with what is
actually known about each, so that a plan built on this document does not
discover them in week six.

## Update — 2026-09-05: the phone and the browser record

Stage 3's recording half has landed, and the sequencing below is out of date in
one specific way worth stating plainly: **capture arrived before the gateway
routes of Stage 2, not after.**

That was deliberate. The gateway authenticates MCP clients by OAuth grant, and
how the *app* should authenticate to it is still the open decision this document
records. The app already authenticates to **Convex**, so transcription is routed
`app → Convex action → a Cloudflare Worker with a Workers AI binding`, which uses
auth that exists today and settles none of that question early. Nothing here
forecloses the Stage 2 design: when it is decided, the cloud transcriber is one
implementation of `ChunkTranscriber` behind an unchanged interface.

What works now, on iOS and on the web build:

- Microphone capture, rotated into 20-second chunks on a wall clock so
  `startMs`/`endMs` stay arithmetic, each chunk transcribed by Whisper and
  deleted immediately.
- `interruptionMode: "mixWithOthers"`, so a phone already in a call keeps its
  microphone; an interruption surfaces as a recoverable error and the meeting
  continues as a notepad rather than dying.
- Android is untouched and still reports notes-only, honestly.

Two things this does **not** do. It transcribes in the cloud only — the
on-device free tier needs a new native module and is still ahead. And a browser
still cannot hear system audio, so the web build captures the room and your own
side of a call, never the far side through headphones; that limit is Notion's
too, and it is why the desktop app remains where system audio belongs.

## Where this is today

The contract, and almost nothing else. `packages/meetings/src/protocol.js`
defines the session, the state machine, the event union, the routes, the
detection inputs and the watch's five verbs. The package's `exports` map already
names `./src/index.js` and `./src/detect.js`; those modules, `session.js` and
the note renderer are being written against the contract now. `test/` is empty.

Nothing ingests, nothing records, nothing writes a note. That is the correct
place to be — the contract was worth settling before four surfaces started
disagreeing — but no part of this product works yet, and no stage below should
be read as "nearly done".

## Stage 1 — the core, and the note it produces

`session.js` (the reducer over `MEETING_TRANSITIONS`), `detect.js` (pure
judgement over `DetectionSignals`, with hysteresis), and the note renderer:
one file per meeting, `## Summary` / `## My notes` / `## Transcript`, frontmatter
carrying the meeting id, times, source, attendees, device and which
transcription engine produced it.

All of it is pure and offline, so all of it is testable without a microphone, a
network or a meeting. That is the point of doing it first: by the end of this
stage the rules that decide *when to record* and *what a meeting looks like on
disk* are settled and covered, and every later stage is plumbing against a
fixed target.

Exit criteria: a fixture event log replays to the same session every time; a
fixture signals sequence with a one-poll flicker never fires the detector; the
renderer produces a byte-stable note from a fixture session.

## Stage 2 — the gateway routes

The routes in `ROUTES`, behind the existing grant machinery: session upsert,
read one session back, list recent sessions, segment append, notes replace,
finalize. Reading one and listing are different paths — one GET cannot be both. Conflict-safe writes with
`meeting_conflict` on a lost conditional put. Audit events recording the acting
identity and the path, never content.

The idempotency tests are the substance of this stage, not a footnote to it:
finalizing twice writes one note; re-sending a segment does not duplicate it; a
re-finalize after a rename rewrites one note rather than adding a second; a
session id from another workspace is refused indistinguishably from one that
never existed.

**Blocked on a decision, not on code:** where an in-flight session lives for the
forty minutes before it becomes a note. The options and what each costs are in
[architecture](./architecture.md); the fallback that cannot become the wrong
answer is that the client holds its own log and the gateway sees the session at
finalize.

## Stage 3 — the phone

Record, type alongside, queue offline, replay on reconnect. `read_meeting` and
`list_meetings` as MCP tools. A Live Activity, which needs an App Group,
`UIBackgroundModes: ["audio"]` in `app.config.js` (added 2026-09-05, and it
takes effect only in a new native build — the microphone permission string was
already in the shipped binary, which is why *foreground* capture reached phones
over the air), and an Expo SDK upgrade if
the first-party `expo-widgets` route is taken — see
[watch-companion](./watch-companion.md) §1.

This is the first stage a person can use, and it is a complete product for
in-person meetings on its own: a phone on the table, a transcript, a summary, and
a note in their bucket that every AI client they own can already read.

The watch surface arrives here for free, mirrored into the Smart Stack from the
Live Activity, with no watchOS code.

## Stage 4 — the desktop app

Detection, the prompt with a reason and a "not now", system audio plus
microphone captured locally, the notepad, and the tray indicator. Nothing joins
the call.

This stage contains **two** of the four hard problems (system audio, calendar
access) and is where a plan built on Stage 3's velocity will go wrong.

## Stage 5 — the watchOS target

Start from the wrist, the face complication, and reliable flag/end when the
Live Activity is not the top of the Smart Stack. Costed in detail in
[watch-companion](./watch-companion.md) §1 and §4: a Swift codebase outside the
OTA channel, a second bundle identifier and provisioning profile, and a
third-party config plugin. Deliberately last, and deliberately not started until
Stage 3 has answered whether the mirrored Live Activity's buttons are
interactive on the watch — that one fact decides how much of this stage is
needed.

---

# The four hard things

## 1. System audio capture on macOS

The single largest piece of native work in the product, and it cannot be done in
JavaScript. Two viable APIs, and the choice matters:

- **Core Audio process taps** (`AudioHardwareCreateProcessTap`, macOS 14.2+).
  Audio-only, which is what we want. Two details reported consistently by people
  who have shipped it: the TCC prompt is triggered by `AudioDeviceStart` on the
  tap-backed aggregate device rather than by creating the tap, and
  `NSAudioCaptureUsageDescription` is its **own** TCC category, separate from
  microphone access, and belongs in the Info.plist with copy explaining why.
  Apple's documentation is thin; the community reference implementation
  (`insidegui/AudioCap`) is how most people learn it.
- **ScreenCaptureKit**, which delivers system audio under the **screen
  recording** grant. Well documented, but even for audio-only capture you must
  configure a screen capture target, and asking a meeting-notes app for screen
  recording permission is a worse conversation than asking for audio capture.

Taps are the right call, with the caveat that they are newer and less
documented. Either way this is a signed native helper with its own TCC prompts,
its own hardened-runtime entitlements, and its own notarisation — and a
permission the user can revoke at any time, which the app has to detect and
explain rather than silently record silence.

Windows is a separate implementation (WASAPI loopback, which is old and
well-trodden). Linux is not addressed.

## 2. Diarization quality

This is where a meeting recorder is judged, and where the free tier is weakest.

Apple's `SpeechAnalyzer` / `SpeechTranscriber` (iOS 26 / macOS 26 and later)
is genuinely good at transcription — reported as comparable to mid-tier Whisper
models on long-form conversational speech and several times faster — and it is
on-device with no server fallback. **It does not do speaker diarization at all.**
Shipping "who said what" on the free tier means a separate diarizer running
after or alongside transcription, on a local audio buffer, with its own model
weights, its own accuracy problems and its own battery cost.

Compounding it: the on-device path has one microphone in a room, so voices at
the far end of a table are quiet and overlapping speech is a single blur. The
bot-based products we are compared to get a clean per-speaker feed from the
conferencing platform, which is most of why their diarization is better; we
declined that trade for the reasons in
[decisions/meetings](../decisions/meetings.md), *nothing joins the call*.

What follows for the product, and it should be designed for rather than
apologised for: **`TranscriptSegment.speaker` is nullable and a great many
segments will be `null`.** The note has to read well with no speaker labels at
all, the summary has to be generated from unlabelled text, and "Speaker 1"
should never be presented with more confidence than it has earned. The paid
tier's diarization is a real upgrade rather than a table-stakes feature that
happens to work better.

## 3. Calendar access on each platform

Correlating a recording with a calendar event is what turns a file called
`recording-3` into a note with a title and an attendee list. Every platform
charges for it:

- **iOS 17+** splits calendar permission into write-only and full access.
  Reading events — which is the only thing useful here — requires **full**
  access, which is a heavy prompt for a feature the user has not yet seen the
  value of. `expo-calendar` exposes both; the prompt timing is a product
  decision, and asking on first launch will cost installs.
- **macOS** is EventKit with its own TCC prompt, in an app that is already
  asking for microphone and audio capture. Three permission dialogs before the
  first recording is a funnel, not an onboarding.
- **Android** needs `READ_CALENDAR`, which is comparatively cheap.
- **Windows** has no single answer; a work calendar is usually reached through
  the organisation's cloud API, which means an OAuth grant against a tenant an
  administrator controls.

The design consequence: **calendar is an enhancement, never a dependency.**
`DetectionSignals.calendarEvents` is allowed to be empty on every platform, the
detector still fires on window and microphone evidence, and the meeting still
gets a note — with a title the human can fix in one tap.

## 4. The watchOS target

Fully costed in [watch-companion](./watch-companion.md). The short version: a
watch app is a Swift codebase that ships only in App Store builds, outside the
over-the-air update channel this app relies on; it needs a config plugin outside
Expo's first-party set, a second bundle identifier and provisioning profile, and
an `ios.appleTeamId` in the app config. It is not required for the mid-meeting
watch surface, which arrives free via Smart Stack mirroring — it is required for
starting from the wrist and for the face complication.

---

## Two smaller things that will surprise someone

- **The Expo SDK upgrade is on the critical path for the Live Activity.**
  `apps/mobile` is on SDK 54. The first-party widgets/Live Activity route is
  reported stable in SDK 56, which also carries a reported Hermes V1 memory
  regression affecting `react-native-worklets` and `react-native-reanimated` —
  both direct dependencies here — said to be fixed in SDK 57. Verify against the
  changelog and expect the upgrade to be its own piece of work, including the
  deliberate `runtimeVersion` decision documented in `app.config.js`.
- **Enhancement is the same privacy seam as cloud transcription, one layer up.**
  Generating `## Summary` means a transcript reaching a model. On the paid tier
  that is the seam already disclosed; wherever it happens it must be stated in
  the same words, and the note records what produced it. A summary is
  regenerable, so nothing is lost by declining to generate one — which means
  "never send my transcript anywhere" is a supportable configuration and should
  stay one.
