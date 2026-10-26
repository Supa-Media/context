/**
 * The keyed-workspace guards, run through convex-test against the real schema:
 * that the table writes the new columns (`convexNodeTable`). Each case fails if its guard is removed.
 */

import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import schema from "../../schema";
import { modules } from "../../test.setup";
import { convexNodeTable } from "../../functions/lib/nodes/convexTable";

async function workspace(t: ReturnType<typeof convexTest>, slug: string): Promise<Id<"workspaces">> {
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

describe("convexNodeTable: noteId and storageKey", () => {
  test("an insert with no noteId mints one; an insert with a given noteId and storageKey keeps them", async () => {
    const t = convexTest(schema, modules);
    const ws = await workspace(t, "ids-table");
    const given = "0190a000-0000-7000-8000-00000000000d";
    await t.run(async (ctx) => {
      const table = convexNodeTable(ctx, ws);
      await table.insert({ path: "plain.md", name: "plain.md", kind: "file", observedAt: 1 });
      await table.insert({
        path: "keyed.md",
        name: "keyed.md",
        kind: "file",
        observedAt: 1,
        noteId: given,
        storageKey: `notes/${given}.md`,
      });
    });
    const plain = await t.run((ctx) => convexNodeTable(ctx, ws).byPath("plain.md"));
    const keyed = await t.run((ctx) => convexNodeTable(ctx, ws).byPath("keyed.md"));
    expect(plain?.noteId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(plain?.storageKey).toBeUndefined();
    expect(keyed).toMatchObject({ noteId: given, storageKey: `notes/${given}.md` });
  });

  test("a patch sets storageKey, keyedFrom and idCopy, and undefined clears them", async () => {
    const t = convexTest(schema, modules);
    const ws = await workspace(t, "patch-table");
    const id = await t.run(async (ctx) => {
      const table = convexNodeTable(ctx, ws);
      return await table.insert({ path: "a.md", name: "a.md", kind: "file", observedAt: 1 });
    });
    await t.run(async (ctx) => {
      await convexNodeTable(ctx, ws).patch(id, {
        storageKey: "notes/n.md",
        keyedFrom: { pathEtag: "p", keyEtag: "k" },
        idCopy: { key: "notes/n.md", etag: "p", copiedAt: 2 },
      });
    });
    const set = await t.run((ctx) => convexNodeTable(ctx, ws).byPath("a.md"));
    expect(set).toMatchObject({ storageKey: "notes/n.md", keyedFrom: { pathEtag: "p", keyEtag: "k" }, idCopy: { key: "notes/n.md" } });

    await t.run(async (ctx) => {
      await convexNodeTable(ctx, ws).patch(id, { storageKey: undefined, keyedFrom: undefined, idCopy: undefined });
    });
    const cleared = await t.run((ctx) => convexNodeTable(ctx, ws).byPath("a.md"));
    expect(cleared?.storageKey).toBeUndefined();
    expect(cleared?.keyedFrom).toBeUndefined();
    expect(cleared?.idCopy).toBeUndefined();
  });
});
