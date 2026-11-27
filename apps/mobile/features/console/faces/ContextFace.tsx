/**
 * Context itself as a mail sender: the app icon's drawn hash on its cream tile, in place of the generic robot (Dev,
 * 2026-11-27, of the "Context" setup checks in Agent Mail: "can we use the context logo or something here"). Drawn,
 * not a picture, so it is sharp at every size; the strokes are the icon's own (`assets/source/favicon.svg`), each
 * reduced to its ends and middle.
 */

import { StyleSheet, View } from "react-native";
import { G, Path, Svg } from "react-native-svg";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";

/** The name Context signs its own mail with (`apps/mcp/src/mail/footer.js` and the setup checks): `context`. */
export const CONTEXT_SENDER = "context";

/** Whether a mail line is Context's own: sent as `context`, signed by no app or by Context. */
export function isContextSender(name: string, app: string | null | undefined): boolean {
  return name.toLowerCase() === CONTEXT_SENDER && (app === null || app === undefined || app.trim().toLowerCase() === "context");
}

/** The icon's four strokes, in its own coordinates (its 256 tile is the group's transform). */
const STROKES = [
  "M296 190.8 Q269.8 420 248 569.2",
  "M431.6 190.8 Q406 380 385.7 569.2",
  "M177.2 315.4 Q353 322 529.2 321",
  "M150.8 449.3 Q326.8 456 502.8 446.6",
];

export function ContextFace({ size }: { size: number }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  return (
    <View style={[styles.tile, { width: size, height: size, borderRadius: Math.min(7, Math.round(size / 4)) }]} testID="owner-face-context" aria-hidden>
      <Svg width={size} height={size} viewBox="0 0 256 256">
        <G transform="translate(-34.13 -53.21) scale(0.47686)" fill="none" stroke={colors.contextMark} strokeLinecap="round" strokeLinejoin="round" strokeWidth={45}>
          {STROKES.map((d) => (
            <Path key={d} d={d} />
          ))}
        </G>
      </Svg>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    tile: { alignItems: "center", justifyContent: "center", backgroundColor: colors.contextTile, overflow: "hidden" },
  });
