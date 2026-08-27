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
      // The gateway's half of the two-party secret. Obviously fake, and the
      // suite proves it never reaches a response or an audit row — which is
      // only checkable because the tests know what it is.
      GATEWAY_SECRET: "test-gateway-secret-not-a-real-one",
      // The Email Worker's own secret — a *different* value held by a different
      // pair of parties, for the reasons in `lib/gatewayAuth.ts`. Deliberately
      // not a prefix, suffix, or substring of the gateway's, so a test proving
      // "the gateway secret does not open an ingest route" cannot pass by
      // coincidence.
      EMAIL_WORKER_SECRET: "test-email-worker-secret-not-a-real-one",
      // Where the consent screen lives, and where an invitation link points.
      // `.invalid` is reserved by RFC 2606 and resolves nowhere, so a test that
      // accidentally made a request to it would fail rather than reach
      // something.
      APP_ORIGIN: "https://app.context.invalid",
      // The address invitation mail is sent from. Same convention `auth.ts`
      // uses for sign-in codes; `.invalid` again, so nothing here is a mailbox.
      AUTH_EMAIL_FROM: "invitations@context.invalid",
      // DELIBERATELY EMPTY, and it is the reason the rest of the suite is safe.
      // `sendInvitationEmail` checks this before it reads or writes anything,
      // so with no key every test that invites somebody takes no action at all
      // — no `fetch`, no sign-in code minted, no row touched. The email tests
      // set it themselves, for the length of one test, alongside a stubbed
      // `fetch`. Giving it a value here would point the whole suite at
      // api.resend.com.
      RESEND_API_KEY: "",
    },
  },
});
