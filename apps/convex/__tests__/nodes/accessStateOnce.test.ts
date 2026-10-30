/**
 * A query reads the workspace's access snapshot once (`accessStateOf`). It is
 * the largest thing a reader reads, and `nodesPrivacy.authority`, the live
 * head and folder listings each read it up to four times (Convex invoice,
 * owner 2026-10-30). A mutation reads it afresh every time, as it may have
 * just written it. Sabotage: drop the memo and the query case counts 3.
 */

import { describe, expect, test } from "vitest";
import type { Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { accessRowsOf, accessVersionOf } from "../../functions/lib/nodes/accessRows";

function stubCtx(writable: boolean) {
  let reads = 0;
  const state = { _id: "s", workspaceId: "w", version: 7, snapshot: [] };
  const empty = { withIndex: () => empty, collect: async () => [], unique: async () => null, first: async () => null, take: async () => [] };
  const db: Record<string, unknown> = {
    query: (table: string) => {
      if (table !== "nodeAccessState") return { withIndex: () => empty, ...empty };
      return {
        withIndex: () => ({
          unique: async () => {
            reads += 1;
            return state;
          },
        }),
      };
    },
    get: async () => null,
  };
  if (writable) db.insert = async () => "id";
  return { ctx: { db } as unknown as QueryCtx, reads: () => reads };
}

const W = "w" as Id<"workspaces">;

describe("the access snapshot", () => {
  test("a query reads it once, however many readers ask", async () => {
    const { ctx, reads } = stubCtx(false);
    await accessRowsOf(ctx, W);
    expect(await accessVersionOf(ctx, W)).toBe(7);
    await accessRowsOf(ctx, W);
    expect(reads()).toBe(1);
  });

  test("a mutation reads it afresh each time", async () => {
    const { ctx, reads } = stubCtx(true);
    await accessVersionOf(ctx, W);
    await accessVersionOf(ctx, W);
    expect(reads()).toBe(2);
  });
});
