/**
 * NOTES' FACTS IN CONVEX: links and front matter (decided by the owner,
 * 2026-10-13: "let's move the front matter, keep it on the same row").
 *
 * What is proved, through convex-test against the real schema:
 *  - a first fill reads every note once and records its links (`nodeLinks`)
 *    and its props on its own `nodes` row, at the version it read; never the
 *    note's text;
 *  - after that, only notes the change log names are read again, and a
 *    note that has gone loses its links;
 *  - a read that lands after the note moved on to another version is not
 *    recorded; a read that fails is kept to try again and counted unparsed;
 *  - one pass at a time holds the fill;
 *  - a move's candidates are the notes pointing at what moved, by path or bare
 *    name, plus every unparsed note; none until the fill is whole;
 *  - one workspace's facts never answer for another.
 *
 * Sabotage (temporary local edits, reverted):
 *  - `factsCurrent` always false: "only the changed note is read again" fails
 *    (every note is re-read);
 *  - `record` writing whatever version it is handed: "a read that the note
 *    outran is not recorded" fails;
 *  - dropping `dropLinks` for a gone note: "a note that has gone loses its
 *    links" fails;
 *  - `finish` ignoring `failedKind`: "a note that keeps failing says why"
 *    fails.
 */

import { describe, expect, test } from "vitest";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import type { FileStore } from "../../functions/lib/fileOps";
import { runFactFill } from "../../functions/lib/nodes/factFill";
import { ManagedEncryptionError } from "../../../mcp/src/store/managedEncryption.js";
import { memoryStore, type MemoryStore } from "../storeStub.helpers";
import { applyTreeObservation } from "../fixtures.helpers";
import { factCtx, fillAll, observeBucket, tester, workspace } from "./facts.helpers";

type Bucket = MemoryStore & FileStore;

// A word, not a number: a timestamp in the dump can contain any digits.
const SECRET = "the quarterly codeword is marmalade";

function bucket(): Bucket {
  const store = memoryStore() as Bucket;
  store.seed("privacy.md", "rules\n");
  store.seed("1-projects/plan.md", `---\nstatus: active\npriority: high\n---\n# Plan\n\n${SECRET}. See [[notes]] and [the area](../2-areas/area.md).\n`);
  store.seed("1-projects/notes.md", "# Notes\n\nBack to [[plan]].\n");
  store.seed("2-areas/area.md", "# Area\n\nNothing links out.\n");
  store.seed("1-projects/diagram.png", "png");
  return store;
}

/** Count `get`s, so a test can say which notes a pass read. */
function counting(store: Bucket): { store: Bucket; reads: string[] } {
  const reads: string[] = [];
  const get = store.get.bind(store);
  store.get = (async (key: string, ...rest: unknown[]) => {
    reads.push(key);
    return await (get as (...args: unknown[]) => Promise<unknown>)(key, ...rest);
  }) as never;
  return { store, reads };
}

async function linksOf(t: ReturnType<typeof tester>, workspaceId: Id<"workspaces">) {
  const page = await t.query(internal.functions.nodeFacts.page, { workspaceId, cursor: null });
  return page.rows.map((row: string[]) => row.join(" ")).sort();
}

async function rowOf(t: ReturnType<typeof tester>, workspaceId: Id<"workspaces">, path: string) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("nodes")
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).eq("path", path))
      .unique(),
  );
}

describe("the facts fill", () => {
  test("a first fill reads every note once: links and props on the row, never the text", async () => {
    const t = tester();
    const ws = await workspace(t, "alpha");
    const { store, reads } = counting(bucket());
    await observeBucket(t, ws, store);
    await fillAll(t, ws, store);

    expect(await linksOf(t, ws)).toEqual([
      "1-projects/notes.md name plan",
      "1-projects/plan.md name notes",
      "1-projects/plan.md path 2-areas/area.md",
    ]);
    const plan = (await rowOf(t, ws, "1-projects/plan.md"))!;
    expect(plan.parsed).toBe(plan.etag);
    expect(JSON.parse(plan.props!).properties).toMatchObject({ status: "active", priority: "high" });
    // Every Markdown key is read once, `privacy.md` too as the search
    // database's fill read it; the picture is not.
    expect([...reads].sort()).toEqual(["1-projects/notes.md", "1-projects/plan.md", "2-areas/area.md", "privacy.md"]);
    expect(await t.query(internal.functions.nodeFacts.readiness, { workspaceId: ws })).toEqual({ ready: true, unparsed: 0 });
    // The lede is a derivative of the text, as the D1 table's was; the link
    // rows and the change state never carry it.
    const dump = await t.run(async (ctx) => JSON.stringify([await ctx.db.query("nodeLinks").collect(), await ctx.db.query("nodeFactState").collect()]));
    expect(dump).not.toContain("marmalade");
  });

  test("only the changed note is read again", async () => {
    const t = tester();
    const ws = await workspace(t, "beta");
    const { store, reads } = counting(bucket());
    await observeBucket(t, ws, store);
    await fillAll(t, ws, store);
    reads.length = 0;

    await store.put("1-projects/notes.md", "---\nstatus: done\n---\n# Notes\n\nNow [[area]] instead.\n");
    await observeBucket(t, ws, store);
    await fillAll(t, ws, store);

    expect(reads).toEqual(["1-projects/notes.md"]);
    expect(await linksOf(t, ws)).toContain("1-projects/notes.md name area");
    expect(await linksOf(t, ws)).not.toContain("1-projects/notes.md name plan");
    const notes = (await rowOf(t, ws, "1-projects/notes.md"))!;
    expect(JSON.parse(notes.props!).properties.status).toBe("done");
  });

  test("a note that has gone loses its links", async () => {
    const t = tester();
    const ws = await workspace(t, "gamma");
    const store = bucket();
    // A note the store wrote under its id key (a seam write): the only kind a removal can tombstone.
    const noteId = "0190a000-0000-7000-8000-00000000000a";
    await applyTreeObservation(t, {
      workspaceId: ws,
      at: 10,
      rows: [{ path: "1-projects/plan.md", etag: "p1", size: 1, keyed: { noteId, storageKey: `notes/${noteId}.md` } }],
      gone: [],
    });
    await fillAll(t, ws, store);
    expect((await linksOf(t, ws)).some((row: string) => row.startsWith("1-projects/plan.md "))).toBe(true);
    await applyTreeObservation(t, { workspaceId: ws, at: 20, rows: [], gone: ["1-projects/plan.md"] });
    await fillAll(t, ws, store);
    expect((await linksOf(t, ws)).some((row: string) => row.startsWith("1-projects/plan.md "))).toBe(false);
  });

  test("a read that the note outran is not recorded", async () => {
    const t = tester();
    const ws = await workspace(t, "delta");
    const store = bucket();
    await observeBucket(t, ws, store);
    await fillAll(t, ws, store);
    const before = (await rowOf(t, ws, "2-areas/area.md"))!;
    await t.mutation(internal.functions.nodeFacts.record, {
      workspaceId: ws,
      notes: [{ path: "2-areas/area.md", etag: "an-older-version", links: [["name", "plan"]], props: "{}" }],
    });
    expect((await rowOf(t, ws, "2-areas/area.md"))!.props).toBe(before.props);
    expect(await linksOf(t, ws)).not.toContain("2-areas/area.md name plan");
  });

  test("a read that fails is kept to try again, and counted unparsed meanwhile", async () => {
    const t = tester();
    const ws = await workspace(t, "epsilon");
    const store = bucket();
    await observeBucket(t, ws, store);
    const get = store.get.bind(store);
    let failing = true;
    store.get = (async (key: string, ...rest: unknown[]) => {
      if (failing && key === "2-areas/area.md") throw new Error("bucket hiccup");
      return await (get as (...args: unknown[]) => Promise<unknown>)(key, ...rest);
    }) as never;
    await fillAll(t, ws, store);
    expect(await t.query(internal.functions.nodeFacts.readiness, { workspaceId: ws })).toEqual({ ready: true, unparsed: 1 });
    failing = false;
    const { ctx } = factCtx(t);
    await runFactFill(ctx, ws, store, 0);
    expect(await t.query(internal.functions.nodeFacts.readiness, { workspaceId: ws })).toEqual({ ready: true, unparsed: 0 });
    expect((await rowOf(t, ws, "2-areas/area.md"))!.parsed).toBeDefined();
  });

  test("a note that keeps failing says why, pass after pass, and forgets it once it reads", async () => {
    const t = tester();
    const ws = await workspace(t, "zeta");
    const store = bucket();
    await observeBucket(t, ws, store);
    const get = store.get.bind(store);
    let failing = true;
    store.get = (async (key: string, ...rest: unknown[]) => {
      // What the sealed-only wrapper throws for @segunawe's late layout files.
      if (failing && key === "2-areas/area.md") throw new ManagedEncryptionError("ENCRYPTED_UNREADABLE", "plain object in encrypted workspace");
      return await (get as (...args: unknown[]) => Promise<unknown>)(key, ...rest);
    }) as never;
    const state = () => t.run(async (ctx) => (await ctx.db.query("nodeFactState").collect()).find((row) => row.workspaceId === ws)!);
    await fillAll(t, ws, store);
    const first = await state();
    expect(first).toMatchObject({ retry: ["2-areas/area.md"], retryKind: "unsealed" });
    await runFactFill(factCtx(t).ctx, ws, store, 0);
    expect((await state()).retryPasses).toBe((first.retryPasses ?? 0) + 1);
    failing = false;
    await runFactFill(factCtx(t).ctx, ws, store, 0);
    const healed = await state();
    expect(healed.retry).toBeUndefined();
    expect(healed.retryKind).toBeUndefined();
    expect(healed.retryPasses).toBeUndefined();
  });

  test("a note with more links than one write holds keeps the first and stays unparsed", async () => {
    const t = tester();
    const ws = await workspace(t, "crowded");
    const store = bucket();
    store.seed("3-resources/index-of-everything.md", Array.from({ length: 2_100 }, (_, n) => `[[note-${n}]]`).join("\n"));
    await observeBucket(t, ws, store);
    await fillAll(t, ws, store);
    const row = (await rowOf(t, ws, "3-resources/index-of-everything.md"))!;
    expect(row.parsed).toBeUndefined();
    const count = await t.run(async (ctx) =>
      (await ctx.db.query("nodeLinks").withIndex("by_workspace_source", (q) => q.eq("workspaceId", ws).eq("source", "3-resources/index-of-everything.md")).collect()).length,
    );
    expect(count).toBe(2_000);
    // A move does not trust the short list: the note is a candidate whatever it names.
    const found = (await t.query(internal.functions.nodeFacts.candidates, { workspaceId: ws, sources: [], names: ["note-2050"] }))!;
    expect(found.unparsed).toContain("3-resources/index-of-everything.md");
  });

  test("a row whose note the bucket no longer has keeps no links", async () => {
    const t = tester();
    const ws = await workspace(t, "vanished");
    const store = bucket();
    await observeBucket(t, ws, store);
    await store.delete("1-projects/plan.md");
    await fillAll(t, ws, store);
    expect((await linksOf(t, ws)).some((row: string) => row.startsWith("1-projects/plan.md "))).toBe(false);
    expect((await rowOf(t, ws, "1-projects/plan.md"))!.parsed).toBeUndefined();
  });

  test("one pass at a time holds the fill", async () => {
    const t = tester();
    const ws = await workspace(t, "zeta");
    const now = Date.now();
    expect(await t.mutation(internal.functions.nodeFacts.claim, { workspaceId: ws, now })).not.toBeNull();
    expect(await t.mutation(internal.functions.nodeFacts.claim, { workspaceId: ws, now: now + 1_000 })).toBeNull();
    // A pass that died lets the next take over once its hold lapses.
    expect(await t.mutation(internal.functions.nodeFacts.claim, { workspaceId: ws, now: now + 10 * 60_000 })).not.toBeNull();
  });

  test("a tree that does not serve is left alone", async () => {
    const t = tester();
    const ws = await workspace(t, "eta");
    const store = bucket();
    await observeBucket(t, ws, store);
    const { ctx } = factCtx(t, { served: false });
    expect(await runFactFill(ctx, ws, store, 0)).toEqual({ kind: "nodesKept", complete: false });
    expect(await t.query(internal.functions.nodeFacts.ready, { workspaceId: ws })).toBe(false);
  });
});

describe("a move's candidates", () => {
  test("the notes pointing at what moved, by path or bare name, and nothing until the fill is whole", async () => {
    const t = tester();
    const ws = await workspace(t, "theta");
    const store = bucket();
    await observeBucket(t, ws, store);
    const ask = { workspaceId: ws, sources: ["2-areas/area.md"], names: ["plan"] };
    expect(await t.query(internal.functions.nodeFacts.candidates, ask)).toBeNull();
    await fillAll(t, ws, store);
    const found = (await t.query(internal.functions.nodeFacts.candidates, ask))!;
    expect(found.pointing.sort()).toEqual(["1-projects/notes.md", "1-projects/plan.md"]);
    expect(found.unparsed).toEqual([]);
  });

  test("a note changed since it was read is a candidate whatever its rows said", async () => {
    const t = tester();
    const ws = await workspace(t, "iota");
    const store = bucket();
    await observeBucket(t, ws, store);
    await fillAll(t, ws, store);
    await store.put("2-areas/area.md", "# Area\n\nNow it links [[plan]].\n");
    await observeBucket(t, ws, store);
    const found = (await t.query(internal.functions.nodeFacts.candidates, { workspaceId: ws, sources: [], names: ["plan"] }))!;
    expect(found.unparsed).toEqual(["2-areas/area.md"]);
  });

  test("one workspace's links never answer for another", async () => {
    const t = tester();
    const mine = await workspace(t, "mine");
    const theirs = await workspace(t, "theirs");
    const store = bucket();
    await observeBucket(t, theirs, store);
    await fillAll(t, theirs, store);
    await observeBucket(t, mine, memoryStore() as Bucket);
    await fillAll(t, mine, memoryStore() as Bucket);
    const found = await t.query(internal.functions.nodeFacts.candidates, { workspaceId: mine, sources: ["2-areas/area.md"], names: ["plan"] });
    expect(found).toEqual({ pointing: [], unparsed: [] });
    expect((await t.query(internal.functions.nodeFacts.page, { workspaceId: mine, cursor: null })).rows).toEqual([]);
    expect(await t.query(internal.functions.nodeFacts.propsAt, { workspaceId: mine, paths: ["1-projects/plan.md"] })).toEqual([]);
  });
});
