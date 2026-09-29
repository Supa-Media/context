import { describe, expect, test } from "@jest/globals";
import { CAST_PREVIEW_BANNER, CAST_PREVIEW_PARAM, castPreviewFrom, castPreviewHref, hasCast } from "../features/home/castPreview";
import { castSite } from "../features/home/cast/castSite";
import { liveHomeTree } from "../features/home/homeSite";

const DRAFT = [
  "---",
  "title: pricing",
  "---",
  "# pricing",
  "",
  "- unlimited members 😪 “quotes” & ünïcode",
  "",
  "```cast",
  "@jon adds a line below: - clearer skin",
  "```",
  "",
].join("\n");

function hashOf(href: string) {
  return href.slice(href.indexOf("#"));
}

describe("Preview demo: the owner's draft, played by the homepage", () => {
  test("offered only for a note whose draft holds a cast step", () => {
    expect(hasCast(DRAFT)).toBe(true);
    expect(hasCast("# pricing\n\n- unlimited members\n")).toBe(false);
    expect(hasCast("```js\ncast()\n```\n")).toBe(false);
    expect(hasCast("```cast\n```\n")).toBe(false);
  });

  test("the draft rides in the fragment, never the path or query a server sees", () => {
    const href = castPreviewHref(DRAFT, "pricing");
    expect(href.startsWith(`/#${CAST_PREVIEW_PARAM}=`)).toBe(true);
    expect(href).not.toContain("?");
    expect(href).not.toContain("unlimited");
    // No storage in between: the address alone carries it, so it survives the
    // desktop app handing the tab to another browser (Dev2, 2026-09-29).
    expect(/^[A-Za-z0-9_-]+$/.test(href.slice(href.indexOf("=") + 1))).toBe(true);
  });

  test("the homepage reads it back as its only page, and its cast plays", () => {
    const snapshot = castPreviewFrom(hashOf(castPreviewHref(DRAFT, "pricing")));
    expect(snapshot).not.toBeNull();
    expect(snapshot!.revision).toBeNull();
    expect(snapshot!.pages).toHaveLength(1);
    expect(snapshot!.pages[0]!.title).toBe("pricing");
    expect(snapshot!.pages[0]!.routePath).toBe("/");
    // The homepage's own warning first, then the draft without its frontmatter.
    expect(snapshot!.pages[0]!.markdown.startsWith(`${CAST_PREVIEW_BANNER}# pricing`)).toBe(true);
    expect(snapshot!.pages[0]!.markdown).toContain("😪 “quotes” & ünïcode");

    const cast = castSite(snapshot!.pages);
    expect(cast.scripts.get("/")?.map((step) => step.kind)).toEqual(["append"]);
    expect(cast.pages[0]!.markdown).not.toContain("```cast");
    expect(liveHomeTree(cast.pages).paths.get("/")).toBeDefined();
  });

  test("a crafted address cannot drop the warning", () => {
    const crafted = btoa(JSON.stringify({ title: "Context", markdown: "# Sign in again\n" }))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const snapshot = castPreviewFrom(`#${CAST_PREVIEW_PARAM}=${crafted}`);
    expect(snapshot?.pages[0]!.markdown).toBe(`${CAST_PREVIEW_BANNER}# Sign in again\n`);
  });

  test("an ordinary visit or a mangled address is the real site", () => {
    expect(castPreviewFrom(undefined)).toBeNull();
    expect(castPreviewFrom("")).toBeNull();
    expect(castPreviewFrom("#top")).toBeNull();
    expect(castPreviewFrom(`#${CAST_PREVIEW_PARAM}=`)).toBeNull();
    expect(castPreviewFrom(`#${CAST_PREVIEW_PARAM}=not base64!`)).toBeNull();
    expect(castPreviewFrom(`#${CAST_PREVIEW_PARAM}=${btoa("{not json")}`)).toBeNull();
    expect(castPreviewFrom(`#${CAST_PREVIEW_PARAM}=${btoa(JSON.stringify({ title: 1, markdown: "x" }))}`)).toBeNull();
  });

  test("a large draft still fits", () => {
    const big = `# big\n\n${"a line of the page. ".repeat(5_000)}\n\n\`\`\`cast\n@jon types: hi\n\`\`\`\n`;
    const back = castPreviewFrom(hashOf(castPreviewHref(big, "big")));
    expect(back?.pages[0]!.markdown).toBe(CAST_PREVIEW_BANNER + big);
  });
});
