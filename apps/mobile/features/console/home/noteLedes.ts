import { useEffect, useMemo, useState } from "react";
import type { FolderListSource } from "../files/listBlock/model";

/**
 * THE FIRST LINES OF THE NOTES ON THE PHONE'S NOTES PAGE.
 *
 * Dev2 (2026-10-18): *"let's make sure we are loading note content when we are
 * on a page so that we can display the first few lines. If we have it
 * downloaded it should be instantly loaded … but if it's still being
 * downloaded maybe we should have UI to show that it's loading."*
 *
 * A note this device keeps already carries its first paragraph
 * (`useHomeSource` reads it from the device's copy), and is drawn with it at
 * once. Every other row on the page asks here: one `load` per folder the rows
 * sit in, without subfolders, which online is the server's parsed facts
 * (`folderNotes`, no note read from storage) and offline the device's copy.
 * Until a folder answers its rows' lines are `undefined` (loading); after it,
 * a note it did not name is `null` (nothing to show).
 *
 * Kept per source in memory, like `folderPage/pageCache.ts`: going back to
 * the page draws the lines at once, and a reload starts empty.
 */

interface LedeCache {
  readonly ledes: Map<string, string | null>;
  /** Folders that answered, or failed: their notes are no longer loading. */
  readonly done: Set<string>;
  readonly reading: Set<string>;
}

/** Folders read at once: a page names a few dozen at most, and each is one call. */
const AT_ONCE = 4;

let caches = new WeakMap<FolderListSource, LedeCache>();
const listeners = new Set<() => void>();

function cacheOf(source: FolderListSource): LedeCache {
  let cache = caches.get(source);
  if (cache === undefined) {
    cache = { ledes: new Map(), done: new Set(), reading: new Set() };
    caches.set(source, cache);
  }
  return cache;
}

function changed(): void {
  for (const listener of [...listeners]) listener();
}

export function parentOf(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

/** Forget every line: a sign-out, or a test. */
export function forgetNoteLedes(): void {
  caches = new WeakMap();
  changed();
}

/** Read the first lines of the notes in `folders`, a few folders at a time; each folder once. */
export async function readLedes(source: FolderListSource, folders: readonly string[]): Promise<void> {
  const cache = cacheOf(source);
  const queue = [...new Set(folders)].filter((folder) => !cache.done.has(folder) && !cache.reading.has(folder));
  for (const folder of queue) cache.reading.add(folder);
  const next = async (): Promise<void> => {
    const folder = queue.shift();
    if (folder === undefined) return;
    try {
      const listed = await source.load(folder, false);
      for (const note of listed?.notes ?? []) cache.ledes.set(note.path, note.lede ?? null);
    } catch {
      // A folder that could not answer shows its rows without a line, not a loading bar forever.
    } finally {
      cache.reading.delete(folder);
      cache.done.add(folder);
      changed();
    }
    return next();
  };
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, queue.length) }, next));
}

/**
 * A note's first line: what the row already carries, else what its folder
 * answered; `undefined` while that folder is still loading, `null` when there
 * is nothing to show (or no source to ask).
 */
export function ledeOf(
  source: FolderListSource | undefined,
  note: { path: string; lede: string | null },
): string | null | undefined {
  if (note.lede !== null) return note.lede;
  if (source === undefined) return null;
  const cache = caches.get(source);
  const found = cache?.ledes.get(note.path);
  if (found !== undefined) return found;
  return cache?.done.has(parentOf(note.path)) === true ? null : undefined;
}

/**
 * `ledeOf` for the rows a page draws, asking for the folders of every row
 * whose line is not known yet, and drawing again as each folder answers.
 */
export function useNoteLedes(
  source: FolderListSource | undefined,
  notes: readonly { path: string; lede: string | null }[],
): (note: { path: string; lede: string | null }) => string | null | undefined {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const listener = () => setVersion((at) => at + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  // As one string, so a new array of the same folders asks nothing again; `""` is the top level.
  const folders = useMemo(
    () => JSON.stringify([...new Set(notes.filter((note) => note.lede === null).map((note) => parentOf(note.path)))].sort()),
    [notes],
  );
  useEffect(() => {
    const wanted = JSON.parse(folders) as string[];
    if (source === undefined || wanted.length === 0) return;
    void readLedes(source, wanted);
  }, [source, folders]);
  return useMemo(() => {
    // A new function per landing, so the rows that read through it draw again.
    void version;
    return (note: { path: string; lede: string | null }) => ledeOf(source, note);
  }, [source, version]);
}
