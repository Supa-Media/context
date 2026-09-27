import { useMemo, useRef, useState, type JSX } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FocusRing } from "../../design/components/FocusRing";
import { Icon } from "../../design/components/Icon";
import { TextField } from "../../design/components/Input";
import { Text } from "../../design/components/Text";
import { radii, touchType } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors, type Shadows } from "../../design/theme";
import { linkRows, type LinkRow, type LinkTarget } from "./linkMarkdown";

/**
 * The Link sheet: the selected words become a link to a web page, a note, or
 * a name — screen 10 of the phone artboards, and the owner's ask: "why isn't
 * there a way for me to easily add a link to a text selection".
 *
 * One field, because the two things a person has to hand are an address they
 * copied and the name of a note they remember, and the field can tell them
 * apart (`webPageAddress`). The rows are `linkRows`; this file only draws them.
 *
 * ## Leaving it
 *
 * Three ways, all `onCancel`, and the editor puts the selection back exactly
 * as it was (`cancelLink`): the scrim, a drag down on the grabber, and Escape
 * — the last because the phone web build is a real surface with a Bluetooth
 * keyboard, and a sheet with a text field in it is exactly where a person
 * reaches for Escape. Return picks the first row, which is drawn as the
 * default for that reason.
 *
 * Native `Modal` and the plain `KeyboardAvoidingView`, as `RecentSheet` and
 * `Palette` use them: the field is at the top, so the keyboard can only ever
 * cover the tail of the list.
 */
export function LinkSheet({
  words,
  paths,
  self,
  onPick,
  onCancel,
}: {
  /** The selected words, shown so the person knows what is being linked. */
  words: string;
  /** The notes this surface knows about — the same list `[[` completes from. */
  paths: readonly string[];
  /** The note being edited, which is never offered as its own link. */
  self: string | null;
  onPick: (link: LinkTarget) => void;
  onCancel: () => void;
}): JSX.Element {
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const [typed, setTyped] = useState("");
  const rows = useMemo(() => linkRows(typed, paths, self), [typed, paths, self]);

  /*
    Drag the grabber down past a thumb's worth and let go: cancel. Anything
    shorter snaps back, which is simply nothing happening — the sheet is not
    dragged along, so there is no position to restore.
  */
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  const drag = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gesture) => gesture.dy > 6 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
        onPanResponderRelease: (_event, gesture) => {
          if (gesture.dy > DRAG_TO_CLOSE) cancel.current();
        },
      }),
    [],
  );

  return (
    <Modal transparent animationType="slide" visible onRequestClose={onCancel}>
      <KeyboardAvoidingView
        style={styles.fill}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <Pressable style={styles.scrim} accessibilityLabel="Close without linking" onPress={onCancel}>
          {/* Swallow presses inside the sheet so only the scrim dismisses it. */}
          <Pressable
            style={[styles.sheet, { marginBottom: Math.max(insets.bottom, 8) }]}
            onPress={() => {}}
            accessibilityLabel="Link"
            testID="link-sheet"
          >
            <View {...drag.panHandlers} style={styles.handle}>
              <View style={styles.grabber} aria-hidden />
              <View style={styles.head}>
                <Text variant="railHead" role="heading" aria-level={2}>
                  Link
                </Text>
                <Text variant="rowSub" numberOfLines={1} style={styles.words}>
                  on &ldquo;{words}&rdquo;
                </Text>
              </View>
            </View>

            <TextField
              label="Web address or note"
              labelHidden
              value={typed}
              onChangeText={setTyped}
              placeholder="Paste a web address, or type a note's name"
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={() => {
                if (rows.length > 0) onPick(rows[0].link);
              }}
              onKeyPress={(event) => {
                if (event.nativeEvent.key === "Escape") onCancel();
              }}
              // 16, not the pointer 13: iOS Safari zooms the page into any
              // field set smaller, and this one opens with the keyboard.
              style={styles.field}
              testID="link-sheet-field"
            />

            <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
              {rows.map((row, index) => (
                <LinkSheetRow key={row.key} row={row} first={index === 0} onPress={() => onPick(row.link)} />
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** How far down, in points, a drag on the grabber has to travel to close. */
const DRAG_TO_CLOSE = 60;

function LinkSheetRow({
  row,
  first,
  onPress,
}: {
  row: LinkRow;
  /** Return picks this one, so it is drawn as the default. */
  first: boolean;
  onPress: () => void;
}): JSX.Element {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const [focused, setFocused] = useState(false);

  return (
    <Pressable
      role="button"
      accessibilityLabel={`${row.title}, ${row.detail}`}
      onPress={onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={({ pressed }) => [styles.row, (first || pressed) && styles.rowDefault]}
      testID={`link-sheet-row-${row.key}`}
    >
      <Icon name={row.icon} size={17} color={first ? colors.accent : colors.muted} />
      <View style={styles.rowText}>
        <Text variant="rowTitle" numberOfLines={1}>
          {row.title}
        </Text>
        <Text variant="rowSub" numberOfLines={1}>
          {row.detail}
        </Text>
      </View>
      <FocusRing visible={focused} radius={radii.md} />
    </Pressable>
  );
}

const makeStyles = (colors: Colors, shadows: Shadows) => StyleSheet.create({
  fill: { flexGrow: 1 },

  scrim: {
    flexGrow: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0,0,0,0.35)",
  },

  /**
   * `RecentSheet`'s surface, floated: it rests on the keyboard rather than on
   * the bottom edge, so all four corners are rounded, as drawn on the board.
   */
  sheet: {
    marginHorizontal: 8,
    paddingTop: 8,
    paddingHorizontal: 12,
    paddingBottom: 10,
    borderRadius: radii.floating,
    backgroundColor: colors.surface,
    maxHeight: "70%",
    boxShadow: shadows.rising,
  },

  handle: { paddingBottom: 8 },

  grabber: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.lineStrong,
    marginBottom: 10,
  },

  head: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: 12,
    paddingHorizontal: 4,
  },

  words: { flexShrink: 1 },

  field: { fontSize: touchType.ui },

  list: { flexGrow: 0, flexShrink: 1, marginTop: 8 },

  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 44,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: radii.md,
  },

  rowDefault: { backgroundColor: colors.accentDim },

  rowText: { flexGrow: 1, flexShrink: 1 },
});
