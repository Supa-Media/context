/**
 * The page's notes and rows with the List's own writes laid over them until
 * the device's copy and the listing catch up (`pendingNotes.ts`). Reset when
 * the page moves to another folder: an overlay is about this page's writes.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ListNote } from "../../listBlock/model";
import type { ItemEntry } from "../model";
import { NO_PENDING, pendCreate, pendMove, pendRemove, settlePending, withPendingEntries, withPendingNotes, type Pending } from "./pendingNotes";

export interface PendingRecord {
  created(note: ListNote): void;
  moved(from: string, to: string): void;
  removed(path: string): void;
  /** What the page draws right now, overlay included — what a move carries. */
  known(): readonly ListNote[];
}

export function usePendingNotes<E extends ItemEntry>(folder: string, loaded: readonly ListNote[] | null, rows: readonly E[]) {
  const [state, setState] = useState<{ folder: string; pending: Pending }>({ folder, pending: NO_PENDING });
  const pending = state.folder === folder ? state.pending : NO_PENDING;
  const notes = useMemo(() => (loaded === null ? null : withPendingNotes(loaded, pending)), [loaded, pending]);
  const drawnRows = useMemo(() => withPendingEntries(folder, rows, pending), [folder, rows, pending]);
  const latest = useRef(notes ?? []);
  latest.current = notes ?? [];

  // Settle against what the device and the listing now say.
  useEffect(() => {
    const listed = new Map([[folder, rows.map((row) => row.path)]]);
    setState((current) => {
      if (current.folder !== folder) return { folder, pending: NO_PENDING };
      const next = settlePending(current.pending, loaded, listed);
      return next === current.pending ? current : { folder, pending: next };
    });
  }, [folder, loaded, rows]);

  const update = useCallback(
    (change: (pending: Pending) => Pending) =>
      setState((current) => ({ folder, pending: change(current.folder === folder ? current.pending : NO_PENDING) })),
    [folder],
  );
  const record = useMemo<PendingRecord>(
    () => ({
      created: (note) => update((current) => pendCreate(current, note)),
      moved: (from, to) => {
        const known = latest.current;
        update((current) => pendMove(current, known, from, to, Date.now()));
      },
      removed: (path) => {
        const known = latest.current;
        update((current) => pendRemove(current, known, path));
      },
      known: () => latest.current,
    }),
    [update],
  );
  return { notes, rows: drawnRows, record };
}
