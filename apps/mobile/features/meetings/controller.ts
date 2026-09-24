import type { MeetingProjection } from "./session";
import { elapsedMs } from "./session";
import type { MeetingActivityController } from "./activityCore";
import { meetingActivity } from "./activity";
import { newActivityControlToken } from "./activityToken";
import type { MeetingSession } from "./protocol";
import type { MeetingRecord } from "./record";
import {
  DEFAULT_EMPTY_REASON,
  DRAIN_DEADLINE_MS,
  INTERRUPTED_EMPTY_REASON,
  INTERRUPTED_RECORDING_REASON,
  PERSIST_DEBOUNCE_MS,
  SYNC_THROTTLE_MS,
  UNCONFIGURED,
  type ConfigureInput,
  type ContinueInput,
  type MeetingsSnapshot,
  type StartInput,
} from "./controller/types";
import { LifecycleMixin } from "./controller/lifecycle";
import { FinalizeRecoveryMixin } from "./controller/finalizeRecovery";
import { SnapshotTypingMixin } from "./controller/snapshotTyping";
import { PersistenceMixin } from "./controller/persistence";

/**
 * The meetings feature's state, outside React.
 *
 * ## Why it is not a provider
 *
 * A recording has to be visible **from anywhere in the app** — that is what the
 * persistent bar is — and it has to survive being navigated away from, which a
 * component's state does not. A context provider would work only if it were
 * mounted above every route, which means one file at the root of the app owning
 * a feature that is otherwise entirely inside `features/meetings/`. An external
 * store read through `useSyncExternalStore` needs nothing above anything: any
 * screen anywhere renders the bar by asking, and no layout has to know this
 * feature exists.
 *
 * That is also what makes the bar honest across a navigation. The clock is
 * derived from the session's own event log (`elapsedMs`), so a screen that
 * mounts thirty minutes into a meeting shows thirty minutes rather than
 * starting from zero — a counter held in a component would have restarted.
 *
 * ## What it owns, and what it deliberately does not
 *
 * It owns: the records for the context you are in, the live session, the
 * recorder handle, writing down, and running a drain. It owns no rendering, no
 * navigation and no clock — `elapsedMs` takes a `now`, and the screens that
 * show a running timer tick themselves.
 *
 * ## Everything goes through the reducer
 *
 * `apply()` is the only path by which a session changes, including answers from
 * the gateway. There is no second place that sets `notePath` or moves a state,
 * which is the property that makes "replaying the log lands on the same
 * session" true of this app rather than only of the protocol.
 *
 * ## Writes are debounced, removals are not
 *
 * The same asymmetry `features/offline/useOfflineNotes.ts` documents. Typing
 * updates memory on every keystroke and is written down on a trailing
 * debounce, so a crash costs a second of typing rather than a `JSON.stringify`
 * per character. Anything that *removes* work — a meeting discarded, a drain
 * settling — is written through immediately, because the failure mode there is
 * resurrection.
 *
 * ## Every write is gated on the session epoch
 *
 * `features/offline/epoch.ts`, captured once when the controller is configured.
 * A recording writes on a keystroke, on a segment and on a timer, all
 * fire-and-forget over an async store; sign-out is a `remove()` loop with an
 * open window behind it. Without the gate the measured result is somebody's
 * private notes back on the device after they signed out.
 *
 * ## Split by responsibility
 *
 * This file is the class shell — fields, constructor, the
 * `subscribe`/`getSnapshot` store contract — and the class body it declares is
 * empty of everything else. The methods are implemented on four mixins,
 * `controller/lifecycle.ts` (start/stop lifecycle), `controller/finalizeRecovery.ts`
 * (finalize/recovery and the gateway sync), `controller/snapshotTyping.ts` (the
 * event reducer and typed notes) and `controller/persistence.ts` (writing a
 * record down), merged onto `MeetingsController.prototype` by `applyMixins`
 * below. Nothing about calling this class changed: `meetings.start(...)` reads
 * and behaves exactly as it did when `start` was a method defined right here.
 * The interface declaration right after the class is what tells TypeScript
 * about the methods the mixins add; see the TypeScript handbook's own mixin
 * pattern, which this follows.
 */
export type { MeetingsSnapshot, ConfigureInput, StartInput, ContinueInput };
export {
  PERSIST_DEBOUNCE_MS,
  SYNC_THROTTLE_MS,
  DRAIN_DEADLINE_MS,
  DEFAULT_EMPTY_REASON,
  INTERRUPTED_RECORDING_REASON,
  INTERRUPTED_EMPTY_REASON,
};

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- see the interface merge below the class, which is the other half of this same, deliberate mixin pattern.
export class MeetingsController {
  constructor(
    readonly activity: MeetingActivityController = meetingActivity,
    readonly activityToken: () => string = newActivityControlToken,
  ) {}
  listeners = new Set<() => void>();
  snapshot: MeetingsSnapshot = UNCONFIGURED;
  projections = new Map<string, MeetingProjection>();
  config: ConfigureInput | null = null;
  epoch = 0;
  persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
  syncTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * How to stop listening to the recorder for the meeting that is live.
   *
   * Held, rather than thrown away, because a subscription that is never
   * detached is not a leak of memory — it is a leak of *authorship*. See
   * `listenToRecorder`.
   */
  recorderOff: (() => void)[] = [];
  /** The meeting `recorderOff` is listening for, or `null`. */
  listeningFor: string | null = null;
  /** Current one-use control capability, held only for this process/session. */
  activityControlTokens = new Map<string, string>();
  /** Stop hearing about the spool. Set while configured. */
  audioOff: (() => void) | null = null;
  /** A spool drain is running; a second request sets `audioAgain` instead. */
  audioDraining: Promise<void> | null = null;
  audioAgain = false;
  /** A drain the transcriber asked us to come back for. */
  audioRetryTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The last reachability answer, kept across `configure` and `reset`.
   *
   * The hook mirrors it in only when it *changes*, and a context switch or a
   * sign-in rebuilds the snapshot from `UNCONFIGURED` — so without this a phone
   * that was already offline would forget it, and the screen would say "waiting
   * to be transcribed" where it should say "offline".
   */
  offlineNow = false;

  /* --------------------------- the store contract -------------------------- */

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * The snapshot.
   *
   * Returned by identity between changes, which `useSyncExternalStore`
   * requires: a fresh object per call is an infinite render loop, and it is the
   * single easiest way to break an external store.
   */
  getSnapshot = (): MeetingsSnapshot => this.snapshot;
}

/**
 * Merge a mixin's prototype methods onto the derived class.
 *
 * The TypeScript handbook's own mixin pattern: each mixin class exists only to
 * hold method implementations (its fields and any method it does not itself
 * define are `declare`d, never initialized), and this copies every own
 * property off its prototype onto `derivedCtor.prototype`. It runs once, at
 * module load, before anything can call a method it is copying in.
 */
function applyMixins(derivedCtor: { prototype: object }, constructors: { prototype: object }[]): void {
  for (const baseCtor of constructors) {
    for (const name of Object.getOwnPropertyNames(baseCtor.prototype)) {
      if (name === "constructor") continue;
      const descriptor = Object.getOwnPropertyDescriptor(baseCtor.prototype, name);
      if (descriptor !== undefined) {
        Object.defineProperty(derivedCtor.prototype, name, descriptor);
      }
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-empty-interface, @typescript-eslint/no-unsafe-declaration-merging, no-redeclare -- the TypeScript handbook's own mixin pattern: `applyMixins` right below actually populates every member this interface adds, at module load and before anything can call one.
export interface MeetingsController
  extends LifecycleMixin,
    FinalizeRecoveryMixin,
    SnapshotTypingMixin,
    PersistenceMixin {}
applyMixins(MeetingsController, [LifecycleMixin, FinalizeRecoveryMixin, SnapshotTypingMixin, PersistenceMixin]);

/**
 * The controller this app uses.
 *
 * A module-level instance rather than one per mount, because the whole point is
 * that a recording outlives the screen that started it. Tests build their own
 * `new MeetingsController()` and never touch this one.
 */
export const meetings = new MeetingsController();

/** Elapsed time for a record, re-exported so screens need one import. */
export function recordElapsedMs(record: MeetingRecord, now: number): number {
  return elapsedMs({ session: record.session, runningSince: record.runningSince }, now);
}

/**
 * How far into the meeting a record is: its own elapsed time, plus what the
 * meeting already held before it when it is a later part (`continues`).
 *
 * The clock a person reads. A resumed meeting is the same meeting still
 * running, so every clock and every typed-note stamp picks up where the note
 * left off — at 31:04, not 0:00 — which is also what the transcript the
 * writer splices in says (`continueMeetingNote` moves it by the same offset).
 */
export function meetingElapsedMs(record: MeetingRecord, now: number): number {
  return (record.continues?.offsetMs ?? 0) + recordElapsedMs(record, now);
}

/** The session a screen is about, or `null`. */
export function findSession(
  snapshot: MeetingsSnapshot,
  meetingId: string,
): MeetingSession | null {
  return snapshot.records.find((record) => record.session.id === meetingId)?.session ?? null;
}
