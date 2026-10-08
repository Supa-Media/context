import { useState } from "react";
import { View } from "react-native";
import { Button } from "../../../design/components/Button";
import { Text } from "../../../design/components/Text";
import { useThemedStyles } from "../../../design/theme";
import { toFileError, type FileBrowser } from "../../files/browser";
import { missingMainRoles } from "@context/shared/src/folderRoles.cjs";
import { addFoldersLabel, mainFolderLines, rootFolderNames } from "../../files/mainFolderOffers";
import { makeStyles } from "./styles";

/**
 * "Add the five main folders?": the band for the owner of a workspace that is
 * missing one of the main folders. Each main folder is either named as found,
 * or listed as "+ Add <folder>"; "Add N folders" makes the missing ones in
 * order, and "Not now" is final (the answer is kept on the account).
 *
 * A failed add stays on screen with the server's sentence, and the band is not
 * dismissed, so the person can try again. Folders that were made before the
 * failure are no longer missing when the band redraws, so a retry adds only
 * what is left.
 */
export function MainFoldersNotice({
  files,
  dismiss,
}: {
  files: FileBrowser;
  /** Answers the band for good (`useInAppMessage`'s dismiss). */
  dismiss: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const names = rootFolderNames(files.listings[""]);
  const lines = mainFolderLines(names);
  const missing = missingMainRoles(names);

  async function add() {
    setBusy(true);
    setError(null);
    try {
      for (const role of missing) await files.addBuiltInFolder(role);
      dismiss();
    } catch (failure) {
      setError(toFileError(failure).message);
      setBusy(false);
    }
  }

  return (
    <View style={styles.notice} testID="browse-main-folders">
      <Text variant="hint">Add the five main folders?</Text>
      <Text variant="meta">
        Your AI files things best when every workspace has them. Your own folders stay exactly as they are.
      </Text>
      <View>
        {lines.map((line) => (
          <Text key={line.role} variant="meta" testID={`main-folder-line-${line.role}`}>
            {line.found === null
              ? `+ Add ${line.label}`
              : `✓ ${line.label} (${line.found})`}
          </Text>
        ))}
      </View>
      <View style={styles.noticeActions}>
        <Button
          label={addFoldersLabel(missing.length)}
          onPress={() => void add()}
          disabled={busy}
          testID="main-folders-add"
        />
        <Button label="Not now" onPress={dismiss} disabled={busy} testID="main-folders-dismiss" />
      </View>
      {error === null ? null : (
        <Text variant="rowSub" testID="main-folders-error">
          {error}
        </Text>
      )}
    </View>
  );
}
