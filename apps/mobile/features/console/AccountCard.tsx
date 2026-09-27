import type { ReactNode } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";

import { PressRow } from "../design/components/Button";
import { Icon } from "../design/components/Icon";
import { Text } from "../design/components/Text";
import { MARGIN } from "../design/components/popoverPlacement";
import { radii, space } from "../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../design/theme";
import { Avatar } from "./AccountBlock";

/**
 * The card the account button opens: who you are, then the workspaces, then
 * what you can do. Discord's shape: it rises from the button at the foot of
 * the sidebar rather than dropping from the title bar.
 *
 * Presentation only. `SwitcherMenu` decides which rows exist and under which
 * conditions; this draws whatever it is handed, so the list cannot fork
 * between two surfaces.
 *
 * A `Modal` rather than `Menu`'s popover, because the popover is a list of
 * 28px text rows sized by arithmetic over their labels, and this card has a
 * header and workspace marks that arithmetic does not know about. The modal
 * gives the same dismissal a menu has: a press outside, Escape on the web
 * (react-native-web's `Modal` routes it to `onRequestClose`), and Back on
 * Android.
 */
export interface AccountCardRow {
  id: string;
  label: string;
  /** Spoken instead of `label`, when the row shows more than its words — a dot. */
  accessibilityLabel?: string;
  /** Quiet text after the label: "yours" on your own workspace. */
  detail?: string;
  /** A workspace's mark, or an icon. */
  leading?: ReactNode;
  /** A tick at the trailing edge: the workspace you are in. */
  checked?: boolean;
  danger?: boolean;
  testID: string;
}

export interface AccountCardSection {
  key: string;
  rows: AccountCardRow[];
}

/** The trigger's box in window coordinates, measured when it was pressed. */
export interface AccountCardAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Never narrower than this, however narrow the sidebar was dragged. */
export const CARD_MIN_WIDTH = 260;
/** The gap between the card and the button it came from. */
const LIFT = 6;

export type CardBox =
  | { left: number; width: number; maxHeight: number; bottom: number }
  | { left: number; width: number; maxHeight: number; top: number };

/**
 * Where the card goes: its left edge on the trigger's, at least as wide as the
 * trigger, pulled back inside the window when either side would clip.
 *
 * It rises from the button, which is where the product puts it — the bottom
 * left. A trigger in the top half of the window (a fixture's strip, a short
 * window) opens it downward instead, because a card that rose from there would
 * have nowhere to go.
 *
 * Pure so it can be checked without a renderer: every branch is a window edge.
 */
export function cardPlacement(
  anchor: AccountCardAnchor,
  view: { width: number; height: number },
): CardBox {
  const width = Math.min(Math.max(CARD_MIN_WIDTH, anchor.width), view.width - MARGIN * 2);
  const left = Math.max(MARGIN, Math.min(anchor.x, view.width - MARGIN - width));
  const room = (space: number) => Math.max(0, space - LIFT - MARGIN);
  const above = room(anchor.y);
  const below = room(view.height - anchor.y - anchor.height);
  if (above >= below) {
    return { left, width, maxHeight: above, bottom: view.height - anchor.y + LIFT };
  }
  return { left, width, maxHeight: below, top: anchor.y + anchor.height + LIFT };
}

export function AccountCard({
  anchor,
  name,
  detail,
  initial,
  sections,
  onSelect,
  onDismiss,
}: {
  anchor: AccountCardAnchor;
  name: string;
  detail?: string;
  initial: string;
  sections: AccountCardSection[];
  onSelect: (id: string) => void;
  onDismiss: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const view = useWindowDimensions();
  const box = cardPlacement(anchor, view);

  return (
    <Modal transparent visible animationType="none" onRequestClose={onDismiss}>
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={onDismiss}
        accessibilityLabel="Close account menu"
        testID="account-card-scrim"
      />
      <View
        role="menu"
        aria-label="Account"
        style={[styles.card, box]}
        testID="account-card"
      >
        <View style={styles.header}>
          <Avatar initial={initial} size={36} />
          <View style={styles.headerText}>
            <Text variant="rowTitle" numberOfLines={1}>
              {name}
            </Text>
            {detail ? (
              <Text variant="treeMeta" numberOfLines={1}>
                {detail}
              </Text>
            ) : null}
          </View>
        </View>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.sections}>
          {sections
            .filter((section) => section.rows.length > 0)
            .map((section) => (
              <View key={section.key} style={styles.section}>
                {section.rows.map((row) => (
                  <PressRow
                    key={row.id}
                    accessibilityLabel={row.accessibilityLabel ?? row.label}
                    onPress={() => onSelect(row.id)}
                    radius={radii.sm}
                    style={styles.row}
                    hoverStyle={styles.rowHover}
                    ariaChecked={row.checked}
                    testID={row.testID}
                  >
                    {row.leading === undefined ? null : (
                      <View style={styles.leading}>{row.leading}</View>
                    )}
                    <Text
                      variant="rowTitle"
                      numberOfLines={1}
                      style={[styles.label, row.danger ? styles.danger : null]}
                    >
                      {row.label}
                    </Text>
                    {row.detail === undefined ? null : (
                      <Text variant="treeMeta" numberOfLines={1}>
                        {row.detail}
                      </Text>
                    )}
                    {row.checked ? (
                      <View style={styles.check}>
                        <Icon name="check" size={14} color={colors.accentText} />
                      </View>
                    ) : null}
                  </PressRow>
                ))}
              </View>
            ))}
        </ScrollView>
      </View>
    </Modal>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    /**
     * `surface3` with `lineStrong`, the popover's own material, so the card
     * reads as the same kind of object every other menu here is.
     */
    card: {
      position: "absolute",
      padding: space.x2,
      gap: space.x2,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.xl,
      backgroundColor: colors.surface3,
      boxShadow: "0 24px 60px -18px rgba(0,0,0,.9)",
      overflow: "hidden",
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      paddingHorizontal: space.x2,
      paddingVertical: space.x2,
    },
    headerText: { flex: 1, minWidth: 0, gap: 2 },
    scroll: { flexGrow: 0, flexShrink: 1 },
    sections: { gap: space.x2 },
    /** Each group is its own inset panel, Discord's grouping. */
    section: {
      padding: space.x1,
      borderRadius: radii.md,
      backgroundColor: colors.surface2,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      minHeight: 34,
      paddingHorizontal: space.x2,
      paddingVertical: space.x1,
    },
    rowHover: { backgroundColor: colors.surface3 },
    leading: { width: 18, alignItems: "center", justifyContent: "center" },
    label: { flexShrink: 1 },
    danger: { color: colors.critText },
    check: { marginLeft: "auto" },
  });
