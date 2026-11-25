/**
 * Everything the Data page and the folder pages under it draw, in one place:
 * the sources and their datasets from the file browser's listings, the metric
 * notes and the areas that use them from the reader's notes, every dataset
 * sheet read by path, the Context source's two datasets counted from notes,
 * and each metric worked out over them. All of it at the reader's clearance
 * and nothing of it written (`docs/decisions/data-and-metrics.md`).
 */

import { useEffect, useMemo } from "react";
import type { FolderListSource, ListNote } from "../listBlock/model";
import type { FolderListing } from "../types";
import { areasFolderNow } from "../jobIcons/jobFoldersNow";
import { contextSheets, countedFolders, foldersToRead } from "./contextSource";
import { metricsIn, usesByMetric, type MetricNote, type Use } from "./metrics";
import { metricsFolderOf, sourceBySlug, sourcesIn, type DataSource } from "./sources";
import { sheetsSettled, useFolderReads, useSheets } from "./useData";
import { workOut, type RowsOf, type Sheet, type Worked } from "./workOut";

export interface Listings {
  listingOf: (path: string) => FolderListing | undefined;
  loadListing: (path: string) => void;
}

export interface DataWorkspace {
  readonly sources: readonly DataSource[];
  readonly metrics: readonly MetricNote[];
  /** Areas that use each metric, by its name lower-cased. */
  readonly uses: ReadonlyMap<string, readonly Use[]>;
  /** Every dataset by path, the Context source's counted ones included; null for one not read or not readable. */
  readonly sheets: ReadonlyMap<string, Sheet | null>;
  readonly worked: ReadonlyMap<string, Worked>;
  /** False until the listings, notes and sheets have all come once: a value drawn before that would flicker. */
  readonly settled: boolean;
  readonly rowsOf: RowsOf;
  /** The data folder's notes: about.md lines and metric notes. */
  readonly notes: readonly ListNote[] | null;
}

const NO_NOTES: readonly ListNote[] = [];

/** Sheets and computed datasets, by `source/dataset`: what a formula reads. */
export function rowsReader(sources: readonly DataSource[], sheets: ReadonlyMap<string, Sheet | null>): RowsOf {
  const bySlug = sourceBySlug(sources);
  return (slug, name) => {
    const source = bySlug(slug);
    const dataset = source?.datasets.find((each) => each.name.toLowerCase() === name.toLowerCase());
    return dataset === undefined ? null : (sheets.get(dataset.path) ?? null);
  };
}

export function useDataWorkspace(dataFolder: string, source: FolderListSource | undefined, listings: Listings, now: number): DataWorkspace {
  const { listingOf, loadListing } = listings;
  const metricsFolder = metricsFolderOf(dataFolder);
  const top = listingOf(dataFolder);
  const children = useMemo(() => (top?.entries ?? []).filter((e) => e.kind === "folder").map((e) => e.path), [top]);
  // Each source folder's listing names its sheets; the data folder's names the sources.
  useEffect(() => {
    loadListing(dataFolder);
    for (const child of children) loadListing(child);
  }, [dataFolder, children, loadListing]);

  const areas = areasFolderNow();
  const dataRead = useFolderReads(source, useMemo(() => [dataFolder, areas], [dataFolder, areas]));
  const dataNotes = dataRead.get(dataFolder) ?? null;
  const areaNotes = dataRead.get(areas) ?? null;
  const notes = dataNotes ?? NO_NOTES;
  // The listings change identity as they load; what is drawn follows their entries.
  const listingKey = [dataFolder, ...children].map((path) => `${path}:${listingOf(path)?.entries.length ?? -1}`).join("|");
  const sources = useMemo(
    () => sourcesIn(dataFolder, listingOf, notes),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataFolder, notes, listingKey],
  );
  const order = useMemo(() => (listingOf(metricsFolder)?.entries ?? []).map((e) => e.path), [listingOf, metricsFolder]);
  const metrics = useMemo(() => metricsIn(metricsFolder, notes, order), [metricsFolder, notes, order]);
  const uses = useMemo(() => usesByMetric(areas, areaNotes ?? NO_NOTES), [areas, areaNotes]);

  // The Context source counts the folders its about.md names, from the reader's own notes of them.
  const context = sources.find((each) => each.kind === "context") ?? null;
  const counted = useMemo(() => countedFolders(context), [context]);
  const countRead = useFolderReads(source, useMemo(() => foldersToRead(counted), [counted]));

  const wanted = useMemo(() => {
    const out = new Map<string, number>();
    for (const each of sources) {
      const entries = listingOf(each.folder)?.entries ?? [];
      for (const dataset of each.datasets) {
        if (dataset.computed) continue;
        out.set(dataset.path, entries.find((entry) => entry.path === dataset.path)?.updatedAt ?? 0);
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources, listingKey]);
  const read = useSheets(source?.readBody, wanted);
  const minute = Math.floor(now / 60_000);
  const sheets = useMemo(() => {
    const out = new Map(read);
    if (context !== null) {
      const counting = [...countRead.values()].flatMap((list) => list ?? []);
      const computed = contextSheets(counted, counting, minute * 60_000);
      for (const dataset of context.datasets) if (dataset.computed) out.set(dataset.path, computed.get(dataset.name) ?? null);
    }
    return out;
  }, [read, context, countRead, counted, minute]);
  const rowsOf = useMemo(() => rowsReader(sources, sheets), [sources, sheets]);
  const worked = useMemo(() => {
    const out = new Map<string, Worked>();
    for (const metric of metrics) out.set(metric.path, workOut(metric, rowsOf, minute * 60_000));
    return out;
  }, [metrics, rowsOf, minute]);

  const settled =
    dataNotes !== null &&
    top !== undefined &&
    children.every((child) => listingOf(child) !== undefined) &&
    sheetsSettled(source?.readBody, wanted.keys()) &&
    [...countRead.values()].every((list) => list !== null);
  return { sources, metrics, uses, sheets, worked, settled, rowsOf, notes: dataNotes };
}
