/**
 * A website's existence, publish-state and front matter come from the tree,
 * never from opening a note (Dev2, 2026-10-14: names, existence and front
 * matter come from the tree; storage is read only to open a note's body). A
 * page the tree says is a draft is not opened at all, and the answer is the
 * same one the bucket read gave.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { asUser, readIntoTree } from "./fixtures.helpers";
import { bodyKeyOf, fixture, publish, readNoteText, type Fixture, writeNote } from "./website.helpers";

// Each test keys a workspace and runs its tree to the end, which takes longer than the default five seconds.
vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => vi.stubEnv("HOME_SITE_HANDLE", "atlas"));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** A site whose route index was never built: no scan has landed, so pages are read from their files. */
async function neverIndexed(f: Fixture): Promise<void> {
  await f.t.run(async (ctx) => {
    const state = await ctx.db
      .query("websiteStates")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", f.workspaceId))
      .unique();
    await ctx.db.patch(state!._id, { routeReconciledGeneration: undefined });
  });
}

const HOME = "---\ntitle: Home\nnav: 1\n---\n\nHome\n";
const ABOUT = "---\ntitle: About\nnav: 2\n---\n\nAbout words\n";
const DRAFT_LINE = "---\ntitle: Held\ndraft\n---\n\nHeld words\n";

const requestsFor = (f: Fixture, key: string) =>
  f.backend.requests.filter((request) => request.method === "GET" && request.key === key);

const resolve = (f: Fixture, routePath: string) =>
  f.t.action(api.functions.websites.resolvePage, { handle: "atlas", routePath });

describe("website existence and publish state come from the tree", () => {
  test("the homepage snapshot drops a page gone draft without opening it", async () => {
    const f = await fixture();
    f.backend.seed("website/index.md", HOME);
    f.backend.seed("website/about.md", ABOUT);
    await publish(f);
    await writeNote(f, "website/about.md", DRAFT_LINE);
    await readIntoTree(f.t, f.workspaceId);
    f.backend.requests.length = 0;

    const snapshot = await f.t.action(api.functions.websites.siteSnapshot, { handle: "atlas" });
    expect(snapshot?.pages.map((page) => page.routePath)).toEqual(["/"]);
    expect(requestsFor(f, await bodyKeyOf(f.t, f.workspaceId, "website/about.md"))).toEqual([]);
  }, 60_000);

  test("a page the tree says is a draft is not served, and its bytes are not opened", async () => {
    const f = await fixture();
    f.backend.seed("website/index.md", HOME);
    await publish(f);
    await neverIndexed(f);
    await writeNote(f, "website/fresh.md", DRAFT_LINE);
    await readIntoTree(f.t, f.workspaceId);
    f.backend.requests.length = 0;

    expect((await resolve(f, "/fresh")).kind).toBe("unavailable");
    expect(requestsFor(f, await bodyKeyOf(f.t, f.workspaceId, "website/fresh.md"))).toEqual([]);
  });

  test("a live page the index has not caught up with is still served from its bytes", async () => {
    const f = await fixture();
    f.backend.seed("website/index.md", HOME);
    await publish(f);
    await neverIndexed(f);
    await writeNote(f, "website/fresh.md", "---\ntitle: Fresh\n---\n\nFresh words\n");
    await readIntoTree(f.t, f.workspaceId);

    const page = await resolve(f, "/fresh");
    expect(page).toMatchObject({ kind: "page", markdown: "Fresh words\n" });
  });

  test("a stylesheet the tree says is a draft is not drawn, and its bytes are not opened", async () => {
    const f = await fixture();
    f.backend.seed("website/index.md", HOME);
    f.backend.seed("website/styles.css.md", "---\ntitle: Styles\n---\n\n```css\n:root { --accent: #FFD23F; }\n```\n");
    await publish(f);
    await writeNote(f, "website/styles.css.md", "---\ntitle: Styles\ndraft\n---\n\n```css\n:root { --accent: #FFD23F; }\n```\n");
    await readIntoTree(f.t, f.workspaceId);
    f.backend.requests.length = 0;

    const page = await resolve(f, "/");
    if (page.kind !== "page") throw new Error("expected a page");
    expect(page.design?.css ?? "").not.toContain("--accent");
    expect(requestsFor(f, await bodyKeyOf(f.t, f.workspaceId, "website/styles.css.md"))).toEqual([]);
  });

  test("enabling a site whose homepage exists reads no homepage bytes", async () => {
    const f = await fixture();
    const existing = "---\ntitle: Kept\n---\n\n# Do not replace me\n";
    f.backend.seed("website/index.md", existing);
    await readIntoTree(f.t, f.workspaceId);
    f.backend.requests.length = 0;

    const enabled = await asUser(f.t, f.owner).action(api.functions.workspaces.enableWebsite, {
      workspaceId: f.workspaceId,
    });
    expect(enabled).toMatchObject({ state: "enabled", starter: "existing" });
    expect(requestsFor(f, await bodyKeyOf(f.t, f.workspaceId, "website/index.md"))).toEqual([]);
    await expect(readNoteText(f, "website/index.md")).resolves.toBe(existing);
  });
});
