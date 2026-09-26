/**
 * `/site/home` and `websites.siteSnapshot`: the homepage's whole site in one
 * answer, drawn as its sidebar.
 *
 * What it may say is what the site's menu already shows an anonymous visitor,
 * page by page: public live pages with a `nav:` number, in that order, read at
 * the publication clearance. So these hold: members-only, draft, unlisted and
 * `privacy.md`-private pages are absent even with a `nav:` line; a signed-in
 * member is answered as the anonymous visitor; a site that is off, or has no
 * public home page, is one null shape.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { asUser } from "./fixtures.helpers";
import { fixture, publish, type Fixture } from "./website.helpers";

afterEach(() => vi.unstubAllGlobals());

const SECRET = "Only the owner should ever read this.";
const NULL_ANSWER = JSON.stringify({ siteName: null, revision: null, pages: null });

async function site(): Promise<Fixture> {
  const f = await fixture();
  f.backend.seed("website/index.md", "---\ntitle: Welcome\nnav: 0\n---\n\n# Welcome\n");
  f.backend.seed("website/writing.md", "---\ntitle: Writing\nnav: 1\n---\n\nEssays.\n");
  f.backend.seed("website/team.md", "---\ntitle: Team\nnav: 2\naudience: members\n---\n\nThe team.\n");
  f.backend.seed("website/soon.md", "---\ntitle: Soon\nnav: 3\ndraft: true\n---\n\nNot yet.\n");
  f.backend.seed("website/secret.md", `---\ntitle: Secret\nnav: 4\n---\n\n${SECRET}\n`);
  f.backend.seed("website/Legal/privacy.md", "---\ntitle: Privacy\nnav: 5\n---\n\nWe keep little.\n");
  f.backend.seed("website/unlisted.md", "---\ntitle: Unlisted\n---\n\nNot in the menu.\n");
  await publish(f);
  await asUser(f.t, f.owner).action(api.functions.files.setNoteVisibility, {
    workspaceId: f.workspaceId,
    path: "website/secret.md",
    visibility: "private",
  });
  await asUser(f.t, f.owner).action(api.functions.websites.refreshRouteStatuses, {
    workspaceId: f.workspaceId,
  });
  return f;
}

async function ask(f: Fixture, body: unknown, as?: Fixture["owner"]) {
  const init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  return as === undefined ? await f.t.fetch("/site/home", init) : await asUser(f.t, as).fetch("/site/home", init);
}

describe("the homepage's site", () => {
  test("is the menu's public pages, in menu order, folders kept in their paths", async () => {
    const f = await site();
    const body = (await (await ask(f, { handle: "atlas" })).json()) as {
      siteName: string;
      revision: string | null;
      pages: Array<{ routePath: string; title: string; markdown: string }>;
    };
    expect(body.siteName).toBe("Atlas Studio");
    expect(body.revision).toEqual(expect.any(String));
    expect(body.pages.map((page) => [page.routePath, page.title])).toEqual([
      ["/", "Welcome"],
      ["/writing", "Writing"],
      ["/Legal/privacy", "Privacy"],
    ]);
    expect(body.pages[1]!.markdown).toContain("Essays.");
  });

  test("a private note under website/ never leaves, whatever its nav line says", async () => {
    const f = await site();
    const text = await (await ask(f, { handle: "atlas" })).text();
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("The team.");
    expect(text).not.toContain("Not yet.");
    expect(text).not.toContain("Not in the menu.");
  });

  test("a member asking is answered as the anonymous visitor", async () => {
    const f = await site();
    const text = await (await ask(f, { handle: "atlas" }, f.member)).text();
    expect(text).not.toContain("The team.");
    expect(text).toBe(await (await ask(f, { handle: "atlas" })).text());
  });

  test("off, nobody's, and malformed are one answer", async () => {
    const f = await site();
    const answers = new Set<string>();
    for (const body of [{ handle: "no-such-handle" }, {}, "not json"]) {
      answers.add(await (await ask(f, body)).text());
    }
    await f.t.run(async (ctx) => {
      const row = await ctx.db
        .query("websiteStates")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", f.workspaceId))
        .unique();
      await ctx.db.patch(row!._id, { state: "disabled" });
    });
    answers.add(await (await ask(f, { handle: "atlas" })).text());
    expect([...answers]).toEqual([NULL_ANSWER]);
  });

  test("the app's action says the same as the route", async () => {
    const f = await site();
    const snapshot = await f.t.action(api.functions.websites.siteSnapshot, { handle: "atlas" });
    const routed = (await (await ask(f, { handle: "atlas" })).json()) as { pages: unknown };
    expect(snapshot?.pages).toEqual(routed.pages);
  });
});

describe("the route's shape", () => {
  /**
   * Three fields on every return, and a page is named field by field: a spread
   * would let something added upstream (the workspace, the object key, the
   * audience) reach the internet without anybody deciding it should.
   */
  test("names its fields and nothing else", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../functions/lib/publicRoutes/siteHome.ts", import.meta.url)),
      "utf8",
    );
    const body = source.slice(source.indexOf("export async function siteHomeHandler"));
    const literals = [...body.matchAll(/json\(\{([^{}]*)\}\)/g)].map(([, literal]) =>
      [...literal!.matchAll(/([a-zA-Z_$][\w$]*)\s*:/g)].map((m) => m[1]).sort(),
    );
    expect(literals).toEqual([
      ["pages", "revision", "siteName"],
      ["pages", "revision", "siteName"],
    ]);
    expect(body).not.toMatch(/\.\.\./);
    for (const forbidden of ["workspaceId", "objectKey", "audience", "navigation"]) {
      expect(body).not.toContain(forbidden);
    }
  });
});
