import { useEffect, useRef, useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { PressRow } from "../design/components/Button";
import { Text } from "../design/components/Text";
import { radii, space } from "../design/tokens";
import { useThemedStyles, type Colors } from "../design/theme";
import { contextMenuItems } from "./contextMenu";
import type { ConsoleRoute } from "./nav";

/**
 * The right-click menu on a rail context, in two pieces.
 *
 * `RightClickTarget` exists because react-native-web strips props it does not
 * know, and `onContextMenu` is one of them — the same lesson as the paste
 * handler in PR #504: reach the real DOM node through the ref and attach the
 * native listener yourself. On native there is no DOM node and no
 * `addEventListener`, so the effect quietly does nothing and the wrapper is
 * just a View.
 *
 * The menu renders *inside* the wrapper, absolutely positioned under the row,
 * rather than in an overlay at the cursor: no portal machinery, no viewport
 * math, and the menu is anchored to the thing it is about — which is also
 * where a keyboard or screen-reader user will find themselves when it opens.
 *
 * Dismissal is the standard pair: any pointer-down outside, or Escape. Both
 * listeners live on `document` only while the menu is open.
 */
export function RightClickTarget({
  onOpenMenu,
  children,
}: {
  onOpenMenu: () => void;
  children: ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  const ref = useRef<View>(null);
  useEffect(() => {
    const node = ref.current as unknown as HTMLElement | null;
    if (!node || typeof node.addEventListener !== "function") return;
    const listener = (event: Event) => {
      event.preventDefault();
      onOpenMenu();
    };
    node.addEventListener("contextmenu", listener);
    return () => node.removeEventListener("contextmenu", listener);
  }, [onOpenMenu]);
  return (
    <View ref={ref} collapsable={false} style={styles.target}>
      {children}
    </View>
  );
}

export function ContextRowMenu({
  slug,
  shared = false,
  onSelect,
  onLeave,
  onDismiss,
}: {
  slug: string;
  /** True under "Shared with you" — the only place Leave is offered. */
  shared?: boolean;
  /** Receives the chosen destination; closing is the caller's move. */
  onSelect: (route: ConsoleRoute) => void;
  /**
   * Fires on the SECOND press of Leave. Leaving is recoverable only by being
   * re-invited, so the first press turns the row into its own confirmation
   * instead of acting — a dialog's worth of caution without a dialog.
   */
  onLeave?: () => void;
  onDismiss: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const ref = useRef<View>(null);
  useEffect(() => {
    if (typeof document === "undefined") return;
    const node = ref.current as unknown as HTMLElement | null;
    const onPointerDown = (event: Event) => {
      if (node && event.target instanceof Node && node.contains(event.target)) return;
      onDismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onDismiss]);

  const [confirmingLeave, setConfirmingLeave] = useState(false);

  return (
    <View ref={ref} style={styles.menu} accessibilityRole="menu" testID="context-menu">
      {contextMenuItems(slug, { shared }).map((item) => {
        if (item.key === "leave") {
          const label = confirmingLeave ? "Press again to leave" : item.label;
          return (
            <PressRow
              key={item.key}
              accessibilityLabel={label}
              onPress={() => {
                if (!confirmingLeave) {
                  setConfirmingLeave(true);
                  return;
                }
                onLeave?.();
              }}
              radius={radii.sm}
              style={styles.item}
              hoverStyle={styles.itemHover}
              testID="context-menu-leave"
            >
              <Text variant="rail" numberOfLines={1} style={styles.leaveLabel}>
                {label}
              </Text>
            </PressRow>
          );
        }
        return (
          <PressRow
            key={item.key}
            accessibilityLabel={item.label}
            onPress={() => onSelect(item.route!)}
            radius={radii.sm}
            style={styles.item}
            hoverStyle={styles.itemHover}
            testID={`context-menu-${item.key}`}
          >
            <Text variant="rail" numberOfLines={1}>
              {item.label}
            </Text>
          </PressRow>
        );
      })}
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  /** The anchor. `position: relative` is what `top: 100%` below measures from. */
  target: { position: "relative", alignSelf: "stretch" },
  menu: {
    position: "absolute",
    top: "100%",
    left: space.x2,
    right: space.x2,
    zIndex: 30,
    marginTop: 2,
    paddingVertical: 4,
    paddingHorizontal: 4,
    gap: 2,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.surface2,
    // The rail scrolls behind it; without a shadow the menu reads as one more
    // row rather than a layer above them.
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
  },
  item: {
    paddingVertical: 6,
    paddingHorizontal: 9,
    borderRadius: radii.sm,
  },
  itemHover: { backgroundColor: colors.surface3 },
  /** Leave severs access; it reads as the one destructive row it is. */
  leaveLabel: { color: colors.critText },
});
