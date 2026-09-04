import { StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { Button } from "../design/components/Button";
import { CenteredScroll } from "../design/components/CenteredScroll";
import { StageBackdrop } from "../design/components/StageBackdrop";
import { Text } from "../design/components/Text";
import { leading, radii } from "../design/tokens";
import { useThemedStyles, type Colors } from "../design/theme";
import { CONSOLE_ROUTE } from "../auth/redirect";

/**
 * A URL that named nothing.
 *
 * ## What it replaces
 *
 * Expo Router's built-in **Unmatched Route** screen, which is a development
 * aid that ships: it prints the path, offers "Go back", and says nothing a
 * person who followed a link from a chat could act on. On 2026-09-03 that is
 * what a `context://note/…` link from ChatGPT rendered on iOS — the app opened,
 * and the first thing the product ever said to somebody arriving from another
 * tool was a routing error.
 *
 * A `+not-found.tsx` at the root replaces it wholesale (`getNavigationConfig`
 * uses the built-in only when the app has not declared one), so this covers
 * every unmatched URL and not only note links: a typo'd path, a link from a
 * version of the app that had a route this one does not, an `https://` link
 * from a self-hoster's domain.
 *
 * ## Why it is a screen and not a redirect
 *
 * Because "we do not know what you asked for" and "here is your console" are
 * different sentences, and silently swapping the second for the first is how
 * somebody concludes their note is gone. The route above this one recovers
 * every URL that *is* a note address; anything reaching here has already failed
 * that, so the honest answer is to say so and offer the one destination that is
 * always meaningful.
 *
 * The path is **not** printed back. It is somebody's note name, it came from
 * outside, and echoing untrusted text into the UI buys nothing here — the
 * person can see their own address bar, and on a phone there is nothing they
 * could do with it.
 */
export function DeadLinkScreen({
  title = "That link did not go anywhere",
  detail = "The address does not match anything in this app. It may have been mistyped, or shortened by whatever you followed it from.",
}: {
  title?: string;
  detail?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();

  return (
    <View style={styles.ground} testID="dead-link">
      <StageBackdrop />
      <CenteredScroll>
        <View style={styles.wrap}>
          <Text variant="mark" style={styles.mark}>
            Context
            <Text variant="mark" style={styles.markSuffix}>
              .lc
            </Text>
          </Text>

          <Text role="heading" aria-level={1} style={styles.title}>
            {title}
          </Text>

          <Text variant="heroSub" style={styles.sub}>
            {detail}
          </Text>

          <View style={styles.note}>
            <Text variant="foot">
              Nothing has happened to your notes. They live in your own bucket, and this is only
              the app in front of them.
            </Text>
          </View>

          <View style={styles.actions}>
            <Button
              label="Go to your notes"
              variant="white"
              onPress={() => router.replace(CONSOLE_ROUTE)}
              testID="dead-link-console"
            />
          </View>
        </View>
      </CenteredScroll>
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  ground: { flex: 1, backgroundColor: colors.ground, overflow: "hidden" },
  wrap: {
    width: "100%",
    maxWidth: 520,
    marginHorizontal: "auto",
    paddingHorizontal: 28,
    paddingVertical: 48,
  },
  mark: { alignSelf: "flex-start", marginBottom: 30 },
  markSuffix: { color: colors.muted },
  title: {
    fontSize: 28,
    lineHeight: leading(28, 1.1),
    fontWeight: "500",
    color: colors.text,
  },
  sub: { marginTop: 14, fontSize: 15.5, lineHeight: leading(15.5, 1.55) },
  note: {
    marginTop: 22,
    paddingVertical: 12,
    paddingHorizontal: 15,
    borderRadius: radii.xl,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.well,
  },
  actions: { marginTop: 26, flexDirection: "row", alignItems: "center", gap: 16, flexWrap: "wrap" },
});
