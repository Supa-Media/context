/**
 * What the Data page's two buttons make, shared with the Areas page's metric
 * picker so "New metric…" and "Connect a source" there do exactly what they
 * do on the Data page: New metric writes a metric note in the data folder's
 * `metrics/` with a starting formula and opens it; Connect a source offers
 * Send from your code, writes the source's `about.md` and its first sheet,
 * then opens the key dialog (`ConnectSource.tsx`).
 *
 * Writes go through the console's own create (`TaskHost.io`), so they are
 * the writer's notes like any other; each is absent for someone who may not
 * make it, and its button is not drawn.
 */

import { useMemo, useState, type ReactNode } from "react";
import type { Id } from "@context/convex/_generated/dataModel";
import { useOptionalConsoleData } from "../../ConsoleDataContext";
import { selectedContext } from "../../types";
import { dataFolderNow } from "../jobIcons/jobFoldersNow";
import type { FolderPageHost } from "../folderPage/useFolderPage";
import { SheetSourcesDialog } from "../sheet/SheetSources";
import { ConnectSourceDialog } from "./ConnectSource";
import { freePath, newMetricText, startingFormula, type PushSourceFiles } from "./dataWrites";
import { metricsFolderOf } from "./sources";
import type { DataWorkspace, Listings } from "./useDataWorkspace";

export interface DataMaking {
  readonly newMetric?: () => void;
  readonly connect?: () => void;
  /** Whether this reader may make a key, the source page's New key. */
  readonly mayKey: boolean;
  readonly workspaceId: string | null;
  readonly openKey: (path: string, columns: readonly string[]) => void;
  /** The Connect a source and key dialogs, when open. */
  readonly dialogs: ReactNode;
}

type Dialog = null | { kind: "connect" } | { kind: "key"; path: string; columns: readonly string[] };

export function useDataMaking({
  host,
  listings,
  ws,
  compact,
  open,
  stay = false,
}: {
  host: FolderPageHost | undefined;
  listings: Listings | undefined;
  ws: Pick<DataWorkspace, "sources" | "sheets">;
  compact: boolean;
  open: (path: string) => void;
  /**
   * Stay on this page once a source is made, its key dialog over it: the
   * Areas page, which opening the source's folder would leave, and the key
   * dialog with it. The Data page opens the new source's page under it.
   */
  stay?: boolean;
}): DataMaking {
  const dataFolder = dataFolderNow();
  const metricsFolder = metricsFolderOf(dataFolder);
  const data = useOptionalConsoleData();
  const current = data === null ? null : selectedContext(data);
  const mayKey = current !== null && data?.demo !== true && (current.role === "owner" || current.role === "editor");
  const io = host?.tasks?.io;
  const [dialog, setDialog] = useState<Dialog>(null);
  const taken = useMemo(() => {
    const out = new Set<string>();
    for (const path of [dataFolder, metricsFolder, ...ws.sources.map((s) => s.folder)]) {
      for (const entry of listings?.listingOf(path)?.entries ?? []) out.add(entry.path);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.sources, listings, dataFolder, metricsFolder]);

  const newMetric =
    io === undefined || dataFolder === ""
      ? undefined
      : () => {
          const path = freePath(metricsFolder, "new-metric", ".md", taken);
          void io
            .create(path, newMetricText(startingFormula(ws.sources, ws.sheets)))
            .then(() => {
              host?.tasks?.refresh([metricsFolder]);
              open(path);
            })
            .catch(() => host?.tasks?.say("The metric could not be made. Try again."));
        };

  const makeSource = async (files: PushSourceFiles): Promise<string | null> => {
    if (io === undefined) return "You can't add to this workspace.";
    try {
      await io.create(files.about.path, files.about.text);
      await io.create(files.sheet.path, files.sheet.text);
    } catch {
      return "The source could not be made. Try again.";
    }
    host?.tasks?.refresh([dataFolder, files.folder]);
    const columns = files.sheet.text.trim().split(",").map((cell) => cell.split(":")[0] ?? cell);
    setDialog({ kind: "key", path: files.sheet.path, columns });
    if (!stay) open(files.folder);
    return null;
  };

  const dialogs = (
    <>
      {dialog?.kind === "connect" ? (
        <ConnectSourceDialog dataFolder={dataFolder} taken={taken} sheet={compact} onMake={makeSource} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === "key" && current !== null ? (
        <SheetSourcesDialog workspaceId={current.id as Id<"workspaces">} path={dialog.path} columns={dialog.columns} onClose={() => setDialog(null)} />
      ) : null}
    </>
  );
  return {
    ...(newMetric === undefined ? {} : { newMetric }),
    ...(io === undefined || !mayKey || dataFolder === "" ? {} : { connect: () => setDialog({ kind: "connect" }) }),
    mayKey,
    workspaceId: current?.id ?? null,
    openKey: (path, columns) => setDialog({ kind: "key", path, columns }),
    dialogs,
  };
}
