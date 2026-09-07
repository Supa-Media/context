// A `finalizing` session has no timeout by construction: `MEETING_TRANSITIONS`
// says a session may sit there as long as it likes, because most of the time
// it is one HTTP request away from `complete`. That is exactly the property
// that turns a lost request into a session nobody can see finishing, or
// starting over — a client that crashed between queuing a finalize and
// receiving its answer leaves the gateway's own record in `finalizing`
// forever, and every badge that reads `state` alone reads it as still working.
//
// This file is the one rule every surface applies to that: pure, so a client
// and the gateway agree on when a stuck finalize stops being "still in
// progress" and starts being something to act on, and testable without
// holding a meeting for ten minutes.

/**
 * How long a session may sit in `finalizing` before a client should act on it.
 *
 * There is no existing "how long may a transcription take" budget in this
 * codebase to inherit — the nearest numbers are `SEGMENT_MS` (twenty seconds,
 * one rotation) and the cloud transcription rate limit's one-minute window,
 * neither of which bounds how long an entire *meeting* may take to finalize.
 * Ten minutes is chosen directly: comfortably longer than an enhancement pass
 * over even a long transcript, and short enough that "stuck for two hours"
 * — the defect this file exists to close — is caught on the first check after
 * the meeting actually finished, not the fortieth.
 */
export const FINALIZE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * @typedef {Object} FinalizeRecoveryAction
 * @property {"none"|"retry"|"fail"} action
 * @property {string} [reason]  Present exactly when `action` is `"fail"` —
 *   what a `fail` event's `reason` should say.
 */

/**
 * What a client should do about a session that may have been `finalizing` for
 * too long.
 *
 * **Retry once, then fail — never fail on the first sighting and never retry
 * forever.** A session just past the bound might be one slow request away from
 * `complete`, so the first time this is asked it says `retry`: re-send the
 * finalize (the audio segments and notes are already on the record, so this
 * costs one request, not the meeting). If it is *still* `finalizing` a full
 * timeout window after that retry was attempted, retrying again is indistinguishable
 * from retrying forever — which is the defect this function exists to close —
 * so it says `fail` instead, and a client folds that into a `fail` event the
 * badge can show as "Failed — <reason>" with a Retry a person presses.
 *
 * Callers hold `retriedAt` themselves — nothing here is written back into the
 * session by this function — because it is bookkeeping about a client's *own*
 * previous call to this function, not a fact about the meeting. A gateway
 * record has no room for it and does not need one: `endedAt` alone is enough
 * for every session to agree on how long it has been finalizing.
 *
 * @param {{state: import("./protocol.js").MeetingState, endedAt: string|null}} session
 * @param {number} now  Epoch milliseconds. An argument, never `Date.now()`
 *   read inside — the same discipline every other pure function in this
 *   package follows, and the only way a ten-minute bound is a test that runs
 *   in a millisecond.
 * @param {{timeoutMs?: number, retriedAt?: number|null}} [options]
 * @returns {FinalizeRecoveryAction}
 */
export function checkFinalizeTimeout(session, now, options = {}) {
  if (!session || session.state !== "finalizing") return { action: "none" };

  const timeoutMs = options.timeoutMs ?? FINALIZE_TIMEOUT_MS;
  const startedFinalizingAt =
    typeof session.endedAt === "string" ? Date.parse(session.endedAt) : NaN;
  // A session whose `endedAt` will not parse — hand-edited, or from a client
  // this contract has never heard of — has no honest age. Doing nothing is the
  // only answer that does not eventually fail a session for a reason that has
  // nothing to do with whether it is stuck.
  if (!Number.isFinite(startedFinalizingAt)) return { action: "none" };

  const elapsed = now - startedFinalizingAt;
  if (elapsed < timeoutMs) return { action: "none" };

  const retriedAt = typeof options.retriedAt === "number" ? options.retriedAt : null;
  if (retriedAt === null) {
    return {
      action: "retry",
      reason: `finalize did not complete within ${minutesOf(timeoutMs)}`,
    };
  }
  if (now - retriedAt < timeoutMs) {
    // The one retry this function grants is still within its own window.
    // Nothing to do yet — this is not a second sighting.
    return { action: "none" };
  }
  return {
    action: "fail",
    reason: `finalize still had not completed ${minutesOf(timeoutMs)} after a retry`,
  };
}

/** `"10 minutes"` / `"1 minute"`, for a sentence a person reads. */
function minutesOf(ms) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}
