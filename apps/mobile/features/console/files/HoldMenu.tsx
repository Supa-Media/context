import { useEffect, useRef } from "react";
import { Animated, Modal, Platform, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "../../design/components/Icon";
import type { IconName } from "../../design/components/icons/names";
import { Text } from "../../design/components/Text";
import { motion, radii, space } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { useReducedMotion } from "../../design/useReducedMotion";
import type { HoldLayout, HoldPreview } from "./holdLayout";
import { liftTap } from "./liftTap";
import type { MenuActionId, MenuItem } from "./menu";

const GLYPH: Partial<Record<MenuActionId, IconName>> = {
  share: "share",
  moveTo: "folder",
  delete: "trash",
  restore: "undo",
  pin: "pin",
  unpin: "pin",
  rename: "pencil",
  duplicate: "copy",
  newNote: "plus",
  setIcon: "smile",
};

/** How wide the menu under the preview is: Apple's, near enough. */
const MENU_WIDTH = 260;

/**
 * Press and hold on a phone row, as Apple Notes does it (the owner's board,
 * 2026-10-16): the page blurs, the note or folder lifts as a card, and a
 * short menu sits under it. Tapping the card opens what it shows; tapping
 * anywhere else puts it back. What the menu offers is `holdLayout`'s
 * arrangement of the row menu's own items, so nothing here decides a verb.
 */
export function HoldMenu({
  preview,
  layout,
  onOpen,
  onSelectMany,
  onRun,
  onMore,
  onDismiss,
}: {
  preview: HoldPreview;
  layout: HoldLayout;
  onOpen: () => void;
  /** Start picking several, with this row picked. Absent where there is nothing to pick among. */
  onSelectMany?: () => void;
  onRun: (id: MenuActionId) => void;
  /** The rest of the row menu, as today's sheet. Absent when there is no rest. */
  onMore?: () => void;
  onDismiss: () => void;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const reduced = useReducedMotion();
  const shown = useRef(new Animated.Value(0)).current;

  // The little tap a finger feels on iPhone as the row lifts (the owner, 2026-10-16).
  useEffect(liftTap, []);
  useEffect(() => {
    if (reduced) {
      shown.setValue(1);
      return;
    }
    Animated.timing(shown, {
      toValue: 1,
      duration: motion.layoutMs,
      useNativeDriver: Platform.OS !== "web",
    }).start();
  }, [reduced, shown]);

  const run = (id: MenuActionId) => {
    onDismiss();
    onRun(id);
  };
  const lift = {
    opacity: shown,
    transform: [{ scale: shown.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }) }],
  };

  return (
    <Modal transparent visible animationType="none" onRequestClose={onDismiss}>
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: shown }]}>
        <View style={[StyleSheet.absoluteFill, styles.scrim]} />
      </Animated.View>
      <Pressable style={StyleSheet.absoluteFill} accessibilityLabel="Close" onPress={onDismiss} testID="hold-menu-scrim">
        <ScrollView
          contentContainerStyle={[styles.content, { paddingTop: insets.top + space.x4, paddingBottom: insets.bottom + space.x4 }]}
        >
          <Animated.View style={lift}>
            <Pressable
              onPress={() => {
                onDismiss();
                onOpen();
              }}
              accessibilityRole="button"
              accessibilityLabel={`Open ${preview.title}`}
              style={[styles.card, { maxHeight: Math.max(220, height * 0.42) }]}
              testID="hold-menu-preview"
            >
              <PreviewBody preview={preview} styles={styles} colors={colors} />
            </Pressable>
          </Animated.View>

          <Animated.View style={[styles.menu, lift]} testID="hold-menu">
            {layout.top.length === 0 ? null : (
              <View style={styles.top}>
                {layout.top.map((item) => (
                  <TopKey key={item.id} item={item} onPress={() => run(item.id)} styles={styles} colors={colors} />
                ))}
              </View>
            )}
            {layout.main.map((item, index) => (
              <Line
                key={item.id}
                label={item.label}
                icon={GLYPH[item.id] ?? "more"}
                ruled={index > 0}
                onPress={() => run(item.id)}
                testID={`hold-menu-${item.id}`}
                styles={styles}
                colors={colors}
              />
            ))}
            {onSelectMany === undefined ? null : (
              <>
                <View style={styles.gap} />
                <Line
                  label="Select"
                  icon="check"
                  onPress={() => {
                    onDismiss();
                    onSelectMany();
                  }}
                  testID="hold-menu-select"
                  styles={styles}
                  colors={colors}
                />
              </>
            )}
            {onMore === undefined ? null : (
              <>
                <View style={styles.gap} />
                <Line
                  label="More"
                  icon="more"
                  trailing
                  onPress={onMore}
                  testID="hold-menu-more"
                  styles={styles}
                  colors={colors}
                />
              </>
            )}
          </Animated.View>
        </ScrollView>
      </Pressable>
    </Modal>
  );
}

type Styles = ReturnType<typeof makeStyles>;

function PreviewBody({ preview, styles, colors }: { preview: HoldPreview; styles: Styles; colors: Colors }) {
  if (preview.kind === "note") {
    return (
      <>
        <Text variant="noteTitle" numberOfLines={2} style={styles.title}>
          {preview.title}
        </Text>
        {preview.meta === null ? null : (
          <Text variant="rowSub" numberOfLines={1} style={styles.meta}>
            {preview.meta}
          </Text>
        )}
        {preview.text === null ? null : (
          <Text variant="body" numberOfLines={9} style={styles.text}>
            {preview.text}
          </Text>
        )}
      </>
    );
  }
  return (
    <>
      <View style={styles.folderHead}>
        <Icon name="folder" size={22} color={colors.accent} />
        <Text variant="noteTitle" numberOfLines={1} style={[styles.title, styles.folderTitle]}>
          {preview.title}
        </Text>
      </View>
      <Text variant="rowSub" numberOfLines={1} style={styles.meta}>
        {preview.meta}
      </Text>
      {preview.notes.map((note) => (
        <View key={note.path} style={styles.folderNote}>
          <Text variant="rowTitle" numberOfLines={1} style={styles.noteName}>
            {note.title}
          </Text>
          {note.text === null ? null : (
            <Text variant="rowSub" numberOfLines={1} style={styles.meta}>
              {note.text}
            </Text>
          )}
        </View>
      ))}
    </>
  );
}

function TopKey({
  item,
  onPress,
  styles,
  colors,
}: {
  item: MenuItem;
  onPress: () => void;
  styles: Styles;
  colors: Colors;
}) {
  const danger = item.id === "delete";
  const tint = danger ? colors.critText : colors.text;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={item.label}
      style={({ pressed }) => [styles.topKey, pressed && styles.pressed]}
      testID={`hold-menu-${item.id}`}
    >
      <Icon name={GLYPH[item.id] ?? "more"} size={22} color={tint} />
      <Text variant="rowSub" style={{ color: tint }}>
        {item.label}
      </Text>
    </Pressable>
  );
}

function Line({
  label,
  icon,
  ruled = false,
  trailing = false,
  onPress,
  testID,
  styles,
  colors,
}: {
  label: string;
  icon: IconName;
  ruled?: boolean;
  trailing?: boolean;
  onPress: () => void;
  testID: string;
  styles: Styles;
  colors: Colors;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.line, ruled && styles.ruled, pressed && styles.pressed]}
      testID={testID}
    >
      <Icon name={icon} size={18} color={colors.text} />
      <Text variant="body" style={styles.lineLabel}>
        {label}
      </Text>
      {trailing ? <Icon name="chevronRight" size={16} color={colors.muted} /> : null}
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    scrim: { backgroundColor: colors.scrim },
    content: { paddingHorizontal: space.x5, gap: space.x3, flexGrow: 1 },
    card: {
      backgroundColor: colors.pageSurface,
      borderRadius: 22,
      padding: space.x5,
      overflow: "hidden",
      boxShadow: "0 20px 60px rgba(0,0,0,0.45)",
    },
    title: { color: colors.text },
    meta: { color: colors.muted, marginTop: 2 },
    text: { color: colors.text2, marginTop: space.x3, lineHeight: 22 },
    folderHead: { flexDirection: "row", alignItems: "center", gap: space.x2 },
    folderTitle: { flexShrink: 1 },
    folderNote: {
      marginTop: space.x3,
      paddingTop: space.x3,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.line,
    },
    noteName: { color: colors.text },
    menu: {
      width: MENU_WIDTH,
      alignSelf: "center",
      backgroundColor: colors.surface3,
      borderRadius: radii.floating,
      overflow: "hidden",
      boxShadow: "0 16px 50px rgba(0,0,0,0.4)",
    },
    top: {
      flexDirection: "row",
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.lineStrong,
    },
    topKey: { flex: 1, alignItems: "center", gap: 4, paddingVertical: space.x3, minHeight: 64 },
    line: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      paddingHorizontal: space.x4,
      minHeight: 46,
    },
    ruled: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
    lineLabel: { flex: 1, color: colors.text },
    gap: { height: 7, backgroundColor: colors.line },
    pressed: { backgroundColor: colors.chromePressed },
  });
