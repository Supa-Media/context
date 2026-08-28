/**
 * @jest-environment jsdom
 */

import { describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The console is an application, not a card on a marketing page.
 *
 * This is the regression guard for the thing the rebuild exists to fix. The
 * console used to mount inside a `ScrollView` → decorative backdrop → 1200px
 * centred wrap, with a "Context.lc" wordmark and a Sign out button in a header
 * above it and a "Free. You bring the bucket · MIT · self-hostable" footer
 * below. Every one of those is landing-page furniture, and each could be
 * reintroduced by one well-meaning edit — a wordmark "for consistency", a
 * footer "so the license is visible", a wrap "so it does not look too wide".
 *
 * So the assertions are literal: that copy must not appear in the signed-in
 * console, the frame must be present, the identity must be in the rail, and
 * nothing above the frame may scroll.
 *
 * The landing page keeps all of it, and should — there the console is a
 * *picture* of the product. `landingActionsCentering.test.ts` covers that side.
 */

// `mock`-prefixed so `jest.mock`'s hoisted factories may close over them.
const mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };
let mockPathname = "/console/@seyi";

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => mockInsets,
}));

jest.mock("expo-router", () => ({
  Slot: () => null,
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  usePathname: () => mockPathname,
}));

jest.mock("@convex-dev/auth/react", () => ({
  useAuthActions: () => ({ signOut: async () => {} }),
}));

// The layout is what is under test; its data source is not. Mocking the hook
// rather than Convex keeps this a test about chrome.
jest.mock("../features/console/useLiveConsoleData", () => ({
  useLiveConsoleData: () => mockConsoleData(),
}));

const { emptyEditor } =
  require("../features/console/files/editor") as typeof import("../features/console/files/editor");

function mockConsoleData(): never {
  const files = {
    canEdit: true,
    loading: false,
    busy: false,
    listings: {
      "": {
        path: "",
        folderDefault: "private" as const,
        truncated: false,
        manifestUsable: true,
        entries: [
          {
            kind: "folder" as const,
            path: "1-projects",
            name: "1-projects",
            visibility: "team" as const,
            inherited: "private" as const,
            exception: true,
            readOnly: false,
          },
        ],
      },
    },
    expanded: new Set<string>(),
    toggleFolder: () => {},
    selectedPath: null,
    select: () => {},
    editor: emptyEditor,
    setDraft: () => {},
    save: () => {},
    useTheirs: () => {},
    keepMine: () => {},
    discard: () => {},
    notice: null,
    dismissNotice: () => {},
    clipboard: null,
    copy: () => {},
    cut: () => {},
    paste: () => {},
    createNote: () => {},
    createFolder: () => {},
    rename: () => {},
    move: () => {},
    duplicate: () => {},
    archive: () => {},
    destroy: () => {},
    setVisibility: () => {},
  };

  return {
    demo: false,
    viewer: { name: "@seyi", detail: "seyi@context.lc", initial: "S" },
    contexts: [
      {
        id: "w1",
        slug: "seyi",
        displayName: "Seyi",
        role: "owner",
        kind: "personal",
        status: "ok",
      },
    ],
    selectedContextId: "w1",
    selectContext: () => {},
    graph: { nodes: [], edges: [] },
    stats: [],
    clients: [],
    storage: {
      connected: true,
      status: "connected",
      provider: "Cloudflare R2",
      bucket: "example-bucket",
      endpoint: "https://example.invalid",
      region: "auto",
      accessKey: "EXAMPLEKEY",
      conditionalWrite: true,
    },
    endpoint: "https://example.invalid/mcp",
    ingestionAddress: "seyi@context.lc",
    ingestion: { settings: null, loading: false },
    files,
    members: { members: [], loading: false },
    loading: false,
    failure: null,
  } as never;
}

const { layout } = require("../features/design/tokens") as typeof import("../features/design/tokens");

const ConsoleLayout = (
  require("../app/(app)/console/_layout") as { default: () => unknown }
).default;

/* -------------------------------------------------------------------------- */

function mountConsole(width = 1440) {
  // react-native-web measures `document.documentElement.clientWidth`, which
  // jsdom reports as 0 — see `appFrameRender.test.ts` for the full trap.
  Object.defineProperty(document.documentElement, "clientWidth", {
    value: width,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, "clientHeight", {
    value: 900,
    configurable: true,
  });
  window.dispatchEvent(new Event("resize"));

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });

  act(() => {
    root.render(createElement(ConsoleLayout as never));
  });

  const find = (testId: string) =>
    container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

  return {
    text: () => container.textContent ?? "",
    find,
    press: (node: HTMLElement | null) => {
      if (node === null) throw new Error("nothing to press");
      act(() => {
        node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    },
    byLabel: (label: string) =>
      container.querySelector<HTMLElement>(`[aria-label="${label}"]`),
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/* -------------------------------------------------------------------------- */

describe("the signed-in console carries no marketing chrome", () => {
  test("the footer is gone", () => {
    const app = mountConsole();
    const text = app.text();

    expect(text).not.toContain("Free. You bring the bucket");
    expect(text).not.toContain("MIT · self-hostable");
    expect(text).not.toContain("self-hostable");

    app.unmount();
  });

  test("the wordmark header is gone", () => {
    // It existed only to hold a Sign out button, which now lives in the rail.
    const app = mountConsole();
    expect(app.text()).not.toContain("Context.lc");
    app.unmount();
  });

  test("signing out is in the rail, not floating above the product", () => {
    const app = mountConsole();
    expect(app.find("rail-sign-out")).not.toBeNull();
    app.unmount();
  });
});

describe("the console is mounted in the application frame", () => {
  test("the frame is there and the explorer is a region of it", () => {
    const app = mountConsole();

    expect(app.find("app-frame")).not.toBeNull();
    // Browse has a tree, so the frame gets an explorer.
    expect(app.find("explorer-tree")).not.toBeNull();
    expect(app.find("explorer-resizer")).not.toBeNull();
    expect(app.find("console-status")).not.toBeNull();

    app.unmount();
  });

  test("nothing above the frame scrolls", () => {
    // The original bug in one assertion: the console inside a page that
    // scrolls, with the tree scrolling again inside it.
    const app = mountConsole();
    let node: HTMLElement | null = app.find("app-frame");
    expect(node).not.toBeNull();

    while (node !== null && node !== document.body) {
      const overflow = window.getComputedStyle(node).getPropertyValue("overflow-y");
      expect(["auto", "scroll"]).not.toContain(overflow);
      node = node.parentElement;
    }

    app.unmount();
  });

  test("a route with no tree gets no explorer column", () => {
    // Map spans every context; there is no single tree that belongs beside it.
    mockPathname = "/console";
    const app = mountConsole();

    expect(app.find("app-frame")).not.toBeNull();
    expect(app.find("explorer-tree")).toBeNull();
    expect(app.find("explorer-resizer")).toBeNull();

    app.unmount();
    mockPathname = "/console/@seyi";
  });
});

describe("on a phone", () => {
  test("the tree is a drawer, and the toolbar replaces the status bar", () => {
    const app = mountConsole(390);

    expect(app.find("frame-drawer-toggle")).not.toBeNull();
    // Not merely off-screen — not mounted until it is asked for.
    expect(app.find("explorer-tree")).toBeNull();
    expect(app.find("console-status")).toBeNull();
    expect(app.find("bottom-bar")).not.toBeNull();

    app.unmount();
  });

  test("the toolbar is the only route to the commands with no gesture", () => {
    // There is no keyboard here and no right-click. Creating and searching are
    // not things you do *to* an existing note, so the row's long-press menu
    // cannot reach them — this bar is it.
    const app = mountConsole(390);
    const text = app.container.textContent ?? "";

    // Labels, not glyphs: the glyphs are aria-hidden, so what a screen reader
    // gets is the whole affordance.
    const labels = Array.from(app.container.querySelectorAll("[aria-label]")).map((node) =>
      node.getAttribute("aria-label"),
    );
    expect(labels).toContain("Search notes");
    expect(labels).toContain("New note");
    expect(text).not.toBe("");

    app.unmount();
  });
});

describe("search", () => {
  test("a pointer gets the ⌘K field; a phone gets the toolbar button", () => {
    const desktop = mountConsole(1440);
    expect(desktop.find("frame-search")).not.toBeNull();
    desktop.unmount();

    // Doubling the same control onto the screen with least room for it would
    // be the obvious "consistency" fix and the wrong one.
    const phone = mountConsole(390);
    expect(phone.find("frame-search")).toBeNull();
    phone.unmount();
  });
});

/* -------------------------------------------------------------------------- */

/**
 * The way off a pane, on a phone, end to end.
 *
 * `appFrameRender.test.ts` proves the frame *can* raise and dismiss the sheet;
 * this proves the console actually wires it up. That gap was real and total:
 * deleting `frame.closeNav()` from the rail's `onNavigate` left all 1113 tests
 * in this suite green, and it is the single line that makes the fix a way out
 * rather than a panel you have to dismiss by hand after every choice.
 *
 * Mounted at a phone width against the real layout, the real `ConsoleRail` and
 * the real `AppFrame` — only the data and the router are stubs.
 */
describe("the phone's way off a pane", () => {
  test("choosing a destination dismisses the sheet", () => {
    const app = mountConsole(390);

    expect(app.find("frame-nav-sheet")).toBeNull();
    app.press(app.find("frame-nav-toggle"));
    expect(app.find("frame-nav-sheet")).not.toBeNull();

    // Connections is an app-level pane, so this is a real change of route.
    app.press(app.byLabel("Connections"));
    expect(app.find("frame-nav-sheet")).toBeNull();
    expect(app.find("frame-scrim")).toBeNull();

    app.unmount();
  });

  test("and so does choosing the pane you are already on", () => {
    // The router has nothing to do here — `sameRoute` short-circuits it — and a
    // sheet that stays put because of that reads as a dead press.
    mockPathname = "/console";
    const app = mountConsole(390);

    app.press(app.find("frame-nav-toggle"));
    app.press(app.byLabel("Map"));
    expect(app.find("frame-nav-sheet")).toBeNull();

    app.unmount();
    mockPathname = "/console/@seyi";
  });

  test("sign-out is reachable, and is a target a thumb can hit", () => {
    // It lives at the foot of the rail and nowhere else, so before the sheet
    // existed there was no way to sign out on a phone at all.
    mockPathname = "/console";
    const app = mountConsole(390);
    app.press(app.find("frame-nav-toggle"));

    const signOut = app.find("rail-sign-out");
    expect(signOut).not.toBeNull();

    const box = window.getComputedStyle(signOut!);
    expect(Number.parseFloat(box.width)).toBeGreaterThanOrEqual(layout.minTouchTarget);
    expect(Number.parseFloat(box.height)).toBeGreaterThanOrEqual(layout.minTouchTarget);

    app.unmount();
    mockPathname = "/console/@seyi";
  });
});
