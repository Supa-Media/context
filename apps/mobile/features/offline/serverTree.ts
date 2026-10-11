import type { CacheScope } from "./keys";
import { treeOf, type MirrorEntry, type MirrorIndex, type MirroredTree } from "./mirror";
import type { ManifestEntry, ManifestPage } from "./mirrorSync";
import type { FileEntry, FolderListing, Visibility } from "../console/files/types";

/**
 * The whole tree of a context, from the server, for a browser tab.
 *
 * **A browser tab keeps no copy of a workspace** (decided by the owner,
 * 2026-10-08), so since #1346 a plain tab had no mirror to draw the side panel
 * from: every folder somebody opened was its own `listFiles` round trip
 * ("Loading…"), and a change made by somebody else never reached the tree,
 * because the hint that says "walk again" asked a mirror that was not there.
 *
 * So a tab without a mirror walks `syncManifest` — the same privacy-filtered,
 * metadata-only walk the apps' mirror commits, paths and versions and no
 * bodies — and every folder then opens from it without a request. The tree
 * signal re-walks it, which is how a folder an agent moved appears without
 * anybody reloading.
 *
 * **Progressive, because a large workspace is several pages.** @seyi (9k
 * notes) is three or more `syncManifest` calls of 4,000 entries, one after
 * another, and holding the tree back until the last one landed left the panel
 * asking folder by folder for as long as the walk took. The manifest is in key
 * order, so once a page ends past every key a folder could hold, that folder
 * is whole: it is drawn at once, and the rest follow page by page.
 *
 * **Kept for the tab, never for the device.** The last complete tree is held
 * in memory and in `sessionStorage` — names and versions, no note text — so a
 * reload draws the panel at once instead of "Reading your bucket…". It dies
 * with the tab, is cleared at sign-out and when a context is left
 * (`forget.ts`), and never touches `localStorage`, whose quota the queue of
 * unsent edits depends on. The server is still asked: a tree read back after a
 * reload only draws rows first, as the device's copy always has (#1345).
 *
 * Keyed by clearance as well as workspace, as the mirror is, so a role that
 * changes mid-session never draws a tree walked at another clearance, and the
 * in-memory copy by session epoch, so nothing walked before a sign-out is
 * served after it.
 */

/**
 * The server's own answer, walked this session, rather than a copy kept on
 * the device: the tree may treat each folder in it as listed by the server
 * (`stampLiveFolders`). Partial while a walk is still paging: then `value`
 * holds only the folders the walk has finished.
 */
export type LiveTree = MirroredTree & { live: true };

interface Held {
  epoch: number;
  tree: LiveTree;
}

const held = new Map<string, Held>();

const keyOf = (scope: CacheScope, workspaceId: string) => `${scope}:${workspaceId}`;

/** The tree last walked for this clearance this session, or `null`. */
export function serverTree(scope: CacheScope, workspaceId: string, epoch: number): LiveTree | null {
  const found = held.get(keyOf(scope, workspaceId));
  if (found === undefined) return null;
  if (found.epoch !== epoch) {
    held.delete(keyOf(scope, workspaceId));
    return null;
  }
  return found.tree;
}

/**
 * Keep one walk's tree. `false` when nothing was kept. A walk that started
 * before the one already held must not undo it (two can overlap, as with the
 * mirror's `commitListing`), and a part of a later walk never replaces a whole
 * earlier one: it would take away every folder it has not reached yet.
 */
export function holdServerTree(
  scope: CacheScope,
  workspaceId: string,
  tree: LiveTree,
  epoch: number,
): boolean {
  const key = keyOf(scope, workspaceId);
  const before = held.get(key);
  if (before !== undefined && before.epoch === epoch) {
    if (before.tree.listedAt > tree.listedAt) return false;
    if (before.tree.complete && !tree.complete) return false;
  }
  held.set(key, { epoch, tree });
  return true;
}

/** Sign-out: every tree, in memory and in this tab's session storage. */
export function forgetServerTrees(): void {
  held.clear();
  const storage = sessionStore();
  if (storage === null) return;
  try {
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index);
      if (key !== null && key.startsWith(SESSION_PREFIX)) storage.removeItem(key);
    }
  } catch {
    // Blocked storage held nothing to forget.
  }
}

/** Leaving a context: its trees, at every clearance. */
export function forgetServerTree(workspaceId: string): void {
  for (const scope of ["private", "team"] as const) {
    held.delete(keyOf(scope, workspaceId));
    try {
      sessionStore()?.removeItem(sessionKey(scope, workspaceId));
    } catch {
      // As above.
    }
  }
}

interface WalkIO {
  manifest: (cursor: string | undefined) => Promise<ManifestPage>;
  /** The session this walk belongs to is still the current one. */
  mine: () => boolean;
  now: () => number;
  /** A tree to draw: each finished part, then the whole. */
  onTree: (tree: LiveTree) => void;
  maxPages?: number;
}

/** Pages one walk follows: a bound on a loop, not on any context. */
export const SERVER_TREE_MAX_PAGES = 100;

/**
 * Walk the manifest, handing over the finished part of the tree after every
 * page and the whole tree at the end. Answers whether the walk finished.
 */
export async function walkServerTree(io: WalkIO): Promise<boolean> {
  const listedAt = io.now();
  const listed = new Map<string, ManifestEntry>();
  const folders = new Map<string, Visibility>();
  let manifestUsable = true;
  let cursor: string | undefined;
  const seen = new Set<string>();
  const maxPages = io.maxPages ?? SERVER_TREE_MAX_PAGES;
  for (let page = 0; page < maxPages; page += 1) {
    let result: ManifestPage;
    try {
      result = await io.manifest(cursor);
    } catch {
      return false;
    }
    if (!io.mine()) return false;
    manifestUsable = result.manifestUsable;
    for (const entry of result.entries) {
      if (!entry.path.endsWith("/")) listed.set(entry.path, entry);
    }
    for (const folder of result.folders ?? []) folders.set(folder.path, folder.visibility);
    const tree = treeOfWalk(listed, folders, manifestUsable, listedAt, io.now());
    if (result.cursor === null && !result.truncated) {
      io.onTree({ ...tree, complete: true });
      return true;
    }
    // A page that cannot be continued ends the walk; what it finished stays drawn.
    const next = result.cursor;
    const finished = next === null ? null : finishedBefore(tree.value, next);
    if (finished !== null && finished.size > 0) io.onTree({ ...tree, value: finished, complete: false });
    if (result.truncated || next === null || seen.has(next) || next === cursor) return false;
    seen.add(next);
    cursor = next;
  }
  return false;
}

/**
 * The folders a walk that has handed out every key up to `cursor` has
 * finished: those every one of whose keys sorts before it. A folder's keys all
 * start `folder/`, so it is finished once the cursor sorts after `folder/` and
 * no longer starts with it. The root is never finished before the end.
 */
export function finishedBefore(
  tree: ReadonlyMap<string, FolderListing>,
  cursor: string,
): Map<string, FolderListing> {
  const finished = new Map<string, FolderListing>();
  for (const [folder, listing] of tree) {
    if (folder === "") continue;
    const prefix = `${folder}/`;
    if (cursor > prefix && !cursor.startsWith(prefix)) finished.set(folder, listing);
  }
  return finished;
}

/** A walk drawn as the mirror would draw the same listing, through `treeOf`. */
export function treeOfWalk(
  listed: ReadonlyMap<string, ManifestEntry>,
  folders: ReadonlyMap<string, Visibility>,
  manifestUsable: boolean,
  listedAt: number,
  now: number,
): LiveTree {
  const entries = new Map<string, MirrorEntry>();
  for (const entry of listed.values()) {
    entries.set(entry.path, {
      path: entry.path,
      etag: entry.etag ?? "",
      ...(entry.size !== undefined ? { size: entry.size } : {}),
      ...(entry.updatedAt !== undefined ? { updatedAt: entry.updatedAt } : {}),
      visibility: entry.visibility,
      inherited: entry.inherited,
      exception: entry.exception,
      readOnly: entry.readOnly,
      body: false,
      syncedAt: now,
    });
  }
  const index: MirrorIndex = {
    v: 1,
    entries,
    folders: new Map(folders),
    manifestUsable,
    listedComplete: true,
    listedAt,
  };
  return { value: treeOf(index), cachedAt: listedAt, complete: true, listedAt, live: true };
}

/* ---- This tab's copy, across a reload ---- */

const SESSION_PREFIX = "context.lc.tree.v1:";
const sessionKey = (scope: CacheScope, workspaceId: string) => `${SESSION_PREFIX}${scope}:${workspaceId}`;

function sessionStore(): Storage | null {
  try {
    const storage = (globalThis as { sessionStorage?: Storage }).sessionStorage;
    return storage ?? null;
  } catch {
    // A browser blocking site data throws on the property itself.
    return null;
  }
}

type Row = [kind: 0 | 1, name: string, visibility: Visibility, inherited: Visibility, flags: number, size?: number, updatedAt?: number];
interface Stored {
  listedAt: number;
  folders: [path: string, folderDefault: Visibility, manifestUsable: 0 | 1, rows: Row[]][];
}

/** Keep a whole tree for this tab, so a reload draws it at once. Best effort. */
export function keepServerTree(scope: CacheScope, workspaceId: string, tree: MirroredTree): void {
  if (!tree.complete) return;
  const storage = sessionStore();
  if (storage === null) return;
  const stored: Stored = { listedAt: tree.listedAt, folders: [] };
  for (const [path, listing] of tree.value) {
    stored.folders.push([
      path,
      listing.folderDefault,
      listing.manifestUsable === false ? 0 : 1,
      listing.entries.map((entry): Row => {
        const row: Row = [
          entry.kind === "folder" ? 1 : 0,
          entry.name,
          entry.visibility,
          entry.inherited,
          (entry.exception ? 1 : 0) | (entry.readOnly ? 2 : 0),
        ];
        if (entry.size !== undefined || entry.updatedAt !== undefined) row.push(entry.size ?? -1);
        if (entry.updatedAt !== undefined) row.push(entry.updatedAt);
        return row;
      }),
    ]);
  }
  try {
    storage.setItem(sessionKey(scope, workspaceId), JSON.stringify(stored));
  } catch {
    // Full or blocked: the tab walks again after a reload, as it did before.
    try {
      storage.removeItem(sessionKey(scope, workspaceId));
    } catch {
      // Nothing more to do.
    }
  }
}

/**
 * The tree this tab kept before a reload, or `null`. Not live: it is what the
 * server said then, drawn first, and the server is asked again.
 */
export function keptServerTree(scope: CacheScope, workspaceId: string): MirroredTree | null {
  const storage = sessionStore();
  if (storage === null) return null;
  let stored: Stored;
  try {
    const raw = storage.getItem(sessionKey(scope, workspaceId));
    if (raw === null) return null;
    stored = JSON.parse(raw) as Stored;
    if (!Array.isArray(stored.folders) || typeof stored.listedAt !== "number") return null;
  } catch {
    return null;
  }
  const value = new Map<string, FolderListing>();
  for (const [path, folderDefault, usable, rows] of stored.folders) {
    value.set(path, {
      path,
      folderDefault,
      truncated: false,
      manifestUsable: usable === 1,
      entries: rows.map(([kind, name, visibility, inherited, flags, size, updatedAt]): FileEntry => ({
        kind: kind === 1 ? "folder" : "file",
        path: path === "" ? name : `${path}/${name}`,
        name,
        visibility,
        inherited,
        exception: (flags & 1) !== 0,
        readOnly: (flags & 2) !== 0,
        ...(size !== undefined && size >= 0 ? { size } : {}),
        ...(updatedAt !== undefined ? { updatedAt } : {}),
      })),
    });
  }
  return { value, cachedAt: stored.listedAt, complete: false, listedAt: stored.listedAt };
}
