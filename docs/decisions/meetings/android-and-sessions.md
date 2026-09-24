# Meetings — Android and sessions

### Android is prepared, not shipped

Owner's call (Seyi, 2026-09-07): "I'm not supporting Android just yet, but we
should prepare for it." Read literally rather than softened into either
extreme — this is not "ship it" and it is not "leave it for later" either.
**No keystore, no build, no store submission** happen as part of preparing;
what does happen is that the codebase stops being the reason a future decision
to go would take more than dispatching one workflow.

**What "prepared" turned out to mean was smaller than expected, because the
work had already been done — by a dependency, not by this repo.** The plan
going in assumed a custom Expo config plugin under `apps/mobile/plugins/`
would be needed to declare `<service android:foregroundServiceType="microphone">`
and a notification channel, because recording in the background on Android
14+ needs a foreground service actually started, with a visible notification —
the platform being right about consent, the same principle *consent is the
customer's* argues from the other direction. Reading `expo-audio`'s installed
Android module (`android/src/main/java/expo/modules/audio/service/AudioRecordingService.kt`,
`android/src/main/AndroidManifest.xml`) found that service already declared,
already starting itself with the `microphone` foreground-service type,
already creating its own notification channel the first time a recording
starts. The plugin was never needed; the only two of the four Android 14+
permissions this app has to declare itself are `FOREGROUND_SERVICE_MICROPHONE`
and `POST_NOTIFICATIONS` (see `apps/mobile/app.config.js`'s `android.permissions`
comment for exactly which of the four permissions come from where, and why all
four are listed there rather than split across two sources).

**The audio-focus worry resolved the same way, for the same reason: read the
dependency's source instead of assuming a gap.** `MEETING_AUDIO_MODE`'s
`interruptionMode: "mixWithOthers"` is what keeps a Zoom call's microphone on
iOS — *the audio session*, above — and the question was whether Android needed
a second, platform-specific answer to the same problem. It does not:
`expo-audio`'s Android `AudioModule.kt` reads the same field to decide whether
to request Android's own audio focus at all, and `mixWithOthers` is the one
value that skips the request entirely. So `audioRecorder("android")` now
answers a real `expoAudioRecorder`, the same function iOS uses, with exactly
one field threaded in that iOS's session never sees:
`allowsBackgroundRecording: true`, which is what tells that native module to
start its bundled foreground service. `expo-audio`'s own type declares that
field `@platform ios` and `@platform android` both — on iOS it gates something
this app has never touched, whether a recorder pauses on backgrounding, which
is why it is not merged into the object iOS reads: doing so would be a
behaviour change nobody asked for, smuggled in under an Android decision.

**What is genuinely still open, said plainly rather than glossed:** the
foreground notification's words. `AudioRecordingService.kt` posts "Recording
audio" / "Tap to return to app", hard-coded in Kotlin, and the installed
version of `expo-audio` exposes no option to override it. The product's own
copy for that moment — "Recording a meeting" — cannot be wired up from this
repository without either a newer `expo-audio` release that adds the option,
or a native patch of the library, and neither belongs in a "prepared, not
shipped" change. The first Android build ships the library's own words on
that notification until one of those two things happens; this is written down
rather than worked around because the alternative was to quietly ship
different copy than the rest of the feature uses, or to claim a fix that was
not made.

**What the first real Android build needs, beyond merging this:**

1. **EAS-managed keystore approval.** Nothing has ever built this app for
   Android, so no signing keystore exists yet. `eas build --platform android`
   in `--non-interactive` mode (`deploy-mobile-native.yml`) will generate one
   silently the first time it runs unattended, and a signing identity for an
   app's Play Store listing is not something a workflow should decide on
   nobody's behalf. The owner runs `eas credentials --platform android` once,
   interactively, from a machine logged into the EAS account, either
   approving an EAS-managed keystore or uploading one that already exists.
2. **A Google Play service-account key.** `eas submit --platform android`
   needs Play Console API access to upload a build; that key does not exist
   yet either, and creating one is a Play Console action only the account
   holder can take. Once it exists it becomes the `GOOGLE_SERVICE_ACCOUNT_KEY`
   secret (`scripts/secrets-allowlist.json`), and `apps/mobile/eas.json` gets
   a `submit.production.android` block naming it — `eas.json`'s own docs
   (<https://docs.expo.dev/submit/android/>) say the exact shape.

Until both are done, `deploy-mobile-native.yml`'s preflight refuses a
`platform: android` or `platform: both` dispatch outright — build, not only
submit — with those same two steps printed rather than an `eas` stack trace
partway through a run somebody else has to interpret. `apps/mobile/eas.json`
carries a `build.production.android` block (AAB, `"buildType": "app-bundle"`)
so that the day both steps are done, turning Android on is deleting that one
preflight check, not authoring a project. No `submit.production.android`
block exists yet, on purpose — JSON has no comment syntax to disable a block
in place, so leaving it out and failing loudly at the workflow level is the
next best thing to a commented-out line.

**What an OTA update can never do, restated for Android because
`runtimeVersion`'s own comment only ever had to say it about iOS before now.**
`runtimeVersion: "1.0.0"` is pinned for the life of the app, deliberately
decoupled from the marketing `version`, so one OTA channel reaches every
install ever shipped — see `app.config.js`'s own comment on the field. The
first Android binary, whenever it ships, becomes the Android floor the exact
way `UIBackgroundModes: ["audio"]` and `#161` were the iOS one: every native
capability Android needs — the permissions, the foreground service, anything
`expo-audio`'s Android module reads off the manifest — has to be in *that*
binary, because no OTA update can add a native module, a permission, or a
manifest entry to a binary already installed on somebody's phone. This PR
changes JS behaviour only (`audioRecorder("android")`, `app.config.js`'s
Android manifest additions) and ships over the air the moment it merges — that
is safe today because zero Android installs exist to receive it, not because
the OTA/native boundary has moved. The day a real Android binary exists, the
same discipline `native-deps.json`'s `core`/`gated` split already holds iOS to
applies to it without exception.

The checks are in `apps/mobile/__tests__/appConfig.test.js` (the Android
permissions are additive and iOS's rendered config is unaffected) and
`apps/mobile/__tests__/meetingsCapture.test.ts`'s `describe("android", ...)`
(real capability, the one field that differs from iOS's session, the same
`interruptionMode` mixing on both platforms, the same rotation and offset
arithmetic run under the Android platform argument).

### A `finalizing` session has a deadline, because the gateway does not need one

`finalizing -> complete` is usually one request. `MEETING_TRANSITIONS` puts no
bound on how long a session may sit in `finalizing` because most of the time it
does not need one — but "most of the time" is exactly the assumption a crash
between queuing `session` and queuing `finalize`, a lost response nobody ever
retried, or a deterministic refusal nobody looked at breaks. The owner found
this on their own machine: a meeting reading "Finalizing" for over two hours,
with a badge that carried no information about which of those had happened,
because `finalizing` meant the same word whether the gateway was a second from
answering or had not heard from this device since the crash.

The rule is `checkFinalizeTimeout` in `packages/meetings/src/recovery.js`, and
it is three things rather than one: **retry once, then fail, and never fail on
the first sighting.** A session past the bound the *first* time a client asks
is told to retry — the segments and notes are already on whichever record holds
them, so a retry costs one request, not the meeting. A session still
`finalizing` a full bound-window *after* that retry was attempted is told to
fail, which a client folds as an ordinary `fail` event — already legal from
`finalizing` and already a client-sendable event, so no new wire shape was
needed, only a client that had a reason to send it. The badge changes from an
unqualified "Finalizing" to "Failed — `<reason>`" with a Retry a person
presses, which `MEETING_TRANSITIONS.failed` already allows: `failed ->
finalizing` lets a later retry — the person's own, or a queued finalize a
client's recovery left in place — still finish the meeting normally if the
underlying problem was transient.

**Ten minutes, chosen directly rather than inherited.** Nothing in this
codebase already states a "how long may a whole meeting take to finalize"
budget — `SEGMENT_MS` bounds one rotation (twenty seconds) and the cloud
transcription rate limit bounds one minute's requests, and neither answers this
question. Ten minutes is comfortably longer than an enhancement pass over even
a long transcript, and short enough that "stuck for two hours" is caught on the
first check after the meeting actually finished rather than the fortieth.

**The rule is pure, and every surface that can get stuck calls the same
function rather than restating the arithmetic.** The gateway needs none of
this — a client-sent `fail` on a `finalizing` session was already legal before
this decision, and the gateway's own idempotency means a retried finalize
after a recovered outage lands on the one note it already claimed. What needed
building was a client that actually *asks* the question:

- **The desktop app** (`apps/desktop/src/core/sync/outbox.ts`,
  `recoverStaleFinalize`) asks it of every `finalize` entry in its outbox,
  called from `drainOnce` before anything is sent — covering both "runs
  periodically" (every drain tick) and "on app launch" (the outbox read back
  from disk on `main/index.ts` startup is checked the moment it is read,
  before the first periodic tick would otherwise get to it). A `fail` is
  queued as a `session`-kind write, which drains ahead of the stale `finalize`
  in `KIND_ORDER` — the gateway learns the session failed before anything else
  about it is attempted — and the stale entry is then dropped, so a client
  that has already said `fail` is not asked to say it again on every later
  tick forever.
- **The mobile app** (`apps/mobile/features/meetings/controller.ts`,
  `recoverStaleFinalizes`) asks it of every record in `finalizing`, called from
  `configure()` — the phone's nearest thing to a launch, reading the records
  `loadMeetings` just restored from disk — and from the top of `sync()`, so a
  session that goes stale while the app stays open is not left until somebody
  happens to relaunch it.

Both callers hold their own `retriedAt` bookkeeping (`OutboxEntry.retriedAt` on
the desktop, `MeetingRecord.retriedAt` on the phone) rather than the pure
function holding any state itself — it is a fact about a *previous call* to
this function, not about the meeting, and a gateway record has no room for it:
`endedAt` alone is enough for every caller to agree on how long a session has
been finalizing.

The checks are `checkFinalizeTimeout` in
`packages/meetings/test/recovery.test.mjs` (below the bound is left alone; at
the bound, exactly once, it is `retry`; a full window past that retry it is
`fail`; it never asks to retry a second time), `recoverStaleFinalize` in
`apps/desktop/test/outbox.test.mjs` (retried once, then a `fail` is queued
ahead of the stale entry and the entry itself is dropped, addressed to the
same context the finalize was, and a session already failed is not asked to
fail again on a later pass), and `recoverStaleFinalizes` in
`apps/mobile/__tests__/meetingsController.test.ts` (the same progression
through `sync()` and through `configure()`, the human's typed words surviving
the whole thing unchanged). **The test that fails if this is reversed:** delete
the `retry` branch from either glue function and a session's first stale
sighting is answered as already failed — a meeting whose gateway was one slow
request from `complete` is told it failed for no reason at all.

**Amended in review, before it merged: a failure nobody can undo is worse
than a session that is still trying.** The paragraph above says the badge
"changes to `Failed — <reason>` with a Retry a person presses", and the state
table has allowed `failed -> finalizing` since a partial recording had to be
writable out — but nothing in either client ever made that move.
`pendingSteps` offers a `finalize` step only for a session in `finalizing`, and
the desktop's recovery drops the stale entry outright, so the first version of
this decision turned "stuck, and still trying every drain" into "failed, and
never sent again": a phone with no signal for twenty minutes after a meeting
kept the words somebody typed on the device permanently, behind a badge that
named a failure and no control that did anything about it. That is a worse
outcome than the bug being fixed, and it is why the retry is now code rather
than a sentence: `MeetingsController.retryFinalize` folds the same `end` the
contract already had (clearing `failureReason`, restamping `endedAt`, clearing
`retriedAt` so a person's retry gets its own full window, and clearing
`acked.finalized` — without which the button does nothing in the case it exists
for, because a gateway that *accepted* a finalize and never came back with a
path is the shape the owner actually reported, and that acknowledgement is what
stops `pendingSteps` offering the step again), and
`MeetingNoteScreen`'s `Landing` gains the `failed` branch that offers it —
which also stops that screen telling a failed meeting it will be "sent as soon
as your context answers", the same false promise the `empty` branch below
exists to avoid. The checks are `nothing sends a failed meeting on its own,
which is why the person's Retry has to exist`, `Retry takes it back to
finalizing and the meeting lands in the bucket`, and `a meeting recovery gave
up on says it was not filed, and offers Retry`.

**And a client giving up races the gateway, which now ships a client that gives
up on a schedule.** A queued `fail` is an ordinary `session` write, so it can
land in the one window where the finalize has claimed a path and the note is
not yet written. The note reaches the customer's bucket a moment later and the
receipt's conditional write loses; folding `written` onto the `failed` record
that replaced it is a move the table refuses, which used to answer 400 — a
refusal the desktop outbox parks — and leave a real note in the bucket with
nothing pointing at it. The rule is that **the bucket wins**: `reopenFailed` in
`apps/mcp/src/meetings/ingest.js` takes the record back to `finalizing` through
the same `end` the claim folds, puts the meeting's own `endedAt` back, and the
receipt says `complete`. The check is `a client that gave up mid-finalize does
not leave the note it raced orphaned`, and its two neighbours pin the note and
the end time.
