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

import { isMeetingId } from "@context/meetings/protocol";
import {
  BRIDGE_CHANNELS,
  MEETING_WRITE_KINDS,
  TRAY_COMMANDS,
  type CaptureStarted,
  type CaptureStateUpdate,
  type CaptureSummary,
  type ConnectionView,
  type DesktopCapabilities,
  type DesktopShell,
  type DetectionView,
  type ImessageStatus,
  type MachineApprovalResult,
  type MeetingWrite,
  type MeetingWriteAck,
  type MeetingWriteKind,
  type OutboxStatus,
  type PendingMachineApproval,
  type StartCaptureRequest,
  type TranscriptSegment,
  type TrayCommand,
} from "@context/desktop-bridge";
import { originOfUrl } from "../core/shell/mirror.ts";

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
  /**
   * The origin the window is pinned to *right now*.
   *
   * A getter rather than a value, because there are two origins this shell may
   * legitimately be serving and only ever one at a time: the live console, and
   * the offline mirror at `app://console`. `consoleMirror.ts` derives which
   * from the URL the window has committed to (`pinnedOriginFor`), so falling
   * back to the mirror moves the trust *instead of* widening it — a frame still
   * claiming the live origin is refused the moment the mirror is being served,
   * and a frame claiming the mirror is refused while the live page is loaded.
   */
  pinned: () => string;
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
  /**
   * The parked authorization request this machine is waiting on, or `null`.
   *
   * The version-3 addition. A request id is not a credential — it is the
   * address of a question the control plane is holding, answerable only by
   * somebody signed in — and handing it to the page is what lets the person
   * already signed in *in this window* answer it with no approve screen.
   * `core/shell/autoGrant.ts` carries the argument.
   */
  pendingApproval: () => PendingMachineApproval | null;
  /**
   * What the page did about it.
   *
   * `approved: false` is the ordinary answer from a page that could not, and
   * the shell answers it by putting the approve screen in this window — which
   * is exactly what #312 shipped. A result naming a request this machine is not
   * waiting on does nothing at all.
   */
  resolveApproval: (result: MachineApprovalResult) => void;
  outbox: () => OutboxStatus;
  drain: () => void;
  /**
   * One write about a meeting, into this machine's own queue.
   *
   * The version-2 addition, and the reason it exists: without it a meeting
   * recorded on a Mac takes two credentials — the shell's grant for the audio
   * and the page's control-plane session for the note — and the shell's
   * window-less queue is not on the path at all.
   */
  writeMeeting: (write: MeetingWrite) => Promise<MeetingWriteAck>;
  /**
   * Whether this machine imports iMessage history, and what it knows about
   * Full Disk Access. The version-5 addition — see `packages/desktop-bridge`'s
   * `imessage` member for the reasoning behind its shape.
   */
  imessage: () => ImessageStatus;
  /** Turn import on or off. Never touches the microphone, the calendar, or anything else the tray already gates. */
  setImessageEnabled: (enabled: boolean) => void;
}

export interface ConsoleBridge {
  /** Push the four subscribable views. Silent when there is no window. */
  push(view: ConsoleBridgeView): void;
  emitSegment(segment: TranscriptSegment): void;
  /** Tell the page a machine approval opened, or that it is over (`null`). */
  emitPendingApproval(pending: PendingMachineApproval | null): void;
  emitTrayCommand(command: TrayCommand): void;
  /** Tell the page iMessage's enabled/permission/last-sync state changed. */
  emitImessage(status: ImessageStatus): void;
  /** Unregister every channel. For a window that is going away for good. */
  dispose(): void;
}

/** Everything this file may put in front of a person, and the whole of it. */
export const CONSOLE_BRIDGE_MESSAGES = Object.freeze({
  noSession: "This meeting has no id, so there is nothing to file its recording under.",
  refused: "The Context app on this machine could not start recording.",
  unwritable: "This machine could not take that meeting, so it is being kept where it is.",
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

  /*
    Every read below is a *getter on a live Electron object*, and two of them
    throw rather than answer once the thing behind them has gone away:
    `event.senderFrame` raises "Render frame was disposed before WebFrameMain
    could be accessed" for a frame that navigated or closed while the call was
    in flight, and `event.sender.id` raises "Object has been destroyed" for a
    webContents that is gone. Both are ordinary — a page reloaded mid-drain
    produces the first — and neither may become a throw out of this guard: on
    `handle` that is a rejection carrying Electron's own text, and on the two
    synchronous channels it is a listener that never sets `returnValue`, which
    leaves the preload's `sendSync` waiting. So the read is the guarded part and
    the answer to any of it going wrong is the same as every other refusal here.
  */
  try {
    const senderId = event.sender?.id;
    if (typeof senderId !== "number" || senderId !== webContentsId) return false;

    const frame = event.senderFrame;
    if (frame === null || frame === undefined) return false;
    // `parent === null` is Electron's own answer for "this is the top frame".
    // Anything else — including an absent property — is refused rather than
    // assumed, because absence here is exactly what a subframe would look like
    // to a check written the other way round.
    return frame.parent === null;
  } catch {
    return false;
  }
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
    /*
      Inside the `try` because reading `senderFrame` can throw for a frame that
      has gone away, exactly as in `isConsoleFrame`.

      `originOfUrl` rather than `new URL(...).origin`, and that is not tidying:
      Node's URL answers `"null"` for `app://console/...` because it was never
      told the scheme is standard, while Chromium — which *was* told, by
      `registerSchemesAsPrivileged` — reports `location.origin` as
      `app://console`. Written the obvious way, this guard refuses the offline
      page the shell is itself serving, and the mirror loads with no bridge and
      nothing to say about the queue.
    */
    origin = originOfUrl(event.senderFrame?.url);
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
  if (!isMeetingId(sessionId)) return null;
  return { sessionId, mic: source.mic === true, systemAudio: source.systemAudio === true };
}

/**
 * The write the page asked for, read rather than trusted.
 *
 * `null` for anything that is not one: no session to file it under, or a kind
 * that is not one of the protocol's four routes. The **body** is passed through
 * as an object because it is the protocol's own JSON and this file is not the
 * protocol — what stops that being a hole is that the body never chooses an
 * address. The route comes from `kind` and the context from `context`, and both
 * are read against closed sets here and again in `contextRouteFor`.
 *
 * **That argument named two of the address's three inputs.** The session id is
 * the third, it went into `ROUTES.*` by raw interpolation, and it was checked
 * only for being non-empty — so a page could pick the path while this paragraph
 * said the body could not. `fetch` normalises, so `a/../../../mcp#` reached
 * `POST /mcp` with this machine's grant and a body the page also chose. It is
 * `isMeetingId` now, the same predicate the gateway applies to the same value,
 * and `ROUTES` encodes and refuses dot segments as well — a validator protects
 * one caller, an encoder protects the shape.
 */
function meetingWriteFrom(payload: unknown): MeetingWrite | null {
  const source = (typeof payload === "object" && payload !== null ? payload : {}) as Record<
    string,
    unknown
  >;
  const sessionId = typeof source.sessionId === "string" ? source.sessionId.trim() : "";
  /*
    `isMeetingId` and not "non-empty", because this id is interpolated raw into
    `ROUTES.*` and sent with this machine's grant — see the block in
    `test/consoleBridge.test.mjs`. Whoever picks the id picks the endpoint, and
    this is the same predicate the gateway already applies to the same value.
  */
  if (!isMeetingId(sessionId)) return null;
  if (!MEETING_WRITE_KINDS.includes(source.kind as MeetingWriteKind)) return null;
  const body = source.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  return {
    sessionId,
    kind: source.kind as MeetingWriteKind,
    /*
      An **empty** context is carried rather than read as "none", and the
      difference is the whole of `routableContext`: absent is this machine's own
      context and is a correct address, while a name that cannot be read is one
      nobody can route to. Collapsing `""` to `null` here would turn the second
      into the first — a meeting filed in whatever context this credential
      defaults to, silently, which is the one outcome the queue refuses to send.
    */
    context: typeof source.context === "string" ? source.context : null,
    body: body as Record<string, unknown>,
  };
}

/**
 * What the page says it did about a parked approval, read against the contract.
 *
 * `null` for anything that is not two well-formed fields. The id is checked for
 * *shape* rather than compared here: which request is in flight is the main
 * process's own fact, and `ApprovalHandover.take` is where a stale or invented
 * id becomes inert. This is the same split as everywhere else in this file —
 * the renderer's payload is normalised at the boundary and authorised inside.
 */
function approvalResultFrom(payload: unknown): MachineApprovalResult | null {
  const source = (typeof payload === "object" && payload !== null ? payload : {}) as Record<
    string,
    unknown
  >;
  const requestId = typeof source.requestId === "string" ? source.requestId : "";
  if (requestId === "" || requestId.length > 256) return null;
  return { requestId, approved: source.approved === true };
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
    // `isDestroyed()` and `webContents` are both live Electron reads, and a
    // window torn down between the two throws rather than answering. No window
    // is the honest reading of that, and it refuses everything.
    try {
      const win = deps.window();
      if (win === null || win.isDestroyed()) return null;
      return win.webContents.id;
    } catch {
      return null;
    }
  };

  /*
    Read on every call, and never captured. A pin read once at construction is
    a pin that keeps trusting the live origin after the shell has fallen back
    to the mirror — and answers `app://console` with nothing.
  */
  const pinnedNow = (): string => {
    try {
      return deps.pinned();
    } catch {
      return "";
    }
  };

  const allowed = (event: BridgeSenderEvent): boolean =>
    isBridgeSender(event, { webContentsId: windowId(), pinned: pinnedNow() });

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
      /*
        `returnValue` is set on every path, including the ones that went wrong.

        A synchronous IPC listener that throws leaves `returnValue` unset, and
        the renderer's `sendSync` is *blocking* while it waits: the preload runs
        at document start, so the failure mode is a window that never paints
        rather than a window with no bridge. `null` is what the preload already
        reads as "no pin", and it fails closed there.
      */
      try {
        event.returnValue = isConsoleFrame(event, windowId()) ? value() : null;
      } catch {
        event.returnValue = null;
      }
    });
  }

  answerSync(BRIDGE_CHANNELS.origin, () => pinnedNow());
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

  handle(BRIDGE_CHANNELS.connectionPendingApproval, () => {
    const pending = deps.pendingApproval();
    // Rebuilt from the one field the contract declares, like every answer here:
    // a main process that grew a second one does not start shipping it to a
    // page served from the network.
    return pending === null ? null : { requestId: pending.requestId };
  });
  handle(BRIDGE_CHANNELS.connectionResolveApproval, (payload) => {
    const result = approvalResultFrom(payload);
    // A malformed answer is dropped rather than refused: there is no sentence
    // worth showing anybody, and the connect it was about is either already
    // over or about to time out into the approve screen.
    if (result !== null) deps.resolveApproval(result);
    return null;
  });

  handle(BRIDGE_CHANNELS.meetingsWrite, (payload) => {
    const write = meetingWriteFrom(payload);
    if (write === null) throw new Error(CONSOLE_BRIDGE_MESSAGES.unwritable);
    return deps.writeMeeting(write);
  });

  handle(BRIDGE_CHANNELS.outboxStatus, () => ({ ...deps.outbox() }));
  handle(BRIDGE_CHANNELS.outboxDrain, () => {
    deps.drain();
    return null;
  });

  handle(BRIDGE_CHANNELS.imessageStatus, () => ({ ...deps.imessage() }));
  handle(BRIDGE_CHANNELS.imessageSetEnabled, (payload) => {
    const enabled = (payload as { enabled?: unknown } | undefined)?.enabled === true;
    deps.setImessageEnabled(enabled);
    return null;
  });

  function send(channel: string, payload: unknown): void {
    /*
      A window that went away between the check and the send throws, and one
      push is four sends: without this, a window closed mid-`push` would take
      the connection, queue and detection updates down with the capture one —
      and the caller is `push()` in `main/index.ts`, which every state change in
      the shell runs through.
    */
    try {
      const win = deps.window();
      if (win === null || win.isDestroyed()) return;
      win.webContents.send(channel, payload);
    } catch {
      /* The window is gone. There is nobody to tell, and nothing to record. */
    }
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
    /*
      Pushed rather than polled, and `null` is a value on this channel: it is
      how the shell says the approval is over — approved, refused, timed out or
      abandoned — so the card stops offering to mint one. Wrapped in an
      envelope because the preload's `subscribe` reads a `null` payload as a
      frame with nothing in it.
    */
    emitPendingApproval(pending: PendingMachineApproval | null): void {
      send(BRIDGE_CHANNELS.pendingApprovalChange, {
        pending: pending === null ? null : { requestId: pending.requestId },
      });
    },
    emitTrayCommand(command: TrayCommand): void {
      if (!TRAY_COMMANDS.includes(command)) return;
      send(BRIDGE_CHANNELS.trayCommand, command);
    },
    emitImessage(status: ImessageStatus): void {
      send(BRIDGE_CHANNELS.imessageChange, { ...status });
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
        BRIDGE_CHANNELS.connectionPendingApproval,
        BRIDGE_CHANNELS.connectionResolveApproval,
        BRIDGE_CHANNELS.outboxStatus,
        BRIDGE_CHANNELS.outboxDrain,
        BRIDGE_CHANNELS.meetingsWrite,
        BRIDGE_CHANNELS.imessageStatus,
        BRIDGE_CHANNELS.imessageSetEnabled,
      ]) {
        deps.ipc.removeHandler(channel);
      }
      deps.ipc.removeAllListeners(BRIDGE_CHANNELS.origin);
      deps.ipc.removeAllListeners(BRIDGE_CHANNELS.shell);
    },
  };
}
