import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "../../../design/components/Text";
import { radii, space } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";

/**
 * "Page | Text" over a `.page.md` note: the page is the default, the text is
 * the same file in the editor, for anything the page cannot change in place
 * (a block's settings, the front matter, a box's code).
 */
export function PageToggle({ asText, onChange, gutter }: { asText: boolean; onChange: (asText: boolean) => void; gutter: number }) {
  const styles = useThemedStyles(stylesFor);
  const option = (label: string, text: boolean) => {
    const on = asText === text;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: on }}
        onPress={() => onChange(text)}
        style={[styles.option, on ? styles.on : null]}
      >
        <Text variant="meta" style={on ? styles.onText : styles.offText}>
          {label}
        </Text>
      </Pressable>
    );
  };
  return (
    <View style={[styles.row, { marginHorizontal: gutter }]}>
      <View style={styles.segments}>
        {option("Page", false)}
        {option("Text", true)}
      </View>
    </View>
  );
}

const stylesFor = (colors: Colors) =>
  StyleSheet.create({
    row: { flexDirection: "row", justifyContent: "flex-end", paddingVertical: space.x2 },
    segments: { flexDirection: "row", backgroundColor: colors.chipFill, borderRadius: radii.sm, padding: 2 },
    option: { paddingHorizontal: space.x3, paddingVertical: space.x1, borderRadius: radii.sm },
    on: { backgroundColor: colors.surface },
    onText: { color: colors.text },
    offText: { color: colors.muted },
  });
