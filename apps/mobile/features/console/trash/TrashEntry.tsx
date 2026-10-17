import { StyleSheet } from "react-native";
import { PressRow } from "../../design/components/Button";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { radii } from "../../design/tokens";
import { useColors, useThemedStyles } from "../../design/theme";
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
