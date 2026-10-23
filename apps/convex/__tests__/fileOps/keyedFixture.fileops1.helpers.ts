/**
 * A KEYED workspace under the lib-level file-operation tests (`fileOps1`).
 *
 * The lib functions (`movePath`, `trashPath`, `followHeading`, ...) run against
 * a store. In production that store is the id layer over the bucket
 * (`withIdLayout`, `apps/mcp/src/store/idLayout.js`) with the barrier's seams
 * attached (`attachQueueMove`, `attachTreeListing`, `attachWorkspaceKeyed`), and
 * every path a person names is looked up in the Convex tree. This builds that
 * same stack over an in-memory bucket, so each test keeps asking for notes by
 * their path while the bytes live at `notes/<noteId>.md`.
 *
 * Writes go through the layer, which is the product's own write path: a note
 * that does not exist yet is minted an id, its bytes go to the id key and the
 * row is created (`adoptKeyed`). Nothing here writes a path object.
 */

import type { Id } from "../../_generated/dataModel";
import type { ActionCtx } from "../../_generated/server";
import { withIdLayout } from "../../../mcp/src/store/idLayout.js";
import { internal } from "../../_generated/api";
import { attachQueueMove } from "../../functions/lib/nodes/moveBarrier";
import { attachTreeListing } from "../../functions/lib/nodes/treeNames";
import type { TreeNames } from "../../functions/lib/fileOps/treeChecks";
import { attachWorkspaceKeyed } from "../../functions/lib/noteIds/keyedStore";
import { consoleIdLayoutHooks } from "../../functions/lib/noteIds/consoleLayer";
import { runNodesOperation } from "../../functions/lib/nodes/run";
import { type FileStore, setFolderVisibility, setVisibility } from "../../functions/lib/fileOps";
import { clearanceOf } from "../../functions/lib/clearance";
import { PRIVACY_KEY } from "../../functions/lib/privacy";
import { renderPrivacyManifest } from "../../functions/lib/scaffold";
import { memoryStore, type MemoryStore } from "../storeStub.helpers";
import { bridge } from "../nodes/moveFixture.helpers";
import { setupTest, createUser, type TestConvex } from "../fixtures.helpers";
import type { RawRow } from "../nodes/keyedFixture.helpers";

export interface KeyedBucket {
  t: TestConvex;
  ctx: ActionCtx;
  workspaceId: Id<"workspaces">;
  /** The store the lib functions take: paths in, id keys out, the tree's seams attached. */
  store: FileStore & MemoryStore;
  /** The raw in-memory bucket underneath, keyed by what is actually stored. */
  raw: MemoryStore;
}

/** The live row a path names, or `null`. */
export async function rowAt(f: KeyedBucket, path: string): Promise<RawRow | null> {
  return await f.t.run(async (ctx) => {
    const rows = await ctx.db
      .query("nodes")
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", f.workspaceId).eq("path", path))
      .collect();
    const live = rows.find((row) => row.goneAt === undefined) ?? null;
    return live as RawRow | null;
  });
}

/** The key a live note's bytes sit at, or `null`. */
export async function keyAt(f: KeyedBucket, path: string): Promise<string | null> {
  return (await rowAt(f, path))?.storageKey ?? null;
}

/** The text of the live note at `path`, read from its key; `null` if there is no such note. */
export async function textAt(f: KeyedBucket, path: string): Promise<string | null> {
  const key = await keyAt(f, path);
  if (key === null) return null;
  return f.raw.snapshot()[key] ?? null;
}

/** The raw bytes of the live note at `path`; `null` if there is no such note. */
export async function bytesAt(f: KeyedBucket, path: string): Promise<Uint8Array | null> {
  const key = await keyAt(f, path);
  if (key === null) return null;
  return f.raw.bytesOf(key);
}

/** Every live note's path, sorted. Folders are not notes and are left out. */
export async function livePaths(f: KeyedBucket): Promise<string[]> {
  return await f.t.run(async (ctx) => {
    const rows = await ctx.db
      .query("nodes")
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", f.workspaceId))
      .collect();
    return rows
      .filter((row) => row.kind === "file" && row.goneAt === undefined)
      .map((row) => row.path)
      .sort();
  });
}

/** Path to text for every live note: the view a test compares, in place of the bucket's keys. */
export async function notesAt(f: KeyedBucket): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const path of await livePaths(f)) out[path] = (await textAt(f, path)) ?? "";
  return out;
}

/** Whether a live row (file or folder) sits at `path`. */
export async function liveAt(f: KeyedBucket, path: string): Promise<boolean> {
  return (await rowAt(f, path)) !== null;
}

/** Keys in the raw bucket that are not note bytes: the privacy manifest and the plumbing. */
export function plumbingKeys(f: KeyedBucket): string[] {
  return Object.keys(f.raw.snapshot())
    .filter((key) => !key.startsWith("notes/") && !key.startsWith("files/"))
    .sort();
}

/**
 * The tree's names, asked afresh on every call. The barrier attaches
 * `attachTreeListing` once per operation, and its served copy is taken at the
 * first ask; a test runs many operations on one store, so each ask here
 * attaches its own, and sees the rows as they are now.
 */
function attachFreshTree(ctx: ActionCtx, workspaceId: Id<"workspaces">, store: FileStore): void {
  const fresh = (): TreeNames => {
    const holder = {} as FileStore;
    attachTreeListing(ctx, workspaceId, holder);
    return (holder as unknown as { treeListing: TreeNames }).treeListing;
  };
  const names: TreeNames = {
    list: (options) => fresh().list(options),
    taken: (paths) => fresh().taken(paths),
    jobs: () => fresh().jobs!(),
    links: (ask) => fresh().links!(ask),
    linking: (paths) => fresh().linking!(paths),
  };
  Object.defineProperty(store, "treeListing", { value: names, enumerable: false, configurable: true });
}

/**
 * A keyed workspace holding `seed` (path to text or bytes), with the PARA
 * privacy manifest in place. Every seeded note is written through the layer.
 */
export async function keyedBucket(
  seed: Record<string, string | Uint8Array> = {},
  options: { manifest?: string } = {},
): Promise<KeyedBucket> {
  const t = setupTest();
  const ownerId = await createUser(t, "owner@example.invalid");
  const workspaceId = await t.run(async (ctx) => {
    const now = Date.now();
    const ws = await ctx.db.insert("workspaces", {
      slug: "atlas",
      displayName: "Atlas",
      createdBy: ownerId,
      kind: "personal",
      structureTemplate: "para",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("workspaceMembers", { workspaceId: ws, userId: ownerId, role: "owner", joinedAt: now });
    await ctx.db.insert("noteIdLayout", { paused: false, mode: "keys", updatedAt: 1 });
    await ctx.db.insert("noteIdCopies", {
      workspaceId: ws,
      status: "done",
      runId: 1,
      files: 0,
      copied: 0,
      failed: 0,
      failures: [],
      updatedAt: 1,
      keyedAt: 1,
    });
    return ws;
  });
  const raw = memoryStore({ conditional: true, ignoreIfMatchOnDelete: false } as never) as MemoryStore;
  raw.seed(PRIVACY_KEY, options.manifest ?? renderPrivacyManifest("para"));
  const ctx = bridge(t);
  // The tree must be served before the seams answer: a sweep of the empty bucket, then the parity mark a served tree carries.
  await runNodesOperation(ctx, { workspaceId, scope: "private", operation: { kind: "nodesSweep" } }, raw);
  await t.mutation(internal.functions.nodes.saveParity, {
    workspaceId,
    parity: { checkedAt: Date.now(), clearances: 2, mismatches: 0, privacyMatches: true },
  });

  const store = withIdLayout(raw, consoleIdLayoutHooks(ctx, workspaceId) as unknown as Parameters<typeof withIdLayout>[1]) as unknown as FileStore & MemoryStore;
  attachFreshTree(ctx, workspaceId, store);
  attachWorkspaceKeyed(ctx, workspaceId, store);
  // The barrier attaches each row seam by the operation that needs it.
  for (const kind of ["move", "trash", "restoreTrash"]) {
    attachQueueMove(ctx, { workspaceId, operation: { kind } } as never, store, store, null);
  }

  const bucket: KeyedBucket = { t, ctx, workspaceId, store, raw };
  for (const [path, body] of Object.entries(seed)) {
    await store.put(path, body);
  }
  return bucket;
}

/** The content type the bucket holds for the live note at `path`, or `undefined`. */
export async function contentTypeAt(f: KeyedBucket, path: string): Promise<string | undefined> {
  const key = await keyAt(f, path);
  if (key === null) return undefined;
  return ((await f.raw.get(key)) as { contentType?: string } | null)?.contentType;
}

/**
 * The notes `fixtures.helpers.ts`'s `bucket()` seeds as a path bucket, minus
 * its legacy `.history/` snapshots (nothing writes them, and a keyed workspace
 * has no path to keep them under).
 */
export const PARA_SEEDS: Record<string, string> = {
  "index.md": "# Context\n",
  "0-inbox/README.md": "# Inbox\n",
  "1-projects/README.md": "# Projects\n",
  "1-projects/context-lc.md": "# Context.LC\n\nnotes\n",
  "1-projects/pay.md": "# Pay\n\nsalaries\n",
  "2-areas/README.md": "# Areas\n",
  "2-areas/health.md": "# Health\n",
  "9-archive/README.md": "# Archive\n",
};

/** Every live row (file or folder) at or under `prefix`, sorted: "is anything left here?" */
export async function liveRowsUnder(f: KeyedBucket, prefix: string): Promise<string[]> {
  return await f.t.run(async (ctx) => {
    const rows = await ctx.db
      .query("nodes")
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", f.workspaceId))
      .collect();
    return rows
      .filter((row) => row.goneAt === undefined && (row.path === prefix || row.path.startsWith(`${prefix}/`)))
      .map((row) => row.path)
      .sort();
  });
}

/** `1-projects` shared with team, and `pay.md` held back as private: the shape `shareProjects` gives a bucket. */
export async function shareProjectsLike(f: KeyedBucket): Promise<void> {
  await setFolderVisibility(f.store, { path: "1-projects", visibility: "team", clearance: clearanceOf("private") });
  await setVisibility(f.store, { path: "1-projects/pay.md", visibility: "private", clearance: clearanceOf("private") });
}

/** The access and name fields of the live row at `path`, for rows-mode checks. */
export async function rowOf2(f: KeyedBucket, path: string) {
  const row = await rowAt(f, path);
  return row === null ? null : { path: row.path, access: (row as unknown as { access?: unknown }).access ?? null };
}
