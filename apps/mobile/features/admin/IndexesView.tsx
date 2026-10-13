/**
 * The Search tab's Indexes view: is every workspace indexed, and the button
 * that fixes the ones that are not.
 *
 * Replaced the stacked Tree index and Search by meaning tables (the owner,
 * 2026-10-08, approved from the mockup): a summary card per index, then one
 * table with a row per workspace and a column per index, opening on the rows
 * that need attention. The rows are `./searchIndexes`; a row's detail and
 * buttons are `./IndexRows`.
 *
 * Three cards since every reader moved to the Convex tree (the owner approved
 * the board, 2026-10-13): the file tree card folds the old Sidebar tree (the
 * D1 tables, now only the details Lists, Boards and the map read) and the
 * migration's Convex copy card into one, and folder moves still copying show
 * on their workspace's row instead of a panel. The card carries the switch
 * that sends everyone back to the bucket (`nodesMigration.setPaused`), still
 * the way back until the bucket readers are removed. Start all, Fill all and
 * Refresh went: `nodesMigration.keepCurrent` copies every due workspace every 15
 * minutes, and a row's Repair does the rest.
 *
 * Search by meaning, the copy and the moves are live queries. The D1 details
 * live in each workspace's own database, so they are an action read on open
 * and again after a Repair.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { Button, Card, Dot, Text, TextField, space, useThemedStyles, type Colors } from "../design";
import { EmptyNote, NoticeLine, Panel, Skeleton } from "./AdminKit";
import { IndexRows, type IndexActions } from "./IndexRows";
import { messageFor } from "./SecretDialogs";
import { Segments } from "./Segments";
import { whenLabel } from "./agent";
import { restartedLine, stuckMeaningCount } from "./meaningIndexes";
import {
  INDEXES,
  countParts,
  healthCounts,
  healthTone,
  joinIndexes,
  matchesFind,
  needsAttention,
  type IndexKey,
  type TreeIndexRow,
  type WorkspaceIndexes,
} from "./searchIndexes";

type Said = { text: string; tone: "ok" | "crit" } | null;

/** How many workspaces need attention, for the red count on the Indexes switch. Null while loading. */
export function useIndexesAttention(): number | null {
  const report = useQuery(api.functions.meaningAdmin.meaningIndexReport, {});
  const migration = useQuery(api.functions.nodesMigration.report, {});
  const moves = useQuery(api.functions.nodeMovesAdmin.report, {});
  return useMemo(
    () =>
      report === undefined
        ? null
        : joinIndexes(null, report.rows, migration?.rows ?? null, migration?.paused ?? false, moves?.rows ?? []).filter(
            needsAttention,
          ).length,
    [report, migration, moves],
  );
}

const checkingLine = (started: number) =>
  started === 0
    ? "Nothing to check yet. A copy is checked once it has finished."
    : started === 1
      ? "Checking 1 workspace against its bucket."
      : `Checking ${started} workspaces against their buckets.`;

export function IndexesView() {
  const styles = useThemedStyles(makeStyles);
  const report = useQuery(api.functions.meaningAdmin.meaningIndexReport, {});
  const readTree = useAction(api.functions.treeAdmin.treeIndexes);
  const fillTree = useAction(api.functions.treeAdmin.fillTreeIndexesNow);
  const restart = useMutation(api.functions.meaningAdmin.restartMeaningIndexing);
  const migration = useQuery(api.functions.nodesMigration.report, {});
  const setMigrationPaused = useMutation(api.functions.nodesMigration.setPaused);
  const startMigration = useMutation(api.functions.nodesMigration.start);
  const checkMigration = useMutation(api.functions.nodesMigration.checkParity);
  const moves = useQuery(api.functions.nodeMovesAdmin.report, {});
  const retryMove = useMutation(api.functions.nodeMovesAdmin.retry);
  const undoMove = useMutation(api.functions.nodeMovesAdmin.undo);
  const [tree, setTree] = useState<TreeIndexRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<Said>(null);
  const [show, setShow] = useState<"attention" | "all">("attention");
  const [find, setFind] = useState("");

  const refreshTree = useCallback(async () => {
    try {
      setTree((await readTree({})).rows);
    } catch (caught) {
      setSaid({ text: messageFor(caught, "Couldn't read the Lists, Boards and map details. Try again."), tone: "crit" });
    }
  }, [readTree]);

  useEffect(() => {
    void refreshTree();
  }, [refreshTree]);

  const rows = useMemo(
    () =>
      report === undefined
        ? null
        : joinIndexes(tree, report.rows, migration?.rows ?? null, migration?.paused ?? false, moves?.rows ?? []),
    [report, tree, migration, moves],
  );
  const paused = migration?.paused ?? false;

  async function act(key: string, work: () => Promise<string>) {
    setBusy(key);
    setSaid(null);
    try {
      setSaid({ text: await work(), tone: "ok" });
    } catch (caught) {
      setSaid({ text: messageFor(caught, "That didn't work. Try again."), tone: "crit" });
    } finally {
      setBusy(null);
    }
  }

  const repair = (workspaceId: string, what: { copy: boolean; fill: boolean }) =>
    act(`repair:${workspaceId}`, async () => {
      const id = workspaceId as Id<"workspaces">;
      if (what.copy) await startMigration({ workspaceId: id });
      if (what.fill) await fillTree({ workspaceId: id });
      if (what.fill) await refreshTree();
      return what.copy && what.fill
        ? "Copying the file tree again and refilling its details."
        : what.copy
          ? "Copying the file tree again."
          : "Refilling the Lists, Boards and map details.";
    });

  const restartMeaning = (workspaceId?: string) =>
    act(workspaceId ? `meaning:${workspaceId}` : "meaning:all", async () => {
      const result = await restart(workspaceId ? { workspaceId: workspaceId as Id<"workspaces"> } : {});
      return restartedLine(result.restarted, result.outcome);
    });

  const togglePaused = () => {
    const next = !paused;
    return act("convex:pause", async () => {
      const { started } = await setMigrationPaused({ paused: next });
      if (next) return "Everyone reads from the bucket now. Each copy stops at its next pass.";
      return `Serving from the file tree again. Restarted ${started === 1 ? "1 workspace" : `${started} workspaces`}.`;
    });
  };

  const checkAll = () =>
    act("convex:check:all", async () => checkingLine((await checkMigration({})).started));

  const checkOne = (workspaceId: string) =>
    act(`check:${workspaceId}`, async () =>
      checkingLine((await checkMigration({ workspaceId: workspaceId as Id<"workspaces"> })).started),
    );

  const actions: IndexActions = {
    busy,
    restart: restartMeaning,
    migrationPaused: paused,
    repair,
    check: checkOne,
    retryMove: (id) =>
      void act(`retry:${id}`, async () => {
        await retryMove({ id: id as Id<"moveQueue"> });
        return "The move will try again now.";
      }),
    undoMove: (id) =>
      void act(`undo:${id}`, async () => {
        await undoMove({ id: id as Id<"moveQueue"> });
        return "The folder is going back to where it was.";
      }),
  };

  if (rows === null) return <Loading />;

  const attention = rows.filter(needsAttention);
  const shown = (show === "attention" ? attention : rows).filter((row) => matchesFind(row, find));
  const stuck = stuckMeaningCount(report?.rows ?? []);

  return (
    <View style={styles.view} testID="admin-indexes">
      <View style={styles.cards}>
        {INDEXES.map((index) => (
          <SummaryCard
            key={index.key}
            indexKey={index.key}
            what={index.what}
            rows={rows}
            label={index.label}
            loading={index.key === "files" && migration === undefined}
            foot={
              index.key === "files" ? (
                migration === undefined ? null : (
                  <>
                    <Text variant="meta" style={styles.grow}>
                      {paused
                        ? migration.changedAt === null
                          ? "Everyone reads from the bucket"
                          : `Everyone reads from the bucket since ${whenLabel(migration.changedAt, Date.now())}`
                        : "Served live to everyone"}
                    </Text>
                    <Button
                      label={busy === "convex:pause" ? "Saving…" : paused ? "Serve from the tree" : "Serve from bucket"}
                      disabled={busy !== null}
                      onPress={() => void togglePaused()}
                      testID="admin-files-serve"
                    />
                    <Button
                      label={busy === "convex:check:all" ? "Checking…" : "Check all"}
                      disabled={busy !== null || migration.rows.length === 0}
                      onPress={() => void checkAll()}
                      testID="admin-files-check-all"
                    />
                  </>
                )
              ) : index.key === "meaning" ? (
                <>
                  <Text variant="meta" style={styles.grow}>
                    Restart never turns on a workspace whose owner turned it off.
                  </Text>
                  <Button
                    label={busy === "meaning:all" ? "Restarting…" : `Restart ${stuck} stuck`}
                    disabled={busy !== null || stuck === 0}
                    onPress={() => void restartMeaning()}
                    testID="admin-meaning-restart-all"
                  />
                </>
              ) : (
                <Text variant="meta" style={styles.grow}>
                  Keeps itself current after every change.
                </Text>
              )
            }
          />
        ))}
      </View>

      {said ? (
        <NoticeLine mark={said.tone === "ok" ? "✓" : "!"} tone={said.tone}>
          {said.text}
        </NoticeLine>
      ) : null}
      {report?.truncated || migration?.truncated ? (
        <NoticeLine mark="!" tone="warn">
          There are more workspaces than this view reads at once; the ones that need attention come first.
        </NoticeLine>
      ) : null}

      <View style={styles.filters}>
        <Segments
          options={[
            { key: "attention", label: "Needs attention" },
            { key: "all", label: "All" },
          ]}
          value={show}
          onChange={setShow}
          counts={(key) => (key === "attention" ? attention.length : rows.length)}
          label="Show"
          testID="admin-indexes-show"
        />
        <TextField
          label="Workspace"
          labelHidden
          value={find}
          onChangeText={setFind}
          placeholder="Find a workspace, e.g. @maya"
          autoCapitalize="none"
          autoCorrect={false}
          containerStyle={styles.find}
          testID="admin-indexes-find"
        />
        <Text variant="meta" style={styles.order}>
          Every note is indexed, in this order: T0 everything else, T1 Inbox, T2 Archive
        </Text>
      </View>

      <Panel flush testID="admin-indexes-table">
        {shown.length === 0 ? (
          <EmptyNote
            title={
              find.trim() !== ""
                ? "No workspace matches"
                : show === "attention"
                  ? "Nothing needs attention"
                  : "No workspace has an index yet"
            }
            body={
              find.trim() !== ""
                ? "Check the spelling, or clear the box."
                : show === "attention"
                  ? "Every workspace's indexes are ready. Pick All to see them."
                  : "The rollout reaches every workspace with storage, a batch every 15 minutes."
            }
          />
        ) : (
          <IndexRows rows={shown} actions={actions} />
        )}
      </Panel>

    </View>
  );
}

function SummaryCard({
  indexKey,
  label,
  what,
  rows,
  loading,
  foot,
}: {
  indexKey: IndexKey;
  label: string;
  what: string;
  rows: readonly WorkspaceIndexes[];
  loading: boolean;
  foot: React.ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  const parts = countParts(indexKey, healthCounts(rows, indexKey));
  return (
    <Card style={styles.card} testID={`admin-indexes-card-${indexKey}`}>
      <Text variant="rowTitle" role="heading" aria-level={2}>
        {label}
      </Text>
      <Text variant="meta">{what}</Text>
      <View style={styles.counts}>
        {loading ? (
          <Skeleton width={160} height={14} />
        ) : parts.length === 0 ? (
          <Text variant="rowSub">No workspaces yet</Text>
        ) : (
          parts.map((part) => (
            <View key={part.health} style={styles.count}>
              <Dot tone={healthTone(part.health)} />
              <Text variant="rowSub" style={styles.num}>
                {part.text}
              </Text>
            </View>
          ))
        )}
      </View>
      <View style={styles.foot}>{foot}</View>
    </Card>
  );
}

function Loading() {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.cards} aria-busy testID="admin-loading">
      {INDEXES.map((index) => (
        <Card key={index.key} style={styles.card}>
          <Skeleton width={120} height={14} />
          <Skeleton width="100%" height={12} />
          <Skeleton width={160} height={14} />
        </Card>
      ))}
    </View>
  );
}

const makeStyles = (_colors: Colors) =>
  StyleSheet.create({
    view: { gap: space.x4 },
    cards: { flexDirection: "row", flexWrap: "wrap", gap: space.x3 },
    card: { flexGrow: 1, flexBasis: 260, gap: space.x2 },
    counts: { flexDirection: "row", flexWrap: "wrap", columnGap: space.x3, rowGap: 4 },
    count: { flexDirection: "row", alignItems: "center", gap: 6 },
    foot: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.x2, marginTop: "auto", paddingTop: space.x2 },
    grow: { flexGrow: 1, flexShrink: 1, flexBasis: 140 },
    filters: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.x3 },
    find: { minWidth: 200, flexGrow: 1, maxWidth: 300 },
    order: { marginLeft: "auto" },
    num: { fontVariant: ["tabular-nums"] },
  });
