/**
 * WHAT THE DEVICE IS DOING — `src/recorder.js`.
 *
 * This table is small enough that the temptation is to trust it by reading it.
 * The reason not to: it is now the *shared* answer for five recorders in two
 * processes — `expo-audio` on a phone, `MediaRecorder` in a browser, the honest
 * notes-only one, the fake a test drives, and the desktop shell across an IPC
 * boundary — and each of those used to keep its own. A rule that is wrong here
 * is wrong in all five at once, which is the price of sharing and the reason
 * the sharing has to be checked rather than assumed.
 *
 * The two rules with a real cost behind them:
 *
 *  - **`resume` does not revive a stopped recorder.** `audio.web.ts` and
 *    `audio.ts` both refuse it by hand — "a meeting that has ended does not
 *    reopen the microphone" — and the whole point of lifting this out was that
 *    such a refusal should exist once. A machine that allowed it would reopen
 *    somebody's microphone after they pressed End.
 *  - **Every move is total.** A recorder is driven by device callbacks arriving
 *    in orders nobody chose: a duplicate `mute`, a pause between a `mute` and
 *    its `unmute`, a stop while a rotation is in flight. A machine that threw
 *    on an unexpected move would crash inside somebody's meeting.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are FAIL lines across the
 * whole package suite.
 *
 *   `stopped` made terminal, so a recorder cannot be reused                    2
 *   `resume` allowed from `stopped`                                            1
 *   `stop` refused from `idle` (teardown before a start)                       1
 *   `start` refused from `paused`                                              1
 *   `isRecorderCapturing` answering true for `paused`                          1
 *   an unknown action throwing rather than being ignored                       1
 *
 * The counts are small because the table is small, and each one names a
 * different real behaviour rather than the same assertion written six times.
 * The last row was **0** on the first run and the reason is the one this house
 * keeps meeting: the check called the function outside a `try`, so the throw it
 * was looking for killed the suite and `grep -c FAIL` counted nothing. A check
 * whose failure mode is a crash reports zero failures.
 */

import {
  RECORDER_STATES,
  RECORDER_TRANSITIONS,
  isRecorderCapturing,
  nextRecorderState,
} from "../src/recorder.js";

const ACTIONS = ["start", "pause", "resume", "stop"];

export function runRecorderChecks(check) {
  // -- the table

  check("there are four states", RECORDER_STATES.length === 4);
  check("...and the list is frozen", Object.isFrozen(RECORDER_STATES));
  check(
    "every state has a row in the transition table",
    RECORDER_STATES.every((state) => Array.isArray(RECORDER_TRANSITIONS[state])),
  );
  check(
    "...and every target is itself a state",
    Object.values(RECORDER_TRANSITIONS).every((targets) =>
      targets.every((target) => RECORDER_STATES.includes(target)),
    ),
  );
  check(
    "a recorder starts idle and can only record or stop from there",
    RECORDER_TRANSITIONS.idle.join(",") === "recording,stopped",
  );
  check(
    "a stopped recorder can be started again — one recorder serves many meetings",
    RECORDER_TRANSITIONS.stopped.includes("recording"),
  );
  check(
    "...but it cannot be resumed: a meeting that has ended does not reopen the microphone",
    nextRecorderState("stopped", "resume") === "stopped",
  );

  // -- the function agrees with the table
  //
  // Driven over every state × action pair rather than the interesting ones,
  // because the table and the function are two statements of one fact and the
  // whole value of writing both down is that they can be compared.

  for (const state of RECORDER_STATES) {
    for (const action of ACTIONS) {
      const next = nextRecorderState(state, action);
      check(
        `${state} + ${action} lands on a real state`,
        RECORDER_STATES.includes(next),
      );
      check(
        `...and ${state} + ${action} is either a move the table allows or no move at all`,
        next === state || RECORDER_TRANSITIONS[state].includes(next),
      );
    }
  }

  // -- totality and idempotence

  check("start from idle records", nextRecorderState("idle", "start") === "recording");
  check("start twice is still recording", nextRecorderState("recording", "start") === "recording");
  check(
    "start on a paused recorder records, because that is what the button says",
    nextRecorderState("paused", "start") === "recording",
  );
  check("pause a recording pauses it", nextRecorderState("recording", "pause") === "paused");
  check("pause twice is still paused", nextRecorderState("paused", "pause") === "paused");
  check(
    "pausing something that is not recording changes nothing",
    nextRecorderState("idle", "pause") === "idle" &&
      nextRecorderState("stopped", "pause") === "stopped",
  );
  check("resume a paused recorder records", nextRecorderState("paused", "resume") === "recording");
  check(
    "resuming something already recording changes nothing",
    nextRecorderState("recording", "resume") === "recording",
  );
  check(
    "stop always stops, from every state, including one that never started",
    RECORDER_STATES.every((state) => nextRecorderState(state, "stop") === "stopped"),
  );
  check(
    "an action nobody defined leaves the state alone rather than throwing",
    (() => {
      // Inside a `try` because the failure being checked for *is* a throw, and
      // an uncaught one takes the whole suite with it — which reports zero
      // failures rather than one. A check whose failure mode is a crash is a
      // check that reports nothing.
      try {
        return nextRecorderState("recording", /** @type {never} */ ("wiretap")) === "recording";
      } catch {
        return false;
      }
    })(),
  );

  // -- what "capturing" means, in one place

  check("only recording is capturing", isRecorderCapturing("recording"));
  check(
    "...and paused is not — the tray dot and the screen chip must agree",
    !isRecorderCapturing("paused"),
  );
  check(
    "...nor idle, nor stopped",
    !isRecorderCapturing("idle") && !isRecorderCapturing("stopped"),
  );
}
