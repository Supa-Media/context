/**
 * @jest-environment jsdom
 */

import { beforeEach, describe, expect, jest, test } from "@jest/globals";
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
 * `storagePill.test.ts`, `railGroup.test.ts` and `viewerIdentity.test.ts`
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
const mockReplaced: string[] = [];
let mockQuickParams: { quickAction?: string } = {};
let mockPathname = "/console/@seyi";

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => mockInsets,
}));

const mockParamsSet: Record<string, string | undefined>[] = [];

jest.mock("expo-router", () => ({
  Slot: () => null,
  useRouter: () => ({
    replace: (href: string) => {
      mockReplaced.push(href);
      mockQuickParams = {};
    },
    push: (href: string) => {
      mockPushed.push(href);
    },
    // Settings is a parameter on the page somebody is already on, not a
    // navigation to a new one — that is what keeps an open note open behind
    // the overlay. Recorded as the URL it produces so the assertions below
    // still read as "where pressing this lands you".
    setParams: (params: Record<string, string | undefined>) => {
      mockParamsSet.push(params);
    },
  }),
  usePathname: () => mockPathname,
  useLocalSearchParams: () => mockQuickParams,
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

/** A shared workspace the viewer created. `owner`, and deliberately not personal. */
const WORKSPACE_CONTEXT: ConsoleContext = {
  id: "w3",
  slug: "acme-eng",
  displayName: "Acme Engineering",
  role: "owner",
  kind: "shared",
  status: "ok",
};

/** A workspace somebody let the viewer into. */
const WORKSPACE_GUEST: ConsoleContext = {
  id: "w4",
  slug: "public-worship",
  displayName: "Public Worship",
  role: "editor",
  kind: "shared",
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
    conflict: null,
    resolveWith: () => {},
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
    // `?? null` rather than `[0]!.id`: an account with *no* contexts is a
    // state this file now mounts — it is where the claim entry lives.
    selectedContextId: (shape.contexts ?? [OWN_CONTEXT])[0]?.id ?? null,
    selectContext: () => {},
    graph: { nodes: [], edges: [] },
    stats: [],
    clients: [],
    storage: shape.storage === undefined ? S3_STORAGE : shape.storage,
    endpoint: "https://example.invalid/mcp",
    ingestionAddress: "seyi@context.lc",
    ingestion: { settings: null, loading: false },
    files,
    // Required on `ConsoleData`, and read by the status strip and the phone's
    // tree footer for how much of this context is indexed. `status: null` is
    // "not answered yet", so neither draws a figure — `indexProgressSurfaces`
    // is where that is the subject rather than a fixture detail.
    fastSearch: { status: null, loading: false },
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
  mockParamsSet.length = 0;

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

  /*
    `document.body`, not the container: the switcher's list is a `Menu`, which
    react-native-web renders through a portal outside the tree it was declared
    in. Querying the container alone would report every row as absent.
  */
  const find = (testId: string) =>
    document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

  const clickNode = (node: HTMLElement | null) => {
    if (node === null) throw new Error("nothing to press");
    act(() => {
      node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };

  return {
    /**
     * Open the workspace switcher, which is where the rail's list went.
     *
     * The list used to be a column and its rows were in the tree from the
     * first render, so these tests read them straight off the console. It is a
     * menu under the workspace's name now (`SwitcherMenu`), so the rows exist
     * once it has been opened — which is a press, and the only difference this
     * fold makes to what they assert.
     */
    openSwitcher: () => {
      clickNode(document.body.querySelector<HTMLElement>('[data-testid="frame-switcher"]'));
    },
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

beforeEach(() => {
  mockQuickParams = {};
  mockReplaced.length = 0;
});

/* -------------------------------------------------------------------------- */

describe("the widget note command is consumed", () => {
  test("opens once, then a remount of the clean history entry stays idle", () => {
    mockQuickParams = { quickAction: "note" };
    const first = mountConsole();
    expect(document.body.textContent).toContain("It will be created in 0-inbox as markdown.");
    expect(mockReplaced).toEqual(["/console/@seyi"]);
    first.unmount();

    const returned = mountConsole();
    expect(document.body.textContent).not.toContain("It will be created in 0-inbox as markdown.");
    expect(mockReplaced).toEqual(["/console/@seyi"]);
    returned.unmount();
  });
});

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
    expect(mockParamsSet).toEqual([{ settings: "workspace" }]);
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
    expect(mockParamsSet).toEqual([{ settings: "workspace" }]);
    app.unmount();
  });

  test("no bucket connected is still a way in, because settings is where one gets connected", () => {
    const app = mountConsole({ storage: null });
    expect(app.text()).toContain("no bucket connected");
    app.press(app.find("storage-pill"));
    expect(mockParamsSet).toEqual([{ settings: "workspace" }]);
    app.unmount();
  });
});

/* -------------------------------------------------------------------------- */

/**
 * The one context list, rendered — in the switcher, where the rail's was.
 *
 * **Every test here used to read the rows straight off the console**, because
 * the rail was a column and its entries were in the tree from the first frame.
 * The rail folded into `SwitcherMenu` (`docs/decisions/app-and-console.md`),
 * so each one opens the menu first and reads the rows out of it. What they
 * assert — one list, the pin, the mark, the two offers and where each is drawn
 * — is unchanged, and that is the point of rewriting them rather than deleting
 * them: they are §1464's reversal guards, and the decision they guard moved
 * container without changing.
 */
describe("the one context list, rendered", () => {
  /** Every row in one list, and the retired noun nowhere on the glass. */
  test("every context sits in one list", () => {
    const app = mountConsole({ contexts: [OWN_CONTEXT, SHARED_CONTEXT, WORKSPACE_CONTEXT] });
    app.openSwitcher();
    const text = document.body.textContent ?? "";

    expect(text).not.toMatch(/brain/i);
    /*
      The headings the old splits drew are gone, and so is the one that
      replaced them. "Workspaces" was the rail's, over a column; a six-row menu
      with a heading over its only group is a row spent saying what the rows
      already say. `railGroup.heading` is still drawn by `ConsoleShell`, which
      is the landing page's picture of a console that still has a rail.
    */
    expect(text).not.toContain("Shared with you");
    // Every row is still a reachable entry.
    expect(app.find("switcher-context-seyi")).not.toBeNull();
    expect(app.find("switcher-context-lk")).not.toBeNull();
    expect(app.find("switcher-context-acme-eng")).not.toBeNull();

    app.unmount();
  });

  /**
   * The pin, on the glass rather than in `railGroup`'s return value. The
   * viewer's own workspace arrives third here and must still be drawn first —
   * personal and shared contexts interleaved in one run is exactly the case
   * the two headed groups used to make impossible.
   */
  test("the viewer's own workspace is drawn first, whatever order it arrived in", () => {
    const app = mountConsole({
      contexts: [WORKSPACE_GUEST, WORKSPACE_CONTEXT, OWN_CONTEXT, SHARED_CONTEXT],
    });
    app.openSwitcher();
    const rows = [...document.body.querySelectorAll("[data-testid]")]
      .map((node) => node.getAttribute("data-testid") ?? "")
      .filter((id) => id.startsWith("switcher-context-"));

    expect(rows[0]).toBe("switcher-context-seyi");
    // A pin and not a sort: the rest keep the order they came in.
    expect(rows).toEqual([
      "switcher-context-seyi",
      "switcher-context-public-worship",
      "switcher-context-acme-eng",
      "switcher-context-lk",
    ]);

    app.unmount();
  });

  /**
   * Where ownership went. Somebody else's personal context sits in the same
   * list as yours, so the mark is the only thing separating them — and it must
   * appear exactly once, on the right row.
   */
  test("only the viewer's own workspace is marked", () => {
    const app = mountConsole({ contexts: [OWN_CONTEXT, SHARED_CONTEXT, WORKSPACE_CONTEXT] });
    app.openSwitcher();
    expect((document.body.textContent ?? "").match(/yours/g)?.length ?? 0).toBe(1);

    expect(app.find("switcher-context-seyi")?.textContent).toContain("yours");
    // Not on somebody else's personal context, and not on a shared workspace
    // the viewer created — `WORKSPACE_CONTEXT` is `role: "owner"`, which is the
    // half of the test that fails if the mark is derived from role alone.
    expect(app.find("switcher-context-lk")?.textContent).not.toContain("yours");
    expect(app.find("switcher-context-acme-eng")?.textContent).not.toContain("yours");

    app.unmount();
  });

  test("an account in no shared workspace still gets the new-workspace entry", () => {
    const app = mountConsole({ contexts: [OWN_CONTEXT] });
    app.openSwitcher();
    expect(app.find("switcher-context-seyi")).not.toBeNull();
    expect(app.find("switcher-new")).not.toBeNull();
    app.unmount();
  });

  /**
   * The empty state and the claim entry are alternatives, not neighbours.
   *
   * Both are for an account with nothing in the list, and the old two-group
   * rail could draw them together — "Nothing here yet" sitting above a live
   * offer, which reads as a screen that failed to load *and* a screen that
   * works. With one group the rail has to choose, and it chooses the offer.
   */
  test("an empty account offered a name gets the offer, not 'Nothing here yet'", () => {
    const app = mountConsole({ contexts: [] });
    app.openSwitcher();
    expect(app.find("switcher-claim")).not.toBeNull();
    expect(document.body.textContent ?? "").not.toContain("Nothing here yet");
    app.unmount();
  });

  /**
   * The claim entry stands in for the pinned row, so it is drawn *where that
   * row would be* — above the contexts, not under them. Somebody invited into
   * one workspace and owning nothing is the only person who ever sees it.
   */
  test("an invited-only account sees the claim entry in the pinned top slot", () => {
    const app = mountConsole({ contexts: [WORKSPACE_GUEST] });
    app.openSwitcher();
    // `offerOwnContext` answers yes for an invitee…
    const claim = app.find("switcher-claim");
    expect(claim).not.toBeNull();
    expect(document.body.textContent ?? "").not.toMatch(/brain/i);

    // …and it leads the list, ahead of the workspace they were let into. The
    // slot is `railGroup`'s rule — the claim stands in for the row that would
    // be first — and it survived the move into the menu.
    const entry = app.find("switcher-context-public-worship");
    expect(entry).not.toBeNull();
    expect(
      claim!.compareDocumentPosition(entry!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    app.unmount();
  });
});
