/**
 * The pages of the data folder, drawn in place of a folder's listing: the
 * Data page for the folder doing the Data job (board 01), a source's own page
 * for each folder in it (07, 09, 10), and the metrics folder's page (11).
 * Which folder is which is decided by job (`dataFolderNow`), never by name.
 *
 * Writes go through the console's own create (`TaskHost.io`), so they are a
 * writer's notes like any other, saved, listed and undone the same way; the
 * buttons are absent for someone who may not write.
 */

import { useMemo, useState } from "react";
import { View } from "react-native";
import type { Id } from "@context/convex/_generated/dataModel";
import { writeClipboard } from "../../../design/clipboard";
import { useOptionalConsoleData } from "../../ConsoleDataContext";
import { selectedContext } from "../../types";
import { dataFolderNow } from "../jobIcons/jobFoldersNow";
import type { FolderPageHost } from "../folderPage/useFolderPage";
import type { RowNesting } from "../NestedRows";
import { SheetSourcesDialog, sheetRowsEndpoint } from "../sheet/SheetSources";
import { ConnectSourceDialog } from "./ConnectSource";
import { DataPage, metricViews, type DataActions } from "./DataPage";
import { freePath, newMetricText, startingFormula, type PushSourceFiles } from "./dataWrites";
import { MetricsPage } from "./MetricsPage";
import { PushKeys } from "./PushKeys";
import { SourcePage } from "./SourcePage";
import { dataPageKind, metricsFolderOf, sourceAt } from "./sources";
import { useSheets } from "./useData";
import { useDataWorkspace } from "./useDataWorkspace";

/** The board's column on a wide page: 820, centred on the note's, as the Areas list widens past it. */
export const DATA_PAGE_WIDTH = 820;

/** Whether `folder` is drawn by this page rather than as a listing. */
export function isDataPage(folder: string): boolean {
  return dataPageKind(folder, dataFolderNow()) !== null;
}

export function DataFolderPage({
  folder,
  host,
  nesting,
  compact,
  pageWidth,
  onSelect,
  onMore,
}: {
  folder: string;
  host: FolderPageHost;
  nesting: RowNesting;
  compact: boolean;
  pageWidth: number;
  onSelect: (path: string) => boolean | void;
  /** The folder's own menu, for a source page's ⋯. */
  onMore?: (anchor: { x: number; y: number }) => void;
}) {
  const dataFolder = dataFolderNow();
  const kind = dataPageKind(folder, dataFolder);
  const [now] = useState(() => Date.now());
  const ws = useDataWorkspace(dataFolder, host.source, nesting, now);
  const data = useOptionalConsoleData();
  const current = data === null ? null : selectedContext(data);
  const mayKey = current !== null && data?.demo !== true && (current.role === "owner" || current.role === "editor");
  const io = host.tasks?.io;
  const metricsFolder = metricsFolderOf(dataFolder);
  const [dialog, setDialog] = useState<null | { kind: "connect" } | { kind: "key"; path: string; columns: readonly string[] }>(null);
  const open = (path: string) => void onSelect(path);
  const taken = useMemo(() => {
    const out = new Set<string>();
    for (const path of [dataFolder, metricsFolder, ...ws.sources.map((s) => s.folder)]) {
      for (const entry of nesting.listingOf(path)?.entries ?? []) out.add(entry.path);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.sources, nesting, dataFolder, metricsFolder]);

  const newMetric =
    io === undefined
      ? undefined
      : () => {
          const path = freePath(metricsFolder, "new-metric", ".md", taken);
          void io
            .create(path, newMetricText(startingFormula(ws.sources, ws.sheets)))
            .then(() => {
              host.tasks?.refresh([metricsFolder]);
              open(path);
            })
            .catch(() => host.tasks?.say("The metric could not be made. Try again."));
        };
  const actions: DataActions = {
    ...(io === undefined || !mayKey ? {} : { connect: () => setDialog({ kind: "connect" }) }),
    ...(newMetric === undefined ? {} : { newMetric }),
  };
  const makeSource = async (files: PushSourceFiles): Promise<string | null> => {
    if (io === undefined) return "You can't add to this workspace.";
    try {
      await io.create(files.about.path, files.about.text);
      await io.create(files.sheet.path, files.sheet.text);
    } catch {
      return "The source could not be made. Try again.";
    }
    host.tasks?.refresh([dataFolder, files.folder]);
    const columns = files.sheet.text.trim().split(",").map((cell) => cell.split(":")[0] ?? cell);
    setDialog({ kind: "key", path: files.sheet.path, columns });
    open(files.folder);
    return null;
  };

  const metrics = metricViews(ws);
  const readingsPath = `${metricsFolder}/readings.csv`;
  const hasReadings = nesting.listingOf(metricsFolder)?.entries.some((entry) => entry.path === readingsPath) === true;
  const readings = useSheets(host.source.readBody, useMemo(() => new Map(hasReadings && kind === "metrics" ? [[readingsPath, 0]] : []), [hasReadings, kind, readingsPath]));

  let page = null;
  if (kind === "data") {
    page = <DataPage folder={folder} compact={compact} ws={ws} now={now} actions={actions} onOpen={open} />;
  } else if (kind === "metrics") {
    page = (
      <MetricsPage
        title={folder.slice(folder.lastIndexOf("/") + 1)}
        metrics={metrics}
        readings={hasReadings ? { path: readingsPath, sheet: readings.get(readingsPath) ?? null } : null}
        compact={compact}
        now={now}
        {...(newMetric === undefined ? {} : { newMetric })}
        onOpen={open}
      />
    );
  } else if (kind === "source") {
    const source = ws.sources.find((each) => each.folder === folder) ?? sourceAt(folder, nesting.listingOf, ws.notes ?? []);
    const first = source.datasets.find((dataset) => !dataset.computed);
    const firstSheet = first === undefined ? null : (ws.sheets.get(first.path) ?? null);
    const push = source.kind === "push";
    page = (
      <SourcePage
        source={source}
        sheets={ws.sheets}
        metrics={metrics.filter((metric) => metric.reads.includes(source.folder))}
        compact={compact}
        now={now}
        endpoint={sheetRowsEndpoint()}
        actions={{
          ...(push && mayKey && first !== undefined
            ? { newKey: () => setDialog({ kind: "key", path: first.path, columns: (firstSheet?.columns ?? []).map((c) => c.name) }) }
            : {}),
          ...(onMore === undefined ? {} : { more: onMore }),
          copy: (text) => void writeClipboard(text),
        }}
        {...(push && mayKey && current !== null && first !== undefined
          ? { keys: <PushKeys workspaceId={current.id} path={first.path} now={now} /> }
          : {})}
        onOpen={open}
      />
    );
  }
  const width = compact || pageWidth <= 0 ? null : Math.min(DATA_PAGE_WIDTH, Math.max(0, pageWidth - 96));
  return (
    <View style={width === null ? undefined : { width, alignSelf: "center" }}>
      {page}
      {dialog?.kind === "connect" ? (
        <ConnectSourceDialog dataFolder={dataFolder} taken={taken} sheet={compact} onMake={makeSource} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === "key" && current !== null ? (
        <SheetSourcesDialog workspaceId={current.id as Id<"workspaces">} path={dialog.path} columns={dialog.columns} onClose={() => setDialog(null)} />
      ) : null}
    </View>
  );
}
