import { useState, type ReactNode } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { Button, PressRow } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { fonts, radii } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { describeDeleteForever, describeNameProblem } from "./paths";

/**
 * The console's dialogs.
 *
 * Three shapes, in the mockup's language: a shell, a name prompt, and a
 * destination picker. The fourth — permanent deletion — is deliberately its
 * own component rather than a `<Confirm danger>`, because it is the one action
 * in this product that cannot be undone and it should not be one boolean away
 * from every other confirmation.
 */

function Shell({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose} visible>
      <Pressable
        style={styles.scrim}
        accessibilityLabel="Close"
        onPress={onClose}
      >
        {/* Swallow presses inside the card so the scrim only closes on the scrim. */}
        <Pressable style={styles.card} onPress={() => {}} accessibilityLabel={title}>
          <Text variant="paneTitle" role="heading" aria-level={2}>
            {title}
          </Text>
          <View style={styles.body}>{children}</View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/** Ask for a name. Validated as you type, with the reason next to the field. */
export function NamePrompt({
  title,
  description,
  confirmLabel,
  initialValue = "",
  onCancel,
  onConfirm,
}: {
  title: string;
  description?: string;
  confirmLabel: string;
  initialValue?: string;
  onCancel: () => void;
  onConfirm: (name: string) => void;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const [value, setValue] = useState(initialValue);
  const problem = value.trim() === "" ? null : describeNameProblem(value);
  const ready = value.trim() !== "" && problem === null;

  return (
    <Shell title={title} onClose={onCancel}>
      {description ? <Text variant="paneSub">{description}</Text> : null}
      <TextInput
        value={value}
        onChangeText={setValue}
        autoFocus
        style={styles.input}
        placeholder="name"
        placeholderTextColor={colors.muted}
        accessibilityLabel={title}
        onSubmitEditing={() => {
          if (ready) onConfirm(value.trim());
        }}
      />
      {problem ? <Text variant="error">{problem}</Text> : null}
      <View style={styles.actions}>
        <Button label="Cancel" onPress={onCancel} />
        <Button
          label={confirmLabel}
          variant="white"
          disabled={!ready}
          onPress={() => onConfirm(value.trim())}
        />
      </View>
    </Shell>
  );
}

/**
 * Choose a destination folder.
 *
 * A list rather than drag-and-drop: React Native Web has no dependable
 * HTML5 drag target, and the alternative is a gesture library — a new native
 * dependency, which this repo gates carefully and which would buy an
 * interaction that is worse on a phone anyway. A list is also the only version
 * that works with a keyboard.
 */
export function MovePicker({
  title,
  description,
  folders,
  currentFolder,
  onCancel,
  onConfirm,
}: {
  title: string;
  /** A consequence worth reading before choosing — see `sharesBreakingWarning`. */
  description?: string;
  folders: readonly string[];
  currentFolder: string;
  onCancel: () => void;
  onConfirm: (folder: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const [chosen, setChosen] = useState<string | null>(null);

  return (
    <Shell title={title} onClose={onCancel}>
      {description ? <Text variant="paneSub">{description}</Text> : null}
      <Text variant="paneSub">Pick where it should live. Nothing is overwritten.</Text>
      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {folders.map((folder) => {
          const here = folder === currentFolder;
          return (
            <PressRow
              key={folder || "/"}
              accessibilityLabel={folder === "" ? "the root of your context" : folder}
              selected={folder === chosen}
              onPress={() => setChosen(folder)}
              radius={radii.sm}
              style={styles.listRow}
              hoverStyle={styles.listRowHover}
              selectedStyle={styles.listRowOn}
            >
              <Text variant="tree" style={folder === chosen ? styles.listRowOnLabel : undefined}>
                {folder === "" ? "/ (root)" : folder}
              </Text>
              {here ? (
                <Text variant="treeMeta" style={styles.listRowMeta}>
                  where it is now
                </Text>
              ) : null}
            </PressRow>
          );
        })}
      </ScrollView>
      <View style={styles.actions}>
        <Button label="Cancel" onPress={onCancel} />
        <Button
          label="Move here"
          variant="white"
          disabled={chosen === null || chosen === currentFolder}
          onPress={() => onConfirm(chosen!)}
        />
      </View>
    </Shell>
  );
}

/** A plain confirmation. Used for archiving, which is recoverable. */
export function Confirm({
  title,
  body,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Shell title={title} onClose={onCancel}>
      <Text variant="paneSub">{body}</Text>
      <View style={styles.actions}>
        <Button label="Cancel" onPress={onCancel} />
        <Button label={confirmLabel} variant="white" onPress={onConfirm} />
      </View>
    </Shell>
  );
}

/**
 * Permanent deletion.
 *
 * Its own component, and it asks you to type the name.
 *
 * That is not friction for its own sake. Archive is reversible — it puts a note
 * in `4-archive/` with its original path intact. This one is not, by design:
 * leaving a hidden copy behind would make the sentence below a lie, in the one
 * product whose entire claim is that you know where your data is. So the
 * sentence is plain, the button is not the default, and you have to spell the
 * name out.
 *
 * The sentence itself lives in `paths.ts` as `describeDeleteForever`, next to
 * the note explaining what it may and may not claim. It has now been wrong in
 * both directions: it claimed "there is no copy kept anywhere" while `.history/`
 * snapshots meant there was, and later claimed deletion "cannot be undone" after
 * this product started telling people to enable versioning at their provider —
 * which is the one setting that makes the noncurrent version outlive the delete.
 * We cannot see that setting, so the sentence names the condition instead of
 * guessing which side of it somebody is on.
 */
export function DeleteForever({
  path,
  isFolder,
  onCancel,
  onConfirm,
}: {
  path: string;
  isFolder: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const [typed, setTyped] = useState("");
  const name = path.slice(path.lastIndexOf("/") + 1);
  const ready = typed.trim() === name;

  return (
    <Shell title="Delete permanently" onClose={onCancel}>
      <Text variant="paneSub">{describeDeleteForever(path, isFolder)}</Text>
      <View style={styles.hint}>
        <Text variant="hint">
          If you might want it back, archive it instead. Archiving moves it to{" "}
          <Text variant="hint" style={styles.hintStrong}>
            4-archive/
          </Text>{" "}
          and you can move it straight back.
        </Text>
      </View>
      <Text variant="eyebrow">Type {name} to confirm</Text>
      <TextInput
        value={typed}
        onChangeText={setTyped}
        autoFocus
        style={styles.input}
        placeholder={name}
        placeholderTextColor={colors.muted}
        accessibilityLabel={`Type ${name} to confirm permanent deletion`}
      />
      <View style={styles.actions}>
        <Button label="Cancel" variant="white" onPress={onCancel} />
        <Button
          label="Delete permanently"
          variant="danger"
          disabled={!ready}
          onPress={onConfirm}
        />
      </View>
    </Shell>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: "rgba(3,3,4,.72)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  card: {
    width: "100%",
    maxWidth: 460,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radii.card,
    backgroundColor: colors.surface2,
    paddingVertical: 22,
    paddingHorizontal: 24,
    boxShadow: "0 40px 100px -30px rgba(0,0,0,1)",
  },
  body: { marginTop: 12, gap: 12 },
  input: {
    fontFamily: fonts.mono,
    fontSize: 13,
    color: colors.text,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radii.lg,
    backgroundColor: colors.well,
  },
  actions: { flexDirection: "row", gap: 10, marginTop: 4 },
  list: {
    maxHeight: 220,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.lg,
    backgroundColor: colors.well,
  },
  listContent: { padding: 7 },
  listRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 9,
    borderRadius: radii.sm,
  },
  listRowHover: { backgroundColor: colors.surface3 },
  listRowOn: { backgroundColor: colors.accentDim },
  listRowOnLabel: { color: colors.accentText },
  listRowMeta: { marginLeft: "auto" },
  hint: {
    paddingVertical: 12,
    paddingHorizontal: 15,
    borderRadius: radii.xl,
    backgroundColor: colors.hintWash,
    borderWidth: 1,
    borderColor: colors.hintBorder,
  },
  hintStrong: { color: colors.hintStrong, fontFamily: fonts.mono },
});
