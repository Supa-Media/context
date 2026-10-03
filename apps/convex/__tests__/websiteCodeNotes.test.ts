/**
 * Code notes in the website folder: which files are pages, which are drawn
 * into pages, and what stops a Publish. The statuses here are what the index
 * stores and what Publish reports, so a code note that slipped into being an
 * address, or a page that silently lost its layout, would show here first.
 */
import { describe, expect, test } from "vitest";
import { buildWebsiteRouteStatuses, compileWebsiteRoutes, summarizeWebsiteRoutes } from "@context/shared";

const FRAME = "The frame.\n\n```html\n<header>{ site.name }</header><main>{ content }</main>\n```\n";
const CARDS =
  "```html\n<div class=\"cards\">{ each card in page.sections }<a href=\"{ card.link }\">{ card.heading }</a>{ end }</div>\n```\n";
const STYLES = "```css\n:root { --accent: #FFD23F; }\n```\n";

const site = (files: Record<string, string>) =>
  buildWebsiteRouteStatuses(
    Object.entries(files).map(([objectKey, markdown]) => ({ objectKey, markdown })),
    { wholeSite: true },
  );
const byKey = (files: Record<string, string>) => new Map(site(files).map((status) => [status.objectKey, status]));

describe("website code notes", () => {
  test("supa.media: the frame, a named layout and a stylesheet are drawn into pages, never addresses", () => {
    const statuses = byKey({
      "website/index.md": "# Supa\n",
      "website/code.md": "---\nlayout: cards\n---\n\n# Code\n\n## Supa Radio\n\nTurn a song into a video.\n",
      "website/layout.html.md": FRAME,
      "website/cards.html.md": CARDS,
      "website/styles.css.md": STYLES,
    });
    expect(statuses.get("website/code.md")).toMatchObject({ routePath: "/code", status: "live" });
    expect(statuses.get("website/layout.html.md")).toMatchObject({ routePath: null, status: "live", code: "frame", nav: null });
    expect(statuses.get("website/cards.html.md")).toMatchObject({ routePath: null, status: "live", code: "layout" });
    expect(statuses.get("website/styles.css.md")).toMatchObject({ routePath: null, status: "live", code: "style", title: "styles" });
    expect(statuses.get("website/index.md")!.code).toBeUndefined();
  });

  test("an .html.md no page names is an all-HTML page at its own address", () => {
    const statuses = byKey({ "website/pricing.html.md": "```html\n<h1>Pricing</h1>\n```\n" });
    expect(statuses.get("website/pricing.html.md")).toMatchObject({ routePath: "/pricing", status: "live", code: "html", title: "pricing" });
  });

  test("a page and an HTML page claiming the same address clash", () => {
    const statuses = byKey({
      "website/about.md": "# About\n",
      "website/about.html.md": "```html\n<h1>About</h1>\n```\n",
    });
    expect(statuses.get("website/about.md")!.status).toBe("problem");
    expect(statuses.get("website/about.html.md")!.status).toBe("problem");
  });

  test("a layout a page names never clashes with a page of the same name", () => {
    const statuses = byKey({
      "website/cards.md": "---\nlayout: cards\n---\n# Cards\n",
      "website/cards.html.md": CARDS,
    });
    expect(statuses.get("website/cards.md")).toMatchObject({ routePath: "/cards", status: "live" });
    expect(statuses.get("website/cards.html.md")).toMatchObject({ routePath: null, code: "layout", status: "live" });
  });

  test("scripts and stylesheets are never addresses, even ones the platform reserves", () => {
    const compiled = compileWebsiteRoutes(["website/styles.css.md", "website/calc.js.md"], { code: true });
    expect(compiled.routes).toEqual([]);
    expect(compiled.diagnostics).toEqual([]);
    expect(compiled.codeNotes).toEqual([
      { objectKey: "website/calc.js.md", role: "script" },
      { objectKey: "website/styles.css.md", role: "style" },
    ]);
  });

  test("without code notes on, the old rules stand: a folder's notes are notes", () => {
    const compiled = compileWebsiteRoutes(["website/notes/about.html.md"]);
    expect(compiled.routes.map((route) => route.routePath)).toEqual(["/notes/about.html"]);
    expect(compiled.codeNotes).toEqual([]);
  });

  test("problems an agent can act on", () => {
    const statuses = byKey({
      "website/index.md": "---\nlayout: missing\n---\n# Hi\n",
      "website/frame.md": "---\nlayout: layout\n---\n# Hi\n",
      "website/bad.md": "---\nlayout: Not A Name\n---\n# Hi\n",
      "website/layout.html.md": "```html\n<main></main>\n```\n",
      "website/styles.css.md": "No block here.\n",
      "website/two.css.md": "```css\na{}\n```\n```css\nb{}\n```\n",
      "website/blog/extra.css.md": "```css\na{}\n```\n",
      "website/cards.html.md": "```html\n{ each x in page.sections }{ x.colour }{ end }\n```\n",
    });
    const message = (key: string) => statuses.get(key)!.problems.map((problem) => problem.message);
    expect(message("website/index.md")).toEqual(["`layout: missing` needs website/missing.html.md, which isn't there."]);
    expect(message("website/frame.md")).toEqual(["`layout: layout` names the frame, which every page already has."]);
    expect(message("website/bad.md")).toEqual(["Website layout must be a layout's name, like `layout: cards` for cards.html.md."]);
    expect(message("website/layout.html.md")).toEqual(["layout.html.md needs { content } where each page goes."]);
    expect(message("website/styles.css.md")).toEqual(["A .css.md note holds one ```css block, and this one has none."]);
    expect(message("website/two.css.md")).toEqual(["A .css.md note holds one ```css block, and this one has 2."]);
    expect(message("website/blog/extra.css.md")).toEqual(["Stylesheets and scripts go at the top of the website folder."]);
    // No page names cards, so it is an HTML page, checked as one.
    expect(message("website/cards.html.md")).toEqual(["{ x.colour } is not a field a layout can use."]);
  });

  test("a single page re-checked alone keeps its layout", () => {
    const [status] = buildWebsiteRouteStatuses([
      { objectKey: "website/code.md", markdown: "---\nlayout: cards\n---\n# Code\n" },
    ]);
    expect(status).toMatchObject({ status: "live", routePath: "/code" });
  });

  test("a draft code note is not part of the site", () => {
    expect(byKey({ "website/styles.css.md": `---\ndraft: true\n---\n${STYLES}` }).get("website/styles.css.md")!.status).toBe("draft");
  });

  test("the Website card counts pages, and broken code notes", () => {
    const summary = summarizeWebsiteRoutes(
      site({
        "website/index.md": "# Hi\n",
        "website/pricing.html.md": "```html\n<h1>Pricing</h1>\n```\n",
        "website/layout.html.md": FRAME,
        "website/styles.css.md": "nothing",
      }),
    );
    expect(summary).toEqual({ total: 3, public: 2, members: 0, drafts: 0, problems: 1 });
  });
});
