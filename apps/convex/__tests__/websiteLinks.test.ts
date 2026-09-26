import { describe, expect, test } from "vitest";
import {
  rewriteWebsiteLinks,
  websiteReferencedSharePaths,
  type WebsiteLinkCatalogEntry,
} from "../functions/lib/websites/links";

const catalog: WebsiteLinkCatalogEntry[] = [
  {
    kind: "route",
    objectKey: "website/index.md",
    href: "/",
    audience: "public",
    sourceEtag: "index-etag",
  },
  {
    kind: "route",
    objectKey: "website/about.md",
    href: "/about",
    audience: "public",
    sourceEtag: "about-etag",
  },
  {
    kind: "share",
    objectKey: "1-projects/shared.md",
    href: "/s/public-token",
    audience: "public",
    sourceEtag: null,
  },
];

const options = {
  fromPath: "website/index.md",
  handle: "atlas",
  ownedHosts: ["notes.atlas.test"],
  catalog,
};

describe("website link publication", () => {
  test("rewrites routes for the current host and live shares through their capability", () => {
    const markdown = [
      "[[about|About us]]",
      "[Shared](../1-projects/shared.md#details)",
      "[Private](../1-projects/private.md)",
      "[Root](/about#team)",
      "[Handle](https://context.lc/@atlas/about)",
      "[Domain](https://notes.atlas.test/about)",
      "[Elsewhere](https://example.test/about)",
    ].join("\n");

    expect(
      rewriteWebsiteLinks(markdown, options, new Set(["1-projects/shared.md"])),
    ).toBe(
      [
        "[About us](/about)",
        "[Shared](/s/public-token#details)",
        "[Private](../1-projects/private.md)",
        "[Root](/about#team)",
        "[Handle](/about)",
        "[Domain](/about)",
        "[Elsewhere](https://example.test/about)",
      ].join("\n"),
    );
  });

  test("hidden names cannot make a bare link ambiguous", () => {
    expect(
      rewriteWebsiteLinks(
        "[[about]]",
        {
          ...options,
          // Only publishable catalog entries participate in bare-name
          // resolution; a hidden second `about.md` is intentionally absent.
        },
        new Set(),
      ),
    ).toBe("[about](/about)");
  });

  test("embeds, code and unpublished targets stay non-fetching and non-clickable", () => {
    const markdown = [
      "![[about]]",
      "`[[about]]`",
      "```md",
      "[[about]]",
      "```",
      "[[missing|Missing]]",
    ].join("\n");
    expect(rewriteWebsiteLinks(markdown, options, new Set())).toBe(markdown);
  });

  test("unsafe wikilink anchors cannot break out of the generated Markdown target", () => {
    const markdown = "[[about#) forged content|About]]";
    expect(rewriteWebsiteLinks(markdown, options, new Set())).toBe(markdown);
  });

  test("only referenced share paths are offered for a live team-scope check", () => {
    expect(
      websiteReferencedSharePaths(
        "[one](../1-projects/shared.md) [two](../1-projects/shared.md) [[about]]",
        options,
      ),
    ).toEqual(["1-projects/shared.md"]);
  });

  test("two publishable notes with one bare name remain plain text", () => {
    const ambiguous: WebsiteLinkCatalogEntry[] = [
      ...catalog,
      {
        kind: "route",
        objectKey: "website/team/about.md",
        href: "/team/about",
        audience: "public",
        sourceEtag: "nested-about-etag",
      },
    ];
    expect(
      rewriteWebsiteLinks(
        "[[about]]",
        { ...options, catalog: ambiguous },
        new Set(),
      ),
    ).toBe("[[about]]");
  });

  /*
    A page whose file name has a space in it is the ordinary case — `Public
    Worship.md` is served at `/Public Worship` — and every way of linking to it
    came out as plain text on seyi.co's home page: the rewritten target carried
    a raw space, which ends a Markdown link target, and a target the author
    wrote with `%20` was refused as unsafe before it was ever looked up.
  */
  describe("a page whose name has a space in it", () => {
    const spaced: WebsiteLinkCatalogEntry[] = [
      ...catalog,
      {
        kind: "route",
        objectKey: "website/Public Worship.md",
        href: "/Public Worship",
        audience: "public",
        sourceEtag: "pw-etag",
      },
    ];
    const withSpaced = { ...options, catalog: spaced };

    test("every way of naming it becomes one encoded, followable link", () => {
      const markdown = [
        "[[Public Worship]]",
        "[[Public Worship|PW]]",
        "[Public Worship](Public%20Worship.md)",
        "[Public Worship](<Public Worship.md>)",
        "[Public Worship](/Public%20Worship)",
        "[Public Worship](https://notes.atlas.test/Public%20Worship#top)",
      ].join("\n");
      expect(rewriteWebsiteLinks(markdown, withSpaced, new Set())).toBe(
        [
          "[Public Worship](/Public%20Worship)",
          "[PW](/Public%20Worship)",
          "[Public Worship](/Public%20Worship)",
          "[Public Worship](</Public%20Worship>)",
          "[Public Worship](/Public%20Worship)",
          "[Public Worship](/Public%20Worship#top)",
        ].join("\n"),
      );
    });

    test("a route written in another case finds the page", () => {
      // Routes are case-insensitive on the way in (`websiteRouteLookupKey`),
      // so the link that works in a browser bar works in a note.
      expect(rewriteWebsiteLinks("[About](/About)", withSpaced, new Set())).toBe(
        "[About](/about)",
      );
    });

    test("an encoded slash or backslash is not a way to invent a path", () => {
      const markdown = "[x](/Public%2FWorship) [y](/about%5C..)";
      expect(rewriteWebsiteLinks(markdown, withSpaced, new Set())).toBe(markdown);
    });
  });
});
