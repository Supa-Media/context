/**
 * An agent that signs its mail as Claude: Claude Code's own mark, the orange pixel creature, on a warm tile, with a
 * small face of the person whose Claude it is at its corner (Dev, 2026-11-26: "a lot of mail from claude does not have
 * the actual claude logo, or who's claude, we should use the claude code logo and then maybe a sub logo of the person
 * who's claude it is"). Drawn, not a picture, so it is sharp at every size and needs no read.
 */

import { StyleSheet, View } from "react-native";
import { Rect, Svg } from "react-native-svg";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { PersonFace } from "./PersonFace";

/** Claude Code's mark. */
export const CLAUDE_ORANGE = "#D97757";

/** Whether a mail line's app is Claude (Claude Code, Claude, claude.ai), so its sender is drawn as Claude. */
export function isClaudeApp(app: string | null | undefined): boolean {
  return typeof app === "string" && /\bclaude\b/i.test(app);
}

/** The smallest tile that carries its owner's face; a smaller one is the mark alone. */
const OWNER_FROM = 24;

export function ClaudeFace({ owner, size }: { owner: string | null; size: number }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const badge = Math.max(12, Math.round(size * 0.44));
  return (
    <View style={{ width: size, height: size }} testID="owner-face-claude" aria-hidden>
      <View style={[styles.tile, { width: size, height: size, borderRadius: Math.min(7, Math.round(size / 4)) }]}>
        <Svg width={size * 0.74} height={size * 0.74} viewBox="0 0 447 447">
          <Rect x={56} y={93} width={334} height={225} fill={CLAUDE_ORANGE} />
          <Rect x={0} y={205} width={447} height={57} fill={CLAUDE_ORANGE} />
          {[84, 140, 280, 336].map((x) => (
            <Rect key={x} x={x} y={318} width={27} height={54} fill={CLAUDE_ORANGE} />
          ))}
          <Rect x={112} y={150} width={27} height={53} fill={colors.claudeTile} />
          <Rect x={308} y={150} width={27} height={53} fill={colors.claudeTile} />
        </Svg>
      </View>
      {owner !== null && size >= OWNER_FROM ? (
        <View style={[styles.badge, { right: -3, bottom: -3, borderRadius: badge }]} testID="owner-face-claude-owner">
          <PersonFace name={owner} size={badge} />
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    tile: { alignItems: "center", justifyContent: "center", backgroundColor: colors.claudeTile, overflow: "hidden" },
    badge: { position: "absolute", borderWidth: 2, borderColor: colors.pageSurface, overflow: "hidden" },
  });
