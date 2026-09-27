/**
 * @jest-environment jsdom
 */

/**
 * The homepage is the console's own frame, not a copy of it.
 *
 * It used to compose `AppFrame` itself, and every piece of the console it did
 * not copy was missing there: the account button at the foot of the tree, the
 * eye, Share, `‹ ›` (the owner's report, 2026-09-26). It now renders
 * `ConsoleFrame`, so these assert the console's own controls by the test ids
 * the console gives them — a copy would have to reuse every id to pass — and
 * then what a visitor gets in place of an account: Sign in, a Share that
 * copies the page's link, and no request to the server at all.
 *
 * SABOTAGE: rendering the old hand-built frame in `HomeShell` fails the first
 * test; dropping `onSignIn` from `ConsoleFrame`'s visitor switcher fails the
 * second; sending Share to the dialog fails the third.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

// `mock`-prefixed so `jest.mock`'s hoisted factories may close over them.
const mockPushed: unknown[] = [];
const mockServer: string[] = [];
const mockCopied: string[] = [];
const mockAuth = { isAuthenticated: false, isLoading: false };
const mockSite = {
  kind: "live",
  snapshot: {
    pages: [
      { path: "index.md", routePath: "/", title: "Welcome", markdown: "# Welcome\n\nSee [pricing](pricing.md)." },
      { path: "pricing.md", routePath: "/pricing", title: "Pricing", markdown: "# Pricing" },
    ],
    emoji: {},
  },
};

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock("expo-router", () => ({
  useRouter: () => ({
    push: (href: unknown) => mockPushed.push(href),
    replace: (href: unknown) => mockPushed.push(href),
    setParams: () => {},
    back: () => {},
  }),
  usePathname: () => "/",
  useLocalSearchParams: () => ({}),
  useGlobalSearchParams: () => ({}),
}));

/*
  Every way into the control plane, recorded. A visitor is not signed in, so
  anything reaching one of these is a request that fails on the homepage — or
  worse, one that succeeds.
*/
jest.mock("convex/react", () => ({
  useConvex: () => ({
    query: async () => {
      mockServer.push("query");
    },
  }),
  useQuery: () => {
    mockServer.push("useQuery");
    return undefined;
  },
  useMutation: () => async () => {
    mockServer.push("mutation");
  },
  useAction: () => async () => {
    mockServer.push("action");
  },
  useConvexAuth: () => mockAuth,
}));
jest.mock("@convex-dev/auth/react", () => ({
  useAuthActions: () => ({ signOut: async () => {} }),
}));
jest.mock("../features/agent/useConsoleGrant", () => ({
  useConsoleGrant: () => async () => {
    mockServer.push("grant");
  },
}));
// The site as the router injects it; `useHomeSite` itself is not under test.
jest.mock("../features/home/useHomeSite", () => ({ useHomeSite: () => mockSite }));
jest.mock("../features/design/clipboard", () => ({
  writeClipboard: async (text: string) => {
    mockCopied.push(text);
    return true;
  },
}));

const { HomeShell } =
  require("../features/home/HomeShell") as typeof import("../features/home/HomeShell");

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
  mockPushed.length = 0;
  mockServer.length = 0;
  mockCopied.length = 0;
  mockAuth.isAuthenticated = false;
});

function mountHome(width = 1280) {
  Object.defineProperty(document.documentElement, "clientWidth", { value: width, configurable: true });
  Object.defineProperty(document.documentElement, "clientHeight", { value: 900, configurable: true });
  window.dispatchEvent(new Event("resize"));
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => root.render(createElement(HomeShell)));
  const find = (testId: string) => document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  const press = (node: HTMLElement | null) => {
    if (node === null) throw new Error("nothing to press");
    act(() => {
      for (const type of ["mousedown", "mouseup", "click"]) {
        node.dispatchEvent(new MouseEvent(type, { bubbles: true }));
      }
    });
  };
  return { find, press };
}

describe("the homepage is the console's frame", () => {
  test("the console's own controls are on it", () => {
    const home = mountHome();
    for (const id of ["account-switcher", "browse-read", "browse-share", "console-status", "console-create"]) {
      expect({ id, drawn: home.find(id) !== null }).toEqual({ id, drawn: true });
    }
    // The console's workspace name, at the foot where the app has it.
    expect(home.find("account-switcher")!.getAttribute("aria-label")).toMatch(/^Visitor, in @context/);
  });

  test("the account button offers a way in, and nothing an account has", () => {
    const home = mountHome();
    home.press(home.find("account-switcher"));
    expect(home.find("switcher-sign-in")).not.toBeNull();
    expect(home.find("switcher-create-account")).not.toBeNull();
    for (const absent of ["switcher-sign-out", "switcher-settings", "switcher-meetings", "switcher-new"]) {
      expect({ absent, drawn: home.find(absent) !== null }).toEqual({ absent, drawn: false });
    }
    home.press(home.find("switcher-sign-in"));
    expect(mockPushed).toContain("/login");
  });

  test("somebody signed in is not called a visitor, and is offered their workspaces", () => {
    mockAuth.isAuthenticated = true;
    const home = mountHome();
    expect(home.find("account-switcher")!.getAttribute("aria-label")).toMatch(/^Signed in, in @context/);
    home.press(home.find("account-switcher"));
    expect(home.find("switcher-sign-in")).toBeNull();
    home.press(home.find("switcher-open-app"));
    expect(mockPushed).toContain("/console");
  });

  test("Share copies the page's public address instead of opening a dialog", async () => {
    const home = mountHome();
    home.press(home.find("browse-share"));
    await act(async () => {});
    expect(mockCopied).toEqual([`${window.location.origin}/`]);
    expect(home.find("share-audience")).toBeNull();
  });

  test("a phone gets the console's phone chrome, and its Share copies too", async () => {
    const home = mountHome(390);
    expect(home.find("note-read")).not.toBeNull();
    home.press(home.find("note-share"));
    await act(async () => {});
    expect(mockCopied).toEqual([`${window.location.origin}/`]);
    expect(home.find("share-audience")).toBeNull();
  });

  test("nothing on it asks the server anything", async () => {
    const home = mountHome();
    await act(async () => {});
    home.press(home.find("console-create"));
    await act(async () => {});
    expect(mockServer).toEqual([]);
  });
});
