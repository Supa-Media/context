import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { describe, expect, test } from "@jest/globals";

/**
 * The lint step has to actually lint.
 *
 * `ci / Lint` reported **skipping** on every PR for months while eslint could
 * not even start locally (`ConfigError: Key "languageOptions": Key "parser"`),
 * so `tsc` and jest were the only gates on this app. Both halves of that failed
 * quietly, which is the shape this project keeps meeting: a check that is green
 * because it never ran.
 *
 * Neither half is visible to any other test — a broken eslint config does not
 * fail a type check, and a workflow input nobody passes does not fail anything
 * at all — so they are asserted here.
 */

const MOBILE = join(__dirname, "..");
const CI_WORKFLOW = join(MOBILE, "..", "..", ".github", "workflows", "ci.yml");

describe("the eslint config loads", () => {
  test("computes a real config for a TypeScript file", () => {
    // Run the real binary rather than the Node API: ESLint 8 loads a flat
    // config with a dynamic `import()`, which Jest's CommonJS VM cannot do, and
    // the binary is what CI runs anyway. It exits non-zero — failing this test
    // — on `ConfigError: Key "languageOptions": Key "parser"` (the preset's
    // optional-parser `require` resolving to `undefined`) and on
    // `Could not find plugin "@supa-media"` (its rules naming a namespace it
    // never registered). Both were live.
    const eslintBin = join(dirname(require.resolve("eslint")), "..", "bin", "eslint.js");
    const printed = execFileSync(
      process.execPath,
      [eslintBin, "--print-config", "features/console/files/useFileBrowser.ts"],
      { cwd: MOBILE, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const config = JSON.parse(printed) as {
      languageOptions?: { parser?: unknown };
      rules?: Record<string, unknown>;
    };

    // `--print-config` reports the parser by name; espree — or nothing — means
    // the TypeScript files are not really being read.
    expect(String(config.languageOptions?.parser ?? "")).toMatch(/typescript-eslint/);

    // And it is a rule set worth running, not five conventions and nothing
    // else. `exhaustive-deps` in particular is the rule that sees an unstable
    // value in a dependency array — the defect behind the React #301 white
    // screen, and the reason `consoleRenderLoop.test.ts` exists.
    const rules = config.rules ?? {};
    expect(rules["react-hooks/exhaustive-deps"]).toBeDefined();
    expect(rules["@typescript-eslint/no-unused-vars"]).toBeDefined();
    expect(rules["@supa-media/no-ungated-native-import"]).toBeDefined();
  }, 30_000);
});

describe("CI runs the lint step", () => {
  const workflow = readFileSync(CI_WORKFLOW, "utf8");
  /** Strip comments, so a rule quoted in prose cannot satisfy an assertion. */
  const settings = workflow
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

  test("passes a lint-command, because the job is skipped without one", () => {
    // The reusable workflow guards the job with `if: inputs.lint-command != ''`
    // and nothing else — no path filter is involved. An empty input is the
    // whole reason it reported "skipping".
    const match = /^\s*lint-command:\s*(.+)$/m.exec(settings);
    expect(match).not.toBeNull();
    expect(match![1].trim().replace(/^["']|["']$/g, "")).not.toBe("");
  });

  test("does not let a lint failure report as a pass", () => {
    // `lint-continue-on-error` defaults to `true` upstream. Left alone, the job
    // would run, fail, and still be green.
    expect(settings).toMatch(/^\s*lint-continue-on-error:\s*false\s*$/m);
  });
});
