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
export const BRIDGE_VERSION = 6;

/**
 * The oldest bridge this bundle will still talk to.
 *
 * **Still 1 now that `BRIDGE_VERSION` is 5**, and that is the whole reason it
 * was written as a second constant: raising the ceiling is not the same edit as
 * dropping support for the shells already installed, and a shell somebody
 * installed in March answers `1` and is doing nothing wrong. A version-1 shell
 * has no `meetings` — see `DesktopBridge.meetings` — so the page keeps the
 * writer it already had, which is the browser's, and nothing degrades. A
 * version-2 shell has no `connection.pendingApproval`, so the page never offers
 * to mint its machine grant and that shell keeps approving in its own window,
 * which is what #312 shipped and what still happens whenever this is refused.
 * A version-3 shell sends no `CaptureStateUpdate.notice` and no
 * `CaptureSummary.frames`, and both are *absences a normaliser fills in* —
 * `null` and `0` — rather than members to be guarded. The number moved anyway,
 * because the ceiling records what a shell can be asked to say, and "this build
 * cannot tell you why it stopped transcribing" is a fact about a shell that
 * somebody staring at an empty transcript has to be able to read. A version-4
 * shell has no `imessage` — see `DesktopBridge.imessage` — so the console
 * never offers the iMessage toggle on it and that shell keeps whatever the
 * tray's own checkbox last set.
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
  /**
   * How many chunks of audio the recorder produced, which is not `segments`.
   *
   * The two answer different questions and the whole value is in the pair.
   * `frames: 0` is **the microphone never produced anything** — a dead input, a
   * rotation that never fired. `frames: 3, segments: 0` is **audio was captured
   * and the far end would not take it**. Different faults, different fixes, and
   * indistinguishable from this payload until this field existed: the count has
   * been kept in `main/capture.ts` since the recorder was written and was read
   * once, for `recordedMs`, then discarded.
   *
   * It is what made the `SEGMENT_MS`/`DRAIN_INTERVAL_MS` race diagnosable at
   * all, and it was only available by patching `fetch` in the main process by
   * hand. Nobody should have to do that twice.
   */
  frames: number;
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
  /**
   * THE ONE SENTENCE ABOUT WHAT THIS MEETING IS *NOT* DOING, OR `null`.
   *
   * Not a fault: the capture is fine and the meeting continues. This is the
   * shell's `SessionView.notice` — "system audio was not available", "this
   * meeting is not being transcribed" — which the shell already shows in its
   * own tray and its own panel and, until this field existed, showed nowhere
   * else.
   *
   * **The field is here because its absence hid a defect for a day.** The
   * transcriber raises `CAPTURE_NOTICES.refused` when a meeting stops being
   * transcribed mid-recording, and with `{state, capturing, fault}` as the whole
   * of this payload there was no member it could travel on: the shell said the
   * sentence to itself, the console drew a recording that looked perfectly
   * healthy, and the only place the truth appeared was a transcript that came
   * out empty afterwards. `CaptureStarted.notice` carries the sentence a meeting
   * *starts* with; nothing carried one it acquires.
   *
   * A plain string rather than a second `CaptureFault`, deliberately. The
   * recoverable bit would be the only other thing to carry, nothing in
   * `apps/mobile` reads it, and each of these sentences already says what it
   * means for the rest of the meeting. What is on the wire is what is on the
   * glass.
   *
   * Additive: a shell built before this field answers without it and
   * `getDesktopBridge`'s normaliser reads that as `null`, so no version moves.
   */
  notice: string | null;
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

/**
 * A machine grant waiting for the page to approve it with its own session.
 *
 * One field, and it is deliberate that there is only one: everything else about
 * the flow — the scope, the tier, the redirect, the verifier, the state — stays
 * in the main process, where it was already. What the page is handed is the
 * address of a question the control plane is holding for it, and the control
 * plane decides whether that question can be answered without a screen.
 */
export interface PendingMachineApproval {
  /** The parked authorization request, as the consent screen addresses it. */
  requestId: string;
}

/** What the page did about a `PendingMachineApproval`. */
export interface MachineApprovalResult {
  /** Which pending approval this is about. A stale id is ignored. */
  requestId: string;
  /**
   * True when the control plane approved and the page is on its way to the
   * loopback redirect. False for every other outcome, and false is a fallback
   * rather than a failure — the shell shows the approve screen instead.
   */
  approved: boolean;
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
 * One write about a meeting, handed to the shell's queue.
 *
 * ## Why the page hands over a write rather than a meeting
 *
 * The four kinds are the meetings protocol's four routes, and the bodies are
 * the ones `createHttpGateway` already composes — because that is the client
 * whose credential the shell actually holds. The page composes; the shell
 * queues, addresses and sends. Nothing here is a second protocol: a `write`
 * with `kind: "segments"` is `POST /meetings/sessions/:id/segments` with this
 * body, and the shell's own tray-only recording posts the same four.
 *
 * ## Why `context` is a name and not a path
 *
 * The gateway routes a meeting by an optional `@name` on the front of the
 * path, and the shell is the process that builds the URL. Handing it a *slug*
 * rather than a path means a page cannot choose what this app posts to: the
 * shell checks the slug against the same `[a-z0-9-]{2,32}` the gateway's own
 * selector accepts, and refuses the write rather than letting an unroutable
 * value fall off the front and be served by whatever context the credential
 * defaults to. That silent fallback is a meeting written into the wrong tenant,
 * which `apps/mobile/features/meetings/gateway.ts` already argues at length.
 *
 * `null` means the connection's own default context, which is the one the
 * machine's grant was minted for.
 */
export interface MeetingWrite {
  sessionId: string;
  kind: MeetingWriteKind;
  /** The `@name` this meeting is addressed to, without the `@`, or `null`. */
  context: string | null;
  /** The JSON body for the protocol route this kind names. */
  body: Record<string, unknown>;
}

/** The meetings protocol's four routes, as a word. */
export type MeetingWriteKind = "session" | "segments" | "notes" | "finalize";

export const MEETING_WRITE_KINDS: readonly MeetingWriteKind[] = Object.freeze([
  "session",
  "segments",
  "notes",
  "finalize",
] as MeetingWriteKind[]);

/**
 * What the shell did with a write.
 *
 * Three states, and the page treats them as three different things:
 *
 *  - **`rejected`** — the gateway refused this meeting in a way retrying cannot
 *    fix, so the shell's queue parked it. The page parks its own record with
 *    the same sentence rather than retrying against somebody's quota.
 *  - **`notePath`** — a finalize that reached the bucket. The only fact on this
 *    ack the page did not already know.
 *  - **`queued`** — the shell holds it. For the first three kinds that is a
 *    completed handover: the queue outlives the window and drains with no page
 *    open. For a **finalize** it is deliberately *not* an acknowledgement — the
 *    note is not written yet, and `docs/decisions/app-and-console.md` is
 *    unambiguous that a UI may never claim a write it has not seen land.
 */
export interface MeetingWriteAck {
  sessionId: string;
  /** The shell's queue is holding this write. See above for what that means. */
  queued: boolean;
  /** Where the note landed, when a finalize has already drained. */
  notePath: string | null;
  /** Parked by the shell's queue: a refusal a person has to act on. */
  rejected: { code: string; message: string } | null;
}

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

    /**
     * The parked authorization request this machine is waiting on. **Version 3.**
     *
     * Optional for `MIN_BRIDGE_VERSION`'s reason: a shell installed before this
     * shipped has no such member, and a page checks for it rather than
     * inferring it from the fact that a bridge is present.
     *
     * ## What this is, and what it deliberately is not
     *
     * It is a **request id** — the same one the control plane's consent screen
     * is addressed by, which is why the page can answer it with the session it
     * already holds. It is not a credential, not a code, and not a step in the
     * OAuth flow: PKCE's verifier and the loopback listener stay in the main
     * process, so the page can no more complete this flow on its own than the
     * system browser could.
     *
     * The reason it crosses at all is the owner's, 2026-09-07: *"when
     * installing Granola I didn't have to 'connect' a machine, things just
     * worked."* The person is signed in **in this window**; handing the page
     * the id lets it approve the machine with that session and no screen, and
     * `docs/decisions/desktop.md` carries what that trades and what it does
     * not.
     */
    pendingApproval?(): Promise<PendingMachineApproval | null>;
    /** Version 3. Pushed when a connect parks one, and when it is over. */
    onPendingApproval?(
      handler: (pending: PendingMachineApproval | null) => void,
    ): Unsubscribe;
    /**
     * Version 3. What the page did about it.
     *
     * `approved: false` is the ordinary answer from a page that could not — no
     * session, a control plane that refused, a client this deployment will not
     * auto-approve — and the shell answers it by putting the approve screen in
     * this window, which is what it did before any of this existed. So a page
     * that says no costs a person one screen, never a grant.
     */
    resolveApproval?(result: MachineApprovalResult): Promise<void>;
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

  /**
   * The meeting note, written by the machine's own grant. **Version 2.**
   *
   * Optional on the type because `MIN_BRIDGE_VERSION` is still 1: a shell
   * somebody installed before this shipped answers `version: 1`, is accepted,
   * and has no `meetings` — so a page checks for the member rather than
   * inferring it from the fact that a bridge is present. Declaring it
   * non-optional would be this bundle asserting a member that is genuinely
   * absent on every shell in the estate today, and the failure would be a
   * `TypeError` mid-meeting rather than a browser-shaped fallback.
   *
   * ## Why this exists at all
   *
   * Without it a meeting recorded on a Mac takes **two** credentials: the
   * shell's machine grant for the audio it captured and transcribed, and the
   * page's control-plane session for the note. `docs/decisions/desktop.md`
   * names that as the half step 3 deferred, and the cost is not abstract —
   * the shell's window-less outbox is not on the path, so the meeting is
   * written by the page that happens to be open rather than by the queue that
   * survives it. One meeting is one credential, and on the desktop it is this
   * one.
   */
  meetings?: {
    write(write: MeetingWrite): Promise<MeetingWriteAck>;
  };

  /**
   * Whether this machine imports iMessage history, and the one fact it needs
   * from the person before it can. **Version 5.**
   *
   * Optional on the type for `MIN_BRIDGE_VERSION`'s reason, same as
   * `meetings` above: a shell that shipped before this existed answers a
   * version below 5 and has no `imessage` member, so the console's iMessage
   * toggle checks for the member rather than assuming it because a bridge is
   * present at all.
   *
   * There is no `enable()`/`disable()` pair here on purpose — `setEnabled`
   * mirrors `toggleDetection`'s own shape (`docs/decisions/desktop.md`'s
   * "Watch for meetings" toggle), because turning iMessage import on is the
   * same kind of decision as turning detection on: reversible, off by
   * default, and something the tray offers exactly as it offers detection.
   */
  imessage?: {
    status(): Promise<ImessageStatus>;
    /** Turn import on or off. Never opens a system dialog — see `docs/decisions/communications.md`. */
    setEnabled(enabled: boolean): Promise<void>;
    /** Explain Full Disk Access and open the exact System Settings pane when the person continues. */
    requestFullDiskAccess(): Promise<void>;
    onChange(handler: (status: ImessageStatus) => void): Unsubscribe;
  };
}

/**
 * What the console may know about iMessage import. Never a path, never a
 * message, never a contact — only whether it is on, whether this Mac has
 * granted the one permission it needs, and when it last actually wrote
 * something.
 */
export interface ImessageStatus {
  enabled: boolean;
  /**
   * Full Disk Access cannot be requested, only attempted — see
   * `core/imessage/permission.ts`. `"unknown"` covers both "never tried yet"
   * and "tried, and the failure was not clearly a permission refusal" (a
   * `chat.db` that does not exist yet, for instance); it is never shown as a
   * more alarming "denied" than the evidence supports.
   */
  permission: "granted" | "denied" | "unknown";
  /** Epoch milliseconds of the last completed sync attempt, or `null` before the first one. */
  lastSyncedAt: number | null;
  /** The shell's own words for the last thing that went wrong, or `null`. */
  lastError: string | null;
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

  /** Version 3. The parked request this machine is waiting on, or null. */
  connectionPendingApproval: "context:connection-pending-approval",
  /** Version 3. What the page did about it. */
  connectionResolveApproval: "context:connection-resolve-approval",

  outboxStatus: "context:outbox-status",
  outboxDrain: "context:outbox-drain",

  /** Version 2. One write about a meeting, into the shell's own queue. */
  meetingsWrite: "context:meetings-write",

  /** Version 5. */
  imessageStatus: "context:imessage-status",
  imessageSetEnabled: "context:imessage-set-enabled",
  /** Version 6. Show the native guide, then open Full Disk Access settings. */
  imessageRequestFullDiskAccess: "context:imessage-request-full-disk-access",

  /** Main → page. Pushed; the page subscribes through the bridge. */
  segment: "context:on-segment",
  level: "context:on-level",
  captureState: "context:on-capture-state",
  connectionChange: "context:on-connection",
  /** Version 3. Main → page: a parked approval opened, or closed. */
  pendingApprovalChange: "context:on-pending-approval",
  outboxChange: "context:on-outbox",
  /** Version 5. Main → page: enabled/permission/last-sync state changed. */
  imessageChange: "context:on-imessage",
  detection: "context:on-detection",
  trayCommand: "context:on-tray-command",
});

/** Every channel name, for a guard that has to cover all of them. */
export const BRIDGE_CHANNEL_NAMES: readonly string[] = Object.freeze(
  Object.values(BRIDGE_CHANNELS),
);
