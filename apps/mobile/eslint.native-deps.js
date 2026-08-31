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
const os = require("os");
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
  // A *source* fault — the file missing, unparseable, or the wrong shape —
  // throws, and takes eslint down with it. That is the intent: the
  // classification could not be built, and linting on with the rule inert is
  // the failure this file exists to end.
  const map = classifyNativeDeps(JSON.parse(fs.readFileSync(source, "utf8")));
  const body = `${JSON.stringify(map, null, 2)}\n`;

  /*
    A *write* fault is a different fault and must not share that fate. The
    classification was built; only the handoff file failed. Taking eslint down
    then loses every core, TypeScript and react-hooks rule — which is exactly
    the "eslint refuses to run at all" disaster `eslint.config.js` records
    above this one, except originating here rather than in a dependency.

    It is reachable on the self-hosting path this repo commits to supporting:
    a read-only checkout, a hermetic build, `docker run --read-only`. So the
    write falls back to the system temp directory, and only a failure there
    too is fatal. `node_modules/.cache` is preferred solely because it is
    already gitignored, which `os.tmpdir()` gives for free.
  */
  for (const candidate of [target, path.join(os.tmpdir(), "supa-linter-native-deps.json")]) {
    try {
      return writeAtomically(candidate, body);
    } catch (error) {
      if (candidate !== target) throw error;
    }
  }
  /* c8 ignore next */
  throw new Error("unreachable: the loop above either returns or throws");
}

/**
 * Write through a per-process temp file and rename.
 *
 * More than one process writes this path — a jest run has `lintRuns.test.ts`
 * spawning the eslint binary while another worker requires the config. A plain
 * `writeFileSync` truncates before it writes, so a concurrent reader can see a
 * partial file, and upstream answers an unreadable `nativeDepsPath` by
 * catching and returning an empty visitor. So a torn read does not surface as
 * a parse error; it makes the rule **silently inert for that run**, which is
 * the precise failure this whole file exists to end.
 *
 * The staging file is in the target's own directory, so the rename is on one
 * filesystem and is therefore atomic. The `finally` is for the throw between
 * write and rename, which would otherwise leave a stray `.tmp` behind.
 */
function writeAtomically(target, body) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const staging = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(staging, body);
    fs.renameSync(staging, target);
    return target;
  } finally {
    try {
      if (fs.existsSync(staging)) fs.unlinkSync(staging);
    } catch {
      // A staging file we could not clean up is inert: it is gitignored,
      // named for this pid, and overwritten by this pid's next run.
    }
  }
}

// Only the two functions: the paths are defaults, and the one place that needs
// to know where the derived map landed is the caller that just wrote it.
module.exports = { classifyNativeDeps, writeClassifiedNativeDeps };
