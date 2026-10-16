/**
 * What a folder page needs before it is drawn, kept and read ahead.
 *
 * Owner, 2026-10-16, from a screen recording of the phone: "the app flickers a
 * lot … make sure before navigating to any page everything in that page is
 * loaded, and we should be preloading the about.md/index.md etc whenever we
 * load a folder." A folder page used to slide in empty and fill itself in
 * three steps — the folder's raw name, then its title and description, then
 * the status circles — and did all three again on the way back, because every
 * read lived in the page's own state and went with it.
 *
 * So the three reads a page is drawn from live here, per source, outside any
 * component:
 *
 *  - the folder's **front note** (`about.md`, `index.md`, …): its title,
 *    status and first paragraph (`loadFront`, one call for many folders);
 *  - the folder's **notes**, subfolders included, and the front notes above
 *    it: the statuses, the counts and the List (`readFolder`);
 *  - the front note's **words**, which the page draws under the title
 *    (`readBody`).
 *
 * A page draws whatever is here at once and reads again behind it, so going
 * back is instant and a changed note still shows. A listing reads its
 * folders' front notes ahead (`preloadFronts`), pressing a folder reads the
 * rest (`preloadFolderPage`), and the phone keeps the page it is on until
 * `folderPageReady` says the next one has all three (`useShownEntry`).
 *
 * Nothing here is a note's body beyond the front note's opening words the
 * page shows anyway, and all of it is in memory only: a reload starts empty.
 */

import { isEncryptedNote } from "../../encryption/envelope";
import type { FolderListSource, ListNote } from "../listBlock/model";
import { summarizeFolder } from "./model";
import type { PanelBody } from "./panel/usePanelBody";

export interface FolderRead {
  readonly notes: readonly ListNote[];
  readonly complete: boolean;
  readonly missing?: readonly string[];
}

interface SourceCache {
  readonly front: Map<string, readonly ListNote[]>;
  readonly folders: Map<string, FolderRead>;
  readonly bodies: Map<string, PanelBody>;
  readonly reading: Map<string, Promise<unknown>>;
}

/** Folders and bodies kept per source, at most: a phone walks a few hundred folders at most in a session. */
const MAX_KEPT = 400;

let caches = new WeakMap<FolderListSource, SourceCache>();
/** Bumped by `forgetPageCache`: a read that started before it files nothing. */
let generation = 0;
const listeners = new Set<() => void>();
let version = 0;

function cacheOf(source: FolderListSource): SourceCache {
  let cache = caches.get(source);
  if (cache === undefined) {
    cache = { front: new Map(), folders: new Map(), bodies: new Map(), reading: new Map() };
    caches.set(source, cache);
  }
  return cache;
}

function changed(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}

function keep<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_KEPT) map.delete(map.keys().next().value as string);
}

/**
 * Forget everything: beside every clear of this device's copy (signing out,
 * leaving a workspace), so nothing read under one session is drawn in the next.
 */
export function forgetPageCache(): void {
  caches = new WeakMap();
  generation += 1;
  changed();
}

/** Heard whenever anything lands here; `pageCacheVersion` says which landing a render saw. */
export function subscribePageCache(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function pageCacheVersion(): number {
  return version;
}

export function cachedFront(source: FolderListSource | undefined, folder: string): readonly ListNote[] | undefined {
  return source === undefined ? undefined : caches.get(source)?.front.get(folder);
}

export function cachedFolder(source: FolderListSource | undefined, folder: string): FolderRead | undefined {
  return source === undefined ? undefined : caches.get(source)?.folders.get(folder);
}

export function cachedBody(source: FolderListSource | undefined, path: string): PanelBody | undefined {
  return source === undefined ? undefined : caches.get(source)?.bodies.get(path);
}

export function rememberFolder(source: FolderListSource, folder: string, read: FolderRead): void {
  keep(cacheOf(source).folders, folder, read);
  changed();
}

export function rememberFront(source: FolderListSource, folder: string, notes: readonly ListNote[]): void {
  keep(cacheOf(source).front, folder, notes);
  changed();
}

export function rememberBody(source: FolderListSource, path: string, body: PanelBody): void {
  keep(cacheOf(source).bodies, path, body);
  changed();
}

/** One read at a time per key: a page and the press that preloaded it share it. */
function once<T>(source: FolderListSource, key: string, run: () => Promise<T>, fresh = false): Promise<T> {
  const reading = cacheOf(source).reading;
  const going = reading.get(key);
  // A fresh read (something changed) never answers with one that started before the change.
  if (going !== undefined && !fresh) return going as Promise<T>;
  const started = run().finally(() => {
    if (reading.get(key) === started) reading.delete(key);
  });
  reading.set(key, started);
  return started;
}

/** Every folder above `folder`, nearest first, and the workspace root last. */
export function ancestorsOf(folder: string): string[] {
  if (folder === "") return [];
  const out: string[] = [];
  let at = folder;
  while (at.includes("/")) {
    at = at.slice(0, at.lastIndexOf("/"));
    out.push(at);
  }
  out.push("");
  return out;
}

/**
 * The folder's notes with subfolders, and the front notes of every folder
 * above it, since a status list is inherited (`statuses.ts`). Where the source
 * reads front notes by name the folders above cost one call; elsewhere each is
 * loaded without its subfolders.
 */
export function readFolder(source: FolderListSource, folder: string, fresh = false): Promise<FolderRead> {
  return once(source, `folder\u0000${folder}`, async () => {
    const started = generation;
    const folders = ancestorsOf(folder);
    const above: Promise<readonly (readonly ListNote[])[]> =
      source.loadFront !== undefined
        ? source.loadFront(folders).then((notes) => [notes])
        : Promise.all(folders.map((at) => source.load(at, false).then((each) => each?.notes ?? [])));
    const [result, aboveNotes] = await Promise.all([source.load(folder, true), above]);
    if (result === null) return { notes: [], complete: false };
    // Only the front notes above matter, and a note is never listed twice.
    const byPath = new Map(result.notes.map((note) => [note.path, note]));
    for (const each of aboveNotes) for (const note of each) if (!byPath.has(note.path)) byPath.set(note.path, note);
    const read: FolderRead = {
      notes: [...byPath.values()],
      complete: result.complete,
      ...(result.missing === undefined ? {} : { missing: result.missing }),
    };
    if (started === generation) rememberFolder(source, folder, read);
    return read;
  }, fresh);
}

function parentOf(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

/**
 * The front notes of `folders`, in one call, filed under each folder — an
 * empty list for a folder that has none, which is an answer too. Then the
 * words of each front note, which the page draws under its title.
 */
export function readFronts(source: FolderListSource, folders: readonly string[], fresh = false): Promise<void> {
  const loadFront = source.loadFront;
  const wanted = [...new Set(folders.filter((folder) => folder !== ""))];
  if (loadFront === undefined || wanted.length === 0) return Promise.resolve();
  return once(source, `front\u0000${wanted.join("\u0000")}`, async () => {
    const started = generation;
    const notes = await loadFront(wanted);
    if (started !== generation) return;
    const byFolder = new Map<string, ListNote[]>(wanted.map((folder) => [folder, []]));
    for (const note of notes) byFolder.get(parentOf(note.path))?.push(note);
    const cache = cacheOf(source);
    for (const [folder, front] of byFolder) keep(cache.front, folder, front);
    changed();
    await Promise.all(
      [...byFolder].map(([folder, front]) => {
        const about = aboutOf(folder, front);
        if (about === null) return null;
        // Read with the listing already, where the source could (`ListNote.text`).
        const text = front.find((each) => each.path === about)?.text;
        if (text !== undefined) {
          rememberBody(source, about, isEncryptedNote(text) ? { kind: "locked" } : { kind: "text", text });
          return null;
        }
        return readAbout(source, about, fresh);
      }),
    );
  }, fresh);
}

/** The front note a page draws its words from, or null where the folder has none. */
export function aboutOf(folder: string, front: readonly ListNote[]): string | null {
  const summary = summarizeFolder(folder, front);
  return summary.creates ? null : summary.target;
}

/** A front note's words, read once and kept; read again with `fresh`. */
export function readAbout(source: FolderListSource, path: string, fresh = false): Promise<PanelBody> {
  const readBody = source.readBody;
  if (readBody === undefined) return Promise.resolve({ kind: "none" });
  const kept = cachedBody(source, path);
  if (kept !== undefined && !fresh) return Promise.resolve(kept);
  return once(source, `body\u0000${path}`, async () => {
    const started = generation;
    const body = await readBody(path)
      .then((found): PanelBody => {
        if (found === null) return { kind: "missing" };
        // Said by the source, or by the text itself: an envelope is never drawn as words.
        if (found.encrypted || isEncryptedNote(found.text)) return { kind: "locked" };
        return { kind: "text", text: found.text };
      })
      .catch((): PanelBody => ({ kind: "missing" }));
    if (started === generation) rememberBody(source, path, body);
    return body;
  }, fresh);
}

/** Read the front notes of folders a listing shows, so opening one draws its title and words at once. */
export function preloadFronts(source: FolderListSource | undefined, folders: readonly string[]): void {
  if (source === undefined) return;
  const unknown = folders.filter((folder) => folder !== "" && cachedFront(source, folder) === undefined);
  if (unknown.length === 0) return;
  void readFronts(source, unknown).catch(() => {});
}

/** Everything a folder's page is drawn from, read ahead of opening it (a press on its row). */
export function preloadFolderPage(source: FolderListSource | undefined, folder: string): void {
  if (source === undefined) return;
  if (cachedFront(source, folder) === undefined) void readFronts(source, [folder]).catch(() => {});
  if (cachedFolder(source, folder) === undefined) void readFolder(source, folder).catch(() => {});
}

/**
 * Whether a folder's page can be drawn whole: its front note, its notes and
 * the front note's words are all here. The workspace root's page is Home,
 * which reads none of these.
 */
export function folderPageReady(source: FolderListSource | undefined, folder: string): boolean {
  if (source === undefined || folder === "") return true;
  if (cachedFolder(source, folder) === undefined) return false;
  // A source that cannot read front notes by name draws the title from the folder's notes.
  if (source.loadFront === undefined) return true;
  const front = cachedFront(source, folder);
  if (front === undefined) return false;
  if (source.readBody === undefined) return true;
  const about = aboutOf(folder, front);
  return about === null || cachedBody(source, about) !== undefined;
}
