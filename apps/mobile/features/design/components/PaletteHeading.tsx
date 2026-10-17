import { View } from "react-native";
import { useThemedStyles } from "../theme";
import { makeStyles } from "./PaletteStyles";
import { Text } from "./Text";

/** The untyped list's heading ("Recent"), with its small print beside it when there is any. */
export function PaletteHeading({ heading, note }: { heading: string; note?: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.headingRow}>
      <Text variant="eyebrow" style={styles.heading} testID="palette-heading">
        {heading}
      </Text>
      {note === undefined ? null : (
        <Text variant="rowSub" numberOfLines={1} style={styles.headingNote} testID="palette-heading-note">
          {note}
        </Text>
      )}
    </View>
  );
}
