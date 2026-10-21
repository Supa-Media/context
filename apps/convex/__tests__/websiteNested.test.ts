/**
 * A website whose folder is nested somewhere else (owner, 2026-10-21;
 * `docs/decisions/websites.md`, "The website folder can be nested").
 *
 * The site keeps naming its pages under `website/`, and every read that judges
 * who may see a page is made where the folder doing the website's job is now
 * (`lib/websites/siteRoot.ts`). What must hold:
 *
 *  - a nested folder publishes and serves its pages at the same addresses;
 *  - what decides a page is the real folder's privacy, never wider: a page
 *    held back there, or the whole folder made private, serves nothing;
 *  - an edit, a privacy change or a move under the real folder marks the site
 *    stale, and an edit elsewhere does not.
 *
 * SABOTAGE (each a temporary local edit, reverted):
 *  - drop the `siteLens` call at the top of `runFileOperationHandler`
 *    (`fileOperationBarrier.ts`): nothing publishes from the nested folder;
 *  - drop `sitePaths` in `nodeFacts.ts`: the tree's answer case fails (the
 *    design notes, lists, probes and history read the tree by the site's name);
 *  - judge at the asked name in `siteLens.ts` (`realSitePath` returning its
 *    path): the nested site is empty;
 *  - drop `nestedSiteRoot` in `routeChangeAt.ts`: the edit-marks-stale case fails.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { markNestedSiteWrite } from "../functions/lib/websites/routeChangeAt";
import { realSitePath, siteNameOf } from "../functions/lib/websites/siteRoot";
import { asUser, copyTree } from "./fixtures.helpers";
import { fixture, type Fixture } from "./website.helpers";

afterEach(() => vi.unstubAllGlobals());

const HOME = "---\ntitle: Home\nnav: 1\n---\n\nHome\n";
const ABOUT = "---\ntitle: About\nnav: 2\n---\n\nAbout us.\n";
const HELD = "---\ntitle: Held\n---\n\nNot for visitors.\n";
const ROOT = "Work/site";

/** A site whose folder is `Work/site`: its row does the website's job, and nothing sits at `website/`. */
async function nested(): Promise<Fixture> {
  const f = await fixture();
  f.backend.seed(`${ROOT}/index.md`, HOME);
  f.backend.seed(`${ROOT}/about.md`, ABOUT);
  f.backend.seed(`${ROOT}/held.md`, HELD);
  f.backend.seed("Work/plans.md", "# Plans\n");
  await copyTree(f.t, f.workspaceId);
  const owner = asUser(f.t, f.owner);
  await owner.action(api.functions.files.setDirectoryVisibility, { workspaceId: f.workspaceId, path: ROOT, visibility: "team" });
  await owner.action(api.functions.files.setNoteVisibility, { workspaceId: f.workspaceId, path: `${ROOT}/held.md`, visibility: "private" });
  await copyTree(f.t, f.workspaceId);
  await f.t.run(async (ctx) => {
    const row = await ctx.db
      .query("nodes")
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", f.workspaceId).eq("path", ROOT))
      .unique();
    await ctx.db.patch(row!._id, { role: "website" });
    await ctx.db.insert("websiteStates", {
      workspaceId: f.workspaceId,
      state: "enabled",
      enabledAt: Date.now(),
      enabledBy: f.owner,
      publicationRuleEnsuredAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
  await owner.action(api.functions.websites.refreshRouteStatuses, { workspaceId: f.workspaceId });
  return f;
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

async function stale(f: Fixture): Promise<boolean> {
  const state = await f.t.run((ctx) =>
    ctx.db
      .query("websiteStates")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", f.workspaceId))
      .unique(),
  );
  return state!.routeGeneration !== state!.routeReconciledGeneration;
}

const open = (f: Fixture, routePath: string) =>
  f.t.action(api.functions.websites.resolvePage, { handle: "atlas", routePath });

describe("the website's name and its folder", () => {
  test("a page under website/ is the same page in the folder wherever it is", () => {
    expect(realSitePath(ROOT, "website/about.md")).toBe("Work/site/about.md");
    expect(realSitePath(ROOT, "website")).toBe(ROOT);
    expect(realSitePath(ROOT, "websites/x.md")).toBe("websites/x.md");
    expect(realSitePath("website", "website/about.md")).toBe("website/about.md");
    expect(siteNameOf(ROOT, "Work/site/blog/a.md")).toBe("website/blog/a.md");
    expect(siteNameOf(ROOT, "Work/sites/a.md")).toBeNull();
    expect(siteNameOf(ROOT, "Work/plans.md")).toBeNull();
  });
});

describe("a website nested in another folder", () => {
  test("publishes its pages at the addresses they always had", async () => {
    const f = await nested();
    expect(await indexedKeys(f)).toEqual(["website/about.md", "website/index.md"]);
    await expect(open(f, "/about")).resolves.toMatchObject({ kind: "page", title: "About", markdown: "About us.\n" });
    await expect(open(f, "/")).resolves.toMatchObject({ kind: "page", title: "Home" });
  }, 30_000);

  test("a page held back in the real folder is not on the site", async () => {
    const f = await nested();
    expect(await indexedKeys(f)).not.toContain("website/held.md");
    const held = await open(f, "/held");
    expect(JSON.stringify(held)).not.toContain("Not for visitors.");
  }, 30_000);

  test("the real folder made private takes every page off the site", async () => {
    const f = await nested();
    await asUser(f.t, f.owner).action(api.functions.files.setDirectoryVisibility, {
      workspaceId: f.workspaceId,
      path: ROOT,
      visibility: "private",
    });
    // The privacy change reached the site by its real name, and the rebuild leaves nothing.
    expect(await stale(f)).toBe(true);
    await asUser(f.t, f.owner).action(api.functions.websites.refreshRouteStatuses, { workspaceId: f.workspaceId });
    expect(await indexedKeys(f)).toEqual([]);
    const about = await open(f, "/about");
    expect(JSON.stringify(about)).not.toContain("About us.");
  }, 30_000);

  test("an edit in the real folder marks the site stale; one elsewhere does not", async () => {
    const f = await nested();
    expect(await stale(f)).toBe(false);
    await f.t.action(internal.functions.files.runFileOperation, {
      workspaceId: f.workspaceId,
      scope: "private",
      operation: { kind: "write", path: "Work/later.md", text: "# Later\n" },
    });
    expect(await stale(f)).toBe(false);
    await f.t.action(internal.functions.files.runFileOperation, {
      workspaceId: f.workspaceId,
      scope: "private",
      operation: { kind: "write", path: `${ROOT}/contact.md`, text: "---\ntitle: Contact\n---\n\nWrite to us.\n" },
    });
    expect(await stale(f)).toBe(true);
  }, 30_000);

  test("a reader at team scope sees a page by the site's name exactly as by its real name", async () => {
    const f = await nested();
    const read = (paths: string[]) =>
      f.t.action(internal.functions.files.runFileOperation, {
        workspaceId: f.workspaceId,
        scope: "team",
        grantedNames: [],
        operation: { kind: "readMany", paths },
      });
    const bySite = await read(["website/about.md", "website/held.md"]);
    const byReal = await read([`${ROOT}/about.md`, `${ROOT}/held.md`]);
    if (bySite.kind !== "notes" || byReal.kind !== "notes") throw new Error("not notes");
    expect(bySite.results.map((entry) => [entry.path, entry.outcome])).toEqual([
      ["website/about.md", byReal.results[0]!.outcome],
      ["website/held.md", byReal.results[1]!.outcome],
    ]);
    expect(byReal.results.map((entry) => entry.outcome)).toEqual(["read", "error"]);
  }, 30_000);

  test("the tree answers for a page by the site's name where the folder is", async () => {
    const f = await nested();
    const published = await f.t.query(internal.functions.nodeFacts.publishedRows, {
      workspaceId: f.workspaceId,
      paths: ["website/about.md", "website/held.md"],
    });
    expect(published?.map((row) => row.path)).toEqual(["website/about.md"]);
    const visible = await f.t.query(internal.functions.nodeFacts.visibleNotes, {
      workspaceId: f.workspaceId,
      paths: ["website/about.md", "website/held.md"],
      scope: "private",
      names: [],
    });
    expect(visible).toEqual(["website/about.md", "website/held.md"]);
  }, 30_000);

  test("a note version landing under the real folder marks the site stale, whoever wrote it", async () => {
    // What `noteIdsKeyed.recordKeyed` and `adoptKeyed` call for every keyed write: an AI client's, a live session's.
    const f = await nested();
    await f.t.run((ctx) => markNestedSiteWrite(ctx, f.workspaceId, "Work/plans.md"));
    expect(await stale(f)).toBe(false);
    await f.t.run((ctx) => markNestedSiteWrite(ctx, f.workspaceId, `${ROOT}/about.md`));
    expect(await stale(f)).toBe(true);
  }, 30_000);
});
