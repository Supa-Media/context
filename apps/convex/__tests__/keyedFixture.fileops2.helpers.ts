/**
 * A keyed workspace for the file editor's operation tests (`__tests__/fileOps/`).
 *
 * The operations in `lib/fileOps` run against a `FileStore`, and in production
 * every store is attached by the credential barrier: the tree's names, the
 * keyed question, and the row moves and trashes that replace path moves in a
 * keyed workspace (`lib/nodes/moveBarrier.ts`). This helper builds the same
 * shape: a bucket seeded with path objects, swept into the Convex tree, then
 * keyed the way `keyedFixture.helpers.ts` keys one (bytes at `notes/<id>.md`,
 * each row's `storageKey` naming them). The store it returns has the seams
 * attached, so a move or trash changes rows and never bytes, and a path-based
 * delete is refused as it is in production.
 *
 * Seed everything up front: a path object written after keying has no row, so
 * no name would ever see it.
 */

import { convexTest } from "convex-test";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import schema from "../schema";
import { modules } from "../test.setup";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";
import { type FileStore } from "../functions/lib/fileOps";
import { attachQueueMove } from "../functions/lib/nodes/moveBarrier";
import { attachTreeListing } from "../functions/lib/nodes/treeNames";
import { attachWorkspaceKeyed } from "../functions/lib/noteIds/keyedStore";
import { runNodesOperation } from "../functions/lib/nodes/run";
import { memoryStore, type MemoryStore } from "./storeStub.helpers";
import { consoleIdLayoutHooks } from "../functions/lib/noteIds/consoleLayer";
import { withIdLayout } from "../../mcp/src/store/idLayout.js";

/** The schema-typed test instance (`convexTest(schema, modules)`), as `fixture()` in `moveFixture.helpers.ts` takes it. */
function makeTest() {
  return convexTest(schema, modules);
}
export type KeyedTest = ReturnType<typeof makeTest>;

/** How a test seeds its bucket before the sweep keys it. */
export type KeySeed = (store: KeyedStore) => Promise<void>;
export type KeyedStore = MemoryStore & FileStore;

export interface KeyedBucket {
  t: KeyedTest;
  ctx: ActionCtx;
  ws: Id<"workspaces">;
  /** What the operations take: the bucket behind the id layer, with the tree's seams attached. */
  store: FileStore;
  /** The bucket itself: seeds and snapshots only. Path objects here are frozen copies once keyed. */
  raw: KeyedStore;
}

/** An action context over `convex-test`: the real functions run, the scheduler only records. */
function bridge(t: KeyedTest): ActionCtx {
  return {
    runQuery: t.query as unknown,
    runMutation: t.mutation as unknown,
    runAction: async () => null,
    scheduler: { runAfter: async () => "job", runAt: async () => "job" },
  } as unknown as ActionCtx;
}

/**
 * A keyed workspace whose bucket holds a PARA context and whatever `seed`
 * adds. `seed` runs on the plain bucket before the sweep, so it may call the
 * visibility setters (which write the rules file, not notes).
 */
export async function keyedBucket(seed: KeySeed = async () => {}): Promise<KeyedBucket> {
  const t = makeTest();
  const ws = await t.run(async (ctx) => {
    const now = Date.now();
    const owner = await ctx.db.insert("users", { email: "owner@example.test", emailVerificationTime: now } as never);
    return await ctx.db.insert("workspaces", {
      slug: "atlas",
      displayName: "Atlas",
      createdBy: owner,
      kind: "shared",
      structureTemplate: "para",
      createdAt: now,
      updatedAt: now,
    });
  });
  const store = memoryStore({ conditional: true, ignoreIfMatchOnDelete: true }) as KeyedStore;
  store.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  store.seed("index.md", "# Context\n");
  store.seed("1-projects/README.md", "# Projects\n");
  store.seed("1-projects/context-lc.md", "# Context.LC\n\nnotes\n");
  store.seed("1-projects/pay.md", "# Pay\n\nsalaries\n");
  store.seed("2-areas/README.md", "# Areas\n");
  store.seed("2-areas/health.md", "# Health\n");
  store.seed("9-archive/README.md", "# Archive\n");
  await seed(store);

  const ctx = bridge(t);
  const bodies = store.snapshot();
  await runNodesOperation(ctx, { workspaceId: ws, scope: "private", operation: { kind: "nodesSweep" } }, store);
  await t.run(async (c) => {
    await c.db.insert("noteIdLayout", { paused: false, mode: "keys", updatedAt: 1 });
    await c.db.insert("noteIdCopies", {
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
    const rows = await c.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", ws)).collect();
    for (const row of rows) {
      if (row.kind !== "file" || row.noteId === undefined) continue;
      const key = `notes/${row.noteId}.md`;
      await c.db.patch(row._id, { storageKey: key });
      store.seed(key, bodies[row.path] ?? "");
    }
  });
  await t.mutation(internal.functions.nodes.saveParity, {
    workspaceId: ws,
    parity: { checkedAt: Date.now(), clearances: 2, mismatches: 0, privacyMatches: true },
  });

  // Reads and writes by path go through the id layer, as the barrier's store does (`consoleLayer.ts`).
  const layered = withIdLayout(store, consoleIdLayoutHooks(ctx, ws) as unknown as Parameters<typeof withIdLayout>[1]) as unknown as FileStore;
  // Production attaches the tree per request, and the tree's served snapshot caches its rows for that request.
  // Here each read of `treeListing` is a request of its own, so a walk after a move sees the move.
  Object.defineProperty(layered, "treeListing", {
    get() {
      const request = Object.create(layered) as FileStore;
      attachTreeListing(ctx, ws, request);
      return (request as unknown as { treeListing: unknown }).treeListing;
    },
    enumerable: false,
    configurable: true,
  });
  attachWorkspaceKeyed(ctx, ws, layered);
  attachQueueMove(ctx, { workspaceId: ws, scope: "private", operation: { kind: "move" } }, layered, store);
  attachQueueMove(ctx, { workspaceId: ws, scope: "private", operation: { kind: "trash" } }, layered, store);
  attachQueueMove(ctx, { workspaceId: ws, scope: "private", operation: { kind: "restoreTrash" } }, layered, store);
  return { t, ctx, ws, store: layered, raw: store };
}

/** The live row at `path`, or `null`. */
export async function liveRowAt(k: KeyedBucket, path: string) {
  return await k.t.run(async (c) => {
    const rows = await c.db
      .query("nodes")
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", k.ws).eq("path", path))
      .collect();
    return rows.find((row) => row.goneAt === undefined) ?? null;
  });
}

/** The body of the note a live path names, read through its row's key; `null` if no live note is there. */
export async function bodyAt(k: KeyedBucket, path: string): Promise<string | null> {
  const row = await liveRowAt(k, path);
  if (row === null || row.storageKey === undefined) return null;
  return k.raw.snapshot()[row.storageKey] ?? null;
}

/**
 * The store with its tree names replaced: a listing whose pages `wrap` changes, for walks that must
 * not finish. Own properties only, as the barrier attaches its seams, so the walks read the wrapped one.
 */
export function withTreeListing(k: KeyedBucket, wrap: (list: (options?: never) => Promise<unknown>) => (options?: never) => Promise<unknown>): FileStore {
  const original = (k.store as unknown as { treeListing: { list: (options?: never) => Promise<unknown> } }).treeListing;
  const wrapped = Object.create(k.store) as FileStore;
  Object.defineProperty(wrapped, "treeListing", {
    value: { ...original, list: wrap(original.list) },
    enumerable: false,
    configurable: true,
  });
  return wrapped;
}
