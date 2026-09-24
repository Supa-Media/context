/**
 * The types and small constants `MeetingsController` and its responsibility
 * mixins (`controller/lifecycle.ts`, `controller/finalizeRecovery.ts`,
 * `controller/snapshotTyping.ts`, `controller/persistence.ts`) share.
 *
 * Split out of `controller.ts` so those leaf modules never have to import the
 * facade file itself — `controller.ts` re-exports everything here that was
 * already public, so nothing outside this feature sees a different name.
 */
import type { MeetingDestination } from "../destination";
import type { KeyValueStore } from "../../offline/memory";
import type { MeetingRecorder, SpooledAudioCounts } from "../capture";
import type { MeetingsGateway } from "../gateway";
import type { RandomBytes } from "../ids";
import type { MeetingContinuation, MeetingRecord } from "../record";
import type { Attendee, MeetingDevice, MeetingSource } from "../protocol";

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
  /**
   * The meeting whose recorder is being stopped right now, or `null`.
   *
   * **This exists because `end()` is slow and was silent.** The press runs
   * `recorder.stop()`, which closes the last chunk, releases the device and
   * then *waits on `drainSends()`* — and `capture/audio.ts` says in its own
   * words what that wait buys and what it costs: "the device is already back,
   * so waiting here costs a spinner rather than a microphone. What it buys is
   * the last few seconds of the meeting — usually the decision — landing in
   * the note." It is the right trade. The spinner was never drawn.
   *
   * So for as long as the final chunk takes to transcribe — seconds on a good
   * connection, longer on a bad one — the session was still `recording`, every
   * screen went on drawing a live meeting with a running clock, and the person
   * who pressed End had no way to tell a slow upload from a dead button. The
   * owner's report is the whole of it: *"when I click end, it literally takes,
   * like, five seconds with no indicator of what's going on."*
   *
   * It is a **snapshot** field rather than a session state on purpose. There is
   * no `MeetingState` for it and there must not be: the contract's states are
   * what the *gateway* and every other client agree a meeting is, and this is
   * one device's knowledge of a local call it has not returned from — the same
   * argument `MeetingRecord.acked` makes for itself. Nothing sends it, nothing
   * persists it, and a restart mid-end comes back with it clear, which is
   * correct: that stop is over, whatever it managed to drain.
   */
  ending: string | null;
  /**
   * The meeting whose audio is still being turned into words, or `null`.
   *
   * `ending`'s sibling, for the wait on the other side of the fold. Splitting
   * `recorder.stop()` from `recorder.drain()` ended the meeting at the moment
   * somebody pressed End — the clock stops, the bar goes down, the note screen
   * is drawn — and moved the transcription wait behind it. Which left that
   * screen saying the one thing it had for a meeting with no note yet:
   * *"Waiting to reach your context."*
   *
   * That is true and it is not the answer. Nothing is wrong with the
   * connection; the last of the audio is still being transcribed, and the
   * finalize is deliberately held until it is so the note is not written
   * without the end of the meeting. A person reading "waiting to reach your
   * context" has been told a network problem they do not have.
   *
   * Client-local, like `ending` and for the same reasons: no `MeetingState`
   * exists for it, nothing sends it, and a restart mid-drain comes back with
   * it clear — which is correct, because that drain is over.
   */
  transcribing: string | null;
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
  /** A sticky warning that this session records only while the app stays open. */
  backgroundCaptureWarning: string | null;
  /**
   * Audio kept on this device that has not been turned into words yet, per
   * meeting id. Absent means none.
   *
   * `waiting` is what holds a meeting's note back: `sync()` does not finalize a
   * meeting while any of its audio is still on its way, because a note written
   * without it is a note missing part of the meeting, and the words cannot be
   * folded into a meeting that is already a note. `kept` also counts chunks the
   * transcriber refused on their own merits and the drain has stopped trying
   * (`spoolDrain.ts`) — still on the device, still the person's, and said so.
   */
  audio: Readonly<Record<string, SpooledAudioCounts>>;
  /**
   * The reachability hook's answer, mirrored in by `useMeetingsSetup`. Only an
   * explicit "offline" is `true`; unknown is `false`, as it is everywhere else.
   */
  offline: boolean;
  /**
   * Whether the writer this device holds can add a resumed part to the note it
   * continues — `MeetingsGateway.canContinue`, carried here so a screen can
   * decide whether to offer Resume without holding the gateway. See
   * `resume.ts`.
   */
  canContinue: boolean;
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
  /**
   * How long `end()` waits for the recorder's own sends before moving on.
   *
   * The wait is what puts the end of a meeting in its note, and it is worth a
   * few seconds. It is not worth forever — and forever is what it was offline,
   * because an action with no connection neither resolves nor rejects, so the
   * note screen said "still turning the last of the audio into words" for as
   * long as the phone was underground. Past this, whatever has not answered is
   * in the spool and the drain has it.
   */
  drainDeadlineMs?: number;
}

export interface StartInput {
  title: string;
  source?: MeetingSource;
  attendees?: Attendee[];
  /**
   * Where this meeting's note should land, from the sheet that asked.
   *
   * Optional, and absent stays `null` on the record rather than becoming a
   * default this layer invents — see `MeetingRecord.destination`. The meetings
   * list's one-tap record genuinely chose nothing, and the gateway's own
   * default is the right answer for it.
   */
  destination?: MeetingDestination;
  /**
   * Record the machine's own audio as well as the microphone.
   *
   * The person's answer from the sheet, and only ever asked where a build can
   * do it at all — inside the desktop shell on a signed build, or in a browser
   * that can put a source picker in front of somebody. Absent means "whatever
   * this build can do **without asking again**", which is what pressing Record
   * from a surface that never offered the choice has to mean: the shell's
   * silent tap is taken, the browser's picker is not.
   *
   * The recorder narrows it: a `true` here on a browser or a phone changes
   * nothing, because a recorder reports what it opened rather than echoing
   * what it was asked.
   */
  systemAudio?: boolean;
  /**
   * This recording is a later part of a meeting whose note exists. Set by
   * `continueMeeting` and by nothing else; see `MeetingContinuation`.
   */
  continues?: MeetingContinuation;
}

/** What `continueMeeting` needs: what it continues, and what to call it on the screen. */
export interface ContinueInput {
  continues: MeetingContinuation;
  /**
   * The meeting's title as the note has it now. Drawn on the live screen and
   * never written: the note keeps whatever heading it has, because a part is
   * added to a note and does not rename one.
   */
  title: string;
  /**
   * The context the note is in. The same meaning `StartInput.destination` has
   * — `null` is this person's own workspace — and it is what resolves the
   * workspace the note is read from and written back to.
   */
  destination: MeetingDestination | null;
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

/** See `ConfigureInput.drainDeadlineMs`. */
export const DRAIN_DEADLINE_MS = 30_000;

/** Shown when a session captured nothing and the device gave no reason why. */
export const DEFAULT_EMPTY_REASON = "Nothing was recorded and no notes were typed.";

/**
 * Shown on a session `recoverInterruptedRecordings` closed at launch.
 *
 * Names the device rather than the meeting: nothing about the conversation
 * failed, this app's own process restarting is what stopped capturing it.
 */
export const INTERRUPTED_RECORDING_REASON =
  "This device restarted while recording, so the rest of this meeting was not captured. What was recorded is kept below.";

/**
 * Shown on a session `recoverInterruptedRecordings` closed at launch that had
 * captured nothing at all — no transcript, no typed notes — before the
 * restart.
 *
 * `INTERRUPTED_RECORDING_REASON` says "what was recorded is kept below", which
 * is only true when something was. A session `hasNothingCaptured` gets this
 * sentence instead, for the same reason `end()`'s own `DEFAULT_EMPTY_REASON`
 * exists: the permanent, correct fact is that there is nothing here, not that
 * a retry might still find something.
 */
export const INTERRUPTED_EMPTY_REASON =
  "This device restarted before anything was captured, so there is nothing to save from this one.";

export const NO_CAPTURE: MeetingRecorder["capability"] = {
  audio: false,
  systemAudio: false,
  systemAudioNeedsPicker: false,
  transcribesAt: "nowhere",
  unavailableReason: null,
};

export const UNCONFIGURED: MeetingsSnapshot = Object.freeze({
  workspaceId: null,
  status: "unconfigured",
  records: [],
  live: null,
  unreadable: 0,
  durable: false,
  durabilityReason: null,
  syncing: false,
  ending: null,
  transcribing: null,
  capture: NO_CAPTURE,
  captureError: null,
  backgroundCaptureWarning: null,
  audio: Object.freeze({}),
  offline: false,
  canContinue: false,
});
