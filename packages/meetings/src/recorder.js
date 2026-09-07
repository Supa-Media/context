/**
 * WHAT THE DEVICE IS DOING, as opposed to what the meeting is doing.
 *
 * There are two state machines in this product and conflating them is a bug
 * waiting to happen, so they live in two files that say what they are:
 *
 *  - `session.js` / `MEETING_TRANSITIONS` — the **meeting**. Idle, recording,
 *    paused, finalizing, complete, failed. It is the thing the note is written
 *    from, it is replayed from a log, and it is what the gateway agrees with.
 *  - this file — the **recorder**. Whether an input is open right now. It has
 *    no log, it is never replayed, and nothing about it reaches the wire.
 *
 * A meeting can be `recording` with no recorder at all (a typed session on a
 * phone that refused the microphone), and a recorder can be `stopped` while the
 * meeting is `finalizing`. Neither is a contradiction, and a single table
 * covering both would have to call one of them a lie.
 *
 * ## Why it is here rather than in the app that first needed it
 *
 * Four implementations of `MeetingRecorder` already exist in `apps/mobile`
 * (`expo-audio` on a phone, `MediaRecorder` in a browser, the honest notes-only
 * one, and the fake a test drives), and the desktop shell adds a fifth that
 * lives in a different process. Every one of them was keeping its own
 * `let state` and its own idea of which moves are allowed. That is the
 * duplication this package exists to end — `apps/desktop/src/core/contract.ts`
 * names the failure exactly: *"a local copy … that drifts by one field is a
 * wire bug that typechecks"* — and it is worth ending here rather than in the
 * app, because the shell cannot import the app: it is a separate process, in a
 * separate bundle, that shares only what is in `packages/`.
 *
 * **Three of the five answer to this table today**, and the count is written
 * down rather than rounded up: `capture/notesOnly.ts`, `capture/fake.ts` and
 * `capture/desktop.ts`. The two that actually hold a device — `capture/audio.ts`
 * and `capture/audio.web.ts` — still keep their own assignments, and they are
 * not an oversight to be quietly counted as converted:
 *
 *  - they carry a move this table has no verb for. A `start` whose first chunk
 *    will not open returns the recorder to **`idle`**, not to `recording` and
 *    not to `stopped`, so the person can press Record again; `start`, `pause`,
 *    `resume` and `stop` cannot express that.
 *  - they are more permissive than this table in one place — `pause` from
 *    `idle` lands on `paused` there and stays `idle` here — and their own
 *    suites pin the conditional they wrote it with (`meetingsCapture.test.ts`
 *    measured 3 failures for making that assignment unconditional).
 *
 * So the rule that matters most is currently held in three places rather than
 * one: here, and by hand in each of those two files, each with its own test
 * named *"resuming a meeting that ended does not reopen the microphone"*.
 * Converting them needs a fifth action for the failed start and a re-run of
 * three suites, and it is the **next step** for this file — recorded here
 * because a shared table that two of its five callers ignore is exactly the
 * kind of half-done consolidation that reads as finished.
 *
 * Plain ESM with JSDoc types and no imports, like everything else here, so the
 * Worker, Metro and Electron can all read it.
 *
 * ## The rules, and why each is what it is
 *
 * **Every move is total and idempotent.** `nextRecorderState` never throws and
 * never returns `undefined`: an illegal move returns the state you were already
 * in. A recorder is driven by device callbacks — a track ending, an
 * interruption, a person pressing pause twice — and those arrive in orders
 * nobody chose. A machine that threw would turn a duplicate `mute` event into a
 * crash in the middle of somebody's meeting.
 *
 * **A stopped recorder can start again.** The controller keeps *one* recorder
 * for the life of a session and starts it once per meeting, so `stopped` is
 * "not currently recording", not "spent". The single exception is `resume`,
 * which does **not** revive a stopped recorder: `audio.web.ts` and `audio.ts`
 * both refuse that by hand today — *"a meeting that has ended does not reopen
 * the microphone"* — and that refusal is the reason this table exists rather
 * than an inferred one.
 *
 * **`stop` always wins.** From any state, including `idle`. Stopping a recorder
 * that never started is how teardown is written everywhere in this feature, and
 * it must be safe: the alternative is a caller that has to know whether it is
 * allowed to release the microphone.
 */

/**
 * @typedef {"idle" | "recording" | "paused" | "stopped"} RecorderState
 * @typedef {"start" | "pause" | "resume" | "stop"} RecorderAction
 */

/** Every state a recorder can be in. The order is the order it moves through. */
export const RECORDER_STATES = Object.freeze(
  /** @type {RecorderState[]} */ (["idle", "recording", "paused", "stopped"]),
);

/**
 * Where each state can go.
 *
 * Declared rather than derived from `nextRecorderState`, so the two are a pair
 * that can disagree — and the suite fails when they do. A table that was
 * computed from the function it is checking would agree with a broken function.
 */
export const RECORDER_TRANSITIONS = Object.freeze({
  idle: Object.freeze(["recording", "stopped"]),
  recording: Object.freeze(["paused", "stopped"]),
  paused: Object.freeze(["recording", "stopped"]),
  /** Reusable, but only by starting again — never by resuming. */
  stopped: Object.freeze(["recording"]),
});

/**
 * The next state, given what happened.
 *
 * @param {RecorderState} state
 * @param {RecorderAction} action
 * @returns {RecorderState} the new state, or the old one when the move is not
 *   available from here. Never throws.
 */
export function nextRecorderState(state, action) {
  switch (action) {
    case "start":
      // From `paused` too: a person who presses Record on a paused recorder
      // means "record", and refusing would leave a control that does nothing.
      return "recording";
    case "pause":
      return state === "recording" ? "paused" : state;
    case "resume":
      // Deliberately not from `stopped`. See the header.
      return state === "paused" ? "recording" : state;
    case "stop":
      return "stopped";
    default:
      return state;
  }
}

/**
 * Whether an input is open in this state.
 *
 * One function so that "is the microphone on" has one answer across a phone, a
 * browser, a menu bar dot and a hidden Electron window. The tray's indicator
 * and the screen's chip disagreeing about that is exactly the kind of thing
 * that makes a recorder untrustworthy.
 *
 * @param {RecorderState} state
 * @returns {boolean}
 */
export function isRecorderCapturing(state) {
  return state === "recording";
}
