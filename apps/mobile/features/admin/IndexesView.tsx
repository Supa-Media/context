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
 * Search by meaning (with fast search beside it) is a live query. The tree
 * state lives in each workspace's own database, so it is an action read on
 * open and on Refresh.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { Button, Card, Dot, Text, TextField, space, useThemedStyles, type Colors } from "../design";
import { EmptyNote, NoticeLine, Panel, Skeleton } from "./AdminKit";
import { IndexRows, healthTone, type IndexActions } from "./IndexRows";
import { messageFor } from "./SecretDialogs";
import { Segments } from "./Segments";
import { restartedLine, stuckMeaningCount } from "./meaningIndexes";
import {
  INDEXES,
  countParts,
  healthCounts,
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
  return useMemo(
    () => (report === undefined ? null : joinIndexes(null, report.rows).filter(needsAttention).length),
    [report],
  );
}

export function IndexesView() {
  const styles = useThemedStyles(makeStyles);
  const report = useQuery(api.functions.meaningAdmin.meaningIndexReport, {});
  const readTree = useAction(api.functions.treeAdmin.treeIndexes);
  const fillTree = useAction(api.functions.treeAdmin.fillTreeIndexesNow);
  const restart = useMutation(api.functions.meaningAdmin.restartMeaningIndexing);
  const [tree, setTree] = useState<TreeIndexRow[] | null>(null);
  const [treeReadAt, setTreeReadAt] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<Said>(null);
  const [show, setShow] = useState<"attention" | "all">("attention");
  const [find, setFind] = useState("");

  const refreshTree = useCallback(async () => {
    try {
      setTree((await readTree({})).rows);
      setTreeReadAt(Date.now());
    } catch (caught) {
      setSaid({ text: messageFor(caught, "Couldn't read the sidebar trees. Try again."), tone: "crit" });
    }
  }, [readTree]);

  useEffect(() => {
    void refreshTree();
  }, [refreshTree]);

  const rows = useMemo(() => (report === undefined ? null : joinIndexes(tree, report.rows)), [report, tree]);

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

  const fill = (workspaceId?: string) =>
    act(workspaceId ? `tree:${workspaceId}` : "tree:all", async () => {
      const { started } = await fillTree(workspaceId ? { workspaceId: workspaceId as Id<"workspaces"> } : {});
      await refreshTree();
      return started === 1 ? "Filling 1 sidebar tree. Refresh to see it move." : `Filling ${started} sidebar trees. Refresh to see them move.`;
    });

  const restartMeaning = (workspaceId?: string) =>
    act(workspaceId ? `meaning:${workspaceId}` : "meaning:all", async () => {
      const result = await restart(workspaceId ? { workspaceId: workspaceId as Id<"workspaces"> } : {});
      return restartedLine(result.restarted, result.outcome);
    });

  const actions: IndexActions = { busy, fill, restart: restartMeaning };

  if (rows === null) return <Loading />;

  const attention = rows.filter(needsAttention);
  const shown = (show === "attention" ? attention : rows).filter((row) => matchesFind(row, find));
  const stuck = stuckMeaningCount(report?.rows ?? []);
  const unfilled = (tree ?? []).filter((row) => row.status === "empty").length;

  return (
    <View style={styles.view} testID="admin-indexes">
      <View style={styles.cards}>
        {INDEXES.map((index) => (
          <SummaryCard
            key={index.key}
            indexKey={index.key}
            label={index.label}
            what={index.what}
            rows={rows}
            loading={index.key === "tree" && tree === null}
            foot={
              index.key === "tree" ? (
                <>
                  <Text variant="meta" style={styles.grow}>
                    {treeReadAt === null ? "Reading…" : "Read when you opened this"}
                  </Text>
                  <Button label="Refresh" disabled={busy !== null} onPress={() => void refreshTree()} testID="admin-tree-refresh" />
                  <Button
                    label={busy === "tree:all" ? "Starting…" : unfilled > 0 ? `Fill all (${unfilled} not filled)` : "Fill all"}
                    disabled={busy !== null || tree === null || tree.length === 0}
                    onPress={() => void fill()}
                    testID="admin-tree-fill-all"
                  />
                </>
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
      {report?.truncated ? (
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
