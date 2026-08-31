const fs = require("fs");
const os = require("os");
const path = require("path");
const { Linter } = require("eslint");
const supaPlugin = require("@supa-media/linter");

const nativeDeps = require("../native-deps.json");
const {
  classifyNativeDeps,
  writeClassifiedNativeDeps,
} = require("../eslint.native-deps");

/**
 * **The lint half of the native-gating guard has to fire, not just resolve.**
 *
 * `lintRuns.test.ts` already asserts that `@supa-media/no-ungated-native-import`
 * is *present* in the computed config. It is, at `"error"`, and it has never
 * reported anything it could report. The rule reads `native-deps.json` as a
 * package -> classification **map**:
 *
 *     for (const [pkg, config] of Object.entries(nativeDeps.dependencies || nativeDeps))
 *       if ((typeof config === "string" ? config : config.classification) === "gated") …
 *     if (gatedDeps.size === 0) return {};
 *
 * This repo's file is the **array** dialect — `{ "$schema": …, "core": [], "gated": [] }` —
 * which is the dialect `@supa-media/testing`'s own scanner requires and the one
 * its error message tells you to create. Iterating it yields `$schema` (whose
 * "classification" is the schema URL) and two arrays (whose `.classification`
 * is `undefined`). Nothing is ever gated, the set is empty, the rule returns an
 * empty visitor. Two packages of one framework disagree about the file format,
 * and the disagreement is silent in the direction that matters.
 *
 * Measured before this test existed, with `react-native` moved into `gated`:
 * `eslint .` reported **0** findings for the rule while the jest scanner
 * correctly reported **77**. So the "two complementary guards" the design
 * assumes were one guard, and the half that was gone is the half that sees
 * sub-path imports (`dep/inner`) and unguarded top-level `require()` — neither
 * of which the scanner's exact `Set.has` on the specifier can see at all.
 * Latent today only because `gated` is empty; live the moment it is not.
 *
 * The real fix belongs upstream. What is here is the bridge and its proof:
 * `eslint.native-deps.js` derives the map dialect from the arrays and hands it
 * over through the rule's own documented `nativeDepsPath` option, so upstream's
 * matching logic runs unmodified.
 *
 * End-to-end firing cannot be asserted against the real `native-deps.json`,
 * because `gated` is legitimately empty and a test may not edit it. So the two
 * halves are asserted separately and they meet in the middle: the conversion
 * plus the rule are driven over a fixture that *does* gate something, and the
 * real config is asserted to hand the rule the conversion of the real file.
 */

const RULE = "@supa-media/no-ungated-native-import";

/** One fixture exercising every shape the rule is supposed to have an opinion about. */
const PROBE = [
  'import a from "gated-pkg";', // 1 — plain static import
  'import b from "gated-pkg/deep/inner";', // 2 — sub-path; the scanner cannot see this
  'const c = require("gated-pkg");', // 3 — unguarded top-level require
  'import d from "core-pkg";', // 4 — classified core: allowed
  'function lazy() { return require("gated-pkg"); }', // 5 — guarded: allowed
  'const later = () => import("gated-pkg");', // 6 — dynamic: allowed
  "export const all = [a, b, c, d, lazy, later];",
].join("\n");

/** Lint the probe with the rule pointed at `nativeDepsPath`. */
function lintProbe(nativeDepsPath) {
  return new Linter({ configType: "flat" }).verify(
    PROBE,
    [
      {
        files: ["**/*.js"],
        plugins: { "@supa-media": supaPlugin },
        languageOptions: { ecmaVersion: 2022, sourceType: "module" },
        rules: { [RULE]: ["error", { nativeDepsPath }] },
      },
    ],
    "probe.js",
  );
}

describe("the gated-native-import rule fires", () => {
  /** A fixture in this repo's dialect that gates something, written per-run. */
  let fixtureDir;
  let arrayDialect;

  beforeAll(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "native-deps-"));
    arrayDialect = path.join(fixtureDir, "native-deps.json");
    fs.writeFileSync(
      arrayDialect,
      JSON.stringify({
        $schema: "https://example.invalid/schemas/native-deps.json",
        core: ["core-pkg"],
        gated: ["gated-pkg"],
      }),
    );
  });

  afterAll(() => {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  test("upstream still cannot read the dialect this repo writes", () => {
    /*
      The finding, pinned so it cannot go quiet again — and the shim's expiry
      notice. **If this test fails, upstream learned the array dialect**: delete
      `eslint.native-deps.js`, drop the rule override from `eslint.config.js`,
      and keep the test below, which is the one that proves the guard works.
      Do not "fix" this by loosening the assertion.
    */
    expect(lintProbe(arrayDialect).map((m) => m.ruleId)).toEqual([]);
  });

  test("and fires on every shape once the classification is converted", () => {
    const converted = writeClassifiedNativeDeps({
      source: arrayDialect,
      target: path.join(fixtureDir, "classified.json"),
    });
    const messages = lintProbe(converted);

    expect(messages.map((m) => m.ruleId)).toEqual([RULE, RULE, RULE]);

    /*
      Lines, not just a count. Line 2 is the sub-path import — the case the jest
      scanner misses by construction (`gatedDeps.has(specifier)`, exact) and the
      reason these two guards were meant to be complementary. Measured against
      this tree: with `react-native` gated, the scanner reports the exact import
      on line 1 of a probe file and nothing for the sub-path on line 2.
    */
    expect(messages.map((m) => m.line)).toEqual([1, 2, 3]);

    // And silent where silence is correct: a core dep, a require() inside a
    // function, and a dynamic import() are the three sanctioned shapes.
    expect(messages.some((m) => m.message.includes("core-pkg"))).toBe(false);
    expect(messages.some((m) => m.line > 3)).toBe(false);
  });
});

describe("the classification is derived, never authored twice", () => {
  test("it is exactly the two arrays and nothing else", () => {
    /*
      `native-deps.json` stays the one authored copy — the arrays are what
      `@supa-media/testing` reads and what the framework's error message
      prescribes. A second, hand-maintained map beside them would be a list
      stored twice, which is a list that can disagree with itself.

      `$schema` in particular must not survive the conversion: iterated as a
      classification it is the string the rule would compare against "gated",
      and a key named after a URL is exactly the noise that made the upstream
      loop meaningless in the first place.
    */
    const map = classifyNativeDeps(nativeDeps);
    expect(Object.keys(map).sort()).toEqual(
      [...nativeDeps.core, ...nativeDeps.gated].sort(),
    );
    for (const name of nativeDeps.core) expect(map[name]).toBe("core");
    for (const name of nativeDeps.gated) expect(map[name]).toBe("gated");
    expect(map.$schema).toBeUndefined();
  });

  test("a shape it does not understand is loud, not empty", () => {
    /*
      The defect being bridged is "an unreadable file yields an empty gated set
      and a rule that reports nothing". A converter that shrugged at a shape it
      did not recognise would reproduce it one layer down.
    */
    expect(() => classifyNativeDeps({ core: ["a"] })).toThrow(/gated/);
    expect(() => classifyNativeDeps({ core: "a", gated: [] })).toThrow(/core/);
    expect(() => classifyNativeDeps({ core: [1], gated: [] })).toThrow(/core/);
  });

  test("the real eslint config hands the rule the converted map", () => {
    /*
      The other half of the end-to-end path. Requiring the config is what CI's
      `eslint .` does, so this also proves the derived file is written where the
      rule will look for it rather than merely computable.
    */
    const config = require("../eslint.config.js");
    const entries = config.filter((entry) => entry.rules && entry.rules[RULE]);
    expect(entries.length).toBeGreaterThan(0);

    // The last entry wins in flat config; the preset's option-less "error" is
    // the first, and it is the one that has never fired.
    const setting = entries[entries.length - 1].rules[RULE];
    expect(Array.isArray(setting)).toBe(true);
    expect(setting[0]).toBe("error");

    const written = JSON.parse(fs.readFileSync(setting[1].nativeDepsPath, "utf8"));
    expect(written).toEqual(classifyNativeDeps(nativeDeps));
  });
});
