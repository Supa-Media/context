/**
 * The floating box a sheet's menus open in: a popover at the thing pressed,
 * flipped by `place` so it never clips at a window edge, and a sheet from the
 * bottom on a phone, where the room decides and not the device. The same
 * shape `OwnerPicker` and `Menu` use. Escape and a tap on the scrim close it.
 */

import { useRef, type ReactNode } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { place } from "../../../design/components/popoverPlacement";
import { radii, space } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { densityFor } from "../../../app/frame";

export interface Anchor {
  x: number;
  y: number;
  /** The bottom edge of what was pressed, so the box opens just under it. */
  bottom: number;
}

/**
 * Where a pressed element sits in the window. Calls `done` with null when the
 * element is not laid out (a test, or a first frame), so the menu still opens.
 */
export function measureNode(node: View | null | undefined, done: (anchor: Anchor | null) => void): void {
  if (!node || typeof node.measureInWindow !== "function") {
    done(null);
    return;
  }
  node.measureInWindow((x, y, _width, height) => done({ x, y: y + height + 4, bottom: y + height }));
}

export function Popover({
  anchor,
  width,
  maxHeight = 360,
  onDismiss,
  children,
  testID,
}: {
  anchor: Anchor | null;
  width: number;
  maxHeight?: number;
  onDismiss: () => void;
  children: ReactNode;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const view = useWindowDimensions();
  const sheet = anchor === null || densityFor(view.width) === "compact";
  const box = sheet || anchor === null ? null : place(anchor.x, anchor.y, { width, height: maxHeight }, view, { minHeight: 120 });
  const dismissed = useRef(false);
  const dismiss = () => {
    if (dismissed.current) return;
    dismissed.current = true;
    onDismiss();
  };
  return (
    <Modal transparent visible animationType={sheet ? "slide" : "none"} onRequestClose={dismiss}>
      <Pressable style={[styles.scrim, sheet && styles.scrimSheet]} accessibilityLabel="Close" onPress={dismiss}>
        <Pressable
          onPress={() => {}}
          style={
            sheet
              ? styles.sheet
              : [styles.popover, box === null ? null : { left: box.left, top: box.top, width: box.width, maxHeight: box.height }]
          }
          testID={testID}
        >
          {sheet ? <View style={styles.grabber} /> : null}
          <ScrollView keyboardShouldPersistTaps="handled">{children}</ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    scrim: { flex: 1 },
    grabber: { alignSelf: "center", width: 36, height: 5, borderRadius: 3, backgroundColor: colors.lineStrong, marginTop: -space.x1, marginBottom: space.x2 },
    scrimSheet: { backgroundColor: "rgba(3,3,4,.72)", justifyContent: "flex-end" },
    popover: {
      position: "absolute",
      padding: space.x1,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.xl,
      backgroundColor: colors.surface3,
      boxShadow: "0 24px 60px -18px rgba(0,0,0,.9)",
    },
    sheet: {
      maxHeight: "80%",
      padding: space.x3,
      paddingBottom: space.x6,
      borderTopLeftRadius: radii.floating,
      borderTopRightRadius: radii.floating,
      borderTopWidth: 1,
      borderColor: colors.lineStrong,
      backgroundColor: colors.surface2,
    },
  });
