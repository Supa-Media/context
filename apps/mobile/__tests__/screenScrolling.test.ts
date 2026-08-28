/**
 * @jest-environment jsdom
 */

import { describe, expect, jest, test } from "@jest/globals";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Every control on the consent screen and the login screen has to be reachable
 * on a phone.
 *
 * ## The bug
 *
 * Both screens were a `flex: 1` box with `justifyContent: "center"` and
 * `overflow: "hidden"`, and **no ScrollView**. `app/+html.tsx` emits Expo
 * Router's `ScrollViewStyleReset`, which switches *document* scrolling off so
 * the body cannot fight a React Native `ScrollView` — so with no ScrollView in
 * the tree, nothing scrolls at all. Content taller than the viewport overflows
 * both ends of the centred box and is clipped.
 *
 * The consent body runs roughly 700–900px. On a 390×700 phone browser — where
 * an AI client's `/authorize?request_id=…` redirect lands somebody — **Approve
 * and Deny were off the screen with no way to reach them, so the OAuth flow
 * could not be completed on a phone at all.** Login clipped the same way once
 * the soft keyboard took half the viewport.
 *
 * ## What this test actually verifies, honestly
 *
 * This is a **render test, not a layout test.** It mounts the real screens
 * through `react-native-web` (which is how this app ships to the browser) and
 * asserts that the DOM node carrying the decision buttons has a **scrollable
 * ancestor** — an element whose resolved `overflow-y` is `auto` or `scroll` —
 * and that the ancestor's content container still carries `flex-grow: 1` and
 * `justify-content: center`, which is what keeps the centred look on a tall
 * desktop window.
 *
 * jsdom cannot lay anything out, so it cannot measure a clip. What it *can* do
 * is resolve `react-native-web`'s injected stylesheet, which is what makes
 * "there is something here that scrolls" a real assertion rather than a source
 * grep. The clipping itself was checked in a browser at 390×700, 390×844 and
 * on a desktop window; see the pull request.
 *
 * Both assertions have been verified to fail with the fix reverted — putting
 * `flex: 1` + `justifyContent: "center"` back on the wrapper and dropping the
 * ScrollView leaves no scrollable ancestor and the tests go red.
 */

// `mock`-prefixed so `jest.mock`'s hoisted factories may close over them.
const mockRouter = { replace: () => {}, push: () => {} };
let mockParams: Record<string, string> = {};

jest.mock("expo-router", () => {
  const { createElement: h } = require("react") as typeof import("react");
  return {
    Redirect: ({ href }: { href: string }) =>
      h("div", { "data-testid": "redirect", "data-href": href }),
    useRouter: () => mockRouter,
    useLocalSearchParams: () => mockParams,
  };
});

jest.mock("convex/react", () => {
  const actual = jest.requireActual("convex/react") as Record<string, unknown>;
  return {
    ...actual,
    useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
    useAction: () => async () => ({ redirectTo: "https://claude.ai/cb" }),
    useQueries: () => ({
      workspaces: [{ workspaceId: "w1", slug: "testagent1", role: "owner" }],
      request: {
        requestId: "req_abc",
        clientName: "An AI client",
        redirectUri: "https://claude.ai/api/mcp/auth_callback",
        scope: "context:read context:write",
        scopes: ["context:read", "context:write"],
        expiresAt: Date.now() + 300_000,
      },
    }),
  };
});

jest.mock("@convex-dev/auth/react", () => ({
  useAuthActions: () => ({ signIn: async () => {} }),
}));

// Imported after the mocks, which `jest.mock` hoists above them anyway.
import { ConsentScreen } from "../features/consent/ConsentScreen";
import { LoginScreen } from "../features/auth/LoginScreen";

function render(element: ReactElement): { container: HTMLElement; unmount: () => void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  act(() => {
    root.render(element);
  });
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/** The nearest ancestor that can actually scroll its overflow, if any. */
function scrollableAncestor(node: Element | null): HTMLElement | null {
  let current = node?.parentElement ?? null;
  while (current !== null) {
    const overflowY = getComputedStyle(current).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return current;
    current = current.parentElement;
  }
  return null;
}

function expectReachable(container: HTMLElement, testID: string) {
  const control = container.querySelector(`[data-testid="${testID}"]`);
  expect(control).not.toBeNull();

  const scroller = scrollableAncestor(control);
  // The failure this guards against is exactly "there is nothing above this
  // that can scroll", so that is the assertion.
  expect(scroller).not.toBeNull();

  // …and the centring has to survive it, or the fix trades a phone bug for a
  // desktop one: a login card jammed against the top of a 1440px window.
  const content = scroller!.firstElementChild as HTMLElement;
  const style = getComputedStyle(content);
  expect(style.flexGrow).toBe("1");
  expect(style.justifyContent).toBe("center");
}

describe("a screen's controls stay reachable at any viewport height", () => {
  test("the consent screen can scroll to Approve and Deny", () => {
    mockParams = { request_id: "req_abc" };
    const { container, unmount } = render(createElement(ConsentScreen));

    // The screen really did render its decision, rather than a loading card —
    // otherwise this would pass on a page with no buttons on it at all.
    expect(container.textContent).toContain("wants access to your context");

    expectReachable(container, "consent-approve");
    expectReachable(container, "consent-deny");
    unmount();
  });

  test("the login screen can scroll to its submit button", () => {
    mockParams = {};
    const { container, unmount } = render(createElement(LoginScreen));
    expect(container.textContent).toContain("Sign in or create your brain");
    expectReachable(container, "login-submit");
    unmount();
  });

  test("the scroll container is the page, not something inside the card", () => {
    // A `ScrollView` wrapped around only the scope list would satisfy "has a
    // scrollable ancestor" and fix nothing, because the buttons live outside
    // it. Anchor the assertion: the same element must be the scroller for the
    // mark at the very top of the page and for the button at the very bottom.
    mockParams = { request_id: "req_abc" };
    const { container, unmount } = render(createElement(ConsentScreen));

    const page = container.querySelector('[data-testid="consent-page"]');
    expect(page).not.toBeNull();
    expect(scrollableAncestor(container.querySelector('[data-testid="consent-approve"]'))).toBe(
      page,
    );
    expect(scrollableAncestor(container.querySelector('[data-testid="consent-context-single"]'))).toBe(
      page,
    );
    unmount();
  });
});
