/**
 * Links follow a move in the background (`functions/linkRepairs.ts`, `lib/nodes/linkRepair.ts`;
 * `paths-on-read.md`): a keyed move queues the files it carried and answers, and a pass rewrites the links
 * to them, never pointing a link at a name narrower than its own note.
 *
 * Sabotage, each run as a temporary local edit and reverted, and each failing here:
 *  - drop `queueLinkRepair` from `settleRowMove`: the move queues nothing;
 *  - drop `reachableRenames` from `fileOps/references.ts`: the team note names the private folder;
 *  - rewrite a collaborative note's Markdown rather than its document's text: the edit not yet rendered is lost;
 *  - let `claim` take an entry while another is leased: two passes hold one workspace;
 *  - drop the attempts check from `claim`: an entry that never succeeds is retried for ever.
 */

import { describe, expect, test } from "vitest";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { readDocument, replaceText } from "@context/collaboration";
import { repairLinks } from "../../functions/lib/nodes/linkRepair";
import { REPAIR_ATTEMPTS, REPAIR_LEASE_MS, REPAIR_PAIRS } from "../../functions/linkRepairs";
import { OWNER, fixture, start, type Fixture } from "./moveFixture.helpers";
import { keyedFixture } from "./keyedFixture.helpers";

async function queued(f: Fixture) {
  return await f.t.run(async (ctx) =>
    await ctx.db.query("linkRepairs").withIndex("by_workspace", (q) => q.eq("workspaceId", f.ws)).collect(),
  );
}

/** A move as the bucket sees it after the rows moved: the object at its new name, none at the old. */
async function moveObject(f: Fixture, from: string, to: string) {
  // A bare `brief.md` resolves by name wherever it lives, so the link here is a path.
  f.store.seed("1-projects/launch/plan.md", "# Plan\n\nSee [the brief](./brief.md).\n");
  const text = await (await f.store.get(from))!.text();
  f.store.seed(to, text);
  await f.store.delete(from);
}

describe("a move's links follow behind it", () => {
  test("a keyed move queues the files it carried, and answers without rewriting a note", async () => {
    const f = await keyedFixture();
    const before = f.store.snapshot();

    await start(f, "1-projects/launch", "3-resources/launch");

    const entries = await queued(f);
    expect(entries).toHaveLength(1);
    expect(entries[0].pairs).toContainEqual({ from: "1-projects/launch/plan.md", to: "3-resources/launch/plan.md" });
    expect(entries[0].pairs).toHaveLength(4);
    // The note bodies are what they were: the move rewrote no link.
    const notes = (snapshot: Record<string, string>) => Object.entries(snapshot).filter(([key]) => key.startsWith("notes/"));
    expect(notes(f.store.snapshot())).toEqual(notes(before));
  });

  test("a big move is queued a page to an entry", async () => {
    const f = await fixture();
    const pairs = Array.from({ length: REPAIR_PAIRS + 1 }, (_, n) => ({ from: `a/${n}.md`, to: `b/${n}.md` }));
    await f.t.mutation(internal.functions.linkRepairs.enqueue, { workspaceId: f.ws, pairs, now: 1 });
    expect((await queued(f)).map((entry) => entry.pairs.length)).toEqual([REPAIR_PAIRS, 1]);
  });

  test("a pass points a link at where its note went", async () => {
    const f = await fixture();
    await moveObject(f, "1-projects/launch/brief.md", "3-resources/brief.md");

    const done = await repairLinks(f.ctx, f.ws, f.store, OWNER, [{ from: "1-projects/launch/brief.md", to: "3-resources/brief.md" }]);

    expect(done).toMatchObject({ kind: "linksRepaired", notes: 1, links: 1, capped: false });
    expect(await (await f.store.get("1-projects/launch/plan.md"))!.text()).toContain("[the brief](../../3-resources/brief.md)");
  });

  test("a note with editing history is rewritten on its own text, so an edit not yet in its Markdown is kept", async () => {
    const f = await fixture();
    await moveObject(f, "1-projects/launch/brief.md", "3-resources/brief.md");
    const plan = "1-projects/launch/plan.md";
    const opened = await readDocument(f.store as never, plan);
    const typed = "# Plan\n\nSee [the brief](./brief.md).\n\nTyped just now.\n";
    await replaceText(f.store as never, plan, { documentId: opened.documentId, expectedEtag: opened.etag, text: typed });

    // The rewrite's own two reads of the Markdown find it rendered behind the document, as it stood before the edit.
    const markdown = { text: async () => "# Plan\n\nSee [the brief](./brief.md).\n", etag: "stale" };
    const get = f.store.get.bind(f.store);
    let stale = 2;
    f.store.get = (async (key: string, ...rest: unknown[]) => {
      if (key === plan && stale > 0) {
        stale -= 1;
        return markdown;
      }
      return await (get as (...a: unknown[]) => unknown)(key, ...rest);
    }) as never;
    await repairLinks(f.ctx, f.ws, f.store, OWNER, [{ from: "1-projects/launch/brief.md", to: "3-resources/brief.md" }]);
    f.store.get = get;

    const after = (await readDocument(f.store as never, plan)).text;
    expect(after).toContain("[the brief](../../3-resources/brief.md)");
    expect(after).toContain("Typed just now.");
  });

  test("a link is never pointed at a name narrower than its own note", async () => {
    const f = await fixture();
    // `1-projects/launch` is team; `1-projects/secret` is private.
    await moveObject(f, "1-projects/launch/brief.md", "1-projects/secret/brief.md");

    const done = await repairLinks(f.ctx, f.ws, f.store, OWNER, [{ from: "1-projects/launch/brief.md", to: "1-projects/secret/brief.md" }]);

    expect(done.notes).toBe(0);
    const plan = await (await f.store.get("1-projects/launch/plan.md"))!.text();
    expect(plan).toContain("[the brief](./brief.md)");
    expect(plan).not.toContain("secret");
  });
});

describe("the queue", () => {
  async function entry(f: Fixture, fields: { attempts?: number; leaseAt?: number } = {}): Promise<Id<"linkRepairs">> {
    return await f.t.run(async (ctx) =>
      await ctx.db.insert("linkRepairs", { workspaceId: f.ws, pairs: [{ from: "a.md", to: "b.md" }], attempts: 0, createdAt: 1, ...fields }),
    );
  }

  test("one pass at a time holds a workspace's queue", async () => {
    const f = await fixture();
    await entry(f);
    await entry(f);
    const now = 10 * REPAIR_LEASE_MS;
    const first = await f.t.mutation(internal.functions.linkRepairs.claim, { workspaceId: f.ws, now });
    expect(first).not.toBeNull();
    expect(await f.t.mutation(internal.functions.linkRepairs.claim, { workspaceId: f.ws, now: now + 1 })).toBeNull();
    // A pass that stopped is taken over once its lease has run out.
    expect(await f.t.mutation(internal.functions.linkRepairs.claim, { workspaceId: f.ws, now: now + REPAIR_LEASE_MS })).not.toBeNull();
  });

  test("a finished entry is gone, a failed one waits with its label, and one that keeps failing is dropped", async () => {
    const f = await fixture();
    const done = await entry(f);
    await f.t.mutation(internal.functions.linkRepairs.finish, { id: done });
    expect(await queued(f)).toEqual([]);

    const failing = await entry(f, { attempts: REPAIR_ATTEMPTS - 1 });
    const claimed = await f.t.mutation(internal.functions.linkRepairs.claim, { workspaceId: f.ws, now: 1 });
    expect(claimed?.id).toBe(failing);
    await f.t.mutation(internal.functions.linkRepairs.fail, { id: failing, error: "REWRITE_CAPPED" });
    expect(await queued(f)).toMatchObject([{ attempts: REPAIR_ATTEMPTS, error: "REWRITE_CAPPED" }]);
    expect(await f.t.query(internal.functions.linkRepairs.report, {})).toEqual({
      entries: 1,
      files: 1,
      workspaces: 1,
      failing: { REWRITE_CAPPED: 1 },
    });

    expect(await f.t.mutation(internal.functions.linkRepairs.claim, { workspaceId: f.ws, now: 2 })).toBeNull();
    expect(await queued(f)).toEqual([]);
  });
});
