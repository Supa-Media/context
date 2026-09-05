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
 * So this class owns a **hidden window** whose only job is to hold two
 * `MediaRecorder`s and post their chunks back. It is not visible, it has no
 * navigation, and it loads one local file.
 *
 * ### What is real here
 *
 * The wiring: the handler, the hidden window, the IPC, the frame plumbing into
 * `AudioRecorder`, pause and resume, and `recordedMs` excluding pauses.
 *
 * ### What is not, and cannot be from inside this repository
 *
 *  - **Entitlements and a signed build.** ScreenCaptureKit requires a hardened
 *    runtime, `com.apple.security.device.audio-input`, and a notarised,
 *    code-signed app. An unsigned development build gets a microphone and, in
 *    most macOS versions, silence from the loopback tap.
 *  - **`NSMicrophoneUsageDescription` and `NSCalendarsUsageDescription`** in
 *    `Info.plist`, which is a packaging step, not a source file.
 *  - **Electron ≥ 31** for `audio: "loopback"`; earlier versions have no
 *    system-audio path on macOS at all.
 *  - **A transcriber.** The frames arrive; `core/capture/transcriber.ts` says
 *    what still has to consume them.
 *
 * None of that can be verified by a test in CI, which is exactly why it is
 * written down here and in `README.md` rather than assumed to work.
 */

import { BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import type { AudioRecorder, RecorderOptions, RecorderSummary } from "../core/capture/recorder.ts";

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

  constructor(rendererDir: string) {
    this.#rendererDir = rendererDir;
  }

  get capturing(): boolean {
    return this.#capturing && !this.#paused;
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
      (_request, callback) => {
        // `video` is required by the API and immediately discarded in the
        // renderer: no frame is ever read, encoded, or written. Audio is the
        // only track this app keeps, and the permission macOS asks for is
        // still called Screen Recording — which is why the rationale in
        // `capture/permissions.ts` says so out loud rather than glossing it.
        callback({ audio: "loopback" });
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
    const ready = new Promise<void>((resolve) => {
      ipcMain.once(CAPTURE_READY, () => resolve());
    });

    ipcMain.on(CAPTURE_CHUNK, (_event, chunk: { channel: "mic" | "system"; atMs: number; data: Uint8Array }) => {
      this.#frames += 1;
      options.onFrame({ channel: chunk.channel, atMs: chunk.atMs, data: new Uint8Array(chunk.data) });
    });

    await window.loadFile(join(this.#rendererDir, "capture.html"));
    window.webContents.send(CAPTURE_START, { channels: options.channels, sampleRate: options.sampleRate });
    try {
      await Promise.race([ready, failure]);
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
    ipcMain.removeAllListeners(CAPTURE_CHUNK);
    // Destroyed rather than hidden: a window holding a live MediaRecorder is a
    // microphone that is still open, and "the indicator is off but the stream
    // is not" is the exact failure this app must never have.
    this.#window?.destroy();
    this.#window = null;
    return { recordedMs: this.#recordedMs, frames: this.#frames };
  }
}
