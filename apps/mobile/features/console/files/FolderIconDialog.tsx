import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { WORKSPACE_ICON_EMOJI } from "@context/shared";
import { Button } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { pointerType as t, radii, space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { toFileError } from "./browser";
import { Shell } from "./DialogShell";
import { baseName, folderLabel } from "./paths";

/**
 * "Set icon…" on a folder: a grid of emoji, and a way to take the icon back off.
 *
 * The same curated list as the workspace's own icon (`WORKSPACE_ICON_EMOJI`),
 * so the two pickers offer the same faces. A tap sets the icon and closes; the
 * dialog stays open until the server has answered, so a refusal (an editor
 * who lost their role mid-session, say) is read here rather than lost behind
 * the closed sheet. "Remove icon" is there only when the folder has one, for
 * the reason every other control in the console that would do nothing is
 * absent rather than present.
 */
export function FolderIconDialog({
  path,
  current,
  onSet,
  onClose,
}: {
  path: string;
  /** The folder's icon now, or `null`. */
  current: string | null;
  /** Rejects with the server's refusal, which is shown here. */
  onSet: (icon: string | null) => Promise<void>;
  onClose: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function choose(icon: string | null) {
    setBusy(true);
    setError(null);
    try {
      await onSet(icon);
      onClose();
    } catch (failure) {
      setError(toFileError(failure).message);
      setBusy(false);
    }
  }

  return (
    <Shell title="Folder icon" onClose={onClose}>
      <Text variant="paneSub" testID="folder-icon-name">
        {folderLabel(baseName(path))}
      </Text>
      <View style={styles.grid}>
        {WORKSPACE_ICON_EMOJI.map((emoji) => {
          const chosen = current === emoji;
          return (
            <Pressable
              key={emoji}
              role="button"
              accessibilityLabel={`Use ${emoji} as this folder’s icon`}
              accessibilityState={{ selected: chosen, disabled: busy }}
              disabled={busy}
              onPress={() => void choose(emoji)}
              style={[styles.cell, chosen && styles.cellChosen]}
              testID={`folder-icon-emoji-${emoji}`}
            >
              <Text style={styles.glyph}>{emoji}</Text>
            </Pressable>
          );
        })}
      </View>
      <View style={styles.actions}>
        <Button label="Cancel" variant="dialog" onPress={onClose} disabled={busy} />
        {current === null ? null : (
          <Button
            label="Remove icon"
            variant="dialog"
            onPress={() => void choose(null)}
            disabled={busy}
            testID="folder-icon-remove"
          />
        )}
      </View>
      {error === null ? null : (
        <Text variant="rowSub" style={styles.error} testID="folder-icon-error">
          {error}
        </Text>
      )}
    </Shell>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    // Wraps and does not scroll, for the reason `WorkspaceIconPicker`'s grid does.
    grid: { flexDirection: "row", flexWrap: "wrap", gap: space.x2 },
    cell: {
      width: 44,
      height: 44,
      borderRadius: radii.sm,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: "transparent",
    },
    cellChosen: { borderColor: colors.accent, backgroundColor: colors.accentDim },
    glyph: { fontSize: t.title, lineHeight: 36 },
    actions: { flexDirection: "row", gap: space.x2, flexWrap: "wrap", marginTop: space.x2 },
    error: { color: colors.crit },
  });
