/**
 * `/site/home` and `websites.siteSnapshot`: the homepage's `website/` folder in
 * one answer, drawn as its sidebar.
 *
 * The sidebar is the folder, exactly: every note the site publishes is a page,
 * with or without a title or a `nav:` line, in its folder. What it may say is
 * still only what the site publishes: the folder is read at the publication
 * clearance, so a `privacy.md`-private note is absent, and drafts,
 * members-only and encrypted notes are dropped. It answers for the homepage's
 * own workspace only, so no other site's unlisted pages become enumerable; a
 * signed-in member is answered as anybody; a site that is off is one null.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { pageTitle, routePathFor } from "../functions/lib/websites/snapshot";
import { asUser } from "./fixtures.helpers";
import { fixture, publish, type Fixture } from "./website.helpers";

beforeEach(() => vi.stubEnv("HOME_SITE_HANDLE", "atlas"));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

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
  f.backend.seed("website/unlisted.md", "# Unlisted page\n\nNot in the menu.\n");
  f.backend.seed("website/untitled-2026-09-26.md", "");
  f.backend.seed("notes/elsewhere.md", "---\ntitle: Elsewhere\nnav: 0\n---\n\nNot the site.\n");
  await publish(f);
  await asUser(f.t, f.owner).action(api.functions.files.setNoteVisibility, {
    workspaceId: f.workspaceId,
    path: "website/secret.md",
    visibility: "private",
  });
  return f;
}

async function ask(f: Fixture, body: unknown, as?: Fixture["owner"]) {
  const init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  return as === undefined ? await f.t.fetch("/site/home", init) : await asUser(f.t, as).fetch("/site/home", init);
}

type Answer = {
  siteName: string;
  revision: string | null;
  pages: Array<{ path: string; routePath: string; title: string; markdown: string }>;
};

describe("the homepage's site is its website/ folder", () => {
  test("every published note, nav'd ones first in order, then the rest by path", async () => {
    const f = await site();
    const body = (await (await ask(f, { handle: "atlas" })).json()) as Answer;
    expect(body.siteName).toBe("Atlas Studio");
    expect(body.revision).toEqual(expect.any(String));
    expect(body.pages.map((page) => [page.path, page.routePath, page.title])).toEqual([
      ["index.md", "/", "Welcome"],
      ["writing.md", "/writing", "Writing"],
      ["Legal/privacy.md", "/Legal/privacy", "Privacy"],
      ["unlisted.md", "/unlisted", "Unlisted page"],
      ["untitled-2026-09-26.md", "/untitled-2026-09-26", "untitled-2026-09-26"],
    ]);
    expect(body.pages[1]!.markdown).toContain("Essays.");
  });

  test("private, members-only and draft notes, and notes outside website/, never leave", async () => {
    const f = await site();
    const text = await (await ask(f, { handle: "atlas" })).text();
    for (const absent of [SECRET, "The team.", "Not yet.", "Not the site.", "secret.md"]) {
      expect(text).not.toContain(absent);
    }
  });

  test("a member asking is answered as anybody", async () => {
    const f = await site();
    expect(await (await ask(f, { handle: "atlas" }, f.member)).text()).toBe(
      await (await ask(f, { handle: "atlas" })).text(),
    );
  });

  test("another site, off, nobody's and malformed are one answer", async () => {
    const f = await site();
    const answers = new Set<string>();
    vi.stubEnv("HOME_SITE_HANDLE", "someone-else");
    answers.add(await (await ask(f, { handle: "atlas" })).text());
    vi.stubEnv("HOME_SITE_HANDLE", "atlas");
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

describe("the copy the router keeps until the next Publish", () => {
  async function revisionOf(f: Fixture, handle = "atlas") {
    const response = await f.t.fetch("/site/home/revision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle }),
    });
    return ((await response.json()) as { revision: string | null }).revision;
  }

  test("a save leaves the answer and its revision alone; Publish moves both", async () => {
    const f = await site();
    const before = await revisionOf(f);
    expect(before).toEqual(expect.any(String));
    expect(await revisionOf(f, "atlas-elsewhere")).toBeNull();

    f.backend.seed("website/writing.md", "---\ntitle: Writing\nnav: 1\n---\n\nHalf a new essay.\n");
    f.backend.seed("website/brand-new.md", "# Brand new\n\nNot published yet.\n");
    await f.t.mutation(internal.functions.websites.recordRouteChange, { workspaceId: f.workspaceId });
    const saved = (await (await ask(f, { handle: "atlas" })).json()) as Answer;
    expect(JSON.stringify(saved)).toContain("Essays.");
    expect(JSON.stringify(saved)).not.toContain("Half a new essay.");
    expect(JSON.stringify(saved)).not.toContain("Brand new");
    expect(await revisionOf(f)).toBe(before);

    await asUser(f.t, f.owner).action(api.functions.websites.publish, { workspaceId: f.workspaceId });
    const published = (await (await ask(f, { handle: "atlas" })).json()) as Answer;
    expect(JSON.stringify(published)).toContain("Half a new essay.");
    expect(published.pages.map((page) => page.path)).toContain("brand-new.md");
    const after = await revisionOf(f);
    expect(after).not.toBe(before);
    expect(published.revision).toBe(after);
  });

  test("a published page made private leaves the answer without a Publish", async () => {
    const f = await site();
    await asUser(f.t, f.owner).action(api.functions.files.setNoteVisibility, {
      workspaceId: f.workspaceId,
      path: "website/writing.md",
      visibility: "private",
    });
    const body = (await (await ask(f, { handle: "atlas" })).json()) as Answer;
    expect(body.pages.map((page) => page.path)).not.toContain("writing.md");
  });
});

describe("names and addresses", () => {
  test("index is its folder's address", () => {
    expect(routePathFor("index.md")).toBe("/");
    expect(routePathFor("Legal/index.md")).toBe("/Legal");
    expect(routePathFor("Legal/terms.md")).toBe("/Legal/terms");
  });

  test("a title, else the first heading, else the file's name", () => {
    expect(pageTitle("a.md", "Given", "# Heading")).toBe("Given");
    expect(pageTitle("a.md", null, "Intro\n\n# Heading #\n")).toBe("Heading");
    expect(pageTitle("f/untitled.md", null, "")).toBe("untitled");
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
    const body = source.slice(
      source.indexOf("export async function siteHomeHandler"),
      source.indexOf("export async function siteHomeRevisionHandler"),
    );
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
