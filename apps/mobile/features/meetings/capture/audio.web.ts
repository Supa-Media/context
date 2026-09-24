import { capabilitiesFrom, getDesktopBridge, type DesktopBridge } from "@context/desktop-bridge";
import { desktopRecorder } from "./desktop";
import type { MeetingRecorder } from "./index";
import { notesOnlyRecorder } from "./notesOnly";
import { browserCanRecord } from "./audioWeb/capabilities";
import { mediaRecorderRecorder } from "./audioWeb/recorder";
import { CAPTURE_MESSAGES, WEB_MIME_CANDIDATES } from "./audioWeb/messages";

/**
 * Capture in a browser: `getUserMedia` + `MediaRecorder`, same interface.
 *
 * Metro resolves `.web.ts` ahead of the bare extension, so this is the whole of
 * how the web build gets capture: no `Platform.OS` branch above `capture/`, no
 * second recorder type, and the same `SEGMENT_MS` rotation and the same
 * `ChunkTranscriber` as the phone. `audio.ts` is unreachable from a browser
 * bundle and this file imports no Expo native module, which is what keeps
 * `expo-audio` out of the web build entirely.
 *
 * The recorder itself, its browser-capability probes, and the sentences it may
 * say each live under `capture/audioWeb/` now — `recorder.ts`,
 * `capabilities.ts`, `blob.ts` and `messages.ts` — split out only because one
 * file holding all four was pushing 1,100 lines; nothing about the split
 * changes what this module exports or how Metro/Jest resolve it. See
 * `audioWeb/recorder.ts` for the capture state machine itself, which is where
 * the header this docstring used to carry now lives in full.
 *
 * ## What a browser can and cannot hear, said plainly
 *
 * The microphone is always the floor: the room and your own side of a call.
 * The far side of a call on headphones is not in *that*, and it used to be the
 * whole of what this file could do — the header here said so, and said system
 * audio was the desktop app's job.
 *
 * It is still the desktop app's job in the sense that matters: a browser tab
 * cannot tap the machine's output, and nothing here pretends otherwise. What a
 * browser can do is ask the **person** to hand it a source —
 * `getDisplayMedia({ audio: true })`, the tab or screen picker, with the "share
 * audio" option ticked — and mix that source's audio with the microphone into
 * one recording. That is a genuinely different consent story from the shell's
 * loopback tap and it is drawn as one: `systemAudioNeedsPicker` is what tells
 * the sheet to say a picker is coming, the offer is **off** by default on this
 * surface, and every way it can come back empty is reported in a sentence
 * rather than left to look like a recording of both sides.
 *
 * Three ways it comes back empty, all of them ordinary: the picker was
 * cancelled, the source chosen carries no audio (a whole screen on most
 * platforms, anything at all on a browser that cannot share audio), or nothing
 * here can mix two inputs into one recording. Each one leaves a microphone
 * recording and says `SYSTEM_AUDIO_UNSHARED`.
 *
 * ## The meter, which is an `AnalyserNode` and not a `MediaRecorder` thing
 *
 * `MediaRecorder` has no meter, which is why `capture/level.ts` lists a browser
 * among the surfaces that cannot answer "how loud is it" — and the honest
 * `null` that produced drew `Waveform`'s static silhouette for the length of
 * every meeting, which is the flat bar that reads as a dead microphone. The
 * shell has always answered this with an `AnalyserNode`; so does this file now,
 * over the same inputs it is recording, published on the same module channel
 * and at the same 10 Hz the phone polls at. A browser with no `AudioContext`
 * still publishes nothing at all, because *"nothing here can tell you"* and
 * *"the room is quiet"* are different answers.
 *
 * ## Why stop/restart rather than `start(timeslice)`
 *
 * `start(timeslice)` emits a `dataavailable` every interval, but only the first
 * blob carries the container's headers — the rest are fragments that no decoder
 * and no transcription service can read on their own. Every chunk this feature
 * sends has to be a complete, self-contained file, so a rotation stops the
 * recorder and starts a new one. The gap between the two is a few milliseconds
 * of a person still talking, which is a real cost and the smaller one.
 *
 * ## There is no file to delete
 *
 * The phone writes each chunk to disk and deletes it before the request goes
 * out. Here the chunk is a `Blob` in a local that goes out of scope when the
 * send returns; nothing is ever written to storage the browser keeps, so the
 * "delete the transient recording" rule is satisfied by there being nothing to
 * delete rather than by a call. No IndexedDB, no `showSaveFilePicker`, no
 * object URL that outlives the request.
 *
 * ## The send is not in the rotation's critical section
 *
 * A rotation stops the recorder, starts a new one, and hands the blob to a
 * transcriber that answers whenever it answers. With the round trip inside the
 * chain — which is how this was first written — recording did not resume until
 * the answer came back, so seconds of every twenty were never captured while
 * the offsets went on claiming the chunks were contiguous. `MAX_INFLIGHT_CHUNKS`
 * is the bound on how many sends may be outstanding, and says what happens at
 * it and why. Segments carry ids and `startMs`, so out-of-order arrival costs
 * nothing; silently missing audio would cost the meeting.
 */

export { CAPTURE_MESSAGES, WEB_MIME_CANDIDATES };

/**
 * The recorder this browser has.
 *
 * `platform` still decides, even though Metro only ever hands this file to the
 * web build: the test runner resolves `.web.ts` first as well, and a caller
 * asking for the Android answer must get the Android answer rather than a
 * browser recorder that would never exist on a phone.
 */
export function audioRecorder(platform: "ios" | "android" | "web"): MeetingRecorder {
  if (platform !== "web") return notesOnlyRecorder(platform);
  if (!browserCanRecord()) return notesOnlyRecorder("web");
  return mediaRecorderRecorder();
}

/**
 * The recorder this page has, once it has asked whether it is inside a shell.
 *
 * `docs/decisions/desktop.md`, step 3: the Expo app is the UI on macOS too, and
 * *"`capture/audio.web.ts` takes segments from `onSegment` when a shell is
 * present instead of driving `MediaRecorder`"*. This is that sentence.
 *
 * ## Detection is the bridge, not the user agent
 *
 * `Platform.OS === "web" && getDesktopBridge() !== null`. Electron's UA is
 * configurable, spoofable, and says nothing about which build is underneath;
 * a frozen `window.desktop` carrying a version this bundle understands is the
 * only thing that means "there is a shell here that will answer". Everything
 * about that check is in `@context/desktop-bridge` — including refusing a
 * bridge that grew a credential-shaped member — and this file only asks.
 *
 * ## In a shell, the shell records — even when it says it cannot
 *
 * There is no fallback to `getUserMedia` inside the shell, and that is
 * deliberate rather than an omission. The console window is **never granted a
 * media permission**: its session denies `media` and `display-capture`
 * outright, because the microphone in that app belongs to a hidden window the
 * main process opens after its consent gate says yes. So a browser recorder in
 * there would ask for a device it is guaranteed to be refused, and present as a
 * denied-permission error rather than as the honest sentence
 * `desktopRecorder` gives.
 *
 * ## Nothing is claimed before the answer arrives
 *
 * `capabilities()` is awaited *before* a recorder exists, so the object the
 * controller reads is right the first time somebody looks at it. A capability
 * that arrived later and mutated in place would have been read as `false` by
 * the screens and then silently disagreed with them.
 */
export async function resolveRecorder(
  platform: "ios" | "android" | "web",
): Promise<MeetingRecorder> {
  if (platform !== "web") return notesOnlyRecorder(platform);
  const bridge = getDesktopBridge();
  if (bridge === null) return audioRecorder(platform);
  return desktopRecorder(bridge, capabilitiesFrom(await askCapabilities(bridge)));
}

/**
 * What the shell says it can do, and `{}` if it will not say.
 *
 * A rejected probe is a shell that is there and not answering — a channel the
 * main process no longer handles, an older build, a window mid-teardown — and
 * `capabilitiesFrom` reads the empty answer as every capability `false`. That
 * produces a recorder that captures nothing and says so, which is the honest
 * end of this branch; the alternative is an unhandled rejection in the effect
 * that configures the whole feature.
 */
async function askCapabilities(bridge: DesktopBridge): Promise<unknown> {
  try {
    return await bridge.capabilities();
  } catch {
    return {};
  }
}
