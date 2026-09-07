/**
 * `src/recovery.js` — the pure rule behind "a meeting stuck on Finalizing for
 * two hours".
 *
 * `checkFinalizeTimeout` never touches a clock: `now` is always an argument,
 * so the ten-minute bound is a handful of checks that run in a millisecond
 * rather than a session left recording for the length of the suite.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted, counts measured against this file.
 *
 *   the `state !== "finalizing"` guard removed                                2
 *   `elapsed < timeoutMs` flipped to `<=`                                     3
 *   the `retriedAt` branch removed (every stale sighting says "retry")        5
 *   the "still within its own retry window" guard removed
 *     (a session already retried is failed immediately)                      2
 */

import { FINALIZE_TIMEOUT_MS, checkFinalizeTimeout } from "../src/recovery.js";
import { attempt } from "./fixtures.mjs";

const T0 = Date.parse("2026-09-07T10:00:00.000Z");

export function runRecoveryChecks(check) {
  check("the default bound is ten minutes", FINALIZE_TIMEOUT_MS === 10 * 60 * 1000);

  check(
    "a session not finalizing at all is left alone, however old endedAt is",
    checkFinalizeTimeout({ state: "recording", endedAt: new Date(T0 - 999_999).toISOString() }, T0).action === "none"
  );
  check(
    "a complete session is left alone too",
    checkFinalizeTimeout({ state: "complete", endedAt: new Date(T0 - 999_999).toISOString() }, T0).action === "none"
  );

  const justEnded = { state: "finalizing", endedAt: new Date(T0).toISOString() };
  check(
    "a session that just started finalizing is left alone",
    checkFinalizeTimeout(justEnded, T0).action === "none"
  );
  check(
    "...and stays alone right up to the bound",
    checkFinalizeTimeout(justEnded, T0 + FINALIZE_TIMEOUT_MS - 1).action === "none"
  );

  check(
    "at the bound, exactly, a first sighting is told to retry",
    checkFinalizeTimeout(justEnded, T0 + FINALIZE_TIMEOUT_MS).action === "retry"
  );
  check(
    "...and says why, in a sentence naming the bound",
    checkFinalizeTimeout(justEnded, T0 + FINALIZE_TIMEOUT_MS).reason?.includes("10 minutes")
  );
  check(
    "well past the bound with no prior retry, it is still just a retry — never a fail on the first sighting",
    checkFinalizeTimeout(justEnded, T0 + FINALIZE_TIMEOUT_MS * 50).action === "retry"
  );

  const retriedAt = T0 + FINALIZE_TIMEOUT_MS;
  check(
    "immediately after the one retry, it is left alone — the retry has not had its own window yet",
    checkFinalizeTimeout(justEnded, retriedAt + 1, { retriedAt }).action === "none"
  );
  check(
    "...right up to a full timeout window past the retry",
    checkFinalizeTimeout(justEnded, retriedAt + FINALIZE_TIMEOUT_MS - 1, { retriedAt }).action === "none"
  );
  check(
    "a full timeout window past the retry, still finalizing, is told to fail",
    checkFinalizeTimeout(justEnded, retriedAt + FINALIZE_TIMEOUT_MS, { retriedAt }).action === "fail"
  );
  check(
    "...with a reason mentioning the retry",
    checkFinalizeTimeout(justEnded, retriedAt + FINALIZE_TIMEOUT_MS, { retriedAt }).reason?.includes("retry")
  );
  check(
    "it never asks to retry a second time — one retry, then fail",
    checkFinalizeTimeout(justEnded, retriedAt + FINALIZE_TIMEOUT_MS * 10, { retriedAt }).action === "fail"
  );

  check(
    "a custom bound is honoured",
    checkFinalizeTimeout(justEnded, T0 + 4_999, { timeoutMs: 5_000 }).action === "none" &&
      checkFinalizeTimeout(justEnded, T0 + 5_000, { timeoutMs: 5_000 }).action === "retry"
  );

  check(
    "a session whose endedAt will not parse is left alone rather than failed for the wrong reason",
    checkFinalizeTimeout({ state: "finalizing", endedAt: "not a date" }, T0 + FINALIZE_TIMEOUT_MS * 5).action === "none"
  );
  check(
    "...and the same for a session with no endedAt at all",
    checkFinalizeTimeout({ state: "finalizing", endedAt: null }, T0 + FINALIZE_TIMEOUT_MS * 5).action === "none"
  );
  check(
    "a missing session is left alone rather than thrown on",
    attempt(() => checkFinalizeTimeout(null, T0)).threw === false &&
      checkFinalizeTimeout(null, T0).action === "none"
  );
}
