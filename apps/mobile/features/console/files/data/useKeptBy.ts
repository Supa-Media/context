/**
 * The source that keeps an open sheet up to date, if any (`syncedSheet.ts`),
 * from the reader's own notes of the sheet's folder, read through the page
 * cache as the Data page reads them. Nothing is read for a sheet outside a
 * source folder.
 */

import { useMemo } from "react";
import type { FolderListSource } from "../listBlock/model";
import { dataFolderNow } from "../jobIcons/jobFoldersNow";
import { keptBy, sourceFolderOfSheet, type KeptBy } from "./syncedSheet";
import { useFolderReads } from "./useData";

export function useKeptBy(path: string | null, source: FolderListSource | undefined): KeptBy | null {
  const dataFolder = dataFolderNow();
  const folder = sourceFolderOfSheet(path, dataFolder);
  const reads = useFolderReads(source, useMemo(() => (folder === null ? [] : [folder]), [folder]));
  const notes = folder === null ? null : (reads.get(folder) ?? null);
  return useMemo(() => (notes === null ? null : keptBy(path, dataFolder, notes)), [notes, path, dataFolder]);
}
