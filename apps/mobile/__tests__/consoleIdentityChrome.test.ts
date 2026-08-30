/**
 * @jest-environment jsdom
 */

import { describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The console's chrome, after the first live Dropbox connect.
 *
 * Three findings from one review, all in the frame rather than in any pane:
 *
 *  1. The storage pill read **"dropbox · undefined"** — the chip interpolated
 *     `provider · bucket` and a Dropbox binding has no bucket — and pressing
 *     it did nothing, so the binding it named was a fact with no way in.
 *  2. The rail listed every reachable context flat under "Contexts", so a
 *     context you own and a context you were invited into were
 *     indistinguishable at the moment of choosing which to open.
 *  3. The identity at the foot of the rail changed with the viewed context.
 *
 * `storagePill.test.ts`, `railSections.test.ts` and `viewerIdentity.test.ts`
 * prove the rules; this proves the real layout is wired to them, which is the
 * failure that actually shipped — the words on the glass, the press that
 * navigates, the headings in the rendered rail. The identity wiring from the
 * live hook is `viewerIdentityLive.test.ts`.
 *
 * `useWindowDimensions` is 0 under jsdom, so the width is stamped onto
 * `document.documentElement` the way `consoleChrome.test.ts` does, and nothing
 * asserted here lives behind a width branch.
 */

const mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };
const mockPushed: string[] = [];
let mockPathname = "/console/@seyi";

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => mockInsets,
}));

jest.mock("expo-router", () => ({
  Slot: () => null,
  useRouter: () => ({
    replace: () => {},
    push: (href: string) => {
      mockPushed.push(href);
    },
  }),
  usePathname: () => mockPathname,
}));

jest.mock("@convex-dev/auth/react", () => ({
  useAuthActions: () => ({ signOut: async () => {} }),
}));

jest.mock("../features/console/useLiveConsoleData", () => ({
  useLiveConsoleData: () => mockConsoleData(),
}));

const { emptyEditor } =
  require("../features/console/files/editor") as typeof import("../features/console/files/editor");

import type { ConsoleContext, ConsoleStorage } from "../features/console/types";

interface Shape {
  storage?: ConsoleStorage | null;
  contexts?: ConsoleContext[];
}

let shape: Shape = {};

const OWN_CONTEXT: ConsoleContext = {
  id: "w1",
  slug: "seyi",
  displayName: "Seyi",
  role: "owner",
  kind: "personal",
  status: "ok",
};

const SHARED_CONTEXT: ConsoleContext = {
  id: "w2",
  slug: "lk",
  displayName: "LK",
  role: "member",
  kind: "personal",
  status: "ok",
};

const S3_STORAGE: ConsoleStorage = {
  connected: true,
  status: "connected",
  provider: "Cloudflare R2",
  bucket: "example-bucket",
  endpoint: "https://example.invalid",
  region: "auto",
  accessKey: "EXAMPLEKEY",
  conditionalWrite: true,
  updatedAt: 0,
};

function mockConsoleData(): never {
  const files = {
    canEdit: true,
    loading: false,
    busy: false,
    listings: {},
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
    toasts: [],
    dismissToast: () => {},
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
    contexts: shape.contexts ?? [OWN_CONTEXT],
    selectedContextId: (shape.contexts ?? [OWN_CONTEXT])[0]!.id,
    selectContext: () => {},
    graph: { nodes: [], edges: [] },
    stats: [],
    clients: [],
    storage: shape.storage === undefined ? S3_STORAGE : shape.storage,
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

function mountConsole(next: Shape = {}, width = 1440) {
  shape = next;
  mockPushed.length = 0;

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
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const DROPBOX_STORAGE: ConsoleStorage = {
  connected: true,
  status: "connected",
  provider: "dropbox",
  conditionalWrite: true,
  updatedAt: 0,
};

/* -------------------------------------------------------------------------- */

describe("the storage pill on a Dropbox binding", () => {
  test("says Dropbox — never 'undefined' — with the folder when there is one", () => {
    const bare = mountConsole({ storage: DROPBOX_STORAGE });
    expect(bare.text()).toContain("Dropbox");
    expect(bare.text()).not.toContain("undefined");
    bare.unmount();

    const scoped = mountConsole({
      storage: { ...DROPBOX_STORAGE, rootPrefix: "second/" },
    });
    expect(scoped.text()).toContain("Dropbox · second/");
    expect(scoped.text()).not.toContain("undefined");
    scoped.unmount();
  });

  test("pressing it opens this context's storage settings", () => {
    const app = mountConsole({ storage: DROPBOX_STORAGE });
    app.press(app.find("storage-pill"));
    expect(mockPushed).toEqual(["/console/@seyi/settings"]);
    app.unmount();
  });
});

describe("the storage pill on every other binding", () => {
  test("an S3-family binding keeps its provider · bucket words", () => {
    const app = mountConsole({});
    expect(app.text()).toContain("R2 · example-bucket");
    app.unmount();
  });

  test("and is a press target too — the way in is not Dropbox-only", () => {
    const app = mountConsole({});
    app.press(app.find("storage-pill"));
    expect(mockPushed).toEqual(["/console/@seyi/settings"]);
    app.unmount();
  });

  test("no bucket connected is still a way in, because settings is where one gets connected", () => {
    const app = mountConsole({ storage: null });
    expect(app.text()).toContain("no bucket connected");
    app.press(app.find("storage-pill"));
    expect(mockPushed).toEqual(["/console/@seyi/settings"]);
    app.unmount();
  });
});

/* -------------------------------------------------------------------------- */

describe("the rail's two context sections, rendered", () => {
  test("own and shared contexts sit under different headings", () => {
    const app = mountConsole({ contexts: [OWN_CONTEXT, SHARED_CONTEXT] });
    const text = app.text();

    expect(text).toContain("Yours");
    expect(text).toContain("Shared with you");
    // Both rows are still reachable entries.
    expect(app.container.querySelector('[aria-label="Open @seyi"]')).not.toBeNull();
    expect(app.container.querySelector('[aria-label="Open @lk"]')).not.toBeNull();

    app.unmount();
  });

  test("an account with nothing shared sees no 'Shared with you' header", () => {
    const app = mountConsole({ contexts: [OWN_CONTEXT] });
    expect(app.text()).not.toContain("Shared with you");
    app.unmount();
  });

  test("an invited-only account sees no empty 'Yours' section — the claim entry is its whole content", () => {
    const app = mountConsole({ contexts: [SHARED_CONTEXT] });
    // `offerOwnContext` answers yes for an invitee, so the group survives to
    // hold the one entry that matters to them…
    expect(app.find("rail-claim-context")).not.toBeNull();
    // …and their guest context still lives under the shared heading, not
    // beside the claim entry.
    expect(app.text()).toContain("Shared with you");
    app.unmount();
  });
});
