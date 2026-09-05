import type { MeetingRecorder } from "./index";
import { notesOnlyRecorder } from "./notesOnly";

/**
 * What a real audio recorder needs, written down where the person who builds it
 * will be standing.
 *
 * This module deliberately ships **no capture**. It is the shape of the work
 * plus a refusal, because a half-built recorder is worse than none: it would
 * report `audio: true`, the screen would draw a transcript chip, and somebody
 * would come out of an hour-long meeting with a note containing nothing they
 * did not type. `audioRecorder()` therefore returns the notes-only recorder
 * with the same honest reason, and the checklist below is the whole delta.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 1. THE MODULE. `expo-audio`, and nothing new.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * `expo-audio@~1.1.1` is already in `package.json` and already in
 * `native-deps.json` `core`, which is the baseline every build has. That is not
 * an accident — "the first build deliberately installed far more than the app
 * used… the cost of carrying an unused module is binary size, and the cost of
 * missing one is a new build plus a reinstall by every user"
 * (`docs/decisions/app-and-console.md`).
 *
 * So it is a **static import, with no `NativeModules` gate and no
 * `runtimeVersion` bump**, exactly as `features/offline/store.ts` imports
 * `@react-native-async-storage/async-storage`. Do not put it in `gated`: `gated`
 * is for dependencies added *after* the first binary, and this one is in it.
 * Adding any *other* native module — a transcription engine, an audio-session
 * plugin, a Live Activity target — is the opposite case and must go through the
 * gate, dynamically imported behind a runtime check with a real fallback.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 2. THE PERMISSIONS, all in `app.config.js` and nowhere else.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Permission strings are declared in the config-plugin blocks and never
 * duplicated into `ios.infoPlist`, so each has one source of truth. A feature
 * built against a missing usage string does not degrade — iOS terminates the
 * app the moment it asks.
 *
 * **Already there:** the `expo-audio` plugin block carries
 * `microphonePermission`. It currently reads "…to record an audio note", which
 * is true of a voice memo and not of this. A permission prompt that
 * misdescribes what is being recorded is both an App Review problem and a
 * consent problem, so **rewrite it in the same change that turns capture on** —
 * something naming meetings, and naming what happens to the audio.
 *
 * **Still needed:**
 *
 *  - `ios.infoPlist.UIBackgroundModes: ["audio"]`. Without it iOS suspends the
 *    app when it leaves the foreground and the recording simply stops — which
 *    is the whole meeting, because nobody watches the phone for an hour.
 *  - Android: `expo-audio`'s plugin adds `RECORD_AUDIO`. Recording while the
 *    app is backgrounded on Android 14+ additionally needs
 *    `FOREGROUND_SERVICE` and `FOREGROUND_SERVICE_MICROPHONE`, plus a
 *    foreground service with the `microphone` type actually started — a
 *    notification the person can see, which is the platform being right about
 *    consent.
 *  - Nothing new on the web. See point 4.
 *
 * Both of those are native changes, so they land in a **new binary**. They
 * cannot be delivered over the air, and a JS update that starts recording
 * against a build without them is the crash this whole policy exists to
 * prevent. Guard the new recorder on a runtime capability check, not on a
 * version number.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 3. THE AUDIO SESSION, which is where the meeting-specific work is.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * A voice memo and a meeting recorder use the same module and need opposite
 * settings:
 *
 *  - `setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true,
 *    shouldPlayInBackground: true, interruptionMode: "mixWithOthers" })`. The
 *    last one is load-bearing: the default takes exclusive use of the input,
 *    which on a phone in a Zoom call means **the call loses the microphone**.
 *    A recorder that mutes the meeting it is recording is a recorder nobody
 *    uses twice.
 *  - Handle interruptions rather than dying of them. A phone call, Siri, or
 *    another app taking the input arrives as an interruption; the correct
 *    response is `onError({ recoverable: true })` so the session keeps running
 *    as a notepad and resumes capture when the input comes back. The
 *    controller already draws that state.
 *  - Segment the file. One hour-long recording is one write that fails whole;
 *    the protocol's transcript is a list of `TranscriptSegment`s with stable
 *    client-generated ids precisely so a phone that lost signal mid-meeting can
 *    re-send. Rotate on a fixed wall-clock interval so `startMs`/`endMs` are
 *    arithmetic rather than a guess.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 4. WHAT THE PLATFORM WILL NOT GIVE, ever, and what to do instead.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * **iOS cannot capture another app's audio.** There is no API for it, and there
 * will not be one. A phone recording a Zoom call is recording the room through
 * the microphone, which works for a call on speaker and does not work at all
 * for one on headphones. That is a fact to say on the screen, not a bug to fix.
 *
 * **A browser cannot hear the system either.** `getUserMedia` gets the
 * microphone after a prompt; `getDisplayMedia({ audio: true })` can get a
 * *shared tab's* audio, only in some browsers, only with the person choosing
 * the source each time. The desktop web build is therefore a notepad by design,
 * and the desktop app is where system audio belongs.
 *
 * **The watch is a remote control, never a recorder** — the protocol says so in
 * its own words. Nothing here changes for it.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 5. THE TRANSCRIBER, which is the other half and is not this module's.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * `MeetingRecorder` emits segments and declares `transcribesAt`, so a recorder
 * is free to produce them either way and nothing above it changes:
 *
 *  - **cloud** (paid tier): ship chunks to the gateway, receive segments back.
 *    Audio is transient and is never written to the bucket, never persisted on
 *    the device, and never reachable from outside `capture/` — which is why
 *    this interface has no method that hands audio out.
 *  - **device** (free tier): a native speech recogniser. On iOS that is
 *    `SFSpeechRecognizer`, which needs `NSSpeechRecognitionUsageDescription` as
 *    well as the microphone string, and which is a **new native dependency** —
 *    so `gated`, dynamic import, runtime check, honest fallback to notes-only.
 *
 * Either way the segments must satisfy the protocol: ids stable across
 * re-sends, `startMs`/`endMs` measured from session start, `speaker: null`
 * where there is no diarization, and `confidence: null` where the engine gives
 * none. Do not invent a confidence.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 6. THE LIVE ACTIVITY is a separate piece of work.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * The mockup's lock-screen and Dynamic Island surfaces are ActivityKit, which
 * is a Swift widget extension — a new native target, not a JS module. It needs
 * its own build, and `WatchState` in the protocol is already the payload shape
 * for it. `RecordingBar` in this feature is the in-app equivalent and is what
 * ships until then.
 */

/**
 * The real recorder, once there is one.
 *
 * Today: the notes-only recorder, unchanged, so that wiring this in early
 * cannot silently promise a transcript. When capture lands, this is the
 * function that changes and nothing above `capture/` does.
 */
export function audioRecorder(platform: "ios" | "android" | "web"): MeetingRecorder {
  return notesOnlyRecorder(platform);
}
