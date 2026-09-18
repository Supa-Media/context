/**
 * SHARED LAYOUT NUMBERS FOR THE CONSOLE'S TOP BAND.
 *
 * `docs/decisions/desktop.md`, "The console reserves the space", is the
 * argument; this file is the numbers it turns on. The console window is
 * frameless with inset traffic lights (`titleBarStyle: "hiddenInset"` in
 * `apps/desktop/src/main/windows.ts`), and the hosted page draws from `x: 0` —
 * so without a reservation, the close/minimise/zoom buttons sit on top of the
 * console's own top-left content.
 *
 * The fix is split the same way the rest of this contract is: **the page owns
 * its layout, the shell owns the buttons' position.** Neither side may guess
 * the other's number, so both import them from here rather than each
 * hard-coding `45` or `{ x: 12, y: 16 }` and drifting the day one of them
 * changes.
 *
 *  - `apps/mobile` reads `SHELL_TITLE_BAND_PX` to reserve a top band on
 *    macOS, inside the shell, on web only — see `features/app/ShellTitleBand`.
 *  - `apps/mobile` reads `SHELL_TITLE_BAND_LEAD_PX` when its own top bar holds
 *    the lights instead of a band above it — see `features/app/topChrome.ts`.
 *  - `apps/desktop` reads `SHELL_TRAFFIC_LIGHTS` to position the native
 *    traffic-light buttons (`BrowserWindow`'s `trafficLightPosition`) inside
 *    whichever of the two is drawn.
 *
 * None of them is part of `DesktopBridge` — they are not asked for at
 * runtime, they are compiled into both bundles — so adding or changing them
 * is not a `BRIDGE_VERSION` change.
 *
 * ## Why the band's height is the top bar's height
 *
 * **`trafficLightPosition` is set once, when the window is created, and the
 * page's layout is not.** A person can narrow the console until it is a phone
 * layout and widen it again, and the buttons do not move when they do. So the
 * two containers that can hold the lights — the root band, and the console's
 * own top bar once it takes the job — cannot have two different heights with
 * one `y` centring the buttons in both. Either the shell learns to move them
 * at runtime (a bridge call, a `BRIDGE_VERSION`, and a round trip on every
 * resize), or **the two boxes are the same height and the question does not
 * arise.**
 *
 * They are the same height. `SHELL_TITLE_BAND_PX` is 45 because
 * `apps/mobile`'s `layout.topBarHeight` is 45 — a touch target plus its
 * hairline — and `appFrame.test.ts` asserts that equality from the app's side
 * so the two cannot drift apart silently. The band was 38 while it was the
 * only box there was; matching the bar cost seven points on the sign-in screen
 * and in settings, which draw nothing in it either way, and bought a single
 * `y` that is correct wherever the buttons land.
 */

/**
 * The height of the box the traffic lights sit in, in points/pixels.
 *
 * Equal to `apps/mobile`'s `layout.topBarHeight` — see the header for why that
 * equality is load-bearing rather than a coincidence, and `appFrame.test.ts`
 * for the assertion that keeps it.
 */
export const SHELL_TITLE_BAND_PX = 45;

/**
 * How much room the buttons need at the leading edge of a bar that holds them.
 *
 * `SHELL_TRAFFIC_LIGHTS.x` (12) plus three 12pt buttons with 8pt between them
 * (52) is 64; the remaining 20 is the air between the last button and the
 * first thing the console puts in its own bar. **Not a new measurement**: the
 * shell's own notepad window has run a 45pt bar at `padding-left: 84px` since
 * it was written (`apps/desktop/src/renderer/notepad.css`), which is where
 * this number comes from and why it is 84 rather than a rounder guess.
 *
 * A band that draws nothing pays this at `x` only, which is why it is a
 * separate constant from the band's height rather than a second field on it.
 */
export const SHELL_TITLE_BAND_LEAD_PX = 84;

/** Where in the band the shell places the traffic lights, in the same units. */
export interface ShellTrafficLightsPosition {
  x: number;
  y: number;
}

/**
 * `y` centres a 12pt button in `SHELL_TITLE_BAND_PX`: `(45 - 12) / 2`, floored.
 * It is a literal rather than that expression because `apps/desktop` reads this
 * object at window creation and a derived value would invite one side to
 * re-derive it from its own idea of the button's size.
 */
export const SHELL_TRAFFIC_LIGHTS: Readonly<ShellTrafficLightsPosition> = Object.freeze({
  x: 12,
  y: 16,
});
