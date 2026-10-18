import { useEffect, useState } from "react";
import { View } from "react-native";
import { Button } from "../../../design/components/Button";
import { Text } from "../../../design/components/Text";
import { useThemedStyles } from "../../../design/theme";
import { toFileError, type FileBrowser } from "../../files/browser";
import { missingMainRoles } from "@context/shared/src/folderRoles.cjs";
import { addFoldersLabel, mainFolderLines, rootFolderNames } from "../../files/mainFolderOffers";
import { makeStyles } from "./styles";
import { pathCrumbs, type FolderJobsAnswer } from "../../files/folderJobsView";

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
  onChoose,
}: {
  files: FileBrowser;
  /** Answers the band for good (`useInAppMessage`'s dismiss). */
  dismiss: () => void;
  /** Opens Settings › Built-in folders. */
  onChoose?: () => void;
}) {
  // With a server, the band asks which folders do the jobs, wherever they are
  // nested (owner, 2026-10-18, board 4): an import's own `00 Inbox` is used,
  // never a second Inbox beside it.
  if (files.folderJobs !== undefined && files.setFolderJob !== undefined) {
    return <WhichFoldersNotice files={files} dismiss={dismiss} onChoose={onChoose} />;
  }
  return <AddMainFoldersNotice files={files} dismiss={dismiss} />;
}

/**
 * "Which folders do these jobs?": for each needed job no folder does, the
 * folder whose name says it (with why), else "+ Make" it. "Use these" gives
 * each guess its job and makes the rest; nothing moves. Drawn only once the
 * server says a needed job is missing, so a vault whose folders already do
 * every job never sees it.
 */
function WhichFoldersNotice({
  files,
  dismiss,
  onChoose,
}: {
  files: FileBrowser;
  dismiss: () => void;
  onChoose?: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const [answer, setAnswer] = useState<FolderJobsAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const read = files.folderJobs!;
  const write = files.setFolderJob!;

  useEffect(() => {
    let live = true;
    void read().then(
      (next) => live && setAnswer(next),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [read]);

  if (answer === null || answer.missingNeeded.length === 0) return null;
  const label = (job: string) => answer.jobs.find((row) => row.job === job)?.label ?? job;
  const lines = answer.missingNeeded.map((job) => ({ job, guess: answer.guesses.find((guess) => guess.job === job) ?? null }));

  async function use() {
    setBusy(true);
    setError(null);
    try {
      for (const line of lines) {
        if (line.guess !== null) await write(line.job, line.guess.path);
        else await files.addBuiltInFolder(line.job);
      }
      dismiss();
    } catch (failure) {
      setError(toFileError(failure).message);
      setBusy(false);
    }
  }

  return (
    <View style={styles.notice} testID="browse-main-folders">
      <Text variant="hint">Which folders do these jobs?</Text>
      <Text variant="meta">
        Your AI files things best when it knows your Inbox, Projects and Archive. Going by your folders' names; nothing moves.
      </Text>
      <View>
        {lines.map((line) => (
          <Text key={line.job} variant="meta" testID={`main-folder-line-${line.job}`}>
            {line.guess === null
              ? `+ Make ${label(line.job)}`
              : `${label(line.job)}: ${pathCrumbs(line.guess.path)} (${line.guess.why})`}
          </Text>
        ))}
      </View>
      <View style={styles.noticeActions}>
        <Button label="Use these" onPress={() => void use()} disabled={busy} testID="main-folders-add" />
        {onChoose === undefined ? null : <Button label="Choose" onPress={onChoose} disabled={busy} testID="main-folders-choose" />}
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

/** "Add the five main folders?", where there is no server to ask (the demo). */
function AddMainFoldersNotice({
  files,
  dismiss,
}: {
  files: FileBrowser;
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
