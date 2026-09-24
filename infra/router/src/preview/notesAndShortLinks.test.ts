// Split out of `preview.test.ts`: note previews and short links.
// `crawlersAndCards.test.ts` covers crawler detection and the
// marketing/OG-card checks; `shareLinks.test.ts` covers share and team
// links. `fixtures.ts` holds the shared imports and helpers.
import { describe, expect, it } from "vitest";
import {
  ogCard,
  GENERIC_PREVIEW,
  OG_CARD_PATH,
  escapeHtml,
  isCrawler,
  previewFor,
  previewForShare,
  previewFromProfile,
  renderPreviewHtml,
  shareTokenFrom,
  consoleNoteFrom,
  previewForNote,
  shortLinkFrom,
  previewForShortLink,
  shortLinkCardFrom,
  shortLinkCardPath,
  route,
  shareSegmentCases,
  shortLinkSlugCases,
  previewHtml,
  meta,
} from "./fixtures";

/**
 * WHAT A FOLDER LINK SAYS IS INSIDE IT, AT THE EDGE.
 *
 * The control plane decides *which* names may be published — only what a `team`
 * reader may see, only for a folder the owner explicitly linked — and bounds
 * them twice on the way out. This file bounds them a third time, for the reason
 * `previewForShare`'s title bound is applied here as well: **an edge that
 * trusts its upstream to have been careful has no bound at all.**
 *
 * What must not change: an absent title is still the frozen card byte for byte,
 * whatever else the upstream sent; the canonical URL is still the site root;
 * `noindex` still survives.
 */
describe("previewForNote: a folder link names what is inside it", () => {
  const TOKEN = "a".repeat(64);

  it("puts the contents in the description", () => {
    const meta = previewForNote("Transition", TOKEN, [
      "interviews/",
      "overview.md",
    ]);
    expect(meta.description).toContain("interviews/");
    expect(meta.description).toContain("overview.md");
    expect(meta.description).toMatch(/sign in/i);
  });

  it("a note's card is unchanged, word for word", () => {
    expect(previewForNote("Chapter transition", TOKEN, [])).toEqual(
      previewForNote("Chapter transition", TOKEN),
    );
  });

  /**
   * **THE test, and the one the whole feature has to survive.** Unlinked,
   * revoked, expired, title switched off, control plane unreachable — every one
   * arrives as a falsy title, and every one renders the frozen card. Contents
   * arriving without a title publish nothing: a title is what licenses a card
   * to say anything at all, and this is the shape a compromised or
   * newer-than-this-deployment upstream would take.
   */
  it.each([[null], [undefined], [""], ["   "]])(
    "contents with no title (%p) are still the frozen card, byte for byte",
    (title) => {
      expect(
        renderPreviewHtml(previewForNote(title, TOKEN, ["overview.md", "notes/"])),
      ).toBe(renderPreviewHtml(GENERIC_PREVIEW));
    },
  );

  it("never names more than three, whatever the upstream sent", () => {
    const meta = previewForNote("Transition", TOKEN, [
      "one.md",
      "two.md",
      "three.md",
      "four.md",
      "five.md",
    ]);
    expect(meta.description).not.toContain("four.md");
    expect(meta.description).not.toContain("five.md");
  });

  it("truncates a name rather than dropping it", () => {
    const meta = previewForNote("Transition", TOKEN, [`${"x".repeat(200)}.md`]);
    expect(meta.description).toContain("x".repeat(40));
    expect(meta.description).not.toContain("x".repeat(41));
  });

  /**
   * This is parsed JSON off the wire, so "an array of strings" is a claim and
   * not a fact. An object that reached `join` would be `[object Object]` on
   * somebody's card.
   */
  it.each([
    [[1, 2, 3]],
    [[{ name: "overview.md" }]],
    [[null, undefined]],
    ["not an array" as unknown as unknown[]],
    [[""]],
  ])("ignores an upstream that answered with %p", (children) => {
    const meta = previewForNote("Transition", TOKEN, children as unknown[]);
    expect(meta).toEqual(previewForNote("Transition", TOKEN));
  });

  /**
   * A filename comes out of a bucket we do not own. A newline inside an
   * `og:description` renders differently in every unfurler and escaping has
   * nothing to escape it *to*, so it is stripped rather than encoded — the same
   * treatment the control plane gives it, applied again here.
   */
  it("strips control characters out of a name", () => {
    const hostile = `over${String.fromCharCode(10)}view${String.fromCharCode(27)}.md`;
    const meta = previewForNote("Transition", TOKEN, [hostile]);
    expect(meta.description).toContain("over view .md");
    expect(meta.description).not.toMatch(/\p{Cc}/u);
  });

  /**
   * `Cf` beside `Cc`, and it needs its own check because the categories are
   * disjoint: U+202E RIGHT-TO-LEFT OVERRIDE, the U+2066 isolates and U+200B
   * ZERO WIDTH SPACE are all `Cf` and none of them is `Cc`. A bidi override
   * reverses the rendering of the text after it in most unfurlers, under this
   * product's own branding, on a card that cannot be retracted once cached.
   *
   * This exists because the line it covers carried a comment saying "the two
   * copies are held by running both, not by this comment" while nothing here
   * ran the router's copy at all — narrowing it back to `\p{Cc}` passed all 221
   * of these tests. The control plane strips first, so this layer is defence in
   * depth; a guard nobody has checked is not a guard either way.
   */
  it("strips format characters, which are a different category", () => {
    const hostile = `a\u202Egnp.exe\u202D\u2066x\u2069\u200Bb.md`;
    const meta = previewForNote("Transition", TOKEN, [hostile]);
    for (const format of ["\u202E", "\u202D", "\u2066", "\u2069", "\u200B"]) {
      expect(meta.description).not.toContain(format);
    }
    expect(meta.description).toContain("gnp.exe");
  });

  it("a hostile name cannot break out of the markup either", () => {
    const html = renderPreviewHtml(
      previewForNote("Transition", TOKEN, ["</title><script>alert(1)</script>"]),
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("still refuses everything the frozen card refuses", () => {
    const html = renderPreviewHtml(
      previewForNote("Transition", "b".repeat(64), ["overview.md"]),
    );
    expect(html).toContain('<link rel="canonical" href="https://context.lc/">');
    expect(meta(html, "name", "robots")).toEqual(["noindex, nofollow"]);
    expect(html).not.toContain("seyi");
    expect(html).not.toContain("1-projects");
  });

  /**
   * The card image's URL carries a hash of everything drawn on it, because the
   * Workers cache is per-datacenter with no global purge — a changed URL is the
   * only invalidation there is. A folder whose contents changed must ask for a
   * different one.
   */
  it("changing the contents changes the card URL", () => {
    const before = previewForNote("Transition", TOKEN, ["overview.md"]).imageUrl;
    expect(previewForNote("Transition", TOKEN, ["timeline.md"]).imageUrl).not.toBe(
      before,
    );
    expect(previewForNote("Transition", TOKEN, ["overview.md"]).imageUrl).toBe(before);
    // …and a note's URL is exactly what it was before folders had contents.
    expect(previewForNote("Transition", TOKEN, []).imageUrl).toBe(
      previewForNote("Transition", TOKEN).imageUrl,
    );
  });
});

/**
 * THE EDGE STRIPS THE TITLE THE WAY IT ALREADY STRIPS THE NAMES UNDER IT.
 *
 * `boundChildren` removes `Cc`/`Cf` from every child name and says why. The
 * title -- the more prominent field, and the one an unlisted card is built
 * entirely from -- was bounded for *length* here and not cleaned, so the rule
 * this file states in its own words ("an edge that trusts its upstream to have
 * been careful has no bound at all") was applied to one field of the response
 * and not the other.
 *
 * The control plane strips it at the source now too. Both, because that is how
 * two copies of a rule are held here -- by running both against the same
 * shapes, not by a comment saying they agree.
 */
describe("a title from upstream is stripped, not only shortened", () => {
  const RLO = "\u202E";
  const NEL = "\u0085";
  const ZWSP = "\u200B";

  it("keeps a bidi override out of og:title on a share card", () => {
    const meta = previewForShare(`Salary${RLO}gnp.exe`);
    expect(meta.title).toContain("gnp.exe");
    for (const hostile of [RLO, NEL, ZWSP]) expect(meta.title).not.toContain(hostile);
  });

  it("and out of a note card's title", () => {
    const meta = previewForNote(`Report${RLO}fdp`, null, []);
    expect(meta.title).not.toContain(RLO);
  });

  it("a title that is only format characters renders the generic card", () => {
    expect(previewForShare(`${RLO}${ZWSP}${NEL}`)).toEqual(GENERIC_PREVIEW);
  });

  it("an ordinary title is untouched", () => {
    expect(previewForShare("Chapter transition").title).toBe("Chapter transition — Context");
  });

  /**
   * ...and cleaned BEFORE it is bounded, which is the ordering `boundTitle`'s
   * comment claims and nothing was checking: swapping to clean-after-bound left
   * all 291 green. Sixty format characters in front of a real title push every
   * readable byte past the cut, so the card falls back to generic — fail-closed
   * rather than a leak, and still the title the owner chose, gone.
   */
  it("cleans before it bounds, so padding cannot push the title past the cut", () => {
    const padded = `${ZWSP.repeat(60)}Chapter transition`;
    expect(previewForShare(padded).title).toBe("Chapter transition — Context");
  });
});


/* ────────────────────────────────────────────────────────────────────────────
 * SHORT LINKS — `/@seyi/intake`
 * ──────────────────────────────────────────────────────────────────────────── */

describe("a short link's address", () => {
  it("a handle and a name parse", () => {
    expect(shortLinkFrom(new URL("https://context.lc/@seyi/intake"))).toEqual({
      handle: "seyi",
      slug: "intake",
    });
    expect(shortLinkFrom(new URL("https://context.lc/@seyi/intake/"))).toEqual({
      handle: "seyi",
      slug: "intake",
    });
  });

  it.each([
    ["https://context.lc/@seyi", "the handle alone, which stays frozen"],
    ["https://context.lc/seyi/intake", "no @, so it is an ordinary page"],
    ["https://context.lc/@seyi/intake/extra", "a third segment"],
    ["https://context.lc/@Seyi/intake", "an uppercase handle never claimed"],
    ["https://context.lc/@seyi/Intake", "an uppercase name never claimed"],
    ["https://context.lc/@seyi/../etc/passwd", "traversal"],
    ["https://context.lc/@seyi/%2e%2e", "encoded traversal"],
    ["https://context.lc/@/intake", "no handle at all"],
  ])("%s is not a short link (%s)", (href: string) => {
    expect(shortLinkFrom(new URL(href))).toBeNull();
  });

  /**
   * The shape rule lives twice — here and in the control plane, which this
   * package cannot import from. Both copies run this corpus, so they are
   * compared against the same cases rather than against a comment.
   *
   * `claimable` is deliberately NOT checked here: the router does not know
   * which words are reserved, and should not. A reserved word is a
   * well-formed address that resolves to nothing upstream, which is one place
   * deciding rather than two.
   */
  it("the shape agrees with the control plane's copy, case for case", () => {
    for (const item of shortLinkSlugCases.cases) {
      const url = new URL(`https://context.lc/@seyi/${item.segment}`);
      expect(
        shortLinkFrom(url) !== null,
        `${JSON.stringify(item.segment)} parses`,
      ).toBe(item.parses);
    }
    expect(shortLinkSlugCases.cases.length).toBeGreaterThan(20);
    expect(shortLinkSlugCases.cases.some((item) => item.parses)).toBe(true);
    expect(shortLinkSlugCases.cases.some((item) => !item.parses)).toBe(true);
  });
});

describe("what a short link unfurls with", () => {
  it("the note's name", () => {
    const meta = previewForShortLink("New project intake");
    expect(meta.title).toBe("New project intake — Context");
  });

  it("and its own card image, addressed by the name rather than by a token", () => {
    /*
      This asserted the opposite until short links learned to unfurl, and the
      reason it did is still true: a short link may sit over an `anyone` share
      where the token IS the authorization, so `/share/short` returns no token
      and this file must never build a URL from one.

      What changed is the address. The card is at the handle and slug the
      crawler already typed, so the image arrives and nothing is published —
      which is what this now checks, including that no 64-hex token appears
      anywhere in the URL.
    */
    const url = previewForShortLink("New project intake", "seyi", "intake", "abcd1234")
      .imageUrl;
    expect(url).toBe("https://context.lc/og/n/@seyi/intake.png?v=abcd1234");
    expect(url).not.toMatch(/[0-9a-f]{64}/);
  });

  it("falls back to the product card when there is no card to point at", () => {
    // No version is every reason a card can be missing: never rendered, render
    // failed, bucket refused, title changed since the last successful render.
    // All of them are the same absence a revoked link gives.
    for (const version of [null, undefined, "", "nothex!!", "abcd123"]) {
      expect(
        previewForShortLink("New project intake", "seyi", "intake", version).imageUrl,
      ).toBe(GENERIC_PREVIEW.imageUrl);
    }
  });

  it("refuses to build a card URL out of a handle or slug it would not route", () => {
    // The value is interpolated into a URL our own tags point at. "Upstream
    // would not send anything else" is the assumption that turns a path built
    // by concatenation into a redirect.
    for (const [handle, slug] of [
      ["seyi/../..", "intake"],
      ["seyi", "in take"],
      ["SEYI", "intake"],
      ["seyi", "-intake"],
      ["", "intake"],
      ["seyi", ""],
    ] as const) {
      expect(
        previewForShortLink("New project intake", handle, slug, "abcd1234").imageUrl,
      ).toBe(GENERIC_PREVIEW.imageUrl);
    }
  });

  it("every absence is the generic card, byte for byte", () => {
    for (const title of [null, undefined, "", "   "]) {
      expect(previewForShortLink(title)).toEqual(GENERIC_PREVIEW);
      expect(previewForShortLink(title, "seyi", "intake", "abcd1234")).toEqual(
        GENERIC_PREVIEW,
      );
    }
  });
});

describe("shortLinkCardFrom", () => {
  it("reads the two halves of a card address", () => {
    expect(shortLinkCardFrom("/og/n/@seyi/intake.png")).toEqual({
      handle: "seyi",
      slug: "intake",
    });
  });

  it("refuses anything that could never have been claimed", () => {
    // Shape-checked before anything is fetched, exactly as `shortLinkFrom` is:
    // a path that could never name a real card never becomes an upstream
    // request, so hammering this address costs a regex rather than a round
    // trip somebody can time.
    for (const path of [
      "/og/n/seyi/intake.png",
      "/og/n/@seyi/intake",
      "/og/n/@seyi.png",
      "/og/n/@seyi/intake/extra.png",
      "/og/n/@seyi/IN TAKE.png",
      "/og/n/@SEYI/intake.png",
      "/og/n/@seyi/-intake.png",
      "/og/n/@/intake.png",
      "/og/s/@seyi/intake.png",
      "/og/card.png",
    ]) {
      expect(shortLinkCardFrom(path), path).toBeNull();
    }
  });

  it("round-trips the path the preview builds", () => {
    // The two halves are written in different files and read in a third. A
    // builder and a parser that disagree is a card address that 404s for a
    // link that works, which is the generic image with extra steps.
    expect(shortLinkCardFrom(shortLinkCardPath("seyi", "intake", "abcd1234").split("?")[0]!))
      .toEqual({ handle: "seyi", slug: "intake" });
  });
});
