import { useState } from "react";
import { StyleSheet, TextInput, View, useWindowDimensions } from "react-native";
import { densityFor } from "../../app/frame";
import { Button, PressRow } from "../../design/components/Button";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { fonts, radii, space, touchType } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { useFieldFont } from "../../design/fieldFont";
import { Shell } from "./DialogShell";
import { placeName, placeTrail } from "./folderPickerModel";
import { PlacePicker } from "./PlacePicker";
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
          confirmLabel={(name) => `Put it in ${name}`}
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
  });
