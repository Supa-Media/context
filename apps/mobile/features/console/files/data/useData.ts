/**
 * What the Data page and the pages under it read: notes of a few folders, and
 * dataset sheets by path, each through the page's own source, so at the
 * reader's clearance like everything else on the page.
 *
 * Sheets are read by name through `readBody` (a folder's notes are Markdown
 * only, so a sheet is never among them), as the Areas page reads each area's
 * `metrics.csv` (`folderPage/areas/useReadings.ts`), and kept the same way:
 * per source in memory, forgotten with `pageCache`, one read at a time, read
 * again when the listing says the sheet changed or after a while. A sheet
 * that is not there, a read that fails and one that comes back encrypted are
 * all null: the engine reads that as "can't read", and a metric over it is
 * drawn Hidden.
 */

import { useEffect, useMemo, useState } from "react";
import { parseSheet } from "../../../../../mcp/src/sheets/csv.js";
import type { FolderListSource, ListNote } from "../listBlock/model";
import { cachedFolder, pageCacheGeneration, readFolder } from "../folderPage/pageCache";
import type { Sheet } from "./workOut";

export type ReadBody = NonNullable<FolderListSource["readBody"]>;

/** How long a sheet read stands before a page opening asks again, as the Areas page's readings do. */
const READ_AGAIN_AFTER = 15_000;

interface Kept {
  readonly generation: number;
  readonly read: Map<string, { sheet: Sheet | null; at: number; stamp: number }>;
  readonly reading: Map<string, Promise<Sheet | null>>;
}

let kept = new WeakMap<ReadBody, Kept>();

function keptFor(readBody: ReadBody): Kept {
  const generation = pageCacheGeneration();
  let found = kept.get(readBody);
  if (found !== undefined && found.generation !== generation) {
    // Signed out or left the workspace since: nothing read then is drawn now.
    kept = new WeakMap();
    found = undefined;
  }
  if (found === undefined) {
    found = { generation, read: new Map(), reading: new Map() };
    kept.set(readBody, found);
  }
  return found;
}

export function sheetOfText(text: string): Sheet | null {
  const parsed = parseSheet(text) as unknown as Sheet & { tooLarge?: boolean };
  return parsed.tooLarge === true ? null : { columns: parsed.columns, rows: parsed.rows };
}

function readSheet(readBody: ReadBody, path: string, stamp: number): Promise<Sheet | null> {
  const cache = keptFor(readBody);
  const going = cache.reading.get(path);
  if (going !== undefined) return going;
  const started = readBody(path)
    .catch(() => null)
    .then((body) => (body === null || body.encrypted ? null : sheetOfText(body.text)))
    .then((sheet) => {
      if (keptFor(readBody) === cache) cache.read.set(path, { sheet, at: Date.now(), stamp });
      return sheet;
    })
    .finally(() => {
      if (cache.reading.get(path) === started) cache.reading.delete(path);
    });
  cache.reading.set(path, started);
  return started;
}

/**
 * Sheets by path, each with the time its listing says it last changed (0 when
 * unknown). Null for a sheet not (yet) read, or one that cannot be read.
 */
export function useSheets(readBody: ReadBody | undefined, wanted: ReadonlyMap<string, number>): ReadonlyMap<string, Sheet | null> {
  const key = [...wanted].map(([path, stamp]) => `${path}@${stamp}`).join("\n");
  const [landed, setLanded] = useState(0);
  useEffect(() => {
    if (readBody === undefined || wanted.size === 0) return;
    const cache = keptFor(readBody);
    const now = Date.now();
    const stale = [...wanted].filter(([path, stamp]) => {
      const each = cache.read.get(path);
      return each === undefined || each.stamp !== stamp || (stamp === 0 && now - each.at > READ_AGAIN_AFTER);
    });
    if (stale.length === 0) return;
    let current = true;
    void Promise.all(stale.map(([path, stamp]) => readSheet(readBody, path, stamp))).then(() => {
      if (current) setLanded((count) => count + 1);
    });
    return () => {
      current = false;
    };
    // `key` names exactly the paths and how fresh each is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, readBody]);
  return useMemo(() => {
    const out = new Map<string, Sheet | null>();
    if (readBody === undefined) return out;
    const cache = keptFor(readBody);
    for (const path of wanted.keys()) out.set(path, cache.read.get(path)?.sheet ?? null);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, readBody, landed]);
}

/** Whether every one of `paths` has been read at least once (so a missing value is missing, not loading). */
export function sheetsSettled(readBody: ReadBody | undefined, paths: Iterable<string>): boolean {
  if (readBody === undefined) return true;
  const cache = keptFor(readBody);
  for (const path of paths) if (!cache.read.has(path)) return false;
  return true;
}

/**
 * The notes of each of `folders`, subfolders included, as `pageCache` reads
 * and keeps them for folder pages; null for a folder not read yet. Read again
 * when the source says something changed.
 */
export function useFolderReads(source: FolderListSource | undefined, folders: readonly string[]): ReadonlyMap<string, readonly ListNote[] | null> {
  const key = folders.join("\n");
  const [landed, setLanded] = useState(0);
  useEffect(() => {
    if (source === undefined || folders.length === 0) return;
    let current = true;
    const read = (fresh: boolean) =>
      void Promise.all(folders.map((folder) => readFolder(source, folder, fresh).catch(() => null))).then(() => {
        if (current) setLanded((count) => count + 1);
      });
    read(false);
    const stop = source.subscribe?.(() => read(true));
    return () => {
      current = false;
      stop?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, source]);
  return useMemo(() => {
    const out = new Map<string, readonly ListNote[] | null>();
    for (const folder of folders) out.set(folder, cachedFolder(source, folder)?.notes ?? null);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, source, landed]);
}
