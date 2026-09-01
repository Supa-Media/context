/**
 * THE SHARE CARD'S ARTWORK, AND THE FONT IT IS DRAWN WITH.
 *
 * The renderer itself is a `"use node"` action calling satori and resvg, which
 * this suite cannot boot — so what is asserted here is everything that decides
 * *what gets drawn*, plus the two ways the setup can rot silently.
 *
 * The render was verified against the real deployment rather than mocked:
 * pushed to a dev backend, wasm installed, and driven through a temporary probe
 * action. 24–34 KB valid PNGs; 3.9 s on a cold isolate, 370–560 ms warm. That
 * is slower than the edge renderer it replaces and does not matter, because
 * this runs once when a share is created rather than on an unfurl.
 *
 * Two things that would otherwise fail only in production, and both are checked
 * below rather than trusted:
 *
 *  1. **The font is a second copy**, and copies drift. The base64 in
 *     `lib/cardFont/onest.ts` must still be the file `infra/router` draws with,
 *     or the same share renders two subtly different cards depending on which
 *     renderer drew it.
 *  2. **`cardRender.ts` must stay actions-only.** A Convex `"use node"` module
 *     may not define a query or a mutation — the push fails outright, which is
 *     how the split into `cardAssets.ts` came about.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  CARD_HEIGHT,
  CARD_SUBTITLE,
  CARD_WIDTH,
  cardElement,
  titleSize,
} from "../functions/lib/cardArt";
import { ONEST_SHA256, onestFont } from "../functions/lib/cardFont/onest";

function repoFile(relative: string): string {
  return fileURLToPath(new URL(`../../../${relative}`, import.meta.url));
}

describe("the embedded font is the font", () => {
  /**
   * The stamped hash describes the bytes actually embedded.
   *
   * This used to compare against `infra/router/src/fonts/Onest.ttf`, because
   * the edge renderer drew with that file and two copies of one font is exactly
   * how a share ends up with two subtly different cards. That renderer is gone
   * — the card is drawn here and fetched by the Worker — so there is one copy
   * again and nothing to drift from.
   *
   * The check is kept rather than deleted, aimed at what remains true: the
   * header of `lib/cardFont/onest.ts` records `ONEST_SHA256` as the digest of
   * the file the base64 came from, and a hand-edited or truncated string would
   * make that a lie.
   */
  test("the stamped hash is the hash of the embedded bytes", () => {
    const embedded = onestFont();
    const embeddedHash = createHash("sha256").update(embedded).digest("hex");
    expect(embeddedHash).toBe(ONEST_SHA256);
  });

  test("decodes to a real TrueType file, not a truncated one", () => {
    const font = onestFont();
    expect(font.byteLength).toBeGreaterThan(50_000);
    // `0x00010000` is the sfnt version every TTF starts with.
    expect([...font.slice(0, 4)]).toEqual([0x00, 0x01, 0x00, 0x00]);
  });

  test("decodes once and hands back the same buffer", () => {
    expect(onestFont()).toBe(onestFont());
  });
});

describe("the card's shape", () => {
  test("is the OpenGraph frame every unfurler expects", () => {
    expect(CARD_WIDTH).toBe(1200);
    expect(CARD_HEIGHT).toBe(630);
  });

  /**
   * The subtitle is about *access*, never about the note. Everything on this
   * card reaches anyone holding the URL — including people the owner never sent
   * it to, because Slack and iMessage copy the image onto their own CDNs — so
   * it may say how to read the thing and nothing about what is in it.
   */
  test("the subtitle says how to read it and nothing about it", () => {
    expect(CARD_SUBTITLE).toMatch(/sign in/i);
    expect(CARD_SUBTITLE).not.toMatch(/note|private|team|folder/i);
  });

  test("only the title varies between two cards", () => {
    const a = JSON.stringify(cardElement("One"));
    const b = JSON.stringify(cardElement("Two"));
    expect(a.replace(/"One"/, "X")).toBe(b.replace(/"Two"/, "X"));
  });

  test("the title reaches the tree exactly as given", () => {
    expect(JSON.stringify(cardElement("Café — it’s"))).toContain("Café — it’s");
  });

  /**
   * satori is not a browser: it implements flexbox and nothing else, and an
   * element with children and no explicit `display: "flex"` lays out wrong
   * rather than throwing. Walking the tree is the only way to catch that
   * without rendering.
   */
  test("every element with children declares display:flex", () => {
    const seen: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (node === null || typeof node !== "object") return;
      const props = (node as { props?: Record<string, unknown> }).props;
      if (props === undefined) return;
      const children = props.children;
      const style = (props.style ?? {}) as Record<string, unknown>;

      if (children !== undefined && typeof children !== "string") {
        if (style.display !== "flex") seen.push(path);
        const list = Array.isArray(children) ? children : [children];
        list.forEach((child, index) => walk(child, `${path}/${index}`));
      }
    };
    walk(cardElement("Chapter transition"), "root");
    expect(seen).toEqual([]);
  });

  /** …and the same walk over the folder card, which adds three elements. */
  test("the folder card lays out under the same rule", () => {
    const seen: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (node === null || typeof node !== "object") return;
      const props = (node as { props?: Record<string, unknown> }).props;
      if (props === undefined) return;
      const children = props.children;
      const style = (props.style ?? {}) as Record<string, unknown>;

      if (children !== undefined && typeof children !== "string") {
        if (style.display !== "flex") seen.push(path);
        const list = Array.isArray(children) ? children : [children];
        list.forEach((child, index) => walk(child, `${path}/${index}`));
      }
    };
    walk(cardElement("Transition", ["interviews/", "overview.md"]), "root");
    expect(seen).toEqual([]);
  });
});

/**
 * WHAT A FOLDER'S CARD DRAWS.
 *
 * The mark and the contents appear **together or not at all**, and that is a
 * decision rather than a convenience: a folder with nothing team-visible inside
 * it draws exactly what a note draws, so a card never says "this is a folder,
 * and there is nothing in it for you". One absence, the same rule the query
 * behind it follows.
 */
describe("the folder card", () => {
  test("no contents is the ordinary card, element for element", () => {
    expect(JSON.stringify(cardElement("Transition", []))).toBe(
      JSON.stringify(cardElement("Transition")),
    );
  });

  test("contents bring a folder mark and the names", () => {
    const plain = JSON.stringify(cardElement("Transition"));
    const folder = JSON.stringify(
      cardElement("Transition", ["interviews/", "overview.md"]),
    );

    expect(folder).not.toBe(plain);
    // One text node, joined exactly as the `og:description` joins it, so the
    // picture and the text cannot say different things about one folder.
    expect(folder).toContain("interviews/ · overview.md");
    // The mark is two boxes rather than a glyph, so it needs no font coverage —
    // an icon drawn from the bundled font would be tofu for the same titles
    // `isRenderableTitle` already refuses, written permanently onto a CDN.
    expect(folder).not.toContain("\u25a1");
    expect(folder).toMatch(/borderTopLeftRadius/);
  });

  /**
   * This module draws what it is handed and derives no bound of its own. The
   * bounds live in `lib/shareTitle.ts`, are re-applied in `previewForNote`, and
   * are applied a third time at the edge — a drawing function that re-decided a
   * security question would be a fourth place for it to be answered wrong.
   */
  test("it draws what it is given, and invents nothing", () => {
    const drawn = JSON.stringify(cardElement("Transition", ["a", "b", "c"]));
    expect(drawn).toContain("a · b · c");
    // No count, no "and 4 more". A total is the addition this card must not
    // grow: over the folder rather than over the visible set it is an existence
    // oracle by subtraction.
    expect(drawn).not.toMatch(/more/i);
    expect(drawn).not.toMatch(/\+\d/);
  });

  /** A child's own text reaches the tree untouched, exactly as the title does. */
  test("a name reaches the tree exactly as given", () => {
    expect(JSON.stringify(cardElement("T", ["Café — it’s.md"]))).toContain(
      "Café — it’s.md",
    );
  });
});

describe("type size", () => {
  /**
   * satori has no text-measurement API to auto-fit with, and the input is
   * bounded at 60 characters by `MAX_PREVIEW_TITLE`, so three steps cover the
   * whole range.
   */
  test("shrinks as the title grows, and never grows", () => {
    const sizes = [4, 24, 25, 42, 43, 60].map((length) => titleSize("x".repeat(length)));
    for (let i = 1; i < sizes.length; i += 1) {
      expect(sizes[i]).toBeLessThanOrEqual(sizes[i - 1]);
    }
  });

  test("the longest allowed title still gets a readable size", () => {
    expect(titleSize("x".repeat(60))).toBeGreaterThanOrEqual(48);
  });

  test("an empty title does not produce a degenerate size", () => {
    expect(titleSize("")).toBeGreaterThan(0);
  });
});

describe("the node module stays actions-only", () => {
  const source = readFileSync(
    repoFile("apps/convex/functions/cardRender.ts"),
    "utf8",
  );
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  /**
   * A Convex `"use node"` module may define **actions and nothing else** — a
   * mutation or query in one fails the push with
   * `Only actions can be defined in Node.js`. That is not a lint: it took a
   * deploy to discover, and it is why `cardAssets.ts` exists at all.
   */
  test("cardRender.ts defines no query or mutation", () => {
    expect(code).toContain('"use node"');
    expect(code).not.toMatch(/\binternalMutation\s*\(/);
    expect(code).not.toMatch(/\binternalQuery\s*\(/);
    expect(code).not.toMatch(/\bmutation\s*\(/);
    expect(code).not.toMatch(/\bquery\s*\(/);
  });

  /**
   * The same line the edge renderer has, for the same reasons: without it
   * satori fetches fallback fonts from Google and Twemoji from jsDelivr on any
   * glyph miss — inside a render path, with note titles as the input.
   */
  test("remote asset loading stays disabled", () => {
    expect(code).toMatch(/loadAdditionalAsset:\s*async\s*\(\)\s*=>\s*""/);
  });

  test("names no font or emoji CDN in code", () => {
    expect(code).not.toContain("fonts.googleapis.com");
    expect(code).not.toContain("jsdelivr");
    // …and the comment explaining why is still there. Matched on the prose
    // rather than the hostname: this module names the CDNs in words, and an
    // assertion that required the literal host would push somebody to write it
    // into a file whose whole point is that it never appears.
    expect(source).toMatch(/Google Fonts/);
    expect(source).toMatch(/Twemoji/);
  });

  /**
   * The renderer takes a title and returns bytes. It must not reach a bucket:
   * `"use node"` is a runtime with far more surface than the default one, and
   * the whole point of keeping it credential-free is that it never becomes a
   * second door to a customer's storage key.
   */
  test("the renderer holds no credential and reaches no bucket", () => {
    expect(code).not.toContain("getBindingForGateway");
    expect(code).not.toContain("decryptSecret");
    expect(code).not.toContain("storeForBinding");
  });
});
