import { Pressable, StyleSheet, View } from "react-native";
import { PressRow } from "../../design/components/Button";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { fonts, radii, space, touchType } from "../../design/tokens";
import { type Colors, useColors, useThemedStyles } from "../../design/theme";
import { makeStyles as explorerStyles } from "../files/explorer/styles";
import { trashCopy } from "./trashCopy";
import { useTrashRoute, type TrashRoute } from "./TrashRouteContext";

/**
 * The sidebar's Trash row, at the foot of the tree (board A1), opening the page
 * where a note would be. Pressed again, it closes. No count: the row is drawn on
 * every console, and asking the server for the trash on each would be a query
 * per window for a number few look at; the page says it when opened.
 */
export function TrashTreeLine() {
  const route = useTrashRoute();
  return route === undefined ? null : <TreeLine route={route} />;
}

function TreeLine({ route }: { route: TrashRoute }) {
  const colors = useColors();
  const ex = useThemedStyles(explorerStyles);
  return (
    <PressRow
      accessibilityLabel={trashCopy.heading}
      onPress={route.open ? route.closeTrash : route.openTrash}
      selected={route.open}
      radius={radii.sm}
      style={StyleSheet.flatten([ex.foot, ex.footPress])}
      hoverStyle={ex.matchHover}
      selectedStyle={ex.matchHover}
      testID="explorer-trash"
    >
      <Icon name="trash" size={12} color={colors.chromeMuted} />
      <Text variant="treeMeta" numberOfLines={1} style={ex.footGrow}>
        {trashCopy.heading}
      </Text>
    </PressRow>
  );
}

/** A phone's Trash row, last on Home (board A4), in a card of its own. */
export function TrashHomeLine() {
  const route = useTrashRoute();
  return route === undefined ? null : <HomeLine route={route} />;
}

function HomeLine({ route }: { route: TrashRoute }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  return (
    <View style={styles.card}>
      <Pressable
        onPress={route.openTrash}
        accessibilityRole="button"
        accessibilityLabel={trashCopy.heading}
        style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
        testID="phone-home-trash"
      >
        <Icon name="trash" size={20} color={colors.muted} />
        <Text style={styles.label} numberOfLines={1}>
          {trashCopy.heading}
        </Text>
        <Icon name="chevronRight" size={16} color={colors.muted} />
      </Pressable>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    card: { backgroundColor: colors.cardSurface, borderRadius: radii.sheet, overflow: "hidden" },
    row: { flexDirection: "row", alignItems: "center", gap: space.x3, minHeight: 52, paddingHorizontal: space.x4, paddingVertical: space.x3 },
    rowPressed: { backgroundColor: colors.rowSelected },
    label: { flex: 1, fontFamily: fonts.body, fontSize: touchType.ui, color: colors.text },
  });
