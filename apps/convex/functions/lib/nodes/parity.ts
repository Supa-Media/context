/**
 * The parity check: the tree, read the way a listing reads it, must equal the
 * bucket at every clearance (`docs/decisions/app-and-console/convex-tree.md`).
 *
 * Why this is the right test in phase 1: nothing reads the tree to answer a
 * person yet, so the only thing that proves it is right is equality with the
 * bucket, reached through the same code a person's tree would be drawn with.
 * `nodesListingStore` serves the tree's rows as a bucket listing, and the
 * unchanged `syncManifest` walks it. Every privacy decision is therefore
 * still `canSee` over `privacy.md`, here rendered from the tree's mirror, so
 * a difference in what either side shows is a difference in the tree's keys
 * or its rules, never in a second filter.
 */

import { clearanceOf, type Clearance } from "../clearance";
import type { FileStore } from "../fileOps/store";
import { syncManifest } from "../fileOps/syncManifest";
import { mirrorFile, privacyMirrorOf } from "./privacyMirror";
import { compareKeys } from "./sweep";
import { NODE_PRIVACY_KEY, type NodeRow, type PrivacyMirror } from "./table";

/** Group names checked beyond the two tiers: a bound on work, not a limit on the product. */
export const PARITY_NAMES = 5;

/** Manifest pages one walk may follow before it is called truncated. */
const WALK_PAGES = 1_000;

/**
 * A store that answers listings from the tree's rows, and `privacy.md` from
 * the tree's privacy mirror. Every other method is the bucket's own, through
 * the prototype, the way the retired D1 table's `treeListingStore`
 * does it.
 *
 * `list` honours `prefix`, `startAfter` and a cursor, and its cursor is the
 * last key of the page, as the bucket's own cursor is a key the caller holds.
 * `get("privacy.md")` answers with the rendered mirror and its etag, or with
 * no file when the mirror holds none. A tree with no mirror has no rules, so
 * it must not fall through to the bucket's file and check itself against it.
 */
export function nodesListingStore(
  base: FileStore,
  rows: readonly NodeRow[],
  mirror: PrivacyMirror | null,
): FileStore {
  const sorted = [...rows].sort((a, b) => compareKeys(a.path, b.path));
  const listing = Object.create(base) as FileStore;
  listing.list = async (options) => {
    const prefix = options?.prefix ?? "";
    const cursor = options?.cursor;
    const after = typeof cursor === "string" && cursor !== "" ? cursor : options?.startAfter;
    const max = options?.limit !== undefined && options.limit > 0 ? options.limit : 1000;
    const hits = sorted.filter(
      (row) => row.path.startsWith(prefix) && (after === undefined || compareKeys(row.path, after) > 0),
    );
    const page = hits.slice(0, max);
    const truncated = hits.length > page.length;
    return {
      objects: page.map(objectOf),
      truncated,
      ...(truncated ? { cursor: page[page.length - 1]!.path } : {}),
    };
  };
  listing.get = async (key) => {
    if (key !== NODE_PRIVACY_KEY) return await base.get(key);
    return mirrorFile(mirror) as Awaited<ReturnType<FileStore["get"]>>;
  };
  return listing;
}

/** A tree row as the object a bucket listing would return for it. */
function objectOf(row: NodeRow): { key: string; etag?: string; size?: number; uploaded?: Date } {
  return {
    key: row.path,
    ...(row.etag !== undefined ? { etag: row.etag } : {}),
    ...(row.size !== undefined ? { size: row.size } : {}),
    ...(row.uploaded !== undefined ? { uploaded: new Date(row.uploaded) } : {}),
  };
}

export interface ParityResult {
  /** Clearances compared: the owner, the team, and one per group the bucket's rules name (up to `PARITY_NAMES`). */
  clearances: number;
  /** Paths (and folders) that differ, counted once each, summed over every clearance. */
  mismatches: number;
  /** Always true: access lives only on the rows, so there is no file of rules to compare them with. Kept for the stored shape. */
  privacyMatches: boolean;
}

/**
 * Compare the tree (`rows`, `mirror`) with the bucket (`store`) at every
 * clearance a person can hold.
 *
 * Both sides are walked completely, with the cursor the manifest hands back,
 * so a difference on the last page counts as much as one on the first. An
 * entry is compared by its etag and size; a folder by its visibility. A walk
 * that did not finish is a mismatch of its own, because a tree that cannot be
 * walked is not one a person could be served.
 */
export async function checkParity(
  store: FileStore,
  rows: readonly NodeRow[],
  mirror: PrivacyMirror | null,
): Promise<ParityResult> {
  const bucketMirror = await privacyMirrorOf(store);
  const clearances = clearancesFor(bucketMirror);
  const tree = nodesListingStore(store, rows, mirror);
  let mismatches = 0;
  for (const clearance of clearances) {
    const fromBucket = await walkManifest(store, clearance);
    const fromTree = await walkManifest(tree, clearance);
    mismatches += diffValues(fromBucket.entries, fromTree.entries);
    mismatches += diffValues(fromBucket.folders, fromTree.folders);
    if (fromBucket.truncated) mismatches += 1;
    if (fromTree.truncated) mismatches += 1;
  }
  return { clearances: clearances.length, mismatches, privacyMatches: true };
}

/**
 * The clearances a check runs at: the owner, the team, and a team member
 * named by each distinct group the bucket's rules name. A group is the only
 * way a rule reaches past the two tiers, so each one is its own view to get
 * right.
 */
function clearancesFor(mirror: PrivacyMirror): Clearance[] {
  const names = new Set<string>();
  for (const visibility of [
    ...mirror.folders.map((folder) => folder.visibility),
    ...mirror.notes.map((note) => note.visibility),
  ]) {
    if (visibility.startsWith("@") && names.size < PARITY_NAMES) names.add(visibility.slice(1));
  }
  return [
    clearanceOf("private"),
    clearanceOf("team"),
    ...[...names].map((name) => clearanceOf("team", [name])),
  ];
}

interface Walk {
  /** Path to `etag|size`. */
  entries: Map<string, string>;
  /** Path to visibility. */
  folders: Map<string, string>;
  truncated: boolean;
}

async function walkManifest(store: FileStore, clearance: Clearance): Promise<Walk> {
  const entries = new Map<string, string>();
  const folders = new Map<string, string>();
  let cursor: string | undefined;
  for (let page = 0; page < WALK_PAGES; page += 1) {
    const manifest = await syncManifest(store, { clearance, ...(cursor === undefined ? {} : { cursor }) });
    for (const entry of manifest.entries) entries.set(entry.path, `${entry.etag ?? ""}|${entry.size ?? ""}`);
    for (const folder of manifest.folders) folders.set(folder.path, folder.visibility);
    if (manifest.truncated) return { entries, folders, truncated: true };
    if (manifest.cursor === null) return { entries, folders, truncated: false };
    cursor = manifest.cursor;
  }
  return { entries, folders, truncated: true };
}

/** Size of the symmetric difference of two maps; a key with two different values counts once. */
function diffValues(a: Map<string, string>, b: Map<string, string>): number {
  let count = 0;
  for (const [path, value] of a) if (b.get(path) !== value) count += 1;
  for (const path of b.keys()) if (!a.has(path)) count += 1;
  return count;
}
