"use strict";

/**
 * Feeds `@supa-media/no-ungated-native-import` a file it can read.
 *
 * The rule is enabled at `"error"` by `@supa-media/linter`'s preset and has
 * never reported anything. It builds its gated set by iterating
 * `native-deps.json` as a package -> classification **map**:
 *
 *     const deps = nativeDeps.dependencies || nativeDeps;
 *     for (const [pkg, config] of Object.entries(deps)) { … }
 *     if (gatedDeps.size === 0) return {};
 *
 * This repo writes the **array** dialect, `{ "$schema", "core": [], "gated": [] }`,
 * because that is what `@supa-media/testing`'s `checkNativeImports` requires —
 * it reads `depsConfig.core` and `depsConfig.gated`, and its own "not found"
 * error tells you to `Create it with: { "core": [...], "gated": [...] }`. Two
 * packages of one framework disagree about the format of one file. Iterating
 * the array dialect as a map yields `$schema` (classification: a URL string)
 * and two arrays (classification: `undefined`), so the gated set is always
 * empty and the rule returns an empty visitor. Measured with `react-native`
 * temporarily gated: `eslint .` reported 0 findings where the jest scanner
 * reported 77. With this file wired in, the same experiment reports 77 from
 * both and `eslint .` exits non-zero. That measurement cannot live in the
 * suite — `gated` is legitimately empty and a test may not edit the file — so
 * `nativeImportGuard.test.js` drives the same conversion over a fixture that
 * does gate something, and asserts separately that the real config hands the
 * rule the conversion of the real file.
 *
 * The array dialect is the one that stays. Reformatting `native-deps.json` into
 * the map form to satisfy the rule trades one guard for the other — measured,
 * the scanner then reads `core` and `gated` as empty, reports all 51 native
 * dependencies unclassified, and scans no file at all. Keeping both dialects in
 * the file would be one list authored twice.
 *
 * So the arrays stay the only authored copy and the map is derived from them on
 * every lint run, handed to the rule through its own documented
 * `nativeDepsPath` option (`meta.schema` accepts `nativeDepsPath` and
 * `allowedFiles`, and nothing else — there is no inline list to configure).
 * Upstream's matching logic then runs unmodified, which is what makes this a
 * bridge rather than a second implementation: it is upstream's rule that
 * decides what a violation is, including the sub-path (`dep/inner`) and
 * unguarded top-level `require()` cases the scanner cannot see.
 *
 * **This belongs upstream.** The rule should read `core`/`gated` arrays, the
 * dialect its sibling package prescribes. `__tests__/nativeImportGuard.test.js`
 * pins the current inertness, so the day upstream learns the dialect that test
 * fails and says to delete this file.
 *
 * The derived file is disposable — regenerated per run, under `node_modules`,
 * never committed, and never the only copy of anything.
 */

const fs = require("fs");
const path = require("path");

/** The one authored copy. */
const NATIVE_DEPS_PATH = path.join(__dirname, "native-deps.json");

/** Where the derived map is written. Inside `node_modules`, so it is ignored. */
const CLASSIFIED_PATH = path.join(
  __dirname,
  "node_modules",
  ".cache",
  "supa-linter",
  "native-deps.classified.json",
);

/**
 * Convert the array dialect to the map dialect.
 *
 * Throws on anything it does not recognise. An empty gated set is precisely how
 * the upstream rule goes quiet, so a converter that shrugged at an unexpected
 * shape would rebuild the defect one layer down.
 *
 * @param {{ core?: unknown, gated?: unknown }} nativeDeps
 * @returns {Record<string, "core" | "gated">}
 */
function classifyNativeDeps(nativeDeps) {
  const map = {};
  // `gated` last: a name in both lists is read as gated, which is the safe
  // direction. `runtimeVersion.test.js` refuses the dual listing outright, so
  // this is a tie-break that should never be reached rather than a policy.
  for (const key of ["core", "gated"]) {
    const list = nativeDeps && nativeDeps[key];
    if (!Array.isArray(list) || list.some((n) => typeof n !== "string" || n === "")) {
      throw new Error(
        `native-deps.json: "${key}" must be an array of package names ` +
          `(got ${JSON.stringify(list)}). The gated-import lint rule reads this ` +
          `file through eslint.native-deps.js and reports nothing when it cannot ` +
          `build a classification.`,
      );
    }
    for (const name of list) map[name] = key;
  }
  return map;
}

/**
 * Write the derived map and return its path, for the rule's `nativeDepsPath`.
 *
 * Deliberately not wrapped in a `try`: a lint run that could not build its
 * classification must fail loudly, not lint on with the rule inert — which is
 * the whole failure this file exists to end.
 *
 * @param {{ source?: string, target?: string }} [paths]
 * @returns {string} absolute path to the derived map
 */
function writeClassifiedNativeDeps({ source = NATIVE_DEPS_PATH, target = CLASSIFIED_PATH } = {}) {
  const map = classifyNativeDeps(JSON.parse(fs.readFileSync(source, "utf8")));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Written through a per-process temp file and renamed, because more than one
  // process writes this path: a jest run has `lintRuns.test.ts` spawning the
  // eslint binary while another worker requires this config. A plain
  // `writeFileSync` truncates first, so a concurrent reader can see a partial
  // file — and a partial file is a parse error in a lint run that has nothing
  // to do with linting.
  const staging = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(staging, `${JSON.stringify(map, null, 2)}\n`);
  fs.renameSync(staging, target);
  return target;
}

// Only the two functions: the paths are defaults, and the one place that needs
// to know where the derived map landed is the caller that just wrote it.
module.exports = { classifyNativeDeps, writeClassifiedNativeDeps };
