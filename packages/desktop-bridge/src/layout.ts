/**
 * SHARED LAYOUT NUMBERS FOR THE CONSOLE'S TOP BAND.
 *
 * `docs/decisions/desktop.md`, "The console reserves the space", is the
 * argument; this file is the two numbers it turns on. The console window is
 * frameless with inset traffic lights (`titleBarStyle: "hiddenInset"` in
 * `apps/desktop/src/main/windows.ts`), and the hosted page draws from `x: 0` —
 * so without a reservation, the close/minimise/zoom buttons sit on top of the
 * console's own top-left content.
 *
 * The fix is split the same way the rest of this contract is: **the page owns
 * its layout, the shell owns the buttons' position.** Neither side may guess
 * the other's number, so both import it from here rather than each hard-coding
 * `38` or `{ x: 12, y: 12 }` and drifting the day one of them changes.
 *
 *  - `apps/mobile` reads `SHELL_TITLE_BAND_PX` to reserve a top band on
 *    macOS, inside the shell, on web only — see `features/app/ShellTitleBand`.
 *  - `apps/desktop` reads `SHELL_TRAFFIC_LIGHTS` to position the native
 *    traffic-light buttons (`BrowserWindow`'s `trafficLightPosition`) inside
 *    that band, in the follow-up PR that wires the shell side.
 *
 * Neither number is part of `DesktopBridge` — they are not asked for at
 * runtime, they are compiled into both bundles — so adding or changing them
 * is not a `BRIDGE_VERSION` change.
 */

/** The band's height in points/pixels. Matches Chrome's own traffic-light row. */
export const SHELL_TITLE_BAND_PX = 38;

/** Where in the band the shell places the traffic lights, in the same units. */
export interface ShellTrafficLightsPosition {
  x: number;
  y: number;
}

export const SHELL_TRAFFIC_LIGHTS: Readonly<ShellTrafficLightsPosition> = Object.freeze({
  x: 12,
  y: 12,
});
