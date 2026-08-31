/**
 * ESLint for the console app.
 *
 * ## Why this file is more than one line
 *
 * It used to be `[...supaPreset, { ignores: [...] }]`, and eslint could not
 * start: `ConfigError: Key "languageOptions": Key "parser"`. Nothing had linted
 * this app for months. Two separate defects in `@supa-media/linter@0.2.0`'s
 * flat preset stacked up. `1.0.0` fixes one of them.
 *
 * **1. The parser — still present at 1.0.0.** The preset sets
 * `languageOptions.parser` for TypeScript files from a
 * `try { require("@typescript-eslint/parser") } catch { undefined }`, treating
 * the parser as optional. It is not optional in flat config: ESLint validates
 * `languageOptions.parser` by the key's *presence*, so an explicit `undefined`
 * is rejected outright rather than falling back to espree — which turns "no
 * TypeScript parser installed" into "eslint refuses to run at all".
 * `@typescript-eslint/parser` is a devDependency of this app for that reason
 * as much as for parsing, and **removing it breaks lint entirely** rather than
 * degrading it. It is not something this app can go without either way: almost
 * everything here is `.ts` or `.tsx`. Still belongs upstream.
 *
 * **2. The plugin namespace — fixed in `@supa-media/linter@1.0.0`.** The preset
 * used to register the plugin as `@supa` while writing every rule as
 * `@supa-media/…`, so with the parser fixed the next thing eslint said was
 * `Could not find plugin "@supa-media"`, and this file re-registered the same
 * plugin object under the name its own rules use. The preset now registers it
 * correctly, so that workaround is gone. `lintRuns.test.ts` asserts the rules
 * actually resolve, which is what makes deleting it safe rather than hopeful.
 *
 * **3. The gated-native-import rule — still inert at 1.0.0, bridged here.**
 * The preset turns `@supa-media/no-ungated-native-import` on at `"error"`, and
 * it has never reported anything: it reads `native-deps.json` as a package ->
 * classification map, this repo writes the `core`/`gated` array dialect that
 * `@supa-media/testing`'s scanner requires, and a shape it cannot read is an
 * empty gated set and an empty visitor rather than an error. Measured with
 * `react-native` temporarily gated: `eslint .` found 0 where the jest scanner
 * found 77. `eslint.native-deps.js` derives the map from the arrays and passes
 * it through the rule's own `nativeDepsPath` option, so upstream's matching
 * logic runs unmodified; `__tests__/nativeImportGuard.test.js` proves the rule
 * fires and pins the upstream defect so the bridge announces its own expiry.
 * Belongs upstream, like the parser.
 *
 * ## Why the preset is not the whole rule set
 *
 * The preset turns on five Supa conventions and nothing else: no core rules, no
 * TypeScript rules, no hook rules. A lint step that runs but checks almost
 * nothing is the same failure as one that skips — and the app's own source
 * assumed otherwise, carrying `eslint-disable` comments for
 * `react-hooks/exhaustive-deps` and `@typescript-eslint/*` written against
 * rules that were never loaded (ESLint reports those as errors, which is how
 * they surfaced). So the standard three for an Expo TypeScript app are on:
 * eslint's own recommended set, typescript-eslint's, and react-hooks' — the
 * last being the one that catches unstable values in dependency arrays, the
 * defect behind the React #301 white screen in #15.
 *
 * ## CommonJS on purpose
 *
 * `apps/mobile` is not `"type": "module"` (metro and babel configs are CJS), so
 * ESLint 8 loads `eslint.config.js` as CommonJS. Written as ESM it still worked,
 * but every run began with a `MODULE_TYPELESS_PACKAGE_JSON` warning about being
 * reparsed — noise on top of a step that is supposed to be read.
 */

const js = require("@eslint/js");
const tsPlugin = require("@typescript-eslint/eslint-plugin");
const reactHooks = require("eslint-plugin-react-hooks");
const supaPreset = require("@supa-media/linter/preset");
const { writeClassifiedNativeDeps } = require("./eslint.native-deps");

const TS = ["**/*.ts", "**/*.tsx"];

module.exports = [
  ...supaPreset,

  {
    // The preset's own entry for this rule carries no options, and without them
    // the rule cannot see a single gated dependency (see 3. above). No `files`
    // key, so it applies exactly where the preset's entry does, and being later
    // in the array it is the one that wins.
    rules: {
      "@supa-media/no-ungated-native-import": [
        "error",
        { nativeDepsPath: writeClassifiedNativeDeps() },
      ],
    },
  },

  {
    ...js.configs.recommended,
    files: ["**/*.js", ...TS],
  },

  {
    // The plain-JS files here are CommonJS run by node (jest configs, the
    // framework guardrail test), not the ES modules flat config assumes. The
    // globals are spelled out rather than pulled from the `globals` package:
    // that package is only reachable because pnpm hoists eslint's own
    // dependencies, and a lint config that breaks when hoisting changes is how
    // this step went quiet in the first place.
    files: ["**/*.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        __dirname: "readonly",
        __filename: "readonly",
        module: "writable",
        exports: "writable",
        process: "readonly",
        require: "readonly",
        afterAll: "readonly",
        afterEach: "readonly",
        beforeAll: "readonly",
        beforeEach: "readonly",
        describe: "readonly",
        expect: "readonly",
        jest: "readonly",
        test: "readonly",
      },
    },
  },

  {
    files: TS,
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      ...tsPlugin.configs.recommended.rules,

      // Off for TypeScript, on purpose, and only here — the core versions
      // cannot read types, so between them they produced 202 of the 212
      // findings and every one was wrong. `no-undef` does not know a `.d.ts`
      // global or an ambient type and reports both as undefined identifiers;
      // core `no-unused-vars` counts a type-only reference as no reference at
      // all. `tsc --noEmit` already fails the build on a genuinely undefined
      // name, and `@typescript-eslint/no-unused-vars` (on, just below) is the
      // type-aware replacement. This is typescript-eslint's own documented
      // recommendation, not a convenience.
      "no-undef": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        // Prefixing with `_` is how this codebase already marks a binding that
        // exists for its position rather than its value.
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },

  {
    files: TS,
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },

  {
    // `jest.mock` is hoisted above the imports in the file it appears in, so a
    // module that must be loaded *after* its mocks is loaded with `require`.
    // That is the documented pattern and several tests here rely on it and say
    // so; `no-require-imports` has nothing useful to add about it.
    // `scripts/design-shots.ts` is a Jest file too — it mounts the console under
    // the same `jest.mock` calls, and is excluded from `pnpm test` only by
    // `jest.config.js`'s `testMatch`. It has the same reason and gets the same
    // exemption rather than a second copy of the rule turned off inline.
    files: ["__tests__/**", "scripts/design-shots.ts"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },

  {
    ignores: ["metro.config.js", "babel.config.js"],
  },
];
