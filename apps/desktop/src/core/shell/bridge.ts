/**
 * `window.desktop`, built here and handed to `contextBridge` by the preload.
 *
 * The preload itself is four lines over this file, and that split is the whole
 * point: everything below is a pure function of an injected `ipcRenderer`, so
 * the surface a remote origin is actually given can be driven, walked and
 * validated by `test/consoleBridge.test.mjs` rather than by launching Electron
 * and pointing it at a hostile server. `shouldExposeBridge` was already written
 * that way for the same reason; this is the rest of the preload catching up.
 *
 * ## Three properties this file exists to hold
 *
 * **There is no generic `invoke`.** Every method below names one channel from
 * `BRIDGE_CHANNELS`, and adding one is a change to `packages/desktop-bridge`,
 * which is a change somebody reviews. A `desktop.invoke(channel, args)` would
 * make that review meaningless the day after it was added.
 *
 * **Nothing credential-shaped crosses, and that is enforced by construction
 * rather than by inspection.** Every payload — in both directions — is rebuilt
 * here from the keys the contract declares. A main process that grew a field
 * does not silently start shipping it to a page served from the network, and a
 * page that added one to a `startCapture` request does not get it forwarded
 * into the shell. The check is cheap, it is one function per shape, and it is
 * the difference between "we did not put a token in the payload" and "a token
 * in the payload would not arrive".
 *
 * **Every subscription hands back an unsubscribe that really detaches.** The
 * old `preload/index.ts` `onState` does not, which was right for one long-lived
 * renderer script and is wrong for a React tree: a handler that cannot be
 * removed is a leak per navigation and a second copy of every segment on the
 * next meeting. The listener registered on `ipcRenderer` is the one removed.
 *
 * ## Why a refusal is an answer rather than a throw
 *
 * A promise rejected inside `ipcMain.handle` reaches the renderer as
 * `Error: Error invoking remote method 'context:console-capture-start': …`, and the
 * page renders `error.message` at a person — `capture/desktop.ts` says so:
 * *"The message is the shell's own sentence when it gave one"*. So the main
 * process answers `{ ok: false, message }` with a sentence `capture/plan.ts`
 * owns, and this file turns that into a thrown `Error` carrying only that
 * sentence. A channel that genuinely could not be reached — no handler, a
 * window mid-teardown, a refused sender — gets this file's own fixed sentence
 * instead, because Electron's wrapper text names a channel and is written for
 * whoever is debugging rather than for whoever is in a meeting.
 */

import {
  BRIDGE_CHANNELS,
  BRIDGE_VERSION,
  NO_CAPABILITIES,
  TRAY_COMMANDS,
  capabilitiesFrom,
  type AudioLevel,
  type CaptureStarted,
  type CaptureState,
  type CaptureStateUpdate,
  type CaptureSummary,
  type ConnectionView,
  type DesktopBridge,
  type DesktopCapabilities,
  type DesktopShell,
  type DetectionView,
  type MeetingWrite,
  type MeetingWriteAck,
  type OutboxStatus,
  type StartCaptureRequest,
  type TranscriptSegment,
  type TrayCommand,
  type Unsubscribe,
} from "@context/desktop-bridge";
import { shouldExposeBridge } from "./console.ts";

/**
 * What the main process answers on a channel it handles.
 *
 * Never a bare value: see the header. `message` is a sentence written for a
 * person by `capture/plan.ts`, `consent/gate.ts` or this app's own copy — never
 * an upstream error's text, and never a channel name.
 */
export type BridgeReply<T> = { ok: true; value: T } | { ok: false; message: string };

/** The half of `ipcRenderer` this file uses, and the whole of it. */
export interface PreloadIpc {
  sendSync(channel: string): unknown;
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  on(channel: string, listener: (event: unknown, payload: unknown) => void): void;
  removeListener(channel: string, listener: (event: unknown, payload: unknown) => void): void;
}

/** The half of `contextBridge` this file uses. */
export interface PreloadHost {
  exposeInMainWorld(key: string, value: unknown): void;
}

/** Where the preload is running, as two facts `shouldExposeBridge` reads. */
export interface PreloadDocument {
  /** `location.origin` of the document this preload is running in. */
  origin: string;
  /** `window === window.top`. A preload runs in every frame. */
  isTopFrame: boolean;
}

/**
 * Everything this file may put in front of a person, and the whole of it.
 *
 * The same closed-set rule `PLAN_NOTICES` and the phone's `CAPTURE_MESSAGES`
 * keep, for the same reason: a message assembled from an upstream error is how
 * a channel name, a URL, or a fragment of a payload ends up on the glass.
 */
export const BRIDGE_MESSAGES = Object.freeze({
  unreachable: "The Context app on this machine did not answer.",
});

/* ----------------------------- reading answers ---------------------------- */

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function sentence(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * A shell descriptor, or `null` from a shell that would not say.
 *
 * The platform is read against the contract's three words rather than passed
 * through: `machineTitle` in the app switches on it, and an unknown value there
 * would be rendered as part of a heading somebody reads.
 */
function shellFrom(answer: unknown): DesktopShell | null {
  const source = record(answer);
  const platform = source.platform;
  if (platform !== "macos" && platform !== "windows" && platform !== "linux") return null;
  const app = text(source.app);
  if (app === "") return null;
  return { app, version: text(source.version), platform };
}

const CAPTURE_STATES: readonly CaptureState[] = ["idle", "recording", "paused", "stopped"];

function captureState(value: unknown): CaptureState {
  return CAPTURE_STATES.includes(value as CaptureState) ? (value as CaptureState) : "idle";
}

function segmentFrom(payload: unknown): TranscriptSegment {
  const source = record(payload);
  const channel = source.channel;
  return {
    id: text(source.id),
    startMs: count(source.startMs),
    endMs: count(source.endMs),
    text: text(source.text),
    speaker: sentence(source.speaker),
    // `mixed` rather than a throw: a segment whose channel this bundle does not
    // know is still somebody's words, and the channel is a label on a rail.
    channel: channel === "mic" || channel === "system" ? channel : "mixed",
    confidence: typeof source.confidence === "number" ? source.confidence : null,
  };
}

function levelFrom(payload: unknown): AudioLevel {
  const source = record(payload);
  return { mic: count(source.mic), systemAudio: count(source.systemAudio) };
}

function captureStateFrom(payload: unknown): CaptureStateUpdate {
  const source = record(payload);
  const fault = record(source.fault);
  return {
    state: captureState(source.state),
    capturing: source.capturing === true,
    fault:
      source.fault === null || source.fault === undefined
        ? null
        : { recoverable: fault.recoverable === true, message: text(fault.message) },
  };
}

function connectionFrom(payload: unknown): ConnectionView {
  const source = record(payload);
  const state = source.state;
  return {
    state: state === "connected" || state === "revoked" ? state : "disconnected",
    gateway: sentence(source.gateway),
    encrypted: source.encrypted === true,
    connecting: source.connecting === true,
    error: sentence(source.error),
  };
}

function outboxFrom(payload: unknown): OutboxStatus {
  const source = record(payload);
  return {
    pending: count(source.pending),
    parked: count(source.parked),
    lastError: sentence(source.lastError),
  };
}

function detectionFrom(payload: unknown): DetectionView {
  const source = record(payload);
  return {
    active: source.active === true,
    episode: sentence(source.episode),
    suggestedTitle: sentence(source.suggestedTitle),
    sourceLabel: text(source.sourceLabel, "a meeting"),
    summary: text(source.summary),
    // Attacker-controlled text — a window title is whatever somebody named
    // their document — so it is carried as strings and rendered as text.
    evidence: Array.isArray(source.evidence) ? source.evidence.map((line) => text(line)) : [],
    degradedNotice: sentence(source.degradedNotice),
    attendees: count(source.attendees),
  };
}

function startedFrom(payload: unknown, request: StartCaptureRequest): CaptureStarted {
  const source = record(payload);
  const transcribesAt = source.transcribesAt;
  return {
    sessionId: text(source.sessionId, request.sessionId),
    // Only `true` is true, so a shell that answered anything else is read as
    // having opened nothing — `capabilitiesFrom`'s rule, one message over.
    mic: source.mic === true,
    systemAudio: source.systemAudio === true,
    startedAtMs: count(source.startedAtMs),
    transcribesAt:
      transcribesAt === "device" || transcribesAt === "cloud" ? transcribesAt : "nowhere",
    notice: sentence(source.notice),
  };
}

function writeAckFrom(payload: unknown, sessionId: string): MeetingWriteAck {
  const source = record(payload);
  const rejected = record(source.rejected);
  return {
    sessionId: text(source.sessionId, sessionId),
    queued: source.queued === true,
    notePath: sentence(source.notePath),
    rejected:
      source.rejected === null || source.rejected === undefined
        ? null
        : { code: text(rejected.code), message: text(rejected.message) },
  };
}

function summaryFrom(payload: unknown): CaptureSummary {
  const source = record(payload);
  return {
    sessionId: text(source.sessionId),
    endedAtMs: count(source.endedAtMs),
    durationMs: count(source.durationMs),
    segments: count(source.segments),
    pending: count(source.pending),
  };
}

/* ------------------------------- the surface ------------------------------ */

/**
 * Ask a channel, and turn every way it can go wrong into one sentence.
 *
 * A rejected `invoke`, a reply that is not an envelope and an explicit refusal
 * are three different situations and exactly one of them carries something
 * worth showing: the refusal's own sentence. The other two get
 * `BRIDGE_MESSAGES.unreachable`, because Electron's wrapper names a channel.
 */
async function ask<T>(
  ipc: PreloadIpc,
  channel: string,
  payload: unknown,
  read: (value: unknown) => T,
): Promise<T> {
  let reply: unknown;
  try {
    reply = await ipc.invoke(channel, payload);
  } catch {
    throw new Error(BRIDGE_MESSAGES.unreachable);
  }
  const envelope = record(reply);
  if (envelope.ok === true) return read(envelope.value);
  throw new Error(text(envelope.message) || BRIDGE_MESSAGES.unreachable);
}

/** A verb with nothing to hand back. Fire and forget; a refusal is not raised. */
function tell(ipc: PreloadIpc, channel: string): void {
  void ipc.invoke(channel).catch(() => {
    /*
      Deliberately silent, and it is the honest shape for these three verbs.
      `connect`, `disconnect` and `drain` return `void` on the contract — the
      page learns what happened from `connection.onChange` and
      `outbox.onChange`, which are the same events the tray and the queue push
      anyway. An unhandled rejection here would be an error nobody asked for
      about a call whose answer arrives elsewhere.
    */
  });
}

/** Subscribe to a pushed channel, normalising every payload on the way in. */
function subscribe<T>(
  ipc: PreloadIpc,
  channel: string,
  read: (payload: unknown) => T | null,
  handler: (value: T) => void,
): Unsubscribe {
  const listener = (_event: unknown, payload: unknown): void => {
    const value = read(payload);
    if (value === null) return;
    try {
      handler(value);
    } catch {
      // One screen's bug is not a reason to take the shell's push loop down.
    }
  };
  ipc.on(channel, listener);
  let attached = true;
  return () => {
    if (!attached) return;
    attached = false;
    ipc.removeListener(channel, listener);
  };
}

/**
 * The bridge object itself, frozen, over one `ipcRenderer`.
 *
 * `shell` is read synchronously at construction because the bridge has to be on
 * `window` before the page's first script runs, and `sendSync` is the only call
 * in this file that is not a channel the page can reach. Both values it fetches
 * are public: the origin is already in the window's own URL, and the app's name
 * and version are on the About panel.
 */
export function desktopBridge(ipc: PreloadIpc): DesktopBridge {
  let shell: DesktopShell | null = null;
  try {
    shell = shellFrom(ipc.sendSync(BRIDGE_CHANNELS.shell));
  } catch {
    shell = null;
  }

  return Object.freeze({
    version: BRIDGE_VERSION,
    shell,

    /*
      A shell that will not answer reports every capability `false` rather than
      rejecting. `resolveRecorder` in the app catches a rejection and does the
      same thing; answering it here as well means the honest end of this branch
      — a recorder that captures nothing and says so — is reached whichever side
      the silence came from.
    */
    capabilities: async (): Promise<DesktopCapabilities> => {
      try {
        return await ask(ipc, BRIDGE_CHANNELS.capabilities, undefined, capabilitiesFrom);
      } catch {
        return { ...NO_CAPABILITIES };
      }
    },

    startCapture: (request: StartCaptureRequest): Promise<CaptureStarted> => {
      /*
        Rebuilt rather than forwarded, so a page cannot smuggle a fourth field
        into the shell's own `beginMeeting`. `mic` and `systemAudio` are read
        with `=== true` for the same reason the answers are.
      */
      const asked: StartCaptureRequest = {
        sessionId: text((request as { sessionId?: unknown })?.sessionId),
        mic: (request as { mic?: unknown })?.mic === true,
        systemAudio: (request as { systemAudio?: unknown })?.systemAudio === true,
      };
      return ask(ipc, BRIDGE_CHANNELS.startCapture, asked, (value) => startedFrom(value, asked));
    },
    pauseCapture: async (): Promise<void> => {
      await ask(ipc, BRIDGE_CHANNELS.pauseCapture, undefined, () => null);
    },
    resumeCapture: async (): Promise<void> => {
      await ask(ipc, BRIDGE_CHANNELS.resumeCapture, undefined, () => null);
    },
    stopCapture: (): Promise<CaptureSummary> =>
      ask(ipc, BRIDGE_CHANNELS.stopCapture, undefined, summaryFrom),

    onSegment: (handler: (segment: TranscriptSegment) => void): Unsubscribe =>
      subscribe(ipc, BRIDGE_CHANNELS.segment, segmentFrom, handler),
    onLevel: (handler: (level: AudioLevel) => void): Unsubscribe =>
      subscribe(ipc, BRIDGE_CHANNELS.level, levelFrom, handler),
    onCaptureState: (handler: (update: CaptureStateUpdate) => void): Unsubscribe =>
      subscribe(ipc, BRIDGE_CHANNELS.captureState, captureStateFrom, handler),
    onDetection: (handler: (view: DetectionView) => void): Unsubscribe =>
      subscribe(ipc, BRIDGE_CHANNELS.detection, detectionFrom, handler),
    onTrayCommand: (handler: (command: TrayCommand) => void): Unsubscribe =>
      subscribe(
        ipc,
        BRIDGE_CHANNELS.trayCommand,
        // A command outside the contract's list is dropped rather than passed
        // on: the page switches on these, and an unknown verb is a `default`
        // branch nobody wrote.
        (payload) => (TRAY_COMMANDS.includes(payload as TrayCommand) ? (payload as TrayCommand) : null),
        handler,
      ),

    connection: Object.freeze({
      get: (): Promise<ConnectionView> =>
        ask(ipc, BRIDGE_CHANNELS.connectionGet, undefined, connectionFrom),
      connect: (): void => tell(ipc, BRIDGE_CHANNELS.connectionConnect),
      disconnect: (): void => tell(ipc, BRIDGE_CHANNELS.connectionDisconnect),
      onChange: (handler: (view: ConnectionView) => void): Unsubscribe =>
        subscribe(ipc, BRIDGE_CHANNELS.connectionChange, connectionFrom, handler),
    }),

    outbox: Object.freeze({
      status: (): Promise<OutboxStatus> =>
        ask(ipc, BRIDGE_CHANNELS.outboxStatus, undefined, outboxFrom),
      drain: (): void => tell(ipc, BRIDGE_CHANNELS.outboxDrain),
      onChange: (handler: (status: OutboxStatus) => void): Unsubscribe =>
        subscribe(ipc, BRIDGE_CHANNELS.outboxChange, outboxFrom, handler),
    }),

    meetings: Object.freeze({
      write: (write: MeetingWrite): Promise<MeetingWriteAck> => {
        /*
          Rebuilt from the four fields the contract declares, like every other
          request — and the `body` is the one place that cannot be, because it
          is the protocol's own JSON and this file is not the protocol. What is
          checked instead is that it *is* an object and that the kind is one of
          four: the shell puts the body on the wire unread, so a `kind` it did
          not recognise would be a route nobody agreed to.
        */
        /*
          `kind` and `context` cross as they were given, and neither is repaired
          here. This file runs in the renderer, so a value it "fixes" is a value
          the guard in the main process never gets to refuse — and both of these
          choose an address:

           - a `kind` outside the four is a **route**, and defaulting it to
             `session` would turn a page's mistake into a body posted to a
             collection nobody named;
           - an **empty** `context` is not the same as an absent one. Absent
             means this machine's own context and is a correct address;
             a name that cannot be read is `UNROUTABLE` in `routableContext` and
             is refused. Collapsing `""` to `null` here would make it mean "my
             own context", which is the silent wrong-bucket write that whole
             function exists to prevent.

          So they are carried and `consoleBridge.ts` reads them against the
          closed sets, in the process that owns the queue and the credential.
        */
        const asked = {
          sessionId: text((write as { sessionId?: unknown })?.sessionId),
          kind: text((write as { kind?: unknown })?.kind),
          context:
            (write as { context?: unknown })?.context === null ||
            (write as { context?: unknown })?.context === undefined
              ? null
              : text((write as { context?: unknown })?.context),
          body: record((write as { body?: unknown })?.body),
        };
        return ask(ipc, BRIDGE_CHANNELS.meetingsWrite, asked, (value) =>
          writeAckFrom(value, asked.sessionId),
        );
      },
    }),
  });
}

/**
 * Put the bridge on the world, if this document is allowed to have one.
 *
 * The pin is fetched from the main process rather than baked into the bundle,
 * so a self-hoster's `CONTEXT_DESKTOP_UI_URL` is honoured by one file — and it
 * is fetched *first*, because a window whose main process will not answer is a
 * window that gets no bridge. Failing closed is the only safe direction.
 *
 * Returns whether it exposed, for the suite. Nothing in the app reads it.
 */
export function installDesktopBridge(
  host: PreloadHost,
  ipc: PreloadIpc,
  document: PreloadDocument,
): boolean {
  let pinned = "";
  try {
    pinned = text(ipc.sendSync(BRIDGE_CHANNELS.origin));
  } catch {
    pinned = "";
  }

  if (!shouldExposeBridge({ pinned, origin: document.origin, isTopFrame: document.isTopFrame })) {
    return false;
  }

  host.exposeInMainWorld("desktop", desktopBridge(ipc));
  return true;
}
