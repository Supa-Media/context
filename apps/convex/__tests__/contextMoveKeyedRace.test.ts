/**
 * A keyed note keeps moving into another workspace when its bytes changed
 * under the tree's back, or while it was being moved
 * (`docs/decisions/storage-and-credentials/notes-by-id.md`).
 *
 * The move used to retire a keyed source by its row's etag, compared against
 * the etag its own read saw in the bucket. Two things put those apart without
 * anybody editing the note, and each one stopped every move of it with "a note
 * changed while it was being moved":
 *  - a rewrite of the note's key the row never heard about (the managed
 *    encryption walk seals keys in the bare bucket and tells no row);
 *  - the move's own read of a collaboratively edited note, which finishes the
 *    document's Markdown first and so writes the key after it was read.
 *
 * And an edit that really lands mid-move (an open editor saving) is no reason
 * to give up: the copy goes, the pass runs again, and the latest text arrives.
 *
 * Sabotage, each confirmed to fail a case here:
 *  - retire by the row's etag again: the stale-row and finished-document cases stop;
 *  - take the etag before the collaboration read: the finished-document case carries twice;
 *  - fail on a conflict instead of trying again: the mid-move edit case stops.
 */

import { readDocument, replaceText } from "@context/collaboration";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { asUser, drainScheduled, type TestConvex } from "./fixtures.helpers";
import { pair as pairOf, type Pair } from "./contextMove.helpers";
import { keyWorkspace } from "./contextMoveKeyed.helpers";
import type { MemoryS3 } from "./storeStub.helpers";

afterEach(() => vi.unstubAllEnvs());

const NOTE = "1-projects/acme/note-001.md";

async function liveRow(t: TestConvex, workspaceId: Id<"workspaces">, path: string) {
  return await t.run(async (ctx) => {
    const row = await ctx.db
      .query("nodes")
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).eq("path", path))
      .unique();
    return row !== null && row.goneAt === undefined ? row : null;
  });
}

/** Copies the destination took back: each one is an edit the move met and carried again. */
async function takenBack(p: Pair) {
  return await p.t.run(async (ctx) =>
    (await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", p.to)).collect()).filter(
      (row) => row.kind === "file" && row.goneAt === undefined && row.path.startsWith(".context/trash/"),
    ),
  );
}

async function move(p: Pair, from: string, to: string) {
  const { moveId } = await asUser(p.t, p.mover).action(api.functions.contextMoves.startContextMove, {
    sourceWorkspaceId: p.from,
    from,
    destinationWorkspaceId: p.to,
    to,
  });
  await drainScheduled(p.t);
  return await p.t.run((ctx) => ctx.db.get(moveId));
}

async function keyedPair(mover: boolean): Promise<Pair> {
  const p = await pairOf({ notes: 3, into: "own", mover });
  await keyWorkspace(p.t, p.from, p.source);
  await keyWorkspace(p.t, p.to, p.destination);
  return p;
}

/**
 * The source bucket as an editor's save sees it: the note's name reads and
 * writes its key, and each write is told to the row, as the id layer reports it.
 */
function editorStore(p: Pair, bucket: MemoryS3, row: Doc<"nodes">) {
  const keyOf = (key: string) => (key === row.path ? row.storageKey! : key);
  const answer = (key: string) => {
    const value = bucket.objects.get(keyOf(key));
    return value === undefined
      ? null
      : { etag: value.etag, size: value.bytes.byteLength, text: async () => value.body, arrayBuffer: async () => value.bytes.slice().buffer };
  };
  return {
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    noteIdAt: async (path: string) => (path === row.path ? row.noteId! : null),
    get: async (key: string) => answer(key),
    head: async (key: string) => answer(key),
    put: async (key: string, body: string | Uint8Array | ArrayBuffer, options?: { onlyIf?: { etagMatches?: string; absent?: boolean } }) => {
      const at = keyOf(key);
      const held = bucket.objects.get(at);
      if (options?.onlyIf?.absent === true && held !== undefined) return null;
      if (options?.onlyIf?.etagMatches !== undefined && held?.etag !== options.onlyIf.etagMatches) return null;
      bucket.seed(at, body);
      const etag = bucket.objects.get(at)!.etag;
      if (at === row.storageKey) await p.t.run((ctx) => ctx.db.patch(row._id, { etag }));
      return { etag };
    },
    delete: async (key: string) => {
      bucket.objects.delete(keyOf(key));
    },
    list: async () => ({ objects: [], truncated: false }),
  };
}

async function landedText(p: Pair, path: string): Promise<string | undefined> {
  const landed = await liveRow(p.t, p.to, path);
  return landed?.storageKey === undefined ? undefined : p.destination.objects.get(landed.storageKey)?.body;
}

describe.each([
  { carrier: "this deployment", mover: false },
  { carrier: "the gateway's mover", mover: true },
])("a keyed note moving out, carried by $carrier", { timeout: 30_000 }, ({ mover }) => {
  test("moves when its key was rewritten without its row hearing", async () => {
    const p = await keyedPair(mover);
    const row = (await liveRow(p.t, p.from, NOTE))!;
    // The same bytes written again under the tree's back, as the encryption walk seals a key.
    p.source.seed(row.storageKey!, "# 1\n");

    const moved = await move(p, NOTE, "work/note-001.md");

    expect([moved?.status, moved?.error]).toEqual(["complete", undefined]);
    expect(await landedText(p, "work/note-001.md")).toBe("# 1\n");
    expect(await liveRow(p.t, p.from, NOTE)).toBeNull();
    // Moved first time: nobody edited it, so nothing was carried twice.
    expect(await takenBack(p)).toEqual([]);
  });

  test("moves a collaboratively edited note whose Markdown the move's own read finishes", async () => {
    const p = await keyedPair(mover);
    const owner = asUser(p.t, p.mover);
    const read = await owner.action(api.functions.files.readNote, { workspaceId: p.from, path: NOTE });
    await owner.action(api.functions.files.writeNote, {
      workspaceId: p.from,
      path: NOTE,
      text: "# 1\n\nTyped in the editor.\n",
      expectedEtag: read.etag,
    });
    const row = (await liveRow(p.t, p.from, NOTE))!;
    // Rewritten underneath with the same text: the document's Markdown etag is behind, so reading it repairs it.
    p.source.seed(row.storageKey!, p.source.objects.get(row.storageKey!)!.body);

    const moved = await move(p, NOTE, "work/note-001.md");

    expect([moved?.status, moved?.error]).toEqual(["complete", undefined]);
    expect(await landedText(p, "work/note-001.md")).toBe("# 1\n\nTyped in the editor.\n");
    expect(await liveRow(p.t, p.from, NOTE)).toBeNull();
    expect(await takenBack(p)).toEqual([]);
  });

  test("an edit landing mid-move is carried by the next try, not lost and not a stopped move", async () => {
    const p = await keyedPair(mover);
    const row = (await liveRow(p.t, p.from, NOTE))!;
    const inner = globalThis.fetch;
    let edited = false;
    vi.stubGlobal("fetch", async (input: URL | RequestInfo, init: RequestInit = {}) => {
      const response = await inner(input, init);
      const url = String(input instanceof Request ? input.url : input);
      // The first time anything lands in the destination, the open editor saves the source.
      if (!edited && (init.method ?? "GET") === "PUT" && url.includes("dest") && url.includes("notes/")) {
        edited = true;
        const store = editorStore(p, p.source, row);
        const base = await readDocument(store, NOTE);
        await replaceText(store, NOTE, { expectedEtag: base.etag, text: "# 1\n\nSaved while it moved.\n" });
      }
      return response;
    });

    const moved = await move(p, NOTE, "work/note-001.md");

    expect(edited).toBe(true);
    expect([moved?.status, moved?.error]).toEqual(["complete", undefined]);
    expect(await landedText(p, "work/note-001.md")).toBe("# 1\n\nSaved while it moved.\n");
    expect(await liveRow(p.t, p.from, NOTE)).toBeNull();
    // The older copy was taken back into the destination's trash, never left beside the note.
    expect(await takenBack(p)).toHaveLength(1);
  });
});
