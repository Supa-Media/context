import { StyleSheet, View } from "react-native";
import { useColors } from "../../design/theme";

/**
 * The five bars that mean "this is live".
 *
 * Drawn from `View`s for the reason `features/design/components/Icon.tsx`
 * gives — a glyph is 17px wide in one face and 10.6 in another — and kept here
 * rather than added to `ICON_NAMES` because that set's own rule is "add an icon
 * when a control needs it, in the same change as the control", and this is not
 * an icon: it is a state, drawn at two sizes, in two tones, with a fixed
 * silhouette.
 *
 * **The heights are fixed and it does not animate.** The mockup shows a static
 * profile and that is what ships, for three reasons that all point the same
 * way. A bar chart driven by the microphone's level is a second, continuous
 * source of re-renders on the one screen whose entire promise is that nothing
 * moves while you type. It would also be a lie in this build, where nothing is
 * listening (see `capture/`). And a meter that responds to sound is a
 * *capability claim*: somebody watching it flatten would reasonably conclude
 * the room had gone quiet rather than that the app was drawing a decoration.
 *
 * `paused` dims it rather than replacing it, because the shape is what carries
 * "this is a recording" and swapping in a different mark for two seconds of
 * pause makes the bar flicker between two identities.
 */
export function Waveform({
  tone = "ok",
  size = 16,
  paused = false,
}: {
  /** `ok` while recording, `muted` when paused or when nothing is listening. */
  tone?: "ok" | "muted";
  /** The tallest bar, in points. The rest are fractions of it. */
  size?: number;
  paused?: boolean;
}) {
  const colors = useColors();
  const color = tone === "ok" ? colors.ok : colors.muted;
  // Fractions of `size`, so the silhouette is the same at every size — the
  // property `icons.test.ts` asserts of every drawing in the icon set.
  const fractions = [0.375, 0.8125, 0.5625, 1, 0.4375];

  return (
    <View style={[styles.row, { height: size }]} aria-hidden>
      {fractions.map((fraction, index) => (
        <View
          key={index}
          style={[
            styles.bar,
            {
              height: Math.max(2, Math.round(size * fraction)),
              backgroundColor: color,
              opacity: paused ? 0.45 : 1,
            },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "flex-end", gap: 2.5 },
  bar: { width: 2.5, borderRadius: 2 },
});
