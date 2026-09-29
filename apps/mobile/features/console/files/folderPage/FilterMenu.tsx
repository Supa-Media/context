/**
 * One of the filter bar's menus — Owner, Tag, Priority, Estimate or Due — as
 * a list of choices ticked as many as wanted, each with how many tasks it
 * would show (`filterOptions.ts`). A tick is kept at once and the menu stays
 * open for the next; it closes on a press outside or Escape.
 *
 * Owner and Tag, whose lists grow with the project, have a field to find one
 * in. A popover under the button where there is room for one, and a sheet
 * from the bottom where there is not, the rule the owner picker uses.
 */

import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, TextInput, View, useWindowDimensions } from "react-native";
import { isolateForDisplay } from "@context/shared/src/displayText.cjs";
import { Icon } from "../../../design/components/Icon";
import { Text } from "../../../design/components/Text";
import { place } from "../../../design/components/popoverPlacement";
import { fonts, layout, pointerType, radii, space } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import type { Shadows } from "../../../design/tokens/shadows";
import { useFieldFont } from "../../../design/fieldFont";
import { OwnerFace, PriorityGlyph } from "./Glyphs";
import { KIND_LABELS, type FilterOption } from "./filterOptions";
import { OWNER_ME, OWNER_NONE, type FilterKind } from "./showFilter";

const WIDTH = 280;
const HEIGHT = 400;

const FIELD_HINTS: Partial<Record<FilterKind, string>> = { owner: "Find a person or AI helper", tag: "Find a tag" };

export function FilterMenu({
  kind,
  options,
  picked,
  noun,
  anchor,
  onToggle,
  onDismiss,
}: {
  kind: FilterKind;
  options: readonly FilterOption[];
  picked: (value: string) => boolean;
  /** "projects" or "tasks", for the note under the list. */
  noun: string;
  anchor: { x: number; y: number } | null;
  onToggle: (value: string) => void;
  onDismiss: () => void;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const fieldFont = useFieldFont();
  const view = useWindowDimensions();
  const [query, setQuery] = useState("");
  const [focus, setFocus] = useState(0);
  const hint = FIELD_HINTS[kind];
  const q = query.trim().toLowerCase();
  // Me and No owner are always offered: they are not names to find.
  const shown = q === "" ? options : options.filter((option) => option.value === OWNER_ME || option.value === OWNER_NONE || option.label.toLowerCase().includes(q));
  const sheet = view.width < layout.narrowBreakpoint || anchor === null;
  const box = sheet ? null : place(anchor.x, anchor.y, { width: WIDTH, height: HEIGHT }, view, { minHeight: 120 });
  const note = kind === "tag" ? `Shows ${noun} with any ticked tag. Tags nothing uses are not listed.` : `Shows ${noun} that match any ticked choice.`;
  return (
    <Modal transparent visible animationType={sheet ? "slide" : "none"} onRequestClose={onDismiss}>
      <Pressable style={[styles.scrim, sheet && styles.scrimSheet]} accessibilityLabel={`Close ${KIND_LABELS[kind]}`} onPress={onDismiss}>
        <Pressable
          onPress={() => {}}
          style={sheet ? styles.sheet : [styles.popover, box === null ? null : { left: box.left, top: box.top, width: box.width, maxHeight: box.height }]}
          role="dialog"
          accessibilityLabel={`Filter by ${KIND_LABELS[kind].toLowerCase()}`}
          testID={`folder-filter-menu-${kind}`}
        >
          {hint === undefined ? null : (
            <TextInput
              autoFocus
              value={query}
              onChangeText={(text) => {
                setQuery(text);
                setFocus(0);
              }}
              placeholder={hint}
              placeholderTextColor={colors.chromeMuted}
              accessibilityLabel={hint}
              autoCapitalize="none"
              autoCorrect={false}
              style={[styles.field, fieldFont]}
              testID="folder-filter-menu-field"
              onKeyPress={(event) => {
                const key = event.nativeEvent.key;
                if (key === "Escape") onDismiss();
                else if (key === "ArrowDown" || key === "ArrowUp") {
                  (event as unknown as { preventDefault?: () => void }).preventDefault?.();
                  if (shown.length > 0) setFocus((at) => (at + (key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length);
                }
              }}
              onSubmitEditing={() => {
                const option = shown[focus];
                if (option !== undefined) onToggle(option.value);
              }}
            />
          )}
          <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
            {shown.map((option, index) => {
              const on = picked(option.value);
              return (
                <View key={`${option.value}:${index}`}>
                  {option.heading === undefined || q !== "" ? null : (
                    <Text variant="treeMeta" style={styles.heading}>
                      {option.heading}
                    </Text>
                  )}
                  <Pressable
                    role="checkbox"
                    aria-checked={on}
                    accessibilityLabel={`${option.label}, ${option.count}`}
                    onPress={() => onToggle(option.value)}
                    onHoverIn={() => setFocus(index)}
                    style={[styles.row, sheet && styles.rowTouch, focus === index && hint !== undefined && styles.rowLit]}
                    testID="folder-filter-option"
                  >
                    <View style={[styles.box, on && styles.boxOn]} testID={on ? "folder-filter-option-on" : undefined}>
                      {on ? <Icon name="check" size={10} color={colors.white} /> : null}
                    </View>
                    {option.face === undefined ? null : <OwnerFace face={option.face} size={20} />}
                    {option.priority === undefined ? null : <PriorityGlyph priority={option.priority} />}
                    <View style={styles.words}>
                      <Text variant="tree" numberOfLines={1} style={styles.label}>
                        {kind === "owner" || kind === "tag" ? isolateForDisplay(option.label) : option.label}
                      </Text>
                      {option.detail === undefined ? null : (
                        <Text variant="treeMeta" numberOfLines={1} style={styles.detail}>
                          {option.detail}
                        </Text>
                      )}
                    </View>
                    <Text variant="treeMeta" style={styles.count}>
                      {String(option.count)}
                    </Text>
                  </Pressable>
                </View>
              );
            })}
            {shown.length === 0 ? (
              <Text variant="treeMeta" style={styles.note} role="status">
                {kind === "tag" && q === "" ? "Nothing here has a tag yet." : "Nothing here matches."}
              </Text>
            ) : null}
          </ScrollView>
          <Text variant="treeMeta" style={styles.foot}>
            {note}
          </Text>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const makeStyles = (colors: Colors, shadows: Shadows) =>
  StyleSheet.create({
    scrim: { flex: 1 },
    scrimSheet: { backgroundColor: colors.scrim, justifyContent: "flex-end" },
    popover: {
      position: "absolute",
      padding: 6,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.xl,
      backgroundColor: colors.surface3,
      boxShadow: shadows.floating,
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
    field: {
      fontFamily: fonts.body,
      fontSize: pointerType.ui,
      color: colors.text,
      height: 30,
      paddingHorizontal: 8,
      marginBottom: 4,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.sm,
      backgroundColor: "transparent",
    },
    list: { flexGrow: 0 },
    heading: { color: colors.chromeMuted, paddingHorizontal: 10, paddingTop: 8, paddingBottom: 2, letterSpacing: 0.6 },
    row: { flexDirection: "row", alignItems: "center", gap: space.x2, minHeight: 32, paddingHorizontal: 8, borderRadius: radii.sm },
    rowTouch: { minHeight: 44 },
    rowLit: { backgroundColor: colors.accentDim },
    box: {
      width: 16,
      height: 16,
      borderRadius: 4,
      borderWidth: 1.5,
      borderColor: colors.lineStrong,
      alignItems: "center",
      justifyContent: "center",
    },
    boxOn: { backgroundColor: colors.accent, borderColor: colors.accent },
    words: { flexGrow: 1, flexShrink: 1, flexDirection: "row", alignItems: "baseline", gap: space.x2, minWidth: 0 },
    label: { flexShrink: 1, color: colors.text },
    detail: { flexShrink: 1, color: colors.chromeMuted },
    count: { color: colors.chromeMuted, fontVariant: ["tabular-nums"] },
    note: { color: colors.chromeMuted, paddingHorizontal: 10, paddingVertical: 6 },
    foot: {
      color: colors.chromeMuted,
      paddingHorizontal: 10,
      paddingTop: 8,
      paddingBottom: 4,
      marginTop: 4,
      borderTopWidth: 1,
      borderTopColor: colors.line,
    },
  });
