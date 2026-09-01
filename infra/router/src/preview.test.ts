import { describe, expect, it } from "vitest";
// The same import src/index.ts serves the card from, resolved the same way:
// wrangler.jsonc's `Data` rule in production, vitest.config.ts's matching
// plugin here. Reading the file with node:fs instead would test a different
// artefact — and would need @types/node, which this Worker has no other use
// for.
import ogCard from "./og-card.png";
import {
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
} from "./preview";
import { route } from "./route";
import shareSegmentCases from "./shareSegment.fixtures.json";
// The app's copy of this rule, imported so a corpus change is checked against
// both implementations in the one suite the corpus's own directory triggers.
import { shareTokenFromSegment } from "../../../apps/mobile/features/share/share";

/** Render whatever a crawler asking for `pathname` would be sent. */
function previewHtml(pathname: string): string {
  return renderPreviewHtml(previewFor(pathname));
}

/** Pull the `content` of a `<meta>` identified by an attribute. */
function meta(html: string, attr: "property" | "name", key: string): string[] {
  const pattern = new RegExp(
    `<meta ${attr}="${key}" content="([^"]*)">`,
    "g",
  );
  return [...html.matchAll(pattern)].map((m) => m[1]!);
}

describe("isCrawler: the unfurlers people actually paste links into", () => {
  it.each([
    ["Slackbot", "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)"],
    ["Twitter/X", "Twitterbot/1.0"],
    [
      "Facebook",
      "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
    ],
    ["WhatsApp", "WhatsApp/2.23.20.0 A"],
    ["Discord", "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)"],
    ["LinkedIn", "LinkedInBot/1.0 (compatible; Mozilla/5.0; Jakarta Commons)"],
    ["Telegram", "TelegramBot (like TwitterBot)"],
    ["iMessage / Apple", "Mozilla/5.0 (compatible; Applebot/0.1)"],
    ["Google", "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"],
    ["Bing", "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)"],
    ["Mastodon", "http.rb/5.1.1 (Mastodon/4.2.1; +https://mastodon.social/)"],
    ["an unfurler nobody has heard of yet", "SomeNewPreviewBot/1.0 (+https://example.com)"],
    ["generic crawler token", "acme-crawler (+http://acme.test)"],
    ["generic spider token", "Bytespider"],
  ])("%s is a crawler", (_name, ua) => {
    expect(isCrawler(ua)).toBe(true);
  });

  it.each([
    [
      "Chrome on macOS",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    ],
    [
      "Safari on iPhone",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) " +
        "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1",
    ],
    [
      "Firefox",
      "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
    ],
    ["curl", "curl/8.7.1"],
  ])("%s is not", (_name, ua) => {
    expect(isCrawler(ua)).toBe(false);
  });

  it("a missing User-Agent is a person, not a crawler", () => {
    expect(isCrawler(undefined)).toBe(false);
    expect(isCrawler(null)).toBe(false);
    expect(isCrawler("")).toBe(false);
  });

  it.each([
    "Mozilla/5.0 (Linux; Android 13; CUBOT_X30) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
    "Mozilla/5.0 (Linux; Android 11; CUBOT NOTE 20) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  ])("does not mistake a Cubot handset for a robot", (ua) => {
    // The reason the generic fallback stands down for anything advertising a
    // browser engine. Cubot is a real Android phone brand and the model name
    // lands in the UA; a bare `includes("bot")` — which is what Togather's
    // worker does — would serve the preview shell to a person, and the app
    // would simply never load for them.
    expect(isCrawler(ua)).toBe(false);
  });

  it("still catches a crawler that advertises Chrome, by name", () => {
    // Googlebot's modern UA carries both Chrome/ and Safari/. The named list
    // is checked before the browser-engine escape hatch for exactly this.
    expect(
      isCrawler(
        "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html) " +
          "Chrome/140.0.0.0 Safari/537.36",
      ),
    ).toBe(true);
  });
});

describe("previewFor: only the marketing routes get their own card", () => {
  it("/ is the product", () => {
    expect(previewFor("/").title).toContain("Free your context");
  });

  it("/ and the empty path are one route", () => {
    expect(previewFor("")).toBe(previewFor("/"));
  });

  it("/login and /login/ are one route", () => {
    expect(previewFor("/login/")).toBe(previewFor("/login"));
    expect(previewFor("/login").title).toBe("Sign in — Context");
  });

  it.each([
    "/@alice",
    "/@alice/1-projects/roadmap.md",
    "/w/acme",
    "/console",
    "/console/storage",
    "/share/abc123",
    "/totally-made-up",
    "/does/not/exist/at/all",
    "/loginx",
    "/login/extra",
  ])("%s is the generic card", (pathname) => {
    expect(previewFor(pathname)).toBe(GENERIC_PREVIEW);
  });

  it("an unknown path is the product, never a 404", () => {
    // A crawler asking for nonsense gets a card, not an error page — an error
    // would be a signal in itself, and would look broken in a chat unfurl.
    const html = previewHtml("/nope");
    expect(html).toContain("<title>Context</title>");
  });
});

describe("previewFor: a context link reveals nothing", () => {
  // THE TEST THIS WHOLE MODULE EXISTS FOR.
  //
  // A crawler is unauthenticated and unrevocable. If the card for a name that
  // exists differed in any way from the card for one that does not — a word, a
  // canonical URL, a byte — then anyone holding a link, or merely sitting in a
  // channel where one was pasted, could enumerate who has an account. The
  // control plane refuses to be that oracle
  // (apps/convex/functions/lib/workspaceAuth.ts); the edge must not become one.
  const contextLinks = [
    "/@alice",
    "/@bob",
    "/@does-not-exist-anywhere",
    "/@a",
    "/@alice/1-projects/roadmap.md",
    "/@bob/4-archive/old.md",
    "/w/acme",
    "/w/never-existed",
    "/share/abcdef",
  ];

  const [first, ...rest] = contextLinks;

  it.each(rest)(
    "%s is byte-identical to " + first,
    (pathname) => {
      expect(previewHtml(pathname)).toBe(previewHtml(first!));
    },
  );

  it("the whole set collapses to exactly one distinct response body", () => {
    const bodies = new Set(contextLinks.map(previewHtml));
    expect(bodies.size).toBe(1);
  });

  it("no requested name appears anywhere in the response", () => {
    const html = previewHtml("/@alice/1-projects/roadmap.md");
    for (const fragment of ["alice", "roadmap", "1-projects"]) {
      expect(html.toLowerCase()).not.toContain(fragment);
    }
  });

  it("the canonical URL is the site root, not the requested path", () => {
    // Echoing the path back would make two context links differ by their own
    // bytes, which is the leak this file is built to avoid.
    const html = previewHtml("/@alice");
    expect(meta(html, "property", "og:url")).toEqual(["https://context.lc/"]);
    expect(html).toContain('<link rel="canonical" href="https://context.lc/">');
  });

  it("keeps context links out of search results", () => {
    expect(meta(previewHtml("/@alice"), "name", "robots")).toEqual([
      "noindex, nofollow",
    ]);
  });

  it("says nothing about existence, ownership, size, or membership", () => {
    const html = previewHtml("/@alice").toLowerCase();
    for (const leak of [
      "member",
      "note",
      "folder",
      "owner",
      "@",
      "not found",
      "private",
    ]) {
      expect(html).not.toContain(leak);
    }
  });
});

describe("renderPreviewHtml: the tags crawlers actually read", () => {
  const html = previewHtml("/");

  it("carries the OpenGraph set", () => {
    expect(meta(html, "property", "og:type")).toEqual(["website"]);
    expect(meta(html, "property", "og:site_name")).toEqual(["Context"]);
    expect(meta(html, "property", "og:title")[0]).toContain("Free your context");
    expect(meta(html, "property", "og:description")[0]).toContain(
      "One MCP endpoint",
    );
    expect(meta(html, "property", "og:url")).toEqual(["https://context.lc/"]);
  });

  it("declares a large Twitter card", () => {
    expect(meta(html, "name", "twitter:card")).toEqual(["summary_large_image"]);
    expect(meta(html, "name", "twitter:title")).toHaveLength(1);
    expect(meta(html, "name", "twitter:description")).toHaveLength(1);
    expect(meta(html, "name", "twitter:image")).toHaveLength(1);
  });

  it("carries a plain description for crawlers that read no OG at all", () => {
    expect(meta(html, "name", "description")[0]).toContain("One MCP endpoint");
  });

  it("gives image URLs absolutely, with the dimensions crawlers want", () => {
    // A relative og:image is dropped by most unfurlers, and a card without
    // declared dimensions renders small while the fetch is still in flight.
    const expected = `https://context.lc${OG_CARD_PATH}`;
    expect(meta(html, "property", "og:image")).toEqual([expected]);
    expect(meta(html, "property", "og:image:secure_url")).toEqual([expected]);
    expect(meta(html, "name", "twitter:image")).toEqual([expected]);
    expect(meta(html, "property", "og:image:type")).toEqual(["image/png"]);
    expect(meta(html, "property", "og:image:width")).toEqual(["1200"]);
    expect(meta(html, "property", "og:image:height")).toEqual(["630"]);
    expect(meta(html, "property", "og:image:alt")).toHaveLength(1);
  });

  it("uses the same card on every route", () => {
    // The image must not vary by slug either — a per-workspace card would leak
    // through the picture what the text is careful not to say.
    const images = ["/", "/login", "/@alice", "/nope"].map(
      (p) => meta(previewHtml(p), "property", "og:image")[0],
    );
    expect(new Set(images).size).toBe(1);
  });

  it("is a complete, well-formed document", () => {
    expect(html.startsWith("<!DOCTYPE html>\n<html lang=\"en\">")).toBe(true);
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    // One <title>, one canonical, balanced head/body.
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html.match(/<link rel="canonical"/g)).toHaveLength(1);
    expect(html.match(/<head>/g)).toHaveLength(1);
    expect(html.match(/<\/head>/g)).toHaveLength(1);
    expect(html.match(/<body>/g)).toHaveLength(1);
    expect(html.match(/<\/body>/g)).toHaveLength(1);
  });

  it("has no unescaped stray quote inside any meta content", () => {
    // Every content="…" must close on its own attribute, so the count of
    // `content="` occurrences equals the count of complete meta tags.
    const opens = html.match(/ content="/g) ?? [];
    const complete = html.match(/ content="[^"]*">/g) ?? [];
    expect(complete).toHaveLength(opens.length);
  });

  it("ships no script of its own", () => {
    expect(html).not.toContain("<script");
  });

  it("is deterministic", () => {
    expect(previewHtml("/")).toBe(previewHtml("/"));
  });

  it("renders a routable page for /login too", () => {
    const login = previewHtml("/login");
    expect(meta(login, "property", "og:url")).toEqual([
      "https://context.lc/login",
    ]);
    expect(meta(login, "name", "robots")).toEqual(["noindex, follow"]);
  });
});

describe("escapeHtml: injection is impossible even if a literal goes bad", () => {
  // Nothing user-supplied reaches the template today — every string comes from
  // the frozen table in preview.ts. This proves the second line of defence
  // anyway, because "the inputs are all constants" is a property a future edit
  // could quietly drop.
  it("neutralises the attribute-escape payload", () => {
    expect(escapeHtml('"><script>alert(1)</script>')).toBe(
      "&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });

  it("escapes the ampersand first, so nothing is double-encoded wrongly", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  it("escapes single quotes, for single-quoted attribute contexts", () => {
    expect(escapeHtml("it's")).toBe("it&#39;s");
  });

  it("renders a hostile title as inert text, not as markup", () => {
    const html = renderPreviewHtml({
      ...GENERIC_PREVIEW,
      title: '"><img src=x onerror=alert(1)>',
    });

    // The payload survives as characters — that is fine, and unavoidable for
    // text. What must not survive is its structure: no new tag, and no early
    // close of the attribute it sits in.
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain(
      '<meta property="og:title" content="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;">',
    );
    const opens = html.match(/ content="/g) ?? [];
    const complete = html.match(/ content="[^"]*">/g) ?? [];
    expect(complete).toHaveLength(opens.length);
  });
});

describe("previewFromProfile: the opt-in seam, which nothing calls yet", () => {
  // The control-plane field does not exist. These tests pin the contract the
  // renderer must keep, so that whoever adds the lookup has a failing test to
  // aim at rather than a blank page.
  it.each([
    ["absent", undefined],
    ["null", null],
    ["an empty name", { displayName: "" }],
    ["whitespace only", { displayName: "   " }],
  ])("falls back to the generic card when the profile is %s", (_case, profile) => {
    expect(previewFromProfile(profile)).toBe(GENERIC_PREVIEW);
  });

  it("shows the chosen label and nothing else", () => {
    const meta = previewFromProfile({ displayName: "Acme Platform Notes" });
    expect(meta.title).toBe("Acme Platform Notes — Context");
    // Everything else is still the generic card: same description, same
    // image, same root canonical, still out of search.
    expect(meta.description).toBe(GENERIC_PREVIEW.description);
    expect(meta.canonical).toBe(GENERIC_PREVIEW.canonical);
    expect(meta.imageAlt).toBe(GENERIC_PREVIEW.imageAlt);
    expect(meta.robots).toBe(GENERIC_PREVIEW.robots);
  });

  it("bounds the label, so the response size cannot be steered", () => {
    const meta = previewFromProfile({ displayName: "x".repeat(4096) });
    expect(meta.title).toBe(`${"x".repeat(60)} — Context`);
  });

  it("escapes a hostile label when rendered", () => {
    const html = renderPreviewHtml(
      previewFromProfile({ displayName: '"><script>x()</script>' }),
    );
    expect(html).not.toContain("<script>x()");
    const opens = html.match(/ content="/g) ?? [];
    const complete = html.match(/ content="[^"]*">/g) ?? [];
    expect(complete).toHaveLength(opens.length);
  });

  it("is not reachable from routing today", async () => {
    // The guard that matters: opting in is a control-plane feature that does
    // not exist, so every real request still renders GENERIC_PREVIEW. If
    // someone wires a lookup in without the constant-time and
    // indistinguishable-negative guarantees documented in preview.ts, the
    // byte-identity tests above start failing — which is the point.
    const { route } = await import("./route");
    expect(
      route(new URL("https://context.lc/@alice"), "Twitterbot/1.0"),
    ).toEqual({ kind: "preview", meta: GENERIC_PREVIEW });
  });
});

describe("the OG card asset", () => {
  const bytes = new Uint8Array(ogCard);
  const view = new DataView(ogCard);
  const ascii = (from: number, to: number) =>
    String.fromCharCode(...bytes.subarray(from, to));

  it("is a real PNG", () => {
    expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });

  it("is 1200x630, the size the meta tags promise", () => {
    // IHDR is always the first chunk: 8 bytes of signature, 4 of length, 4 of
    // type, then width and height as big-endian uint32s. A card whose real
    // dimensions disagree with og:image:width/height renders letterboxed or
    // cropped, differently in every client.
    expect(ascii(12, 16)).toBe("IHDR");
    expect(view.getUint32(16)).toBe(1200);
    expect(view.getUint32(20)).toBe(630);
  });

  it("is small enough to live inside the Worker bundle", () => {
    // Workers cap the script at 3 MB. The card is the only large thing in it,
    // so keeping it well under 200 KB leaves the budget for code.
    expect(ogCard.byteLength).toBeLessThan(200 * 1024);
  });
});

describe("share links: the one card that may say something", () => {
  // The exception to the rule the block above tests, and the tests here are
  // what keep it an exception rather than a hole. Read `previewForShare` in
  // preview.ts before changing any of them.

  it("only a well-formed token is a share link", () => {
    const token = "a".repeat(64);
    expect(shareTokenFrom(`/s/${token}`)).toBe(token);
    expect(shareTokenFrom(`/s/${token}/`)).toBe(token);
  });

  it.each([
    ["/s/", "no token at all"],
    ["/s/short", "too short"],
    ["/s/" + "a".repeat(63), "one character short"],
    ["/s/" + "a".repeat(65), "one character long"],
    ["/s/" + "A".repeat(64), "uppercase — not what randomOpaqueToken emits"],
    ["/s/" + "g".repeat(64), "not hex"],
    ["/s/" + "a".repeat(64) + "/extra", "a second segment"],
    ["/s/../../etc/passwd", "traversal"],
    ["/share/" + "a".repeat(64), "the frozen prefix, which stays frozen"],
    ["/@alice", "a name-bearing path"],
  ])("%s is not a share link (%s)", (pathname) => {
    expect(shareTokenFrom(pathname)).toBeNull();
  });

  /**
   * The shape check is what stops `/s/<garbage>` from reaching the control
   * plane at all — so the obvious probe (hammer the prefix and time the
   * answers) never gets a lookup to time.
   */
  it("a malformed token never becomes a lookup", () => {
    const decision = route(new URL("https://context.lc/s/nope"), "Slackbot");
    expect(decision.kind).toBe("preview");
  });

  it("a well-formed token routes to the lookup branch", () => {
    const token = "b".repeat(64);
    const decision = route(new URL(`https://context.lc/s/${token}`), "Slackbot");
    expect(decision).toEqual({ kind: "share-preview", token });
  });

  it("a human gets the app, not a card", () => {
    const token = "b".repeat(64);
    const decision = route(
      new URL(`https://context.lc/s/${token}`),
      "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
    );
    expect(decision.kind).toBe("proxy");
  });

  /**
   * The router's half of one rule that lives in two deployments.
   *
   * `shareTokenFromSegment` in `apps/mobile/features/share/share.ts` reads the
   * same URL shape and cannot be imported here, so both run over the corpus in
   * `shareSegment.fixtures.json` and neither is trusted to match a comment.
   * The one that matters most is `token` being read off the **end**: a slug is
   * whatever the owner's note is called, so it can contain hex, and a search
   * rather than an anchor would let a title decide which token was looked up.
   */
  it.each(shareSegmentCases.cases.map((c) => [c.why, c.segment, c.token] as const))(
    "%s",
    (_why, segment, token) => {
      expect(shareTokenFrom(`/s/${segment}`)).toBe(token);
    },
  );

  /**
   * AND THE CORPUS ITSELF IS PINNED, BECAUSE IT IS THE ONLY THING HOLDING THE
   * TWO COPIES TOGETHER.
   *
   * Both suites run it — sabotage either parser from an anchor to a search and
   * six checks fail on each side — but nothing was checking its *size*.
   * Deleting all twelve negative cases left both suites green at their previous
   * counts, and the concrete hole that leaves is measurable: relaxing
   * `^([A-Za-z0-9][A-Za-z0-9-]*)` to `^([A-Za-z0-9-]+)` in one copy passed
   * every check, because the corpus had `-<64hex>` and not `--<64hex>`.
   *
   * An enumeration nobody checks the size of is a list that shrinks, which is
   * the discipline `UNAUTHENTICATED_HTTP_ROUTES` and `CREDENTIAL_BARRIERS`
   * already follow one repository over. The floor is asserted rather than the
   * exact count, so adding a case is free and removing one is not.
   */
  /**
   * BOTH PARSERS, IN THE SUITE THE CORPUS'S OWN DIRECTORY TRIGGERS.
   *
   * The corpus exists to hold `shareTokenFrom` here and
   * `shareTokenFromSegment` in `apps/mobile` together, and both suites do run
   * it — but only one of them runs in CI when the corpus changes. The file
   * lives under `infra/router/src/`, so editing it triggers `router.yml`
   * (`paths: infra/router/**`) while the reusable workflow's change detection
   * skips `ci / Test Mobile App`, which is gated on `apps/mobile/**`.
   *
   * So the edit the corpus is *designed* to receive — adding a case — was
   * checked against one of the two implementations it exists to compare.
   * Measured on the pull request that added six cases: `Test Edge Router` ran,
   * `Test Mobile App` was skipped. A case that this parser accepts and the
   * app's rejects would have gone green.
   *
   * The mobile suite keeps its own copy of this loop, because a corpus change
   * is not the only way the two can drift — a change to either parser must fail
   * on its own side too.
   */
  it.each(shareSegmentCases.cases.map((c) => [c.why, c.segment, c.token] as const))(
    "the app's parser agrees: %s",
    (_why, segment, token) => {
      expect(shareTokenFromSegment(segment)).toBe(token);
    },
  );

  it("the shared corpus keeps its negative cases", () => {
    const cases = shareSegmentCases.cases;
    const refused = cases.filter((c) => c.token === null);
    expect(cases.length, "cases were removed from the corpus").toBeGreaterThanOrEqual(25);
    expect(refused.length, "the refusals are the half that guards the charset").toBeGreaterThanOrEqual(18);

    // Each hazard by name, because a count alone is satisfied by twenty copies
    // of one shape. These are the classes a divergence would hide in.
    for (const [hazard, matches] of [
      ["uppercase hex", (c: string) => /[A-F]/.test(c)],
      // A hex run of the wrong length, wherever in the segment it sits — the
      // corpus spells these with a slug in front.
      ["a wrong length", (c: string) => /(?:^|-)[0-9a-f]{63}$|(?:^|-)[0-9a-f]{65}$/.test(c)],
      ["a leading separator", (c: string) => c.startsWith("-")],
      ["a percent escape", (c: string) => c.includes("%")],
      ["a non-ASCII separator", (c: string) => /[^\x00-\x7F]/.test(c)],
      ["a path separator", (c: string) => c.includes("/") || c.includes(".")],
    ] as const) {
      expect(
        refused.some((c) => matches(c.segment)),
        `the corpus lost its case for ${hazard}`,
      ).toBe(true);
    }
  });

  it("a title reaches the card", () => {
    const meta = previewForShare("Chapter transition");
    expect(meta.title).toBe("Chapter transition — Context");
  });

  /**
   * THE test for this feature. Every way a lookup can come back empty —
   * unknown token, revoked, expired, title switched off, upstream down,
   * timeout, malformed JSON — arrives here as a falsy title, and every one of
   * them must render the frozen card byte for byte. That is what makes
   * revocation invisible: a crawler cannot tell a share that was taken back
   * from one that never existed.
   */
  it.each([[null], [undefined], [""], ["   "]])(
    "an empty title (%p) is the frozen card, byte for byte",
    (title) => {
      expect(renderPreviewHtml(previewForShare(title))).toBe(
        renderPreviewHtml(GENERIC_PREVIEW),
      );
    },
  );

  /**
   * …and openness cannot rescue an absence into a card. A crawler that could
   * tell "revoked, and it used to be an open link" from "never existed" has
   * learned something, so the frozen card has to win over the second argument
   * as completely as it wins over the first.
   */
  it.each([[null], [undefined], [""], ["   "]])(
    "an empty title (%p) is still the frozen card when the link is open",
    (title) => {
      expect(renderPreviewHtml(previewForShare(title, undefined, true))).toBe(
        renderPreviewHtml(GENERIC_PREVIEW),
      );
    },
  );

  /**
   * An unlisted link's reader needs no account, and a card that tells them to
   * sign in is the product being wrong on the first surface a stranger sees —
   * the kind of wrong that stops the link being opened at all, which is the
   * whole reason a share card carries a title.
   */
  it("an open link's card does not ask for a sign-in", () => {
    const open = previewForShare("Chapter transition", undefined, true);
    expect(open.description).not.toMatch(/sign in/i);
    expect(open.description).toMatch(/no account needed/i);
  });

  it("…and every other share's card still does", () => {
    for (const meta of [
      previewForShare("Chapter transition"),
      previewForShare("Chapter transition", undefined, false),
    ]) {
      expect(meta.description).toMatch(/sign in to read it/i);
    }
  });

  /**
   * The default is the narrow one, so an upstream that has not been taught
   * about this field — older, newer, or wrong — sends the reader to sign in
   * rather than promising them access they may not have.
   */
  it("the sign-in wording is what you get without being told otherwise", () => {
    expect(previewForShare("Chapter transition").description).toBe(
      previewForShare("Chapter transition", undefined, false).description,
    );
  });

  it("a share card still refuses everything the frozen one refuses", () => {
    const html = renderPreviewHtml(previewForShare("Chapter transition"));

    // The canonical URL is the site root, never the requested share path.
    expect(html).toContain('<link rel="canonical" href="https://context.lc/">');
    expect(meta(html, "property", "og:url")).toEqual(["https://context.lc/"]);
    // Still out of search results.
    expect(meta(html, "name", "robots")).toEqual(["noindex, nofollow"]);
    // Still the product's own card image.
    expect(meta(html, "property", "og:image")).toEqual([
      "https://context.lc/og/card.png",
    ]);
    // And nothing beyond the title: no owner, no path, no context name.
    expect(html).not.toContain("1-projects");
    expect(html).not.toContain("@");
  });

  it("a hostile title cannot break out of the markup", () => {
    const html = renderPreviewHtml(
      previewForShare('</title><script>alert(1)</script><meta x="'),
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  /**
   * Bounded at the edge as well as in the control plane. An edge that trusts
   * its upstream to have been careful is an edge with no bound at all.
   */
  it("a very long title is truncated here too", () => {
    const meta = previewForShare("x".repeat(500));
    expect(meta.title.length).toBeLessThanOrEqual(60 + " — Context".length);
  });
});

describe("a readable team link", () => {
  /**
   * The rule that replaced "every console URL is frozen", and the two halves
   * are what make it safe:
   *
   *  - A console URL **with no linked note** is frozen, exactly as before.
   *  - A note link unfurls **only when the owner has team-linked that note** —
   *    the control plane answers `null` for everything else, and `null` renders
   *    GENERIC_PREVIEW byte for byte.
   *
   * So probing `?note=<guess>` reveals the set of notes the owner already chose
   * to publish a card for, and nothing about the rest of the context. That was
   * their call, made with the unguessable-token alternative in front of them,
   * because a link nobody can read is a link nobody clicks.
   */
  it("is recognised only in the shape the console actually produces", () => {
    expect(
      consoleNoteFrom(new URL("https://context.lc/console/@seyi?note=1-projects/a.md")),
    ).toEqual({ slug: "seyi", path: "1-projects/a.md" });
    expect(
      consoleNoteFrom(new URL("https://context.lc/console/%40seyi?note=a.md")),
    ).toEqual({ slug: "seyi", path: "a.md" });
  });

  it.each([
    ["https://context.lc/console/@seyi", "no note"],
    ["https://context.lc/console/@seyi/settings?note=a.md", "not the browse route"],
    ["https://context.lc/console?note=a.md", "no context"],
    ["https://context.lc/console/@seyi?note=/etc/passwd", "rooted"],
    ["https://context.lc/console/@seyi?note=../../privacy.md", "traversal"],
    ["https://context.lc/console/@seyi?note=1-projects/../../x.md", "traversal inside"],
    ["https://context.lc/console/@seyi?note=.history/a.md", "history"],
    ["https://context.lc/console/@seyi?note=privacy.md", "the access map"],
    ["https://context.lc/console/@Seyi?note=a.md", "not a handle shape"],
    ["https://context.lc/@seyi?note=a.md", "not a console URL"],
  ])("%s is not one (%s)", (href) => {
    expect(consoleNoteFrom(new URL(href))).toBeNull();
  });

  /**
   * **A folder the owner named routes like anything else they named.**
   *
   * This asserted the opposite a commit ago, and the reversal is the point: the
   * preview turns on *guessability*, and file-versus-folder was only ever a
   * proxy for it. `/@name/1-projects` is five guesses per handle and is still
   * refused below — by name, where that refusal belongs — but
   * `1-projects/pilot` is a name its owner typed, exactly like
   * `1-projects/pilot/overview.md`.
   */
  it("routes a folder the owner named", () => {
    expect(
      consoleNoteFrom(new URL("https://context.lc/console/@seyi?note=1-projects/pilot")),
    ).toEqual({ slug: "seyi", path: "1-projects/pilot" });
  });

  /** ...and the five it did not. */
  it.each(["0-inbox", "1-projects", "2-areas", "3-resources", "4-archive"])(
    "does not route %s, which every brain has",
    (path) => {
      expect(
        consoleNoteFrom(new URL(`https://context.lc/console/@seyi?note=${path}`)),
      ).toBeNull();
    },
  );

  /**
   * The shape of that refusal: **exact**, not `startsWith`. Writing it as a
   * prefix — the obvious way to say "and everything under it" — would refuse
   * every note in the brain, since all of them live under a PARA folder, and
   * the frozen card would be back for everything without a test noticing.
   */
  it.each([
    ["1-projects-archive", "a name that begins with a scaffolded one"],
    ["1-projects/pilot", "a folder inside one"],
    ["1-projects/plan.md", "a note inside one"],
  ])("%s is still routed (%s)", (path) => {
    expect(
      consoleNoteFrom(new URL(`https://context.lc/console/@seyi?note=${path}`)),
    ).not.toBeNull();
  });

  /**
   * Two more that are not routed. `.images/a.md` is held by the dot-segment
   * rule, and dropping that rule fails this.
   *
   * `scopes.yml` is the interesting one. It was **unpinnable** while a
   * note-only rule stood here — it does not end in `.md`, so that rule refused
   * it first and deleting the explicit check left this green. The comment then
   * said the check was kept because "it becomes load-bearing again the moment
   * the note-only line is relaxed". That moment is now, and this test has teeth
   * it did not have: delete `path === "scopes.yml"` and it fails.
   */
  it.each([
    ["https://context.lc/console/@seyi?note=scopes.yml", "the legacy scope map"],
    ["https://context.lc/console/@seyi?note=.images/a.md", "the image store"],
  ])("%s is not one (%s)", (href) => {
    expect(consoleNoteFrom(new URL(href))).toBeNull();
  });

  /**
   * The names the product writes itself, which are guessable however unguessable
   * an arbitrary filename is. Restated here from
   * `apps/convex/functions/lib/scaffold.ts` because this package is a separate
   * deployment; the control-plane copy is driven off `scaffoldFiles` directly,
   * so a new scaffolded file fails there and this list is the one to update —
   * and `teamShare.test.ts` asserts these thirteen equal what it derives, so
   * the update is not optional.
   *
   * `privacy.md` is in the list and would pass here regardless, because the
   * explicit plumbing line above already refuses it.
   */
  it.each([
    "index.md",
    "privacy.md",
    "todo.md",
    "0-inbox/README.md",
    "1-projects/README.md",
    "2-areas/README.md",
    "3-resources/README.md",
    "4-archive/README.md",
    "0-inbox",
    "1-projects",
    "2-areas",
    "3-resources",
    "4-archive",
  ])("%s is a name anybody can guess, so it is not routed", (note) => {
    expect(
      consoleNoteFrom(new URL(`https://context.lc/console/@seyi?note=${note}`)),
    ).toBeNull();
  });

  it("while a name the owner chose is routed", () => {
    expect(
      consoleNoteFrom(
        new URL("https://context.lc/console/@seyi?note=1-projects/acme-migration.md"),
      ),
    ).toEqual({ slug: "seyi", path: "1-projects/acme-migration.md" });
  });

  it("is routed when the extension is upper case, which is still a note", () => {
    expect(
      consoleNoteFrom(new URL("https://context.lc/console/@seyi?note=1-projects/UPPER.MD")),
    ).toEqual({ slug: "seyi", path: "1-projects/UPPER.MD" });
  });

  it("routes a crawler to the lookup, and a person to the app", () => {
    const url = new URL("https://context.lc/console/@seyi?note=1-projects/a.md");
    expect(route(url, "Slackbot 1.0")).toEqual({
      kind: "note-preview",
      slug: "seyi",
      path: "1-projects/a.md",
    });
    expect(
      route(url, "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36")
        .kind,
    ).toBe("proxy");
  });

  it("a linked note gets its title, and its card", () => {
    const meta = previewForNote("Chapter transition", "a".repeat(64));
    expect(meta.title).toBe("Chapter transition — Context");
    expect(meta.imageUrl).toContain(`/og/s/${"a".repeat(64)}.png`);
  });

  /**
   * THE test. Unlinked, revoked, expired, title switched off, control plane
   * unreachable — every one arrives as a falsy title, and every one must render
   * the frozen card byte for byte. That is what keeps the probe to "has the
   * owner published this one".
   */
  it.each([[null], [undefined], [""], ["   "]])(
    "an unlinked note (%p) is the frozen card, byte for byte",
    (title) => {
      expect(renderPreviewHtml(previewForNote(title, "a".repeat(64)))).toBe(
        renderPreviewHtml(GENERIC_PREVIEW),
      );
    },
  );

  it("a console URL with no note is still frozen", () => {
    for (const pathname of ["/console/@seyi", "/console/@seyi/settings", "/console"]) {
      expect(previewHtml(pathname)).toBe(previewHtml("/@alice"));
    }
  });

  it("still refuses everything the frozen card refuses", () => {
    const html = renderPreviewHtml(previewForNote("Chapter transition", "b".repeat(64)));
    expect(html).toContain('<link rel="canonical" href="https://context.lc/">');
    expect(meta(html, "name", "robots")).toEqual(["noindex, nofollow"]);
    // The title, and nothing else about the context.
    expect(html).not.toContain("seyi");
    expect(html).not.toContain("1-projects");
  });

  it("a hostile title cannot break out of the markup", () => {
    const html = renderPreviewHtml(
      previewForNote('</title><script>alert(1)</script>', "c".repeat(64)),
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

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
});
