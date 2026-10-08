import type { CacheScope } from "./keys";
import { treeOf, type MirrorEntry, type MirrorIndex, type MirroredTree } from "./mirror";
import type { ContextListing } from "./mirrorSync";

/**
 * The whole tree of a context, from the server, held in this tab's memory.
 *
 * **A browser tab keeps no copy of a workspace** (decided by the owner,
 * 2026-10-08), so since #1346 a plain tab had no mirror to draw the side panel
 * from: every folder somebody opened was its own `listFiles` round trip
 * ("Loading…"), and a change made by somebody else never reached the tree,
 * because the hint that says "walk again" asked a mirror that was not there.
 * Reported the same day as "back to really slow loading".
 *
 * So a tab without a mirror walks `syncManifest` — the same privacy-filtered,
 * metadata-only walk the apps' mirror commits, paths and versions and no
 * bodies — and keeps the result **here, in memory**: nothing is written to the
 * device, and it is gone with the tab. Every folder then opens from it without
 * a request, and the tree signal re-walks it, which is how a folder an agent
 * moved appears without anybody reloading.
 *
 * Keyed by clearance as well as workspace, as the mirror is, so a role that
 * changes mid-session never draws a tree walked at another clearance, and by
 * the session epoch, so nothing walked before a sign-out is served after it.
 */

interface Held {
  epoch: number;
  tree: MirroredTree;
}

const held = new Map<string, Held>();

const keyOf = (scope: CacheScope, workspaceId: string) => `${scope}:${workspaceId}`;

/** The tree last walked for this clearance this session, or `null`. */
export function serverTree(scope: CacheScope, workspaceId: string, epoch: number): MirroredTree | null {
  const found = held.get(keyOf(scope, workspaceId));
  if (found === undefined) return null;
  if (found.epoch !== epoch) {
    held.delete(keyOf(scope, workspaceId));
    return null;
  }
  return found.tree;
}

/**
 * Keep one walk's tree. `false` when nothing was kept. Only a **complete**
 * walk is kept: one that stopped part-way is a floor, and a folder it never
 * reached would draw "Empty" — the bug #1345 fixed for the mirror — so the
 * tree goes on asking folder by folder instead. And a walk that started
 * before the one already held must not undo it (two can overlap, as with the
 * mirror's `commitListing`).
 */
export function holdServerTree(
  listing: ContextListing & { pagesListed: number },
  epoch: number,
  now: number,
): boolean {
  if (listing.pagesListed === 0 || !listing.complete) return false;
  const key = keyOf(listing.scope, listing.workspaceId);
  const before = held.get(key);
  if (before !== undefined && before.epoch === epoch && before.tree.listedAt > listing.listedAt) return false;
  held.set(key, { epoch, tree: treeOfListing(listing, now) });
  return true;
}

/** Tests only. */
export function forgetServerTrees(): void {
  held.clear();
}

/** A listing drawn as the mirror would draw the same listing, through `treeOf`. */
export function treeOfListing(listing: ContextListing, now: number): MirroredTree {
  const entries = new Map<string, MirrorEntry>();
  for (const entry of listing.listed.values()) {
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
    folders: new Map(listing.folders ?? []),
    manifestUsable: listing.manifestUsable,
    listedComplete: listing.complete,
    listedAt: listing.listedAt,
  };
  return {
    value: treeOf(index),
    cachedAt: listing.listedAt,
    complete: listing.complete,
    listedAt: listing.listedAt,
    live: true,
  };
}
