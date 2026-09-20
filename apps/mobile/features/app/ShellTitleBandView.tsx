import { Platform, StyleSheet, View, type ViewStyle } from "react-native";
import {
  getDesktopBridge,
  SHELL_TITLE_BAND_LEAD_PX,
  SHELL_TITLE_BAND_PX,
} from "@context/desktop-bridge";
import { useColors } from "../design/theme";
import {
  shellBandDraws,
  shellLightsLeadPx,
  shellTitleBandPx,
  shouldShowShellTitleBand,
} from "./shellTitleBand";
import { useTopChromeHoldsLights } from "./topChrome";

/**
 * The band that keeps the desktop shell's traffic lights off the console's
 * own content.
 *
 * Mounted once, in `app/_layout.tsx`, above every route — the sign-in group
 * and the console alike, and the offline mirror `apps/desktop` serves from
 * disk, because all three are the same web bundle. See `shellTitleBand.ts` for
 * the rule this draws and `docs/decisions/desktop.md`, "The console reserves
 * the space", for why the reservation lives here rather than in the shell.
 *
 * ## What it draws, and what it deliberately does not
 *
 * A full-width, `SHELL_TITLE_BAND_PX`-tall strip in the console header's own
 * colour, in normal document flow — not `position: "absolute"` — so it pushes
 * everything below it down rather than floating over it. That is also the
 * whole answer to "must not eat clicks meant for content": there is no
 * content *under* this element to intercept a press from, because nothing
 * else occupies the space it takes.
 *
 * It renders nothing itself besides the strip — no buttons, no label. The
 * traffic lights are native OS chrome the **shell** draws at
 * `SHELL_TRAFFIC_LIGHTS`, inside this band, in a separate change to
 * `apps/desktop`; this side's job is only to reserve the pixels.
 *
 * `WebkitAppRegion: "drag"` is the same escape hatch `AppFrame.tsx` uses for
 * `cursor: "col-resize"`: React Native's `ViewStyle` has no name for a
 * property that only means something on the web, so it is asserted through
 * rather than typed. **If this band ever grows an interactive child**
 * (a control drawn on top of it), that child must set
 * `WebkitAppRegion: "no-drag"` on itself — otherwise a click on it moves the
 * window instead of activating it. Nothing here does yet, which is why there
 * is no such override to see.
 */
export function ShellTitleBand({ color }: { color?: string } = {}) {
  const colors = useColors();
  const bridge = Platform.OS === "web" ? getDesktopBridge() : null;

  if (!shouldShowShellTitleBand(Platform.OS, bridge?.shell?.platform ?? null)) return null;

  return (
    <View
      testID="shell-title-band"
      style={[styles.band, { backgroundColor: color ?? colors.surface2 }]}
    />
  );
}

/**
 * The same reservation as a number, for the two surfaces that cannot use the
 * band itself: the app frame, which is sized in viewport units, and anything
 * inside a `Modal`, which is its own root and sits above the band.
 *
 * A hook only because reading the bridge is a web-only global; it has no
 * state and never changes within a session — the shell a page is hosted by
 * does not change under it.
 */
export function useShellTitleBandPx(): number {
  const bridge = Platform.OS === "web" ? getDesktopBridge() : null;
  return shellTitleBandPx(Platform.OS, bridge?.shell?.platform ?? null, SHELL_TITLE_BAND_PX);
}

/**
 * The band mounted at the root, which stands down when a route holds the
 * lights in its own chrome.
 *
 * **This is the only caller that may read the handshake**, and the split into
 * two components is how that is enforced rather than remembered. `Overlay`
 * renders `ShellTitleBand` above, unconditionally, because a `Modal` is its
 * own root and the console frame *behind* it goes on publishing "I hold them"
 * for as long as settings is open — an overlay that consulted the flag would
 * put the buttons back over its own first control, which is exactly the defect
 * `docs/decisions/desktop.md` records under "The band's other two payers".
 *
 * `app/_layout.tsx` mounts this one. See `topChrome.ts` for the handshake.
 */
export function RootShellTitleBand() {
  const holdsLights = useTopChromeHoldsLights();
  const bridge = Platform.OS === "web" ? getDesktopBridge() : null;

  if (!shellBandDraws(Platform.OS, bridge?.shell?.platform ?? null, holdsLights)) return null;
  return <ShellTitleBand />;
}

/**
 * How much band is drawn *above* a frame that may itself be holding the
 * lights — the inset `viewportHeight` has to subtract.
 *
 * Not the same question as `useShellTitleBandPx`, and the difference is the
 * whole point: a frame that took the job has nothing above it, so it is one
 * whole viewport tall again and the 45pt goes back to the note list. A frame
 * that did not — the phone layout, an ordinary browser tab — pays exactly what
 * it paid before.
 */
export function useShellBandAbovePx(chromeHoldsLights: boolean): number {
  const bandPx = useShellTitleBandPx();
  return chromeHoldsLights ? 0 : bandPx;
}

/**
 * The leading inset a bar owes when it is the thing holding the buttons.
 *
 * Zero in an ordinary browser tab, zero on a phone, zero at compact density
 * inside the shell — see `shellLightsLeadPx`, which is where that rule lives
 * so it can be tested without a bridge or a rendered tree.
 */
export function useShellLightsLeadPx(chromeHoldsLights: boolean): number {
  const bridge = Platform.OS === "web" ? getDesktopBridge() : null;
  return shellLightsLeadPx(
    Platform.OS,
    bridge?.shell?.platform ?? null,
    chromeHoldsLights,
    SHELL_TITLE_BAND_LEAD_PX,
  );
}

const styles = StyleSheet.create({
  band: {
    width: "100%",
    height: SHELL_TITLE_BAND_PX,
    flexShrink: 0,
    ...({ WebkitAppRegion: "drag" } as unknown as ViewStyle),
  },
});
