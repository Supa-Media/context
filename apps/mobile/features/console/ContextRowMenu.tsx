import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { PressRow } from "../design/components/Button";
import { Text } from "../design/components/Text";
import { radii, space } from "../design/tokens";
import { useThemedStyles, type Colors } from "../design/theme";
import { contextMenuItems } from "./contextMenu";
import type { ConsoleRoute } from "./nav";

/**
 * The per-context menu, opened by a long press on the phone's context strip.
 *
 * **It used to be two pieces, and the other one is gone with the rail.**
 * `RightClickTarget` wrapped each of the rail's rows and attached a native
 * `contextmenu` listener through the ref, because react-native-web strips
 * props it does not know and `onContextMenu` is one of them. The rail folded
 * into `SwitcherMenu` (`docs/decisions/app-and-console.md`) and a menu row has
 * no second menu behind it, so the wrapper had no row left to wrap and went
 * rather than staying as a component nothing mounts. The lesson it carried —
 * reach the real DOM node through the ref and attach the listener yourself —
 * is alive in `useRightClick`, which is what the file tree's rows use.
 *
 * What the pointer layout has instead is a row in the switcher's own menu:
 * Settings for the context you are in, and Leave where the server would allow
 * it. That is the same two verbs this menu offers, minus the row you press
 * them on.
 *
 * The menu renders *inside* its anchor, absolutely positioned under the pill,
 * rather than in an overlay at the cursor: no portal machinery, no viewport
 * math, and the menu is anchored to the thing it is about — which is also
 * where a keyboard or screen-reader user will find themselves when it opens.
 * `ContextStrip` owns that anchor, because a dropdown drawn inside the
 * horizontal scroller would be clipped by it.
 *
 * Dismissal is the standard pair: any pointer-down outside, or Escape. Both
 * listeners live on `document` only while the menu is open.
 */
export function ContextRowMenu({
  slug,
  canLeave = false,
  pinned = false,
  onSelect,
  onLeave,
  onDismiss,
}: {
  slug: string;
  /** True when the viewer is not this context's owner — see `contextMenuItems`. */
  canLeave?: boolean;
  /** True for the pinned context, which offers Open and nothing else. */
  pinned?: boolean;
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
      {contextMenuItems(slug, { canLeave, pinned }).map((item) => {
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
