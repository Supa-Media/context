/**
 * Every area's readings on the open page: the `metrics.csv` in each area that
 * names a metric, read through the page's source (so at the reader's
 * clearance, like every other note on the page) and parsed by `readings.ts`.
 *
 * Read by name rather than found in the page's notes: the folder listing a
 * page is drawn from holds Markdown notes only, so a sheet never appears in
 * it. A sheet that is not there, or a read that fails or comes back
 * encrypted, leaves that area without readings: the box says "—", as it did
 * before there were any. The sheets are read again whenever anything under
 * those areas changes.
 */

import { useEffect, useMemo, useState } from "react";
import type { ListNote } from "../../listBlock/model";
import { METRICS_SHEET, readingsOf, type Readings } from "./readings";
import type { AreaNode } from "./seat";

export type ReadBody = (path: string) => Promise<{ text: string; encrypted: boolean } | null>;

function metricFolders(node: AreaNode, out: string[] = []): string[] {
  if (node.seat.metrics.length > 0) out.push(node.seat.folder);
  for (const child of node.areas) metricFolders(child, out);
  return out;
}

/** Readings by area folder. */
export function useReadings(tree: AreaNode, notes: readonly ListNote[], readBody: ReadBody | undefined): ReadonlyMap<string, Readings> {
  const folders = useMemo(() => metricFolders(tree), [tree]);
  // What changed under those areas: a new reading written by an agent moves
  // the sheet's folder, and the page's notes are reloaded when it does.
  const stamp = useMemo(() => {
    let latest = 0;
    for (const note of notes) {
      if (folders.some((folder) => note.path.startsWith(`${folder}/`))) latest = Math.max(latest, note.updatedAt ?? 0);
    }
    return latest;
  }, [notes, folders]);
  const key = `${folders.join("\n")}@${stamp}`;
  const [read, setRead] = useState<ReadonlyMap<string, Readings>>(() => new Map());

  useEffect(() => {
    if (readBody === undefined || folders.length === 0) return;
    let current = true;
    void Promise.all(
      folders.map(async (folder) => {
        const body = await readBody(`${folder}/${METRICS_SHEET}`).catch(() => null);
        return [folder, body === null || body.encrypted ? new Map() : readingsOf(body.text)] as const;
      }),
    ).then((pairs) => {
      if (current) setRead(new Map(pairs));
    });
    return () => {
      current = false;
    };
    // `key` names exactly the folders and how fresh their notes are; `folders` follows it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, readBody]);

  return read;
}
