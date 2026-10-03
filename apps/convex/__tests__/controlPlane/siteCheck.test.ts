/**
 * `/gateway/site` `check` — WHAT AN AGENT NEEDS TO KNOW BEFORE IT PUBLISHES,
 * WITHOUT A BROWSER.
 *
 * Asked for by an agent that built a site through MCP and could not tell why
 * its larger layout drew an empty page, or that `/index` went nowhere. What is
 * proved here:
 *
 *  1. Only an owner's or editor's connection is answered; everyone else gets
 *     the one bare `null`.
 *  2. The route map names every address and the file behind it.
 *  3. A link that goes nowhere is reported with its note and line, from a
 *     page and from a layout, with the nearest real address; a link to a
 *     draft says so; a working link, an external one and an alias are quiet.
 *  4. Every picture the site draws is listed with its size and the files that
 *     use it; a missing, oversized, remote or foldered one says why.
 *  5. What the cleaner removes from a layout is reported line by line, and a
 *     `{ content }` it removes is called out as an empty site.
 *  6. Given a code note's path, the check hands back what the site draws.
 *  7. Nothing is published by a check.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../../_generated/api";
import { MAX_PUBLISHED_IMAGE_BYTES } from "../../functions/lib/websites/images";
import { addMember, createUser, gatewayPost } from "../fixtures.helpers";
import { fixture, publish } from "../website.helpers";
import { bodyOf, registerClient, seedConnectedClient, token } from "./fixtures.helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const EDITOR = token("check_editor");
const MEMBER = token("check_member");
const CLIENT = "mcp_client_check";
const IMAGES = ".context/assets/images/";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);

const LAYOUT = [
  "# The frame",
  "",
  "```html",
  '<header><a href="/index"><img src="logo.png" alt="SB"></a>',
  '<a href="/abuot">About</a> <a href="work">Work</a> <a href="/about#team">Team</a></header>',
  '<template><main>{ content }</main></template>',
  '<div onclick="go()">x</div>',
  "```",
  "",
].join("\n");

async function checkFixture() {
  vi.stubEnv("APP_ORIGIN", "https://context.lc");
  const f = await fixture();
  const editor = await createUser(f.t, "check-editor@example.invalid");
  await addMember(f.t, f.workspaceId, editor, "editor", f.owner);
  f.backend.seed(`${IMAGES}logo.png`, PNG);
  f.backend.seed(`${IMAGES}hero.png`, new Uint8Array(MAX_PUBLISHED_IMAGE_BYTES + 1));
  f.backend.seed("website/index.md", "---\ntitle: Home\nnav: 1\n---\n\n# Welcome\n\n![[hero.png]]\n");
  f.backend.seed(
    "website/about.md",
    [
      "---\ntitle: About\nnav: 2\n---\n",
      "See [home](/), [the index](/index), [contact](contact.md) and [news](/newz).",
      "Also [elsewhere](https://example.test/x) and ![remote](https://cdn.test/a.png) and ![[gone.png]].",
      "",
    ].join("\n"),
  );
  f.backend.seed("website/news.md", "---\ntitle: News\n---\n\nNews\n");
  f.backend.seed("website/contact.md", "---\ntitle: Contact\ndraft: true\n---\n\nSoon\n");
  f.backend.seed("website/blank.md", "---\ntitle: Blank\n---\n\n<!-- nothing yet -->\n");
  f.backend.seed("website/layout.html.md", LAYOUT);
  f.backend.seed("website/site.css.md", "```css\n.a { color: red; } @font-face { font-family: X; }\n.b { background: url(images/x.png); }\n```\n");
  await publish(f);
  await registerClient(f.t, CLIENT);
  await seedConnectedClient(f.t, { workspaceId: f.workspaceId, userId: editor, clientId: CLIENT, accessToken: EDITOR, scopes: ["context:read", "context:write"] });
  await seedConnectedClient(f.t, { workspaceId: f.workspaceId, userId: f.member, clientId: CLIENT, accessToken: MEMBER, scopes: ["context:read", "context:write"] });
  return f;
}

type Check = {
  routes: Array<{ address: string; path: string; status: string }>;
  links: Array<{ path: string; line: number; target: string; problem: string }>;
  pictures: Array<{ name: string; bytes: number | null; usedBy: string[]; labels: string[]; problem: string | null }>;
  code: Array<{ path: string; removed: Array<{ line: number | null; what: string; why: string }> }>;
  warnings: Array<{ path: string; why: string }>;
  inspected: { path: string; output: string } | null;
  draft: string;
};

async function check(f: Awaited<ReturnType<typeof checkFixture>>, accessToken: string, path?: string) {
  const response = await gatewayPost(f.t, "/gateway/site", {
    accessToken,
    expectedWorkspaceId: f.workspaceId,
    action: "check",
    ...(path === undefined ? {} : { path }),
  });
  expect(response.status).toBe(200);
  return (await bodyOf(response)).site as Check | null;
}

describe("/gateway/site check", () => {
  test("a member's connection gets the bare null", async () => {
    const f = await checkFixture();
    expect(await check(f, MEMBER)).toBeNull();
  });

  test("the route map names every address and the file behind it", async () => {
    const f = await checkFixture();
    const result = (await check(f, EDITOR))!;
    expect(result.draft).toMatch(/^[0-9a-f]{16}$/);
    expect(result.routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ address: "/", path: "website/index.md", status: "live" }),
        expect.objectContaining({ address: "/about", path: "website/about.md", status: "live" }),
        expect.objectContaining({ address: "/contact", path: "website/contact.md", status: "draft" }),
      ]),
    );
  });

  test("links that go nowhere are reported with note, line and the nearest address", async () => {
    const f = await checkFixture();
    const { links } = (await check(f, EDITOR))!;
    const found = links.map((link) => [link.path, link.line, link.target]);
    expect(found).toEqual(
      expect.arrayContaining([
        ["website/about.md", 6, "contact.md"],
        ["website/about.md", 6, "/newz"],
        ["website/layout.html.md", 5, "/abuot"],
        ["website/layout.html.md", 5, "work"],
      ]),
    );
    // `/`, the `/index` alias, an anchor on a live page and an external link are fine.
    expect(found.map(([, , target]) => target)).not.toEqual(expect.arrayContaining(["/", "/index", "/about#team", "https://example.test/x"]));
    const byTarget = new Map(links.map((link) => [link.target, link.problem]));
    expect(byTarget.get("/newz")).toBe("no page has the address /newz; did you mean /news?");
    expect(byTarget.get("/abuot")).toMatch(/did you mean \/about\?/);
    expect(byTarget.get("contact.md")).toMatch(/website\/contact\.md is a draft/);
    expect(byTarget.get("work")).toMatch(/start it with \//);
  });

  test("pictures: sizes, users, and why the broken ones will not draw", async () => {
    const f = await checkFixture();
    const pictures = new Map((await check(f, EDITOR))!.pictures.map((picture) => [picture.name, picture]));
    expect(pictures.get("logo.png")).toEqual({ name: "logo.png", bytes: PNG.byteLength, usedBy: ["website/layout.html.md"], labels: [], problem: null });
    expect(pictures.get("hero.png")!.problem).toMatch(/over the 2 MB a site draws/);
    expect(pictures.get("gone.png")).toMatchObject({ usedBy: ["website/about.md"], problem: "no picture is stored under this exact name" });
    expect(pictures.get("https://cdn.test/a.png")!.problem).toMatch(/never loads/);
    expect(pictures.get("images/x.png")!.problem).toMatch(/with no folder/);
  });

  test("what the cleaner removes is reported by line, and a removed { content } is an empty site", async () => {
    const f = await checkFixture();
    const result = (await check(f, EDITOR))!;
    const layout = result.code.find((entry) => entry.path === "website/layout.html.md")!;
    expect(layout.removed).toEqual([
      expect.objectContaining({ line: 6, what: "<template> and everything inside it" }),
      expect.objectContaining({ line: 7, what: "onclick on <div>" }),
    ]);
    const sheet = result.code.find((entry) => entry.path === "website/site.css.md")!;
    expect(sheet.removed.map((removal) => removal.what)).toEqual(["@font-face"]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        { path: "website/layout.html.md", why: expect.stringMatching(/\{ content \} sits inside/) },
        { path: "website/blank.md", why: expect.stringMatching(/no words/) },
      ]),
    );
  });

  test("pictures carry the labels their embeds give them, so an agent knows which are real photographs", async () => {
    const f = await checkFixture();
    f.backend.seed(`${IMAGES}team.png`, PNG);
    f.backend.seed("website/news.md", '---\ntitle: News\n---\n\n![Team](team.png "original photograph")\n');
    f.backend.seed("website/team.md", '---\ntitle: Team\n---\n\n![Again](team.png "original photograph") ![Mock](team.png \'early draft\')\n');
    const pictures = new Map((await check(f, EDITOR))!.pictures.map((picture) => [picture.name, picture]));
    expect(pictures.get("team.png")).toMatchObject({ usedBy: ["website/news.md", "website/team.md"], labels: ["early draft", "original photograph"] });
    expect(pictures.get("logo.png")!.labels).toEqual([]);
  });

  test("given a code note's path, the check returns what the site draws, and publishes nothing", async () => {
    const f = await checkFixture();
    const before = await f.t.query(api.functions.websites.siteRevision, { handle: "atlas" });
    const sheet = (await check(f, EDITOR, "website/site.css.md"))!.inspected!;
    expect(sheet.output).toContain("Context's base sheet");
    expect(sheet.output).toContain(".ctx-site .a { color: red; }");
    const layout = (await check(f, EDITOR, "website/layout.html.md"))!.inspected!;
    expect(layout.output).not.toMatch(/onclick|<template/);
    expect((await check(f, EDITOR, "website/nope.md"))!.inspected!.output).toMatch(/nothing to show/);
    expect(await f.t.query(api.functions.websites.siteRevision, { handle: "atlas" })).toEqual(before);
  });

  test("a site that says base: off is inspected without the base sheet", async () => {
    const f = await checkFixture();
    f.backend.seed("website/reset.css.md", "---\nbase: off\n---\n\n```css\n.c { margin: 0; }\n```\n");
    const sheet = (await check(f, EDITOR, "website/site.css.md"))!.inspected!;
    expect(sheet.output).not.toContain("Context's base sheet");
    expect(sheet.output).not.toContain("--bg: #ffffff");
    expect(sheet.output).toContain(".ctx-site .a { color: red; }");
  });
});
