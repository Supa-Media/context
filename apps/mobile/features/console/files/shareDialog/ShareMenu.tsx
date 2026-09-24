import type { ReactNode } from "react";
import { Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import { PressRow } from "../../../design/components/Button";
import { Icon } from "../../../design/components/Icon";
import type { IconName } from "../../../design/components/icons/names";
import { Text } from "../../../design/components/Text";
import { fonts, leading, pointerType, radii, touchType } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";

/** Where a menu hangs from, in window coordinates. */
export interface MenuAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ShareMenuItem {
  id: string;
  label: string;
  detail?: string;
  icon?: IconName;
  /** Radio items: `true` draws the tick, `false` reserves its gutter. */
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
  testID?: string;
  onPress: () => void;
}

const WIDTH = 320;
const GAP = 6;

/**
 * A menu that belongs to the share dialog.
 *
 * Drawn inside the dialog's own `Modal` rather than through the app's `Menu`:
 * that one portals to the page (or opens a second native modal), and a
 * popover over a modal is either painted underneath it on the web or is the
 * modal-over-modal iOS gets wrong. Here it is a sibling of the card in one
 * tree, so it layers correctly everywhere and closes with the dialog.
 *
 * A popover under its trigger on a pointer layout; a sheet from the bottom
 * edge on a phone, with the item it is about as its title and a Cancel row,
 * the same two presentations `Menu` has.
 */
export function ShareMenu({
  items,
  anchor,
  compact,
  title,
  onClose,
  testID,
  children,
}: {
  items: readonly ShareMenuItem[];
  anchor: MenuAnchor | null;
  compact: boolean;
  title?: string;
  onClose: () => void;
  testID?: string;
  /** Extra content drawn after the items, e.g. the encryption row. */
  children?: ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const view = useWindowDimensions();
  // A host that could not measure answers zeros; that is "not measured yet".
  const at = anchor !== null && (anchor.width > 0 || anchor.height > 0) ? anchor : null;

  const rows = items.map((item) => (
    <View key={item.id}>
      {item.separatorBefore ? <View aria-hidden style={styles.separator} /> : null}
      <PressRow
        accessibilityLabel={item.label}
        ariaChecked={item.checked}
        onPress={
          item.disabled
            ? undefined
            : () => {
                onClose();
                item.onPress();
              }
        }
        radius={radii.md}
        testID={item.testID ?? `share-menu-${item.id}`}
        style={StyleSheet.flatten([
          styles.item,
          compact && styles.itemCompact,
          item.disabled && styles.itemOff,
        ])}
        hoverStyle={styles.itemHover}
      >
        {item.checked === undefined ? null : (
          <View style={styles.gutter}>
            {item.checked ? <Icon name="check" size={16} color={colors.accent} /> : null}
          </View>
        )}
        {item.icon === undefined ? null : (
          <View style={styles.gutter}>
            <Icon name={item.icon} size={16} color={item.danger ? colors.crit : colors.muted} />
          </View>
        )}
        <View style={styles.labels}>
          <Text style={[styles.label, compact && styles.labelCompact, item.danger && styles.labelDanger]}>
            {item.label}
          </Text>
          {item.detail === undefined ? null : (
            <Text variant="meta" style={[styles.detail, compact && styles.detailCompact]}>
              {item.detail}
            </Text>
          )}
        </View>
      </PressRow>
    </View>
  ));

  if (compact) {
    return (
      <View style={styles.layer} testID={testID}>
        <Pressable style={styles.sheetScrim} accessibilityLabel="Close menu" onPress={onClose} />
        <View style={styles.sheet} role="menu">
          {title === undefined ? null : (
            <Text variant="meta" style={styles.sheetTitle} numberOfLines={1}>
              {title}
            </Text>
          )}
          {rows}
          {children}
          <PressRow
            accessibilityLabel="Cancel"
            onPress={onClose}
            radius={radii.md}
            style={styles.cancel}
            hoverStyle={styles.itemHover}
          >
            <Text style={[styles.label, styles.labelCompact, styles.cancelLabel]}>Cancel</Text>
          </PressRow>
        </View>
      </View>
    );
  }

  /*
    Right-aligned to the trigger, which is where every trigger here sits, and
    flipped above it when there is no room below. Until the trigger has been
    measured the menu sits in the card's top-right corner: it answers the press
    at once rather than a frame later, and it moves at most once.
  */
  const width = Math.min(WIDTH, view.width - 32);
  const left =
    at === null
      ? Math.max(16, (view.width - width) / 2)
      : Math.min(Math.max(16, at.x + at.width - width), view.width - width - 16);
  const below = at === null ? view.height * 0.2 : at.y + at.height + GAP;
  const roomBelow = view.height - below;
  const position =
    at !== null && roomBelow < 220
      ? { bottom: view.height - at.y + GAP }
      : { top: below };

  return (
    <View style={styles.layer} testID={testID}>
      <Pressable style={styles.clickAway} accessibilityLabel="Close menu" onPress={onClose} />
      <View style={[styles.popover, { left, width }, position]} role="menu">
        {rows}
        {children}
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  layer: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 10 },
  clickAway: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
  popover: {
    position: "absolute",
    padding: 6,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    boxShadow: "0 16px 40px -12px rgba(26,23,20,.30)",
  },
  sheetScrim: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.scrim,
  },
  sheet: {
    position: "absolute",
    left: 8,
    right: 8,
    bottom: 30,
    padding: 8,
    borderRadius: radii.floating - 4,
    backgroundColor: colors.surface,
    boxShadow: "0 20px 50px -10px rgba(26,23,20,.40)",
  },
  sheetTitle: {
    textAlign: "center",
    paddingTop: 6,
    paddingBottom: 10,
    marginBottom: 4,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  item: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  itemCompact: { paddingVertical: 12, paddingHorizontal: 12 },
  itemHover: { backgroundColor: colors.surface2 },
  itemOff: { opacity: 0.5 },
  gutter: { width: 16, paddingTop: 2, alignItems: "center" },
  labels: { flexGrow: 1, flexShrink: 1, minWidth: 0, gap: 2 },
  label: {
    fontFamily: fonts.body,
    fontSize: pointerType.ui,
    lineHeight: leading(pointerType.ui, 1.45),
    fontWeight: "500",
    color: colors.text,
  },
  labelCompact: { fontSize: touchType.lede, lineHeight: leading(touchType.lede, 1.35) },
  labelDanger: { color: colors.critText },
  detail: { color: colors.muted },
  detailCompact: { fontSize: pointerType.ui },
  separator: { height: 1, backgroundColor: colors.line, marginVertical: 5, marginHorizontal: 4 },
  cancel: {
    marginTop: 6,
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  cancelLabel: { fontWeight: "600", textAlign: "center" },
});
