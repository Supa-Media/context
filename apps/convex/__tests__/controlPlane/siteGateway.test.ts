/**
 * `/gateway/site` — AN AGENT ON AN OWNER'S OR EDITOR'S CONNECTION CAN SEE
 * WHAT A WEBSITE WOULD PUBLISH, AND PUBLISH EXACTLY THAT.
 *
 * Decided by the owner, 2026-10-03: owners and editors may publish through
 * MCP. Editors could already press Publish in the app, so their agents get the
 * same right and no new access. What is proved here:
 *
 *  1. A member's, a stranger's and a forged token's call gets one bare `null`,
 *     and publishes nothing.
 *  2. Status names the draft (a fingerprint of what Publish would release),
 *     the published revision, the site's addresses and which pages changed.
 *  3. Publish releases the draft and answers with the new revision. Given the
 *     draft it was checked against, it refuses with a conflict when the folder
 *     changed since, and the site keeps what it had.
 *  4. A page with a problem is reported, and nothing is released.
 *  5. The audit trail records the person and the connection that published.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../../_generated/api";
import { addMember, createUser, gatewayPost } from "../fixtures.helpers";
import { fixture, publish } from "../website.helpers";
import { bodyOf, registerClient, seedConnectedClient, token } from "./fixtures.helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const OWNER_TEAM = token("site_owner_team");
const EDITOR = token("site_editor");
const MEMBER = token("site_member");
const STRANGER = token("site_stranger");
const CLIENT = "mcp_client_site";

async function siteFixture() {
  // Production's origin, the one deployment that also serves `ctxlc.site`.
  vi.stubEnv("APP_ORIGIN", "https://context.lc");
  const f = await fixture();
  const editor = await createUser(f.t, "atlas-editor@example.invalid");
  await addMember(f.t, f.workspaceId, editor, "editor", f.owner);
  f.backend.seed("website/index.md", "---\ntitle: Home\nnav: 1\n---\n\n# Welcome\n");
  f.backend.seed("website/about.md", "---\ntitle: About\nnav: 2\n---\n\nFirst words\n");
  await publish(f);

  await registerClient(f.t, CLIENT);
  const grant = (userId: typeof f.owner, accessToken: string, scopes: string[], workspaceId = f.workspaceId) =>
    seedConnectedClient(f.t, { workspaceId, userId, clientId: CLIENT, accessToken, scopes });
  await grant(f.owner, OWNER_TEAM, ["context:read", "context:write"]);
  await grant(editor, EDITOR, ["context:read", "context:write"]);
  await grant(f.member, MEMBER, ["context:read", "context:write"]);
  const elsewhere = await f.t.run(async (ctx) =>
    (await ctx.db.query("workspaces").collect()).find((w) => w.slug === "atlas-elsewhere")!._id,
  );
  await grant(f.stranger, STRANGER, ["context:read", "context:write", "context:private"], elsewhere);
  return { ...f, editor };
}

type Site = Record<string, unknown> & {
  draft: string;
  pages: Array<{ path: string; address: string | null; changed: boolean; problems: string[] }>;
};

async function site(f: Awaited<ReturnType<typeof siteFixture>>, accessToken: string, body: Record<string, unknown>) {
  const response = await gatewayPost(f.t, "/gateway/site", {
    accessToken,
    expectedWorkspaceId: f.workspaceId,
    ...body,
  });
  expect(response.status).toBe(200);
  return (await bodyOf(response)).site as Site | null;
}

const aboutText = (f: Awaited<ReturnType<typeof siteFixture>>) =>
  f.t
    .action(api.functions.websites.resolvePage, { handle: "atlas", routePath: "/about" })
    .then((page) => (page as { markdown?: string }).markdown);

describe("/gateway/site", () => {
  test("a member, a stranger and a forged token get the bare null, and nothing is published", async () => {
    const f = await siteFixture();
    f.backend.seed("website/about.md", "---\ntitle: About\nnav: 2\n---\n\nSecond words\n");
    for (const accessToken of [MEMBER, STRANGER, token("site_forged")]) {
      expect(await site(f, accessToken, { action: "status" })).toBeNull();
      expect(await site(f, accessToken, { action: "publish" })).toBeNull();
    }
    expect(await aboutText(f)).toBe("First words\n");
  });

  test("status names the draft, the published revision, the addresses and the changed pages", async () => {
    const f = await siteFixture();
    const before = await site(f, EDITOR, { action: "status" });
    expect(before).toMatchObject({ enabled: true, handle: "atlas" });
    expect(before!.addresses).toEqual(["https://context.lc/@atlas", "https://atlas.ctxlc.site"]);
    expect(before!.draft).toMatch(/^[0-9a-f]{16}$/);
    expect(before!.pages.filter((page) => page.changed)).toEqual([]);

    f.backend.seed("website/about.md", "---\ntitle: About\nnav: 2\n---\n\nSecond words\n");
    const after = await site(f, EDITOR, { action: "status" });
    expect(after!.draft).not.toBe(before!.draft);
    expect(after!.pages.filter((page) => page.changed).map((page) => page.path)).toEqual(["website/about.md"]);
    expect(after!.pages.find((page) => page.path === "website/about.md")!.address).toBe("/about");
    expect(after!.publishedRevision).toBe(before!.publishedRevision);
  });

  test("publish releases the draft it was checked against, and a stale draft is a conflict", async () => {
    const f = await siteFixture();
    f.backend.seed("website/about.md", "---\ntitle: About\nnav: 2\n---\n\nSecond words\n");
    const checked = await site(f, EDITOR, { action: "status" });

    // Somebody saves again after the agent looked: its publish must not
    // release words it never saw.
    f.backend.seed("website/about.md", "---\ntitle: About\nnav: 2\n---\n\nThird words\n");
    const stale = await site(f, EDITOR, { action: "publish", draft: checked!.draft });
    expect(stale).toMatchObject({ published: false, conflict: true });
    expect(stale!.draft).not.toBe(checked!.draft);
    expect(await aboutText(f)).toBe("First words\n");

    const fresh = await site(f, EDITOR, { action: "publish", draft: stale!.draft });
    expect(fresh).toMatchObject({ published: true, draft: stale!.draft, problems: [] });
    expect(typeof fresh!.revision).toBe("number");
    expect(fresh!.addresses).toContain("https://atlas.ctxlc.site");
    expect(await aboutText(f)).toBe("Third words\n");
    const status = await site(f, EDITOR, { action: "status" });
    expect(status!.publishedRevision).toBe(fresh!.revision);
    expect(status!.pages.filter((page) => page.changed)).toEqual([]);
  });

  test("a stylesheet saved after the check is part of the draft too", async () => {
    // A design note is drawn into every page, so a change to it is as much a
    // change to what Publish releases as a page's own words.
    const f = await siteFixture();
    f.backend.seed("website/site.css.md", "```css\nbody { color: red; }\n```\n");
    const checked = await site(f, EDITOR, { action: "status" });
    f.backend.seed("website/site.css.md", "```css\nbody { color: blue; }\n```\n");
    const stale = await site(f, EDITOR, { action: "publish", draft: checked!.draft });
    expect(stale).toMatchObject({ published: false, conflict: true });
  });

  test("an owner's team connection publishes without a draft, and the audit names person and connection", async () => {
    const f = await siteFixture();
    f.backend.seed("website/about.md", "---\ntitle: About\nnav: 2\n---\n\nSecond words\n");
    expect(await site(f, OWNER_TEAM, { action: "publish" })).toMatchObject({ published: true });
    expect(await aboutText(f)).toBe("Second words\n");

    await site(f, EDITOR, { action: "publish" });
    const events = await f.t.run((ctx) => ctx.db.query("auditEvents").collect());
    const published = events.filter((event) => event.action === "website.published");
    expect(published.map((event) => [event.actorUserId, event.actorClientId])).toEqual([
      [f.owner, CLIENT],
      [f.editor, CLIENT],
    ]);
  });

  test("a page with a problem is reported with its path, and nothing is released", async () => {
    const f = await siteFixture();
    f.backend.seed("website/about.md", "---\ntitle: About\nnav: 2\n---\n\nSecond words\n");
    f.backend.seed("website/broken.md", "---\ntitle: Broken\naudience: everyone\n---\n\nBroken\n");
    const status = await site(f, EDITOR, { action: "status" });
    expect(status!.pages.find((page) => page.path === "website/broken.md")!.problems.length).toBeGreaterThan(0);
    const result = await site(f, EDITOR, { action: "publish" });
    expect(result).toMatchObject({ published: false });
    expect((result!.problems as Array<{ path: string }>).map((problem) => problem.path)).toContain("website/broken.md");
    expect(await aboutText(f)).toBe("First words\n");
  });

  test("a site that is off says so, and publishing it is refused with the reason", async () => {
    const f = await siteFixture();
    await f.t.run(async (ctx) => {
      const row = await ctx.db
        .query("websiteStates")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", f.workspaceId))
        .unique();
      await ctx.db.patch(row!._id, { state: "disabled" });
    });
    expect(await site(f, EDITOR, { action: "status" })).toMatchObject({ enabled: false });
    expect(await site(f, EDITOR, { action: "publish" })).toMatchObject({
      published: false,
      message: expect.stringMatching(/turn the website on/i),
    });
  });

  test("an unknown action is refused rather than read as a status or a publish", async () => {
    const f = await siteFixture();
    const response = await gatewayPost(f.t, "/gateway/site", {
      accessToken: EDITOR,
      expectedWorkspaceId: f.workspaceId,
      action: "unpublish",
    });
    expect((await bodyOf(response)).site).toBeNull();
  });
});
