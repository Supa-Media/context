/**
 * The smaller pieces of the task composer (`QuickAddComposer.tsx`): its
 * menus, the tag field with the project's tags to pick from, the "Pick a
 * date…" field, and a chosen word with a way to take it off again.
 */

import { useState } from "react";
import { Pressable, StyleSheet, TextInput, View, type NativeSyntheticEvent, type TextInputKeyPressEventData } from "react-native";
import { isolateForDisplay } from "@context/shared/src/displayText.cjs";
import { Icon } from "../../../../design/components/Icon";
import { Menu } from "../../../../design/components/Menu";
import { Text } from "../../../../design/components/Text";
import { fonts, pointerType, radii, space } from "../../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";
import { useFieldFont } from "../../../../design/fieldFont";
import type { MenuItem } from "../../menu";
import { cleanTag, parseDueText } from "./taskWords";

/** Where a menu opens: under its button, or null for wherever the menu puts itself (a sheet on a phone). */
export type Anchor = { readonly x: number; readonly y: number } | null;

/** How many of the project's tags are offered at once. */
const SUGGESTED = 6;

export function ComposerMenu({
  anchor,
  title,
  items,
  onSelect,
  onDismiss,
}: {
  anchor: Anchor;
  title: string;
  items: readonly { id: string; label: string; checked?: boolean }[];
  onSelect: (id: string) => void;
  onDismiss: () => void;
}) {
  const menuItems: MenuItem<string>[] = items.map((item) => ({ ...item, testID: `quick-add-menu-${item.id}` }));
  return (
    <Menu<string>
      items={menuItems}
      {...(anchor === null ? {} : { anchor })}
      title={title}
      onDismiss={onDismiss}
      onSelect={(id) => {
        onDismiss();
        onSelect(id);
      }}
    />
  );
}

function escapeCloses(onClose: () => void) {
  return (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
    if (event.nativeEvent.key === "Escape") onClose();
  };
}

/** "+ Tag": a field, and the project's own tags that match what is typed. Enter adds what is typed. */
export function TagPanel({
  suggestions,
  onAdd,
  onClose,
}: {
  suggestions: readonly string[];
  onAdd: (tag: string) => void;
  onClose: () => void;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const fieldFont = useFieldFont();
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const typed = draft.trim().toLowerCase();
  const offered = suggestions.filter((tag) => typed === "" || tag.toLowerCase().includes(typed)).slice(0, SUGGESTED);
  const add = (text: string) => {
    const tag = cleanTag(text);
    if (tag === null) {
      if (text.trim() !== "") setProblem("A tag can’t hold a comma, a bracket, a quote or #.");
      return;
    }
    onAdd(tag);
    setDraft("");
    setProblem(null);
  };
  return (
    <View style={styles.panel} testID="quick-add-tag-panel">
      <TextInput
        autoFocus
        value={draft}
        onChangeText={(text) => {
          setDraft(text);
          setProblem(null);
        }}
        onKeyPress={escapeCloses(onClose)}
        onSubmitEditing={() => add(draft)}
        blurOnSubmit={false}
        placeholder="Tag"
        placeholderTextColor={colors.chromeMuted}
        accessibilityLabel="Tag"
        autoCapitalize="none"
        style={[styles.field, fieldFont]}
        testID="quick-add-tag-field"
      />
      {offered.map((tag) => (
        <Pressable key={tag} role="button" accessibilityLabel={`Add tag ${tag}`} onPress={() => add(tag)} style={styles.suggestion} testID="quick-add-tag-suggestion">
          <Text variant="treeMeta" style={styles.suggestionText}>
            {isolateForDisplay(tag)}
          </Text>
        </Pressable>
      ))}
      {problem === null ? null : (
        <Text variant="treeMeta" style={styles.problem} role="alert">
          {problem}
        </Text>
      )}
    </View>
  );
}

/** "Pick a date…": `Oct 3`, `3 Oct` or `2026-10-03`. */
export function DuePanel({ now, onPick, onClose }: { now: Date; onPick: (day: string) => void; onClose: () => void }) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const fieldFont = useFieldFont();
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const pick = () => {
    const day = parseDueText(draft, now);
    if (day === null) setProblem("That isn’t a day. Try Oct 3.");
    else onPick(day);
  };
  return (
    <View style={styles.panel} testID="quick-add-due-panel">
      <TextInput
        autoFocus
        value={draft}
        onChangeText={(text) => {
          setDraft(text);
          setProblem(null);
        }}
        onKeyPress={escapeCloses(onClose)}
        onSubmitEditing={pick}
        blurOnSubmit={false}
        placeholder="e.g. Oct 3"
        placeholderTextColor={colors.chromeMuted}
        accessibilityLabel="Due date"
        style={[styles.field, fieldFont]}
        testID="quick-add-due-field"
      />
      {problem === null ? null : (
        <Text variant="treeMeta" style={styles.problem} role="alert">
          {problem}
        </Text>
      )}
    </View>
  );
}

/** A chosen tag or owner, with × to take it off. */
export function WordChip({ word, onRemove, testID }: { word: string; onRemove: () => void; testID?: string }) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.chip} testID={testID}>
      <Text variant="treeMeta" style={styles.suggestionText}>
        {isolateForDisplay(word)}
      </Text>
      <Pressable role="button" accessibilityLabel={`Remove ${word}`} onPress={onRemove} hitSlop={6}>
        <Icon name="close" size={10} color={colors.chromeMuted} />
      </Pressable>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    panel: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.x1 + 2 },
    field: {
      fontFamily: fonts.body,
      fontSize: pointerType.ui,
      color: colors.text,
      width: 160,
      height: 28,
      paddingHorizontal: space.x2,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.sm,
      backgroundColor: "transparent",
    },
    suggestion: { paddingHorizontal: space.x2, paddingVertical: 2, borderRadius: radii.sm, backgroundColor: colors.chipFill },
    suggestionText: { color: colors.muted },
    chip: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x1,
      paddingHorizontal: space.x2,
      paddingVertical: 2,
      borderRadius: radii.sm,
      backgroundColor: colors.chipFill,
    },
    problem: { color: colors.critText },
  });
