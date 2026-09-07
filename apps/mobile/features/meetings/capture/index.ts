import type { RecorderState } from "@context/meetings/recorder";
import type { TranscriptSegment } from "../protocol";
import { audioRecorder, resolveRecorder } from "./audio";

/**
 * Everything the rest of the app is allowed to know about capturing audio.
 *
 * One module, one interface. Nothing above this line imports an Expo audio
 * module, asks about a permission, or branches on a platform — which is the
 * point: audio capture is the part of this feature that differs most between
 * iOS, Android and a browser, and it is also the part that is not built yet.
 * Keeping it behind `MeetingRecorder` means the notepad, the queue, the sync
 * and every screen are finished and tested without it, and turning it on later
 * is one new implementation of five methods rather than a change to any of them.
 *
 * ## What ships today, honestly
 *
 * Real capture on iOS and Android (`audio.ts`, `expo-audio`) and in a browser
 * (`audio.web.ts`, `getUserMedia` + `MediaRecorder`), all transcribing in the
 * cloud through the one `ChunkTranscriber` seam. `notesOnlyRecorder` is still
 * what a browser gets when it is missing either half of the capability — see
 * `notesOnly.ts` for why it says what it says. Android's own JS is ready, and
 * this build's Android binary is not: no keystore, no build, no store
 * submission until the owner says go (`docs/decisions/meetings.md`, "Android
 * is prepared, not shipped").
 *
 * A notes-only recorder captures **nothing**: it reports `audio: false` with a
 * reason, runs the clock, and emits no segments. A meeting recorded with it is
 * the person's own typed notes and nothing else, which is a real and useful
 * product — the reference experience is a notepad first — and it is drawn as
 * exactly that rather than as a recording that silently produced no transcript.
 *
 * That is the rule this repo already applies to `writeClipboard` returning
 * `false` on native and `useUnsavedGuard`'s documented native no-op: an absent
 * capability is reported, never faked.
 *
 * ## Why transcription is a separate thing from capture
 *
 * The product transcribes in the cloud for the paid tier — audio transient,
 * never stored — with on-device as the free tier. Those are two very different
 * data paths and the interface must not assume either, so it does not know
 * about either: a `MeetingRecorder` emits `TranscriptSegment`s and says where
 * they came from (`transcribesAt`). A cloud recorder is one that ships chunks
 * out and emits what comes back; an on-device one is one that runs a model and
 * emits what it produced. Everything above this file sees the same segments and
 * the same `id`-stable, re-sendable contract the protocol specifies.
 *
 * What is deliberately **not** in this interface is any way to get at the audio
 * itself. Nothing above here can hold it, write it down, or attach it to a
 * note, which is what makes "audio is transient" a property of the code rather
 * than a promise in a document.
 *
 * ## Where the pieces are
 *
 *  - `./audio.ts` — the phone, both platforms. `expo-audio`, statically
 *    imported because it is in `native-deps.json` `core`; the audio session
 *    (including the `mixWithOthers` line that keeps a Zoom call's microphone,
 *    on iOS and Android alike), rotation, the interruption handling, and the
 *    one field (`allowsBackgroundRecording`) that is Android's own switch for
 *    the foreground service `expo-audio`'s native module already bundles.
 *  - `./audio.web.ts` — the browser. Metro resolves it for the web build, which
 *    is why nothing above this file branches on a platform.
 *  - `./segments.ts` — the wall clock and the chunk-id scheme both halves share.
 *  - `./transcriber.ts` — the seam the chunks go out through, and the module
 *    seam a test substitutes so no test here touches the network.
 *  - `./notesOnly.ts` — the honest refusal, for a browser that cannot record.
 *
 * Still open: on-device transcription for the free tier (a second
 * `ChunkTranscriber`, and a `gated` native dependency), and an Android
 * *binary* — the JS above is ready; nobody has approved a keystore yet.
 */

/** Where the words are produced. The product's two tiers, as a type. */
export type TranscribesAt = "device" | "cloud" | "nowhere";

/**
 * What the recorder itself is doing — and it comes from `@context/meetings`.
 *
 * It was declared here, and four implementations in this folder each kept their
 * own `let state` and their own idea of which moves are legal. The desktop
 * shell is a fifth, in another process, which cannot import this app at all —
 * so the four words and the moves between them live in
 * `packages/meetings/src/recorder.js` now, beside the meeting's own state
 * machine and carefully not confused with it.
 *
 * `capture/` stays the one door: nothing above this folder imports that module.
 */
export type { RecorderState };

export interface RecorderCapability {
  /** Whether this build can capture audio at all. */
  audio: boolean;
  /**
   * Whether this build can hear the **machine's own** audio — the far side of
   * a call on headphones — as well as the microphone.
   *
   * False everywhere except inside the desktop shell, and false there too on a
   * build macOS has not verified: a loopback tap is ScreenCaptureKit and an
   * unsigned app is refused one. So it is asked of the shell at runtime rather
   * than inferred from the fact that a shell is present, which is
   * `docs/decisions/desktop.md`'s rule — *`version` gates the shape;
   * `capabilities()` gates the feature.*
   *
   * It is on this interface rather than only inside the desktop recorder
   * because the **sheet** has to know: a switch offering something this machine
   * cannot do is exactly what `docs/decisions/meetings.md` forbids, and a
   * browser must go on saying plainly that the far side of a call is not in the
   * recording.
   */
  systemAudio: boolean;
  transcribesAt: TranscribesAt;
  /**
   * Why not, in words somebody can read, when `audio` is false. `null` when it
   * can. Never a code and never empty: this sentence is what the live screen
   * puts on the glass in place of a transcript chip.
   */
  unavailableReason: string | null;
}

/**
 * A capture session.
 *
 * The five verbs are the protocol's states — `start`, `pause`, `resume`, `stop`
 * — plus subscription. They are deliberately **not** the session's state
 * machine: `MEETING_TRANSITIONS` is what decides whether a move is legal, this
 * only does it. A recorder that refused a move would be a second, silent copy
 * of that table.
 */
export interface MeetingRecorder {
  readonly capability: RecorderCapability;
  /** What the recorder itself thinks it is doing, for the honesty check below. */
  readonly state: RecorderState;
  /**
   * Open the inputs for one meeting.
   *
   * The options are what the **person** asked for at the sheet, not what this
   * build can do: a recorder narrows the request to its own capability and
   * reports what it actually opened, rather than echoing the request back. All
   * four recorders that predate the shell ignore them, and do so by declaring
   * no parameter at all — which is why widening this cost nothing in four
   * files.
   */
  start(options?: CaptureOptions): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  /** Stop and release the device. Safe to call twice. */
  stop(): Promise<void>;
  /** Segments as they are produced. Returns an unsubscribe. */
  onSegment(listener: (segment: TranscriptSegment) => void): () => void;
  /**
   * Something went wrong *during* capture — the mic was taken by a phone call,
   * the permission was revoked mid-meeting, the transcriber gave up.
   *
   * A separate channel from a rejected `start()` because the person is in a
   * different situation: the meeting is already running and the typed notes
   * still matter. The controller turns this into a visible state, never into a
   * thrown recording.
   */
  onError(listener: (error: RecorderError) => void): () => void;
}

/**
 * What the person asked for when they pressed Start.
 *
 * One field today, and an object rather than a boolean so that the second one —
 * a chosen input, a language — is not a second positional argument threaded
 * through the controller and four recorders that do not read it.
 */
export interface CaptureOptions {
  /**
   * The meeting this capture belongs to.
   *
   * Four of the five recorders ignore it, because a device that emits segments
   * into a callback needs no name for what it is doing. The desktop shell is
   * not one of those: it queues writes in another process that outlives this
   * page, and those are keyed by session — so a capture started under a name
   * the app did not choose would be a second meeting in somebody's bucket. It
   * is the app's `newMeetingId`, minted once by the controller.
   */
  sessionId: string;
  /** Record the machine's own audio too, wherever this build can. */
  systemAudio: boolean;
}

export interface RecorderError {
  /** Whether capture can continue. `false` means the session is notes-only from here. */
  recoverable: boolean;
  message: string;
}

/**
 * The recorder this build has.
 *
 * One function so there is one answer, and a `platform` argument rather than a
 * `Platform.OS` read so the web answer is drivable from a test on any host —
 * the same reason `resolveScheme` takes its inputs.
 */
export function createRecorder(
  platform: "ios" | "android" | "web",
): MeetingRecorder {
  /*
    Straight through to `audioRecorder`, which today returns the notes-only
    recorder and tomorrow will not. One function changes when capture lands, and
    nothing above `capture/` moves — which is the whole reason this interface
    exists. It is not an indirection with no caller: this *is* its caller.
  */
  return audioRecorder(platform);
}

/**
 * The recorder this build has, **after asking the machine what it can do**.
 *
 * The one the app wires up. `createRecorder` above is the synchronous answer
 * and stays exactly as it was — it is what a phone, a browser and every test
 * that does not care about a shell get, and it is still the whole of the
 * platform split.
 *
 * This one exists because of a single fact about the desktop shell: what it can
 * capture is **asked**, over an IPC channel, and the answer is a promise.
 * `capabilities()` is deliberately async on the bridge (`preload/console.ts`
 * says why: making it synchronous now would make a wider surface later a
 * breaking change to something already shipped in a binary), and
 * `MeetingRecorder.capability` is deliberately a plain property read by the
 * controller at configure time. Something has to bridge those two, and the
 * honest place is here, before a recorder exists — not a capability that
 * mutates under the snapshot after the screens have read it.
 *
 * On every other platform it resolves immediately with exactly what
 * `createRecorder` returns, so nothing about a phone or a browser changes.
 */
export async function createRecorderFor(
  platform: "ios" | "android" | "web",
): Promise<MeetingRecorder> {
  return resolveRecorder(platform);
}

/*
  Re-exported here so `capture/` is one import for everything above it: the
  interface, the recorder this build has, the honest fallback, the fake a test
  drives by hand, and the module that documents what a real one needs. The split
  into files is about keeping `audio.ts` importable without a cycle back through
  this barrel, not about several places to import from — and this being the only
  door is what makes "nothing above `capture/` can reach the audio" a boundary
  rather than a preference. `meetingsCaptureWiring.test.ts` fails if any module
  outside `capture/` imports past it.

  **`setTranscriber` is deliberately not here.** It installs an object that is
  handed every chunk's bytes — `fakeTranscriber` retains all of them by design —
  so re-exporting it beside the types put a way to capture raw audio one import
  away from every module in the app, in the same file that says in prose that
  nothing above here could. `setTranscriptionClient` genuinely has to be
  reachable from above (only React can see the app's Convex client) and hands
  out nothing; the other does not, and a test reaches `capture/transcriber` by
  its own path instead.
*/
/*
  `./desktop` is deliberately **not** re-exported here.

  It is the browser-with-a-shell half of the platform split, reached only
  through `audio.web.ts` — which Metro hands to the web build and never to a
  phone. Putting it on this barrel would import `@context/desktop-bridge` into
  the iOS bundle to describe a global that cannot exist there: `window.desktop`
  is a web-only concept by construction, because the Expo binary *is* the native
  surface on a phone. A test reaches it by its own path, the way
  `capture/transcriber` is reached.
*/
export { notesOnlyRecorder } from "./notesOnly";
export { audioRecorder } from "./audio";
export { fakeRecorder, fakeSegment, type FakeRecorder } from "./fake";
export { SEGMENT_MS } from "./segments";
export {
  setTranscriptionClient,
  type ChunkTranscriber,
  type TranscribeChunkArgs,
} from "./transcriber";
