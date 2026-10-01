import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, TextInput, View, useWindowDimensions } from "react-native";
import { densityFor } from "../../app/frame";
import { Button } from "../../design/components/Button";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { fonts, radii, space, touchType } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { useFieldFont } from "../../design/fieldFont";
import { Shell } from "./DialogShell";
import { cleanTag, tagSuggestions } from "../home/folderTags";

/**
 * Tag a folder (board 14 of the phone Home artboards, approved by the owner
 * on 2026-09-30), from its •••.
 *
 * The folder's tags sit in the field as chips, each with an × to take it
 * off. Typing suggests the tags the workspace already uses, the best one
 * first so return picks it, and a new tag is always the last row. Done
 * writes them all at once to the folder's front note (`home/folderTags.ts`);
 * Cancel writes nothing. Tags then show on the folder and as a chip on Home.
 */
export function TagsSheet({
  name,
  initial,
  known,
  workspaceLabel,
  onCancel,
  onSave,
}: {
  /** The folder's name, for the title. */
  name: string;
  initial: readonly string[];
  /** Every tag in the workspace, with how many notes carry it. */
  known: readonly { tag: string; count: number }[];
  workspaceLabel: string;
  onCancel: () => void;
  /** Resolves to null once written, or the sentence saying why not. */
  onSave: (tags: readonly string[]) => Promise<string | null>;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const fieldFont = useFieldFont();
  const [tags, setTags] = useState<readonly string[]>(initial);
  const [typed, setTyped] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const sheet = densityFor(useWindowDimensions().width) === "compact";
  const { suggestions, add } = useMemo(() => tagSuggestions(typed, known, tags), [typed, known, tags]);
  const shown = suggestions.slice(0, 8);

  const take = (tag: string) => {
    const clean = cleanTag(tag);
    if (clean === "") return;
    setTags((current) => (current.some((one) => one.toLocaleLowerCase() === clean.toLocaleLowerCase()) ? current : [...current, clean]));
    setTyped("");
  };
  // Return picks the highlighted row: the best suggestion, else the new tag.
  const best = typed.trim() === "" ? null : (shown[0]?.tag ?? add);
  const changed = tags.length !== initial.length || tags.some((tag, index) => tag !== initial[index]);

  return (
    <Shell title={`Tag ${name}`} onClose={onCancel} sheet={sheet}>
      <View style={styles.field}>
        {tags.map((tag) => (
          <Pressable
            key={tag}
            accessibilityRole="button"
            accessibilityLabel={`Remove ${tag}`}
            onPress={() => setTags((current) => current.filter((one) => one !== tag))}
            style={styles.chip}
            testID="tag-chip"
          >
            <Text style={styles.chipText}>{tag}</Text>
            <Icon name="close" size={14} color={colors.accentText} />
          </Pressable>
        ))}
        <TextInput
          value={typed}
          onChangeText={setTyped}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.input, fieldFont]}
          placeholder={tags.length === 0 ? "Add a tag" : ""}
          placeholderTextColor={colors.muted}
          accessibilityLabel="Add a tag"
          onSubmitEditing={() => {
            if (best !== null) take(best);
          }}
          blurOnSubmit={false}
        />
      </View>
      {shown.length > 0 || add !== null ? (
        <>
          <Text variant="meta">{`Tags already in ${workspaceLabel}`}</Text>
          <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
            {shown.map((one, index) => (
              <Pressable
                key={one.tag}
                accessibilityRole="button"
                accessibilityLabel={`${one.tag}, ${one.count === 1 ? "1 note" : `${one.count} notes`}`}
                onPress={() => take(one.tag)}
                style={[styles.row, index > 0 && styles.rule, one.tag === best && styles.rowBest]}
                testID="tag-suggestion"
              >
                <Icon name="tag" size={18} color={colors.text2} />
                <Text style={styles.rowLabel} numberOfLines={1}>
                  {one.tag}
                </Text>
                <Text variant="meta">{one.count === 1 ? "1 note" : `${one.count} notes`}</Text>
              </Pressable>
            ))}
            {add === null ? null : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Add “${add}” as a new tag`}
                onPress={() => take(add)}
                style={[styles.row, shown.length > 0 && styles.rule, add === best && styles.rowBest]}
                testID="tag-new"
              >
                <Icon name="plus" size={18} color={colors.text2} />
                <Text style={styles.rowLabel} numberOfLines={1}>
                  {`Add “${add}” as a new tag`}
                </Text>
              </Pressable>
            )}
          </ScrollView>
        </>
      ) : null}
      <Text variant="meta">Tags show on the folder and as a filter on Home.</Text>
      {problem === null ? null : <Text variant="error">{problem}</Text>}
      <View style={styles.actions}>
        <Button label="Cancel" variant="dialog" onPress={onCancel} />
        <Button
          label={saving ? "Saving…" : "Done"}
          variant="dialogPrimary"
          disabled={saving}
          onPress={() => {
            if (!changed) return onCancel();
            setSaving(true);
            setProblem(null);
            void onSave(tags).then((answer) => {
              setSaving(false);
              if (answer === null) onCancel();
              else setProblem(answer);
            });
          }}
        />
      </View>
    </Shell>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    field: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      gap: space.x2,
      minHeight: 50,
      paddingHorizontal: space.x2 + 2,
      paddingVertical: space.x2 - 1,
      borderWidth: 1,
      borderColor: colors.accent,
      borderRadius: radii.lg,
      backgroundColor: colors.well,
    },
    chip: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x1,
      minHeight: 32,
      paddingHorizontal: space.x3,
      borderRadius: radii.pill,
      borderWidth: 1,
      borderColor: colors.accent,
      backgroundColor: colors.accentDim,
    },
    chipText: { fontFamily: fonts.body, fontSize: touchType.meta + 1, color: colors.accentText, fontWeight: "500" },
    input: {
      flexGrow: 1,
      minWidth: 90,
      fontFamily: fonts.body,
      fontSize: touchType.ui,
      color: colors.text,
      paddingVertical: 6,
      outlineWidth: 0,
    },
    list: {
      maxHeight: 280,
      borderRadius: radii.lg,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.well,
    },
    row: { flexDirection: "row", alignItems: "center", gap: space.x3, minHeight: 46, paddingHorizontal: space.x3 },
    rule: { borderTopWidth: 1, borderTopColor: colors.line },
    rowBest: { backgroundColor: colors.accentDim },
    rowLabel: { flex: 1, fontFamily: fonts.body, fontSize: touchType.ui, color: colors.text },
    actions: { flexDirection: "row", gap: 10, marginTop: 4 },
  });
