/**
 * A bot's helper (a Claude Code session it started): the helper's own mark with its bot's face at the corner, the
 * way `ClaudeFace` carries the face of the person whose Claude it is. The corner says who it works for, so "Claude
 * via Grok Bot" reads as Claude's tile with Grok Bot's logo on it, and never as a bare Claude. A helper that isn't
 * Claude is the agent tile (the robot) with the same corner. Below 24 the corner is left off, as `ClaudeFace` does;
 * the name beside it still says "via".
 */

import { StyleSheet, View } from "react-native";
import { useThemedStyles, type Colors } from "../../design/theme";
import { ClaudeFace, isClaudeApp } from "./ClaudeFace";
import { OwnerFace, type Face } from "../files/folderPage/Glyphs";

const BADGE_FROM = 24;

export function HelperFace({ helper, via, size, dim = false }: { helper: string; via: Face; size: number; dim?: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const badge = Math.max(12, Math.round(size * 0.46));
  return (
    <View style={[{ width: size, height: size }, dim && styles.dim]} testID="helper-face" aria-hidden>
      {isClaudeApp(helper) ? <ClaudeFace owner={null} size={size} /> : <OwnerFace face={{ kind: "agent" }} size={size} />}
      {size >= BADGE_FROM ? (
        <View style={[styles.badge, { right: -4, bottom: -4, borderRadius: Math.round(badge / 3.2) + 2 }]} testID="helper-face-bot">
          <OwnerFace face={via} size={badge} />
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    badge: { position: "absolute", borderWidth: 2, borderColor: colors.pageSurface, backgroundColor: colors.pageSurface, overflow: "hidden" },
    dim: { opacity: 0.55 },
  });
