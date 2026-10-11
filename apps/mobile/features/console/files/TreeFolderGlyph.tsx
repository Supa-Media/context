import { useRef } from "react";
import { Pressable, StyleSheet, View, type GestureResponderEvent } from "react-native";
import { Icon } from "../../design/components/Icon";
import { EmojiGlyph } from "../emoji/EmojiGlyph";
import { pointerType, radii } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";

/**
 * A folder's glyph in the tree: its own emoji, or the plain folder icon, and
 * for somebody who may change it, the way in to the picker.
 *
 * The owner (2026-10-09): clicking the icon should open the icon picker right
 * there instead of only through the right-click menu, and **only the icon**:
 * the chevron, the name and the rest of the row still open and close the
 * folder. So the button is exactly the 16pt glyph box and has no horizontal
 * `hitSlop` — slop to the left would take clicks from the chevron, and to the
 * right from the name. It is the inner pressable, so the row's own press does
 * not also fire.
 *
 * Not a tab stop: a keyboard is on the row, where Enter opens the folder as it
 * always has, and the row's menu key still offers "Set icon…". A ⌘/ctrl- or
 * shift-click is the row's pick before it reaches here (`rowInteractions.web`
 * listens in the capture phase), so the icon never steals a multi-selection.
 */
export function TreeFolderGlyph({
  label,
  icon,
  onPress,
}: {
  /** The folder's name, for the button's accessible name. */
  label: string;
  /** Its emoji, or `null` for the plain folder icon. */
  icon: string | null;
  /** Open the picker at this window point. Absent where the icon cannot be changed: the glyph is then only drawn. */
  onPress?: (anchor: { x: number; y: number }) => void;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const ref = useRef<View>(null);
  const glyph =
    icon === null ? (
      <Icon name="folder" size={14} color={colors.chromeMuted} />
    ) : (
      <EmojiGlyph
        emoji={icon}
        size={14}
        textStyle={styles.emoji}
        fallback={<Icon name="folder" size={14} color={colors.chromeMuted} />}
        testID="tree-folder-emoji"
      />
    );
  if (onPress === undefined) return glyph;

  function open(event: GestureResponderEvent) {
    const fallback = { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY + 8 };
    const node = ref.current;
    if (node === null || typeof node.measureInWindow !== "function") {
      onPress?.(fallback);
      return;
    }
    // Just under the icon, its left edge on the icon's: the picker reads as
    // coming out of the thing that was clicked.
    node.measureInWindow((x, y, _width, height) => {
      onPress?.(Number.isFinite(x) && Number.isFinite(y) ? { x, y: y + height + 4 } : fallback);
    });
  }

  return (
    <Pressable
      ref={ref}
      // No `role="button"`: on the web that is a <button>, and the row around
      // it already is one, which HTML does not allow.
      accessibilityLabel={`Change ${label}’s icon`}
      tabIndex={-1}
      onPress={open}
      hitSlop={{ top: 6, bottom: 6, left: 0, right: 0 }}
      style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [styles.button, hovered && styles.hover]}
      testID="tree-folder-icon-button"
    >
      {glyph}
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    emoji: { fontSize: pointerType.ui, lineHeight: 16 },
    /** The whole glyph box, so the hit area is the icon and nothing beside it. */
    button: {
      width: 16,
      height: 18,
      borderRadius: radii.sm,
      alignItems: "center",
      justifyContent: "center",
      cursor: "pointer",
    },
    /** Says "this part does something of its own" on top of the row's hover. */
    hover: { backgroundColor: colors.lineStrong },
  });
