import { Platform, StyleSheet, View, type ViewStyle } from "react-native";
import { getDesktopBridge, SHELL_TITLE_BAND_PX } from "@context/desktop-bridge";
import { useColors } from "../design/theme";
import { shouldShowShellTitleBand } from "./shellTitleBand";

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
export function ShellTitleBand() {
  const colors = useColors();
  const bridge = Platform.OS === "web" ? getDesktopBridge() : null;

  if (!shouldShowShellTitleBand(Platform.OS, bridge?.shell?.platform ?? null)) return null;

  return (
    <View
      testID="shell-title-band"
      style={[styles.band, { backgroundColor: colors.surface2 }]}
    />
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
