/**
 * A move's link rewrite reads only the notes the tree's link facts name
 * (`linkCandidates` in `lib/fileOps/references.ts`), so a workspace of any size
 * is rewritten: the cap counts the notes that can hold a link to what moved,
 * not the workspace.
 *
 * Runs the real functions through `convex-test`: a queued folder move, drained
 * by the worker whose finish runs the rewrite, over a tree of more than
 * `LINK_SCAN_CAP` notes.
 *
 * Sabotage: drop the candidate filter and the workspace is past the cap, so the
 * linking note keeps its old link (the first case fails); drop the moved notes'
 * own links (`linking`) and the moved note's relative link is not mended (the
 * second case fails).
 */

import { describe, expect, test } from "vitest";
import { attachTreeListing } from "../../functions/lib/nodes/treeNames";
import { type Fixture, drain, fixture, start } from "./moveFixture.helpers";

/** More notes than one rewrite may read: `LINK_SCAN_CAP` is 4,000. */
const NOTES = 4_100;

async function crowded(f: Fixture): Promise<void> {
  await f.t.run(async (ctx) => {
    for (let index = 0; index < NOTES; index += 1) {
      await ctx.db.insert("nodes", {
        workspaceId: f.ws,
        path: `3-resources/many/m${index}.md`,
        name: `m${index}.md`,
        kind: "file",
        etag: "e",
        observedAt: 1,
      });
    }
    await ctx.db.insert("nodeFactState", { workspaceId: f.ws, ready: true, seq: Number.MAX_SAFE_INTEGER });
  });
}

/** A note in the bucket and the tree, with the link rows its text holds. */
async function note(f: Fixture, path: string, text: string, links: { kind: "path" | "name"; target: string }[]): Promise<void> {
  const put = await f.store.put(path, text);
  await f.t.run(async (ctx) => {
    await ctx.db.insert("nodes", { workspaceId: f.ws, path, name: path.slice(path.lastIndexOf("/") + 1), kind: "file", etag: put?.etag ?? "e", observedAt: 1 });
    for (const link of links) await ctx.db.insert("nodeLinks", { workspaceId: f.ws, source: path, ...link });
  });
}

describe("a move's link rewrite in a workspace past the scan cap", { timeout: 120_000 }, () => {
  test("reaches a note linking into the moved folder", async () => {
    const f = await fixture();
    await crowded(f);
    await note(f, "3-resources/linker.md", "# Linker\n\nSee [the brief](../1-projects/launch/brief.md).\n", [
      { kind: "path", target: "1-projects/launch/brief.md" },
    ]);
    attachTreeListing(f.ctx, f.ws, f.store);

    await start(f, "1-projects/launch", "2-areas/launch");
    await drain(f);

    expect(f.store.snapshot()["3-resources/linker.md"]).toContain("](../2-areas/launch/brief.md)");
  });

  test("mends a moved note's own relative link out of the folder", async () => {
    const f = await fixture();
    await crowded(f);
    await note(f, "1-projects/launch/out.md", "# Out\n\nSee [keep](../keep.md).\n", [{ kind: "path", target: "1-projects/keep.md" }]);
    attachTreeListing(f.ctx, f.ws, f.store);

    await start(f, "1-projects/launch", "2-areas/launch");
    await drain(f);

    expect(f.store.snapshot()["2-areas/launch/out.md"]).toContain("](../../1-projects/keep.md)");
  });
});
