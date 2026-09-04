import { describe, expect, test } from "vitest";
import * as shared from "@context/shared/src/links";
// The gateway is plain JS. `allowJs` lets this resolve; nothing here needs
// its types, and the point of the file is that the two agree at runtime.
import * as gateway from "../../mcp/src/links.js";

/**
 * THE TWO LINK ENGINES AGREE, OR THIS FAILS.
 *
 * There are two copies of the rule that decides what a link points at and how
 * it is rewritten: `packages/shared/src/links.ts`, used by the control plane
 * and the console, and `apps/mcp/src/links.js`, used by the gateway. The
 * gateway cannot import the first (dependency-free by rule, and
 * `scripts/check-gateway-imports.mjs` requires every specifier in it to be
 * relative) and the mobile app cannot import the second (Metro reaches
 * `@context/shared` and nothing else). This file imports both, which it can do
 * because vitest resolves a relative path and the control plane already reaches
 * into the gateway the same way for the search modules.
 *
 * **A rule with a copy on each side of a boundary is a rule that will drift**
 * (`packages/shared/src/index.ts` says so in its own header), and drift here is
 * not cosmetic: a rename through the app and the same rename through an MCP
 * client would rewrite somebody's notes two different ways, and only one of
 * them would still resolve. So the two are run over one corpus and required to
 * answer identically, at every level — what a body parses to, what a target
 * resolves to, how a target is written back, and what a whole rewrite produces.
 *
 * The corpus is deliberately awkward. Every entry in it is either a shape these
 * buckets actually contain or a shape that has broken a link rewriter before:
 * a fenced block, an unterminated fence, an alias, an embed, an anchor, an
 * attachment, a percent-encoded space, a traversal attempt, a bare name two
 * notes answer to.
 *
 * ## What this does not prove
 *
 * That either copy is *right*. `apps/mcp/test/links.test.mjs` and
 * `fileOps.test.ts` do that, on each side. This proves they are the same,
 * which is the only property neither of those can see.
 */

const NOTE = "1-projects/persistence/overview.md";

const CORPUS = [
  "plain text with no links at all",
  "see [[../../2-products/context-lc/overview]]",
  "see [[2-products/context-lc/overview]]",
  "see [[overview]] and [[unique-name]]",
  "an alias [[../../2-products/context-lc/overview|the app]]",
  "an embed ![[../../2-products/context-lc/overview]]",
  "an anchor [[../../2-products/context-lc/overview#shape]]",
  "a block ref [[../../2-products/context-lc/overview#^abc123]]",
  "inline [label](../../2-products/context-lc/overview.md)",
  "inline titled [label](../../2-products/context-lc/overview.md \"a title\")",
  "inline bracketed [label](<../a note with spaces.md>)",
  "inline encoded [label](../a%20note%20with%20spaces.md)",
  "external [docs](https://context.lc/2-products/context-lc/overview.md)",
  "protocol relative [x](//evil.example/a.md)",
  "mail [x](mailto:someone@example.com)",
  "anchor only [x](#heading)",
  "an attachment ![diagram](../assets/diagram.png)",
  "traversal [[../../../../../etc/passwd]]",
  "encoded traversal [x](%2e%2e/%2e%2e/secrets.md)",
  "```\n[[../../2-products/context-lc/overview]]\n```\nand [[./sibling]]",
  "~~~\n[[a]]\n~~~\n[[./sibling]]",
  "unterminated ```\n[[./sibling]]",
  "a span `[[./sibling]]` and a link [[./sibling]]",
  "empty target [x]()",
  "two on one line [[./sibling]] [[../../2-products/context-lc/overview]]",
  "a sibling [[./sibling]] and a cousin [[../other/thing]]",
];

const NAMES = [
  NOTE,
  "2-products/context-lc/overview.md",
  "3-resources/unique-name.md",
  "1-projects/persistence/sibling.md",
  "1-projects/other/thing.md",
  "2-products/x/overview.md",
  "1-projects/a note with spaces.md",
  "1-projects/persistence/assets/diagram.png",
];

const RENAMES: [string, string][] = [
  ["2-products/context-lc/overview.md", "2-products/contextlc/readme.md"],
  ["1-projects/persistence/sibling.md", "4-archive/2026/sibling.md"],
  ["3-resources/unique-name.md", "3-resources/renamed-name.md"],
];

/** Every place the referring note might be, including two it was moved to. */
const REFERRERS = [
  { from: NOTE, to: NOTE },
  { from: NOTE, to: "4-archive/2026/1-projects/persistence/overview.md" },
  { from: NOTE, to: "overview.md" },
];

describe("the shared link engine and the gateway's agree", () => {
  test("both modules export the same surface", () => {
    const surface = [
      "codeRanges",
      "dirOf",
      "expressLink",
      "indexByName",
      "normalizeSegments",
      "parseLinks",
      "relativePath",
      "resolveLink",
      "rewriteLinks",
      "styleOf",
    ];
    for (const name of surface) {
      expect(typeof (shared as Record<string, unknown>)[name], name).toBe("function");
      expect(typeof (gateway as Record<string, unknown>)[name], name).toBe("function");
    }
  });

  test("a body parses to the same links", () => {
    for (const text of CORPUS) {
      expect(shared.parseLinks(text), text).toEqual(gateway.parseLinks(text));
    }
  });

  test("code is masked identically", () => {
    for (const text of CORPUS) {
      expect(shared.codeRanges(text), text).toEqual(gateway.codeRanges(text));
    }
  });

  test("a target resolves to the same note, or to nothing", () => {
    const sharedNames = shared.indexByName(NAMES);
    const gatewayNames = gateway.indexByName(NAMES);
    for (const text of CORPUS) {
      for (const link of shared.parseLinks(text)) {
        expect(
          shared.resolveLink(link, NOTE, sharedNames),
          `${text} → ${link.target}`,
        ).toEqual(gateway.resolveLink(link, NOTE, gatewayNames));
      }
    }
  });

  test("a target is written back the same way", () => {
    for (const text of CORPUS) {
      for (const link of shared.parseLinks(text)) {
        for (const referrer of REFERRERS) {
          for (const [, destination] of RENAMES) {
            expect(
              shared.expressLink(link, referrer.to, destination),
              `${link.target} @ ${referrer.to} → ${destination}`,
            ).toEqual(gateway.expressLink(link, referrer.to, destination));
          }
        }
      }
    }
  });

  test("a whole rewrite produces the same bytes, and the same count", () => {
    const renames = new Map(RENAMES);
    const sharedNames = shared.indexByName(NAMES);
    const gatewayNames = gateway.indexByName(NAMES);
    let rewrites = 0;
    for (const text of CORPUS) {
      for (const referrer of REFERRERS) {
        const a = shared.rewriteLinks(text, {
          fromPath: referrer.from,
          toPath: referrer.to,
          renames,
          byName: sharedNames,
        });
        const b = gateway.rewriteLinks(text, {
          fromPath: referrer.from,
          toPath: referrer.to,
          renames,
          byName: gatewayNames,
        });
        expect(a, `${text} @ ${referrer.to}`).toEqual(b);
        if (a !== null) rewrites += 1;
      }
    }
    /*
      A corpus that rewrote nothing would pass every assertion above by
      comparing `null` to `null`, twenty-six times, and prove precisely nothing.
      The floor is what makes the equality mean something.
    */
    expect(rewrites).toBeGreaterThan(15);
  });

  test("the low-level helpers agree too", () => {
    const paths = ["", "a", "a/b", "a/b/c.md", "4-archive/2026/x.md"];
    for (const path of paths) {
      expect(shared.dirOf(path), path).toBe(gateway.dirOf(path));
      expect(shared.styleOf(path), path).toBe(gateway.styleOf(path));
      for (const target of paths) {
        expect(shared.relativePath(path, target || "x.md")).toBe(
          gateway.relativePath(path, target || "x.md"),
        );
      }
    }
    for (const segments of [["a", ".."], ["..", "a"], [".", "a"], ["", "a"], ["a", "b", ".."]]) {
      expect(shared.normalizeSegments(segments), segments.join("/")).toEqual(
        gateway.normalizeSegments(segments),
      );
    }
  });
});
