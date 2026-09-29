/**
 * A phone's filter: the bar's five menus as one sheet from the bottom (the
 * Phone artboard), each a group of 44pt choices to tick, with "Clear all" at
 * the top and "Show 3 of 7 projects" to close it. A tick is kept at once, so
 * the count on the button is what closing will show.
 */

import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { isolateForDisplay } from "@context/shared/src/displayText.cjs";
import { Button } from "../../../design/components/Button";
import { Text } from "../../../design/components/Text";
import { radii, space } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { KIND_LABELS, type FilterOption } from "./filterOptions";
import { FILTER_KINDS, type FilterKind } from "./showFilter";

export function FilterSheet({
  options,
  picked,
  onToggle,
  onClear,
  shown,
  total,
  noun,
  onClose,
}: {
  /** Each kind's choices; a kind with none (no tags in use) is left out. */
  options: (kind: FilterKind) => readonly FilterOption[];
  picked: (kind: FilterKind, value: string) => boolean;
  onToggle: (kind: FilterKind, value: string) => void;
  onClear: (() => void) | null;
  shown: number;
  total: number;
  noun: string;
  onClose: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Modal transparent visible animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.scrim} accessibilityLabel="Close filter" onPress={onClose}>
        <Pressable onPress={() => {}} style={styles.sheet} role="dialog" accessibilityLabel={`Filter ${noun}`} testID="folder-filter-sheet">
          <View style={styles.handle} />
          <View style={styles.head}>
            <Text variant="paneTitle" style={styles.title}>
              Filter
            </Text>
            {onClear === null ? null : (
              <Pressable onPress={onClear} role="button" style={styles.clear} testID="folder-filter-sheet-clear">
                <Text variant="body" style={styles.clearText}>
                  Clear all
                </Text>
              </Pressable>
            )}
          </View>
          <ScrollView style={styles.groups} contentContainerStyle={styles.groupsInner}>
            {FILTER_KINDS.map((kind) => {
              const choices = options(kind);
              if (choices.length === 0) return null;
              return (
                <View key={kind} style={styles.group} role="group" accessibilityLabel={KIND_LABELS[kind]} testID={`folder-filter-group-${kind}`}>
                  <Text variant="eyebrow" style={styles.groupTitle}>
                    {KIND_LABELS[kind].toUpperCase()}
                  </Text>
                  <View style={styles.pills}>
                    {choices.map((option) => {
                      const on = picked(kind, option.value);
                      return (
                        <Pressable
                          key={option.value}
                          onPress={() => onToggle(kind, option.value)}
                          role="checkbox"
                          aria-checked={on}
                          accessibilityLabel={`${option.label}, ${option.count}`}
                          style={[styles.pill, on && styles.pillOn]}
                          testID="folder-filter-pill"
                        >
                          <Text variant="body" numberOfLines={1} style={[styles.pillText, on && styles.pillTextOn]}>
                            {kind === "owner" || kind === "tag" ? isolateForDisplay(option.label) : option.label}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              );
            })}
          </ScrollView>
          <Button
            label={shown === total ? `Show all ${total} ${noun}` : `Show ${shown} of ${total} ${noun}`}
            variant="dialogPrimary"
            onPress={onClose}
            style={styles.show}
            testID="folder-filter-sheet-show"
          />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    scrim: { flex: 1, backgroundColor: colors.scrim, justifyContent: "flex-end" },
    sheet: {
      maxHeight: "85%",
      paddingHorizontal: space.x4,
      paddingTop: space.x2,
      paddingBottom: space.x6,
      gap: space.x3,
      borderTopLeftRadius: radii.floating,
      borderTopRightRadius: radii.floating,
      borderTopWidth: 1,
      borderColor: colors.lineStrong,
      backgroundColor: colors.surface2,
    },
    handle: { alignSelf: "center", width: 40, height: 5, borderRadius: 3, backgroundColor: colors.lineStrong },
    head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    title: { color: colors.text },
    clear: { minHeight: 44, justifyContent: "center", paddingHorizontal: space.x1 },
    clearText: { color: colors.text2, textDecorationLine: "underline" },
    groups: { flexGrow: 0, flexShrink: 1 },
    groupsInner: { gap: space.x4 },
    group: { gap: space.x2 },
    groupTitle: { color: colors.muted },
    pills: { flexDirection: "row", flexWrap: "wrap", gap: space.x2 },
    pill: {
      minHeight: 44,
      justifyContent: "center",
      paddingHorizontal: 14,
      borderRadius: 22,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      maxWidth: "100%",
    },
    pillOn: { borderColor: colors.accent, backgroundColor: colors.accentDim },
    pillText: { color: colors.text },
    pillTextOn: { color: colors.accentText, fontWeight: "600" },
    show: { alignSelf: "stretch", minHeight: 48, justifyContent: "center" },
  });
