/**
 * A shell a test drives by hand.
 *
 * The reference implementation of the bridge, and deliberately the *only* one
 * that exists in this package: a fake that lived in `apps/mobile/__tests__` and
 * another that lived in `apps/desktop/test` would be two guesses at one
 * contract, which is the drift this package was created to stop. It is exported
 * from `@context/desktop-bridge/fake` rather than from the index so that
 * importing the contract cannot pull a fake shell into an app bundle.
 *
 * Deterministic on purpose, for the reason `capture/fake.ts` gives about the
 * phone's recorder: nothing here is on a timer and no segment appears unless a
 * test emits one. What this feature has to be right about is *ordering* — a
 * segment arriving after End was pressed, a capability answered late, a tray
 * command landing while a screen is mounting — and none of that can be staged
 * against a bridge that produces things on its own.
 *
 * It is frozen, like the real one, because `getDesktopBridge` refuses a bridge
 * that is not — so a fake that was not frozen would be a fake no caller could
 * use, and the fact that this one passes the validator is itself a check that
 * the validator is satisfiable.
 */

import {
  NO_CAPABILITIES,
  BRIDGE_VERSION,
  type AudioLevel,
  type CaptureStarted,
  type CaptureStateUpdate,
  type CaptureSummary,
  type ConnectionView,
  type DesktopBridge,
  type DesktopCapabilities,
  type DesktopShell,
  type DetectionView,
  type OutboxStatus,
  type StartCaptureRequest,
  type TranscriptSegment,
  type TrayCommand,
  type Unsubscribe,
} from "./contract.ts";

export interface FakeDesktopBridge {
  /** The object a test puts on `window.desktop`. Frozen, like the real one. */
  bridge: DesktopBridge;
  /** Method names in the order they were called, with `startCapture`'s request. */
  calls: string[];
  /** The last `startCapture` request, or `null`. */
  lastStart: StartCaptureRequest | null;
  emitSegment(segment: TranscriptSegment): void;
  emitLevel(level: AudioLevel): void;
  emitCaptureState(update: CaptureStateUpdate): void;
  emitConnection(view: ConnectionView): void;
  emitOutbox(status: OutboxStatus): void;
  emitDetection(view: DetectionView): void;
  emitTrayCommand(command: TrayCommand): void;
  /** How many handlers are attached, so a test can prove teardown detached them. */
  listenerCount(): number;
}

export interface FakeBridgeOptions {
  version?: number;
  shell?: DesktopShell | null;
  capabilities?: Partial<DesktopCapabilities>;
  connection?: ConnectionView;
  outbox?: OutboxStatus;
  /** What `startCapture` answers. Defaults to granting exactly what was asked. */
  started?: Partial<CaptureStarted>;
  summary?: Partial<CaptureSummary>;
  /** Make `startCapture` reject — a refused permission, a busy device. */
  refuseStart?: string;
}

const DEFAULT_CONNECTION: ConnectionView = {
  state: "disconnected",
  gateway: null,
  encrypted: true,
  connecting: false,
  error: null,
};

const DEFAULT_OUTBOX: OutboxStatus = { pending: 0, parked: 0, lastError: null };

export function fakeDesktopBridge(options: FakeBridgeOptions = {}): FakeDesktopBridge {
  const segments = new Set<(segment: TranscriptSegment) => void>();
  const levels = new Set<(level: AudioLevel) => void>();
  const captureStates = new Set<(update: CaptureStateUpdate) => void>();
  const connections = new Set<(view: ConnectionView) => void>();
  const outboxes = new Set<(status: OutboxStatus) => void>();
  const detections = new Set<(view: DetectionView) => void>();
  const trayCommands = new Set<(command: TrayCommand) => void>();

  const calls: string[] = [];
  const capabilities: DesktopCapabilities = { ...NO_CAPABILITIES, ...options.capabilities };
  let connectionView = options.connection ?? DEFAULT_CONNECTION;
  let outboxStatus = options.outbox ?? DEFAULT_OUTBOX;
  let lastStart: StartCaptureRequest | null = null;

  function subscribe<T>(set: Set<T>, handler: T): Unsubscribe {
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  const bridge: DesktopBridge = Object.freeze({
    version: options.version ?? BRIDGE_VERSION,
    shell:
      options.shell === undefined
        ? { app: "Context", version: "0.0.0-test", platform: "macos" as const }
        : options.shell,

    async capabilities() {
      calls.push("capabilities");
      return { ...capabilities };
    },

    async startCapture(request: StartCaptureRequest): Promise<CaptureStarted> {
      calls.push("startCapture");
      lastStart = request;
      if (options.refuseStart !== undefined) throw new Error(options.refuseStart);
      return {
        sessionId: request.sessionId,
        // What was asked for, narrowed by what this fake shell can do — the
        // same narrowing a real shell does, so a test that ticks system audio
        // against a shell without it sees the honest answer rather than its own
        // request handed back.
        mic: request.mic && capabilities.mic,
        systemAudio: request.systemAudio && capabilities.systemAudio,
        startedAtMs: 0,
        transcribesAt: "cloud",
        notice: null,
        ...options.started,
      };
    },

    async pauseCapture() {
      calls.push("pauseCapture");
    },

    async resumeCapture() {
      calls.push("resumeCapture");
    },

    async stopCapture(): Promise<CaptureSummary> {
      calls.push("stopCapture");
      return {
        sessionId: lastStart?.sessionId ?? "",
        endedAtMs: 0,
        durationMs: 0,
        segments: 0,
        pending: 0,
        ...options.summary,
      };
    },

    // Annotated rather than inferred: `Object.freeze` is a generic call, so the
    // `DesktopBridge` annotation on the const does not reach inside it.
    onSegment: (handler: (segment: TranscriptSegment) => void) => subscribe(segments, handler),
    onLevel: (handler: (level: AudioLevel) => void) => subscribe(levels, handler),
    onCaptureState: (handler: (update: CaptureStateUpdate) => void) =>
      subscribe(captureStates, handler),
    onDetection: (handler: (view: DetectionView) => void) => subscribe(detections, handler),
    onTrayCommand: (handler: (command: TrayCommand) => void) => subscribe(trayCommands, handler),

    connection: Object.freeze({
      async get() {
        calls.push("connection.get");
        return { ...connectionView };
      },
      connect() {
        calls.push("connection.connect");
      },
      disconnect() {
        calls.push("connection.disconnect");
      },
      onChange: (handler: (view: ConnectionView) => void) => subscribe(connections, handler),
    }),

    outbox: Object.freeze({
      async status() {
        calls.push("outbox.status");
        return { ...outboxStatus };
      },
      drain() {
        calls.push("outbox.drain");
      },
      onChange: (handler: (status: OutboxStatus) => void) => subscribe(outboxes, handler),
    }),
  });

  return {
    bridge,
    calls,
    get lastStart() {
      return lastStart;
    },
    emitSegment(segment) {
      for (const handler of segments) handler(segment);
    },
    emitLevel(level) {
      for (const handler of levels) handler(level);
    },
    emitCaptureState(update) {
      for (const handler of captureStates) handler(update);
    },
    emitConnection(view) {
      connectionView = view;
      for (const handler of connections) handler(view);
    },
    emitOutbox(status) {
      outboxStatus = status;
      for (const handler of outboxes) handler(status);
    },
    emitDetection(view) {
      for (const handler of detections) handler(view);
    },
    emitTrayCommand(command) {
      for (const handler of trayCommands) handler(command);
    },
    listenerCount() {
      return (
        segments.size +
        levels.size +
        captureStates.size +
        connections.size +
        outboxes.size +
        detections.size +
        trayCommands.size
      );
    },
  };
}
