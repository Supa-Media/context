/// <reference types="vite/client" />
/**
 * Module map for `convex-test`.
 *
 * `convexTest(schema, modules)` needs every function module eagerly globbed —
 * it has no filesystem access of its own. Keep the ignore list in sync with
 * what the Convex CLI itself skips (`_generated/*.js` is included because the
 * generated `api` object is a real runtime module).
 */
export const modules = import.meta.glob([
  "./**/*.ts",
  "./_generated/**/*.js",
  "!./__tests__/**",
  "!./node_modules/**",
  "!./*.config.ts",
  "!./*.setup.ts",
]);
