/**
 * THE SHARED NUMBERS — `src/layout.ts`.
 *
 * Three constants, and what is worth checking about them is exactly what would
 * make the two sides drift: the values, and that they are the *same* values
 * read from the *one* place rather than copies either side could edit alone.
 *
 * The one that is not just a number is `SHELL_TRAFFIC_LIGHTS.y`. It centres a
 * 12pt button in `SHELL_TITLE_BAND_PX`, and it has to, because the shell sets
 * `trafficLightPosition` once at window creation while the page's layout goes
 * on changing under it — see the header of `src/layout.ts`. So the relation is
 * asserted here as a relation, not as the literal `16`: a change to the band's
 * height that forgets the buttons fails this file rather than shipping the
 * buttons 3pt high in a taller bar.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are FAIL lines across the
 * whole package suite.
 *
 *   `SHELL_TITLE_BAND_PX` changed to 38 (its old value)        2
 *   `SHELL_TRAFFIC_LIGHTS` not frozen                          1
 *   `SHELL_TRAFFIC_LIGHTS.y` left at 12                        1
 *   `SHELL_TITLE_BAND_LEAD_PX` narrower than the buttons need  1
 */

/** A macOS traffic-light button, for the centring check below. */
const BUTTON_PX = 12;

export function runLayoutChecks(
  check,
  { SHELL_TITLE_BAND_PX, SHELL_TITLE_BAND_LEAD_PX, SHELL_TRAFFIC_LIGHTS },
) {
  check("SHELL_TITLE_BAND_PX is 45 — the console top bar's own height", SHELL_TITLE_BAND_PX === 45);
  check(
    "SHELL_TRAFFIC_LIGHTS is { x: 12, y: 16 }",
    SHELL_TRAFFIC_LIGHTS.x === 12 && SHELL_TRAFFIC_LIGHTS.y === 16,
  );
  check(
    "y centres a button in the band, so one position serves band and bar alike",
    SHELL_TRAFFIC_LIGHTS.y === Math.floor((SHELL_TITLE_BAND_PX - BUTTON_PX) / 2),
  );
  check("SHELL_TITLE_BAND_LEAD_PX is 84", SHELL_TITLE_BAND_LEAD_PX === 84);
  check(
    "the lead clears three buttons and their gaps, with air after the last",
    SHELL_TITLE_BAND_LEAD_PX > SHELL_TRAFFIC_LIGHTS.x + BUTTON_PX * 3 + 8 * 2,
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
