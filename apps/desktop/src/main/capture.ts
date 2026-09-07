/**
 * System audio and the microphone, without anything joining the call.
 *
 * ## How this works on macOS, and what is genuinely missing
 *
 * Electron cannot open a system-audio stream from the main process. The capture
 * happens in a renderer, through `getDisplayMedia`, and the main process
 * decides what that renderer is allowed to have: `setDisplayMediaRequestHandler`
 * answers the renderer's request with a source and — the part that matters —
 * `audio: "loopback"`, which is Electron's binding for ScreenCaptureKit's
 * system-audio tap. That is the whole trick that makes a bot unnecessary: macOS
 * hands the app the meeting's own output, so the other people see six
 * participants rather than seven.
 *
 * So this class owns a **hidden window** whose only job is to hold the
 * `MediaRecorder`s and post their chunks back. It is not visible, it has no
 * navigation, and it loads one local file.
 *
 * ### What is real here
 *
 * The wiring: the handler, the hidden window, the IPC, the frame plumbing into
 * `AudioRecorder`, pause and resume, `recordedMs` excluding pauses, and the
 * **honest degrade** — a build macOS will not give system audio to records the
 * microphone and reports which half is missing, rather than failing the meeting
 * or claiming both channels.
 *
 * ### What is not, and cannot be from inside this repository
 *
 *  - **Entitlements and a signed build.** ScreenCaptureKit requires a hardened
 *    runtime, `com.apple.security.device.audio-input`, and a notarised,
 *    code-signed app. An unsigned development build gets a microphone and, in
 *    most macOS versions, nothing at all from the loopback tap — which is the
 *    degrade path above, and the reason it exists rather than being an edge
 *    case somebody might hit.
 *
 *    What is **not** on that list, and was assumed to be: macOS's *Screen
 *    Recording* grant. Measured on the signed installed build on macOS 26.4.1
 *    with no `kTCCServiceScreenCapture` row for this app at all, the loopback
 *    tap still delivered real system audio (peak 0.32 over 16 frames while
 *    sound played). So the tap is not gated on that permission, which is why
 *    `capture/permissions.ts` no longer refuses a meeting for the want of it.
 *  - **`NSMicrophoneUsageDescription` and `NSAudioCaptureUsageDescription`** in
 *    `Info.plist`, which is a packaging step, not a source file.
 *  - **Electron ≥ 31** for `audio: "loopback"`; earlier versions have no
 *    system-audio path on macOS at all. This app declares 33.
 *
 * None of that can be verified by a test in CI, which is exactly why it is
 * written down here and in `README.md` rather than assumed to work. What CI
 * *does* prove is everything on the other side of the IPC boundary: the chunk
 * arithmetic, the transcriber, the queue and the note.
 */

import { BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import { answerDisplayMedia } from "../core/capture/displayMedia.ts";
import type { AudioRecorder, RecorderOptions, RecorderSummary } from "../core/capture/recorder.ts";
import type { CaptureChunk } from "../preload/capture.ts";

const CAPTURE_READY = "context:capture-ready";
const CAPTURE_START = "context:capture-start";
const CAPTURE_STOP = "context:capture-stop";
const CAPTURE_PAUSE = "context:capture-pause";
const CAPTURE_RESUME = "context:capture-resume";
const CAPTURE_CHUNK = "context:capture-chunk";
const CAPTURE_FAILED = "context:capture-failed";

export class DesktopCaptureRecorder implements AudioRecorder {
  #window: BrowserWindow | null = null;
  #capturing = false;
  #paused = false;
  #frames = 0;
  #startedAt = 0;
  #recordedMs = 0;
  #rendererDir: string;
  /** Which requested channels the platform refused. Read after `start`. */
  #degraded: string[] = [];

  constructor(rendererDir: string) {
    this.#rendererDir = rendererDir;
  }

  get capturing(): boolean {
    return this.#capturing && !this.#paused;
  }

  /**
   * What the last `start` could not open.
   *
   * The probe is the attempt: there is no API that answers "would macOS give
   * this build the system tap" without asking for it, so the answer is what
   * came back. `capturePlan` takes it as `systemAudio: false` from the next
   * meeting on, which is what stops the app asking for Screen Recording every
   * time on a build that will never get it.
   */
  degradedChannels(): string[] {
    return [...this.#degraded];
  }

  async start(options: RecorderOptions): Promise<void> {
    if (this.#capturing) throw new Error("recorder already started");

    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: join(this.#rendererDir, "capturePreload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        // This window exists to hold a MediaRecorder. Nothing about it should
        // survive being backgrounded, which is what a menu-bar app's hidden
        // window always is.
        backgroundThrottling: false,
      },
    });

    // The renderer may have exactly one source, and it comes with the loopback
    // tap attached. `getDisplayMedia` in that window cannot reach anything we
    // did not hand it here.
    window.webContents.session.setDisplayMediaRequestHandler(
      (request, callback) => {
        /*
          THE ANSWER MATCHES THE REQUEST, OR THE REQUEST IS REFUSED OUT LOUD.

          What used to be here answered `{ audio: "loopback" }` unconditionally,
          under a comment claiming `video` was "required by the API and
          immediately discarded in the renderer". It was not: Chromium refuses a
          request whose video half nothing answers, throws *"Video was
          requested, but no video stream was provided"* straight back into this
          callback, and — because the handler is called from an async context —
          that became two `UnhandledPromiseRejectionWarning` lines on stderr
          every single time somebody pressed Record. The renderer's own `catch`
          then degraded the meeting to mic-only, so the app looked fine while
          system audio had in fact never worked once.

          `answerDisplayMedia` is the rule, in a file the suite can import.
          The `try` is the other half: `callback` can throw synchronously from
          inside Electron, and a throw here has to be a logged line rather than
          a rejection nobody owns.
        */
        const answer = answerDisplayMedia({
          videoRequested: request.videoRequested === true,
          audioRequested: request.audioRequested === true,
        });
        try {
          if (answer.kind === "refuse") {
            console.error(`[capture] ${answer.reason}; the request is refused`);
            // An empty answer is Electron's cancel. The renderer sees a
            // rejected `getDisplayMedia` and degrades, which is the path it is
            // already written for.
            callback({});
            return;
          }
          callback(answer.streams);
        } catch (error) {
          console.error(
            `[capture] the display-media request could not be answered: ${(error as Error).message}`,
          );
        }
      },
      { useSystemPicker: false },
    );

    // Both are `once`, and both are removed after the race whichever way it
    // goes: a `failed` listener left over from a successful start would still
    // be armed on the next meeting, and would reject a promise nobody is
    // waiting on any more.
    const failure = new Promise<never>((_resolve, reject) => {
      ipcMain.once(CAPTURE_FAILED, (_event, message: string) =>
        reject(new Error(String(message).slice(0, 200))),
      );
    });
    const ready = new Promise<string[]>((resolve) => {
      ipcMain.once(CAPTURE_READY, (_event, degraded: unknown) =>
        resolve(Array.isArray(degraded) ? degraded.map(String) : []),
      );
    });

    ipcMain.on(CAPTURE_CHUNK, (_event, chunk: CaptureChunk) => {
      this.#frames += 1;
      options.onFrame({
        channel: chunk.channel,
        atMs: Number(chunk.atMs) || 0,
        durationMs: Number(chunk.durationMs) || 0,
        mimeType: String(chunk.mimeType || "audio/webm"),
        data: new Uint8Array(chunk.data),
      });
    });

    await window.loadFile(join(this.#rendererDir, "capture.html"));
    window.webContents.send(CAPTURE_START, { channels: options.channels, sampleRate: options.sampleRate });
    try {
      this.#degraded = await Promise.race([ready, failure]);
    } catch (error) {
      await this.#abandon(window);
      throw error;
    } finally {
      ipcMain.removeAllListeners(CAPTURE_READY);
      ipcMain.removeAllListeners(CAPTURE_FAILED);
    }

    this.#window = window;
    this.#capturing = true;
    this.#paused = false;
    this.#startedAt = Date.now();
    this.#recordedMs = 0;
    this.#frames = 0;
  }

  /** A start that threw must leave no window and no live track behind. */
  async #abandon(window: BrowserWindow): Promise<void> {
    ipcMain.removeAllListeners(CAPTURE_CHUNK);
    if (!window.isDestroyed()) window.destroy();
  }

  async pause(): Promise<void> {
    if (!this.#capturing || this.#paused) return;
    this.#recordedMs += Date.now() - this.#startedAt;
    this.#paused = true;
    this.#window?.webContents.send(CAPTURE_PAUSE);
  }

  async resume(): Promise<void> {
    if (!this.#capturing || !this.#paused) return;
    this.#startedAt = Date.now();
    this.#paused = false;
    this.#window?.webContents.send(CAPTURE_RESUME);
  }

  async stop(): Promise<RecorderSummary> {
    if (!this.#capturing) return { recordedMs: this.#recordedMs, frames: this.#frames };
    if (!this.#paused) this.#recordedMs += Date.now() - this.#startedAt;
    this.#capturing = false;
    this.#paused = false;
    this.#window?.webContents.send(CAPTURE_STOP);
    /*
      The window is given a moment to hand over its last chunk before it is
      destroyed — the final seconds of a meeting are exactly the ones somebody
      wants — but a moment, not a wait: `stop()` is on the path between "the
      person pressed End" and the microphone closing, and the one thing that may
      not happen here is an open stream waiting on a renderer that has hung.
      The chunk listener is removed after it, so a late arrival is dropped
      rather than delivered into a session that is already finalized.
    */
    await new Promise((resolve) => setTimeout(resolve, LAST_CHUNK_GRACE_MS));
    ipcMain.removeAllListeners(CAPTURE_CHUNK);
    // Destroyed rather than hidden: a window holding a live MediaRecorder is a
    // microphone that is still open, and "the indicator is off but the stream
    // is not" is the exact failure this app must never have.
    this.#window?.destroy();
    this.#window = null;
    return { recordedMs: this.#recordedMs, frames: this.#frames };
  }
}

/**
 * How long `stop()` waits for the renderer's last chunk.
 *
 * Long enough for a `MediaRecorder.stop()` to fire `onstop` and an
 * `arrayBuffer()` to resolve — both are fast and local — and short enough that
 * a hung renderer cannot hold the microphone open while the UI says the meeting
 * has ended.
 */
const LAST_CHUNK_GRACE_MS = 400;
