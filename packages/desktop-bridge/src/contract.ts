/**
 * THE CONTRACT BETWEEN ONE UI AND THE SHELL THAT HOSTS IT.
 *
 * `docs/decisions/desktop.md` is the argument; this file is the shape. The
 * owner's decision, 2026-09-07: *"Making changes to the app should be one
 * runtime for web, mobile and desktop."* The Expo app in `apps/mobile` is that
 * one runtime, Electron stops having a UI, and what is left of the desktop app
 * is the half a web page cannot be: a menu bar, a loopback audio tap, a
 * credential in the OS keychain, and a queue that drains with no window open.
 *
 * `window.desktop` is how the page reaches those, and this package is the only
 * place either side describes it. The failure it exists to prevent is the one
 * `apps/desktop/src/core/contract.ts` already names about the meetings
 * protocol: *"a local copy of `TranscriptSegment` that drifts by one field is a
 * wire bug that typechecks."* An interface declared once in `apps/mobile` and
 * again in `apps/desktop` is that bug with a process boundary through it.
 *
 * ## Three rules this file encodes rather than states
 *
 * **The credential never crosses.** There is no `getToken` in any type below
 * and there must not be one: `connection.get()` answers three words and a base
 * URL, `connect()` opens a browser, and the token stays in `safeStorage` in the
 * main process where every request that carries it is made. `bridge.ts` refuses
 * a bridge that grew a credential-shaped member, so this is a check rather than
 * a comment.
 *
 * **`version` gates the shape; `capabilities()` gates the feature.** A web
 * bundle published today lands on a shell somebody installed in March, and no
 * version number could have predicted whether macOS hands *that* build a
 * loopback tap — an unsigned build is refused one and a notarised build is not,
 * with the same bridge version on both. So the page asks.
 *
 * **Everything is asked for, nothing is inferred.** `capabilitiesFrom` reads a
 * missing or malformed key as `false`, which is the honest answer to "can this
 * shell do X" from a shell that does not know what X is.
 *
 * ## Where the shapes come from
 *
 * `ConnectionView`, `OutboxStatus` and `DetectionView` are the shell's own
 * vocabulary, taken from `apps/desktop/src/main/ipc.ts`'s `UiState` rather than
 * invented here — including `revoked` being a third word beside `disconnected`,
 * because one means "you have not connected this machine" and the other means
 * "the grant you had is gone", and only the second has a queue waiting on
 * somebody pressing a button.
 */

import type { TranscriptSegment } from "@context/meetings/protocol";

export type { TranscriptSegment };

/**
 * The bridge's shape, and the only number a bundle compares against.
 *
 * It moves when this interface changes and never when the app is released: a
 * shell shipped in March and one shipped today both answer `1` if they expose
 * the same surface. See `isSupportedBridgeVersion` in `bridge.ts` for what a
 * bundle does with a number that is not this one — the short version is that
 * the **UI** is the half that has to be backward compatible, because it is the
 * half that can be updated in an afternoon.
 */
export const BRIDGE_VERSION = 1;

/**
 * The oldest bridge this bundle will still talk to.
 *
 * Equal to `BRIDGE_VERSION` today because there has only ever been one shape.
 * It is a separate constant so that raising `BRIDGE_VERSION` is not the same
 * edit as dropping support for the shells already installed — those are two
 * decisions and the second one strands people.
 */
export const MIN_BRIDGE_VERSION = 1;

/** Every subscription hands one of these back. See `DesktopBridge`. */
export type Unsubscribe = () => void;

/** Where the shell is running. `macos` is the only one built; see the doc. */
export type DesktopPlatform = "macos" | "windows" | "linux";

/** Who is hosting the page. Rendered in Settings; never a path, never a token. */
export interface DesktopShell {
  /** The application's name, as it calls itself. */
  app: string;
  /** The *app's* version — not the bridge's. `1.4.2`-shaped. */
  version: string;
  platform: DesktopPlatform;
}

/**
 * What THIS build can actually do.
 *
 * Asked at runtime, never inferred from `version`, and never assumed from the
 * fact that a bridge is present at all. The rule `app.config.js` already states
 * about `UIBackgroundModes` — *"a runtime capability check, never a version
 * comparison against a manifest that ships over the air"* — with the same
 * reasoning and a second reason on top: two builds of the same shell version
 * differ on `systemAudio` depending on whether the binary was signed.
 */
export interface DesktopCapabilities {
  /** The machine's own audio, via ScreenCaptureKit. Needs a notarised build. */
  systemAudio: boolean;
  /** The microphone, through the shell rather than through `getUserMedia`. */
  mic: boolean;
  /** Meeting detection: this shell watches for a call and says so. */
  detection: boolean;
  /** A menu-bar presence that can start and end a recording with no window. */
  tray: boolean;
  /** A queue in the main process that outlives the page. */
  outbox: boolean;
  /** This machine holds its own revocable grant on the gateway. */
  connection: boolean;
}

/**
 * Everything off.
 *
 * The default a caller gets from a shell that answered nothing, answered
 * rubbish, or is simply older than the capability being asked about. Frozen, so
 * a page cannot edit the answer it was given and then believe it.
 */
export const NO_CAPABILITIES: Readonly<DesktopCapabilities> = Object.freeze({
  systemAudio: false,
  mic: false,
  detection: false,
  tray: false,
  outbox: false,
  connection: false,
});

/** The keys of `DesktopCapabilities`, for anything that has to iterate them. */
export const CAPABILITY_NAMES: readonly (keyof DesktopCapabilities)[] = Object.freeze([
  "systemAudio",
  "mic",
  "detection",
  "tray",
  "outbox",
  "connection",
] as (keyof DesktopCapabilities)[]);

/**
 * Read a capabilities answer, with a missing or malformed key as `false`.
 *
 * The far side of this bridge is another process, and an older one at that.
 * Spreading its answer into a default (`{ ...NO_CAPABILITIES, ...answer }`)
 * would let `systemAudio: "yes"` through as a truthy value and put a system
 * audio switch on the glass of a shell that cannot open one — which is the
 * exact thing `meetings.md` forbids: *nothing on screen may claim a capability
 * the shell did not report*. So every key is read, and only `true` is true.
 */
export function capabilitiesFrom(answer: unknown): DesktopCapabilities {
  const source = (answer ?? {}) as Partial<Record<keyof DesktopCapabilities, unknown>>;
  const out = { ...NO_CAPABILITIES } as DesktopCapabilities;
  for (const name of CAPABILITY_NAMES) out[name] = source[name] === true;
  return out;
}

/** What the page asks the shell to open. */
export interface StartCaptureRequest {
  /**
   * The meeting this capture belongs to, minted by the page.
   *
   * `newMeetingId` from `@context/meetings` on both sides, so a laptop that
   * recorded a whole meeting on a plane posts under the id it has been using
   * all along and the gateway upserts one note rather than two.
   */
  sessionId: string;
  /** Open the microphone. */
  mic: boolean;
  /** Open the loopback tap as well — the far side of a call on headphones. */
  systemAudio: boolean;
}

/**
 * What the shell actually opened, which may be less than was asked for.
 *
 * The asymmetry is deliberate and it is the whole reason this is not `void`. A
 * person on an unsigned build who ticked "system audio" gets `systemAudio:
 * false` and a `notice` saying so, rather than a recording that quietly
 * contains one side of their call.
 */
export interface CaptureStarted {
  sessionId: string;
  mic: boolean;
  systemAudio: boolean;
  /** Epoch milliseconds, from the machine that is recording. */
  startedAtMs: number;
  /** Where the words are produced. The same two tiers the phone has. */
  transcribesAt: TranscribesAt;
  /** What this recording is *not* doing, in one sentence, or `null`. */
  notice: string | null;
}

/** Where the words are produced. The product's two tiers, as a type. */
export type TranscribesAt = "device" | "cloud" | "nowhere";

/**
 * What a finished capture amounts to.
 *
 * Note what is not in it: no file, no path, no bytes, no duration of audio kept
 * anywhere. Audio is transient on this bridge in the same way it is transient
 * in `capture/audio.web.ts` — by there being nothing to hand over.
 */
export interface CaptureSummary {
  sessionId: string;
  endedAtMs: number;
  /** Wall-clock milliseconds of capture, pauses excluded. */
  durationMs: number;
  /** How many segments were emitted, so "nothing was heard" can be said out loud. */
  segments: number;
  /** Writes the shell's queue is still holding for this session. */
  pending: number;
}

/**
 * What the recorder itself thinks it is doing.
 *
 * The same four words `apps/mobile/features/meetings/capture` uses for a
 * `MeetingRecorder`, deliberately: the desktop is one more implementation of
 * that interface rather than a second vocabulary, and a screen that had to map
 * between two sets of state names would be the fork this whole change exists to
 * avoid. `@context/meetings`' `RECORDER_STATES` is the shared list.
 */
export type CaptureState = "idle" | "recording" | "paused" | "stopped";

/** Something went wrong *during* capture. `recoverable: false` means notes-only from here. */
export interface CaptureFault {
  recoverable: boolean;
  /** A sentence a person can read. Never a code, never an upstream error's text. */
  message: string;
}

/** Pushed whenever the shell's recorder moves, and on every fault. */
export interface CaptureStateUpdate {
  state: CaptureState;
  /** True while an input is actually open — what the tray's dot means. */
  capturing: boolean;
  fault: CaptureFault | null;
}

/**
 * How loud it is right now, for a waveform.
 *
 * Normalised 0–1 and deliberately not samples: a level is a number a UI can
 * draw, and audio the page could hold is exactly what this bridge does not
 * carry. Sent at the shell's own cadence — a subscriber must expect nothing.
 */
export interface AudioLevel {
  /** 0–1. `0` when the microphone is not open. */
  mic: number;
  /** 0–1. `0` when there is no loopback tap. */
  systemAudio: number;
}

/**
 * This machine's grant, as words the UI may say.
 *
 * `apps/desktop/src/main/ipc.ts`'s shape, unchanged. There is no token in it
 * and there must not be: `gateway` is where meetings go, which is not a secret
 * and is the one thing a person needs to see to know their notes are landing in
 * their own bucket.
 */
export interface ConnectionView {
  state: "disconnected" | "connected" | "revoked";
  /** Where meetings go. Never a credential. */
  gateway: string | null;
  /** False when this OS gave the shell no encrypted storage; said out loud. */
  encrypted: boolean;
  /** True while the browser half of the OAuth flow is open. */
  connecting: boolean;
  /** The last connect failure, in the shell's own words, or `null`. */
  error: string | null;
}

/** What the queue is holding. Counts, never contents. */
export interface OutboxStatus {
  /** Writes not yet acknowledged by the gateway. */
  pending: number;
  /** Entries parked because the gateway refused them unretryably. */
  parked: number;
  /** The last drain failure, in the shell's own words, or `null`. */
  lastError: string | null;
}

/**
 * What the shell thinks is happening, when it is watching for meetings.
 *
 * Attacker-controlled text — a window title is whatever somebody named their
 * document — so every consumer renders it as text and never as markup. That is
 * true of the existing renderer and stays true of a React tree.
 */
export interface DetectionView {
  active: boolean;
  /** The episode being asked about, echoed back on accept/decline. */
  episode: string | null;
  suggestedTitle: string | null;
  sourceLabel: string;
  summary: string;
  evidence: string[];
  /** What detection cannot see on this machine, in one sentence, or `null`. */
  degradedNotice: string | null;
  attendees: number;
}

/**
 * What somebody pressed in the menu bar while the page was open.
 *
 * The tray is a complete capture surface on its own — a person can record a
 * whole meeting with the window never having loaded — so these are not the
 * page's only route to those verbs. They exist so a page that *is* open agrees
 * with the menu bar instead of drawing a stale Record button.
 */
export type TrayCommand = "record" | "accept" | "decline" | "pause" | "resume" | "end";

export const TRAY_COMMANDS: readonly TrayCommand[] = Object.freeze([
  "record",
  "accept",
  "decline",
  "pause",
  "resume",
  "end",
] as TrayCommand[]);

/**
 * THE BRIDGE.
 *
 * One frozen object on `window.desktop`, exposed by a preload that has already
 * decided this document is allowed to have it, and reached only through
 * `getDesktopBridge()`.
 *
 * ## Every subscription returns its own unsubscribe
 *
 * The desktop app's existing `preload/index.ts` `onState` does not, which is
 * right for a renderer with one long-lived script and wrong for a React tree
 * that mounts and unmounts screens: a handler that cannot be detached is a leak
 * per navigation and a stale closure writing into an unmounted component. This
 * is the one place the new surface is deliberately not a copy of the old one.
 *
 * ## There is no generic `invoke`
 *
 * Not `invoke(channel, args)`, not `send`, not `require`, not a filesystem.
 * Every method below is a verb the shell agreed to, and adding one is a change
 * to this file — which is a change somebody reviews. A generic channel would
 * make the review meaningless the day after it was added.
 *
 * ## Nothing here can open a microphone by itself
 *
 * `startCapture` is a *request*. It lands on the shell's consent gate, its
 * blocklist and its tray indicator, exactly as the menu bar's Record does. The
 * console window is never granted a media permission at all, so the worst a
 * fully compromised page can do is ask — and be refused, or be recorded
 * visibly.
 */
export interface DesktopBridge {
  /** The contract's shape. Moves only when this interface changes. */
  readonly version: number;
  /** Who is hosting the page. `null` from a shell that would not say. */
  readonly shell: DesktopShell | null;

  /** What THIS build can actually do. Asked, never inferred from `version`. */
  capabilities(): Promise<DesktopCapabilities>;

  startCapture(request: StartCaptureRequest): Promise<CaptureStarted>;
  pauseCapture(): Promise<void>;
  resumeCapture(): Promise<void>;
  /** Stop, release the device, and say what was captured. Safe to call twice. */
  stopCapture(): Promise<CaptureSummary>;

  onSegment(handler: (segment: TranscriptSegment) => void): Unsubscribe;
  onLevel(handler: (level: AudioLevel) => void): Unsubscribe;
  onCaptureState(handler: (update: CaptureStateUpdate) => void): Unsubscribe;

  /** This machine's grant. State and two verbs — never a token. */
  connection: {
    get(): Promise<ConnectionView>;
    /** Open the browser half of the OAuth flow. Returns nothing to hold. */
    connect(): void;
    /** Give the grant up. The queue keeps whatever it is holding. */
    disconnect(): void;
    onChange(handler: (view: ConnectionView) => void): Unsubscribe;
  };

  /** The queue that outlives the window. Counts and a nudge. */
  outbox: {
    status(): Promise<OutboxStatus>;
    /** Ask for a drain now. Fire and forget; the shell decides. */
    drain(): void;
    onChange(handler: (status: OutboxStatus) => void): Unsubscribe;
  };

  onDetection(handler: (view: DetectionView) => void): Unsubscribe;
  onTrayCommand(handler: (command: TrayCommand) => void): Unsubscribe;
}

/**
 * The IPC channel names, in the package both sides import.
 *
 * The preload and the main process are two files that have to agree on a set of
 * strings, and a typo in one of them is a channel nobody answers — which
 * presents as a promise that never settles rather than as an error. Naming them
 * here also makes the main process's sender check enumerable: every channel it
 * handles is in this object, so "did we guard all of them" is a question with a
 * list rather than a grep.
 *
 * The first two keep the names `preload/console.ts` already used, so wiring the
 * shell to this package renames nothing.
 */
export const BRIDGE_CHANNELS = Object.freeze({
  /** Sync. The origin the main process pinned this window to. */
  origin: "context:console-origin",
  /** Sync. `{ app, version, platform }`. No credential, no paths. */
  shell: "context:console-shell",

  capabilities: "context:capabilities",
  /*
    THE FOUR CAPTURE VERBS CARRY THE `console-` PREFIX, AND THAT IS A GUARD.

    `context:capture-{start,pause,resume,stop}` are the *hidden capture
    window's* private channels — `apps/desktop/src/main/capture.ts` sends them
    at one window it owns and `src/preload/capture.ts` listens for them there.
    The bridge used the same four strings when this file was written, which was
    safe only for a reason nobody reading either file would see: `handle`
    (renderer→main, by `invoke`) and `send` (main→renderer) are separate
    registries, so the two never met. That is a trap rather than a design — the
    day somebody answers one of those names with `ipcMain.on` in the capture
    file, the console's Pause is answered by a window holding a live
    microphone.

    So the names are disjoint by construction, which is a property a check can
    hold: `test/consoleBridge.test.mjs` reads both capture sources and asserts
    that no channel string in this object appears in either. Renaming here is
    the whole of the change, because both processes import these constants.
  */
  startCapture: "context:console-capture-start",
  pauseCapture: "context:console-capture-pause",
  resumeCapture: "context:console-capture-resume",
  stopCapture: "context:console-capture-stop",

  connectionGet: "context:connection-get",
  connectionConnect: "context:connection-connect",
  connectionDisconnect: "context:connection-disconnect",

  outboxStatus: "context:outbox-status",
  outboxDrain: "context:outbox-drain",

  /** Main → page. Pushed; the page subscribes through the bridge. */
  segment: "context:on-segment",
  level: "context:on-level",
  captureState: "context:on-capture-state",
  connectionChange: "context:on-connection",
  outboxChange: "context:on-outbox",
  detection: "context:on-detection",
  trayCommand: "context:on-tray-command",
});

/** Every channel name, for a guard that has to cover all of them. */
export const BRIDGE_CHANNEL_NAMES: readonly string[] = Object.freeze(
  Object.values(BRIDGE_CHANNELS),
);
