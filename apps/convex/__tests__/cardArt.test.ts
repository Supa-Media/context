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
 *  1. **The font is embedded as base64**, and a hand-edited or truncated
 *     string is a card that renders as nothing. The stamped digest is checked
 *     against the bytes that actually decode.
 *  1b. **The palette is a copy of `apps/mobile`'s tokens**, because
 *     `apps/convex` cannot import from it — so the copy is compared against
 *     that file here. A comment claiming two files agree is the thing this
 *     repo keeps finding untrue.
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
  CARD_SUBTITLE_FORM,
  CARD_WIDTH,
  cardElement,
  drawnKind,
  titleSize,
  type CardFacts,
} from "../functions/lib/cardArt";
import {
  CARD_FONT_SHA256,
  cardFont,
} from "../functions/lib/cardFont/instrumentSans";

/** A note card, with everything the caller may vary spelled out. */
function facts(over: Partial<CardFacts> = {}): CardFacts {
  return { title: "Chapter transition", handle: null, kind: "note", children: [], ...over };
}

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
   * header of `lib/cardFont/instrumentSans.ts` records `CARD_FONT_SHA256` as
   * the digest of the file the base64 came from, and a hand-edited or
   * truncated string would make that a lie.
   */
  test("the stamped hash is the hash of the embedded bytes", () => {
    const embedded = cardFont();
    const embeddedHash = createHash("sha256").update(embedded).digest("hex");
    expect(embeddedHash).toBe(CARD_FONT_SHA256);
  });

  test("decodes to a real TrueType file, not a truncated one", () => {
    const font = cardFont();
    expect(font.byteLength).toBeGreaterThan(40_000);
    // `0x00010000` is the sfnt version every TTF starts with.
    expect([...font.slice(0, 4)]).toEqual([0x00, 0x01, 0x00, 0x00]);
  });

  test("decodes once and hands back the same buffer", () => {
    expect(cardFont()).toBe(cardFont());
  });
});

/**
 * THE PALETTE IS A COPY, SO IT IS COMPARED WITH WHAT IT COPIES.
 *
 * `apps/convex` cannot import from `apps/mobile`, so `cardArt.ts` restates
 * Graphite's values as literals. That is the arrangement this repo keeps
 * finding go wrong: the card sat on `#050506` and `#3B82F6` for as long as it
 * took somebody to notice it did not look like the app any more, and no test
 * could have told them.
 *
 * So the token file is read as text and the drawn colours are looked up in it.
 * A palette change in the app now reddens this rather than quietly leaving the
 * card behind.
 */
describe("the card wears the app's palette", () => {
  const tokens = readFileSync(
    repoFile("apps/mobile/features/design/tokens/colors.ts"),
    "utf8",
  );
  const darkBlock = tokens.slice(
    tokens.indexOf("export const darkColors"),
    tokens.indexOf("export const lightColors"),
  );

  /** `ground: "#100F0E",` → `#100F0E`, out of the dark palette only. */
  function darkToken(name: string): string | null {
    const match = new RegExp(`\\b${name}:\\s*"([^"]+)"`).exec(darkBlock);
    return match?.[1] ?? null;
  }

  test("the token file still has a dark palette to compare against", () => {
    // Guards the extraction itself: a renamed export would make every lookup
    // below return null and every comparison vacuous.
    expect(darkBlock.length).toBeGreaterThan(500);
    expect(darkToken("ground")).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  test.each([
    ["ground", "#100F0E"],
    ["surface", "#191715"],
    ["text", "#EDE8E0"],
    ["text2", "#C3BCB2"],
    ["heroDim", "#7A736A"],
    ["accent", "#6BC8C1"],
    ["line", "rgba(237,232,224,0.07)"],
    ["lineStrong", "rgba(237,232,224,0.14)"],
  ])("%s matches the app's token", (name, drawn) => {
    expect(darkToken(name)).toBe(drawn);
    expect(JSON.stringify(cardElement(facts({ handle: "@seyi" })))).toContain(drawn);
  });

  /**
   * Petrol is the only hue, which is the token file's own rationing rule: it
   * means "here, active, yours" and is never a status. A card reports no
   * status, so a second hue on one would be a hue with no job.
   */
  test("and spends exactly one hue", () => {
    const drawn = JSON.stringify(cardElement(facts({ handle: "@seyi", kind: "form" })));
    const hues = [...drawn.matchAll(/#[0-9A-Fa-f]{6}/g)].map((m) => m[0]);
    const chromatic = hues.filter((hex) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      return Math.max(r, g, b) - Math.min(r, g, b) > 24;
    });
    expect([...new Set(chromatic)]).toEqual(["#6BC8C1"]);
  });
});

/**
 * WHOSE CONTEXT IT IS, AND WHEN THE CARD MAY SAY SO.
 *
 * The handle leads the card because a share is somebody's note being handed to
 * somebody else, and our domain in the position of most emphasis made every one
 * of them look like an advertisement.
 *
 * What bounds it is that `shareCard.ts` only ever supplies a handle for a link
 * whose address already carries one. This file cannot check that decision — it
 * has no row — so what it checks is that the absence is drawn as an absence,
 * because a `null` that rendered as "null" or as an empty corner would be the
 * failure nobody sees until it is on a CDN.
 */
describe("the lockup", () => {
  test("a handle leads, in the size a name deserves", () => {
    const drawn = JSON.stringify(cardElement(facts({ handle: "@seyi" })));
    expect(drawn).toContain("@seyi");
    expect(drawn).toContain('"fontSize":36');
  });

  test("no handle falls back to the domain rather than to a gap", () => {
    const drawn = JSON.stringify(cardElement(facts({ handle: null })));
    expect(drawn).not.toContain("null,");
    expect(drawn).not.toContain('"children":""');
    /*
      ONCE. This asserted twice when it was first written, because the code
      drew it twice — the lockup's fallback and an unconditional foot — and the
      test was written from the code rather than from the card. A domain
      repeated 400px below itself is the sort of thing nobody reports and
      everybody sees.
    */
    expect([...drawn.matchAll(/context\.lc/g)]).toHaveLength(1);
  });

  test("the domain is on every card, and never leads one", () => {
    const withHandle = JSON.stringify(cardElement(facts({ handle: "@seyi" })));
    expect(withHandle).toContain("context.lc");
    // Smaller than the handle above it: the domain is a footnote now.
    expect(withHandle).toContain('"fontSize":23');
  });
});

/**
 * WHAT THE LINK OPENS, AND THE SENTENCE THAT GOES WITH IT.
 */
describe("the kind chip", () => {
  test("a form says so, and tells nobody to sign in", () => {
    const drawn = JSON.stringify(cardElement(facts({ kind: "form", handle: "@seyi" })));
    expect(drawn).toContain("FORM");
    expect(drawn).toContain(CARD_SUBTITLE_FORM);
    // The one case where "sign in" is false: a collect link takes answers from
    // people with no account, so a card saying otherwise contradicts the page.
    expect(drawn).not.toMatch(/sign in/i);
  });

  test("everything else keeps the access sentence", () => {
    for (const kind of ["note", "folder"] as const) {
      const drawn = JSON.stringify(
        cardElement(facts({ kind, children: kind === "folder" ? ["a.md"] : [] })),
      );
      expect(drawn).toContain(CARD_SUBTITLE);
    }
  });

  test("no chip says anything about what is inside the thing", () => {
    for (const kind of ["note", "folder", "form"] as const) {
      const drawn = JSON.stringify(
        cardElement(facts({ kind, children: kind === "folder" ? ["a.md"] : [] })),
      );
      expect(drawn).not.toMatch(/private|team|owner|editor|member/i);
    }
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
    const a = JSON.stringify(cardElement(facts({ title: "One" })));
    const b = JSON.stringify(cardElement(facts({ title: "Two" })));
    expect(a.replace(/"One"/, "X")).toBe(b.replace(/"Two"/, "X"));
  });

  test("the title reaches the tree exactly as given", () => {
    expect(JSON.stringify(cardElement(facts({ title: "Café — it’s" })))).toContain(
      "Café — it’s",
    );
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
    walk(cardElement(facts()), "root");
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
    walk(
      cardElement(
        facts({ title: "Transition", kind: "folder", children: ["interviews/", "overview.md"], handle: "@seyi" }),
      ),
      "root",
    );
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
  /**
   * **Including the chip**, which is the half a redesign nearly lost.
   *
   * The folder mark this chip replaced appeared with the listing or not at
   * all. A `FOLDER` chip tied to the *row* instead would have drawn over an
   * otherwise empty card and said, permanently and to everybody the link
   * reached, "this is a folder and there is nothing in it for you".
   */
  test("no contents is the ordinary card, element for element", () => {
    expect(
      JSON.stringify(cardElement(facts({ title: "Transition", kind: "folder" }))),
    ).toBe(JSON.stringify(cardElement(facts({ title: "Transition", kind: "note" }))));
  });

  test("...which is `drawnKind` narrowing the row's answer, not the caller's job", () => {
    expect(drawnKind("folder", [])).toBe("note");
    expect(drawnKind("folder", ["a.md"])).toBe("folder");
    // Only the folder case narrows: a collect link is over a note and has no
    // listing of its own, so tying it to `children` would silence every one.
    expect(drawnKind("form", [])).toBe("form");
    expect(drawnKind("note", [])).toBe("note");
  });

  test("contents bring the chip and the names", () => {
    const plain = JSON.stringify(cardElement(facts({ title: "Transition" })));
    const folder = JSON.stringify(
      cardElement(
        facts({ title: "Transition", kind: "folder", children: ["interviews/", "overview.md"] }),
      ),
    );

    expect(folder).not.toBe(plain);
    // One text node, joined exactly as the `og:description` joins it, so the
    // picture and the text cannot say different things about one folder.
    expect(folder).toContain("interviews/ · overview.md");
    expect(folder).toContain("FOLDER");
    // Uppercase Latin, so the bundled face draws it and `cardCoverage.ts` has
    // nothing to say — which is why the card has one font rather than two.
    expect(folder).not.toContain("\u25a1");
  });

  /**
   * This module draws what it is handed and derives no bound of its own. The
   * bounds live in `lib/shareTitle.ts`, are re-applied in `previewForNote`, and
   * are applied a third time at the edge — a drawing function that re-decided a
   * security question would be a fourth place for it to be answered wrong.
   */
  test("it draws what it is given, and invents nothing", () => {
    const drawn = JSON.stringify(cardElement(facts({ title: "Transition", kind: "folder", children: ["a", "b", "c"] })));
    expect(drawn).toContain("a · b · c");
    // No count, no "and 4 more". A total is the addition this card must not
    // grow: over the folder rather than over the visible set it is an existence
    // oracle by subtraction.
    expect(drawn).not.toMatch(/more/i);
    expect(drawn).not.toMatch(/\+\d/);
  });

  /** A child's own text reaches the tree untouched, exactly as the title does. */
  test("a name reaches the tree exactly as given", () => {
    expect(JSON.stringify(cardElement(facts({ title: "T", kind: "folder", children: ["Café — it’s.md"] })))).toContain(
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
