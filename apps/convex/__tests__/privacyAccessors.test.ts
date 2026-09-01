/**
 * NO ONE READS AN OVERRIDE WITHOUT THE FOLD.
 *
 * `overrideFor` and `hasOverride` exist because a privacy decision keyed on an
 * exact path is unsound on a backend whose keyspace folds case — see "A privacy
 * decision is folded" in CLAUDE.md. What makes them work is that they are the
 * *only* way either engine reads an override.
 *
 * That is not something the behavioural tests can see. Reverting all five call
 * sites in `fileOps.ts` from `hasOverride(overrides, k)` to `overrides.has(k)`
 * was measured against the full suite and passed 1430/1430: the folded twin
 * only differs on a Dropbox-backed context, and the suites do not stand one up.
 * So the guard is structural, in the shape this repository already uses for a
 * rule two copies have to keep — read the file, do not trust a comment.
 *
 * It is deliberately narrow, and the narrowness is worth stating rather than
 * discovering. It does not prove the fold is *correct* — the differential
 * matrix in `privacyEngine.test.ts` does that — only that the three files below
 * do not read an override by name without it. It is line-scoped, name-scoped
 * and dot-scoped, so it does NOT see an alias (`const o = state.overrides;
 * o.has(k)`), a subscript (`overrides["get"](k)`), a destructured method, a
 * `Map.prototype.get.call`, a newline between the receiver and the `.`, or any
 * file not listed here. Each of those is a deliberate act rather than the thing
 * this catches, which is somebody reverting a call site to what it used to say.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = join(__dirname, "..", "..", "..");

const FILES = [
  "apps/convex/functions/lib/privacy.ts",
  "apps/convex/functions/lib/fileOps.ts",
  "apps/mcp/src/index.js",
];

/**
 * Strip comments before matching, because prose about `overrides.get(...)` is
 * not code — an import guard in this estate once read English as an import and
 * reported nothing for the life of the repository.
 */
function codeOnly(source: string): string[] {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, "");
  return withoutBlocks
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .map((line) => line.trimEnd());
}

/**
 * `overrides.get(`, `state.overrides.has(`, `overrides?.get(` …
 *
 * The optional-call form is included because leaving it out was not a
 * hypothetical gap: `overrideFor`'s own signature accepts `| undefined`, so
 * `overrides?.has(k)` is the natural thing for a caller to write, and it
 * type-checks, passes every behavioural suite, and restores the whole defect
 * this file exists for — one character wide.
 */
const RAW_ACCESS = /\boverrides\s*\??\s*\.\s*(get|has)\s*\(/i;

describe("every override read goes through the folding helpers", () => {
  for (const relative of FILES) {
    test(`${relative} reads overrides only through overrideFor/hasOverride`, () => {
      const lines = codeOnly(readFileSync(join(ROOT, relative), "utf8"));
      const offenders: string[] = [];
      let insideHelper = false;
      let depth = 0;

      for (const line of lines) {
        if (!insideHelper && /function (overrideFor|hasOverride)\b/.test(line)) {
          insideHelper = true;
          depth = 0;
        }
        if (insideHelper) {
          depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
          if (depth <= 0 && /\}/.test(line)) insideHelper = false;
          continue;
        }
        if (RAW_ACCESS.test(line)) offenders.push(line.trim());
      }

      expect(offenders, `raw override access in ${relative}`).toEqual([]);
    });
  }

  test("the guard can actually see a raw access", () => {
    // A guard nobody has checked is not a guard. This is the self-test.
    const sabotaged = [
      "function unrelated() {",
      "  if (state.overrides.has(destination)) throw notFound();",
      "}",
    ].join("\n");
    const lines = codeOnly(sabotaged);
    expect(lines.some((line) => RAW_ACCESS.test(line))).toBe(true);

    // The optional-call form, which type-checks and passes every other suite.
    expect(RAW_ACCESS.test("    if (overrides?.has(destination)) throw notFound();")).toBe(true);
    expect(RAW_ACCESS.test("  const exact = overrides ?. get (key);")).toBe(true);

    // …and that it does not read a comment as code.
    const prose = codeOnly(["/**", " * Once upon a time this was overrides.get(key).", " */"].join("\n"));
    expect(prose.some((line) => RAW_ACCESS.test(line))).toBe(false);
  });
});
