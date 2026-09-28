/**
 * A website page unfurls as itself: `/site/preview` and `/site/card`, the
 * preview facts behind them, and the card's artwork.
 *
 * The security argument (`docs/decisions/websites.md`, "A page unfurls as
 * itself") is that a crawler is told exactly what an anonymous visitor to the
 * same address is shown. So these hold: a live public page answers with its
 * title, its site's name and one line; every other case (members-only, draft,
 * site off, nobody's handle) is one byte-identical null answer; and a request
 * that arrives signed in is still answered as the anonymous visitor.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ResolvedWebsitePage } from "@context/shared";
import { isRenderableSiteCard } from "../functions/lib/cardCoverage";
import { SITE_SERIF_FONT_SHA256, siteSerifFont } from "../functions/lib/cardFont/instrumentSerif";
import { isHomeTitle, siteCardElement } from "../functions/lib/siteCardArt";
import {
  excerptFromMarkdown,
  siteCardFacts,
  siteCardVersion,
  websitePreviewFromPage,
} from "../functions/lib/websites/preview";
import { asUser } from "./fixtures.helpers";
import { fixture, publish, type Fixture } from "./website.helpers";

afterEach(() => vi.unstubAllGlobals());

function page(over: Partial<Extract<ResolvedWebsitePage, { kind: "page" }>> = {}): ResolvedWebsitePage {
  return {
    kind: "page",
    siteName: "Atlas Studio",
    routePath: "/writing",
    audience: "public",
    title: "Writing",
    description: null,
    markdown: "",
    navigation: [],
    ...over,
  };
}

describe("what a page's preview says", () => {
  test("a public page gives its title, its site's name and its description", () => {
    expect(websitePreviewFromPage(page({ description: "Essays." }))).toEqual({
      siteName: "Atlas Studio",
      title: "Writing",
      description: "Essays.",
    });
  });

  test("the home page speaks as the site", () => {
    expect(websitePreviewFromPage(page({ routePath: "/", title: "Home" }))?.title).toBe("Atlas Studio");
  });

  test("with no description, the first paragraph of prose stands in", () => {
    const markdown = "# Writing\n\n![cover](https://x.invalid/a.png)\n\nThings I **wrote**, with [links](/a).\nOn two lines.\n\nLater.\n";
    expect(websitePreviewFromPage(page({ markdown }))?.description).toBe(
      "Things I wrote, with links. On two lines.",
    );
  });

  test("members-only pages and every non-page answer are absent", () => {
    expect(websitePreviewFromPage(page({ audience: "members" }))).toBeNull();
    expect(websitePreviewFromPage({ kind: "unavailable", siteName: "Atlas", navigation: [] })).toBeNull();
    expect(
      websitePreviewFromPage({
        kind: "authentication_required",
        siteName: "Atlas",
        navigation: [],
        signInPath: "/login",
      }),
    ).toBeNull();
  });

  test("control and format characters are cleaned and long text is cut at a word", () => {
    const preview = websitePreviewFromPage(
      page({ title: `Wri\u202Eting`, description: `${"word ".repeat(80)}end` }),
    );
    expect(preview?.title).toBe("Wri ting");
    expect(preview!.description!.length).toBeLessThanOrEqual(200);
    expect(preview!.description!.endsWith("word…")).toBe(true);
  });
});

describe("the excerpt", () => {
  test.each([
    ["headings, lists, code and tables are passed over", "# T\n\n- a\n- b\n\n```\ncode\n```\n\n| a | b |\n\nProse.", "Prose."],
    ["a quote is prose", "> Said well.", "Said well."],
    ["nothing but structure is no excerpt", "# T\n\n- only\n- a list\n", null],
    ["an unclosed fence hides what follows", "```\nsecret\n\nstill code", null],
    ["html tags and comments are dropped", "<!-- note -->\nHi <kbd>there</kbd>.", "Hi there."],
  ])("%s", (_name, markdown, expected) => {
    expect(excerptFromMarkdown(markdown)).toBe(expected);
  });
});

describe("the card", () => {
  test("the embedded serif is the font its header names", () => {
    const font = siteSerifFont();
    expect(createHash("sha256").update(font).digest("hex")).toBe(SITE_SERIF_FONT_SHA256);
    expect(font.byteLength).toBeGreaterThan(40_000);
  });

  test("its palette is the app's Paper palette", () => {
    const tokens = readFileSync(
      fileURLToPath(new URL("../../mobile/features/design/tokens/colors.ts", import.meta.url)),
      "utf8",
    );
    const light = tokens.slice(tokens.indexOf("export const lightColors"));
    const art = readFileSync(fileURLToPath(new URL("../functions/lib/siteCardArt.ts", import.meta.url)), "utf8");
    for (const [token, constant] of [["ground", "GROUND"], ["text", "TEXT"], ["line", "LINE"]] as const) {
      const value = new RegExp(`\\n  ${token}: "([^"]+)"`).exec(light)?.[1];
      expect(value, `lightColors.${token}`).toBeDefined();
      expect(art).toContain(`const ${constant} = "${value}";`);
    }
  });

  function texts(node: unknown, out: string[] = []): string[] {
    const props = (node as { props?: { children?: unknown; style?: { display?: string } } }).props;
    const children = props?.children;
    if (typeof children === "string") out.push(children);
    if (Array.isArray(children)) {
      expect(props?.style?.display, "satori needs flex on every parent").toBe("flex");
      for (const child of children) texts(child, out);
    }
    return out;
  }

  test("draws the page's title and its site's name, and nothing of ours", () => {
    const drawn = texts(siteCardElement({ title: "Writing", siteName: "Atlas Studio" }));
    expect(drawn).toEqual(["Atlas Studio", "Writing"]);
    expect(drawn.join(" ").toLowerCase()).not.toContain("context");
  });

  test("the home page draws the name once", () => {
    expect(texts(siteCardElement({ title: "Atlas Studio", siteName: "Atlas Studio" }))).toEqual(["Atlas Studio"]);
    expect(isHomeTitle("Home", "Atlas Studio")).toBe(true);
  });

  test("a title is cut to the card's measure, and a new title or design is a new picture", () => {
    const long = { siteName: "Atlas", title: "A very long title ".repeat(8).trim(), description: null };
    expect(siteCardFacts(long).title.length).toBeLessThanOrEqual(60);
    const base = { siteName: "Atlas", title: "Writing", description: null };
    expect(siteCardVersion(base)).toMatch(/^[0-9a-f]{8}$/);
    expect(siteCardVersion({ ...base, title: "Reading" })).not.toBe(siteCardVersion(base));
    expect(siteCardVersion({ ...base, description: "changed" })).toBe(siteCardVersion(base));
  });

  test("a title either face cannot draw means no card, never tofu", () => {
    expect(isRenderableSiteCard({ title: "Writing…", siteName: "Atlas Studio" })).toBe(true);
    expect(isRenderableSiteCard({ title: "書く", siteName: "Atlas" })).toBe(false);
    expect(isRenderableSiteCard({ title: "Writing", siteName: "アトラス" })).toBe(false);
  });
});

async function ask(f: Fixture, path: "/site/preview" | "/site/card", body: unknown, as?: Parameters<typeof asUser>[1]) {
  const init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  return as === undefined ? await f.t.fetch(path, init) : await asUser(f.t, as).fetch(path, init);
}

describe("the routes", () => {
  async function site() {
    const f = await fixture();
    f.backend.seed("website/index.md", "---\ntitle: Home\ndescription: Hello there.\n---\n\n# Welcome\n");
    f.backend.seed("website/writing.md", "---\ntitle: Writing\n---\n\nEssays and notes.\n");
    f.backend.seed("website/team.md", "---\ntitle: Team\naudience: members\n---\n\nThe team.\n");
    f.backend.seed("website/soon.md", "---\ntitle: Soon\ndraft: true\n---\n\nNot yet.\n");
    await publish(f);
    return f;
  }

  test("a live public page answers with four fields", async () => {
    const f = await site();
    const response = await ask(f, "/site/preview", { handle: "atlas", routePath: "/writing" });
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      title: "Writing",
      description: "Essays and notes.",
      siteName: "Atlas Studio",
      cardVersion: expect.stringMatching(/^[0-9a-f]{8}$/),
    });
    const home = (await (await ask(f, "/site/preview", { handle: "atlas", routePath: "/" })).json()) as Record<string, unknown>;
    expect(home).toMatchObject({ title: "Atlas Studio", description: "Hello there." });
  });

  test("members-only, draft, missing, nobody's, and malformed are one answer", async () => {
    const f = await site();
    const answers = new Set<string>();
    for (const body of [
      { handle: "atlas", routePath: "/team" },
      { handle: "atlas", routePath: "/soon" },
      { handle: "atlas", routePath: "/nope" },
      { handle: "no-such-handle", routePath: "/" },
      { handle: "atlas" },
      "not json",
    ]) {
      answers.add(await (await ask(f, "/site/preview", body)).text());
    }
    expect([...answers]).toEqual([
      JSON.stringify({ title: null, description: null, siteName: null, cardVersion: null }),
    ]);
  });

  test("a member asking is answered as the anonymous visitor", async () => {
    const f = await site();
    const response = await ask(f, "/site/preview", { handle: "atlas", routePath: "/team" }, f.member);
    expect(await response.json()).toMatchObject({ title: null });
  });

  test("a site that is turned off previews nothing", async () => {
    const f = await site();
    await f.t.run(async (ctx) => {
      const row = await ctx.db
        .query("websiteStates")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", f.workspaceId))
        .unique();
      await ctx.db.patch(row!._id, { state: "disabled" });
    });
    expect(await (await ask(f, "/site/preview", { handle: "atlas", routePath: "/writing" })).json()).toMatchObject({
      title: null,
    });
  });

  test("the picture is drawn only for the page's current version", async () => {
    const f = await site();
    const { cardVersion } = (await (
      await ask(f, "/site/preview", { handle: "atlas", routePath: "/writing" })
    ).json()) as { cardVersion: string };
    // Not the page's version: refused before a render is spent. (The current
    // one gets as far as the renderer, whose wasm a test deployment lacks.)
    expect(
      (await ask(f, "/site/card", { handle: "atlas", routePath: "/writing", version: "00000000" })).status,
    ).toBe(404);
    expect(cardVersion).not.toBe("00000000");
  });

  test("the picture is a 404 wherever there is no page", async () => {
    const f = await site();
    for (const body of [
      { handle: "atlas", routePath: "/team" },
      { handle: "no-such-handle", routePath: "/" },
      {},
    ]) {
      expect((await ask(f, "/site/card", body)).status).toBe(404);
    }
  });
});
