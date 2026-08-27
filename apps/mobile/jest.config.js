/**
 * Jest config.
 *
 * Two kinds of test live here, and both run in plain node with no app boot:
 *
 *  - `supa-framework.test.js` — the @supa-media/testing static guardrails
 *    (routing conflicts, web bundle safety, React resolution, native imports).
 *  - `*.test.ts` — unit tests for the parts of the app that are real logic:
 *    map layout maths, the copy-to-clipboard state machine, auth redirect
 *    rules, and console formatting. Most modules under test are deliberately
 *    free of React and React Native imports, so they need neither a renderer
 *    nor native mocks — which is why there is no `jest-expo` preset here and no
 *    new dependency to add one.
 *  - a few `@jest-environment jsdom` files that mount real components and
 *    hooks, because some bugs are only visible to a reconciler: a render-phase
 *    `setState` loop, a query that throws during render, a button whose handler
 *    never reaches the client. See `consoleRenderLoop.test.ts` for why a
 *    string renderer cannot catch those.
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
  // Render React Native components as `react-native-web` does, which is how
  // this app already ships to the browser. It costs no new dependency and no
  // native mocks: `react-native-web`'s `main` is a CommonJS build, so it needs
  // no transform, and it renders real DOM with the real text in it — which is
  // what lets a test assert that a screen does *not* show somebody a capture
  // address for a name the field is rejecting.
  moduleNameMapper: { "^react-native$": "react-native-web" },
  /**
   * Resolve `.web.ts` / `.web.tsx` ahead of the bare extension, the way Metro
   * does when it bundles for the browser.
   *
   * Without this the suite was in a contradictory state: it renders components
   * through `react-native-web` — the mapping above — while resolving every
   * platform split to its **native** half. So `clipboard.web.ts`,
   * `fonts.web.ts`, `leave.web.ts` and `rowInteractions.web.ts` were never once
   * executed by a test, and a test asserting web behaviour silently exercised
   * the native stub that deliberately does nothing. That is the same shape of
   * false green this project keeps producing, and it is worth the risk of
   * changing resolution for the whole suite to remove it.
   *
   * Native halves stay reachable by importing them by their explicit path.
   */
  moduleFileExtensions: ["web.ts", "web.tsx", "web.js", "ts", "tsx", "js", "jsx", "json", "node"],
};
