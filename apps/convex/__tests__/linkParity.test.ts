import { describe, expect, test } from "vitest";
import * as shared from "@context/shared/src/links";
// The gateway is plain JS. `allowJs` lets this resolve; nothing here needs
// its types, and the point of the file is that the two agree at runtime.
import * as gateway from "../../mcp/src/links.js";
// Plain data, shared with the gateway's own test of the reader.
import { referenceCases } from "../../mcp/test/fixtures/linkReferences.mjs";

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
 * The reader (`extractReferences`, `resolveReference`) is held to the same
 * standard twice: over this corpus, copy against copy, and over the fixture
 * table in `apps/mcp/test/fixtures/linkReferences.mjs`, where each copy must
 * also equal the table's written-out answers.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits to ONE copy and reverted. Counts are failing
 * tests in this file.
 *
 *   footnote lookahead dropped from `DEFINITION` (shared only)                 1
 *   code-range check dropped for definitions (shared only)                     1
 *   ambiguous bare name collapsed to missing/unknown (shared only)             2
 *   `fragment` always empty (shared only)                                      3
 *   `style` always null (shared only)                                         22
 *   definition check ahead of the external check (shared only)                 2
 *
 * (The first corpus had no footnote entry, so the footnote edit passed until
 * one was added: the sabotage is what exposed the gap.)
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
  "[ref]: ./sibling.md\n[[./sibling]]",
  "[ref]: <../a note.md> \"title\"\n[^1]: a footnote, see ./sibling.md",
  "```\n[ref]: ./sibling.md\n```\n`[x]: ./other.md`",
  "[ref]: https://example.com/x#frag",
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
      "extractReferences",
      "indexByName",
      "normalizeSegments",
      "parseLinks",
      "relativePath",
      "resolveLink",
      "resolveReference",
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

  test("extractReferences reports the same occurrences", () => {
    for (const text of [...CORPUS, ...referenceCases.map((c) => c.text)]) {
      expect(shared.extractReferences(text), text).toEqual(gateway.extractReferences(text));
    }
  });

  test("resolveReference gives the same verdict, with and without a path list", () => {
    const sharedCatalog = { byName: shared.indexByName(NAMES) };
    const gatewayCatalog = { byName: gateway.indexByName(NAMES) };
    const states = new Set<string>();
    for (const text of CORPUS) {
      for (const occurrence of shared.extractReferences(text)) {
        for (const withPaths of [false, true]) {
          const a = withPaths ? { ...sharedCatalog, paths: new Set(NAMES) } : sharedCatalog;
          const b = withPaths ? { ...gatewayCatalog, paths: new Set(NAMES) } : gatewayCatalog;
          const verdict = shared.resolveReference(occurrence, NOTE, a);
          expect(verdict, `${text} → ${occurrence.target}`).toEqual(
            gateway.resolveReference(occurrence, NOTE, b),
          );
          states.add(verdict.state);
        }
      }
    }
    // Equality of two `unknown`s proves little; the corpus must reach several verdicts.
    expect(states.size).toBeGreaterThanOrEqual(5);
  });

  describe("the shared reader answers the gateway's fixture table", () => {
    for (const { name, text, fromPath, catalog, expected } of referenceCases) {
      test(name, () => {
        const fixture: { byName: Record<string, string[]>; paths?: string[] } = catalog;
        const cat = {
          byName: new Map(Object.entries(fixture.byName)),
          ...(fixture.paths ? { paths: new Set<string>(fixture.paths) } : {}),
        };
        const actual = shared
          .extractReferences(text)
          .map((occurrence) => ({ ...occurrence, resolution: shared.resolveReference(occurrence, fromPath, cat) }));
        expect(actual).toEqual(expected);
      });
    }
  });
});
