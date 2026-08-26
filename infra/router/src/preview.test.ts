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
  previewFromProfile,
  renderPreviewHtml,
} from "./preview";

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
