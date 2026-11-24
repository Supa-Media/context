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
 *
 * Kept per source in memory, beside `pageCache` and forgotten with it: the
 * Areas folder reads every sheet beneath it, so opening a sub-area, or going
 * back, draws its readings at once rather than "—" and then the numbers
 * (owner, 2026-11-24: "make it immediately snappy"). Each sheet is read once
 * at a time, so a page and `preloadAreas` share a read.
 */

import { useEffect, useMemo, useState } from "react";
import type { ListNote } from "../../listBlock/model";
import { pageCacheGeneration } from "../pageCache";
import { METRICS_SHEET, readingsOf, type Readings } from "./readings";
import type { AreaNode } from "./seat";

export type ReadBody = (path: string) => Promise<{ text: string; encrypted: boolean } | null>;

/** How long a sheet read stands before a page opening asks again behind it, as a list's server answer does. */
const READ_AGAIN_AFTER = 15_000;

interface Kept {
  readonly generation: number;
  /** Readings by area folder, with when they were read. */
  readonly read: Map<string, { readings: Readings; at: number }>;
  readonly reading: Map<string, Promise<Readings>>;
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

export function metricFolders(node: AreaNode, out: string[] = []): string[] {
  if (node.seat.metrics.length > 0) out.push(node.seat.folder);
  for (const child of node.areas) metricFolders(child, out);
  return out;
}

/** What is kept for `folders`, by area folder. */
export function keptReadings(readBody: ReadBody | undefined, folders: readonly string[]): ReadonlyMap<string, Readings> {
  const out = new Map<string, Readings>();
  if (readBody === undefined) return out;
  const { read } = keptFor(readBody);
  for (const folder of folders) {
    const each = read.get(folder);
    if (each !== undefined) out.set(folder, each.readings);
  }
  return out;
}

/** Whether every one of `folders` was read after `since` and lately enough to stand. */
function fresh(readBody: ReadBody, folders: readonly string[], since: number): boolean {
  const { read } = keptFor(readBody);
  const now = Date.now();
  return folders.every((folder) => {
    const each = read.get(folder);
    return each !== undefined && each.at > since && now - each.at < READ_AGAIN_AFTER;
  });
}

/** Read every one of `folders`' sheets, all at once, filing each as it lands. */
export function readReadings(readBody: ReadBody, folders: readonly string[]): Promise<void> {
  const cache = keptFor(readBody);
  return Promise.all(
    folders.map((folder) => {
      const going = cache.reading.get(folder);
      if (going !== undefined) return going;
      const started = readBody(`${folder}/${METRICS_SHEET}`)
        .catch(() => null)
        .then((body): Readings => (body === null || body.encrypted ? new Map() : readingsOf(body.text)))
        .then((readings) => {
          if (keptFor(readBody) === cache) cache.read.set(folder, { readings, at: Date.now() });
          return readings;
        })
        .finally(() => {
          if (cache.reading.get(folder) === started) cache.reading.delete(folder);
        });
      cache.reading.set(folder, started);
      return started;
    }),
  ).then(() => undefined);
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
  // Bumped as reads land; what is drawn is always what is kept.
  const [landed, setLanded] = useState(0);

  useEffect(() => {
    if (readBody === undefined || folders.length === 0) return;
    if (fresh(readBody, folders, stamp)) return;
    let current = true;
    void readReadings(readBody, folders).then(() => {
      if (current) setLanded((count) => count + 1);
    });
    return () => {
      current = false;
    };
    // `key` names exactly the folders and how fresh their notes are; `folders` and `stamp` follow it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, readBody]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => keptReadings(readBody, folders), [readBody, folders, landed]);
}
