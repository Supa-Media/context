import { Pressable, StyleSheet, View, type GestureResponderEvent } from "react-native";
import { Icon, type IconName } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { fonts, layout, radii, space, touchType } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors, type Shadows } from "../../design/theme";
import type { SelectBar } from "./selectActions";

/**
 * The bottom bar while rows are picked on a phone's folder page (board 16):
 * Move, Tags, Pin and Archive, each with its word under it, and More for the
 * rest of what the tree's selection menu offers. Nothing is pressable with
 * nothing picked; a button these rows cannot take is dimmed in its place.
 */
export function SelectActionsBar({ bar }: { bar: SelectBar }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const none = bar.count === 0;
  const { move, tags, pin, archive, more } = bar.actions;
  const keys: { id: string; label: string; icon: IconName; run: ((event: GestureResponderEvent) => void) | undefined }[] = [
    { id: "move", label: "Move", icon: "folder", run: move },
    { id: "tags", label: "Tags", icon: "tag", run: tags },
    { id: "pin", label: pin?.pinned ? "Unpin" : "Pin", icon: "pin", run: pin?.run },
    { id: "archive", label: "Archive", icon: "archive", run: archive },
    {
      id: "more",
      label: "More",
      icon: "more",
      run: (event) => more({ x: event.nativeEvent.pageX, y: event.nativeEvent.pageY }),
    },
  ];
  return (
    <View style={styles.bar} role="toolbar" aria-label={`Actions for ${bar.count} selected`} testID="select-actions">
      {keys.map((key) => {
        const off = none || key.run === undefined;
        return (
          <Pressable
            key={key.id}
            onPress={off ? undefined : key.run}
            disabled={off}
            accessibilityRole="button"
            accessibilityState={{ disabled: off }}
            accessibilityLabel={key.label}
            style={({ pressed }) => [styles.key, pressed && !off ? styles.pressed : null]}
            testID={`select-${key.id}`}
          >
            <Icon name={key.icon} size={22} color={off ? colors.muted : colors.accent} />
            <Text style={[styles.label, off ? styles.off : null]}>{key.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const makeStyles = (colors: Colors, shadows: Shadows) =>
  StyleSheet.create({
    bar: {
      flexDirection: "row",
      alignItems: "center",
      height: layout.bottomBarHeight,
      marginHorizontal: space.x1,
      borderRadius: radii.sheet,
      backgroundColor: colors.pageSurface,
      boxShadow: shadows.floating,
    },
    key: {
      flex: 1,
      alignSelf: "stretch",
      alignItems: "center",
      justifyContent: "center",
      gap: 2,
      minHeight: layout.minTouchTarget,
      borderRadius: radii.md,
    },
    pressed: { backgroundColor: colors.surface2 },
    label: { fontFamily: fonts.body, fontSize: touchType.meta, color: colors.accent, fontWeight: "500" },
    off: { color: colors.muted },
  });
