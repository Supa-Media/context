import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { radii, space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { toFileError, type FileBrowser } from "./browser";
import { addFolderChoices } from "./addFolderChoices";
import { Shell } from "./DialogShell";
import { NewFolderForm } from "./NewFolderForm";

/**
 * "Add a folder" at the top of the workspace (owner-approved mockup): the
 * built-in folders the workspace does not have yet, then "A folder of your own…".
 *
 * Choosing a built-in makes it under its fixed name and closes the sheet; the
 * server's refusal stays in the sheet, so a folder that already exists says so
 * where the person is looking. "A folder of your own…" turns this same sheet
 * into the New folder form, rather than opening a second dialog on top of it.
 */
export function AddFolderSheet({
  files,
  names,
  folders,
  rootLabel,
  compact,
  onAdded,
  onClose,
}: {
  files: FileBrowser;
  /** The top-level folder names the workspace has now. */
  names: readonly string[];
  /** Every folder the New folder form's picker offers. */
  folders: readonly string[];
  rootLabel: string;
  /** A phone opens the folder it has just made; a pointer layout keeps its place. */
  compact: boolean;
  /** Called with the new folder's path once it exists, before the sheet closes. */
  onAdded?: (path: string) => void;
  onClose: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [own, setOwn] = useState(false);

  if (own) {
    return (
      <NewFolderForm
        folder=""
        folders={folders}
        rootLabel={rootLabel}
        onCancel={() => setOwn(false)}
        onCreate={(place, name) => {
          onClose();
          files.createFolder(place, name, { open: compact });
        }}
      />
    );
  }

  const choices = addFolderChoices(names);

  async function choose(role: string) {
    setBusy(true);
    setError(null);
    try {
      const path = await files.addBuiltInFolder(role);
      onAdded?.(path);
      onClose();
    } catch (failure) {
      setError(toFileError(failure).message);
      setBusy(false);
    }
  }

  return (
    <Shell title="Add a folder" onClose={onClose}>
      {choices.length === 0 ? (
        <Text variant="paneSub" testID="add-folder-none">
          Every built-in folder is already here.
        </Text>
      ) : (
        <View style={styles.list}>
          {choices.map((choice) => (
            <Pressable
              key={choice.role}
              role="button"
              accessibilityLabel={`${choice.label}. ${choice.description}`}
              accessibilityState={{ disabled: busy }}
              disabled={busy}
              onPress={() => void choose(choice.role)}
              style={({ pressed }) => [styles.choice, pressed ? styles.pressed : null]}
              testID={`add-folder-choice-${choice.role}`}
            >
              <Text variant="rowTitle">{choice.label}</Text>
              <Text variant="meta" style={styles.description}>
                {choice.description}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
      <Pressable
        role="button"
        accessibilityLabel="A folder of your own"
        accessibilityState={{ disabled: busy }}
        disabled={busy}
        onPress={() => setOwn(true)}
        style={({ pressed }) => [styles.own, pressed ? styles.pressed : null]}
        testID="add-folder-own"
      >
        <Text variant="meta" style={styles.ownLabel}>
          A folder of your own…
        </Text>
      </Pressable>
      {error === null ? null : (
        <Text variant="rowSub" style={styles.error} testID="add-folder-error">
          {error}
        </Text>
      )}
      <View style={styles.actions}>
        <Button label="Cancel" variant="dialog" onPress={onClose} disabled={busy} />
      </View>
    </Shell>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    list: { gap: space.x2 },
    choice: {
      paddingVertical: space.x2,
      paddingHorizontal: space.x3,
      borderRadius: radii.sm,
      borderWidth: 1,
      borderColor: colors.line,
      gap: 2,
    },
    description: { color: colors.muted },
    own: { paddingVertical: space.x2, paddingHorizontal: space.x3 },
    ownLabel: { color: colors.text2 },
    pressed: { opacity: 0.6 },
    error: { color: colors.crit },
    actions: { flexDirection: "row", gap: space.x2, flexWrap: "wrap", marginTop: space.x2 },
  });
