/**
 * A job's Setups tab (board 17; the owner, 2026-10-16: "we should only be
 * showing setups that are live, and setups that are being presently
 * experimented with, unless we click a button to show old setups … a simple
 * way to archive setups"). Live on top, then the experiments still in play,
 * then "Show archived" for everything retired, lost or untouched for two
 * weeks (`archivedSetup`). Archive moves the note under
 * `ai/setups/retired/<job>/`, where the bench no longer pulls it; Restore
 * moves it back. Nothing is deleted.
 *
 * A score says how sure it is: runs passed with a likely range, and against
 * live "Better", "Worse" or "Too close to call" (`./aiExperiments`).
 */

import { useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Text, space, useThemedStyles, type Colors } from "../design";
import { Box, Cell, Head, LinkText, Quietly, StatusPill, TableLine, pct, shortDay, type Column } from "./AiKit";
import { archivedSetup, gapLabel, passedRange, setupTitle } from "./aiExperiments";
import { sizeDelta, type Candidate, type JobPage } from "./aiModel";
import { messageOf, useNoteMoves } from "./useAiNote";
import type { Id } from "@context/convex/_generated/dataModel";

const COLUMNS: readonly Column[] = [
  { label: "SETUP", flex: 1 },
  { label: "PASSED", width: 170 },
  { label: "AGAINST LIVE", width: 200 },
  { label: "CHANGED", width: 110 },
  { label: "", width: 150, align: "right" },
];

/** The line under a setup's name: what it changes, then its file name, small. */
function setupLine(candidate: Candidate, live: boolean): string {
  if (live) return candidate.name;
  return [candidate.change, candidate.name].filter(Boolean).join(" · ");
}

/** Runs passed with its range, or the old percentage for a round without a case table. */
function passedCell(candidate: Candidate): ReactNode {
  if (candidate.passed !== null) {
    return <Cell title={`${candidate.passed.passed} of ${candidate.passed.runs} runs`} sub={passedRange(candidate.passed)} strong />;
  }
  if (candidate.score !== null) return <Cell title={pct(candidate.score.score)} sub={candidate.run ? `round ${candidate.run.name.match(/gh-\d+/)?.[0] ?? ""}`.trim() : null} strong />;
  return <Cell title="Not run yet" strong />;
}

function againstCell(candidate: Candidate, live: boolean): ReactNode {
  if (live) return <Cell title="—" sub="it is live" />;
  if (candidate.claimed === "draft") return <Cell title="Needs a person" sub="check it before it runs" tone="warn" />;
  if (candidate.gap !== null) {
    const tone = candidate.status === "beat live" ? "ok" : candidate.status === "lost" ? "crit" : "warn";
    const word = candidate.status === "beat live" ? "Better than live" : candidate.status === "lost" ? "Worse than live" : "Too close to call";
    return <Cell title={word} sub={gapLabel(candidate.gap)} tone={tone} />;
  }
  if (candidate.score === null) return <Cell title="—" sub="run tests to see" />;
  return <StatusPill status={candidate.status} />;
}

/** Against live in a word, for the phone's one line under a setup. */
function againstWord(candidate: Candidate): string | null {
  if (candidate.claimed === "draft") return "Needs a person";
  if (candidate.status === "beat live") return "Better than live";
  if (candidate.status === "lost") return "Worse than live";
  if (candidate.status === "too close") return "Too close to call";
  return candidate.score === null ? "Not run yet" : null;
}

export function AiSetups({ page, workspaceId, reload, openInNotes, openCompare, now = Date.now() }: {
  page: JobPage;
  workspaceId: Id<"workspaces">;
  reload: () => void;
  openInNotes: (path: string) => void;
  openCompare: (setup: string) => void;
  now?: number;
}) {
  const styles = useThemedStyles(makeStyles);
  const moves = useNoteMoves(workspaceId);
  const [showArchived, setShowArchived] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const all = [...page.candidates, ...page.retired];
  const live = all.find((item) => item.status === "live") ?? null;
  const experiments = all.filter((item) => item !== live && !archivedSetup(item, now));
  const archived = all.filter((item) => item !== live && archivedSetup(item, now));
  const job = page.job.key;

  const move = async (candidate: Candidate, to: string) => {
    setBusy(candidate.row.path);
    setProblem(null);
    try {
      await moves.move(candidate.row.path, to);
      reload();
    } catch (error: unknown) {
      setProblem(messageOf(error));
    } finally {
      setBusy(null);
    }
  };
  const archive = (candidate: Candidate) => void move(candidate, `ai/setups/retired/${job}/${candidate.name}.md`);
  const restore = (candidate: Candidate) => void move(candidate, `ai/setups/${job}/${candidate.name}.md`);

  const actions = (candidate: Candidate, isLive: boolean): ReactNode => {
    if (busy === candidate.row.path) return <Text variant="meta" style={styles.muted}>Moving…</Text>;
    if (isLive) return <LinkText label="View" onPress={() => openInNotes(candidate.row.path)} testID={`admin-ai-setup-view-${candidate.name}`} />;
    const first =
      candidate.score !== null ? (
        <LinkText label="Compare" onPress={() => openCompare(candidate.name)} testID={`admin-ai-setup-compare-${candidate.name}`} />
      ) : (
        <LinkText label={candidate.claimed === "draft" ? "Check it" : "Edit"} onPress={() => openInNotes(candidate.row.path)} testID={`admin-ai-setup-edit-${candidate.name}`} />
      );
    // Only a setup in `retired/` comes back by moving; one that lost or went stale was never moved.
    const second = candidate.retired ? (
      <LinkText label="Restore" onPress={() => restore(candidate)} testID={`admin-ai-setup-restore-${candidate.name}`} />
    ) : (
      <LinkText label="Archive" onPress={() => archive(candidate)} testID={`admin-ai-setup-archive-${candidate.name}`} />
    );
    return (
      <View style={styles.actions}>
        {first}
        {second}
      </View>
    );
  };

  const table = (rows: readonly Candidate[], isLive: boolean, testID: string) => (
    <View testID={testID}>
      <Head columns={COLUMNS} />
      {rows.map((candidate, index) => {
        const delta = isLive ? null : sizeDelta(candidate.size, candidate.baseSize);
        return (
          <TableLine
            key={candidate.row.path}
            columns={COLUMNS}
            cells={[
              <Cell key="name" title={setupTitle(candidate)} sub={setupLine(candidate, isLive)} strong />,
              <View key="passed">{passedCell(candidate)}</View>,
              <View key="against">{againstCell(candidate, isLive)}</View>,
              <Cell key="changed" title={shortDay(candidate.row.updatedAt, now)} sub={delta === null ? null : `${delta} tokens`} />,
              <View key="actions" style={styles.actionCell}>{actions(candidate, isLive)}</View>,
            ]}
            title={setupTitle(candidate)}
            sub={[isLive ? null : againstWord(candidate), isLive ? candidate.name : (candidate.change ?? candidate.name), candidate.passed ? `${candidate.passed.passed} of ${candidate.passed.runs} runs` : null].filter(Boolean).join(" · ")}
            trailing={actions(candidate, isLive)}
            first={index === 0}
            last={index === rows.length - 1}
            testID={`admin-ai-setup-${candidate.name}`}
          />
        );
      })}
    </View>
  );

  return (
    <View style={styles.wrap} testID="admin-ai-setups">
      {problem ? <Text variant="meta" style={styles.problem} testID="admin-ai-setups-problem">{problem}</Text> : null}
      <Box title="Live">
        {live === null ? <Quietly>Production names no setup it came from.</Quietly> : table([live], true, "admin-ai-setups-live")}
      </Box>
      <Box title={`Experiments · ${experiments.length}`} testID="admin-ai-experiments">
        {experiments.length === 0 ? <Quietly testID="admin-ai-no-experiments">Nothing is being tried. New experiment copies live to start one.</Quietly> : table(experiments, false, "admin-ai-setups-experiments")}
        <View style={styles.foot}>
          <LinkText
            label={showArchived ? `Hide archived (${archived.length})` : `Show archived (${archived.length})`}
            onPress={() => setShowArchived((was) => !was)}
            testID="admin-ai-toggle-archived"
          />
          <Text variant="meta" style={styles.muted} numberOfLines={1}>lost, retired, or untouched for 14 days</Text>
        </View>
      </Box>
      {showArchived ? (
        <Box title={`Archived · ${archived.length}`} testID="admin-ai-archived">
          {archived.length === 0 ? <Quietly>Nothing archived.</Quietly> : table(archived, false, "admin-ai-setups-archived")}
        </Box>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    wrap: { gap: space.x4, minWidth: 0 },
    actions: { flexDirection: "row", gap: space.x3, justifyContent: "flex-end" },
    actionCell: { alignItems: "flex-end" },
    foot: { flexDirection: "row", alignItems: "center", gap: space.x2, paddingTop: space.x3, flexWrap: "wrap" },
    muted: { color: colors.muted },
    problem: { color: colors.critText },
  });
