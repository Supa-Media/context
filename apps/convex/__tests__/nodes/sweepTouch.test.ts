/**
 * The tree's sweep and write-path re-check, end to end over the in-memory
 * sink (`nodeTable.helpers.ts`), which runs the production `observe.ts` rules.
 *
 * A listing that returns seven keys at a time is the real shape of the
 * problem: the sweep must resume across passes, the plumbing jump must hold,
 * and nothing a pass did not reach may be pruned as "gone". So every sweep
 * here goes through `pagedStore(…, 7)`, and most run several passes.
 */

import { describe, expect, test, vi } from "vitest";
import { clearanceOf } from "../../functions/lib/clearance";
import { type FileStore, setFolderVisibility, setVisibility } from "../../functions/lib/fileOps";
import { PRIVACY_KEY } from "../../functions/lib/privacy";
import { renderPrivacyManifest } from "../../functions/lib/scaffold";
import { FILL_FAILED, TOKEN_CURSOR, sweepNodesPass, type NodeListingStore } from "../../functions/lib/nodes/sweep";
import { touchNodes } from "../../functions/lib/nodes/touch";
import {
  NODE_TOUCH_FOLDER_PAGES,
  NODE_TOUCH_PATHS,
  NODE_UNSUPPORTED_RETRY_MS,
  nodeSweepDue,
  type NodeSink,
} from "../../functions/lib/nodes/table";
import { memoryNodeSink } from "../nodeTable.helpers";
import { memoryStore, type MemoryStore } from "../storeStub.helpers";

type Store = MemoryStore & FileStore;
const OWNER = clearanceOf("private");

/** A workspace shaped like the one the tree is checked against, and a folder move the sweep must see. */
async function workspace(): Promise<Store> {
  const store = memoryStore() as Store;
  store.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  store.seed("index.md", "# Context\n");
  store.seed("1-projects/launch.md", "# Launch\n");
  store.seed("1-projects/launch/brief.md", "# Brief\n");
  store.seed("1-projects/held-back.md", "# Held back\n");
  store.seed("1-projects/private/plan.md", "# Plan\n");
  store.seed("1-projectsX/sibling.md", "# Not under 1-projects\n");
  store.seed("2-areas/health/vitals.md", "# Vitals\n");
  store.seed(".context/reads/2026-10-08/1.json", "{}");
  for (let index = 0; index < 30; index += 1) {
    store.seed(`3-resources/r${String(index).padStart(2, "0")}.md`, `# R${index}\n`);
  }
  await setFolderVisibility(store, { path: "1-projects", visibility: "team", clearance: OWNER });
  await setFolderVisibility(store, { path: "3-resources", visibility: "team", clearance: OWNER });
  await setFolderVisibility(store, { path: "1-projects/private", visibility: "private", clearance: OWNER });
  await setVisibility(store, { path: "1-projects/held-back.md", visibility: "private", clearance: OWNER });
  return store;
}

/** Each call is a later time, so every observation is stamped after the one before it. */
function ticker(start = 1_000): () => number {
  let at = start;
  return () => (at += 1);
}

/** The bucket's listing, answering at most `size` keys a page. */
function pagedStore(base: Store, size: number): NodeListingStore {
  return {
    list: (options) => base.list({ ...options, limit: Math.min(options?.limit ?? 1_000, size) }),
    get: (key) => base.get(key),
  };
}

/** Sweeps two pages at a time until a pass completes. Returns how many passes that took. */
async function sweepToEnd(store: Store, sink: NodeSink, now = ticker()): Promise<number> {
  for (let pass = 1; pass <= 50; pass += 1) {
    const result = await sweepNodesPass(pagedStore(store, 7), sink, { now, maxPages: 2 });
    expect(result.unsupported).toBe(false);
    if (result.complete) return pass;
  }
  throw new Error("the sweep did not finish");
}

/** The tree's live file keys, sorted. */
function livePaths(sink: ReturnType<typeof memoryNodeSink>): string[] {
  return sink.table
    .rows()
    .filter((node) => node.kind === "file" && node.goneAt === undefined)
    .map((node) => node.path)
    .sort();
}

describe("the sweep", () => {
  test("fills the tree from a paged listing over several passes, to exactly what the bucket holds", async () => {
    const store = await workspace();
    const sink = memoryNodeSink();
    const passes = await sweepToEnd(store, sink);
    expect(passes).toBeGreaterThan(1);

    const expected = [...store.objects.keys()].filter((key) => !key.startsWith(".")).sort();
    expect(livePaths(sink)).toEqual(expected);
    for (const node of sink.table.rows().filter((row) => row.kind === "file")) {
      expect(node.etag).toBe((await store.get(node.path))?.etag);
    }
    expect(sink.treeState()).toMatchObject({ status: "ready", files: expected.length });
  });

  test("keeps the privacy rules the bucket's privacy.md states", async () => {
    const store = await workspace();
    const sink = memoryNodeSink();
    await sweepToEnd(store, sink);
    const mirror = await sink.privacy();
    expect(mirror?.invalid).toBe(false);
    expect(mirror?.folders).toEqual(
      expect.arrayContaining([
        { prefix: "1-projects", visibility: "team" },
        { prefix: "3-resources", visibility: "team" },
      ]),
    );
    expect(mirror?.notes).toContainEqual({ path: "1-projects/held-back.md", visibility: "private" });
  });

  test("re-reads an unchanged privacy.md whose held copy did not parse", async () => {
    // The parser can come to read bytes it once refused (a colon in a path,
    // 2026-10-14). The etag has not moved, so an etag check alone would leave
    // the workspace failed closed until someone edits the file.
    const store = await workspace();
    const sink = memoryNodeSink();
    await sweepToEnd(store, sink);
    const held = (await sink.privacy())!;
    await sink.savePrivacy({ ...held, invalid: true, folders: [], notes: [] }, 3_000);
    expect((await sink.privacy())?.invalid).toBe(true);
    await sweepToEnd(store, sink, ticker(5_000));
    const mirror = await sink.privacy();
    expect(mirror?.invalid).toBe(false);
    expect(mirror?.notes).toContainEqual({ path: "1-projects/held-back.md", visibility: "private" });
  });

  test("a note deleted from the bucket is gone after the next completed sweep, and one added appears", async () => {
    const store = await workspace();
    const sink = memoryNodeSink();
    const now = ticker();
    await sweepToEnd(store, sink, now);
    await store.delete("3-resources/r03.md");
    store.seed("3-resources/added.md", "# Added\n");
    await sweepToEnd(store, sink, now);
    const paths = livePaths(sink);
    expect(paths).not.toContain("3-resources/r03.md");
    expect(paths).toContain("3-resources/added.md");
  });

  test("a store that ignores startAfter is paged by its own token, across passes, and fills", async () => {
    // Sabotage: mark it unsupported on the first out-of-order key (the old
    // rule) and this never completes; drop the token from `progress` and the
    // second pass starts again from the top and never reaches r19.
    const store = memoryStore({ ignoreStartAfter: true }) as Store;
    for (let index = 0; index < 20; index += 1) store.seed(`3-resources/r${index}.md`, "x");
    store.seed(".context/activity/a.json", "{}");
    const sink = memoryNodeSink();
    const now = ticker();
    const first = await sweepNodesPass(pagedStore(store, 7), sink, { now, maxPages: 2 });
    expect(first).toMatchObject({ complete: false, unsupported: false });
    expect(sink.treeState()?.cursor?.startsWith(TOKEN_CURSOR)).toBe(true);
    let result = first;
    for (let pass = 0; pass < 10 && !result.complete; pass += 1) {
      result = await sweepNodesPass(pagedStore(store, 7), sink, { now, maxPages: 2 });
    }
    expect(result).toMatchObject({ complete: true, unsupported: false });
    expect(sink.treeState()?.status).toBe("ready");
    const live = sink.table.rows().filter((row) => row.kind === "file" && row.goneAt === undefined).map((row) => row.path);
    expect(live.sort()).toEqual(Array.from({ length: 20 }, (_, index) => `3-resources/r${index}.md`).sort());
  });

  test("a token the store no longer takes starts the listing again rather than failing for ever", async () => {
    const store = memoryStore({ ignoreStartAfter: true }) as Store;
    for (let index = 0; index < 20; index += 1) store.seed(`3-resources/r${index}.md`, "x");
    const sink = memoryNodeSink();
    const now = ticker();
    await sweepNodesPass(pagedStore(store, 7), sink, { now, maxPages: 2 });
    const expiring: NodeListingStore = {
      list: async (options) => {
        if (options?.cursor !== undefined) throw new Error("expired cursor");
        return await pagedStore(store, 50).list(options);
      },
      get: (key) => store.get(key),
    };
    expect(await sweepNodesPass(expiring, sink, { now })).toMatchObject({ complete: true });
  });

  test("a store that says there is more and gives no way to ask stays unsupported, and is tried again a day later", async () => {
    const store = memoryStore({ ignoreStartAfter: true }) as Store;
    for (let index = 0; index < 20; index += 1) store.seed(`3-resources/r${index}.md`, "x");
    const tokenless: NodeListingStore = {
      list: async (options) => ({ ...(await pagedStore(store, 7).list(options)), cursor: undefined }),
      get: (key) => store.get(key),
    };
    const sink = memoryNodeSink();
    const result = await sweepNodesPass(tokenless, sink, { now: ticker(), maxPages: 5 });
    expect(result).toMatchObject({ complete: false, unsupported: true });
    expect(sink.treeState()?.status).toBe("unsupported");
    const marked = { ...sink.treeState()!, leaseAt: 1_000 };
    expect(nodeSweepDue(marked, 1_000 + 60_000)).toBe(false);
    expect(nodeSweepDue(marked, 1_000 + NODE_UNSUPPORTED_RETRY_MS)).toBe(true);
    // And the retry is a real pass: a store that now pages by token fills.
    expect(await sweepNodesPass(pagedStore(store, 50), sink, { now: ticker() })).toMatchObject({ complete: true });
  });

  test("a failing pass records a fixed label, never the error text, and rethrows", async () => {
    const store = await workspace();
    const failing: NodeListingStore = {
      list: async () => {
        throw new Error("AccessDenied: 1-projects/held-back.md");
      },
      get: (key) => store.get(key),
    };
    const sink = memoryNodeSink();
    await expect(sweepNodesPass(failing, sink, { now: ticker() })).rejects.toThrow("AccessDenied");
    expect(sink.treeState()?.error).toBe(FILL_FAILED);
    expect(JSON.stringify(sink.treeState())).not.toContain("held-back");
  });

  test("a row a touch observed after the page that listed it was taken is not overwritten by that page", async () => {
    const store = await workspace();
    const sink = memoryNodeSink();
    let raced = false;
    // The sweep's clock: the page is stamped at 1_000, before its listing. The
    // touch (5_000) happens during that listing and the clock moves on after it.
    // The note is on a page the sweep keeps (not the one a plumbing jump discards),
    // so this listing is the one the sweep stores.
    let clock = 1_000;
    const racing: NodeListingStore = {
      list: async (options) => {
        const listing = await pagedStore(store, 7).list(options);
        const holdsRaced = listing.objects.some((object) => object.key === "3-resources/r20.md");
        if (holdsRaced && !raced) {
          raced = true;
          // The bucket changes after this page was listed, and the write path's re-check sees the change first.
          await store.put("3-resources/r20.md", "# R20, edited\n");
          await touchNodes(store, sink, { files: ["3-resources/r20.md"], now: () => 5_000 });
          clock = 6_000;
        }
        return listing;
      },
      get: (key) => store.get(key),
    };
    const result = await sweepNodesPass(racing, sink, { now: () => clock, maxPages: 50 });
    expect(raced).toBe(true);
    expect(result.complete).toBe(true);
    const row = await sink.table.byPath("3-resources/r20.md");
    expect(row?.etag).toBe((await store.get("3-resources/r20.md"))?.etag);
    expect(row?.observedAt).toBe(5_000);
  });
});

describe("the write-path re-check", () => {
  test("after a file is deleted and its folder touched, its row is gone", async () => {
    const store = await workspace();
    const sink = memoryNodeSink();
    const now = ticker();
    await sweepToEnd(store, sink, now);
    await store.delete("2-areas/health/vitals.md");
    const result = await touchNodes(store, sink, { paths: ["2-areas/health"], now });
    expect(result).toEqual({ checked: 1, dirty: false });
    expect(livePaths(sink)).not.toContain("2-areas/health/vitals.md");
  });

  test("after a file is added and touched, it appears", async () => {
    const store = await workspace();
    const sink = memoryNodeSink();
    const now = ticker();
    await sweepToEnd(store, sink, now);
    store.seed("1-projects/new-note.md", "# New\n");
    await touchNodes(store, sink, { files: ["1-projects/new-note.md"], now });
    expect(livePaths(sink)).toContain("1-projects/new-note.md");
  });

  test("more than NODE_TOUCH_PATHS paths marks the tree dirty without listing a thing", async () => {
    const store = await workspace();
    const sink = memoryNodeSink();
    await sweepToEnd(store, sink);
    const listed = vi.spyOn(store, "list");
    const files = Array.from({ length: NODE_TOUCH_PATHS + 1 }, (_, index) => `3-resources/bulk-${index}.md`);
    expect(await touchNodes(store, sink, { files, now: ticker() })).toEqual({ checked: 0, dirty: true });
    expect(listed).not.toHaveBeenCalled();
    expect(sink.treeState()?.dirty).toBe(true);
  });

  test("a folder that takes more pages than one re-check may walk marks the tree dirty; one that fits does not", async () => {
    const store = await workspace();
    const sink = memoryNodeSink();
    await sweepToEnd(store, sink);
    // Seven keys a page: NODE_TOUCH_FOLDER_PAGES pages hold exactly 70.
    const fits = NODE_TOUCH_FOLDER_PAGES * 7;
    for (let index = 0; index < fits; index += 1) store.seed(`fits/f${index}.md`, "x");
    for (let index = 0; index < fits + 1; index += 1) store.seed(`toobig/f${index}.md`, "x");

    expect(await touchNodes(pagedStore(store, 7) as Store, sink, { paths: ["fits"], now: ticker() })).toEqual({
      checked: 1,
      dirty: false,
    });
    expect(livePaths(sink).filter((path) => path.startsWith("fits/"))).toHaveLength(fits);

    const big = await touchNodes(pagedStore(store, 7) as Store, sink, { paths: ["toobig"], now: ticker() });
    expect(big.dirty).toBe(true);
    expect(sink.treeState()?.dirty).toBe(true);
  });

  test("touching privacy.md after a folder's visibility changed in the bucket updates the mirror", async () => {
    const store = await workspace();
    const sink = memoryNodeSink();
    const now = ticker();
    await sweepToEnd(store, sink, now);
    await setFolderVisibility(store, { path: "3-resources", visibility: "private", clearance: OWNER });
    await touchNodes(store, sink, { files: [PRIVACY_KEY], now });
    expect((await sink.privacy())?.folders).toContainEqual({ prefix: "3-resources", visibility: "private" });
    expect((await sink.table.byPath(PRIVACY_KEY))?.etag).toBe((await store.get(PRIVACY_KEY))?.etag);
  });
});

describe("a page whose keys were all hidden", () => {
  // Deleted notes leave markers the store hides (`logicalDelete.js`): a full
  // page can list nothing yet say there is more, naming where it got to in
  // `resumeAfter`. Seen on a real workspace on 2026-10-12, where the sweep
  // stopped with "said there was more but returned nothing new".
  function hidingStore(base: Store, hidden: (key: string) => boolean): NodeListingStore {
    return {
      list: async (options) => {
        const listing = await base.list({ ...options, limit: Math.min(options?.limit ?? 1_000, 7) });
        const objects = (listing.objects ?? []) as { key: string }[];
        const shown = objects.filter((object) => !hidden(object.key));
        const last = objects[objects.length - 1]?.key;
        return { ...listing, objects: shown, ...(last === undefined ? {} : { resumeAfter: last }) };
      },
      get: (key) => base.get(key),
    };
  }

  test("the sweep resumes after the last key the provider listed and finishes", async () => {
    const store = await workspace();
    for (let index = 0; index < 20; index += 1) store.seed(`0-inbox/gone-${String(index).padStart(2, "0")}.md`, "x");
    const sink = memoryNodeSink();
    const now = ticker();
    let complete = false;
    for (let pass = 0; pass < 50 && !complete; pass += 1) {
      const result = await sweepNodesPass(hidingStore(store, (key) => key.startsWith("0-inbox/gone-")), sink, { now, maxPages: 2 });
      expect((await sink.state())?.error).toBeUndefined();
      complete = result.complete;
    }
    expect(complete).toBe(true);
    expect(livePaths(sink)).toContain("3-resources/r29.md");
    expect(livePaths(sink).some((path) => path.startsWith("0-inbox/gone-"))).toBe(false);
  });
});
