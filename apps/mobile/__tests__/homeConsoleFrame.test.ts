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
const mockParams: { page?: string } = {};
const mockSite = {
  kind: "live",
  snapshot: {
    pages: [
      { path: "index.md", routePath: "/", title: "Welcome", markdown: "# Welcome\n\nSee [pricing](pricing.md)." },
      { path: "pricing.md", routePath: "/pricing", title: "Pricing", markdown: "# Pricing" },
    ],
    emoji: {},
    images: {},
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
  useGlobalSearchParams: () => mockParams,
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
  delete mockParams.page;
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

  /*
    Invite-only (Dev2, 2026-09-28): one way in, "Sign in or join", and it
    answers on this page. The menu row focuses the page's own field rather
    than opening /login.
  */
  test("the account button offers one way in, and it stays on the page", async () => {
    const index = mockSite.snapshot.pages[0]!;
    const before = index.markdown;
    index.markdown = "# Welcome\n\n```join\n```\n\nsee [pricing](pricing.md)";
    try {
      await signInFocusesTheField();
    } finally {
      index.markdown = before;
    }
  });

  async function signInFocusesTheField() {
    const home = mountHome();
    await act(async () => {});
    expect(home.find("join-card")).not.toBeNull();
    home.press(home.find("account-switcher"));
    expect(home.find("switcher-sign-in")).not.toBeNull();
    expect(home.find("switcher-create-account")).toBeNull();
    for (const absent of ["switcher-sign-out", "switcher-settings", "switcher-meetings", "switcher-new"]) {
      expect({ absent, drawn: home.find(absent) !== null }).toEqual({ absent, drawn: false });
    }
    home.press(home.find("switcher-sign-in"));
    await act(async () => {});
    expect(mockPushed).not.toContain("/login");
    const field = home.find("join-email");
    expect(field).not.toBeNull();
    expect(document.activeElement).toBe(field);
  }

  /*
    Dev2, 2026-09-29: the field goes where the page says, as the artboard drew
    it — a ```join fence where the button was — not above the note.
  */
  test("a page with a join fence draws the field there, and only there", async () => {
    const index = mockSite.snapshot.pages[0]!;
    const before = index.markdown;
    index.markdown = "# Welcome\n\nit's invite only for now.\n\n```join\n```\n\nthe end";
    try {
      const home = mountHome();
      await act(async () => {});
      const cards = document.querySelectorAll('[data-testid="join-card"]');
      expect(cards.length).toBe(1);
      expect(cards[0]!.closest(".cm-lp-join")).not.toBeNull();
      expect(home.find("join-email")).not.toBeNull();
    } finally {
      index.markdown = before;
    }
  });

  /*
    Dev2, 2026-10-03: on devlog and connect, pages with no fence, the field sat
    above the note at the pane's top-left corner, beside the page rather than
    in it. A page without a fence has no field; "Sign in or join" there opens
    the page that has one and focuses it.
  */
  test("a page without one has no field, and Sign in takes the visitor to the one that does", async () => {
    const index = mockSite.snapshot.pages[0]!;
    const before = index.markdown;
    index.markdown = "# Welcome\n\n```join\n```\n\nthe end";
    mockParams.page = "pricing";
    try {
      const home = mountHome();
      await act(async () => {});
      expect(home.find("join-card")).toBeNull();
      home.press(home.find("account-switcher"));
      home.press(home.find("switcher-sign-in"));
      expect(mockPushed).toEqual(["/"]);
    } finally {
      index.markdown = before;
    }
  });

  test("a site with no field anywhere sends Sign in to /login", async () => {
    const home = mountHome();
    await act(async () => {});
    expect(home.find("join-card")).toBeNull();
    home.press(home.find("account-switcher"));
    home.press(home.find("switcher-sign-in"));
    expect(mockPushed).toEqual(["/login"]);
  });

  test("somebody signed in still sees the page's own field", async () => {
    mockAuth.isAuthenticated = true;
    const index = mockSite.snapshot.pages[0]!;
    const before = index.markdown;
    index.markdown = "# Welcome\n\n```join\n```\n\nthe end";
    try {
      mountHome();
      await act(async () => {});
      const card = document.querySelector('[data-testid="join-card"]');
      expect(card).not.toBeNull();
      expect(card!.closest(".cm-lp-join")).not.toBeNull();
    } finally {
      index.markdown = before;
    }
  });

  test("somebody signed in has no join card", () => {
    mockAuth.isAuthenticated = true;
    const home = mountHome();
    expect(home.find("join-card")).toBeNull();
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

  /*
    `/pricing` is the page's address (it used to be `/?page=pricing`, and
    `/pricing` was the not-found screen). What Share hands out is the one a
    person would type.
  */
  test("Share copies a page's clean address, not its query string", async () => {
    mockParams.page = "pricing";
    const home = mountHome();
    home.press(home.find("browse-share"));
    await act(async () => {});
    expect(mockCopied).toEqual([`${window.location.origin}/pricing`]);
  });

  /*
    Share moved into ••• on a phone (owner, 2026-09-27, screen 2): a visitor's
    note-actions sheet offers Copy link, which is the same copy the pointer
    Share makes, and nothing that would write outside the tab.
  */
  test("a phone gets the console's phone chrome, and its Copy link copies too", async () => {
    const home = mountHome(390);
    expect(home.find("note-read")).not.toBeNull();
    expect(home.find("note-share")).toBeNull();
    home.press(home.find("note-actions"));
    expect(home.find("note-action-share")).toBeNull();
    expect(home.find("note-action-archive")).toBeNull();
    home.press(home.find("note-action-copy-link"));
    await act(async () => {});
    expect(mockCopied).toEqual([`${window.location.origin}/`]);
    expect(home.find("share-audience")).toBeNull();
  });

  /*
    The owner's phone screenshot (2026-09-27): the homepage's search listed
    `01-context.md` over a lone `/`, and three letters got "That search could
    not be run". It searches the notes in the tab now, and names them.
  */
  test("search names each page by its title and quotes the line that matched", async () => {
    const home = mountHome();
    home.press(home.find("frame-search"));
    const input = home.find("palette-input") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, "pri");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // Past the search's debounce, and its answer.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    const rows = [...document.body.querySelectorAll('[data-testid^="palette-row-"]')].map(
      (row) => row.textContent ?? "",
    );
    expect(rows[0]).toContain("Pricing");
    expect(rows.join("|")).not.toMatch(/\.md/);
    expect(rows.some((row) => row.includes("Welcome") && row.includes("@context · See pricing."))).toBe(true);
    expect(home.find("palette-empty")).toBeNull();
    expect(mockServer).toEqual([]);
  });

  /*
    The live site's Pricing page is `pricing.md` headed "free, you cheapo", and
    in a real build "pricing" found nothing: the row carried the heading and
    the ranker matched only that (2026-09-27).
  */
  test("search finds a page by its name when its heading says something else", async () => {
    mockSite.snapshot.pages.push({
      path: "plans.md",
      routePath: "/plans",
      title: "plans",
      markdown: "\n# free, you cheapo\n\nFive bucks a month.",
    });
    try {
      const home = mountHome();
      home.press(home.find("frame-search"));
      const input = home.find("palette-input") as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      act(() => {
        setter.call(input, "plans");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 400));
      });
      const rows = [...document.body.querySelectorAll('[data-testid^="palette-row-"]')].map(
        (row) => row.textContent ?? "",
      );
      expect(rows[0]).toContain("free, you cheapo");
      expect(home.find("palette-empty")).toBeNull();
    } finally {
      mockSite.snapshot.pages.pop();
    }
  });

  /*
    The account slot on a phone is the same component as the pointer's
    switcher, drawn as a "Sign in" pill for a visitor, and it opens the same
    rows as a bottom sheet (screen 9).
  */
  test("a phone visitor's account slot is a Sign in pill opening the same sheet", async () => {
    const home = mountHome(390);
    const pill = home.find("account-sign-in-pill");
    expect(pill).not.toBeNull();
    expect(pill!.textContent).toContain("Sign in");
    home.press(home.find("account-menu"));
    expect(home.find("menu-sheet")).not.toBeNull();
    // Invite-only: one row, "Sign in or join", and no "Create workspace".
    expect(home.find("switcher-sign-in")!.textContent).toContain("Sign in or join");
    expect(home.find("switcher-create-account")).toBeNull();
    expect(home.find("switcher-sign-out")).toBeNull();
  });

  test("nothing on it asks the server anything", async () => {
    const home = mountHome();
    await act(async () => {});
    home.press(home.find("console-create"));
    await act(async () => {});
    expect(mockServer).toEqual([]);
  });
});
