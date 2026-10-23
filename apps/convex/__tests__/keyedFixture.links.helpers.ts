/**
 * A keyed workspace for the link, move and index suites (`links` group): the
 * bucket's notes are seeded as paths, swept into the Convex tree, and then
 * keyed the way production keys a workspace. Every note's bytes move to
 * `notes/<noteId>.md` and its row names that key, so a move, trash or archive
 * changes rows and never bytes (`docs/decisions/storage-and-credentials/notes-by-id.md`).
 *
 * The move, trash and archive seams the barrier attaches (`fileOperationBarrier.ts`)
 * are attached here too, so a test calls the real fileOps functions over a
 * store that is served and keyed. Path objects the bucket still holds after
 * keying are frozen copies nothing reads; tests read notes by name through
 * `bodyAt` and `keyAt`, never by spelling a path into the bucket.
 */

import { convexTest } from "convex-test";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import schema from "../schema";
import { modules } from "../test.setup";
import type { FileStore } from "../functions/lib/fileOps";
import { attachQueueMove } from "../functions/lib/nodes/moveBarrier";
import { attachTreeListing } from "../functions/lib/nodes/treeNames";
import { attachWorkspaceKeyed } from "../functions/lib/noteIds/keyedStore";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "./seededRules.helpers";
import { memoryStore, type MemoryStore } from "./storeStub.helpers";
import { bridge } from "./nodes/moveFixture.helpers";
import { seedTreeFromStore, type TestConvex } from "./fixtures.helpers";

export type LinksStore = MemoryStore & FileStore;

export interface KeyedLinks {
  t: TestConvex;
  ctx: ActionCtx;
  ws: Id<"workspaces">;
  store: LinksStore;
}

export interface RowLive {
  path: string;
  live: boolean;
  noteId?: string;
  storageKey?: string;
  etag?: string;
}

/**
 * A keyed workspace whose bucket holds `seeds` (paths to text) after `setup`
 * has set its folder and note visibility. Keyed before the function returns.
 */
export async function keyedLinks(
  seeds: Record<string, string>,
  setup: (store: LinksStore) => Promise<void> = async () => {},
): Promise<KeyedLinks> {
  const t = convexTest(schema, modules) as unknown as TestConvex;
  const ws = await t.run(async (ctx) => {
    const now = Date.now();
    const ownerId = await ctx.db.insert("users", { email: "owner@example.test", emailVerificationTime: now } as never);
    const workspaceId = await ctx.db.insert("workspaces", {
      slug: "acme",
      displayName: "Acme",
      createdBy: ownerId,
      kind: "shared",
      structureTemplate: "para",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("workspaceMembers", { workspaceId, userId: ownerId, role: "owner", joinedAt: now });
    return workspaceId;
  });
  const store = memoryStore() as LinksStore;
  store.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  for (const [path, text] of Object.entries(seeds)) store.seed(path, text);
  await setup(store);

  const ctx = bridge(t);
  await seedTreeFromStore(t, ws, store);
  await key(t, ws, store);
  const f = { t, ctx, ws, store };
  seamsOf(f);
  return f;
}

/** The keyed state: the switch at `keys`, the flip done, and every live note row named by its key with the bytes there. */
async function key(t: TestConvex, ws: Id<"workspaces">, store: LinksStore): Promise<void> {
  await t.run(async (ctx) => {
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
    const rows = await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", ws)).collect();
    for (const row of rows) {
      if (row.kind !== "file" || row.noteId === undefined) continue;
      const storageKey = `notes/${row.noteId}.md`;
      store.seed(storageKey, store.snapshot()[row.path] ?? "");
      await ctx.db.patch(row._id, { storageKey, etag: store.objects.get(storageKey)!.etag });
    }
  });
}

/**
 * The barrier's seams for the operations these tests call: a move or archive
 * (`queueMove`), a trash (`trashKeyedRows`, its restore too), the tree's
 * listing, and the keyed question.
 */
export function seamsOf(f: KeyedLinks): void {
  const scope = "private" as const;
  attachQueueMove(f.ctx, { workspaceId: f.ws, scope, operation: { kind: "move" } }, f.store, f.store);
  attachQueueMove(f.ctx, { workspaceId: f.ws, scope, operation: { kind: "trash" } }, f.store, f.store);
  attachQueueMove(f.ctx, { workspaceId: f.ws, scope, operation: { kind: "restoreTrash" } }, f.store, f.store);
  attachTreeListing(f.ctx, f.ws, f.store);
  attachWorkspaceKeyed(f.ctx, f.ws, f.store);
}

/** Every live and gone row of the workspace, sorted by path. */
export async function rowsOf(f: KeyedLinks): Promise<RowLive[]> {
  return await f.t.run(async (ctx) => {
    const rows = await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", f.ws)).collect();
    return rows
      .map((row) => ({
        path: row.path,
        live: row.goneAt === undefined,
        noteId: row.noteId,
        storageKey: row.storageKey,
        etag: row.etag,
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
  });
}

/** The live row a path names, or `null`. */
export async function liveRowAt(f: KeyedLinks, path: string): Promise<RowLive | null> {
  return (await rowsOf(f)).find((row) => row.path === path && row.live) ?? null;
}

/** Any row, live or gone, at exactly `path`. */
export async function anyRowAt(f: KeyedLinks, path: string): Promise<RowLive | null> {
  return (await rowsOf(f)).find((row) => row.path === path) ?? null;
}

/** The key a note's bytes sit at, through its row, or `null` when no row names the path. */
export async function keyAt(f: KeyedLinks, path: string): Promise<string | null> {
  return (await anyRowAt(f, path))?.storageKey ?? null;
}

/** The text of the note a path names, read through its row's key; `null` if no row names it. */
export async function bodyAt(f: KeyedLinks, path: string): Promise<string | null> {
  const key = await keyAt(f, path);
  if (key === null) return null;
  return f.store.snapshot()[key] ?? null;
}

/** The etag the bytes at a path's key carry right now (the version an offline edit was made against). */
export async function etagAt(f: KeyedLinks, path: string): Promise<string> {
  const key = await keyAt(f, path);
  if (key === null) throw new Error(`no note at ${path}`);
  return f.store.objects.get(key)!.etag;
}

/**
 * Somebody else's edit, landing between a read and a later operation. The
 * bytes go to the note's key, and the tree hears of it the way the gateway
 * reports a keyed write (`noteIdsKeyed.recordKeyed`): a row is only ever
 * changed by that seam, never by a listing of the path objects.
 */
export async function editedElsewhere(f: KeyedLinks, path: string, body: string): Promise<string> {
  const key = await keyAt(f, path);
  if (key === null) throw new Error(`no note at ${path}`);
  f.store.seed(key, body);
  const object = f.store.objects.get(key)!;
  await f.t.mutation(internal.functions.noteIdsKeyed.recordKeyed, {
    workspaceId: f.ws,
    path,
    key,
    etag: object.etag,
    at: Date.now(),
  });
  return object.etag;
}

/** The text of every note body in the bucket (keyed notes only): for "nothing changed" checks. */
export function noteBodies(f: KeyedLinks): Record<string, string> {
  return Object.fromEntries(Object.entries(f.store.snapshot()).filter(([key]) => key.startsWith("notes/")));
}

