/**
 * `/site/revision` and `/site/page`: what the router keeps at the edge so a
 * site's page is read from the bucket once per Publish, not once per visit.
 *
 * The copy is handed to anyone, so it is answered as an anonymous visitor
 * whatever credentials arrive; a members-only page is only ever "sign in".
 * The revision holds still across a save and moves on Publish, which is what
 * makes a copy per revision correct. "Unavailable" is never kept, because a
 * bucket that did not answer looks exactly like it.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { asUser } from "./fixtures.helpers";
import { fixture, pressPublish, publish, type Fixture } from "./website.helpers";

afterEach(() => vi.unstubAllGlobals());

const MEMBERS_ONLY = "Only members read this.";

async function site(): Promise<Fixture> {
  const f = await fixture();
  f.backend.seed("website/index.md", "---\ntitle: Home\nnav: 1\n---\n\nPublished words\n");
  f.backend.seed("website/team.md", `---\ntitle: Team\naudience: members\n---\n\n${MEMBERS_ONLY}\n`);
  await publish(f);
  return f;
}

async function post(f: Fixture, path: string, body: unknown, as?: Fixture["owner"]): Promise<Response> {
  const init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  return as === undefined ? await f.t.fetch(path, init) : await asUser(f.t, as).fetch(path, init);
}

type Answer = { revision: string | null; cacheable: boolean; address: Record<string, unknown> };
const page = async (f: Fixture, body: unknown, as?: Fixture["owner"]) =>
  (await (await post(f, "/site/page", body, as)).json()) as Answer;
const revision = async (f: Fixture, handle: string) =>
  ((await (await post(f, "/site/revision", { handle })).json()) as { revision: string | null }).revision;

describe("/site/page", () => {
  test("a published page, with the revision it belongs to and exactly the named fields", async () => {
    const f = await site();
    const answer = await page(f, { handle: "atlas", routePath: "/" });
    expect(Object.keys(answer).sort()).toEqual(["address", "cacheable", "revision"]);
    expect(answer.revision).toBe(await revision(f, "atlas"));
    expect(answer.cacheable).toBe(true);
    expect(Object.keys(answer.address).sort()).toEqual(
      ["audience", "description", "kind", "markdown", "navigation", "routePath", "siteName", "title"],
    );
    expect(answer.address).toMatchObject({ kind: "page", title: "Home", siteName: "Atlas Studio" });
    expect(answer.address.markdown).toContain("Published words");
    expect(answer.address.navigation).toEqual([{ title: "Home", routePath: "/" }]);
  });

  test("a member is answered as anybody, so a kept copy never holds a members-only page", async () => {
    const f = await site();
    const answer = await page(f, { handle: "atlas", routePath: "/team" }, f.owner);
    expect(answer.address.kind).toBe("authentication_required");
    expect(JSON.stringify(answer)).not.toContain(MEMBERS_ONLY);
  });

  test("an unavailable answer is never kept, and a malformed ask is one of them", async () => {
    const f = await site();
    expect(await page(f, { handle: "atlas", routePath: "/nowhere" })).toMatchObject({
      cacheable: false,
      address: { kind: "unavailable" },
    });
    expect(await page(f, { handle: "atlas" })).toEqual({
      revision: null,
      cacheable: false,
      address: { kind: "unavailable", siteName: null, navigation: [] },
    });
    expect(await page(f, { handle: "nobody", routePath: "/" })).toMatchObject({ revision: null, cacheable: false });
  });

  test("the page keeps its published words across a save, under the same revision", async () => {
    const f = await site();
    const before = await page(f, { handle: "atlas", routePath: "/" });
    f.backend.seed("website/index.md", "---\ntitle: Home\nnav: 1\n---\n\nHalf-typed words\n");
    const after = await page(f, { handle: "atlas", routePath: "/" });
    expect(after.revision).toBe(before.revision);
    expect(after.address.markdown).toContain("Published words");
  });
});

describe("/site/revision", () => {
  test("answers for any site, moves on Publish, and is null for a handle with no site", async () => {
    const f = await site();
    const first = await revision(f, "atlas");
    expect(first).toEqual(expect.any(String));
    f.backend.seed("website/index.md", "---\ntitle: Home\nnav: 1\n---\n\nNew words\n");
    expect(await revision(f, "atlas")).toBe(first);
    await pressPublish(f);
    const second = await revision(f, "atlas");
    expect(second).not.toBe(first);
    expect((await page(f, { handle: "atlas", routePath: "/" })).address.markdown).toContain("New words");
    expect(await revision(f, "nobody")).toBeNull();
    expect(await revision(f, "")).toBeNull();
  });
});

test("nothing is kept while a restriction is pending", async () => {
  const f = await site();
  await f.t.run(async (ctx) => {
    const state = await ctx.db
      .query("websiteStates")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", f.workspaceId))
      .unique();
    await ctx.db.patch(state!._id, {
      routeGeneration: (state!.routeGeneration ?? 0) + 1,
      routeUnsafeGeneration: (state!.routeGeneration ?? 0) + 1,
    });
  });
  const answer = await page(f, { handle: "atlas", routePath: "/" });
  expect(answer.revision).toMatch(/:pending$/);
  expect(answer.cacheable).toBe(false);
});
