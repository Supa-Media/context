/**
 * Settings › Built-in folders: every job, what Context does with it, and the
 * folder doing it wherever it is nested (owner, 2026-10-18, "Built-in folder
 * jobs" boards 2, 4 and 6; `docs/decisions/app-and-console/folder-jobs.md`).
 *
 * Three groups: needed (can move, never removed), made when used (Tex,
 * Website), optional (Clients, Teams, Products). The Inbox's own folders are
 * one sentence under the Inbox, not a row each. "Change" picks any folder and
 * nothing moves; guesses from an import's folder names come first, each with
 * its reason. Only an owner is offered changes: the server says so too.
 */

import { useCallback, useEffect, useState } from "react";
import { StyleSheet, View, useWindowDimensions } from "react-native";

import { Button } from "../../../design/components/Button";
import { Card } from "../../../design/components/Card";
import { Text } from "../../../design/components/Text";
import { TextLink } from "../../../design/components/TextLink";
import { space } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { EmojiGlyph } from "../../emoji/EmojiGlyph";
import { PlacePicker } from "../../files/PlacePicker";
import { toFileError, type FileBrowser } from "../../files/browser";
import { jobIconMarker } from "../../files/jobIcons/marker";
import { isRowRole } from "@context/shared/src/folderRoles.cjs";
import { groupedJobs, inboxPartsLine, pathCrumbs, type FolderJobRow, type FolderJobsAnswer } from "../../files/folderJobsView";
import { PanelHead } from "./PanelHead";

/** Narrower than this, a row's folder and buttons go under its words. */
const STACK_BELOW = 720;

export function BuiltInFoldersPanel({ files, sectioned }: { files: FileBrowser; sectioned: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const [answer, setAnswer] = useState<FolderJobsAnswer | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState<string | null>(null);
  const read = files.folderJobs;
  const write = files.setFolderJob;

  const reload = useCallback(async () => {
    if (read === undefined) return;
    try {
      setAnswer(await read());
    } catch (failure) {
      setProblem(toFileError(failure).message);
    }
  }, [read]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** Run one change, show the server's sentence if it refuses, and read the jobs again. */
  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    setProblem(null);
    try {
      await work();
      setPicking(null);
    } catch (failure) {
      setProblem(toFileError(failure).message);
    }
    await reload();
    setBusy(false);
  }

  return (
    <>
      <PanelHead section="folders" sectioned={sectioned}>
        Context and your AI tools treat these folders specially: email lands in your Inbox, the Archive button files
        into Archive. Call them anything and put them anywhere. Each job belongs to one folder.
      </PanelHead>
      {read === undefined ? (
        <Card>
          <Text variant="hint">Built-in folders are shown in a workspace you're signed in to.</Text>
        </Card>
      ) : answer === null ? (
        <Card>
          <Text variant="hint">{problem ?? "Reading…"}</Text>
        </Card>
      ) : (
        <>
          {answer.guesses.length > 0 && write !== undefined ? (
            <Guesses answer={answer} busy={busy} onUse={(pairs) => run(async () => {
              for (const [job, path] of pairs) await write(job, path);
            })} />
          ) : null}
          {groupedJobs(answer).map((group) => (
            <View key={group.group} style={styles.group} testID={`folders-group-${group.group}`}>
              <View style={styles.groupHead}>
                <Text variant="eyebrow">{group.label}</Text>
                <Text variant="meta">{group.hint}</Text>
              </View>
              <Card style={styles.card}>
                {group.jobs.map((row, index) => (
                  <JobLine
                    key={row.job}
                    row={row}
                    first={index === 0}
                    answer={answer}
                    busy={busy}
                    picking={picking === row.job}
                    onPick={() => setPicking(picking === row.job ? null : row.job)}
                    onChoose={write === undefined ? undefined : (path) => run(() => write(row.job, path))}
                    onRemove={write === undefined ? undefined : () => run(() => write(row.job, null))}
                    onAdd={() => run(() => files.addBuiltInFolder(row.job))}
                  />
                ))}
              </Card>
            </View>
          ))}
          {problem === null ? null : (
            <Text variant="error" testID="folders-problem">
              {problem}
            </Text>
          )}
        </>
      )}
    </>
  );
}

/** "Which folders do these jobs?": the server's guesses from folder names, each with its reason (board 4). */
function Guesses({
  answer,
  busy,
  onUse,
}: {
  answer: FolderJobsAnswer;
  busy: boolean;
  onUse: (pairs: [string, string][]) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const label = (job: string) => answer.jobs.find((row) => row.job === job)?.label ?? job;
  return (
    <Card style={styles.card} testID="folders-guesses">
      <Text variant="rowTitle">Which folders do these jobs?</Text>
      <Text variant="rowSub">Going by your folders' names. Nothing moves; Context just starts filing there.</Text>
      {answer.guesses.map((guess) => (
        <View key={guess.job} style={styles.guess}>
          <View style={styles.flex}>
            <Text variant="body">
              {label(guess.job)}: {pathCrumbs(guess.path)}
            </Text>
            <Text variant="meta">{guess.why}</Text>
          </View>
          <Button label="Use" variant="dialog" disabled={busy} onPress={() => onUse([[guess.job, guess.path]])} testID={`folders-guess-${guess.job}`} />
        </View>
      ))}
      {answer.guesses.length > 1 ? (
        <View style={styles.actions}>
          <Button
            label={`Use all ${answer.guesses.length}`}
            variant="dialogPrimary"
            disabled={busy}
            onPress={() => onUse(answer.guesses.map((guess): [string, string] => [guess.job, guess.path]))}
            testID="folders-guesses-all"
          />
        </View>
      ) : null}
    </Card>
  );
}

function JobLine({
  row,
  first,
  answer,
  busy,
  picking,
  onPick,
  onChoose,
  onRemove,
  onAdd,
}: {
  row: FolderJobRow;
  first: boolean;
  answer: FolderJobsAnswer;
  busy: boolean;
  picking: boolean;
  onPick: () => void;
  onChoose: ((path: string) => void) | undefined;
  onRemove: (() => void) | undefined;
  onAdd: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const { width } = useWindowDimensions();
  const stacked = width < STACK_BELOW;
  const [confirming, setConfirming] = useState(false);
  // Archive stays at the top, so only top folders are offered for it.
  const folders = row.job === "archive" ? answer.folders.filter((path) => !path.includes("/")) : answer.folders;
  const makeable = row.path === null && row.canChange && row.job !== "tex";

  return (
    <View style={[styles.line, !first && styles.divided]} testID={`folders-job-${row.job}`}>
      <View style={[styles.lineTop, stacked && styles.lineStacked]}>
        <View style={styles.what}>
          {isRowRole(row.job) ? <EmojiGlyph emoji={jobIconMarker(row.job)} size={20} /> : null}
          <View style={styles.flex}>
            <Text variant="rowTitle">{row.label}</Text>
            <Text variant="rowSub">{row.line}</Text>
            {row.job === "inbox" && answer.inboxParts.length > 0 ? <Text variant="meta">{inboxPartsLine(answer)}</Text> : null}
          </View>
        </View>
        <View style={[styles.where, stacked && styles.whereStacked]}>
          {row.path === null ? (
            <Text variant="meta" style={styles.none}>
              {row.job === "tex" ? "Made the first time Tex is used" : "No folder"}
            </Text>
          ) : (
            <Text variant="body" style={[styles.path, stacked && styles.pathStacked]} testID={`folders-path-${row.job}`}>
              {pathCrumbs(row.path)}
            </Text>
          )}
          <View style={styles.actions}>
            {row.canChange && onChoose !== undefined ? (
              <Button
                label={row.path === null ? "Use a folder" : "Change"}
                variant="dialog"
                disabled={busy}
                onPress={onPick}
                testID={`folders-change-${row.job}`}
              />
            ) : null}
            {makeable ? <Button label="Add" variant="dialog" disabled={busy} onPress={onAdd} testID={`folders-add-${row.job}`} /> : null}
            {row.canRemove && row.path !== null && onRemove !== undefined && !confirming ? (
              <TextLink label="Remove" onPress={() => setConfirming(true)} testID={`folders-remove-${row.job}`} />
            ) : null}
          </View>
        </View>
      </View>
      {confirming && onRemove !== undefined ? (
        <View style={styles.confirm}>
          <Text variant="rowSub">
            Stop using {row.path === null ? "this folder" : pathCrumbs(row.path)} as {row.label}? It keeps everything in it.
          </Text>
          <View style={styles.actions}>
            <Button label="Remove" variant="dialogDanger" disabled={busy} onPress={() => (setConfirming(false), onRemove())} testID={`folders-remove-yes-${row.job}`} />
            <Button label="Cancel" variant="dialog" disabled={busy} onPress={() => setConfirming(false)} />
          </View>
        </View>
      ) : null}
      {picking && onChoose !== undefined ? (
        <View style={styles.picker}>
          <PlacePicker
            folders={folders}
            rootLabel="This workspace"
            initial={row.path ?? ""}
            here={row.path}
            top={false}
            backLabel="Cancel"
            onBack={onPick}
            confirmLabel={(name) => `Use ${name} as ${row.label}`}
            onPick={(path) => onChoose(path)}
          />
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    group: { gap: space.x2, marginBottom: space.x4 },
    groupHead: { flexDirection: "row", alignItems: "baseline", gap: space.x2, flexWrap: "wrap" },
    card: { gap: space.x2 },
    line: { paddingVertical: space.x2, gap: space.x2 },
    divided: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.lineStrong },
    lineTop: { flexDirection: "row", alignItems: "center", gap: space.x3 },
    lineStacked: { flexDirection: "column", alignItems: "stretch" },
    what: { flex: 1, flexDirection: "row", alignItems: "flex-start", gap: space.x3, minWidth: 240 },
    // A long nested path wraps inside its half; it never squeezes the job's words.
    where: { flexDirection: "row", alignItems: "center", gap: space.x3, flexShrink: 1, maxWidth: "50%" },
    path: { flexShrink: 1, textAlign: "right" },
    pathStacked: { textAlign: "left" },
    whereStacked: { paddingLeft: 32, justifyContent: "space-between", flexWrap: "wrap", maxWidth: "100%" },
    none: { fontStyle: "italic" },
    actions: { flexDirection: "row", alignItems: "center", gap: space.x2, flexWrap: "wrap" },
    confirm: { gap: space.x2, paddingLeft: 32 },
    picker: { paddingLeft: 32 },
    guess: { flexDirection: "row", alignItems: "center", gap: space.x3 },
    flex: { flex: 1, minWidth: 0 },
  });
