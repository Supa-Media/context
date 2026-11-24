/**
 * A footer's calculation, picked from a short list: None, Sum, Average, Min,
 * Max, Latest, Count. A view choice for this session, like sort and filter.
 */

import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "../../../design/components/Text";
import { radii, space } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import { Popover, type Anchor } from "./Popover";
import { CALCS, type CalcKind } from "./sheetModel";

export function CalcMenu({
  current,
  anchor,
  onPick,
  onClose,
}: {
  current: CalcKind;
  anchor: Anchor | null;
  onPick: (kind: CalcKind) => void;
  onClose: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  return (
    <Popover anchor={anchor} width={180} onDismiss={onClose} testID="sheet-calc-menu">
      <View style={styles.body}>
        {CALCS.map((kind) => (
          <Pressable
            key={kind}
            accessibilityRole="button"
            accessibilityState={{ selected: kind === current }}
            onPress={() => {
              onPick(kind);
              onClose();
            }}
            style={[styles.row, kind === current && { backgroundColor: colors.accentDim }]}
          >
            <Text variant="tree" style={kind === current ? styles.accent : styles.text}>
              {kind}
            </Text>
            {kind === current ? <Text variant="tree" style={styles.accent}>✓</Text> : null}
          </Pressable>
        ))}
      </View>
    </Popover>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    body: { padding: space.x1 },
    row: { height: 30, flexDirection: "row", alignItems: "center", paddingHorizontal: space.x2, borderRadius: radii.sm },
    text: { color: colors.text, flex: 1 },
    accent: { color: colors.accentText, flex: 1 },
  });
