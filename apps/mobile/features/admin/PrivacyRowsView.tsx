/**
 * The Search tab's "Privacy on rows" view (`./SearchSection`): the setting
 * (Off, Shadow or On), the three steps to move it, and a row per workspace
 * with its check. Staff only; the report is `api.functions.privacyRows.report`
 * and each button is one of its mutations.
 *
 * The words and the rules are `./privacyRows`. Counts, times and fixed labels
 * only: a note's name and text never reach this view, and a difference is shown
 * as a count (its path sample is read with `differencesFor`, not here).
 */

import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { Button, Card, Text, space, useThemedStyles, type Colors } from "../design";
import { EmptyNote, NoticeLine, Panel, Skeleton, useCompact } from "./AdminKit";
import { ListRow, RowValue, TableHead, TableRow, type Column } from "./AdminTable";
import { messageFor } from "./SecretDialogs";
import {
  checkedAtLabel,
  checkedLine,
  differencesLine,
  offNote,
  orphanNote,
  settingLabel,
  settingNote,
  slugLabel,
  statusLabel,
  summaryLine,
  switchButtons,
  switchedWords,
  rowsSwitchNote,
  type PrivacyRowsRow,
} from "./privacyRows";

type Said = { text: string; tone: "ok" | "crit" } | null;

const COLUMNS: readonly Column[] = [
  { label: "Workspace", flex: 1.6 },
  { label: "Rows checked", flex: 1, align: "right" },
  { label: "Differences", flex: 1, align: "right" },
  { label: "Orphans", flex: 0.9, align: "right" },
  { label: "Last checked", flex: 1.2, align: "right" },
];

export function PrivacyRowsView() {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  const report = useQuery(api.functions.privacyRows.report, {});
  const start = useMutation(api.functions.privacyRows.startKeeping);
  const check = useMutation(api.functions.privacyRows.checkAll);
  const switchToRows = useMutation(api.functions.privacyRows.useRows);
  const backToOff = useMutation(api.functions.privacyRows.backToOff);
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<Said>(null);
  const [confirmingRows, setConfirmingRows] = useState(false);

  const rows: PrivacyRowsRow[] | null = report?.rows ?? null;

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

  if (report === undefined || rows === null) {
    return (
      <View style={styles.view} aria-busy testID="admin-rows-loading">
        <Card style={styles.card}>
          <Skeleton width={140} height={14} />
          <Skeleton width={90} height={30} style={styles.gap} />
          <Skeleton width="100%" height={12} style={styles.gap} />
        </Card>
      </View>
    );
  }

  const buttons = switchButtons(report);

  return (
    <View style={styles.view} testID="admin-rows">
      <Card style={styles.card}>
        <Text variant="rowTitle" role="heading" aria-level={2}>
          Privacy on rows
        </Text>
        <Text variant="meta" testID="admin-rows-setting">
          Setting: {settingLabel(report.source)}
        </Text>
        <Text variant="check" testID="admin-rows-note">
          {settingNote(report.source)}
        </Text>
        {report.truncated ? (
          <NoticeLine mark="!" tone="warn">
            There are more workspaces than this view reads at once. Nothing has changed.
          </NoticeLine>
        ) : null}
        <View style={styles.actions}>
          <Button
            label={busy === "start" ? "Starting…" : buttons.start.label}
            disabled={busy !== null}
            onPress={() =>
              void act("start", async () => {
                await start({});
                return "Keeping rows for every workspace. Each row updates as it is derived.";
              })
            }
            testID="admin-rows-start"
          />
          <Button
            label={busy === "check" ? "Checking…" : buttons.check.label}
            disabled={busy !== null}
            onPress={() =>
              void act("check", async () => {
                await check({});
                return "Checking every workspace against the rules.";
              })
            }
            testID="admin-rows-check"
          />
          {buttons.useRows.shown && !confirmingRows ? (
            <View style={styles.switchCell}>
              <Button
                label={busy === "rows" ? "Switching…" : "Use rows"}
                disabled={busy !== null || !buttons.useRows.enabled}
                onPress={() => setConfirmingRows(true)}
                testID="admin-rows-use"
              />
            </View>
          ) : null}
          {buttons.off.shown ? (
            <View style={styles.switchCell}>
              <Button
                label={busy === "off" ? "Switching…" : buttons.off.label}
                disabled={busy !== null}
                onPress={() =>
                  void act("off", async () => {
                    const { source } = await backToOff({});
                    return switchedWords(source);
                  })
                }
                testID="admin-rows-off"
              />
            </View>
          ) : null}
        </View>
        {buttons.useRows.shown && !buttons.useRows.enabled && buttons.useRows.reason ? (
          <Text variant="meta" testID="admin-rows-reason">
            {buttons.useRows.reason}
          </Text>
        ) : null}
        {confirmingRows ? (
          <View style={styles.inline} role="alert" testID="admin-rows-use-confirm">
            <Text variant="check">{rowsSwitchNote()}</Text>
            <View style={styles.actions}>
              <Button label="Cancel" disabled={busy !== null} onPress={() => setConfirmingRows(false)} />
              <Button
                label={busy === "rows" ? "Switching…" : "Use rows"}
                disabled={busy !== null}
                onPress={() =>
                  void act("rows", async () => {
                    const { source } = await switchToRows({});
                    setConfirmingRows(false);
                    return switchedWords(source);
                  })
                }
                testID="admin-rows-use-go"
              />
            </View>
          </View>
        ) : null}
        {report.source !== "file" && !confirmingRows ? (
          <Text variant="meta" testID="admin-rows-off-note">
            {offNote()}
          </Text>
        ) : null}
        {said ? (
          <NoticeLine mark={said.tone === "ok" ? "✓" : "!"} tone={said.tone}>
            {said.text}
          </NoticeLine>
        ) : null}
      </Card>

      <Panel flush title="Workspaces" meta={summaryLine(rows)} metaWide testID="admin-rows-table">
        {rows.length === 0 ? (
          <EmptyNote title="No workspaces yet" body="Each workspace shows here once it has storage." />
        ) : (
          <>
            {compact ? null : <TableHead columns={COLUMNS} />}
            {rows.map((row, index) => (
              <WorkspaceRow key={row.workspaceId} row={row} compact={compact} first={index === 0} last={index === rows.length - 1} />
            ))}
          </>
        )}
      </Panel>
    </View>
  );
}

function WorkspaceRow({
  row,
  compact,
  first,
  last,
}: {
  row: PrivacyRowsRow;
  compact: boolean;
  first: boolean;
  last: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const orphans = orphanNote(row.orphans);
  const title = slugLabel(row.slug);
  const status = `${statusLabel(row.status)}${row.archived ? " · archived" : ""}`;
  if (compact) {
    return (
      <ListRow
        first={first}
        title={title}
        sub={`${status} · ${checkedLine(row)}${orphans ? ` · ${orphans}` : ""}`}
        trailing={<RowValue>{differencesLine(row)} differ</RowValue>}
        below={<Text variant="meta">Last checked {checkedAtLabel(row.checkedAt)}</Text>}
        testID={`admin-rows-row-${row.workspaceId}`}
      />
    );
  }
  return (
    <TableRow
      columns={COLUMNS}
      last={last}
      testID={`admin-rows-row-${row.workspaceId}`}
      cells={[
        <View key="name" style={styles.name}>
          <Text variant="rowTitle" numberOfLines={1}>
            {title}
          </Text>
          <Text variant="rowSub" style={row.status === "differs" ? styles.bad : null}>
            {status}
          </Text>
        </View>,
        <Text key="checked" style={styles.num}>
          {row.checked.toLocaleString("en-US")}
        </Text>,
        <Text key="diffs" style={row.differences > 0 ? styles.bad : styles.num}>
          {differencesLine(row)}
        </Text>,
        <Text key="orphans" style={styles.num} testID={`admin-rows-orphans-${row.workspaceId}`}>
          {row.orphans.toLocaleString("en-US")}
        </Text>,
        <Text key="at" variant="rowSub">
          {checkedAtLabel(row.checkedAt)}
        </Text>,
      ]}
    />
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    view: { gap: space.x4 },
    card: { gap: space.x2 },
    gap: { marginTop: 14 },
    actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.x2, paddingTop: space.x2 },
    switchCell: { marginLeft: "auto" },
    inline: { gap: space.x2, paddingTop: space.x2 },
    name: { flexGrow: 1, minWidth: 0, gap: 2 },
    num: { fontVariant: ["tabular-nums"], color: colors.text },
    bad: { color: colors.critText },
  });
