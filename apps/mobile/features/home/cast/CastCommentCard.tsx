import { StyleSheet, Text, View } from "react-native";
import { useColors, useTheme } from "../../design/theme";
import { pointerType, radii, space } from "../../design/tokens";
import type { CastSaid } from "./castRun";

/**
 * A scene's latest comment, as a card in Context's window on a phone.
 *
 * The console shows comments in the margin beside a note, and a phone has no
 * margin: there a thread opens as a sheet when the reader taps its words,
 * and the cast never raises one on its own (a sheet over half the screen took
 * the page from a reader who had not asked, Dev2 2026-09-28). In a phone's
 * recording, though, "we cant see comments" (Dev2, 2026-09-30), so the words
 * of the comment come up here, over the foot of the note, as the approved
 * artboard drew them: who said it, what about, and what they said.
 */
export function CastCommentCard({ said, badge }: { said: CastSaid; badge?: string }) {
  const colors = useColors();
  const { shadows } = useTheme();
  return (
    <View
      style={[styles.card, { backgroundColor: colors.pageSurface, boxShadow: shadows.window }]}
      role="status"
      testID="cast-comment-card"
    >
      <View style={[styles.badge, { backgroundColor: badge ?? colors.muted }]} />
      <View style={styles.words}>
        <Text style={[styles.head, { color: colors.text }]} numberOfLines={1}>
          {said.who}
          <Text style={[styles.about, { color: colors.muted }]}>{` on “${said.quote}”`}</Text>
        </Text>
        <Text style={[styles.text, { color: said.resolved ? colors.muted : colors.text }]} numberOfLines={3}>
          {said.resolved ? "Resolved" : said.text}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    position: "absolute",
    left: space.x3,
    right: space.x3,
    bottom: space.x3,
    flexDirection: "row",
    gap: space.x2,
    padding: space.x3,
    borderRadius: radii.console,
  },
  badge: { width: 24, height: 24, borderRadius: 7 },
  words: { flex: 1, minWidth: 0, gap: 2 },
  head: { fontSize: pointerType.meta, fontWeight: "600" },
  about: { fontWeight: "400" },
  text: { fontSize: pointerType.ui, lineHeight: 20 },
});
