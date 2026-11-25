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
import { writeClipboard } from "../../../design/clipboard";
import { dataFolderNow } from "../jobIcons/jobFoldersNow";
import type { FolderPageHost } from "../folderPage/useFolderPage";
import type { RowNesting } from "../NestedRows";
import { sheetRowsEndpoint } from "../sheet/SheetSources";
import { DataPage, metricViews, type DataActions } from "./DataPage";
import { MetricsPage } from "./MetricsPage";
import { PushKeys } from "./PushKeys";
import { SourcePage } from "./SourcePage";
import { dataPageKind, metricsFolderOf, sourceAt } from "./sources";
import { useSheets } from "./useData";
import { useDataMaking } from "./useDataMaking";
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
  const metricsFolder = metricsFolderOf(dataFolder);
  const open = (path: string) => void onSelect(path);
  const making = useDataMaking({ host, listings: nesting, ws, compact, open });
  const { mayKey } = making;
  const actions: DataActions = {
    ...(making.connect === undefined ? {} : { connect: making.connect }),
    ...(making.newMetric === undefined ? {} : { newMetric: making.newMetric }),
  };
  const newMetric = making.newMetric;

  const metrics = metricViews(ws);
  const readingsPath = `${metricsFolder}/readings.csv`;
  const hasReadings = nesting.listingOf(metricsFolder)?.entries.some((entry) => entry.path === readingsPath) === true;
  const readings = useSheets(host.source.readBody, useMemo(() => new Map(hasReadings && kind === "metrics" ? [[readingsPath, 0]] : []), [hasReadings, kind, readingsPath]));

  let page = null;
  if (kind === "data") {
    page = <DataPage folder={folder} compact={compact} ws={ws} now={now} actions={actions} sync={making.syncOf} onOpen={open} />;
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
    const app = source.kind === "cloudflare" || source.kind === "stripe" || source.kind === "github" ? source.kind : null;
    page = (
      <SourcePage
        source={source}
        sheets={ws.sheets}
        metrics={metrics.filter((metric) => metric.reads.includes(source.folder))}
        compact={compact}
        now={now}
        {...(source.kind === "fetch" || app !== null ? { sync: making.syncOf(source.folder) ?? { known: false } } : {})}
        endpoint={sheetRowsEndpoint()}
        actions={{
          ...(source.kind === "fetch" && making.syncNow !== undefined ? { syncNow: () => making.syncNow?.(source) } : {}),
          ...(app !== null && making.reconnect !== undefined && (app !== "github" || making.githubRepos !== undefined) ? { reconnect: () => making.reconnect?.(app) } : {}),
          ...(app === "github" && making.githubRepos !== undefined ? { repositories: making.githubRepos } : {}),
          ...(app !== null && making.disconnect !== undefined ? { disconnect: () => making.disconnect?.(app) } : {}),
          ...(push && mayKey && first !== undefined
            ? { newKey: () => making.openKey(first.path, (firstSheet?.columns ?? []).map((c) => c.name)) }
            : {}),
          ...(onMore === undefined ? {} : { more: onMore }),
          copy: (text) => void writeClipboard(text),
        }}
        {...(push && mayKey && making.workspaceId !== null && first !== undefined
          ? { keys: <PushKeys workspaceId={making.workspaceId} path={first.path} now={now} /> }
          : {})}
        onOpen={open}
      />
    );
  }
  const width = compact || pageWidth <= 0 ? null : Math.min(DATA_PAGE_WIDTH, Math.max(0, pageWidth - 96));
  return (
    <View style={width === null ? undefined : { width, alignSelf: "center" }}>
      {page}
      {making.dialogs}
    </View>
  );
}
