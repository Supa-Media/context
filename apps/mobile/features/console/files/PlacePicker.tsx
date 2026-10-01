import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { fonts, radii, space, touchType } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { useFieldFont } from "../../design/fieldFont";
import { openTo, pickerRows, placeName } from "./folderPickerModel";

/**
 * The place picker of the phone Home artboards (approved by the owner on
 * 2026-09-30): the workspace by name at the top, its folders as a tree opened
 * a level at a time, and "Find a folder" for a workspace too big to walk.
 *
 * Two boards draw it and both use this one: New folder's "Put it in" (05b),
 * and Move (12), where the folder the thing is in now is marked "Here now" and
 * is not somewhere it can be moved to.
 */
export function PlacePicker({
  folders,
  rootLabel,
  initial,
  here = null,
  backLabel = "Back",
  onBack,
  confirmLabel,
  onPick,
}: {
  folders: readonly string[];
  rootLabel: string;
  /** The place picked when the picker opens. */
  initial: string;
  /** Where the thing is now: marked, and refused as a pick. `null` when there is no one place. */
  here?: string | null;
  backLabel?: string;
  onBack: () => void;
  /** The confirm button's words for a place, given its name. */
  confirmLabel: (name: string) => string;
  onPick: (folder: string) => void;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const fieldFont = useFieldFont();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<ReadonlySet<string>>(() => openTo(initial));
  const [picked, setPicked] = useState(initial);
  const rows = useMemo(
    () => pickerRows({ folders, open, query, rootLabel }),
    [folders, open, query, rootLabel],
  );
  const toggle = (folder: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });

  return (
    <>
      <Pressable accessibilityRole="button" accessibilityLabel={backLabel} onPress={onBack} style={styles.back}>
        {backLabel === "Back" ? <Icon name="chevronLeft" size={18} color={colors.accent} /> : null}
        <Text style={styles.backLabel}>{backLabel}</Text>
      </Pressable>
      <View style={styles.find}>
        <Icon name="search" size={16} color={colors.muted} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          style={[styles.input, fieldFont]}
          placeholder="Find a folder"
          placeholderTextColor={colors.muted}
          accessibilityLabel="Find a folder"
        />
      </View>
      <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
        {rows.length === 0 ? (
          <Text variant="meta" style={styles.none}>
            No folder is called that.
          </Text>
        ) : null}
        {rows.map((row) => {
          const on = row.path === picked;
          const sub = row.path === here ? "Here now" : row.sub;
          return (
            <View key={row.path || "/"} style={[styles.row, on && styles.rowOn]}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={on ? `${row.label}, picked` : row.label}
                accessibilityState={{ selected: on }}
                onPress={() => setPicked(row.path)}
                style={[styles.rowPick, { paddingLeft: space.x3 + row.depth * 20 }]}
                testID="place-row"
              >
                <Icon name="folder" size={20} color={on ? colors.accentText : colors.text2} />
                <View style={styles.rowText}>
                  <Text style={[styles.rowLabel, on && styles.rowLabelOn]} numberOfLines={1}>
                    {row.label}
                  </Text>
                  {sub === undefined ? null : (
                    <Text variant="meta" numberOfLines={1}>
                      {sub}
                    </Text>
                  )}
                </View>
                {on ? <Icon name="check" size={18} color={colors.accentText} /> : null}
              </Pressable>
              {row.opens ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${row.open ? "Close" : "Open"} ${row.label}`}
                  onPress={() => toggle(row.path)}
                  style={styles.opener}
                >
                  <Icon name={row.open ? "chevronDown" : "chevronRight"} size={16} color={colors.muted} />
                </Pressable>
              ) : null}
            </View>
          );
        })}
      </ScrollView>
      <Button
        label={confirmLabel(placeName(picked, rootLabel))}
        variant="dialogPrimary"
        disabled={picked === here}
        onPress={() => onPick(picked)}
        testID="place-confirm"
        style={styles.confirm}
      />
    </>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    back: { flexDirection: "row", alignItems: "center", gap: 2, minHeight: 44, alignSelf: "flex-start" },
    backLabel: { fontFamily: fonts.body, fontSize: touchType.ui, color: colors.accent, fontWeight: "500" },
    find: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      paddingHorizontal: space.x3,
      minHeight: 44,
      borderRadius: radii.lg,
      backgroundColor: colors.well,
    },
    input: {
      flex: 1,
      fontFamily: fonts.body,
      fontSize: touchType.ui,
      color: colors.text,
      paddingVertical: 10,
      // Its own petrol border when focused, not the browser's orange outline.
      outlineWidth: 0,
    },
    list: {
      maxHeight: 380,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.lg,
      backgroundColor: colors.well,
    },
    none: { padding: space.x4 },
    // Across the sheet, as boards 05b and 12 draw it.
    confirm: { alignSelf: "stretch" },
    row: { flexDirection: "row", alignItems: "center", minHeight: 52 },
    rowOn: { backgroundColor: colors.accentDim },
    rowPick: { flex: 1, flexDirection: "row", alignItems: "center", gap: space.x3, paddingVertical: space.x2, paddingRight: space.x3 },
    rowText: { flex: 1, gap: 2 },
    rowLabel: { fontFamily: fonts.body, fontSize: touchType.ui, color: colors.text },
    rowLabelOn: { color: colors.accentText, fontWeight: "600" },
    opener: {
      width: 44,
      height: 44,
      alignItems: "center",
      justifyContent: "center",
      borderLeftWidth: 1,
      borderLeftColor: colors.line,
    },
  });
