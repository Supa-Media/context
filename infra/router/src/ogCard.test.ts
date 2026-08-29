/**
 * THE SHARE CARD — routing, coverage, and the one property that matters most.
 *
 * The rendering itself is not tested here: satori and resvg are WebAssembly and
 * this suite runs in plain node. What was verified instead is stronger than a
 * unit test and is recorded so nobody has to redo it — the module was built
 * into a real Worker with `wrangler dev` and driven in workerd:
 *
 *   bundle 910.61 KiB gzip (limit 3 MiB Free / 10 MiB Paid)
 *   first render 121 ms (wasm compile), warm 25–30 ms
 *   PNG 24–33 KB (WhatsApp's 600 KB cap is the binding one)
 *   13 hostile inputs — combining marks, RTL override, zero-width runs,
 *     60 identical wide/narrow glyphs, BOM, script tags, entities, tabs,
 *     whitespace-only — all bounded 22–45 ms, no crash, no 5xx
 *   accented Latin / em dash / curly quotes / ellipsis: rendered
 *   Japanese and emoji: refused by the coverage check, static card served
 *
 * What IS tested here is everything that decides *whether* a card is drawn and
 * *which* one is served, because those are the parts that can silently be
 * wrong.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fontCoverage, isRenderable } from "./fontCoverage";
import {
  GENERIC_PREVIEW,
  hashTitle,
  previewForShare,
  renderPreviewHtml,
  shareCardPath,
  shareCardTokenFrom,
} from "./preview";
import { route } from "./route";

const TOKEN = "a".repeat(64);

/** The font the router actually bundles — not a fixture. */
function onest(): ArrayBuffer {
  const path = fileURLToPath(new URL("./fonts/Onest.ttf", import.meta.url));
  const buffer = readFileSync(path);
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

describe("font coverage, read from the font we ship", () => {
  const covered = fontCoverage(onest());

  it("has real coverage, not an empty set from a failed parse", () => {
    // An empty set fails closed — every title would fall back — so a broken
    // parser would look like "the feature just never renders".
    expect(covered.size).toBeGreaterThan(500);
  });

  it("covers ordinary English", () => {
    expect(isRenderable("Chapter transition", covered)).toBe(true);
  });

  /**
   * The characters that actually appear in these notes. Every one of them was
   * a plausible tofu risk before it was measured.
   */
  it("covers accented Latin, em dashes, curly quotes and ellipses", () => {
    expect(isRenderable("Café — “curly” it’s… naïve", covered)).toBe(true);
    expect(isRenderable("Björk, Æthelred & Zoë", covered)).toBe(true);
  });

  /**
   * Not a shortcoming — a decision. satori would draw these as `□`, silently,
   * onto a card that then gets cached forever by unfurlers. Refusing and
   * serving the product card is the better failure.
   */
  it("refuses scripts the bundled Latin subset cannot draw", () => {
    expect(isRenderable("日本語のノート", covered)).toBe(false);
    expect(isRenderable("🚀 launch", covered)).toBe(false);
    expect(isRenderable("مرحبا", covered)).toBe(false);
  });

  it("one uncovered character is enough to refuse the whole title", () => {
    expect(isRenderable("Mostly fine 日", covered)).toBe(false);
  });

  /**
   * Whitespace has no glyph to miss. A font whose cmap omits a newline must not
   * send an ordinary English title to the fallback.
   */
  it("does not refuse on whitespace", () => {
    expect(isRenderable("two words", covered)).toBe(true);
    expect(isRenderable("tab\tand\nnewline", covered)).toBe(true);
    expect(isRenderable("", covered)).toBe(true);
  });

  /**
   * Iterating by codepoint rather than UTF-16 unit: an astral character is one
   * question, not two surrogate halves that are each independently uncovered.
   */
  it("treats an astral character as one codepoint", () => {
    const single = [..."𝄞"];
    expect(single).toHaveLength(1);
    expect(isRenderable("𝄞", covered)).toBe(false);
  });

  it("a font that will not parse yields no coverage, so everything falls back", () => {
    const rubbish = new Uint8Array([1, 2, 3, 4]).buffer;
    expect(fontCoverage(rubbish).size).toBe(0);
    expect(isRenderable("anything", fontCoverage(rubbish))).toBe(false);
  });
});

describe("the card's URL", () => {
  it("is only recognised for a well-formed token", () => {
    expect(shareCardTokenFrom(`/og/s/${TOKEN}.png`)).toBe(TOKEN);
  });

  it.each([
    ["/og/s/.png", "no token"],
    [`/og/s/${"a".repeat(63)}.png`, "one short"],
    [`/og/s/${"a".repeat(65)}.png`, "one long"],
    [`/og/s/${"A".repeat(64)}.png`, "uppercase"],
    [`/og/s/${"g".repeat(64)}.png`, "not hex"],
    [`/og/s/${TOKEN}`, "no extension"],
    [`/og/s/${TOKEN}.jpg`, "wrong extension"],
    [`/og/s/../../${TOKEN}.png`, "traversal"],
    [`/s/${TOKEN}`, "the page, not the card"],
    ["/og/card.png", "the static card"],
  ])("%s is not a card (%s)", (pathname) => {
    expect(shareCardTokenFrom(pathname)).toBeNull();
  });

  /**
   * THE property of this endpoint. The `?v=` is a cache key and never an input:
   * the renderer re-resolves the title from the token. An endpoint that drew
   * the text it was handed would make context.lc an arbitrary-text image
   * generator wearing our own branding — a ready-made phishing asset.
   *
   * It holds structurally rather than by discipline: `shareCardTokenFrom` takes
   * a pathname, and a pathname has no query string in it.
   */
  it("carries no text — the version parameter is not part of the path", () => {
    const url = new URL(`https://context.lc/og/s/${TOKEN}.png?v=deadbeef&t=evil`);
    expect(shareCardTokenFrom(url.pathname)).toBe(TOKEN);
    expect(url.pathname).not.toContain("evil");
  });

  it("routes to the card branch, ahead of the crawler check", () => {
    // No User-Agent at all: a card must be served to anyone who asks, because
    // the unfurler fetching the image is not always the one that read the tags.
    expect(route(new URL(`https://context.lc/og/s/${TOKEN}.png`))).toEqual({
      kind: "share-card",
      token: TOKEN,
    });
  });

  it("serves the card to a crawler too, rather than the preview shell", () => {
    expect(
      route(new URL(`https://context.lc/og/s/${TOKEN}.png`), "Slackbot 1.0"),
    ).toEqual({ kind: "share-card", token: TOKEN });
  });
});

describe("the version hash", () => {
  it("is stable for the same title", () => {
    expect(hashTitle("Chapter transition")).toBe(hashTitle("Chapter transition"));
  });

  /**
   * The Workers Cache API is per-datacenter and `cache.delete` purges only the
   * colo the Worker ran in, so a card cannot be globally invalidated. A changed
   * title being a different URL is what makes an edit take effect at once.
   */
  it("changes when the title changes", () => {
    expect(hashTitle("Chapter transition")).not.toBe(hashTitle("Chapter transitio"));
  });

  it("is a fixed-width hex string", () => {
    for (const title of ["", "a", "Chapter transition", "x".repeat(60)]) {
      expect(hashTitle(title)).toMatch(/^[0-9a-f]{8}$/);
    }
  });
});

describe("which image the tags point at", () => {
  it("a titled share points at its own card", () => {
    const meta = previewForShare("Chapter transition", TOKEN);
    expect(meta.imageUrl).toBe(
      `https://context.lc${shareCardPath(TOKEN, "Chapter transition")}`,
    );
  });

  /**
   * Revoked, expired, unknown, title switched off — all arrive here as a falsy
   * title, and every one of them must render the frozen card byte for byte.
   * That is what keeps revocation invisible to a crawler, and it must survive
   * the image having become dynamic.
   */
  it.each([[null], [undefined], [""], ["   "]])(
    "an empty title (%p) still renders the frozen card exactly",
    (title) => {
      expect(renderPreviewHtml(previewForShare(title, TOKEN))).toBe(
        renderPreviewHtml(GENERIC_PREVIEW),
      );
    },
  );

  it("a share with no token falls back to the static card", () => {
    // The token is optional on the type, and the honest answer when it is
    // absent is the product card rather than a URL with `undefined` in it.
    const meta = previewForShare("Chapter transition");
    expect(meta.imageUrl).toBeUndefined();
    expect(renderPreviewHtml(meta)).toContain("https://context.lc/og/card.png");
  });

  /**
   * Facebook documents these as the fix for "the first share shows no image",
   * and they are about the frame rather than the file, so they stay correct for
   * a dynamic card at the same dimensions.
   */
  it("keeps the dimension tags, which are what stop a first share rendering blank", () => {
    const html = renderPreviewHtml(previewForShare("Chapter transition", TOKEN));
    expect(html).toContain('content="1200"');
    expect(html).toContain('content="630"');
    expect(html).toContain('property="og:image:type" content="image/png"');
  });

  it("still refuses everything the frozen card refuses", () => {
    const html = renderPreviewHtml(previewForShare("Chapter transition", TOKEN));
    expect(html).toContain('<link rel="canonical" href="https://context.lc/">');
    expect(html).toMatch(/name="robots" content="noindex, nofollow"/);
  });

  it("a hostile title cannot break out of the image URL either", () => {
    const html = renderPreviewHtml(
      previewForShare('" onerror="alert(1)', TOKEN),
    );
    expect(html).not.toContain('onerror="alert(1)"');
    expect(html).toContain("&quot;");
  });
});

/**
 * THE PRECHECK IS A PIN, BECAUSE NOTHING ELSE HERE CAN HOLD IT.
 *
 * satori and resvg are WebAssembly and this suite runs in plain node, so
 * `renderShareCard` cannot be called from a test at all. That is a real gap and
 * it was found the way gaps here are supposed to be found: by deleting the
 * `canRenderTitle` guard and watching all 184 tests stay green.
 *
 * A card rendered without that guard does not throw — it draws `□□□` and gets
 * cached by every unfurler that sees it, permanently, because Discord and
 * WhatsApp copy the image onto their own CDNs. The failure is silent, shipped,
 * and unretractable, which is the worst combination available.
 *
 * So this reads the source, exactly as `structure.test.ts` does for the
 * credential barrier and the route factories. A source assertion is a weak
 * test; a weak test on this is better than the green run that a deleted guard
 * currently produces.
 */
describe("the coverage precheck cannot be deleted quietly", () => {
  const source = readFileSync(
    fileURLToPath(new URL("./ogCard.ts", import.meta.url)),
    "utf8",
  );

  /**
   * The source with its comments removed.
   *
   * The first version of the CDN check below asserted against the raw file and
   * failed on this module's own doc comment, which *names* the hosts in order
   * to explain why they are disabled. CLAUDE.md lists "an import guard that
   * read English prose as code" as one of three times a guard here was weaker
   * than it looked; this is the same mistake in the opposite direction, and the
   * fix is the same — check the code, not the prose.
   */
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("renderShareCard refuses an unrenderable title before doing any work", () => {
    const body = code.slice(code.indexOf("export async function renderShareCard"));
    const guard = body.indexOf("canRenderTitle");
    const render = body.indexOf("new ImageResponse");

    expect(guard, "renderShareCard does not consult canRenderTitle").toBeGreaterThan(-1);
    expect(render, "renderShareCard no longer renders").toBeGreaterThan(-1);
    expect(
      guard,
      "the coverage check must come BEFORE the render, or tofu ships",
    ).toBeLessThan(render);
    expect(body.slice(guard, render)).toContain("return null");
  });

  /**
   * The single most important line in the module. Without it satori fetches
   * fallback fonts from Google and Twemoji from jsDelivr on any glyph miss —
   * a hidden third-party dependency in the request path, note titles leaked to
   * two CDNs, latency that swings 36× on attacker-chosen text, and a hard crash
   * on Arabic. It also closes the SSRF path that `@cf-wasm/og`'s pinned satori
   * 0.29.0 is one patch short of hardening.
   */
  it("remote asset loading stays disabled", () => {
    expect(code).toMatch(/loadAdditionalAsset:\s*async\s*\(\)\s*=>\s*""/);
  });

  /** Neither host may appear in this Worker at all. */
  it("names no font or emoji CDN in code", () => {
    expect(code).not.toContain("fonts.googleapis.com");
    expect(code).not.toContain("jsdelivr");
    expect(code).not.toContain("twemoji");
    // …and the comment that explains them is still there, because the reason
    // this line exists is the least obvious thing in the module.
    expect(source).toContain("fonts.googleapis.com");
  });
});
