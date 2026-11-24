/**
 * Every area's readings on the open page: the `metrics.csv` in each area
 * folder the notes reach, read through the page's source (so at the reader's
 * clearance, like every other note on the page) and parsed by `readings.ts`.
 *
 * A sheet is read again when its listing says it changed (`updatedAt`), and a
 * read that fails or comes back encrypted simply leaves that area without
 * readings: the box says "—", as it did before there were any.
 */

import { useEffect, useMemo, useState } from "react";
import type { ListNote } from "../../listBlock/model";
import { METRICS_SHEET, readingsOf, type Readings } from "./readings";

export type ReadBody = (path: string) => Promise<{ text: string; encrypted: boolean } | null>;

/** Readings by area folder. */
export function useReadings(notes: readonly ListNote[], readBody: ReadBody | undefined): ReadonlyMap<string, Readings> {
  const sheets = useMemo(
    () => notes.filter((note) => note.path.endsWith(`/${METRICS_SHEET}`)).map((note) => ({ path: note.path, stamp: `${note.path}@${note.updatedAt ?? 0}` })),
    [notes],
  );
  const key = sheets.map((sheet) => sheet.stamp).join("\n");
  const [read, setRead] = useState<{ key: string; byFolder: ReadonlyMap<string, Readings> }>({ key: "", byFolder: new Map() });

  useEffect(() => {
    if (readBody === undefined || sheets.length === 0) return;
    let current = true;
    void Promise.all(
      sheets.map(async ({ path }) => {
        const body = await readBody(path).catch(() => null);
        const folder = path.slice(0, path.lastIndexOf("/"));
        return [folder, body === null || body.encrypted ? new Map() : readingsOf(body.text)] as const;
      }),
    ).then((pairs) => {
      if (current) setRead({ key, byFolder: new Map(pairs) });
    });
    return () => {
      current = false;
    };
    // `key` names exactly the sheets and their versions; `sheets` follows it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, readBody]);

  return read.byFolder;
}
