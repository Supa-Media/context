/**
 * The seat menu on web, drawn to the approved prototype's measures
 * (`.st-menu`): a white card under its trigger in a roomy window, the same
 * card pinned to the bottom edge in a narrow one (`.st-menu.phone`).
 *
 * Not the shared `Menu`, because that one draws rows only, on a grey panel,
 * and the approved design opens with a head: the seat, who holds it, and how
 * to reach them (the owner, 2026-11-23: "a white background and the exact
 * layout"). It dismisses as `Menu` does: a press outside, Escape, any scroll,
 * the window losing focus.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { StyleSheet, View, useWindowDimensions } from "react-native";
import { MARGIN, place } from "../../../../design/components/popoverPlacement";
import { writeClipboard } from "../../../../design/clipboard";
import { densityFor } from "../../../../app/frame";
import { radii, space } from "../../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../../design/theme";
import type { SeatMenuProps } from "./SeatMenu";
import { SeatMenuHead, SeatMenuRow, SeatMenuSeparator } from "./seatMenuParts";

export type { SeatMenuProps } from "./SeatMenu";

export function SeatMenu({ model, anchor, onSelect, onDismiss }: SeatMenuProps) {
  const styles = useThemedStyles(makeStyles);
  const view = useWindowDimensions();
  const phone = densityFor(view.width) === "compact";
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
      style={[
        styles.panel,
        phone ? styles.phone : { left: box.left, top: box.top, opacity: size === null ? 0 : 1 },
      ]}
    >
      <SeatMenuHead model={model} touch={phone} onCopy={(text) => void writeClipboard(text)} />
      <View>
        {model.items.map((item, index) => (
          <View key={item.id}>
            {item.separatorBefore === true ? <SeatMenuSeparator /> : null}
            <SeatMenuRow
              item={item}
              touch={phone}
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
    // `.st-menu`: min 232, max 320, padding 6, radius 10, the white card, a 1px line border.
    panel: {
      position: "fixed" as "absolute",
      minWidth: 232,
      maxWidth: 320,
      padding: 6,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.xl,
      backgroundColor: colors.menuSurface,
      boxShadow: "0 10px 30px -10px rgba(16,16,28,.32), 0 1px 3px rgba(16,16,28,.10)",
      zIndex: 10000,
    },
    // `.st-menu.phone`: 8 from three edges, radius 18, padding 8 8 24.
    phone: {
      left: space.x2,
      right: space.x2,
      bottom: space.x2,
      maxWidth: "100%",
      borderRadius: 18,
      paddingTop: space.x2,
      paddingHorizontal: space.x2,
      paddingBottom: space.x6,
    },
  });
