import { StyleSheet, View } from "react-native";
import { Text } from "../design/components/Text";
import { leading, pointerType as t, radii, space } from "../design/tokens";
import { useThemedStyles, type Colors } from "../design/theme";

/**
 * The line above a setup somebody left and has just been brought back to.
 *
 * Says why they are here rather than in the console — without it, signing in
 * and landing on "Step 2 of 4" reads like the account was reset — and offers
 * the way out on the same line. Skipping is a real answer: `onboarding/resume.ts`
 * does not ask again until the next sign-in.
 */
export function ResumeNotice({ slug, onLater }: { slug: string | null; onLater: () => void }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.notice} testID="welcome-resume">
      <Text style={styles.text}>
        {slug === null ? "Your name is claimed" : `@${slug} is yours`}, but it has nowhere to keep
        notes yet. Pick up where you left off.
      </Text>
      <Text role="link" style={styles.later} onPress={onLater} testID="welcome-resume-later">
        I'll do this later
      </Text>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    notice: {
      marginBottom: space.x5,
      borderRadius: radii.card,
      backgroundColor: colors.hintWash,
      paddingVertical: space.x3,
      paddingHorizontal: space.x4,
      gap: space.x2,
    },
    text: { fontSize: t.ui, lineHeight: leading(t.ui, 1.5), color: colors.text },
    later: {
      alignSelf: "flex-start",
      fontSize: t.ui,
      fontWeight: "600",
      color: colors.accent,
      textDecorationLine: "underline",
    },
  });
