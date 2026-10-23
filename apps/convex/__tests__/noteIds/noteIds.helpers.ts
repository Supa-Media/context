/**
 * The id copy's test harness: a workspace whose tree mirrors an in-memory
 * bucket, and a stand-in for the action context that runs the two chains
 * (`lib/noteIds/copyPass.ts`, `checkPass.ts`) in a loop, in the order their
 * scheduled pages were asked for. Real functions through `convex-test`; the
 * bucket side is `memoryStore` read by the same `runIdCopyPage` /
 * `runIdCheckPage` the gateway's fallback runs.
 */

import { convexTest } from "convex-test";
import { getFunctionName } from "convex/server";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import type { ActionCtx } from "../../_generated/server";
import schema from "../../schema";
import { modules } from "../../test.setup";
import { runIdCheckPage, runIdCopyPage } from "../../../mcp/src/moves/idCopyPage.js";
import { runCheckChain, type CheckDeps } from "../../functions/lib/noteIds/checkPass";
import { runCopyChain, type CopyDeps } from "../../functions/lib/noteIds/copyPass";
import { beginCopyPass, copyRowOf, ensureCopyRow } from "../../functions/lib/noteIds/state";
import { memoryStore, type MemoryStore } from "../storeStub.helpers";
import { observeBucket } from "../nodes/facts.helpers";
import { internal as internalApi } from "../../_generated/api";
import { applyTreeObservation } from "../fixtures.helpers";
import { withTreeOf } from "../storeStub.helpers";

export { observeBucket };

/**
 * Observe only the keys named, at their versions in the bucket. The copies a
 * pass writes live in the same bucket, and a test about the source files must
 * not see them listed as notes.
 */
export async function observeKeys(t: T, workspaceId: Id<"workspaces">, store: Store, keys: string[], at = Date.now()) {
  const rows = [];
  for (const key of keys) {
    const object = await store.get(key);
    if (object !== null) rows.push({ path: key, etag: object.etag, size: store.bytesOf(key)?.byteLength ?? 0 });
  }
  await applyTreeObservation(t, { workspaceId, at, rows, gone: [] });
}
export type T = ReturnType<typeof convexTest>;
export type Store = MemoryStore;

export const ADMIN = "staff@example.test";

export function tester(): T {
  return convexTest(schema, modules);
}

export async function user(t: T, email: string): Promise<Id<"users">> {
  return await t.run(async (ctx) => await ctx.db.insert("users", { email, emailVerificationTime: Date.now() } as never));
}

/** A bound workspace (a storage binding row), with the staff and a stranger signed in. */
export async function boundWorkspace(t: T, slug: string): Promise<Id<"workspaces">> {
  const createdBy = await user(t, `${slug}@example.test`);
  return await t.run(async (ctx) => {
    const now = Date.now();
    const workspaceId = await ctx.db.insert("workspaces", {
      slug,
      displayName: `Workspace ${slug}`,
      createdBy,
      kind: "shared",
      structureTemplate: "para",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("storageBindings", {
      workspaceId,
      provider: "r2",
      bucket: `bucket-${slug}`,
      endpoint: "https://storage.example.test",
      region: "auto",
      accessKeyId: "fake",
      encryptedSecretAccessKey: "fake",
      capabilities: { conditionalWrite: true },
      status: "connected",
      boundBy: createdBy,
      createdAt: now,
      updatedAt: now,
    } as never);
    return workspaceId;
  });
}

/** The memory bucket, with the head that the production store answers with a size. */
export function bucket(files: Record<string, string>): Store {
  const store = memoryStore();
  for (const [key, body] of Object.entries(files)) store.seed(key, body);
  return store;
}

/** The store as the copy reads it: the bare adapter's `head` is answered from the bytes. */
export function storeWithHead(store: Store) {
  return withTreeOf({
    ...store,
    async head(key: string) {
      const object = await store.get(key);
      if (object === null) return null;
      return { etag: object.etag, size: store.bytesOf(key)?.byteLength ?? 0 };
    },
  });
}

export const CREDENTIAL = { workspaceId: "", bucket: "bucket", endpoint: "https://storage.example.test" } as never;

export interface Chain {
  t: T;
  workspaceId: Id<"workspaces">;
  store: Store;
  /** Scheduled pages not yet run, in the order they were asked for. */
  pending: { name: string; args: Record<string, unknown> }[];
  copy: CopyDeps;
  check: CheckDeps;
  ctx: ActionCtx;
}

/**
 * A chain harness over one workspace and one bucket. `copyHere` and `checkHere`
 * default to the memory store; a test can wrap them to act mid-page.
 */
export function chain(
  t: T,
  workspaceId: Id<"workspaces">,
  store: Store,
  overrides: { copyHere?: CopyDeps["copyHere"]; checkHere?: CheckDeps["checkHere"]; keyHeads?: CheckDeps["keyHeads"] } = {},
): Chain {
  const pending: { name: string; args: Record<string, unknown> }[] = [];
  const buckets = storeWithHead(store) as never;
  const copy: CopyDeps = {
    origin: null,
    credential: async () => CREDENTIAL,
    copyHere: overrides.copyHere ?? ((page) => runIdCopyPage(page, { buildStore: () => buckets })),
  };
  const check: CheckDeps = {
    origin: null,
    credential: async () => CREDENTIAL,
    checkHere: overrides.checkHere ?? ((page) => runIdCheckPage(page, { buildStore: () => buckets })),
    // The HEAD of each key, answered from the bytes the way the production store's head is.
    keyHeads:
      overrides.keyHeads ??
      (async (_ctx, _workspaceId, keys) => {
        const heads = [];
        for (const key of keys) heads.push(await (buckets as unknown as { head(k: string): Promise<unknown> }).head(key));
        return heads as { etag: string; size?: number }[];
      }),
  };
  const ctx = {
    runQuery: (ref: unknown, args: unknown) => (t.query as unknown as (r: unknown, a: unknown) => Promise<unknown>)(ref, args),
    runMutation: (ref: unknown, args: unknown) => (t.mutation as unknown as (r: unknown, a: unknown) => Promise<unknown>)(ref, args),
    runAction: async () => null,
    scheduler: {
      runAfter: async (_delay: number, ref: unknown, args: Record<string, unknown>) => {
        pending.push({ name: getFunctionName(ref as never), args });
      },
    },
  } as unknown as ActionCtx;
  return { t, workspaceId, store, pending, copy, check, ctx };
}

/**
 * Run what is scheduled until nothing is, or until `limit` pages ran. The
 * chains themselves schedule the next page; a backfill is a mutation.
 */
export async function drain(c: Chain, limit = 200): Promise<number> {
  let ran = 0;
  while (c.pending.length > 0) {
    if (ran >= limit) throw new Error("the id copy did not settle");
    const next = c.pending.shift()!;
    ran += 1;
    if (next.name.endsWith("noteIdsCopy:run")) {
      await runCopyChain(c.ctx, next.args as never, c.copy);
    } else if (next.name.endsWith("noteIdsCopy:runCheck")) {
      await runCheckChain(c.ctx, next.args as never, c.check);
    } else if (next.name.endsWith("noteIdsCopy:backfill")) {
      await c.t.mutation(internal.functions.noteIdsCopy.backfill, next.args as never);
    } else if (next.name.endsWith("noteIdsCopy:flip")) {
      await c.t.mutation(internal.functions.noteIdsCopy.flip, next.args as never);
    } else {
      throw new Error(`unexpected scheduled function ${next.name}`);
    }
  }
  return ran;
}

/** Start a pass the way `start` does (no lease held) and run it to the end. */
export async function runPass(c: Chain): Promise<void> {
  await c.t.run(async (ctx) => {
    await beginCopyPass(ctx, c.workspaceId, { force: false });
  });
  c.pending.length = 0;
  const row = await c.t.run((ctx) => copyRowOf(ctx.db, c.workspaceId));
  c.pending.push({ name: "functions/noteIdsCopy:run", args: { workspaceId: c.workspaceId, runId: row!.runId } });
  await drain(c);
}

export async function pass(c: Chain) {
  return await c.t.run((ctx) => copyRowOf(ctx.db, c.workspaceId));
}

export async function rowAt(t: T, workspaceId: Id<"workspaces">, path: string) {
  return await t.run(async (ctx) => {
    const rows = await ctx.db.query("nodes").collect();
    return rows.find((row) => row.workspaceId === workspaceId && row.path === path) ?? null;
  });
}

export { ensureCopyRow };
