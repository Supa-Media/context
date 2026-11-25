/**
 * The Data page (board 01): the data folder's own page, found by its job like
 * the Areas folder's. Metrics come first, because people open it to read
 * numbers; sources are setup, so they follow, as cards.
 *
 * Every value is worked out as the page is read, at the reader's clearance
 * (`useDataWorkspace.ts`). The two buttons are drawn only for someone who
 * may write here, and each does what it says: New metric makes a metric note
 * and opens it, and Connect a source offers the one source this stage can
 * make, Send from your code (`ConnectSource.tsx`).
 */

import { StyleSheet, View } from "react-native";
import { Text } from "../../../design/components/Text";
import { pointerType } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import { JobIcon } from "../jobIcons/JobIcon";
import { baseName } from "../paths";
import { DatabaseGlyph, PlusGlyph } from "./Marks";
import { MetricRows } from "./MetricRows";
import { PageHead } from "./PageHead";
import { DataButton, SectionHead } from "./Parts";
import { SourceCards, type SourceCard } from "./SourceCards";
import type { DataWorkspace } from "./useDataWorkspace";
import { metricView, type MetricView } from "./views";
import { sourceStatus, type SyncState } from "./words";

export const DATA_LEDE = "Sources sync into datasets. Metrics are worked out from them, and any area can use one.";

export interface DataActions {
  /** Connect a source: absent for someone who may not add one, and the button is not drawn. */
  readonly connect?: () => void;
  /** New metric: absent for someone who may not write here. */
  readonly newMetric?: () => void;
}

export function metricViews(ws: DataWorkspace): MetricView[] {
  return ws.metrics.map((metric) => metricView(metric, ws.worked.get(metric.path), ws.uses, ws.sources, ws.settled));
}

export function sourceCards(ws: DataWorkspace, now: number, sync?: (folder: string) => SyncState | undefined): SourceCard[] {
  return ws.sources.map((source) => ({
    source,
    status: sourceStatus(source, ws.sheets, now, sync?.(source.folder)),
    datasets: source.datasets.map((dataset) => ({ ...dataset, sheet: ws.sheets.get(dataset.path) ?? null })),
  }));
}

export function HeadButtons({ actions, compact }: { actions: DataActions; compact: boolean }) {
  const colors = useColors();
  if (actions.connect === undefined && actions.newMetric === undefined) return null;
  return (
    <>
      {actions.connect === undefined ? null : (
        <DataButton label="Connect a source" leading={<PlusGlyph size={13} color={colors.text} />} onPress={actions.connect} compact={compact} testID="data-connect" />
      )}
      {actions.newMetric === undefined ? null : (
        <DataButton label="New metric" kind="pri" leading={<PlusGlyph size={13} color={colors.ink} />} onPress={actions.newMetric} compact={compact} testID="data-new-metric" />
      )}
    </>
  );
}

export function DataPage({
  folder,
  compact,
  ws,
  now,
  actions,
  onOpen,
  sync,
}: {
  folder: string;
  compact: boolean;
  ws: DataWorkspace;
  now: number;
  actions: DataActions;
  onOpen: (path: string) => void;
  /** What the sync object says of each source's last run; absent until sources sync (stage E). */
  sync?: (folder: string) => SyncState | undefined;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const metrics = metricViews(ws);
  const cards = sourceCards(ws, now, sync);
  const name = baseName(folder);
  const buttons = <HeadButtons actions={actions} compact={compact} />;
  const empty = ws.notes !== null && metrics.length === 0 && cards.length === 0;
  return (
    <View testID="data-page">
      <PageHead
        tile={<JobIcon job="data" size={36} tile testID="data-page-icon" />}
        title={name}
        actions={actions.connect === undefined && actions.newMetric === undefined ? null : buttons}
        lede={DATA_LEDE}
        compact={compact}
      />
      {ws.notes === null ? (
        <View style={styles.waiting} accessibilityLabel="Loading" testID="data-page-waiting" />
      ) : empty ? (
        <View style={styles.empty} testID="data-page-empty">
          <View style={styles.emptyIcon}>
            <DatabaseGlyph size={22} color={colors.accentText} />
          </View>
          <Text style={styles.emptyTitle}>No sources or metrics yet</Text>
          <Text style={styles.emptyText}>
            Connect a source and its rows land here as plain sheets. A metric is a formula over them, and any area can use one.
          </Text>
        </View>
      ) : (
        <>
          <SectionHead title="Metrics" right={compact ? null : "Worked out from the datasets below, as you read"} compact={compact} />
          {metrics.length === 0 ? (
            <Text style={styles.none}>No metrics yet. A metric is a note in {name}/metrics with a formula over the datasets below.</Text>
          ) : (
            <MetricRows metrics={metrics} compact={compact} onOpen={onOpen} header phoneLine="usedAndInputs" />
          )}
          <SectionHead title="Sources" right={compact ? null : `Each sync adds rows to plain CSV sheets in ${name}/`} compact={compact} />
          {cards.length === 0 ? (
            <Text style={styles.none}>No sources yet. A source is a folder in {name}/ with its sheets.</Text>
          ) : (
            <SourceCards cards={cards} compact={compact} onOpen={onOpen} />
          )}
        </>
      )}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    waiting: { minHeight: 240 },
    none: { fontSize: pointerType.ui, lineHeight: 20, color: colors.muted, marginBottom: 26 },
    empty: { alignItems: "center", gap: 8, paddingTop: 18, paddingBottom: 8, paddingHorizontal: 10 },
    emptyIcon: { width: 44, height: 44, borderRadius: 12, backgroundColor: colors.surface3, alignItems: "center", justifyContent: "center" },
    emptyTitle: { fontSize: pointerType.lede, lineHeight: 20, fontWeight: "600", color: colors.text, textAlign: "center" },
    emptyText: { fontSize: pointerType.ui, lineHeight: 19, color: colors.muted, textAlign: "center", maxWidth: 360 },
  });
