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
    avatarInitial: "S",
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

  return {
    text: () => container.textContent ?? "",
    find: (testId: string) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`),
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

    app.unmount();
  });
});
