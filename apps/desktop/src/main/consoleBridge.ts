/**
 * The main process's half of `window.desktop` — and the guard that faces the page.
 *
 * `docs/decisions/desktop.md`, *Nothing that can start a recording may come from
 * an origin we did not pin*, names three independent guards. Two of them run in
 * the renderer or around the window: `shouldExposeBridge` decides what the
 * preload *exposes*, and `will-navigate`/`setWindowOpenHandler` decide where the
 * window may *go*. This file is the third, and it is the one that matters most
 * because **a compromised renderer is the threat model**: a check inside the
 * renderer is a check the attacker owns, so every channel answered here re-asks
 * who is asking, in a process the page cannot reach.
 *
 * ## What the sender check is
 *
 * Three facts about the asking frame, all required:
 *
 *  - **It is the console window's own `webContents`.** Identity, by id, against
 *    the window this process created. This is what refuses *another* window in
 *    this app — including the hidden capture window, which holds a live
 *    microphone and must never be able to drive the queue or the grant.
 *  - **It is a document at the pinned origin.** This is what refuses *this*
 *    window on a page it should not be on: a redirect chain, a
 *    `will-navigate` regression, a future relaxation of either. Compared as
 *    whole origins — a prefix match would hand the bridge to
 *    `https://context.lc.attacker.invalid`.
 *  - **It is the top frame.** A preload runs in every frame; an iframe on the
 *    console page is otherwise a fully-privileged bridge belonging to whoever
 *    the page embedded.
 *
 * The origin comparison is written out here rather than delegated to
 * `shouldExposeBridge`, and that is deliberate: the two guards must be able to
 * fail independently, or the sabotage that proves they are not one check
 * written twice cannot be run. `test/consoleBridge.test.mjs` records both
 * counts.
 *
 * ## Why an answer is an envelope
 *
 * `{ ok: true, value }` / `{ ok: false, message }` rather than a value or a
 * throw. A promise rejected inside `ipcMain.handle` reaches the renderer as
 * `Error: Error invoking remote method '<channel>': …`, and the page renders
 * that string at a person — so a refusal a person is meant to read travels as
 * data, carrying a sentence `capture/plan.ts` or `consent/gate.ts` owns.
 *
 * A **refused sender** is the exception and throws, because it is an attack
 * rather than a state: there is no sentence to show, nobody legitimate is
 * waiting for the answer, and a rejected promise is the least useful thing to
 * hand whoever sent it.
 *
 * ## No Electron is imported here
 *
 * Everything is structural — an `ipcMain`-shaped host, a window-shaped object,
 * an event-shaped sender — so the whole surface is driven by the suite. That is
 * the same reason `core/shell/console.ts` is a pure module: a guard that can
 * only be exercised by launching an app is a guard nobody has checked.
 */

import {
  BRIDGE_CHANNELS,
  TRAY_COMMANDS,
  type CaptureStarted,
  type CaptureStateUpdate,
  type CaptureSummary,
  type ConnectionView,
  type DesktopCapabilities,
  type DesktopShell,
  type DetectionView,
  type OutboxStatus,
  type StartCaptureRequest,
  type TranscriptSegment,
  type TrayCommand,
} from "@context/desktop-bridge";

/** An `IpcMainInvokeEvent`/`IpcMainEvent`, as much of one as the guard reads. */
export interface BridgeSenderEvent {
  sender?: { id?: unknown } | null;
  senderFrame?: { url?: unknown; parent?: unknown } | null;
  /** Set on the synchronous channels. `null` is the refusal. */
  returnValue?: unknown;
}

/** The half of `ipcMain` this file uses, and the whole of it. */
export interface IpcHost {
  handle(channel: string, listener: (event: BridgeSenderEvent, payload: unknown) => unknown): void;
  removeHandler(channel: string): void;
  on(channel: string, listener: (event: BridgeSenderEvent, payload: unknown) => void): void;
  removeAllListeners(channel: string): void;
}

/** The console window, as much of one as this file touches. */
export interface ConsoleWindowLike {
  isDestroyed(): boolean;
  webContents: { id: number; send(channel: string, payload?: unknown): void };
}

/** What the shell pushes to the page whenever anything moves. */
export interface ConsoleBridgeView {
  captureState: CaptureStateUpdate;
  connection: ConnectionView;
  outbox: OutboxStatus;
  detection: DetectionView | null;
}

export interface ConsoleBridgeDeps {
  ipc: IpcHost;
  /** The origin the window was pinned to, from `consoleOrigin(consoleUrl(env))`. */
  pinned: string;
  /** The console window, or `null` before it exists / after it is gone. */
  window: () => ConsoleWindowLike | null;
  shell: () => DesktopShell;
  capabilities: () => DesktopCapabilities;
  startCapture: (request: StartCaptureRequest) => Promise<CaptureStarted>;
  pauseCapture: () => Promise<void>;
  resumeCapture: () => Promise<void>;
  stopCapture: () => Promise<CaptureSummary>;
  connection: () => ConnectionView;
  connect: () => void;
  disconnect: () => void;
  outbox: () => OutboxStatus;
  drain: () => void;
}

export interface ConsoleBridge {
  /** Push the four subscribable views. Silent when there is no window. */
  push(view: ConsoleBridgeView): void;
  emitSegment(segment: TranscriptSegment): void;
  emitTrayCommand(command: TrayCommand): void;
  /** Unregister every channel. For a window that is going away for good. */
  dispose(): void;
}

/** Everything this file may put in front of a person, and the whole of it. */
export const CONSOLE_BRIDGE_MESSAGES = Object.freeze({
  noSession: "This meeting has no id, so there is nothing to file its recording under.",
  refused: "The Context app on this machine could not start recording.",
});

/**
 * Whether this event came from the console window's own top frame.
 *
 * The identity half and the frame half, without the origin. Split out because
 * the two synchronous channels cannot ask the origin question without asking it
 * circularly — the preload is calling them to find out *what* the pinned origin
 * is, before it knows whether the document it is in matches. See `answerSync`.
 */
export function isConsoleFrame(event: BridgeSenderEvent, webContentsId: number | null): boolean {
  if (webContentsId === null) return false;

  const senderId = event.sender?.id;
  if (typeof senderId !== "number" || senderId !== webContentsId) return false;

  const frame = event.senderFrame;
  if (frame === null || frame === undefined) return false;
  // `parent === null` is Electron's own answer for "this is the top frame".
  // Anything else — including an absent property — is refused rather than
  // assumed, because absence here is exactly what a subframe would look like to
  // a check written the other way round.
  return frame.parent === null;
}

/**
 * Whether this event came from the console window, at the pinned origin, in its
 * top frame. See the header for what each third of that refuses.
 */
export function isBridgeSender(
  event: BridgeSenderEvent,
  expected: { webContentsId: number | null; pinned: string },
): boolean {
  if (!isConsoleFrame(event, expected.webContentsId)) return false;
  if (expected.pinned === "" || expected.pinned === "null") return false;

  let origin = "";
  try {
    origin = new URL(String(event.senderFrame?.url)).origin;
  } catch {
    return false;
  }
  if (origin === "" || origin === "null") return false;
  return origin === expected.pinned;
}

/** The request the page made, read rather than trusted. */
function startRequestFrom(payload: unknown): StartCaptureRequest | null {
  const source = (typeof payload === "object" && payload !== null ? payload : {}) as Record<
    string,
    unknown
  >;
  const sessionId = typeof source.sessionId === "string" ? source.sessionId.trim() : "";
  if (sessionId === "") return null;
  return { sessionId, mic: source.mic === true, systemAudio: source.systemAudio === true };
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== "" ? error.message : fallback;
}

/**
 * Register every channel the contract names, guarded.
 *
 * Registered *before* the window is created — `window` is a getter for exactly
 * that reason — because the preload's two synchronous calls happen while the
 * page is loading, and a handler registered after `loadURL` is a race whose
 * losing side is a window with no bridge on it.
 */
export function createConsoleBridge(deps: ConsoleBridgeDeps): ConsoleBridge {
  const windowId = (): number | null => {
    const win = deps.window();
    if (win === null || win.isDestroyed()) return null;
    return win.webContents.id;
  };

  const allowed = (event: BridgeSenderEvent): boolean =>
    isBridgeSender(event, { webContentsId: windowId(), pinned: deps.pinned });

  /** A handled channel: guarded, enveloped, and never throwing a sentence. */
  function handle<T>(channel: string, run: (payload: unknown) => T | Promise<T>): void {
    deps.ipc.handle(channel, async (event, payload) => {
      if (!allowed(event)) {
        /*
          Thrown rather than answered. See the header: this is not a state a
          person is in, it is a frame that is not the one this bridge belongs
          to, and the channel name is deliberately not in the message.
        */
        throw new Error("refused");
      }
      try {
        return { ok: true as const, value: await run(payload) };
      } catch (error) {
        return { ok: false as const, message: messageOf(error, CONSOLE_BRIDGE_MESSAGES.refused) };
      }
    });
  }

  /**
   * A synchronous channel: the pin, and what to call this shell.
   *
   * Guarded on **identity and frame only**, and the missing third is the point.
   * These two run at document start, before the preload knows which origin it
   * is on — asking "is this the pinned origin" in order to answer "what is the
   * pinned origin" is circular, and a frame url that has not settled yet would
   * fail closed and leave the window with no bridge at all.
   *
   * That is safe because both values are public: the origin is already in the
   * window's own URL bar, and the app's name and version are on its About
   * panel. Neither is a credential and neither may ever become one — which is
   * the property this comment exists to hold against the next addition here.
   * The *decision* these two feed is still made in the renderer, by
   * `shouldExposeBridge`, against `location.origin` — which the renderer knows
   * exactly and this process would only be guessing at.
   */
  function answerSync(channel: string, value: () => unknown): void {
    deps.ipc.on(channel, (event) => {
      event.returnValue = isConsoleFrame(event, windowId()) ? value() : null;
    });
  }

  answerSync(BRIDGE_CHANNELS.origin, () => deps.pinned);
  answerSync(BRIDGE_CHANNELS.shell, () => ({ ...deps.shell() }));

  handle(BRIDGE_CHANNELS.capabilities, () => ({ ...deps.capabilities() }));
  handle(BRIDGE_CHANNELS.startCapture, (payload) => {
    const request = startRequestFrom(payload);
    if (request === null) throw new Error(CONSOLE_BRIDGE_MESSAGES.noSession);
    return deps.startCapture(request);
  });
  handle(BRIDGE_CHANNELS.pauseCapture, async () => {
    await deps.pauseCapture();
    return null;
  });
  handle(BRIDGE_CHANNELS.resumeCapture, async () => {
    await deps.resumeCapture();
    return null;
  });
  handle(BRIDGE_CHANNELS.stopCapture, () => deps.stopCapture());

  handle(BRIDGE_CHANNELS.connectionGet, () => ({ ...deps.connection() }));
  handle(BRIDGE_CHANNELS.connectionConnect, () => {
    deps.connect();
    return null;
  });
  handle(BRIDGE_CHANNELS.connectionDisconnect, () => {
    deps.disconnect();
    return null;
  });

  handle(BRIDGE_CHANNELS.outboxStatus, () => ({ ...deps.outbox() }));
  handle(BRIDGE_CHANNELS.outboxDrain, () => {
    deps.drain();
    return null;
  });

  function send(channel: string, payload: unknown): void {
    const win = deps.window();
    if (win === null || win.isDestroyed()) return;
    win.webContents.send(channel, payload);
  }

  return {
    push(view: ConsoleBridgeView): void {
      send(BRIDGE_CHANNELS.captureState, view.captureState);
      send(BRIDGE_CHANNELS.connectionChange, view.connection);
      send(BRIDGE_CHANNELS.outboxChange, view.outbox);
      send(BRIDGE_CHANNELS.detection, view.detection);
    },
    emitSegment(segment: TranscriptSegment): void {
      send(BRIDGE_CHANNELS.segment, segment);
    },
    emitTrayCommand(command: TrayCommand): void {
      if (!TRAY_COMMANDS.includes(command)) return;
      send(BRIDGE_CHANNELS.trayCommand, command);
    },
    dispose(): void {
      for (const channel of [
        BRIDGE_CHANNELS.capabilities,
        BRIDGE_CHANNELS.startCapture,
        BRIDGE_CHANNELS.pauseCapture,
        BRIDGE_CHANNELS.resumeCapture,
        BRIDGE_CHANNELS.stopCapture,
        BRIDGE_CHANNELS.connectionGet,
        BRIDGE_CHANNELS.connectionConnect,
        BRIDGE_CHANNELS.connectionDisconnect,
        BRIDGE_CHANNELS.outboxStatus,
        BRIDGE_CHANNELS.outboxDrain,
      ]) {
        deps.ipc.removeHandler(channel);
      }
      deps.ipc.removeAllListeners(BRIDGE_CHANNELS.origin);
      deps.ipc.removeAllListeners(BRIDGE_CHANNELS.shell);
    },
  };
}
