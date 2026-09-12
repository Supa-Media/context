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
  type ImessageStatus,
  type MachineApprovalResult,
  type MeetingWrite,
  type MeetingWriteAck,
  type OutboxStatus,
  type PendingMachineApproval,
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
  /** Every meeting write the page handed the shell, in order. */
  writes: MeetingWrite[];
  /** Every answer the page gave about a parked machine approval, in order. */
  approvals: MachineApprovalResult[];
  /** Every `setEnabled` the page asked for, in order. */
  imessageSetEnabledCalls: boolean[];
  /** How many times the page asked the shell to guide the person to Full Disk Access. */
  imessageFullDiskAccessRequests: number;
  emitSegment(segment: TranscriptSegment): void;
  emitLevel(level: AudioLevel): void;
  emitCaptureState(update: CaptureStateUpdate): void;
  emitConnection(view: ConnectionView): void;
  emitOutbox(status: OutboxStatus): void;
  emitDetection(view: DetectionView): void;
  emitTrayCommand(command: TrayCommand): void;
  /** Push a parked machine approval at the page, or `null` to say it is over. */
  emitPendingApproval(pending: PendingMachineApproval | null): void;
  /** Push a new iMessage status at the page. */
  emitImessage(status: ImessageStatus): void;
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
  /**
   * What `meetings.write` answers, per write.
   *
   * A function rather than a value because the three answers are about
   * *sequence*: a finalize is queued while the machine is offline and carries a
   * note path once the queue has drained, and a test that could not say "this
   * one, then that one" could not stage the case the whole surface exists for.
   * Defaults to "queued", which is what an offline shell always answers.
   */
  write?: (write: MeetingWrite) => MeetingWriteAck;
  /**
   * Answer no `meetings` at all — a version-1 shell.
   *
   * The estate this bundle actually meets: somebody installed the shell before
   * `meetings` existed, `MIN_BRIDGE_VERSION` still accepts it, and the page has
   * to notice the member is missing rather than call it.
   */
  noMeetings?: boolean;
  /**
   * The parked approval this shell is holding. `null` — the default — is a
   * shell with no connect in flight, which is every ordinary moment.
   */
  pendingApproval?: PendingMachineApproval | null;
  /**
   * Answer no machine-approval members at all — a **version-2** shell.
   *
   * `noMeetings`'s reason, one version along: somebody installed the shell that
   * shipped #312's in-window approve screen, `MIN_BRIDGE_VERSION` still accepts
   * it, and the page has to notice the members are missing rather than call
   * them. An explicit `version` still wins, so the refusal can be staged too.
   */
  noMachineApproval?: boolean;
  /** The status `imessage.status()` and the initial push answer. */
  imessage?: ImessageStatus;
  /**
   * Answer no `imessage` member at all — a shell older than **version 5**,
   * which is every shell in anybody's Applications folder today.
   *
   * The version it answers is **4**, not 3: the shell this stages is the one
   * that shipped complete just before iMessage import existed, and tagging it
   * with the highest version that legitimately has no `imessage` is what makes
   * it that shell rather than an older one that also happens to lack the
   * member. (Rows 3 and 4 of the required-member table are the identical list,
   * so 3 would validate too — it would just be staging a different shell than
   * the name says.)
   *
   * The same reason `noMeetings` and `noMachineApproval` exist: a page must
   * notice the member is missing rather than call it and get a `TypeError` a
   * real shell would never have let it reach in the first place.
   */
  noImessage?: boolean;
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
  const writes: MeetingWrite[] = [];
  const approvals: MachineApprovalResult[] = [];
  const imessageSetEnabledCalls: boolean[] = [];
  let imessageFullDiskAccessRequests = 0;
  const pendingApprovals = new Set<(pending: PendingMachineApproval | null) => void>();
  const imessageListeners = new Set<(status: ImessageStatus) => void>();
  let pending: PendingMachineApproval | null = options.pendingApproval ?? null;
  let imessageStatus: ImessageStatus = options.imessage ?? {
    enabled: false,
    permission: "unknown",
    lastSyncedAt: null,
    lastError: null,
  };
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
    /*
      A shell with no `meetings` is a **version-1** shell, and answering 2
      without one would be a shell the validator correctly refuses — which is
      not the case a test asking for `noMeetings` is trying to stage. An
      explicit `version` still wins, so the refusal itself can be staged too.
    */
    version:
      options.version ??
      (options.noMeetings === true
        ? 1
        : options.noMachineApproval === true
          ? 2
          : options.noImessage === true
            ? 4
            : BRIDGE_VERSION),
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
        frames: 0,
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
      /*
        Absent entirely under `noMachineApproval`, rather than present and
        answering nothing — `meetings`' rule, and for its reason: a version-2
        shell does not have these members, and a fake that had them and refused
        would let a page pass by catching an error it should never have been in
        a position to throw.
      */
      ...(options.noMachineApproval === true
        ? {}
        : {
            async pendingApproval(): Promise<PendingMachineApproval | null> {
              calls.push("connection.pendingApproval");
              return pending === null ? null : { ...pending };
            },
            onPendingApproval: (
              handler: (value: PendingMachineApproval | null) => void,
            ): Unsubscribe => subscribe(pendingApprovals, handler),
            async resolveApproval(result: MachineApprovalResult): Promise<void> {
              calls.push(`connection.resolveApproval:${result.approved}`);
              approvals.push(result);
              pending = null;
            },
          }),
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

    /*
      Absent entirely under `noMeetings`, rather than present and answering
      nothing. A version-1 shell does not have this member, and a fake that had
      it and refused would let a page pass by catching an error it should never
      have been in a position to throw.
    */
    ...(options.noMeetings === true
      ? {}
      : {
          meetings: Object.freeze({
            async write(write: MeetingWrite): Promise<MeetingWriteAck> {
              calls.push(`meetings.write:${write.kind}`);
              writes.push(write);
              return (
                options.write?.(write) ?? {
                  sessionId: write.sessionId,
                  queued: true,
                  notePath: null,
                  rejected: null,
                }
              );
            },
          }),
        }),

    /*
      Absent entirely under `noImessage`, rather than present and answering
      nothing — the same rule `meetings` and the machine-approval trio follow,
      and for the same reason: a shell older than version 5 does not have this
      member, and a fake that had it and refused would let a page pass by
      catching an error it should never have been in a position to throw.
    */
    ...(options.noImessage === true
      ? {}
      : {
          imessage: Object.freeze({
            async status(): Promise<ImessageStatus> {
              calls.push("imessage.status");
              return { ...imessageStatus };
            },
            async setEnabled(enabled: boolean): Promise<void> {
              calls.push(`imessage.setEnabled:${enabled}`);
              imessageSetEnabledCalls.push(enabled);
              imessageStatus = { ...imessageStatus, enabled };
            },
            async requestFullDiskAccess(): Promise<void> {
              calls.push("imessage.requestFullDiskAccess");
              imessageFullDiskAccessRequests += 1;
            },
            onChange: (handler: (status: ImessageStatus) => void) => subscribe(imessageListeners, handler),
          }),
        }),
  });

  return {
    bridge,
    calls,
    writes,
    approvals,
    imessageSetEnabledCalls,
    get imessageFullDiskAccessRequests() {
      return imessageFullDiskAccessRequests;
    },
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
    emitPendingApproval(value) {
      pending = value;
      for (const handler of pendingApprovals) handler(value);
    },
    emitImessage(status) {
      imessageStatus = status;
      for (const handler of imessageListeners) handler(status);
    },
    listenerCount() {
      return (
        segments.size +
        levels.size +
        captureStates.size +
        connections.size +
        outboxes.size +
        detections.size +
        trayCommands.size +
        pendingApprovals.size +
        imessageListeners.size
      );
    },
  };
}
