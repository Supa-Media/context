/**
 * A website while a folder move is queued (phase 4 of
 * `docs/decisions/app-and-console/convex-tree.md`), and the changes that may
 * narrow a site from outside `website/`.
 *
 * A queued move is one `moveQueue` row: every screen draws the folder at its
 * new name at once, and the bucket catches up behind. What must hold here:
 *
 *  - a Publish pressed mid-move publishes every page, at the name the tree
 *    draws, or fails as incomplete; it never puts the site up without them;
 *  - a page moved out of `website/` mid-move is not served from its old key
 *    (a one-go move takes it down at once, and a queued one must not be wider);
 *  - a move finishing (or starting, or turning round) that reaches the site
 *    marks its index stale, and so does a privacy change or a move of a folder
 *    a page names with `folder:`, unsafe, so the menu waits for the rebuild.
 *
 * SABOTAGE (each a temporary local edit, reverted):
 *  - list without `source: "tree"` while moves are pending (`routes.ts`): the
 *    mid-move Publish case fails (it can no longer publish the moved pages);
 *  - drop `assertScanSawMoves`: the "tree not serving" case publishes;
 *  - drop `get` from `AWAY_ANSWER` (`apps/mcp/src/moves/queued.js`): the
 *    moved-out page is served from its old key;
 *  - drop the `markWebsiteMoved` call in `nodeMoves.complete`: the finish case fails;
 *  - drop the index-row overlap in `routeChangeReaches`: the referenced-folder cases fail;
 *  - drop the `websiteNarrowingPaths` branch in the barrier: the console
 *    visibility case fails.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { asUser, gatewayPost } from "./fixtures.helpers";
import { fixture, pressPublish, publish, type Fixture } from "./website.helpers";

afterEach(() => vi.unstubAllGlobals());

const HOME = "---\ntitle: Home\nnav: 1\n---\n\nHome\n";
const FEATURES = "---\ntitle: Features\nnav: 2\nfolder: features\n---\n\nWhat Context does.\n";
const FIRST = "---\ntitle: First post\n---\n\nThe first post.\n";
const SECOND = "---\ntitle: Second post\n---\n\nThe second post.\n";

async function site(): Promise<Fixture> {
  const f = await fixture();
  f.backend.seed("website/index.md", HOME);
  f.backend.seed("website/features.md", FEATURES);
  f.backend.seed("website/blog/first.md", FIRST);
  f.backend.seed("website/blog/second.md", SECOND);
  f.backend.seed("features/forms.md", "---\ntitle: Forms\n---\n\nForms body\n");
  await asUser(f.t, f.owner).action(api.functions.files.setDirectoryVisibility, {
    workspaceId: f.workspaceId,
    path: "features",
    visibility: "team",
  });
  await publish(f);
  return f;
}

/** The tree swept and proved, so it serves the workspace and draws moves. */
async function serveTree(f: Fixture): Promise<void> {
  await f.t.action(internal.functions.files.runFileOperation, {
    workspaceId: f.workspaceId,
    scope: "private",
    operation: { kind: "nodesSweep" },
  });
  await f.t.mutation(internal.functions.nodes.saveParity, {
    workspaceId: f.workspaceId,
    parity: { checkedAt: Date.now(), clearances: 2, mismatches: 0, privacyMatches: true },
  });
  expect(await f.t.query(internal.functions.nodes.served, { workspaceId: f.workspaceId })).not.toBeNull();
}

/** A drawn move whose copy has not started: the bucket still holds every object at its old key. */
async function queuedMove(f: Fixture, from: string, to: string): Promise<Id<"moveQueue">> {
  const now = Date.now();
  return await f.t.run((ctx) =>
    ctx.db.insert("moveQueue", {
      workspaceId: f.workspaceId,
      from,
      to,
      kind: "folder",
      state: "moving",
      scope: "private",
      grantedNames: [],
      total: 2,
      moved: 0,
      added: { folders: [], notes: [] },
      attempts: 0,
      // Not due: no pass copies anything behind the test's back.
      nextAt: now + 3_600_000,
      createdAt: now,
      updatedAt: now,
    }),
  );
}

async function indexedKeys(f: Fixture): Promise<string[]> {
  const rows = await f.t.run((ctx) =>
    ctx.db
      .query("websiteRouteIndex")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", f.workspaceId))
      .collect(),
  );
  return rows.map((row) => row.objectKey).sort();
}

async function websiteState(f: Fixture) {
  const state = await f.t.run((ctx) =>
    ctx.db
      .query("websiteStates")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", f.workspaceId))
      .unique(),
  );
  return {
    stale: state!.routeGeneration !== state!.routeReconciledGeneration,
    unsafe: state!.routeUnsafeGeneration !== undefined,
    generation: state!.routeGeneration,
  };
}

describe("a Publish while a folder move is queued", () => {
  test("publishes every page, at the name the tree draws", async () => {
    const f = await site();
    expect(await indexedKeys(f)).toContain("website/blog/first.md");
    await serveTree(f);
    await queuedMove(f, "website/blog", "website/posts");

    await expect(pressPublish(f)).resolves.toMatchObject({ published: true });
    const keys = await indexedKeys(f);
    expect(keys).toEqual(expect.arrayContaining(["website/posts/first.md", "website/posts/second.md"]));
    expect(keys.some((key) => key.startsWith("website/blog/"))).toBe(false);
    // The read moved each page to where the tree draws it, as opening it would.
    expect(Object.keys(f.backend.snapshot())).toContain("website/posts/first.md");
  }, 30_000);

  test("fails as incomplete, keeping the published site, when the tree cannot draw the move", async () => {
    const f = await site();
    const before = await indexedKeys(f);
    // The tree is not there to draw it (its first copy is running again from
    // scratch): the scan cannot see the move. Pause no longer does this, since
    // 2026-10-13 it stops copying only.
    await f.t.run(async (ctx) => {
      for (const row of await ctx.db.query("nodeTrees").collect()) {
        await ctx.db.patch(row._id, { status: "filling", sweptAt: undefined });
      }
    });
    await queuedMove(f, "website/blog", "website/posts");

    await expect(pressPublish(f)).rejects.toMatchObject({ data: { code: "WEBSITE_SCAN_INCOMPLETE" } });
    expect(await indexedKeys(f)).toEqual(before);
  });

  test("a move nowhere near the site does not stop a Publish", async () => {
    const f = await site();
    await queuedMove(f, "2-areas/old", "2-areas/new");
    await expect(pressPublish(f)).resolves.toMatchObject({ published: true });
  });

  test("a page moved out of the site mid-move is not served from its old key", async () => {
    const f = await site();
    const before = await f.t.action(api.functions.websites.resolvePage, { handle: "atlas", routePath: "/blog/first" });
    expect(JSON.stringify(before)).toContain("The first post.");
    // Into a folder `privacy.md` keeps private: a one-go move would take the page down at once.
    await queuedMove(f, "website/blog", "2-areas/blog");

    const during = await f.t.action(api.functions.websites.resolvePage, { handle: "atlas", routePath: "/blog/first" });
    expect(JSON.stringify(during)).not.toContain("The first post.");
  });
});

describe("a change outside website/ that may narrow the site", () => {
  test("a queued move reaching the site marks it stale when it finishes", async () => {
    const f = await site();
    const id = await queuedMove(f, "website/blog", "website/posts");
    expect((await websiteState(f)).stale).toBe(false);
    await f.t.mutation(internal.functions.nodeMoves.complete, { id });
    expect(await websiteState(f)).toMatchObject({ stale: true, unsafe: true });
  });

  test("a queued move of a folder a page names marks it stale when it finishes", async () => {
    const f = await site();
    expect(await indexedKeys(f)).toContain("features/forms.md");
    const id = await queuedMove(f, "features", "capabilities");
    await f.t.mutation(internal.functions.nodeMoves.complete, { id });
    expect(await websiteState(f)).toMatchObject({ stale: true, unsafe: true });
  });

  test("a queued move elsewhere leaves the site alone", async () => {
    const f = await site();
    const id = await queuedMove(f, "2-areas/old", "2-areas/new");
    await f.t.mutation(internal.functions.nodeMoves.complete, { id });
    expect((await websiteState(f)).stale).toBe(false);
  });

  test("the console making a folder a page names private marks the site stale and unsafe", async () => {
    const f = await site();
    await asUser(f.t, f.owner).action(api.functions.files.setDirectoryVisibility, {
      workspaceId: f.workspaceId,
      path: "features",
      visibility: "private",
    });
    expect(await websiteState(f)).toMatchObject({ stale: true, unsafe: true });
  });

  test("the console re-scoping an unrelated folder leaves the site alone", async () => {
    const f = await site();
    await asUser(f.t, f.owner).action(api.functions.files.setDirectoryVisibility, {
      workspaceId: f.workspaceId,
      path: "2-areas",
      visibility: "team",
    });
    expect((await websiteState(f)).stale).toBe(false);
  });

  test("the gateway naming a folder a page names marks the site stale and unsafe", async () => {
    const f = await site();
    const response = await gatewayPost(f.t, "/gateway/website", {
      workspaceId: f.workspaceId,
      paths: ["features"],
    });
    expect(response.status).toBe(200);
    expect(await websiteState(f)).toMatchObject({ stale: true, unsafe: true });
  });

  test("the gateway naming privacy.md marks the site stale and unsafe", async () => {
    const f = await site();
    await gatewayPost(f.t, "/gateway/website", { workspaceId: f.workspaceId, paths: ["privacy.md"] });
    expect(await websiteState(f)).toMatchObject({ stale: true, unsafe: true });
  });

  test("the gateway naming an unrelated path leaves the site alone", async () => {
    const f = await site();
    await gatewayPost(f.t, "/gateway/website", { workspaceId: f.workspaceId, paths: ["2-areas/notes.md"] });
    expect((await websiteState(f)).stale).toBe(false);
  });
});
