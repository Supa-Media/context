import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, TextInput, View, useWindowDimensions } from "react-native";
import { densityFor } from "../../app/frame";
import { Button, PressRow } from "../../design/components/Button";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { fonts, radii, space, touchType } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { useFieldFont } from "../../design/fieldFont";
import { Shell } from "./DialogShell";
import { openTo, pickerRows, placeName, placeTrail } from "./folderPickerModel";
import { describeNameProblem } from "./paths";

/**
 * New folder: a name, and where it goes (boards 05 and 05b of the phone Home
 * artboards, approved by the owner on 2026-09-30).
 *
 * The place starts where the button was pressed — the top from Home, the
 * folder from inside one — and "Put it in" swaps the form for the place
 * picker in the same sheet: the workspace at the top, its folders as a tree
 * opened a level at a time, and "Find a folder" for a workspace too big to
 * walk. Confirming comes back to the form with the name still typed.
 *
 * Who can see the new folder is not asked: it follows the folder it is put
 * in, as every folder does, and the form says so in one line.
 */
export function NewFolderForm({
  folder,
  folders,
  rootLabel,
  onCancel,
  onCreate,
}: {
  /** Where it goes unless somebody picks another place; `""` is the top. */
  folder: string;
  /** Every folder the picker offers. */
  folders: readonly string[];
  /** What the top of the workspace is called: its name. */
  rootLabel: string;
  onCancel: () => void;
  onCreate: (place: string, name: string) => void;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const fieldFont = useFieldFont();
  const [name, setName] = useState("");
  const [place, setPlace] = useState(folder);
  const [picking, setPicking] = useState(false);
  const [focused, setFocused] = useState(false);
  const sheet = densityFor(useWindowDimensions().width) === "compact";
  const problem = name.trim() === "" ? null : describeNameProblem(name);
  const ready = name.trim() !== "" && problem === null;
  const where = placeName(place, rootLabel);

  if (picking) {
    return (
      <Shell title={`Put ${name.trim() || "it"} in`} onClose={onCancel} sheet={sheet}>
        <PlacePicker
          folders={folders}
          rootLabel={rootLabel}
          initial={place}
          onBack={() => setPicking(false)}
          onPick={(picked) => {
            setPlace(picked);
            setPicking(false);
          }}
        />
      </Shell>
    );
  }

  return (
    <Shell title="New folder" onClose={onCancel} sheet={sheet}>
      <View style={[styles.field, focused && styles.fieldFocused]}>
        <Icon name="folder" size={20} color={colors.text2} />
        <TextInput
          value={name}
          onChangeText={setName}
          autoFocus
          style={[styles.input, fieldFont]}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder="Folder name"
          placeholderTextColor={colors.muted}
          accessibilityLabel="Folder name"
          onSubmitEditing={() => {
            if (ready) onCreate(place, name.trim());
          }}
        />
      </View>
      {problem ? <Text variant="error">{problem}</Text> : null}
      <Text variant="meta" style={styles.label}>
        Put it in
      </Text>
      <PressRow
        accessibilityLabel={`Put it in ${where}. Change`}
        onPress={() => setPicking(true)}
        radius={radii.lg}
        style={styles.place}
        hoverStyle={styles.placeHover}
        testID="new-folder-place"
      >
        <Icon name="folder" size={20} color={colors.text2} />
        <Text style={styles.placeName} numberOfLines={1}>
          {where}
        </Text>
        <Text variant="meta" numberOfLines={1} style={styles.trail}>
          {placeTrail(place, rootLabel)}
        </Text>
        <Icon name="chevronRight" size={16} color={colors.muted} />
      </PressRow>
      <Text variant="meta" style={styles.label}>
        {`Who can see it: the same people who can see ${where}. Change it later in Share.`}
      </Text>
      <View style={styles.actions}>
        <Button label="Cancel" variant="dialog" onPress={onCancel} />
        <Button label="Create" variant="dialogPrimary" disabled={!ready} onPress={() => onCreate(place, name.trim())} />
      </View>
    </Shell>
  );
}

/** The place picker, board 05b: the same list Move's board draws. */
function PlacePicker({
  folders,
  rootLabel,
  initial,
  onBack,
  onPick,
}: {
  folders: readonly string[];
  rootLabel: string;
  initial: string;
  onBack: () => void;
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
      <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={onBack} style={styles.back}>
        <Icon name="chevronLeft" size={18} color={colors.accent} />
        <Text style={styles.backLabel}>Back</Text>
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
        {rows.map((row) => (
          <View key={row.path || "/"} style={[styles.row, row.path === picked && styles.rowOn]}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={row.path === picked ? `${row.label}, picked` : row.label}
              accessibilityState={{ selected: row.path === picked }}
              onPress={() => setPicked(row.path)}
              style={[styles.rowPick, { paddingLeft: space.x3 + row.depth * 20 }]}
              testID="place-row"
            >
              <Icon name="folder" size={20} color={row.path === picked ? colors.accentText : colors.text2} />
              <View style={styles.rowText}>
                <Text style={[styles.rowLabel, row.path === picked && styles.rowLabelOn]} numberOfLines={1}>
                  {row.label}
                </Text>
                {row.sub === undefined ? null : (
                  <Text variant="meta" numberOfLines={1}>
                    {row.sub}
                  </Text>
                )}
              </View>
              {row.path === picked ? <Icon name="check" size={18} color={colors.accentText} /> : null}
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
        ))}
      </ScrollView>
      <Button
        label={`Put it in ${placeName(picked, rootLabel)}`}
        variant="dialogPrimary"
        onPress={() => onPick(picked)}
      />
    </>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    field: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      paddingHorizontal: space.x3,
      minHeight: 50,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.lg,
      backgroundColor: colors.well,
    },
    fieldFocused: { borderColor: colors.accent },
    input: {
      flex: 1,
      fontFamily: fonts.body,
      fontSize: touchType.ui,
      color: colors.text,
      paddingVertical: 10,
      // Its own petrol border when focused, not the browser's orange outline.
      outlineWidth: 0,
    },
    label: { marginTop: space.x1 },
    place: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      minHeight: 50,
      paddingHorizontal: space.x3,
      borderRadius: radii.lg,
      backgroundColor: colors.well,
      borderWidth: 1,
      borderColor: colors.line,
    },
    placeHover: { backgroundColor: colors.surface3 },
    placeName: { fontFamily: fonts.body, fontSize: touchType.ui, color: colors.text, flexShrink: 0, maxWidth: "45%" },
    trail: { flex: 1, textAlign: "right" },
    actions: { flexDirection: "row", gap: 10, marginTop: 4 },
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
    list: {
      maxHeight: 380,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.lg,
      backgroundColor: colors.well,
    },
    none: { padding: space.x4 },
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
