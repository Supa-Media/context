/**
 * A context's mirror index — what is on this device and at which version —
 * and how it is written to and read back from the device's store. Split out
 * of `mirror.ts`, which re-exports all of it; that file's header holds the
 * rules the mirror keeps.
 */

import type { Visibility } from "../console/files/types";

export const MIRROR_INDEX_VERSION = 1;

export interface MirrorEntry {
  path: string;
  /**
   * The version the body is at. For an entry with no body (an attachment),
   * the version the manifest listed, or `""` when the store gave none.
   */
  etag: string;
  /** Provider object version used to compare the mirror with the manifest. */
  rawEtag?: string;
  size?: number;
  updatedAt?: number;
  visibility: Visibility;
  inherited: Visibility;
  exception: boolean;
  readOnly: boolean;
  encrypted?: boolean;
  /**
   * A body is on this device at `etag`. `false` for a file the console lists
   * but does not open as a note — an image, a PDF — which the mirror names so
   * the offline tree matches the online one, and never downloads.
   */
  body: boolean;
  /** When the bucket last confirmed this version. What "cached … ago" counts from. */
  syncedAt: number;
  /** The etag of an ancestor held in the `base` slot for a merge. */
  base?: string;
}

/** Why the last sync did not leave this context complete. */
export type IncompleteReason =
  /** The manifest itself said it could not list everything. */
  | "manifest-truncated"
  /** Some notes could not be read — refused, or the store failed. */
  | "read-failed"
  /** The run stopped part-way: the connection went, or the app was closed. */
  | "interrupted";

export interface MirrorIndex {
  v: typeof MIRROR_INDEX_VERSION;
  /**
   * A `Map`, never an object keyed by path: a bucket key may be `__proto__`
   * or `constructor`, and on a plain object the first assignment of one sets
   * the prototype and the second reads `Object`'s. Serialised as arrays.
   */
  entries: Map<string, MirrorEntry>;
  /**
   * Folder path → its own default visibility, as the last listing that named
   * it said. Only for the badge on a folder row offline: the manifest lists
   * notes, not folders, and the privacy rules that decide a folder's default
   * are not on this device. See `badge` in `treeOf` for what happens without one.
   */
  folders: Map<string, Visibility>;
  /** When a sync run last finished, complete or not. */
  lastSyncedAt?: number;
  /** The last run listed everything and fetched everything it listed. */
  complete?: boolean;
  /** Notes the last run listed that are not on this device at their current version. */
  remaining?: number;
  incomplete?: IncompleteReason;
  manifestUsable?: boolean;
  /**
   * The last manifest listed everything, so the entries and folders are the
   * whole of what this clearance may see as of `listedAt` — whether or not
   * every body has arrived yet. `complete` is about bodies; this is about the
   * tree, which is drawn from metadata alone.
   */
  listedComplete?: boolean;
  /** When the manifest behind the entries started walking the bucket. */
  listedAt?: number;
  /**
   * Where a catch-up from the tree table's change log resumes, and the
   * `privacy.md` version this copy was judged by. Absent until a walk of the
   * table has said where (`syncTreeChanges` on the server).
   */
  changes?: ChangeCursor;
}

/** A position in the server's tree change log. See `mirrorChanges.ts`. */
export interface ChangeCursor {
  since: number;
  after: string;
  privacy: string;
  /** When this copy was last walked whole, by this device's clock. */
  walkedAt: number;
}

export function emptyIndex(): MirrorIndex {
  return { v: MIRROR_INDEX_VERSION, entries: new Map(), folders: new Map() };
}

/* ------------------------------ serialisation ----------------------------- */

const VISIBILITY = /^(private|team|@.+)$/;

function isVisibility(value: unknown): value is Visibility {
  return typeof value === "string" && VISIBILITY.test(value);
}

/**
 * An index read back, or `null` for anything that is not one. Never a throw:
 * this runs on the path that draws the console, and an index written by a
 * version that shaped it differently has to read as "not mirrored yet" — the
 * next sync rebuilds it — rather than as entries with `undefined` in them.
 */
export function parseIndex(raw: string | null): MirrorIndex | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Omit<SerialisedIndex, "v">> & { v?: unknown };
    if (parsed?.v !== MIRROR_INDEX_VERSION || !Array.isArray(parsed.entries)) return null;
    const entries = new Map<string, MirrorEntry>();
    for (const value of parsed.entries) {
      const entry = value as Partial<MirrorEntry>;
      if (typeof entry?.path !== "string" || typeof entry.etag !== "string") continue;
      if (!isVisibility(entry.visibility) || !isVisibility(entry.inherited)) continue;
      if (typeof entry.body !== "boolean" || typeof entry.syncedAt !== "number") continue;
      entries.set(entry.path, {
        path: entry.path,
        etag: entry.etag,
        ...(typeof entry.rawEtag === "string" ? { rawEtag: entry.rawEtag } : {}),
        visibility: entry.visibility,
        inherited: entry.inherited,
        exception: entry.exception === true,
        readOnly: entry.readOnly === true,
        body: entry.body,
        syncedAt: entry.syncedAt,
        ...(typeof entry.size === "number" ? { size: entry.size } : {}),
        ...(typeof entry.updatedAt === "number" ? { updatedAt: entry.updatedAt } : {}),
        ...(entry.encrypted === true ? { encrypted: true } : {}),
        ...(typeof entry.base === "string" ? { base: entry.base } : {}),
      });
    }
    const folders = new Map<string, Visibility>();
    for (const pair of Array.isArray(parsed.folders) ? parsed.folders : []) {
      if (Array.isArray(pair) && typeof pair[0] === "string" && isVisibility(pair[1])) {
        folders.set(pair[0], pair[1]);
      }
    }
    return {
      v: MIRROR_INDEX_VERSION,
      entries,
      folders,
      ...(typeof parsed.lastSyncedAt === "number" ? { lastSyncedAt: parsed.lastSyncedAt } : {}),
      ...(typeof parsed.complete === "boolean" ? { complete: parsed.complete } : {}),
      ...(typeof parsed.remaining === "number" ? { remaining: parsed.remaining } : {}),
      ...(typeof parsed.incomplete === "string"
        ? { incomplete: parsed.incomplete as IncompleteReason }
        : {}),
      ...(typeof parsed.manifestUsable === "boolean"
        ? { manifestUsable: parsed.manifestUsable }
        : {}),
      ...(typeof parsed.listedComplete === "boolean"
        ? { listedComplete: parsed.listedComplete }
        : {}),
      ...(typeof parsed.listedAt === "number" ? { listedAt: parsed.listedAt } : {}),
      ...(isChangeCursor(parsed.changes) ? { changes: parsed.changes } : {}),
    };
  } catch {
    return null;
  }
}

interface SerialisedIndex extends Omit<MirrorIndex, "entries" | "folders"> {
  entries: MirrorEntry[];
  folders: [string, Visibility][];
}

export function serialiseIndex(index: MirrorIndex): string {
  const { entries, folders, ...meta } = index;
  const out: SerialisedIndex = { ...meta, entries: [...entries.values()], folders: [...folders] };
  return JSON.stringify(out);
}

function isChangeCursor(value: unknown): value is ChangeCursor {
  const cursor = value as Partial<ChangeCursor> | null | undefined;
  return (
    typeof cursor?.since === "number" &&
    typeof cursor.after === "string" &&
    typeof cursor.privacy === "string" &&
    typeof cursor.walkedAt === "number"
  );
}
