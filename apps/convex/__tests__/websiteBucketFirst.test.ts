/**
 * A website is served from its bucket. The route index is a derivative that
 * feeds the menu and catches clashes; it never decides that a page the bucket
 * holds does not exist. So a file written straight to the bucket (another
 * tool, a sync, a site whose index has not been built yet) is a page at once,
 * judged from its own bytes exactly as the index would judge it.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { asUser } from "./fixtures.helpers";
import { fixture, publish, type Fixture } from "./website.helpers";

afterEach(() => vi.unstubAllGlobals());

const resolve = (f: Fixture, routePath: string) =>
  f.t.action(api.functions.websites.resolvePage, { handle: "atlas", routePath });

const nothing = { kind: "unavailable", siteName: "Atlas Studio", navigation: [] };

async function neverIndexed(f: Fixture): Promise<void> {
  await f.t.run(async (ctx) => {
    const state = await ctx.db
      .query("websiteStates")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", f.workspaceId))
      .unique();
    await ctx.db.patch(state!._id, { routeReconciledGeneration: undefined });
  });
}

describe("pages come from the bucket", () => {
  test("a page written straight to the bucket is served before any rebuild", async () => {
    const f = await fixture();
    f.backend.seed("website/index.md", "---\ntitle: Home\nnav: 1\n---\n\nHome\n");
    await publish(f);
    f.backend.seed("website/notes.md", "---\ntitle: Notes\n---\n\nFresh from the bucket.\n");

    const page = await resolve(f, "/notes");
    expect(page).toMatchObject({ kind: "page", routePath: "/notes", title: "Notes" });
    expect(JSON.stringify(page)).toContain("Fresh from the bucket.");
  });

  test("a site whose index was never built still serves its pages, without a menu", async () => {
    const f = await fixture();
    f.backend.seed("website/index.md", "---\ntitle: Home\nnav: 1\n---\n\nHello\n");
    await publish(f);
    await neverIndexed(f);

    await expect(resolve(f, "/")).resolves.toMatchObject({
      kind: "page",
      title: "Home",
      navigation: [],
    });
  });

  test("a nested page resolves from either file form, and both at once is a clash", async () => {
    const f = await fixture();
    await publish(f);
    f.backend.seed("website/work/2026.md", "---\ntitle: This year\n---\n\nWork\n");
    await expect(resolve(f, "/work/2026")).resolves.toMatchObject({ kind: "page", title: "This year" });

    f.backend.seed("website/work/2026/index.md", "---\ntitle: Also this year\n---\n\nWork\n");
    await expect(resolve(f, "/work/2026")).resolves.toEqual(nothing);
  });

  test("a clash the built index found across the folder still stands", async () => {
    const f = await fixture();
    f.backend.seed("website/about.md", "---\ntitle: About\n---\n\nOne\n");
    f.backend.seed("website/About.md", "---\ntitle: About\n---\n\nTwo\n");
    await publish(f);

    await expect(resolve(f, "/about")).resolves.toEqual(nothing);
  });

  test("a members page found in the bucket still gates by membership", async () => {
    const f = await fixture();
    await publish(f);
    f.backend.seed("website/team.md", "---\ntitle: Team\naudience: members\n---\n\nPrivate body\n");

    const anonymous = await resolve(f, "/team");
    expect(anonymous).toMatchObject({ kind: "authentication_required" });
    expect(JSON.stringify(anonymous)).not.toContain("Private body");
    const stranger = await asUser(f.t, f.stranger).action(api.functions.websites.resolvePage, {
      handle: "atlas",
      routePath: "/team",
    });
    expect(stranger).toEqual(nothing);
    await expect(
      asUser(f.t, f.member).action(api.functions.websites.resolvePage, { handle: "atlas", routePath: "/team" }),
    ).resolves.toMatchObject({ kind: "page", title: "Team" });
  });

  test("a draft, a broken file and a private note outside the folder are not served", async () => {
    const f = await fixture();
    await publish(f);
    f.backend.seed("website/draft.md", "---\ntitle: Draft\ndraft: true\n---\n\nDraft\n");
    f.backend.seed("website/broken.md", "---\ntitle: Broken\naudience: everyone\n---\n\nBroken\n");
    f.backend.seed("website/untitled.md", "No title here\n");
    f.backend.seed("2-areas/diary.md", "---\ntitle: Diary\n---\n\nSecret\n");

    for (const routePath of ["/draft", "/broken", "/untitled", "/2-areas/diary"]) {
      await expect(resolve(f, routePath)).resolves.toEqual(nothing);
    }
  });

  test("finding an unindexed page queues the rebuild that adds it to the menu", async () => {
    const f = await fixture();
    await publish(f);
    f.backend.seed("website/notes.md", "---\ntitle: Notes\nnav: 1\n---\n\nNotes\n");
    await resolve(f, "/notes");

    const state = await f.t.run((ctx) =>
      ctx.db
        .query("websiteStates")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", f.workspaceId))
        .unique(),
    );
    expect(state?.routeGeneration).not.toBe(state?.routeReconciledGeneration);
  });
});
