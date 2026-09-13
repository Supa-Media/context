import { useState, type ReactNode } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { Button, PressRow } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { fonts, radii } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { describeNameProblem } from "./paths";

/**
 * The console's dialogs.
 *
 * Three shapes, in the mockup's language: a shell, a name prompt, and a
 * destination picker.
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

/**
 * What `New note` and `New folder` say about where the thing is going, in one
 * place because two surfaces now raise them: the explorer's own pair of
 * buttons, and the chooser below that a phone's `+` opens.
 */
export function newNoteHint(folder: string): string {
  return `It will be created in ${folder || "the root of your context"} as markdown.`;
}
export const NEW_FOLDER_HINT =
  "A bucket has no empty folders, so this also writes a README.md inside it — visible in Obsidian and to every other tool that reads your bucket.";

/**
 * `+`, on a surface with room for exactly one of it.
 *
 * ## Why this exists
 *
 * The explorer's toolbar carries a New note button and a New folder button
 * side by side. A phone has no explorer — the tree is gone at that density —
 * so its bottom bar carries a single `+`, and that `+` meant *note*. Which
 * left **no way to make a folder on a phone at all**: not in the bar, not in
 * the folder view, not behind a long press. The owner found it by needing one.
 *
 * ## Why a chooser rather than a second button
 *
 * `BottomBar`'s own rule is that a fixed strip must not move items out from
 * under a thumb, and it is already seven keys wide at 390pt. An eighth for the
 * rarer of the two operations would cost every other key its width. So the one
 * key asks, which is also the honest reading of `+`: it never said "note".
 *
 * The two rows are the whole dialog — picking one swaps this for the same
 * `NamePrompt` the explorer raises, with the same sentence about where the
 * thing is going, because a phone and a desktop disagreeing about that is how
 * two dialogs with one name start to drift.
 */
export function CreatePrompt({
  folder,
  onCancel,
  onCreateNote,
  onCreateFolder,
}: {
  folder: string;
  onCancel: () => void;
  onCreateNote: (name: string) => void;
  onCreateFolder: (name: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const [kind, setKind] = useState<"note" | "folder" | null>(null);

  if (kind === "note") {
    return (
      <NamePrompt
        title="New note"
        description={newNoteHint(folder)}
        confirmLabel="Create"
        onCancel={onCancel}
        onConfirm={onCreateNote}
      />
    );
  }
  if (kind === "folder") {
    return (
      <NamePrompt
        title="New folder"
        description={NEW_FOLDER_HINT}
        confirmLabel="Create"
        onCancel={onCancel}
        onConfirm={onCreateFolder}
      />
    );
  }

  return (
    <Shell title="Create" onClose={onCancel}>
      <Text variant="paneSub">
        {`In ${folder || "the root of your context"}.`}
      </Text>
      <View style={styles.choices}>
        <PressRow
          accessibilityLabel="New note"
          onPress={() => setKind("note")}
          style={styles.choiceRow}
          hoverStyle={styles.listRowHover}
        >
          <Text variant="body">Note</Text>
          <Text variant="paneSub">A markdown file you can write in.</Text>
        </PressRow>
        <PressRow
          accessibilityLabel="New folder"
          onPress={() => setKind("folder")}
          style={styles.choiceRow}
          hoverStyle={styles.listRowHover}
        >
          <Text variant="body">Folder</Text>
          <Text variant="paneSub">A place to file notes. Starts with a README.md.</Text>
        </PressRow>
      </View>
      <View style={styles.actions}>
        <Button label="Cancel" onPress={onCancel} />
      </View>
    </Shell>
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
  /**
   * The two rows of the create chooser.
   *
   * In the same well the destination picker's list sits in, so the thing being
   * chosen from reads the same on both dialogs — but with no `maxHeight`,
   * because there are exactly two rows and a scroller around two rows says
   * there might be more.
   */
  choices: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.lg,
    backgroundColor: colors.well,
    overflow: "hidden",
  },
  /**
   * A row of the chooser. Taller than the destination picker's rows because it
   * carries two lines and is a thumb target rather than a list to scan — this
   * dialog only exists on the density where the pointer does not.
   */
  choiceRow: { gap: 2, paddingVertical: 12, paddingHorizontal: 14 },
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
