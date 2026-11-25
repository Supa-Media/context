/**
 * The data folder's `metrics/` page (board 11): one row per metric note, by
 * its file name, with its latest value, formula and who uses it, and the
 * readings sheet beneath when there is one.
 */

import { View } from "react-native";
import { useColors } from "../../../design/theme";
import { FolderGlyph, PlusGlyph } from "./Marks";
import { MetricRows } from "./MetricRows";
import { PageHead } from "./PageHead";
import { DataButton, SectionHead } from "./Parts";
import { FileRows, Words, type FileLine } from "./SourceParts";
import type { MetricView } from "./views";
import type { Sheet } from "./workOut";
import { columnsWords, lastRowAt, lastRowWords, rowsWords } from "./words";

export const METRICS_LEDE = "Each metric is a note: its name, formula and period sit in its properties. Each is worked out from its datasets as you read it.";

export function MetricsPage({
  title,
  metrics,
  readings,
  compact,
  now,
  newMetric,
  onOpen,
}: {
  title: string;
  metrics: readonly MetricView[];
  /** `readings.csv` where the folder has one: its path and sheet. */
  readings: { path: string; sheet: Sheet | null } | null;
  compact: boolean;
  now: number;
  newMetric?: () => void;
  onOpen: (path: string) => void;
}) {
  const colors = useColors();
  const files: FileLine[] =
    readings === null
      ? []
      : [
          {
            name: "readings.csv",
            path: readings.path,
            sheet: true,
            columns: columnsWords(readings.sheet),
            rows: readings.sheet === null ? "" : rowsWords(readings.sheet.rows.length),
            last: lastRowWords(lastRowAt(readings.sheet), now),
          },
        ];
  return (
    <View testID="data-metrics-page">
      <PageHead
        tile={
          <View style={{ width: compact ? 32 : 36, height: compact ? 32 : 36, borderRadius: 10, backgroundColor: colors.surface3, alignItems: "center", justifyContent: "center" }}>
            <FolderGlyph size={16} color={colors.text2} />
          </View>
        }
        title={title}
        status={{ tone: "ok", text: `${metrics.length} ${metrics.length === 1 ? "metric" : "metrics"} · worked out as you read` }}
        actions={
          newMetric === undefined ? null : (
            <DataButton label="New metric" kind="pri" leading={<PlusGlyph size={12} color={colors.ink} />} onPress={newMetric} compact={compact} testID="data-new-metric" />
          )
        }
        lede={METRICS_LEDE}
        compact={compact}
      />
      <SectionHead title="Metric notes" compact={compact} />
      {metrics.length === 0 ? (
        <Words text="No metric notes yet." quiet />
      ) : (
        <MetricRows metrics={metrics} compact={compact} onOpen={onOpen} asFiles />
      )}
      {files.length === 0 ? null : (
        <>
          <SectionHead title="Readings" compact={compact} />
          <FileRows files={files} compact={compact} onOpen={onOpen} />
        </>
      )}
    </View>
  );
}
