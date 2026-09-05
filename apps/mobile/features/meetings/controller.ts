import { currentEpoch } from "../offline/epoch";
import type { KeyValueStore } from "../offline/memory";
import type { MeetingRecorder } from "./capture";
import type { MeetingsGateway } from "./gateway";
import { newMeetingId, type RandomBytes } from "./ids";
import { NOT_DURABLE_REASON, forgetMeeting, loadMeetings, saveMeeting } from "./local";
import {
  emptyAck,
  isSynced,
  retrySync,
  type MeetingRecord,
} from "./record";
import type {
  Attendee,
  MeetingDevice,
  MeetingEvent,
  MeetingSession,
  MeetingSource,
} from "./protocol";
import { PROTOCOL_VERSION } from "./protocol";
import {
  applyMeetingEvent,
  can,
  elapsedMs,
  isLive,
  seedProjection,
  transcriptionFor,
  type MeetingProjection,
} from "./session";
import { drainMeetings } from "./sync";

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
 */

export interface MeetingsSnapshot {
  /** `null` until `configure` has run; the workspace these records belong to. */
  workspaceId: string | null;
  status: "unconfigured" | "loading" | "ready";
  /** Newest first. */
  records: MeetingRecord[];
  /** The meeting that is recording or paused, if any. */
  live: MeetingRecord | null;
  /** Records under this feature's keys that this build could not read. */
  unreadable: number;
  /** False when this device will not keep a meeting across a restart. */
  durable: boolean;
  /** Why not. Shown once, plainly, rather than on every screen. */
  durabilityReason: string | null;
  /** A drain is in flight. */
  syncing: boolean;
  /** What capture this build can do. Straight off the recorder. */
  capture: MeetingRecorder["capability"];
  /**
   * Why audio is not being captured for the meeting in progress, or `null`.
   *
   * Device state, deliberately kept off the session. `MeetingSession.failureReason`
   * belongs to the `failed` state, and `MEETING_TRANSITIONS` allows
   * `failed -> recording` — which is exactly the move that turns a refused
   * microphone into a typed session — so the reducer clears the reason on the
   * way through. Storing a capture problem there would mean either losing it
   * one event later or keeping a session marked failed that is not.
   *
   * It is also the honest place for it: a denied permission is a fact about
   * this phone, not about the meeting, and it would be wrong in the note that
   * lands in somebody's bucket.
   */
  captureError: string | null;
}

export interface ConfigureInput {
  workspaceId: string;
  store: KeyValueStore;
  gateway: MeetingsGateway;
  recorder: MeetingRecorder;
  device: MeetingDevice;
  now?: () => number;
  randomBytes?: RandomBytes;
  /** Trailing debounce before a record is written down. */
  persistDebounceMs?: number;
  /** Floor between two drains asked for by `requestSync`. */
  syncThrottleMs?: number;
}

export interface StartInput {
  title: string;
  source?: MeetingSource;
  attendees?: Attendee[];
}

/** How long typing waits before it is written to the device. */
export const PERSIST_DEBOUNCE_MS = 800;

/**
 * The floor between two drains asked for by `requestSync`.
 *
 * A **throttle**, not a debounce, and the difference is the whole point. Every
 * keystroke changes the record, so the app's "something is waiting, send it"
 * effect fires on every keystroke — and a debounce would then reset on every
 * one, so a person typing steadily for forty minutes would sync nothing until
 * they stopped. A throttle guarantees progress: the first request schedules a
 * drain and the ones behind it ride along with it.
 *
 * Five seconds because the thing being bounded is a POST to the customer's own
 * gateway on their quota. Losing five seconds of typing to a phone that dies is
 * the cost; the device's own copy is a second behind at worst
 * (`PERSIST_DEBOUNCE_MS`), and that copy is what actually protects the meeting.
 *
 * `sync()` itself is never throttled — `end()` calls it directly, and so does a
 * person pressing retry.
 */
export const SYNC_THROTTLE_MS = 5_000;

const NO_CAPTURE: MeetingRecorder["capability"] = {
  audio: false,
  transcribesAt: "nowhere",
  unavailableReason: null,
};

const UNCONFIGURED: MeetingsSnapshot = Object.freeze({
  workspaceId: null,
  status: "unconfigured",
  records: [],
  live: null,
  unreadable: 0,
  durable: false,
  durabilityReason: null,
  syncing: false,
  capture: NO_CAPTURE,
  captureError: null,
});

export class MeetingsController {
  private listeners = new Set<() => void>();
  private snapshot: MeetingsSnapshot = UNCONFIGURED;
  private projections = new Map<string, MeetingProjection>();
  private config: ConfigureInput | null = null;
  private epoch = 0;
  private persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private syncTimer: ReturnType<typeof setTimeout> | null = null;

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

  /* ------------------------------- lifecycle ------------------------------ */

  /**
   * Point the controller at a context and read what is already on the device.
   *
   * Re-configuring for the *same* workspace is a no-op rather than a reload:
   * every screen in this feature calls it on mount, and re-reading the store
   * because somebody navigated between two of them would drop the live
   * session's projection on the floor.
   */
  async configure(input: ConfigureInput): Promise<void> {
    if (this.config?.workspaceId === input.workspaceId) {
      this.config = { ...input };
      return;
    }

    this.config = { ...input };
    this.epoch = currentEpoch();
    this.projections.clear();
    this.set({
      ...UNCONFIGURED,
      workspaceId: input.workspaceId,
      status: "loading",
      capture: input.recorder.capability,
    });

    const { records, unreadable } = await loadMeetings(input.store, input.workspaceId);
    for (const record of records) {
      this.projections.set(record.session.id, {
        session: record.session,
        runningSince: record.runningSince,
      });
    }

    this.set({
      ...this.snapshot,
      status: "ready",
      records,
      live: records.find((record) => isLive(record.session.state)) ?? null,
      unreadable,
      durable: input.store.durable,
      durabilityReason: input.store.durable ? null : NOT_DURABLE_REASON,
      capture: input.recorder.capability,
    });
  }

  /** Forget the configuration, for a sign-out or a context switch. */
  reset(): void {
    for (const timer of this.persistTimers.values()) clearTimeout(timer);
    this.persistTimers.clear();
    if (this.syncTimer !== null) clearTimeout(this.syncTimer);
    this.syncTimer = null;
    this.projections.clear();
    this.config = null;
    this.set(UNCONFIGURED);
  }

  /* ------------------------------- recording ------------------------------ */

  /**
   * Begin a meeting.
   *
   * The order is deliberate and is the one thing in this method that is not
   * obvious: the record is created and written down **before** the recorder is
   * asked to start. A recorder that refuses — a denied permission, a device
   * already in use — then leaves a real session on screen that the person can
   * type into, rather than nothing at all. The reference experience is a
   * notepad first; a refused microphone must not cost somebody their notes.
   */
  async start(input: StartInput): Promise<string> {
    const config = this.require();
    const now = config.now?.() ?? Date.now();
    const at = new Date(now).toISOString();
    const id = newMeetingId(config.randomBytes);

    const projection = seedProjection({
      id,
      title: input.title,
      startedAt: at,
      source: input.source ?? { kind: "unknown" },
      device: config.device,
      attendees: input.attendees,
      /*
        Taken from the recorder this build has, at the one moment a session is
        built, so the note that lands in somebody's bucket says how it was made.
        It names the engine that is about to run rather than the one that turned
        out to produce words: a recorder that ships audio to a service and then
        fails still shipped it, and a note that said `none` because nothing came
        back would be wrong in the only direction that matters.
      */
      transcription: transcriptionFor(config.recorder.capability.transcribesAt),
      version: PROTOCOL_VERSION,
    });
    this.projections.set(id, projection);

    const record: MeetingRecord = {
      version: 1,
      workspaceId: config.workspaceId,
      session: projection.session,
      acked: emptyAck(),
      runningSince: null,
      updatedAt: now,
      attempts: 0,
    };
    this.put(record, { immediate: true });

    this.apply(id, { type: "start", at });
    this.set({ ...this.snapshot, captureError: null });

    try {
      await config.recorder.start();
    } catch (error) {
      /*
        The session stays `recording` and the reason goes on the *snapshot*.
        Moving it to `failed` and straight back — the first version of this —
        was worse in both directions: the reducer clears `failureReason` on the
        way back to `recording`, so the sentence was lost one line after it was
        written, and while it existed the meeting was marked as having failed
        when nothing about the meeting had.

        A refused microphone is a fact about this phone. The notepad is the
        product, so it keeps running and the screen says what is not being
        captured.
      */
      this.set({
        ...this.snapshot,
        captureError:
          error instanceof Error ? error.message : "The recorder would not start.",
      });
    }

    this.listenToRecorder(id);
    return id;
  }

  pause(): void {
    const live = this.snapshot.live;
    if (live === null || !can(live.session.state, "paused")) return;
    void this.require().recorder.pause();
    this.apply(live.session.id, { type: "pause", at: this.nowIso() });
  }

  resume(): void {
    const live = this.snapshot.live;
    if (live === null || !can(live.session.state, "recording")) return;
    void this.require().recorder.resume();
    this.apply(live.session.id, { type: "resume", at: this.nowIso() });
  }

  /**
   * End the meeting: stop the device, move to `finalizing`, and try to sync.
   *
   * The recorder is stopped **first and unconditionally**, before any state
   * check. A session whose state machine says it cannot end — a bug, or a
   * double press racing itself — must not leave the microphone open; on iOS
   * that is a red bar across somebody's status bar after they thought they had
   * finished.
   */
  async end(): Promise<void> {
    const config = this.require();
    await config.recorder.stop().catch(() => {
      // A recorder that will not stop is not a reason to refuse to end a
      // meeting. It is reported through `onError`, which is already wired.
    });

    const live = this.snapshot.live;
    if (live === null) return;
    this.apply(live.session.id, { type: "end", at: this.nowIso() });
    this.flush(live.session.id);
    await this.sync();
  }

  /**
   * The human's own Markdown.
   *
   * Never rewritten by anything else in this feature — "it is theirs and is
   * never rewritten by the enhancement pass" — and never read back into the
   * text input the person is typing in. See `NotesPad`.
   */
  setNotes(meetingId: string, markdown: string): void {
    this.apply(meetingId, { type: "notes", markdown });
  }

  setTitle(meetingId: string, title: string): void {
    this.apply(meetingId, { type: "title", title });
  }

  /** Forget a meeting on this device. The only path that destroys a recording. */
  async discard(meetingId: string): Promise<void> {
    const config = this.require();
    if (this.snapshot.live?.session.id === meetingId) {
      // Discarding the meeting that is running has to release the device as
      // well. Without this the microphone stays open with nothing left to
      // record into — on iOS, a red bar over an app that has forgotten why.
      await config.recorder.stop().catch(() => {});
    }
    this.cancelPersist(meetingId);
    this.projections.delete(meetingId);
    await forgetMeeting(config.store, config.workspaceId, meetingId);
    const records = this.snapshot.records.filter((record) => record.session.id !== meetingId);
    this.set({ ...this.snapshot, records, live: records.find((r) => isLive(r.session.state)) ?? null });
  }

  /** Put a parked meeting back in the queue, at the person's request. */
  async retry(meetingId: string): Promise<void> {
    const record = this.find(meetingId);
    if (record === undefined) return;
    this.put(retrySync(record), { immediate: true });
    await this.sync();
  }

  /* --------------------------------- sync --------------------------------- */

  /**
   * Ask for a drain, at most one every `SYNC_THROTTLE_MS`.
   *
   * What the app's "something changed, send it" effect calls. Everything that
   * changes a meeting changes it on a keystroke, so this is the only entry
   * point that is safe to call from a render-driven effect — see
   * `SYNC_THROTTLE_MS` for why it is a throttle rather than a debounce.
   */
  requestSync(): void {
    if (this.syncTimer !== null) return;
    const delay = this.config?.syncThrottleMs ?? SYNC_THROTTLE_MS;
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      void this.sync();
    }, delay);
  }

  /**
   * Send everything waiting.
   *
   * Guarded against overlapping runs rather than queued: two drains in flight
   * would each read the same records and send the same segments twice, which is
   * harmless by the protocol's idempotency and pointless against somebody's
   * request quota. The second caller gets the first one's outcome by watching
   * the snapshot.
   */
  async sync(): Promise<void> {
    const config = this.config;
    if (config === null || this.snapshot.syncing) return;

    const waiting = this.snapshot.records.filter(
      (record) => !isSynced(record) && record.rejection === undefined,
    );
    if (waiting.length === 0) return;

    this.set({ ...this.snapshot, syncing: true });
    try {
      const { records } = await drainMeetings(waiting, {
        gateway: config.gateway,
        now: () => config.now?.() ?? Date.now(),
        onEvents: (meetingId, events) => {
          for (const event of events) this.apply(meetingId, event);
        },
      });
      /*
        Only the sync bookkeeping is written back, never the session.

        The drain works from the records it was handed, and `onEvents` has
        already folded the gateway's answer — a `written` with the note's path —
        through the reducer while it ran. Putting the whole returned record back
        would overwrite that with the pre-drain session, so a meeting would
        finish `finalizing` forever with the path it was just given thrown away.
        Measured: `meetingsController.test.ts`'s "the device is released and the
        note is written" is the test that caught it.
      */
      for (const drained of records) {
        const current = this.find(drained.session.id) ?? drained;
        this.put(
          {
            ...current,
            acked: drained.acked,
            attempts: drained.attempts,
            rejection: drained.rejection,
            lastError: drained.lastError,
          },
          { immediate: true },
        );
      }
    } finally {
      this.set({ ...this.snapshot, syncing: false });
    }
  }

  /* ------------------------------- internals ------------------------------ */

  /** The one path by which a session changes. */
  apply(meetingId: string, event: MeetingEvent): void {
    const config = this.config;
    if (config === null) return;
    const before = this.projections.get(meetingId);
    if (before === undefined) return;

    const after = applyMeetingEvent(before, event);
    // Identity, not deep equality: `applyMeetingEvent` returns the same object
    // for a refused move, so this is exactly "the reducer refused" and costs
    // nothing to check.
    if (after === before) return;
    this.projections.set(meetingId, after);

    const existing = this.find(meetingId);
    const record: MeetingRecord = {
      version: 1,
      workspaceId: config.workspaceId,
      session: after.session,
      acked: existing?.acked ?? emptyAck(),
      runningSince: after.runningSince,
      updatedAt: config.now?.() ?? Date.now(),
      attempts: existing?.attempts ?? 0,
      rejection: existing?.rejection,
      lastError: existing?.lastError,
    };
    // A state change is written through; typing is debounced. See the header.
    this.put(record, { immediate: event.type !== "notes" && event.type !== "title" });
  }

  private listenToRecorder(meetingId: string): void {
    const config = this.require();
    config.recorder.onSegment((segment) => {
      this.apply(meetingId, { type: "segment", segment });
    });
    config.recorder.onError((error) => {
      /*
        A capture failure never ends a meeting, recoverable or not, and it never
        moves the session's state — see `start` above. The typed notes are the
        product and they keep working; what changes is what the screen is
        allowed to claim about the transcript.

        A recoverable interruption (a phone call, Siri) also lands here so the
        chip can say so while it lasts; the next successful `start` clears it.
      */
      this.set({ ...this.snapshot, captureError: error.message });
    });
  }

  private put(record: MeetingRecord, options: { immediate: boolean }): void {
    const records = [record, ...this.snapshot.records.filter((r) => r.session.id !== record.session.id)]
      .sort((a, b) => Date.parse(b.session.startedAt) - Date.parse(a.session.startedAt));
    this.set({
      ...this.snapshot,
      records,
      live: records.find((r) => isLive(r.session.state)) ?? null,
    });

    if (options.immediate) {
      this.cancelPersist(record.session.id);
      void this.persist(record);
      return;
    }
    this.schedulePersist(record);
  }

  private schedulePersist(record: MeetingRecord): void {
    const config = this.require();
    this.cancelPersist(record.session.id);
    const timer = setTimeout(() => {
      this.persistTimers.delete(record.session.id);
      const latest = this.find(record.session.id);
      if (latest !== undefined) void this.persist(latest);
    }, config.persistDebounceMs ?? PERSIST_DEBOUNCE_MS);
    this.persistTimers.set(record.session.id, timer);
  }

  /** Write a pending record down now, e.g. because the meeting just ended. */
  flush(meetingId: string): void {
    const record = this.find(meetingId);
    if (record === undefined) return;
    this.cancelPersist(meetingId);
    void this.persist(record);
  }

  private cancelPersist(meetingId: string): void {
    const timer = this.persistTimers.get(meetingId);
    if (timer !== undefined) clearTimeout(timer);
    this.persistTimers.delete(meetingId);
  }

  private async persist(record: MeetingRecord): Promise<void> {
    const config = this.config;
    if (config === null) return;
    const outcome = await saveMeeting(config.store, record, this.epoch);
    if (outcome.persisted) return;
    /*
      Idempotent on purpose. This runs on every write — which is every keystroke
      — and `set` notifies every subscriber, so a version that reassigned the
      snapshot each time would re-render the whole app once per character on
      exactly the devices least able to afford it.
    */
    const reason = outcome.reason ?? this.snapshot.durabilityReason;
    if (!this.snapshot.durable && this.snapshot.durabilityReason === reason) return;
    this.set({ ...this.snapshot, durable: false, durabilityReason: reason });
  }

  private find(meetingId: string): MeetingRecord | undefined {
    return this.snapshot.records.find((record) => record.session.id === meetingId);
  }

  private nowIso(): string {
    return new Date(this.config?.now?.() ?? Date.now()).toISOString();
  }

  private require(): ConfigureInput {
    if (this.config === null) {
      throw new Error("MeetingsController used before configure()");
    }
    return this.config;
  }

  private set(snapshot: MeetingsSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

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

/** The session a screen is about, or `null`. */
export function findSession(
  snapshot: MeetingsSnapshot,
  meetingId: string,
): MeetingSession | null {
  return snapshot.records.find((record) => record.session.id === meetingId)?.session ?? null;
}
