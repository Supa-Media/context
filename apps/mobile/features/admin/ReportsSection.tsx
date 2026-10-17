/**
 * The Reports tab: content people sent from the app, and a way to mark each
 * one handled. Every report is also emailed to the support address; this is
 * where it is worked. The Terms promise a review within 24 hours, which is why
 * the open list is the default view.
 *
 * Control-plane metadata only, like the rest of the console: nothing here
 * shows the content that was reported, only what the reporter said about it.
 */

import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { Button, Card, Pill, Text, space, useThemedStyles, type Colors } from "../design";
import { EmptyNote, Skeleton, useCompact } from "./AdminKit";
import { Segments } from "./Segments";
import { relativeTime } from "./report";

type ShowKey = "open" | "all";

const SHOW = [
  { key: "open", label: "Open" },
  { key: "all", label: "All" },
] as const;

type ReportKind = "share" | "grant" | "invitation" | "workspace_note" | "public_page";

const KIND_LABELS: Record<ReportKind, string> = {
  share: "A note shared with them",
  grant: "A note shared with them by name",
  invitation: "An invitation",
  workspace_note: "A note in their workspace",
  public_page: "A public page",
};

interface Report {
  id: Id<"contentReports">;
  createdAt: number;
  kind: ReportKind;
  reason: string;
  details: string | null;
  resolved: boolean;
  reporter: string;
  about: string | null;
  workspace: string | null;
  ids: Record<string, string>;
  handledAt: number | null;
  handledBy: string | null;
}

export function ReportsSection() {
  const styles = useThemedStyles(makeStyles);
  const [show, setShow] = useState<ShowKey>("open");
  const reports = useQuery(api.functions.contentReports.listReports, { show });

  return (
    <View style={styles.section} testID="admin-reports">
      <View style={styles.titles}>
        <Text variant="meta">
          Reports people sent from the app. Each one is also emailed to the support address. The Terms
          promise a review within 24 hours.
        </Text>
      </View>
      <Segments options={SHOW} value={show} onChange={setShow} label="Which reports" testID="admin-reports-show" />
      {reports === undefined ? (
        <View style={styles.list}>
          <Skeleton width="100%" height={140} />
        </View>
      ) : reports.length === 0 ? (
        <EmptyNote title={show === "open" ? "No open reports." : "No reports yet."} />
      ) : (
        <View style={styles.list}>
          {reports.map((report) => (
            <ReportCard key={report.id} report={report} />
          ))}
        </View>
      )}
    </View>
  );
}

function ReportCard({ report }: { report: Report }) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  const handle = useMutation(api.functions.contentReports.setReportHandled);
  const [busy, setBusy] = useState(false);
  const handled = report.handledAt !== null;

  async function setHandled(next: boolean) {
    setBusy(true);
    try {
      await handle({ reportId: report.id, handled: next });
    } finally {
      setBusy(false);
    }
  }

  const idLine = Object.entries(report.ids)
    .map(([name, value]) => `${name} ${value}`)
    .join(" · ");

  return (
    <Card style={StyleSheet.flatten([styles.card, compact && styles.cardCompact])} testID="admin-report-row">
      <View style={styles.head}>
        <View style={styles.grow}>
          <Text variant="rowTitle">{report.reason}</Text>
          <Text variant="meta">
            {KIND_LABELS[report.kind] ?? report.kind} · {relativeTime(report.createdAt)} ·{" "}
            {dateLabel(report.createdAt)}
          </Text>
        </View>
        {!report.resolved ? <Pill tone="warn">Target not found</Pill> : null}
      </View>

      <Text variant="rowSub">Reporter: {report.reporter}</Text>
      {report.about ? <Text variant="rowSub">About: {report.about}</Text> : null}
      {report.workspace ? <Text variant="rowSub">Workspace: {report.workspace}</Text> : null}
      {report.details ? (
        <Text variant="check" style={styles.quote}>
          “{report.details}”
        </Text>
      ) : null}
      {idLine ? (
        <Text variant="treeMetaMono" style={styles.ids}>
          {idLine}
        </Text>
      ) : null}

      <View style={styles.foot}>
        {handled ? (
          <Text variant="meta" style={styles.grow}>
            Handled by {report.handledBy ?? "someone"}, {dateLabel(report.handledAt ?? report.createdAt)}
          </Text>
        ) : (
          <View style={styles.grow} />
        )}
        {handled ? (
          <Button
            label="Reopen"
            variant="dialog"
            disabled={busy}
            onPress={() => void setHandled(false)}
            testID="admin-report-handle"
          />
        ) : (
          <Button
            label={busy ? "Saving…" : "Mark handled"}
            variant="dialogPrimary"
            disabled={busy}
            onPress={() => void setHandled(true)}
            testID="admin-report-handle"
          />
        )}
      </View>
    </Card>
  );
}

function dateLabel(at: number): string {
  return new Date(at).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    section: { gap: space.x4 },
    titles: { gap: 2 },
    list: { gap: space.x3 },
    card: { gap: space.x2, paddingVertical: space.x4, paddingHorizontal: space.x5 },
    cardCompact: { paddingHorizontal: space.x4 },
    head: { flexDirection: "row", alignItems: "flex-start", gap: space.x3 },
    grow: { flex: 1, minWidth: 0, gap: 2 },
    quote: { color: colors.text, fontStyle: "italic", marginTop: space.x1 },
    ids: { color: colors.muted, marginTop: space.x1 },
    foot: { flexDirection: "row", alignItems: "center", gap: space.x3, marginTop: space.x2 },
  });
