import type { ReactNode } from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import { leading } from "../tokens";
import { useThemedStyles, type Colors } from "../theme";
import { Text } from "./Text";

/**
 * A short titled statement: a mono key over a sentence of plain English.
 *
 * Lifted verbatim out of `onboarding/steps/DoneStep.tsx`, where four of them
 * explain `index.md`, `privacy.md`, plain Markdown, and revoking a key. The
 * invitation screen needs the same shape for a different six sentences, and two
 * copies of a visual treatment drift — the mono title in `colors.codeKey` is
 * the one thing making these read as facts rather than as body copy, and it is
 * three lines of style that nothing else in the design system carries.
 *
 * `trailing` is the only addition, and it exists for a real case rather than
 * for generality: one fact on the overview describes something that does not
 * exist yet, and a `Pill` beside the title is how this app already says so.
 */
export function Fact({
  title,
  body,
  trailing,
  style,
  testID,
}: {
  title: string;
  body: string;
  /** Rendered on the title row, e.g. a `<Pill>coming soon</Pill>`. */
  trailing?: ReactNode;
  style?: ViewStyle;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={[styles.fact, style]} testID={testID}>
      <View style={styles.head}>
        <Text variant="mono" style={styles.title}>
          {title}
        </Text>
        {trailing}
      </View>
      <Text variant="rowSub" style={styles.body}>
        {body}
      </Text>
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  fact: { gap: 3 },
  // A row rather than the bare `Text` it used to be, so a trailing pill sits
  // beside the title instead of pushing the body down. `flexWrap` keeps a long
  // title and its pill readable in a 390px column.
  head: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  title: { color: colors.codeKey },
  body: { lineHeight: leading(12.5, 1.7) },
});
