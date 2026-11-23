/**
 * The seat menu on web: a popover beside the pointer in a roomy window, the
 * sheet (`Menu`'s own) in a narrow one, as every menu chooses.
 *
 * Not the shared `Menu` popover, because that one draws rows only and the
 * approved design opens with a head: the seat, who holds it, and how to reach
 * them. The rows are `Menu`'s own `ItemRow`, so they look and behave alike.
 * It dismisses as `Menu` does: a press outside, Escape, any scroll, the window
 * losing focus.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { StyleSheet, View, useWindowDimensions } from "react-native";
import { ItemRow, Separator } from "../../../../design/components/MenuRow";
import { MARGIN, place } from "../../../../design/components/popoverPlacement";
import { writeClipboard } from "../../../../design/clipboard";
import { densityFor } from "../../../../app/frame";
import { radii, space } from "../../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../../design/theme";
import { SeatMenu as SeatSheet, type SeatMenuProps } from "./SeatMenu";
import { SeatMenuHead } from "./seatMenuParts";

export type { SeatMenuProps } from "./SeatMenu";

export function SeatMenu(props: SeatMenuProps) {
  const { width } = useWindowDimensions();
  return densityFor(width) === "compact" ? <SeatSheet {...props} /> : <SeatPopover {...props} />;
}

function SeatPopover({ model, anchor, onSelect, onDismiss }: SeatMenuProps) {
  const styles = useThemedStyles(makeStyles);
  const view = useWindowDimensions();
  const node = useRef<HTMLElement | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [focus, setFocus] = useState(-1);
  const box = place(anchor?.x ?? MARGIN, anchor?.y ?? MARGIN, size ?? { width: 260, height: 200 }, view);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target !== null && node.current?.contains(target) === true) return;
      onDismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onDismiss();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const n = model.items.length;
        setFocus((at) => (event.key === "ArrowDown" ? (at + 1) % n : (at <= 0 ? n : at) - 1));
      } else if (event.key === "Enter" && focus >= 0) {
        event.preventDefault();
        const item = model.items[focus];
        if (item !== undefined) {
          onSelect(item.id);
          onDismiss();
        }
      }
    };
    document.addEventListener("mousedown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("scroll", onDismiss, true);
    window.addEventListener("blur", onDismiss);
    return () => {
      document.removeEventListener("mousedown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("scroll", onDismiss, true);
      window.removeEventListener("blur", onDismiss);
    };
  }, [onDismiss, onSelect, model.items, focus]);

  return createPortal(
    <View
      ref={(element) => {
        node.current = element as unknown as HTMLElement | null;
      }}
      role="menu"
      accessibilityLabel={`${model.title} seat options`}
      testID="menu-root"
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        if (size === null || size.width !== width || size.height !== height) setSize({ width, height });
      }}
      style={[styles.panel, { left: box.left, top: box.top, opacity: size === null ? 0 : 1 }]}
    >
      <SeatMenuHead model={model} touch={false} onCopy={(text) => void writeClipboard(text)} />
      <View style={styles.items}>
        {model.items.map((item, index) => (
          <View key={item.id}>
            {item.separatorBefore === true ? <Separator touch={false} /> : null}
            <ItemRow
              item={item}
              touch={false}
              focused={focus === index}
              onActivate={() => {
                onSelect(item.id);
                onDismiss();
              }}
              onHover={() => setFocus(index)}
            />
          </View>
        ))}
      </View>
    </View>,
    document.body,
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    panel: {
      position: "fixed" as "absolute",
      minWidth: 240,
      maxWidth: 380,
      paddingVertical: space.x1,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.xl,
      backgroundColor: colors.surface3,
      boxShadow: "0 24px 60px -18px rgba(0,0,0,.45)",
      zIndex: 10000,
    },
    items: { paddingTop: space.x1 },
  });
