/**
 * A sheet, as the note column opens one, with what the data folder says of
 * it: a sheet a source keeps up to date (GitHub, Cloudflare, Stripe) opens
 * read-only under the lock line that names the source and links to its page
 * (board 08; `syncedSheet.ts`). Any other sheet is the plain grid.
 */

import type { FolderListSource } from "../listBlock/model";
import { SheetView, type SheetViewProps } from "../sheet/SheetView";
import { useKeptBy } from "./useKeptBy";

export function SourceSheetView({
  source,
  onOpenFolder,
  ...props
}: Omit<SheetViewProps, "keptBy"> & { source: FolderListSource | undefined; onOpenFolder?: (path: string) => void }) {
  const kept = useKeptBy(props.path, source);
  return (
    <SheetView
      {...props}
      {...(kept === null ? {} : { keptBy: { name: kept.name, ...(onOpenFolder === undefined ? {} : { onOpenSource: () => onOpenFolder(kept.folder) }) } })}
    />
  );
}
