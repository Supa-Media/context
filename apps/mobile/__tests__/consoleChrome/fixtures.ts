/**
 * @jest-environment jsdom
 */

import { afterEach, jest } from "@jest/globals";
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
 *
 * This module carries the shared mounting harness — the mocks, the console
 * fixture data, and `mountConsole` — for every file in this folder; it has no
 * tests of its own.
 */

// `mock`-prefixed so `jest.mock`'s hoisted factories may close over them.
const mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };

/**
 * Mutable state the mocked router and console data read, so a test can steer
 * either — reassigned rather than reimported, since an ES import binding
 * cannot be assigned to from outside the module that declares it.
 */
export const mockConsoleState: {
  pathname: string;
  /**
   * Whether this context has a model key, as `ConsoleData.modelConnected` says.
   *
   * Three values, and each is a state the console really has: `true` once the
   * subscription answers with a key, `false` once it answers with none, and
   * `undefined` for the moment before it answers at all.
   */
  modelConnected: boolean | undefined;
} = {
  pathname: "/console/@seyi",
  modelConnected: true,
};

/** What the `+` sheet asked the browser to make, as `<kind>:<folder>`. */
export const created: string[] = [];

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => mockInsets,
}));

/**
 * The router records nothing here, on purpose — **and that is a limit, not a
 * convenience.**
 *
 * This file is about the chrome: which surfaces exist, what they are called,
 * how big they are. It presses controls to prove they are reachable and never
 * asks where a press *went*, so a stub that swallows both methods is honest
 * about what is being observed. It is also why a whole feature could be deleted
 * under it: replacing `contextHrefFrom` with a plain root href in `_layout.tsx`
 * left every assertion below passing, because none of them can see an href.
 *
 * `lastPlaceConsole.test.ts` mounts this same layout at this same width with a
 * **recording** router and asserts the strings. Where a press sends somebody
 * belongs there; whether it is a target a thumb can hit belongs here.
 */
jest.mock("expo-router", () => ({
  /*
    The smallest thing a real pane is, and it has to be one.

    The contexts are no longer a slot in the frame's top bar — they are the
    first row of `NavBand`, drawn inside whatever scroller the pane below owns,
    which is what stops a phone's navigation lying across the note. So a `Slot`
    that renders `null` is not "the layout without a pane", it is a layout with
    the navigation missing, and every assertion about the strip below would be
    testing the fixture. `NavBand` with no path is exactly what `BrowsePane`
    renders at a context root and what `EditorRegion` renders on Map,
    Connections and Settings.
  */
  Slot: () => {
    const { createElement: h } = require("react") as typeof import("react");
    const { NavBand } =
      require("../../features/console/NavBand") as typeof import("../../features/console/NavBand");
    return h(NavBand);
  },
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  usePathname: () => mockConsoleState.pathname,
}));

jest.mock("@convex-dev/auth/react", () => ({
  useAuthActions: () => ({ signOut: async () => {} }),
}));

// The layout is what is under test; its data source is not. Mocking the hook
// rather than Convex keeps this a test about chrome.
/*
  The console layout mints this app's gateway grant through `useAgentEngine`,
  which is the first thing in it to reach `convex/react` directly — everything
  else goes through `useLiveConsoleData`, mocked below. The action is never
  called here: `VoiceButton` is what would call it, and nothing in this file
  asks the agent anything.
*/
// These layout fixtures have no authenticated gateway session.
jest.mock("../../features/agent/useConsoleGrant", () => ({
  useConsoleGrant: () => async () => { throw new Error("No fixture gateway session"); },
}));

jest.mock("convex/react", () => ({
  useAction: () => async () => {
    throw new Error("not used in this test");
  },
}));

jest.mock("../../features/console/useLiveConsoleData", () => ({
  useLiveConsoleData: () => mockConsoleData(),
}));

const { emptyEditor } =
  require("../../features/console/files/editor") as typeof import("../../features/console/files/editor");

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
    deselect: () => true,
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
    /* Recorded, so the `+` sheet's rows can be shown to reach the browser. */
    createUntitled: (folder: string, kind: string) => created.push(`${kind}:${folder}`),
    rename: () => {},
    move: () => {},
    duplicate: () => {},
    archive: () => {},
    destroy: () => {},
    setVisibility: () => {},
  };

  return {
    demo: false,
    modelConnected: mockConsoleState.modelConnected,
    viewer: { name: "@seyi", detail: "seyi@context.lc", initial: "S" },
    /*
      Two, not one, and the second is the point of the pair.

      A one-context account can tell you nothing about a *switcher*: the
      context you are in is drawn by the breadcrumb (`strip.ts`) and by the
      rail's selected row, so a list with only that in it renders the same
      whether or not the console can offer anything else. "The contexts you can
      reach" needs one you are not in.
    */
    contexts: [
      {
        id: "w1",
        slug: "seyi",
        displayName: "Seyi",
        role: "owner",
        kind: "personal",
        status: "ok",
      },
      {
        id: "w2",
        slug: "public-worship",
        displayName: "Public Worship",
        role: "editor",
        kind: "shared",
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
    // Read by the status strip and the phone's tree footer, which draw how much
    // of this context is indexed. `status: null` is "not answered yet", so
    // neither draws a figure — see `indexProgressSurfaces.test.ts`, which is
    // where that is the subject rather than a fixture detail.
    fastSearch: { status: null, loading: false },
    members: { members: [], loading: false },
    loading: false,
    failure: null,
  } as never;
}

export const { layout } = require("../../features/design/tokens") as typeof import("../../features/design/tokens");

export const ConsoleLayout = (
  require("../../app/(app)/console/_layout") as { default: () => unknown }
).default;

/* -------------------------------------------------------------------------- */

/**
 * Consoles this file has mounted, so a failing assertion cannot hand the next
 * test its DOM.
 *
 * Every test here reads `document.body` — the switcher's rows and the `+`'s
 * menu are portals — and each one ends with `app.unmount()`. That line does not
 * run when an assertion above it throws, so one red test used to leave a whole
 * live console in the body and the *next* test would find its controls: five
 * failures reported for one defect, four of them in tests about something else.
 * Tracked and torn down here instead, which is the same thing
 * `asidePanelRender.test.ts` does for the same reason.
 */
const mounted: (() => void)[] = [];

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!();
  document.body.replaceChildren();
  /*
    And the route, for the same reason: a test that sets `mockConsoleState.pathname`
    and then fails never reaches the line that sets it back, so the next test
    mounts a console on somebody else's route. Under a sabotage run that
    reported `bottom-bar-meeting` missing on a phone — a true statement about
    the Map route, and nothing to do with the defect being injected.
  */
  mockConsoleState.pathname = "/console/@seyi";
  mockConsoleState.modelConnected = true;
});

export function mountConsole(width = 1440) {
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

  mounted.push(() => {
    act(() => root.unmount());
    container.remove();
  });

  /*
    `document.body`, not the container: the switcher's rows are a `Menu`, which
    react-native-web renders through a portal outside the tree it was declared
    in. Querying the container alone reports every row in it as absent.
  */
  const find = (testId: string) =>
    document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

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

/** The meeting sheet is a `Modal`, so it portals outside the container. */
/**
 * Whether the destination sheet is on screen — which it now never is.
 *
 * Kept as an assertion rather than deleted with the component: "the key asks
 * before it records" was a property of this product for a long time and its
 * reversal is the kind of thing that should read as a decision in the suite
 * rather than as a test that quietly disappeared.
 */
export function sheetUp(): boolean {
  return document.body.querySelector('[data-testid="meeting-destination-sheet"]') !== null;
}
