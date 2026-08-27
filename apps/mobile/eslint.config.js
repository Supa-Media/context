/**
 * ESLint for the console app.
 *
 * ## Why this file is more than one line
 *
 * It used to be `[...supaPreset, { ignores: [...] }]`, and eslint could not
 * start: `ConfigError: Key "languageOptions": Key "parser"`. Nothing had linted
 * this app for months. Two separate defects in `@supa-media/linter@0.2.0`'s
 * flat preset stack up, and each has to be answered here until a fixed preset
 * ships — both belong upstream, in supa-framework.
 *
 * **1. The parser.** The preset sets `languageOptions.parser` for TypeScript
 * files from a `try { require("@typescript-eslint/parser") } catch { undefined }`,
 * treating the parser as optional. It is not optional in flat config: ESLint
 * validates `languageOptions.parser` by the key's *presence*, so an explicit
 * `undefined` is rejected outright rather than falling back to espree — which
 * turns "no TypeScript parser installed" into "eslint refuses to run at all".
 * `@typescript-eslint/parser` is now a devDependency of this app, which both
 * makes that `require` succeed and gives the TS files a parser that can read
 * them. It is not something this app can go without: almost everything here is
 * `.ts` or `.tsx`.
 *
 * **2. The plugin namespace.** The preset registers the plugin as `@supa` but
 * writes every rule as `@supa-media/…`, so with the parser fixed the next thing
 * eslint says is `Could not find plugin "@supa-media"`. Registering the same
 * plugin object under the name its own rules use is the smallest honest answer;
 * the alternative is restating all five rules here, which would quietly stop
 * tracking the preset.
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
const supaPlugin = require("@supa-media/linter");
const supaPreset = require("@supa-media/linter/preset");

const TS = ["**/*.ts", "**/*.tsx"];

module.exports = [
  ...supaPreset,

  // See note 2. Flat config merges `plugins` across every config object that
  // matches a file, so registering it here is enough for the preset's own rule
  // references to resolve.
  {
    plugins: { "@supa-media": supaPlugin },
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
        afterEach: "readonly",
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
    files: ["__tests__/**"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },

  {
    ignores: ["metro.config.js", "babel.config.js"],
  },
];
