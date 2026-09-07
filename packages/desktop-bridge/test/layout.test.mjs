/**
 * THE SHARED NUMBERS — `src/layout.ts`.
 *
 * Two constants, and what is worth checking about them is exactly what would
 * make the two sides drift: the value, and that it is the *same* value read
 * from the *one* place rather than a copy either side could edit alone.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are FAIL lines across the
 * whole package suite.
 *
 *   `SHELL_TITLE_BAND_PX` changed to a different number     1
 *   `SHELL_TRAFFIC_LIGHTS` not frozen                        1
 *   `SHELL_TRAFFIC_LIGHTS.x` or `.y` changed                 1
 */

export function runLayoutChecks(check, { SHELL_TITLE_BAND_PX, SHELL_TRAFFIC_LIGHTS }) {
  check("SHELL_TITLE_BAND_PX is 38", SHELL_TITLE_BAND_PX === 38);
  check(
    "SHELL_TRAFFIC_LIGHTS is { x: 12, y: 12 }",
    SHELL_TRAFFIC_LIGHTS.x === 12 && SHELL_TRAFFIC_LIGHTS.y === 12,
  );
  try {
    SHELL_TRAFFIC_LIGHTS.x = 999;
  } catch {
    // A frozen object throws in strict mode, which module code is. Either
    // way, the check below is what matters.
  }
  check(
    "SHELL_TRAFFIC_LIGHTS is frozen — neither side can edit the other's copy",
    SHELL_TRAFFIC_LIGHTS.x === 12,
  );
}
