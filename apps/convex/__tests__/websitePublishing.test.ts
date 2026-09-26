/**
 * Edits wait for Publish (decided by the owner, 2026-09-26). A file saved or
 * written straight to the bucket under `website/` changes the note and
 * nothing a visitor sees; pressing Publish makes it the site. Before a site's
 * first scan there is nothing published to keep, so its pages are judged from
 * their own bytes, as they always were.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { asUser } from "./fixtures.helpers";
import { fixture, pressPublish, publish, type Fixture } from "./website.helpers";

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

describe("pages wait for Publish", () => {
  test("a new page is not on the site until someone presses Publish", async () => {
    const f = await fixture();
    f.backend.seed("website/index.md", "---\ntitle: Home\nnav: 1\n---\n\nHome\n");
    await publish(f);
    f.backend.seed("website/notes.md", "---\ntitle: Notes\nnav: 2\n---\n\nFresh from the bucket.\n");

    const before = await resolve(f, "/notes");
    expect(before).toMatchObject({ kind: "unavailable" });
    expect(JSON.stringify(before)).not.toContain("Fresh from the bucket.");

    await expect(pressPublish(f)).resolves.toEqual({ published: true, problems: [] });
    const page = await resolve(f, "/notes");
    expect(page).toMatchObject({ kind: "page", routePath: "/notes", title: "Notes" });
    expect(JSON.stringify(page)).toContain("Fresh from the bucket.");
    expect((page as { navigation: unknown[] }).navigation).toHaveLength(2);
  });

  test("an edit to a published page serves the published words until Publish", async () => {
    const f = await fixture();
    f.backend.seed("website/index.md", "---\ntitle: Home\n---\n\nPublished words\n");
    await publish(f);
    f.backend.seed("website/index.md", "---\ntitle: Home again\n---\n\nHalf-typed words\n");

    const before = JSON.stringify(await resolve(f, "/"));
    expect(before).toContain("Published words");
    expect(before).not.toContain("Half-typed words");
    expect(before).not.toContain("Home again");

    await pressPublish(f);
    const after = JSON.stringify(await resolve(f, "/"));
    expect(after).toContain("Half-typed words");
    expect(after).toContain("Home again");
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

  test("a nested page publishes from either file form, and both at once is a clash", async () => {
    const f = await fixture();
    await publish(f);
    f.backend.seed("website/work/2026.md", "---\ntitle: This year\n---\n\nWork\n");
    await pressPublish(f);
    await expect(resolve(f, "/work/2026")).resolves.toMatchObject({ kind: "page", title: "This year" });

    f.backend.seed("website/work/2026/index.md", "---\ntitle: Also this year\n---\n\nWork\n");
    const refused = await pressPublish(f);
    expect(refused.published).toBe(false);
    expect(refused.problems.map((problem) => problem.path).sort()).toEqual([
      "website/work/2026.md",
      "website/work/2026/index.md",
    ]);
    // The clash publishes nothing; what was published stands.
    await expect(resolve(f, "/work/2026")).resolves.toMatchObject({ kind: "page", title: "This year" });
  });

  test("a clash the built index found across the folder still stands", async () => {
    const f = await fixture();
    f.backend.seed("website/about.md", "---\ntitle: About\n---\n\nOne\n");
    f.backend.seed("website/About.md", "---\ntitle: About\n---\n\nTwo\n");
    await publish(f);

    await expect(resolve(f, "/about")).resolves.toEqual(nothing);
  });

  test("a published members page still gates by membership", async () => {
    const f = await fixture();
    await publish(f);
    f.backend.seed("website/team.md", "---\ntitle: Team\naudience: members\n---\n\nPrivate body\n");
    await pressPublish(f);

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

  test("a draft and a private note outside the folder are not served after Publish", async () => {
    const f = await fixture();
    await publish(f);
    f.backend.seed("website/draft.md", "---\ntitle: Draft\ndraft: true\n---\n\nDraft\n");
    f.backend.seed("2-areas/diary.md", "---\ntitle: Diary\n---\n\nSecret\n");
    await pressPublish(f);

    for (const routePath of ["/draft", "/2-areas/diary"]) {
      await expect(resolve(f, routePath)).resolves.toEqual(nothing);
    }
  });

  test("a broken page stops Publish and says which one", async () => {
    const f = await fixture();
    await publish(f);
    f.backend.seed("website/broken.md", "---\ntitle: Broken\naudience: everyone\n---\n\nBroken\n");
    f.backend.seed("website/untitled.md", "No title here\n");

    const result = await pressPublish(f);
    expect(result.published).toBe(false);
    expect(result.problems.map((problem) => problem.path)).toEqual(["website/broken.md"]);
    for (const routePath of ["/broken", "/untitled"]) {
      await expect(resolve(f, routePath)).resolves.toMatchObject({ kind: "unavailable" });
    }

    // A page with no title is not broken: it is titled by its file name.
    f.backend.objects.delete("website/broken.md");
    await expect(pressPublish(f)).resolves.toEqual({ published: true, problems: [] });
    await expect(resolve(f, "/untitled")).resolves.toMatchObject({ kind: "page", title: "untitled" });
  });

  test("a member cannot publish; an editor can", async () => {
    const f = await fixture();
    await publish(f);
    f.backend.seed("website/notes.md", "---\ntitle: Notes\n---\n\nNotes\n");
    await expect(pressPublish(f, f.member)).rejects.toThrow();
    await expect(pressPublish(f, f.stranger)).rejects.toThrow();
    await expect(resolve(f, "/notes")).resolves.toMatchObject({ kind: "unavailable" });

    await f.t.run(async (ctx) => {
      const membership = await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace_user", (q) => q.eq("workspaceId", f.workspaceId).eq("userId", f.member))
        .unique();
      await ctx.db.patch(membership!._id, { role: "editor" });
    });
    await expect(pressPublish(f, f.member)).resolves.toEqual({ published: true, problems: [] });
    await expect(resolve(f, "/notes")).resolves.toMatchObject({ kind: "page", title: "Notes" });
  });

  test("a site that is off cannot be published", async () => {
    const f = await fixture();
    await publish(f);
    await asUser(f.t, f.owner).mutation(api.functions.workspaces.disableWebsite, {
      workspaceId: f.workspaceId,
    });
    await expect(pressPublish(f)).rejects.toThrow(/Turn the website on/);
  });
});
