/**
 * The incremental cursor: repair, never crash, never move backward.
 *
 * ## Sabotage record
 *
 * Measured by actually editing `src/core/imessage/cursor.ts` and reverting:
 *
 *   `advanceCursor`'s backward/non-integer guard removed entirely      3 FAIL
 */

import { EMPTY_CURSOR, advanceCursor, normalizeCursor } from "../src/core/imessage/cursor.ts";

export function runImessageCursorChecks(check) {
  check("EMPTY_CURSOR starts at zero", EMPTY_CURSOR.lastRowId === 0);

  check("a well-formed cursor round-trips", normalizeCursor({ version: 1, lastRowId: 42 }).lastRowId === 42);
  check("undefined repairs to empty", normalizeCursor(undefined).lastRowId === 0);
  check("null repairs to empty", normalizeCursor(null).lastRowId === 0);
  check("a string repairs to empty", normalizeCursor("garbage").lastRowId === 0);
  check("a future version repairs to empty rather than trusting an unknown shape", normalizeCursor({ version: 2, lastRowId: 42 }).lastRowId === 0);
  check("a negative lastRowId repairs to empty", normalizeCursor({ version: 1, lastRowId: -1 }).lastRowId === 0);
  check("a non-integer lastRowId repairs to empty", normalizeCursor({ version: 1, lastRowId: 1.5 }).lastRowId === 0);
  check("a string lastRowId repairs to empty", normalizeCursor({ version: 1, lastRowId: "42" }).lastRowId === 0);

  check("advancing past the current value moves it", advanceCursor(EMPTY_CURSOR, 10).lastRowId === 10);
  check("advancing to the same value is a no-op (same reference, so a caller can skip a write)", advanceCursor({ version: 1, lastRowId: 10 }, 10).lastRowId === 10);
  const current = { version: 1, lastRowId: 10 };
  check("advancing to a SMALLER value never moves the cursor backward", advanceCursor(current, 3) === current);
  check("advancing with a non-integer value never moves the cursor", advanceCursor(current, 3.5) === current);
  check("advancing with NaN never moves the cursor", advanceCursor(current, Number.NaN) === current);
}
