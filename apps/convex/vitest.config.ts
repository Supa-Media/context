import { defineConfig } from "vitest/config";

/**
 * `convex-test` runs the real functions against an in-memory Convex, so these
 * are integration tests of the authorization rules, not mocks of them. That
 * distinction matters: a mocked `requireWorkspaceAccess` would prove nothing
 * about tenant isolation.
 *
 * `edge-runtime` gives us the same Web Crypto the Convex runtime provides, so
 * the AES-GCM code under test is the code that ships.
 */
export default defineConfig({
  test: {
    environment: "edge-runtime",
    include: ["__tests__/**/*.test.ts"],
    // `@supa-media/convex` ships TypeScript source rather than a build, so it
    // has to be transformed by vite rather than imported natively by node.
    server: { deps: { inline: ["convex-test", "@supa-media/convex"] } },
    env: {
      // A deterministic 32-byte AES-256 key, base64. Obviously fake, and only
      // ever used by the test suite — this repository is public, so a real key
      // must never appear here or anywhere else in source.
      STORAGE_SECRET_ENCRYPTION_KEY:
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    },
  },
});
