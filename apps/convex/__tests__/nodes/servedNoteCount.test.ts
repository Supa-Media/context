/**
 * The free plan's note count ("912 of 1,000 notes") is counted from the
 * Convex tree's rows where the tree serves the workspace, instead of walking
 * the bucket a page at a time every time an owner opens a capped context.
 *
 * What is proved:
 *  - the count from the rows is the count the bucket walk gives, plumbing,
 *    attachments and `privacy.md` excluded alike;
 *  - it is read without a single bucket listing;
 *  - a pending folder move changes nothing about the number;
 *  - where the tree does not serve, or its read fails, the answer is `null`,
 *    and `recountNotes` keeps the last figure rather than count the bucket
 *    (decided by the owner, 2026-10-13: no fallbacks to the bucket).
 *
 * Sabotage (temporary local edits, reverted):
 *  - counting every key instead of `isNoteKey`: "counts what the bucket
 *    walk counts" fails;
 *  - dropping the `catch`: "a failing tree read is no answer" fails;
 *  - counting the bucket again where the tree has no answer: "keeps the last
 *    figure" fails (the bucket is fetched, and the figure changes).
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../../_generated/api";
import { createUser, createWorkspace, seedStorageBinding, setupTest } from "../fixtures.helpers";
import { getFunctionName } from "convex/server";
import type { Id } from "../../_generated/dataModel";
import type { FileStore } from "../../functions/lib/fileOps";
import { countNotes } from "../../functions/lib/noteCount";
import { servedNoteCount } from "../../functions/lib/nodes/servedCount";
import type { NodeRow } from "../../functions/lib/nodes/table";
import { memoryStore, type MemoryStore } from "../storeStub.helpers";

const WS = "w1" as Id<"workspaces">;

function bucket(): MemoryStore & FileStore {
  const store = memoryStore() as MemoryStore & FileStore;
  store.seed("privacy.md", "rules\n");
  store.seed("index.md", "# front\n");
  store.seed("todo.md", "- one\n");
  for (let n = 0; n < 7; n += 1) store.seed(`1-projects/launch/note-${n}.md`, `# ${n}\n`);
  store.seed("1-projects/launch/diagram.png", "png");
  store.seed("2-areas/hiring/Plan.MD", "# plan\n");
  store.seed("3-resources/.obsidian/workspace.md", "plumbing");
  store.seed(".context/proposals/pending/a.md", "plumbing");
  store.seed(".history/todo.md/1", "plumbing");
  return store;
}

/** Every non-plumbing key, as a finished sweep leaves the rows. */
async function rowsOf(store: FileStore): Promise<NodeRow[]> {
  const listed = await store.list({ prefix: "" });
  return (listed.objects as { key: string }[])
    .filter(({ key }) => !key.startsWith("."))
    .map(({ key }) => ({ path: key }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function ctxServing(rows: NodeRow[] | null, moves: unknown[] = []) {
  return {
    runQuery: vi.fn(async (ref: unknown, args: { after?: string; limit?: number }) => {
      const name = getFunctionName(ref as never);
      if (name === "functions/nodes:served") return rows === null ? null : { mirror: null };
      if (name === "functions/nodeRowMoves:drawn") return moves;
      if (name === "functions/nodes:listLive") {
        const after = rows!.filter((row) => args.after === undefined || row.path > args.after);
        const page = after.slice(0, args.limit ?? 1000);
        return { rows: page, cursor: after.length > page.length ? page[page.length - 1]!.path : null };
      }
      throw new Error(`unexpected ${name}`);
    }),
  } as never;
}

describe("the free plan's note count from the tree", () => {
  test("counts what the bucket walk counts", async () => {
    const store = bucket();
    const walked = await countNotes(store);
    const served = await servedNoteCount(ctxServing(await rowsOf(store)), WS);
    expect(walked).toEqual({ notes: 11, truncated: false });
    expect(served).toEqual(walked);
  });

  test("reads no bucket listing", async () => {
    const store = bucket();
    const rows = await rowsOf(store);
    const list = vi.spyOn(store, "list");
    await servedNoteCount(ctxServing(rows), WS);
    expect(list).not.toHaveBeenCalled();
  });

  test("a pending folder move changes nothing about the number", async () => {
    const store = bucket();
    const moves = [{ from: "1-projects/launch", to: "4-archive/launch" }];
    const served = await servedNoteCount(ctxServing(await rowsOf(store), moves), WS);
    expect(served).toEqual({ notes: 11, truncated: false });
  });

  test("where the tree does not serve, there is no answer", async () => {
    expect(await servedNoteCount(ctxServing(null), WS)).toBeNull();
  });

  test("a failing tree read is no answer", async () => {
    const ctx = { runQuery: vi.fn(async () => { throw new Error("down"); }) } as never;
    expect(await servedNoteCount(ctx, WS)).toBeNull();
  });
});

/**
 * What a verification records (`provisioning.ts`) is the tree's count too: the
 * bucket holds the frozen path copies beside the id keys, so walking it would
 * count every note twice.
 *
 * Sabotage: count the bucket's listing instead -> the first case fails (the
 * listing is called, and the count is the doubled one).
 */
describe("the count a verification records", () => {
  /** The bucket after a flip: the notes' frozen path copies, and their id keys beside them. */
  function keyedBucket(): MemoryStore & FileStore {
    const store = bucket();
    for (let n = 0; n < 7; n += 1) store.seed(`notes/0190-note-${n}.md`, `# ${n}\n`);
    return store;
  }

  test("is counted from the tree, and the bucket is not listed", async () => {
    const store = keyedBucket();
    const rows = (await rowsOf(store)).filter(({ path }) => !path.startsWith("notes/"));
    const list = vi.spyOn(store, "list");
    const counted = await servedNoteCount(ctxServing(rows), WS);
    expect(counted).toEqual({ notes: 11, truncated: false });
    expect(list).not.toHaveBeenCalled();
  });

  test("records nothing when the tree cannot answer, rather than the walk", async () => {
    const store = keyedBucket();
    const list = vi.spyOn(store, "list");
    expect(await servedNoteCount(ctxServing(null), WS)).toBeNull();
    expect(list).not.toHaveBeenCalled();
  });
});

describe("recountNotes", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("keeps the last figure while the tree has not copied, and opens no bucket", async () => {
    const t = setupTest();
    const owner = await createUser(t, "count-owner@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "count-me");
    await seedStorageBinding(t, { workspaceId, boundBy: owner, status: "connected" });
    await t.run(async (ctx) => {
      const binding = await ctx.db.query("storageBindings").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).unique();
      await ctx.db.patch(binding!._id, { noteCount: 912, noteCountedAt: 1 });
    });
    const fetched = vi.fn(async () => new Response("<ListBucketResult></ListBucketResult>", { status: 200 }));
    vi.stubGlobal("fetch", fetched);
    await t.action(internal.functions.provisioning.recountNotes, { workspaceId });
    expect(fetched).not.toHaveBeenCalled();
    const binding = await t.run((ctx) => ctx.db.query("storageBindings").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).unique());
    expect(binding!.noteCount).toBe(912);
    expect(binding!.noteCountedAt).toBe(1);
  });
});
