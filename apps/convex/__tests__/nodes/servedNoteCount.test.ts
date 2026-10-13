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
 *  - where the tree does not serve, or its read fails, the answer is `null`
 *    and the caller counts the bucket as before.
 *
 * Sabotage (temporary local edits, reverted):
 *  - counting every key instead of `isNoteKey`: "counts what the bucket
 *    walk counts" fails;
 *  - dropping the `catch`: "a failing tree read is no answer" fails.
 */

import { describe, expect, test, vi } from "vitest";
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
      if (name === "functions/nodeMoves:active") return moves;
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
