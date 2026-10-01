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
 *
 * A `ghost` is the comment before, faded behind the latest (Dev2, 2026-10-01:
 * "at least see one other previous comment in a ghost state"). Placed by
 * `CastPhoneComments`; a draft shows the words typed so far and a caret.
 */
export function CastCommentCard({ said, badge, ghost = false }: { said: CastSaid; badge?: string; ghost?: boolean }) {
  const colors = useColors();
  const { shadows } = useTheme();
  return (
    <View
      style={[styles.card, ghost ? styles.ghost : null, { backgroundColor: colors.pageSurface, boxShadow: shadows.window }]}
      role={ghost ? undefined : "status"}
      testID={ghost ? "cast-comment-ghost" : "cast-comment-card"}
    >
      {/* A ghost fades its words, never its card: the note must not show through. */}
      <View style={[styles.badge, ghost ? styles.faded : null, { backgroundColor: badge ?? colors.muted }]} />
      <View style={[styles.words, ghost ? styles.faded : null]}>
        <Text style={[styles.head, { color: colors.text }]} numberOfLines={1}>
          {said.who}
          <Text style={[styles.about, { color: colors.muted }]}>{` on “${said.quote}”`}</Text>
        </Text>
        <Text style={[styles.text, { color: said.resolved ? colors.muted : colors.text }]} numberOfLines={3}>
          {said.resolved ? "Resolved" : said.text}
          {said.draft === true ? <Text style={{ color: badge ?? colors.text }}>|</Text> : null}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    gap: space.x2,
    padding: space.x3,
    borderRadius: radii.console,
  },
  ghost: { transform: [{ scale: 0.96 }] },
  faded: { opacity: 0.42 },
  badge: { width: 24, height: 24, borderRadius: 7 },
  words: { flex: 1, minWidth: 0, gap: 2 },
  head: { fontSize: pointerType.meta, fontWeight: "600" },
  about: { fontWeight: "400" },
  text: { fontSize: pointerType.ui, lineHeight: 20 },
});
