/**
 * The workspace's metrics as the Areas page reads them: stage B's own
 * `useDataWorkspace` over the data folder (found by job), so an area's
 * reading is worked out by the engine the Data page uses, from the sheets
 * this reader can read, and kept nowhere but memory.
 *
 * Without the file browser's listings (a page drawn on its own) the data
 * folder is not listed, so there are no workspace metrics and every area
 * reads its own `metrics.csv`, as before.
 */

import { useMemo, useState } from "react";
import type { FolderListSource } from "../../listBlock/model";
import { dataFolderNow } from "../../jobIcons/jobFoldersNow";
import { useDataWorkspace, type DataWorkspace, type Listings } from "../../data/useDataWorkspace";
import type { WorkspaceMetrics } from "./areaMetric";

const NO_LISTINGS: Listings = { listingOf: () => undefined, loadListing: () => {} };

export function useWorkspaceMetrics(
  source: FolderListSource | undefined,
  listings: Listings | undefined,
): { metrics: WorkspaceMetrics; ws: DataWorkspace } {
  const dataFolder = dataFolderNow();
  // One time per page opening: a reading's "1h ago" is said against it, as the Data page's are.
  const [now] = useState(() => Date.now());
  const usable = listings !== undefined && dataFolder !== "";
  const ws = useDataWorkspace(dataFolder, usable ? source : undefined, usable ? listings : NO_LISTINGS, now);
  const metrics = useMemo<WorkspaceMetrics>(
    () => ({
      metrics: ws.metrics,
      worked: ws.worked,
      sources: ws.sources,
      sheets: ws.sheets,
      uses: ws.uses,
      settled: ws.settled,
      known: !usable || ws.notes !== null,
      now,
    }),
    [ws.metrics, ws.worked, ws.sources, ws.sheets, ws.uses, ws.settled, ws.notes, usable, now],
  );
  return { metrics, ws };
}
