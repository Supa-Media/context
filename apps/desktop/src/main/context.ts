/**
 * The state `main()` shares, in one object rather than module-level `let`s.
 *
 * Every field here used to be a `let` at the top of `main/index.ts`, read and
 * reassigned by the functions inside `main()`. They are fields of one object
 * now, created once per launch by `createMainContext()`, so that the functions
 * which read them can live in modules of their own and still read the value
 * *at call time* — `ctx.consoleBridge` is rebuilt whenever the console window
 * is, and a function holding a copy of the one that existed when it was
 * created would push into a window that is gone.
 *
 * The comments below are the ones that sat on the `let`s, moved with them.
 */

import type { BrowserWindow } from "electron";
import type {
  CaptureStarted,
  CaptureStateUpdate,
  CaptureSummary,
  DesktopCapabilities,
  MachineApprovalResult,
  MeetingWrite,
  MeetingWriteAck,
  OutboxStatus,
  StartCaptureRequest,
  TrayCommand,
} from "@context/desktop-bridge";
import type { DetectionLoop, DetectionUpdate } from "../core/detection/loop.ts";
import type { BeginResult, MeetingController, SessionView } from "../core/recording/controller.ts";
import type { TokenStore } from "../core/sync/tokenStore.ts";
import type { GatewayConnection } from "../core/sync/connection.ts";
import type { DesktopCaptureRecorder } from "./capture.ts";
import type { DesktopStore } from "./store.ts";
import type { LocalAgentRunner } from "./localAgent.ts";
import type { ImessageSyncService } from "./imessage.ts";
import type { AppTray } from "./tray.ts";
import type { DesktopUpdater } from "./updater.ts";
import type { UiState } from "./ipc.ts";
import { IDLE_CONSENT } from "../core/consent/gate.ts";
import type { ConsentState } from "../core/consent/gate.ts";
import { emptyOutbox } from "../core/sync/outbox.ts";
import type { Outbox } from "../core/sync/outbox.ts";
import { createApprovalRoute } from "../core/shell/approval.ts";
import type { ApprovalRoute } from "../core/shell/approval.ts";
import { createApprovalHandover } from "../core/shell/autoGrant.ts";
import type { ApprovalHandover } from "../core/shell/autoGrant.ts";
import type { ConsoleBridge } from "./consoleBridge.ts";
import type { ConsoleMirror } from "./consoleMirror.ts";
import { DEFAULT_SETTINGS } from "../core/settings.ts";
import type { DesktopSettings } from "../core/settings.ts";

export interface MainState {
  settings: DesktopSettings;
  outbox: Outbox;
  consent: ConsentState;
  lastUpdate: DetectionUpdate | null;
  missingPermissions: string[];
  /**
   * What the last capture found out about system audio, for the next meeting.
   *
   * `null` until something has tried: there is no API that answers "would macOS
   * give this build the loopback tap" without asking for it, so the probe is the
   * attempt and this is its answer. It is deliberately **not** persisted — a
   * signed build installed over an unsigned one would inherit the old answer and
   * never ask again.
   */
  systemAudioAvailable: boolean | null;
  connecting: boolean;
  /**
   * The console window and the bridge behind it, when this launch opened one.
   *
   * Both are `null` on a `CONTEXT_DESKTOP_UI=renderer` launch, which is still the
   * default, and every use of them is optional-chained for that reason rather
   * than guarded by the flag a second time.
   */
  consoleWindow: BrowserWindow | null;
  consoleBridge: ConsoleBridge | null;
  /**
   * The address this launch resolved the console to, once it has.
   *
   * Recorded rather than re-derived, because the bug it exists to expose was in
   * the *wiring* and not in `consoleUrl` itself: a signed build resolved
   * `http://localhost:8081` and showed a blank window, and a check that asks
   * `consoleUrl(process.env, app.isPackaged)` a second time would have agreed
   * with itself and reported nothing. This is what the window was actually
   * pointed at.
   */
  consoleAddress: string | null;
  /**
   * The offline mirror, and the authority on which origin is pinned.
   *
   * `null` until a console window is opened, and the bridge reads
   * `pinnedOrigin()` through a getter for it — a shell serving the mirror trusts
   * `app://console` *instead of* the live origin, never as well as it.
   */
  consoleMirror: ConsoleMirror | null;
  /**
   * Resolves once the console window's first navigation has settled — `true` for
   * `did-finish-load`, `false` for a main-frame `did-fail-load` (the mirror or
   * the failure page takes over from there, and this promise does not follow it
   * — that is `consoleMirror.awaitFallback()`'s job, awaited separately by
   * `--smoke-load` once this one resolves `false`).
   *
   * `null` on a launch that never opened a console window at all —
   * `CONTEXT_DESKTOP_UI=renderer`, or a `CONTEXT_DESKTOP_UI_URL` this app
   * refused — which `--smoke-load` reads as "there was nothing to wait for".
   */
  consoleLoadSettled: Promise<boolean> | null;
  /**
   * The one navigation this window makes that is neither the console nor the
   * mirror: the loopback address a connect in flight is listening on.
   *
   * One per launch and single, because there is one console window and
   * `connectThisMachine` already refuses to run twice over. It is `null` except
   * between pressing Connect and the grant coming back — `core/shell/approval.ts`
   * is the argument, and `test/approval.test.mjs` is the check.
   */
  readonly approval: ApprovalRoute;
  /**
   * The parked request this machine has handed to the page, while it holds one.
   *
   * One per launch and single for `approval`'s reason — one console window, one
   * connect at a time. `core/shell/autoGrant.ts` is the argument and
   * `test/autoGrant.test.mjs` is the check.
   */
  readonly handover: ApprovalHandover;
  connectError: string | null;
  /**
   * Where each finished meeting's note landed, as the queue learns it.
   *
   * The console is what needs this: its page hands the shell a finalize and
   * must not draw the meeting as saved until the note is in the bucket, so
   * "the gateway answered with this path" is the one fact it is waiting for.
   * The tray path has no use for it and does not read it.
   *
   * Kept in memory only. It is a receipt for a call this process made, not a
   * record of anything — the note itself is in the customer's bucket, and a
   * relaunch that had forgotten a path re-finalizes and is answered with the
   * same one.
   */
  readonly notePaths: Map<string, string>;
}

/**
 * What `main()` builds once and never replaces: the store, the credential, the
 * recorder and the rest. Attached to the context after the tray exists, which
 * is the last of them — see `main()` for the order and why it matters.
 */
export interface MainServices {
  store: DesktopStore;
  tokens: TokenStore;
  connection: GatewayConnection;
  localAgent: LocalAgentRunner;
  imessage: ImessageSyncService;
  /** `null` in console mode — see `UI_MODE`. */
  panel: BrowserWindow | null;
  notepad: BrowserWindow | null;
  /** `null` under `--fake-signals`, where there is no real recorder. */
  capture: DesktopCaptureRecorder | null;
  controller: MeetingController;
  updater: DesktopUpdater;
  loop: DetectionLoop;
  tray: AppTray;
}

/**
 * The functions that used to call each other by name inside `main()`.
 *
 * They live in subject modules now, and a module calls another's through this
 * table — read from `ctx` at call time, never copied at creation, because the
 * modules reference each other in a cycle (a meeting pushes, a push reads the
 * capture state, the console starts a meeting) and none of them can be built
 * after all the others.
 */
export interface MainActions {
  // shellView.ts
  pressed(command: TrayCommand, run: () => Promise<unknown>): Promise<unknown>;
  uiState(): UiState;
  push(): void;
  update(patch: Partial<DesktopSettings>): Promise<void>;
  // surfaces.ts
  showPanel(): void;
  showConsoleWindow(): boolean;
  openConsoleWindow(): boolean;
  explain(sentence: string): void;
  liveConsoleWindow(): BrowserWindow | null;
  // meetings.ts
  onDetection(current: DetectionUpdate): Promise<void>;
  beginMeeting(episode: string, manual?: boolean, id?: string, queueWrites?: boolean): Promise<BeginResult | null>;
  recordNow(): Promise<void>;
  endMeeting(): Promise<SessionView | null>;
  // outboxDrain.ts
  drain(): Promise<void>;
  // consoleCapture.ts
  shellCapabilities(): DesktopCapabilities;
  captureStateUpdate(): CaptureStateUpdate;
  outboxStatus(): OutboxStatus;
  startFromConsole(request: StartCaptureRequest): Promise<CaptureStarted>;
  writeMeetingFromConsole(write: MeetingWrite): Promise<MeetingWriteAck>;
  stopFromConsole(): Promise<CaptureSummary>;
  // windowIpc.ts
  openConsoleWindowIfAsked(): void;
  // connectFlow.ts
  answerFromConsole(result: MachineApprovalResult): void;
  connectThisMachine(): Promise<void>;
  disconnectThisMachine(): Promise<void>;
}

/**
 * One launch's shared state, services and functions, as one object.
 *
 * `createMainContext()` fills in the state; `main()` attaches the services and
 * then the functions, in that order, before anything can call through it.
 */
export type MainContext = MainState & MainServices & MainActions;

/**
 * The state a launch starts in: the values the module-level `let`s held.
 *
 * Typed as the whole context because that is what every module is handed;
 * the services and the functions are attached by `main()` before the first
 * thing that can reach them runs, which is the same guarantee the hoisted
 * declarations inside `main()` used to give.
 */
export function createMainContext(): MainContext {
  const state: MainState = {
    settings: DEFAULT_SETTINGS,
    outbox: emptyOutbox(),
    consent: IDLE_CONSENT,
    lastUpdate: null,
    missingPermissions: [],
    systemAudioAvailable: null,
    connecting: false,
    consoleWindow: null,
    consoleBridge: null,
    consoleAddress: null,
    consoleMirror: null,
    consoleLoadSettled: null,
    approval: createApprovalRoute(),
    handover: createApprovalHandover(),
    connectError: null,
    notePaths: new Map<string, string>(),
  };
  return state as MainContext;
}
