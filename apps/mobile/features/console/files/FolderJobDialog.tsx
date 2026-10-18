/**
 * "Use this folder as…": give the folder a built-in job (owner, 2026-10-18,
 * "Built-in folder jobs" board 3). Each job with its one line and, where
 * another folder does it now, which; picking one asks once, saying nothing
 * moves, then the server gives the job (`builtInFolders.setJob`).
 */

import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { Button } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { Shell } from "./DialogShell";
import { toFileError, type FileBrowser } from "./browser";
import { jobChoicesFor, pathCrumbs, type FolderJobsAnswer } from "./folderJobsView";

export function FolderJobDialog({
  files,
  path,
  sheet = false,
  onClose,
}: {
  files: Pick<FileBrowser, "folderJobs" | "setFolderJob">;
  path: string;
  sheet?: boolean;
  onClose: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const [answer, setAnswer] = useState<FolderJobsAnswer | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const read = files.folderJobs;
  const write = files.setFolderJob;

  useEffect(() => {
    if (read === undefined) return;
    let live = true;
    void read().then(
      (next) => live && setAnswer(next),
      (failure) => live && setProblem(toFileError(failure).message),
    );
    return () => {
      live = false;
    };
  }, [read]);

  const choices = answer === null ? [] : jobChoicesFor(answer, path);
  const picked = choices.find((choice) => choice.job === chosen) ?? null;
  const name = pathCrumbs(path);

  async function use() {
    if (picked === null || write === undefined) return;
    setBusy(true);
    setProblem(null);
    try {
      await write(picked.job, path);
      onClose();
    } catch (failure) {
      setProblem(toFileError(failure).message);
      setBusy(false);
    }
  }

  return (
    <Shell title="Use this folder as…" onClose={onClose} sheet={sheet}>
      {picked === null ? (
        <>
          <Text variant="paneSub">{name}</Text>
          {answer === null ? (
            <Text variant="hint">{problem ?? "Reading…"}</Text>
          ) : (
            <View style={styles.list}>
              {choices.map((choice) => (
                <Pressable
                  key={choice.job}
                  style={styles.choice}
                  onPress={() => (choice.current ? undefined : setChosen(choice.job))}
                  disabled={choice.current}
                  accessibilityRole="button"
                  accessibilityLabel={`Use as ${choice.label}`}
                  testID={`folder-job-${choice.job}`}
                >
                  <View style={styles.flex}>
                    <Text variant="rowTitle">{choice.label}</Text>
                    <Text variant="rowSub">{choice.line}</Text>
                  </View>
                  <Text variant="meta">{choice.current ? "This folder" : choice.now === null ? "" : `now ${pathCrumbs(choice.now)}`}</Text>
                </Pressable>
              ))}
            </View>
          )}
        </>
      ) : (
        <>
          <Text variant="body">
            Use {name} as your {picked.label} folder? Nothing moves: Context starts filing here
            {picked.now === null ? "." : `, and ${pathCrumbs(picked.now)} keeps everything in it as an ordinary folder.`}
          </Text>
          <View style={styles.actions}>
            <Button label={`Use as ${picked.label}`} variant="dialogPrimary" disabled={busy} onPress={() => void use()} testID="folder-job-confirm" />
            <Button label="Back" variant="dialog" disabled={busy} onPress={() => setChosen(null)} />
          </View>
        </>
      )}
      {problem !== null && answer !== null ? <Text variant="error">{problem}</Text> : null}
    </Shell>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    list: { gap: 0 },
    choice: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      paddingVertical: space.x2,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderColor: colors.lineStrong,
    },
    actions: { flexDirection: "row", gap: space.x2, flexWrap: "wrap" },
    flex: { flex: 1, minWidth: 0 },
  });
