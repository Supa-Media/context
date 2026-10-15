/**
 * A workspace whose Convex tree mirrors a memory bucket, with the facts fill
 * (`lib/nodes/factFill.ts`) run against it through convex-test. The tree is
 * "served" by answering `nodes.served` directly, so a test needs no sweep.
 */

import { convexTest } from "convex-test";
import { getFunctionName } from "convex/server";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import schema from "../../schema";
import { modules } from "../../test.setup";
import type { FileStore } from "../../functions/lib/fileOps";
import { runFactFill } from "../../functions/lib/nodes/factFill";

export function tester() {
  return convexTest(schema, modules);
}

export type Tester = ReturnType<typeof tester>;

export async function workspace(t: Tester, slug: string): Promise<Id<"workspaces">> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const createdBy = await ctx.db.insert("users", { email: `${slug}@example.test`, emailVerificationTime: now } as never);
    return await ctx.db.insert("workspaces", {
      slug,
      displayName: `Workspace ${slug}`,
      createdBy,
      kind: "shared",
      structureTemplate: "para",
      createdAt: now,
      updatedAt: now,
    });
  });
}

/** Every key the bucket holds outside its plumbing, observed into the tree at its version. */
export async function observeBucket(t: Tester, workspaceId: Id<"workspaces">, store: FileStore, at = Date.now()) {
  const listed = await store.list({ prefix: "" });
  const rows = (listed.objects as { key: string; etag?: string }[])
    .filter(({ key }) => !key.startsWith("."))
    .map(({ key, etag }) => ({ path: key, ...(etag === undefined ? {} : { etag }) }));
  await t.mutation(internal.functions.nodes.observe, { workspaceId, at, rows, gone: [], vanishedUnder: [] });
}

/** One path observed gone. */
export async function observeGone(t: Tester, workspaceId: Id<"workspaces">, path: string, at = Date.now()) {
  await t.mutation(internal.functions.nodes.observe, { workspaceId, at, rows: [], gone: [path], vanishedUnder: [] });
}

/** An action context over convex-test, the tree served, scheduled passes recorded rather than run. */
export function factCtx(t: Tester, options: { served?: boolean } = {}) {
  const scheduled: unknown[] = [];
  const ctx = {
    runQuery: async (ref: unknown, args: unknown) => {
      if (getFunctionName(ref as never) === "functions/nodes:served") return options.served === false ? null : { mirror: null };
      return await (t.query as (ref: unknown, args: unknown) => Promise<unknown>)(ref, args);
    },
    runMutation: (ref: unknown, args: unknown) => (t.mutation as (ref: unknown, args: unknown) => Promise<unknown>)(ref, args),
    scheduler: { runAfter: async (_delay: number, _ref: unknown, args: unknown) => void scheduled.push(args) },
  };
  return { ctx: ctx as never, scheduled };
}

/** Run fill passes until one says it is complete. Returns how many ran. */
export async function fillAll(t: Tester, workspaceId: Id<"workspaces">, store: FileStore, limit = 50): Promise<number> {
  for (let pass = 1; pass <= limit; pass += 1) {
    const { ctx } = factCtx(t);
    // A finished pass releases its hold, so the next claims at once.
    const result = await runFactFill(ctx, workspaceId, store, 0);
    if (result.kind === "nodesKept" && result.complete) return pass;
  }
  throw new Error("the facts fill never finished");
}
