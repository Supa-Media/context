/**
 * ONE READER FOR EVERY LINK IN A NOTE: `extractReferences` and
 * `resolveReference` in `src/links.js`.
 *
 * `parseLinks` answers "what would a move rewrite". These answer "what does
 * this note point at", which is a different question: it needs the anchor, the
 * written style, definitions a rewrite deliberately leaves alone, and a verdict
 * on each target that says why it did not resolve. The cases live in
 * `fixtures/linkReferences.mjs` so the shared package's port is held to the
 * same table.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests in this
 * file.
 *
 *   footnote lookahead dropped from `DEFINITION`                              1
 *   code-range check dropped for definitions                                  1
 *   ambiguous bare name collapsed to missing/unknown                          1
 *   absent bare name always `missing` (ignoring a missing `catalog.paths`)    1
 *   `fragment` always empty                                                   2
 *   path targets not `unknown` without `catalog.paths`                        1
 *   definition check ahead of the external check                              1
 *   `style` always null                                                      21
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { extractReferences, indexByName, parseLinks, resolveReference } from "../src/links.js";
import { referenceCases } from "./fixtures/linkReferences.mjs";

function toCatalog(catalog) {
  return {
    byName: new Map(Object.entries(catalog.byName)),
    ...(catalog.paths ? { paths: new Set(catalog.paths) } : {}),
  };
}

for (const { name, text, fromPath, catalog, expected } of referenceCases) {
  test(`extractReferences and resolveReference: ${name}`, () => {
    const found = extractReferences(text);
    const cat = toCatalog(catalog);
    const actual = found.map((occurrence) => ({ ...occurrence, resolution: resolveReference(occurrence, fromPath, cat) }));
    assert.deepEqual(actual, expected);
  });
}

test("occurrences come back in document order across all three kinds", () => {
  const text = "[ref]: ./a.md\n[[b]] then [c](./c.md)\n[later]: ./d.md";
  assert.deepEqual(
    extractReferences(text).map((o) => o.kind),
    ["definition", "wiki", "inline", "definition"],
  );
});

test("a definition inside a fence or code span is not reported", () => {
  assert.deepEqual(extractReferences("```\n[ref]: ./a.md\n```\n`[x]: ./b.md`"), []);
});

test("a footnote definition is not a reference definition", () => {
  assert.deepEqual(extractReferences("[^1]: a footnote, see ./a.md"), []);
});

test("an angle-bracketed definition target spans the inside of the brackets", () => {
  const text = "[ref]: <./a b.md>";
  const [definition] = extractReferences(text);
  assert.equal(text.slice(definition.start, definition.end), "./a b.md");
});

test("parseLinks still ignores definitions", () => {
  assert.deepEqual(parseLinks("[ref]: ./plan.md"), []);
});

test("resolveReference never throws on what extractReferences produces", () => {
  const text = [
    "[ref]: <>",
    "[ref2]: %E0%A4%A",
    "[[ ]]",
    "[x](<>)",
    "[x](%E0%A4%A)",
    "[[#]]",
    "[[../..]]",
    "[x](https://example.com)",
    "[[a|b]] ![[c#^d]]",
  ].join("\n");
  const catalog = { byName: indexByName(["a.md", "c.md"]) };
  for (const occurrence of extractReferences(text)) {
    for (const cat of [catalog, { ...catalog, paths: new Set(["a.md"]) }]) {
      const { state } = resolveReference(occurrence, "dir/note.md", cat);
      assert.ok(["resolved", "missing", "ambiguous", "unknown", "invalid", "unsupported", "external"].includes(state));
    }
  }
});

test("only a resolved verdict carries a path", () => {
  const cat = { byName: new Map([["a", ["a.md"]]]), paths: new Set(["a.md"]) };
  for (const text of ["[[a]]", "[[b]]", "[x](#h)", "[x](https://e.com)", "[r]: ./a.md"]) {
    const [occurrence] = extractReferences(text);
    const verdict = resolveReference(occurrence, "n.md", cat);
    assert.equal("path" in verdict, verdict.state === "resolved", text);
  }
});
