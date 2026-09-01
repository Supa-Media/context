/**
 * @jest-environment jsdom
 */

import { describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ConvexError } from "convex/values";

// React only treats `act` as authoritative when this is set, and warns loudly on
// every call when it is not. Setting it keeps the suite's output readable and
// makes an update outside `act` a signal rather than background noise.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The `(app)` gate, on a cold start.
 *
 * ## The crash this exists to prevent
 *
 * `AppLayout` asked for `listMyWorkspaces` unconditionally, above both the
 * "wait" and the "redirect" auth gates, on the reasoning that a subscription
 * nobody reads is harmless. It is not harmless: `listMyWorkspaces` calls
 * `requireAuth` and **throws** `NOT_AUTHENTICATED` for a client with no
 * identity, and Convex's `useQuery` re-throws a failed query *during render*.
 *
 * On a cold start the socket is live before the token has come back out of
 * SecureStore, so that subscription goes out unauthenticated and the error
 * lands in the render phase of the very layout that was about to redirect to
 * `/login`. There is no ErrorBoundary anywhere above it — not in `app/`, not in
 * `features/` — so the user gets expo-router's crash screen instead of the
 * sign-in page. The whole thing is invisible to a pure route-rule test, because
 * `resolveProtectedRoute` was always returning the right answer; the crash
 * happened before anybody could act on it.
 *
 * ## Why this file mocks what it mocks
 *
 * `useConvexAuth` reads a context only `ConvexProviderWithAuth` provides and
 * throws without one, so it is stubbed to whatever state the test is standing
 * in. `expo-router` is stubbed because a real router is not the thing under
 * test — where the layout decides to send you is. React Native itself needs no
 * stub: `jest.config.js` maps it to `react-native-web`.
 */

// `mock`-prefixed so `jest.mock`'s hoisted factories may close over them: the
// factory runs before the module body, and Jest only permits that for names it
// can see are deliberate.
let mockAuthState = { isLoading: true, isAuthenticated: false };
let mockPathname = "/console";
/**
 * The href including the query, which is what expo-router's own
 * `usePathname` deliberately throws away (`/acme?foo=bar` -> `/acme`).
 * Defaulted to the pathname so a test that does not care sets one thing.
 */
let mockHref: string | null = null;

jest.mock("expo-router", () => {
  const { createElement: h } = require("react") as typeof import("react");
  return {
    Redirect: ({ href }: { href: string }) =>
      h("div", { "data-testid": "redirect", "data-href": href }),
    Stack: () => h("div", { "data-testid": "stack" }),
    usePathname: () => mockPathname,
    useUnstableGlobalHref: () => mockHref ?? mockPathname,
  };
});

jest.mock("convex/react", () => {
  const actual = jest.requireActual("convex/react") as Record<string, unknown>;
  return { ...actual, useConvexAuth: () => mockAuthState };
});

// Imported after the mocks, which is what `jest.mock`'s hoisting is for.
/* eslint-disable @typescript-eslint/no-var-requires */
const { ConvexProvider } = require("convex/react") as typeof import("convex/react");
const AppLayout = (require("../app/(app)/_layout") as { default: () => unknown })
  .default as () => never;

/**
 * A client whose every query throws, the way an unauthenticated one does.
 *
 * `NOT_AUTHENTICATED` is what `requireAuth` raises. Convex's queries observer
 * catches a throw out of `localQueryResult` and hands the `Error` back as the
 * result, and `useQuery` then re-throws it during render — so a fake that
 * throws here reproduces the real crash exactly.
 */
function unauthenticatedClient() {
  let subscriptions = 0;
  const client = {
    watchQuery: () => {
      subscriptions++;
      return {
        localQueryResult: () => {
          throw new ConvexError({
            code: "NOT_AUTHENTICATED",
            message: "You must be signed in.",
          });
        },
        onUpdate: () => () => {},
        journal: () => undefined,
      };
    },
    watchPaginatedQuery: () => ({
      localQueryResult: () => undefined,
      onUpdate: () => () => {},
      journal: () => undefined,
    }),
    mutation: async () => undefined,
    action: async () => undefined,
    connectionState: () => ({ isWebSocketConnected: true }),
  };
  return { client: client as never, subscriptions: () => subscriptions };
}

/** A client that answers `listMyWorkspaces` normally. */
function signedInClient(workspaces: unknown[]) {
  const client = {
    watchQuery: () => ({
      localQueryResult: () => workspaces,
      onUpdate: () => () => {},
      journal: () => undefined,
    }),
    watchPaginatedQuery: () => ({
      localQueryResult: () => undefined,
      onUpdate: () => () => {},
      journal: () => undefined,
    }),
    mutation: async () => undefined,
    action: async () => undefined,
    connectionState: () => ({ isWebSocketConnected: true }),
  };
  return client as never;
}

function render(client: never): { html: string; error: Error | null } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, {
    onUncaughtError: () => {},
    onCaughtError: () => {},
  });

  let error: Error | null = null;
  try {
    act(() => {
      root.render(createElement(ConvexProvider, { client }, createElement(AppLayout)));
    });
  } catch (thrown) {
    error = thrown as Error;
  }
  const html = container.innerHTML;
  try {
    act(() => root.unmount());
  } catch {
    // A root that already failed cannot always be unmounted cleanly.
  }
  container.remove();
  return { html, error };
}

describe("the (app) gate on a cold start", () => {
  test("does not subscribe while the stored token is still being restored", () => {
    mockAuthState = { isLoading: true, isAuthenticated: false };
    const { client, subscriptions } = unauthenticatedClient();

    const { error } = render(client);

    expect(error).toBeNull();
    // Not merely "did not crash": nothing was asked for at all. The socket is
    // live at this point, so a subscription here is a real request from a
    // client that has no identity yet.
    expect(subscriptions()).toBe(0);
  });

  test("redirects a signed-out visitor to sign in instead of crashing", () => {
    mockAuthState = { isLoading: false, isAuthenticated: false };
    const { client, subscriptions } = unauthenticatedClient();

    const { html, error } = render(client);

    expect(error).toBeNull();
    expect(html).toContain('data-href="/login"');
    expect(subscriptions()).toBe(0);
  });

  test("carries the whole link, query included, into the sign-in it triggers", () => {
    /**
     * **A team link survived sign-in as the context and not the note.**
     *
     * `teamShareLink` hands somebody
     * `/console/@seyi?note=3-resources/…md`, and the note is the entire
     * reason that URL exists rather than `/console/@seyi`. Following one
     * without a session on that device — a link sent to a colleague, opened
     * on a phone — went to `/login?next=/console/@seyi`, and they arrived
     * after signing in at the context's empty "choose a note" screen with no
     * way of knowing which note they had been sent.
     *
     * The cause was one hook: this gate passed `usePathname()`, and expo-router
     * documents that as returning the location **without search parameters**.
     * `safeNextRoute` was never the problem — it passes a query through
     * untouched — so nothing about the redirect rule was wrong, and no test of
     * it could have seen this.
     */
    mockAuthState = { isLoading: false, isAuthenticated: false };
    mockPathname = "/console/@seyi";
    mockHref = "/console/@seyi?note=3-resources/engineering/note.md";
    const { client } = unauthenticatedClient();

    const { html, error } = render(client);

    expect(error).toBeNull();
    expect(html).toContain(
      `data-href="/login?next=${encodeURIComponent(mockHref)}"`,
    );

    mockHref = null;
  });

  test("an href that is not a rooted path is refused, not followed", () => {
    // `useUnstableGlobalHref` is expo-router's own private hook and its doc
    // comment says it "may change in the future to include the hostname". If
    // it ever does, `safeNextRoute` refuses it for not being rooted and this
    // gate falls back to a bare `/login` — which is exactly what it did before
    // the query was carried at all. The failure direction is the safe one, and
    // it is asserted rather than assumed.
    mockAuthState = { isLoading: false, isAuthenticated: false };
    mockPathname = "/console/@seyi";
    mockHref = "https://context.lc/console/@seyi?note=a.md";
    const { client } = unauthenticatedClient();

    const { html, error } = render(client);

    expect(error).toBeNull();
    expect(html).toContain('data-href="/login"');
    expect(html).not.toContain("context.lc");

    mockHref = null;
  });

  test("still reads the context list once there is a session", () => {
    // The skip must not cost the gate its actual job.
    mockAuthState = { isLoading: false, isAuthenticated: true };
    mockPathname = "/console";

    const empty = render(signedInClient([]));
    expect(empty.error).toBeNull();
    expect(empty.html).toContain('data-href="/welcome"');

    const one = render(signedInClient([{ workspaceId: "w1", slug: "seyi" }]));
    expect(one.error).toBeNull();
    expect(one.html).toContain('data-testid="stack"');
  });
});
