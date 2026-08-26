/**
 * Jest config.
 *
 * Two kinds of test live here, and both run in plain node with no app boot:
 *
 *  - `supa-framework.test.js` — the @supa-media/testing static guardrails
 *    (routing conflicts, web bundle safety, React resolution, native imports).
 *  - `*.test.ts` — unit tests for the parts of the app that are real logic:
 *    map layout maths, the copy-to-clipboard state machine, auth redirect
 *    rules, and console formatting. Every module under test is deliberately
 *    free of React and React Native imports, so it needs neither a renderer nor
 *    native mocks — which is why there is no `jest-expo` preset here and no new
 *    dependency to add one.
 */
module.exports = {
  testEnvironment: "node",
  testMatch: ["**/__tests__/**/*.test.js", "**/__tests__/**/*.test.ts"],
  transform: {
    "^.+\\.[jt]sx?$": ["babel-jest", { presets: ["babel-preset-expo"] }],
  },
  // `babel-preset-expo` rewrites `process.env.EXPO_PUBLIC_*` into an import of
  // `expo/virtual/env`, which ships as ESM. Node's default "never transform
  // node_modules" would then hand Jest an untransformed `export`. Letting the
  // `expo` package itself through the transform is the same fix `jest-expo`
  // applies; everything else in node_modules stays untouched.
  transformIgnorePatterns: ["/node_modules/(?!(\\.pnpm/)?expo(@|/))"],
};
