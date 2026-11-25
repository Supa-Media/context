/**
 * A metric note opened (board 12): its name as the title, its front matter as
 * properties — the formula as chips, its period, its inputs, how it is shown
 * and who uses it — and its readings over the last periods, worked out from
 * its inputs as it is read, with the target of the area that uses it.
 *
 * The note's body stays what the person wrote under it, a plain reading of
 * the formula; nothing here writes a value into the note or anywhere else.
 * Drawn over the editor, in place of the folded Properties row, for a note in
 * the data folder's `metrics/` (`isMetricNotePath`).
 */

import { useMemo, useState } from "react";
import { withoutTextExtension } from "@context/shared/src/fileKinds.cjs";
import { StyleSheet, View } from "react-native";
import { formatValue } from "../../../../../mcp/src/data/formula/index.js";
import { Text } from "../../../design/components/Text";
import { pointerType, radii, touchType } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { properties, splitNote } from "../frontmatter";
import { areasFolderNow, dataFolderNow } from "../jobIcons/jobFoldersNow";
import type { FolderListSource, ListNote } from "../listBlock/model";
import { contextSheets, countedFolders, foldersToRead } from "./contextSource";
import { metricOf, usesByMetric } from "./metrics";
import { FormulaChips, SectionLink } from "./Parts";
import { ReadingsChart } from "./ReadingsChart";
import { Code, PropsGrid, Words } from "./SourceParts";
import { CONTEXT_DATASETS, sourceBySlug, sourcesFromNotes } from "./sources";
import { useFolderReads, useSheets } from "./useData";
import { metricView } from "./views";
import { workOut, type RowsOf, type Sheet } from "./workOut";
import { useOptionalConsoleData } from "../../ConsoleDataContext";
import { KeptReadingsHead } from "./KeptReadingsHead";
import { keptSheetPath } from "./useMetricKeep";
import { periodLabel } from "./words";

const PERIODS = 6;
const NO_NOTES: readonly ListNote[] = [];

export function MetricNoteView({
  path,
  text,
  source,
  compact,
  gutter,
  onOpen,
}: {
  path: string;
  /** The note's whole text as the editor holds it, front matter included. */
  text: string;
  source: FolderListSource | undefined;
  compact: boolean;
  gutter: number;
  onOpen?: (path: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const dataFolder = dataFolderNow();
  const areas = areasFolderNow();
  const [now] = useState(() => Date.now());
  const [keptStamp, setKeptStamp] = useState(0);
  // Keeping a metric asks the gateway with the console's grant: only inside the signed-in console, never a demo.
  const consoleData = useOptionalConsoleData();
  const live = consoleData !== null && consoleData.demo !== true;
  const split = splitNote(text);
  const front = split.frontmatter;
  // A body that opens with its own heading is the note's title already: drawn
  // once, by the editor, never twice.
  const headed = /^\s*#\s/.test(split.body);
  const metric = useMemo(
    () => metricOf({ path, properties: Object.fromEntries(properties(front).map((row) => [row.key, row.value])) }),
    [path, front],
  );
  const reads = useFolderReads(source, useMemo(() => [dataFolder, areas], [dataFolder, areas]));
  const dataNotes = reads.get(dataFolder) ?? null;
  const sources = useMemo(() => sourcesFromNotes(dataFolder, dataNotes ?? NO_NOTES), [dataFolder, dataNotes]);
  const uses = useMemo(() => usesByMetric(areas, reads.get(areas) ?? NO_NOTES), [areas, reads]);
  const bySlug = useMemo(() => sourceBySlug(sources), [sources]);
  const inputs = useMemo(() => (metric.parsed.ok ? metricView(metric, undefined, uses, sources, true).inputPaths : []), [metric, uses, sources]);
  const context = sources.find((each) => each.kind === "context") ?? null;
  const counted = useMemo(() => countedFolders(context), [context]);
  const countRead = useFolderReads(source, useMemo(() => (metric.formula.includes("context/") ? foldersToRead(counted) : []), [metric.formula, counted]));
  const wanted = useMemo(() => {
    const out = new Map<string, number>();
    for (const input of inputs) {
      const [slug = "", rest = ""] = input.label.split("/");
      const name = withoutTextExtension(rest);
      if (bySlug(slug)?.kind === "context" && (CONTEXT_DATASETS as readonly string[]).includes(name)) continue;
      out.set(`${dataFolder}/${slug}/${name}.csv`, 0);
    }
    // A right-now metric's own sheet of hourly readings, beside its note; read again once Keep every hour wrote it.
    out.set(keptSheetPath(path), keptStamp);
    return out;
  }, [metric, inputs, bySlug, dataFolder, path, keptStamp]);
  const sheets = useSheets(source?.readBody, wanted);
  const rowsOf: RowsOf = useMemo(() => {
    const counting = [...countRead.values()].flatMap((list) => list ?? []);
    const computed = contextSheets(counted, counting, now);
    return (slug: string, name: string): Sheet | null => {
      if (bySlug(slug)?.kind === "context" && (CONTEXT_DATASETS as readonly string[]).includes(name)) return computed.get(name) ?? null;
      return sheets.get(`${dataFolder}/${slug}/${name}.csv`) ?? null;
    };
  }, [sheets, countRead, counted, now, bySlug, dataFolder]);
  // A note's sources come from their about.md, which names no sheets: an input links to the sheet that was read.
  const links = inputs.map((input) => {
    if (input.path !== null) return input;
    const [slug = "", rest = ""] = input.label.split("/");
    const name = withoutTextExtension(rest);
    const found = bySlug(slug);
    if (found === undefined) return input;
    if (found.kind === "context" && (CONTEXT_DATASETS as readonly string[]).includes(name)) return { ...input, path: found.folder };
    const sheetPath = `${dataFolder}/${slug}/${name}.csv`;
    return sheets.get(sheetPath) == null ? input : { ...input, path: sheetPath };
  });
  const keptSheet = sheets.get(keptSheetPath(path)) ?? null;
  const worked = useMemo(() => workOut(metric, rowsOf, now, PERIODS, keptSheet), [metric, rowsOf, now, keptSheet]);
  const settled = dataNotes !== null && [...wanted.keys()].every((each) => sheets.has(each));
  const view = metricView(metric, worked, uses, sources, settled);
  const used = uses.get(metric.name.trim().toLowerCase()) ?? [];
  const first = used[0];

  const rows = [
    { key: "metric", value: <Words text={metric.name} /> },
    {
      key: "formula",
      value: metric.parsed.ok ? <FormulaChips parts={view.parts} large /> : <Text style={styles.problem}>{metric.parsed.message}</Text>,
    },
    { key: "every", value: <Words text={worked.now ? `${metric.every} · right now` : `${metric.every} · worked out as you read`} /> },
    ...(inputs.length === 0
      ? []
      : [
          {
            key: "inputs",
            value: (
              <>
                {links.map((input, at) => (
                  <View key={input.label} style={styles.inputs}>
                    {at > 0 ? <Text style={styles.sep}>·</Text> : null}
                    {input.path !== null && onOpen !== undefined ? (
                      <SectionLink label={input.label} onPress={() => onOpen(input.path!)} />
                    ) : (
                      <Words text={input.label} />
                    )}
                  </View>
                ))}
              </>
            ),
          },
        ]),
    ...(metric.format === "" ? [] : [{ key: "shown as", value: <Code text={metric.format} /> }]),
    {
      key: "used by",
      value: <Words text={used.length === 0 ? "Not used yet" : used.map((use) => (use.target === null ? use.area : `${use.area} · target ${use.target}`)).join(", ")} quiet={used.length === 0} />,
    },
  ];

  const periods = worked.periods;
  const values = periods.map((p) => (p.status === "ok" ? p.value : null));
  const shownOf = (at: number) => formatShown(periods[at]?.value ?? null, periods[at]?.status ?? "", metric.format);
  return (
    <View style={[styles.wrap, { paddingLeft: gutter, paddingRight: gutter }]} testID="metric-note-view">
      {headed ? null : (
        <Text style={[styles.title, compact && styles.titleCompact]} role="heading" aria-level={1}>
          {metric.name}
        </Text>
      )}
      <PropsGrid rows={rows} compact={compact} />
      {worked.now && live ? (
        <KeptReadingsHead path={path} keptExists={keptSheet !== null} settled={settled} now={now} onKept={() => setKeptStamp((at) => at + 1)} />
      ) : (
        <View style={styles.readingsHead}>
          <Text style={styles.h3}>Readings</Text>
          <Text style={styles.from}>{worked.now ? "right now only" : "worked out from its inputs"}</Text>
        </View>
      )}
      {!metric.parsed.ok ? (
        <Words text="No readings: the formula could not be read." quiet />
      ) : !settled ? (
        <View style={styles.waiting} accessibilityLabel="Loading" />
      ) : worked.latest.status === "hidden" ? (
        <Words text="Hidden: one of its inputs is missing, or not shared with you." quiet />
      ) : (
        <>
          <View style={styles.card}>
            <ReadingsChart
              values={values}
              labels={periods.map((p) => periodLabel(p, metric.every))}
              target={view.target}
              targetLabel={first?.target == null ? null : `${first.area}'s target, ${first.target}`}
              state={view.state}
              format={metric.format}
            />
          </View>
          <View style={[styles.grid, compact && styles.gridCompact]}>
            {periods.map((p, at) => (
              <View key={p.from} style={[styles.cell, compact && styles.cellCompact, at === periods.length - 1 && styles.cellLast]}>
                <Text style={styles.cellLabel} numberOfLines={1}>
                  {periodLabel(p, metric.every, at === periods.length - 1)}
                </Text>
                <Text style={styles.cellValue} numberOfLines={1}>
                  {shownOf(at)}
                </Text>
              </View>
            ))}
          </View>
        </>
      )}
    </View>
  );
}

/** A period's value in the metric's format; "—" for a period with none. */
function formatShown(value: number | null, status: string, format: string): string {
  if (status !== "ok" || value === null) return "—";
  return formatValue(value, format === "" ? undefined : format) as string;
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    wrap: { paddingTop: 4, paddingBottom: 8 },
    title: { fontSize: pointerType.title, lineHeight: 38, fontWeight: "600", letterSpacing: -0.6, color: colors.text, marginTop: 4, marginBottom: 14 },
    titleCompact: { fontSize: touchType.title, lineHeight: 34 },
    problem: { fontSize: pointerType.meta, lineHeight: 18, color: colors.critText },
    inputs: { flexDirection: "row", alignItems: "center", gap: 6 },
    sep: { fontSize: pointerType.meta, color: colors.muted },
    readingsHead: { flexDirection: "row", alignItems: "baseline", gap: 10, marginBottom: 10 },
    h3: { fontSize: pointerType.h3, lineHeight: 26, fontWeight: "600", color: colors.text },
    from: { marginLeft: "auto", fontSize: pointerType.meta, color: colors.muted },
    waiting: { height: 220 },
    card: { borderWidth: 1, borderColor: colors.line, borderRadius: radii.card, backgroundColor: colors.cardSurface, padding: 12 },
    grid: { flexDirection: "row", borderWidth: 1, borderColor: colors.line, borderRadius: radii.card, overflow: "hidden", marginTop: 10 },
    gridCompact: { flexWrap: "wrap" },
    cell: { flexGrow: 1, flexBasis: 0, paddingVertical: 8, paddingHorizontal: 10, borderRightWidth: 1, borderRightColor: colors.line },
    cellCompact: { flexBasis: "33%", borderBottomWidth: 1, borderBottomColor: colors.line },
    cellLast: { borderRightWidth: 0 },
    cellLabel: { fontSize: pointerType.meta, lineHeight: 16, color: colors.muted },
    cellValue: { fontSize: pointerType.lede, lineHeight: 20, fontWeight: "600", color: colors.text },
  });
