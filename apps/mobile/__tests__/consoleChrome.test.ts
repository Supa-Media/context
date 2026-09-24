/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { EditorRegion } from "../features/console/EditorRegion";
import { NavBandProvider } from "../features/console/NavBand";

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
/**
 * Whether this context has a model key, as `ConsoleData.modelConnected` says.
 *
 * Three values, and each is a state the console really has: `true` once the
 * subscription answers with a key, `false` once it answers with none, and
 * `undefined` for the moment before it answers at all.
 */
let mockModelConnected: boolean | undefined = true;
/** What the `+` sheet asked the browser to make, as `<kind>:<folder>`. */
const created: string[] = [];

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
      require("../features/console/NavBand") as typeof import("../features/console/NavBand");
    return h(NavBand);
  },
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  usePathname: () => mockPathname,
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
jest.mock("../features/agent/useConsoleGrant", () => ({
  useConsoleGrant: () => async () => { throw new Error("No fixture gateway session"); },
}));

jest.mock("convex/react", () => ({
  useAction: () => async () => {
    throw new Error("not used in this test");
  },
}));

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
    modelConnected: mockModelConnected,
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

const { layout } = require("../features/design/tokens") as typeof import("../features/design/tokens");

const ConsoleLayout = (
  require("../app/(app)/console/_layout") as { default: () => unknown }
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
    And the route, for the same reason: a test that sets `mockPathname` and
    then fails never reaches the line that sets it back, so the next test
    mounts a console on somebody else's route. Under a sabotage run that
    reported `bottom-bar-meeting` missing on a phone — a true statement about
    the Map route, and nothing to do with the defect being injected.
  */
  mockPathname = "/console/@seyi";
  mockModelConnected = true;
});

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
    // It existed only to hold a Sign out button, which is in the workspace
    // switcher on a pointer layout and the account mark on a phone.
    const app = mountConsole();
    expect(app.text()).not.toContain("Context.lc");
    app.unmount();
  });

  test("signing out is under the workspace's name, not floating above the product", () => {
    /*
      It was `rail-sign-out`, the power glyph at the foot of the rail's account
      block, and before that a button in a marketing header. The rail folded
      into `SwitcherMenu`, so it is a row in the menu under the name already in
      the title bar — which is where every application of this shape puts it,
      and still not above the product.
    */
    const app = mountConsole();
    expect(app.find("rail-sign-out")).toBeNull();

    app.press(app.find("frame-switcher"));
    expect(app.find("switcher-sign-out")).not.toBeNull();

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
  /**
   * **This used to be `the tree is a drawer, and the toolbar replaces the
   * status bar`**, and it asserted a `frame-drawer-toggle`. A phone has no left
   * panel at all now — no file-tree drawer, no rail sheet, no toggle for either
   * and no scrim from either (`features/app/frame.ts`) — so that assertion
   * describes a design that was removed and is replaced rather than deleted.
   *
   * It is replaced **positively**, which is the part that matters. "There is no
   * drawer toggle" is also what a phone renders when its whole top row has
   * failed to mount, so a rewrite that only checked the old things were absent
   * would pass on a broken screen. The two surfaces navigation actually moved
   * to are asserted present, and only then is the retired chrome asserted gone.
   */
  test("navigation is a strip along the top and a row along the bottom", () => {
    const app = mountConsole(390);

    // The two things that replaced the panels, and neither is behind a control.
    expect(app.find("context-strip")).not.toBeNull();
    expect(app.find("bottom-bar")).not.toBeNull();
    /*
      The `+`, which is the row's one way into making anything and — since the
      microphone key went — into recording a meeting too. It is unconditional,
      so this holds for a read-only context as well as this one.
    */
    expect(app.find("bottom-bar-new")).not.toBeNull();
    // And the key it replaced is gone, with the rule that separated it.
    expect(app.find("bottom-bar-meeting")).toBeNull();
    expect(app.find("bottom-bar-separator")).toBeNull();
    // And the account, pinned at the leading end of the top row.
    expect(app.find("account-menu")).not.toBeNull();

    // The bottom edge is one of the two, never both — `frame.ts`'s invariant.
    expect(app.find("console-status")).toBeNull();

    // Nothing of the left panel: not the tree, not a drawer, not a rail sheet,
    // not a scrim, and no toggle for any of them.
    for (const gone of [
      "explorer-tree",
      "frame-drawer",
      "frame-drawer-toggle",
      "frame-nav-sheet",
      "frame-nav-toggle",
      "frame-scrim",
    ]) {
      expect(app.find(gone)).toBeNull();
    }

    app.unmount();
  });

  test("the toolbar is the only route to the commands with no gesture", () => {
    // There is no keyboard here and no right-click. Creating and searching are
    // not things you do *to* an existing note, so the row's long-press menu
    // cannot reach them — this bar is it.
    const app = mountConsole(390);

    // Labels, not glyphs: the glyphs are aria-hidden, so what a screen reader
    // gets is the whole affordance.
    const labels = Array.from(app.container.querySelectorAll("[aria-label]")).map((node) =>
      node.getAttribute("aria-label"),
    );
    expect(labels).toContain("Search notes");
    /*
      "Create", not "New note" and not "New note or folder". A phone has no
      explorer, so this one key is the only way to start anything — a note, a
      drawing, a folder, and now a meeting, since the microphone beside it went.
      It raises the sheet; see `CreatePrompt`.
    */
    expect(labels).toContain("Create");
    // The bar is really on the screen, and not merely a set of labels somewhere
    // in the tree. It used to be enough to assert the console had rendered
    // *any* text — and then it was not, because the top bar became a toggle and
    // one group of icons with nothing in the middle. The middle has words again
    // (the context strip), so a text sweep would pass on a screen with no
    // toolbar at all; the testID is what makes this about the bar.
    expect(app.find("bottom-bar")).not.toBeNull();

    app.unmount();
  });

  /**
   * A phone can be navigated by landmark, and for a while it could not.
   *
   * `AppFrame` declares `role="navigation"` on exactly two things — the rail
   * column and the rail sheet — and **neither is rendered at compact**. When
   * the panels went, the assertion that a phone had a nav landmark went with
   * the sheet it was written about, and the two surfaces navigation actually
   * moved to declared nothing. A phone-width browser window therefore had zero
   * navigation landmarks: every pill and every key had a good `aria-label`, and
   * a screen-reader user rotoring by landmark, or anything jumping to `<nav>`,
   * could not find the navigation at all. Labelling each control is not the
   * same capability as being able to find the group of them.
   *
   * So this counts them at the console level rather than trusting a component:
   * exactly one, and it is the strip. The bottom row is deliberately **not** a
   * second one — six of its seven keys are verbs about the open note, and
   * calling a row of verbs "navigation" because one destination sits at the end
   * behind a separator makes the landmark mean less rather than more — so it is
   * asserted to still be the toolbar it says it is.
   *
   * SABOTAGE: dropped `role`/`aria-label` from `ContextStrip`'s root. Fails
   * here and in `contextStrip.test.ts`'s `it is a navigation landmark, and it
   * says which navigation`.
   */
  test("a phone has a navigation landmark, and it is not the toolbar", () => {
    const app = mountConsole(390);

    const landmarks = Array.from(app.container.querySelectorAll("nav"));
    expect(landmarks).toHaveLength(1);
    expect(landmarks[0]!.dataset.testid).toBe("context-strip");
    expect(landmarks[0]!.getAttribute("aria-label")).toBe("Contexts");

    // The bottom row stays a toolbar, named, and is not a second landmark.
    const bar = app.find("bottom-bar")!;
    expect(bar.getAttribute("role")).toBe("toolbar");
    expect(bar.getAttribute("aria-label")).toBe("Console actions");
    expect(bar.closest("nav")).toBeNull();

    app.unmount();
  });

  test("the top row is an account and a capsule, and the contexts are below it", () => {
    /*
      The two-rows-of-chrome complaint, at the console level.
      `appFrameRender.test.ts` pins the frame's own geometry; this pins what the
      console hands it.

      **This asserted three slots — an account, the contexts, a capsule — and
      the middle one has moved.** A floating top bar means the document runs
      behind whatever is in it, which the note's own verbs earn and navigation
      does not: a row of context pills lay across somebody's note at every
      scroll position, and named the context a second time one line above a
      breadcrumb that already did. The contexts are the first row of `NavBand`
      now, inside the scroller. One row of chrome is still one row; what is in
      it is smaller.
    */
    const app = mountConsole(390);

    // Leading: the account. Trailing: the capsule with the note's own actions,
    // which is `noteChrome.test.ts`'s.
    expect(app.find("account-menu")).not.toBeNull();

    // The contexts are on the screen, and not in the bar. `topBarCompact` is
    // the bar's own testID-free container, so the check is the band: the strip
    // is inside it, and the band is inside the pane.
    const strip = app.find("context-strip");
    expect(strip).not.toBeNull();
    expect(strip!.closest('[data-testid="nav-band"]')).not.toBeNull();
    expect(strip!.closest('[data-testid="app-frame"] > div')).not.toBe(
      app.find("account-menu")!.closest('[data-testid="app-frame"] > div'),
    );

    // The two controls that used to be here, and the chip that never was.
    expect(app.find("frame-drawer-toggle")).toBeNull();
    expect(app.find("frame-nav-toggle")).toBeNull();
    expect(app.find("storage-pill")).toBeNull();

    app.unmount();
  });
});

/**
 * THE SWITCHER EXISTS AT EVERY DENSITY, AND WHICH ONE IT IS CHANGES.
 *
 * "A session resolves to a *set* of accessible contexts — one connection
 * reaches every context its person is a live member of" is the product, not a
 * layout preference, so the surface that offers that set is not allowed to be a
 * phone feature. It was asserted at 390 alone: the file above counts the
 * strip's landmark and pins what the top row holds, all of it at compact,
 * because that is where the two-rows-of-chrome complaint came from.
 *
 * Nothing said the same thing about 1440, and the cost of that showed up in the
 * one console anybody can open in a browser: `/e2e-fixture` mounted the strip
 * and not the rail, so above 880pt it drew no way to another context at all,
 * and a green suite said nothing (`fixtureConsoleDensity.test.ts` is that hole,
 * closed). The product was right the whole time — which is exactly the claim
 * that was resting on nobody having checked.
 *
 * So this asks one question at both densities and does not care which component
 * answers it: is every context this account can reach on the screen, named, and
 * pressable? At compact that is `ContextStrip`; at wide it is `ConsoleRail`.
 * `frame.ts` is explicit that it is never both at once, so that is asserted
 * here too — the strip's dot means *kind* and the rail's means *storage
 * status*, and one glyph with two meanings on one screen is worse than either.
 *
 * SABOTAGE: return `rail: "hidden"` from `regionsFor`'s wide arm and "a pointer
 * layout offers them too" fails; gate `_layout`'s `contexts` node on something
 * other than `phone` and "a phone offers every context" fails.
 */
describe("every context this account can reach is on the screen", () => {
  /*
    Controls naming the one context this account is *not* in. Matched with its
    `@`, which `atName` puts on every label either surface draws: a bare slug is
    a substring of ordinary prose, and a note titled after the workspace would
    make this pass with no switcher on the screen at all.
  */
  const reachable = (app: ReturnType<typeof mountConsole>) =>
    Array.from(app.container.querySelectorAll('[role="button"]'))
      .map((node) => `${node.getAttribute("aria-label") ?? ""} ${node.textContent ?? ""}`)
      .filter((label) => label.includes("@public-worship")).length;

  test("a phone offers every context, on the strip", () => {
    const app = mountConsole(390);

    expect(app.find("context-strip")).not.toBeNull();
    expect(app.find("console-rail")).toBeNull();
    expect(reachable(app)).toBeGreaterThan(0);

    app.unmount();
  });

  test("a pointer layout offers them too, in the switcher", () => {
    /*
      It used to assert `console-rail` and read the rows off the container.
      The rail folded into the menu under the workspace's name, so the list is
      behind one press — and a press is what a person makes to reach it, which
      is the thing this file exists to prove is possible.
    */
    const app = mountConsole(1440);

    expect(app.find("console-rail")).toBeNull();
    expect(app.find("context-strip")).toBeNull();
    expect(app.find("frame-switcher")).not.toBeNull();

    app.press(app.find("frame-switcher"));
    expect(app.find("switcher-context-public-worship")).not.toBeNull();

    app.unmount();
  });
});

describe("the panes that are not Browse carry the navigation too", () => {
  /*
    THE FIXTURE ABOVE DRAWS `NavBand` ITSELF, AND THAT IS THE RIGHT CALL — a
    `Slot` rendering `null` would be a layout with the navigation missing, so
    every assertion about the strip would be testing the absence. But it means
    those assertions cannot say anything about the pane that draws the band on
    Map, Connections and Settings, because the fixture stands in for it.

    MEASURED, on `main`: deleting `EditorRegion`'s `<NavBand />` — the only one
    for every non-Browse pane — left the whole mobile suite green at 3,516. A
    phone on Settings would have had no rail (hidden at compact) and no strip,
    which is no navigation at all, and nothing would have said so.

    So this mounts the real `EditorRegion`. `BrowsePane` is already covered the
    same way in `noteChrome.test.ts`; between them both halves of "the console
    always has a way out" rest on a real component rather than on a mock.
  */
  const mountEditorRegion = (phone: boolean) => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
    act(() => {
      root.render(
        createElement(
          NavBandProvider as never,
          /*
            Plain nodes: `NavBand` draws the band when the provider holds any,
            and what the contexts row CONTAINS is `ContextStrip`'s own question,
            asked in `contextStrip.test.ts`. Coupling this to that component's
            props would buy nothing and break on a rename.

            The shape here is `nodes: { contexts, current }`. It was `node` when
            this was written, and #255 changed it — which these two checks
            caught by failing, which is the whole point of mounting the real
            component rather than a fixture that supplies it.
          */
          {
            nodes: {
              contexts: createElement("div", null, "contexts"),
              current: createElement("div", null, "here"),
            },
          },
          createElement(
            EditorRegion as never,
            { browse: false, failure: null, tabs: null, onCloseTab: () => {}, phone },
            createElement("div", null, "a pane"),
          ),
        ),
      );
    });
    return {
      band: () => container.querySelector('[data-testid="nav-band"]'),
      unmount: () => {
        act(() => root.unmount());
        container.remove();
      },
    };
  };

  test("a non-Browse pane draws the navigation band on a phone", () => {
    const view = mountEditorRegion(true);
    expect(view.band()).not.toBeNull();
    view.unmount();
  });

  test("...and on a pointer, where the rail is present too", () => {
    /*
      The positive twin for the phone case above. If this drew nothing on a
      pointer the first assertion would still pass while the component was
      broken for everybody — and asserting only the phone would leave the
      band's presence resting on one density.
    */
    const view = mountEditorRegion(false);
    expect(view.band()).not.toBeNull();
    view.unmount();
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
 * Navigation on a phone, end to end — and it is not a way *off* a panel any
 * more, because there is no panel.
 *
 * **This block used to be `the phone's way off a pane`**, and its premise was
 * stated in its own header: "`appFrameRender.test.ts` proves the frame *can*
 * raise and dismiss the sheet; this proves the console actually wires it up.
 * That gap was real and total: deleting `frame.closeNav()` from the rail's
 * `onNavigate` left all 1113 tests in this suite green, and it is the single
 * line that makes the fix a way out rather than a panel you have to dismiss by
 * hand after every choice." Every word of that was true and none of it survives
 * the panels: there is no rail sheet, no drawer, no scrim and no toggle at any
 * density (`features/app/frame.ts`).
 *
 * What survives is the *requirement* underneath it, in two halves, and both are
 * asserted below rather than assumed:
 *
 *  - **A destination is reachable without opening anything.** That is now
 *    stronger than "you can get out of the panel": there is nothing to get out
 *    of, so the test presses a destination on a console nobody has touched.
 *  - **Choosing a destination dismisses whatever it was chosen from.** The
 *    strip is not a panel, so choosing from it raises and leaves nothing — the
 *    assertion is that the screen is unchanged furniture rather than a sheet
 *    that has to be dismissed. The one thing a phone still raises over the note
 *    is the meeting sheet, and it puts itself away: `contextStrip.test.ts`
 *    holds the strip menu's half by name (`choosing a destination closes the
 *    menu and reports it once`) and `meetingsFlow.test.ts` holds the sheet's
 *    (`the meeting that results is the one the sheet described`, which asserts
 *    the sheet is gone). What is left here is the wiring between them and this
 *    console, which is exactly what the deleted `closeNav()` mutant proved a
 *    unit test cannot see.
 *
 * Mounted at a phone width against the real layout, the real `ContextStrip`,
 * the real `BottomBar` and the real `AppFrame` — only the data and the router
 * are stubs.
 *
 * ## Sabotage record
 *
 * Against a green baseline of **172 suites / 3,285 tests**
 * (`npx jest --watchman=false`): returning the pinned account's pressable to
 * `padding: 4` — a 34pt target around a 34pt mark, which is what it shipped as
 * — fails **1 test**, `sign-out is reachable through the account menu, and the
 * trigger is a target a thumb can hit`, and nothing else. That is the whole of
 * the coverage on the only sign-out control this product has on a phone,
 * which is why it is asserted from `layout.minTouchTarget` rather than from a
 * literal.
 */
describe("the phone reaches a destination with nothing opened first", () => {
  test("a context is one press in the band, and the press raises no panel", () => {
    const app = mountConsole(390);

    // Nothing is up before, which is the whole point: this is the resting
    // state of the screen rather than something a previous press produced.
    expect(app.find("frame-nav-sheet")).toBeNull();
    expect(app.find("frame-scrim")).toBeNull();

    /*
      The button for the context you are IN, at the head of the breadcrumb —
      this fixture has exactly one context, so there is no pill for it on the
      strip and this is the whole of the navigation to a context on this screen.
      It is also the way to that context's root, which is the press that was
      missing when the segment was deleted instead of moved.
    */
    const pill = app.find("nav-context-seyi");
    expect(pill).not.toBeNull();
    app.press(pill);

    // Still nothing. The band is furniture; there is no dismissal to wire up
    // and therefore none to forget.
    expect(app.find("frame-nav-sheet")).toBeNull();
    expect(app.find("frame-scrim")).toBeNull();
    expect(app.find("nav-band")).not.toBeNull();

    app.unmount();
  });

  test("the + is in the corner of a pointer console, on every route it has", () => {
    /*
      THE MOUNT, WHICH IS THE HALF NO UNIT TEST OF THE BUTTON CAN SEE.

      `CreateButton` has its own tests for what it draws and what its menu
      offers. Those pass just as happily if nothing in the product ever renders
      it — which is exactly the defect being guarded here, and the one the
      microphone it replaced actually shipped: the corner was drawn by
      `NoteEditor`, so it existed on a note and nowhere else. The owner's words
      are the requirement: *"it should show up all the time, even when on a
      folder page, and not just show up when on a note."*

      So this asserts the *layout* draws it, at a context route with no note
      selected — which is a folder page, and the state a console arrives in.
    */
    mockPathname = "/console/@seyi";
    const app = mountConsole(1280);
    expect(app.find("console-create")).not.toBeNull();
    app.unmount();
  });

  test("...and on Map, which has no file tree and no note at all", () => {
    // Restored by `afterEach`, not here: see the note there.
    mockPathname = "/console/map";
    const app = mountConsole(1280);
    expect(app.find("console-create")).not.toBeNull();
    app.unmount();
  });

  test("pressing it offers everything a console starts", () => {
    const app = mountConsole(1280);
    app.press(app.find("console-create"));

    // The menu is a `Menu`, which react-native-web portals out of the tree.
    for (const label of ["New meeting", "New note", "New drawing", "New folder", "New chat"]) {
      expect([label, document.body.textContent?.includes(label)]).toEqual([label, true]);
    }
    app.unmount();
  });

  test("a context with no model key is not offered a conversation", () => {
    /*
      A key is what lets the agent answer at all, so the row without one opens
      a composer whose first send errors — the control that appears to work and
      does nothing. Everything else in the menu still makes a file, so the menu
      is shorter rather than absent.
    */
    mockModelConnected = false;
    const app = mountConsole(1280);
    app.press(app.find("console-create"));

    expect(document.body.textContent).not.toContain("New chat");
    expect(document.body.textContent).toContain("New note");
    expect(document.body.textContent).toContain("New meeting");
    app.unmount();
  });

  test("...and neither is one whose answer has not landed yet", () => {
    /*
      `undefined` is "ask again in a moment", which is not "there is no key".
      Absent then present is the honest direction: offered then withdrawn is an
      offer somebody may already have pressed.
    */
    mockModelConnected = undefined;
    const app = mountConsole(1280);
    app.press(app.find("console-create"));
    expect(document.body.textContent).not.toContain("New chat");
    app.unmount();
  });

  test("and the corner holds no second control: the microphone is not drawn beside it", () => {
    /*
      One corner, one control. `oneMicrophone.test.ts` holds the editor's half
      through the real editor; this is the one that can see both at once,
      because it mounts the console that supplies the `+` and the note that
      used to supply the microphone.
    */
    const app = mountConsole(1280);
    expect(app.find("console-create")).not.toBeNull();
    expect(app.find("voice-button")).toBeNull();
    app.unmount();
  });

  test("a phone draws no floating + at all, because its bottom row carries one", () => {
    /*
      The row's own `+` is the phone's create surface — and since the microphone
      key went, its meeting route too. A second floating control 24pt above that
      row is the defect `oneMicrophone.test.ts` exists for, arriving again with a
      different glyph on it.
    */
    const app = mountConsole(390);
    expect(app.find("console-create")).toBeNull();
    expect(app.find("bottom-bar-new")).not.toBeNull();
    expect(app.find("bottom-bar-meeting")).toBeNull();
    app.unmount();
  });

  test("the app's other place is a row in the + sheet, and choosing it records", () => {
    /*
      THE SEVENTH KEY, AFTER THE SHEET WENT — AND AFTER THE KEY WENT.

      It used to be its own microphone at the end of the row, and before that it
      raised a destination sheet with two rows, an audience line and a Start.
      Both are gone, for the owner's reasons in order: *"no need to ask people it
      will just confuse them"*, and then *"we no longer need a dedicated mic
      button on the bottom row, just a plus button that opens different
      options"*.

      What `docs/decisions/meetings.md` actually protects survived both. It calls
      a control that silently starts recording "the same product with the
      indicator removed", and the indicator is where it went: the press records
      and lands on the meeting's own screen — a clock, a meter, a transport and
      the note it is becoming. What the phone must keep is a **route**, and this
      is the route: one press for the `+`, one for Meeting.

      So what is asserted is that the two presses reach a recording, and that
      neither raises the retired destination sheet. This fixture's console has no
      meetings controller configured, so the attempt cannot reach a microphone;
      what it must do is say so rather than doing nothing at all, which is
      `meetingsFlow.test.ts`'s refusal arriving through the real row.
    */
    const app = mountConsole(390);
    expect(sheetUp()).toBe(false);

    app.press(app.find("bottom-bar-new"));
    const meeting = document.body.querySelector<HTMLElement>('[aria-label="New meeting"]');
    expect(meeting).not.toBeNull();
    app.press(meeting);

    expect(sheetUp()).toBe(false);
    expect(document.body.querySelector('[data-testid="meeting-refusal"]')).not.toBeNull();

    // And it is dismissible from inside itself, which is the property the rail
    // sheet's `closeNav()` used to carry for the panel it replaced.
    app.press(document.body.querySelector<HTMLElement>('[data-testid="meeting-refusal-close"]'));
    expect(document.body.querySelector('[data-testid="meeting-refusal"]')).toBeNull();

    app.unmount();
  });

  /**
   * AND THE FILES ARE IN THE SAME SHEET, WITH NOTHING ASKING FOR A NAME.
   *
   * The `+` is the only route to creating anything on a phone, so what it offers
   * is the whole of that capability — and the note is made on the press rather
   * than after a text field, which is what the owner asked for: *"for new note,
   * new drawing etc should not ask you to title it"*.
   */
  test("the + offers the three files, and Note writes one without asking", () => {
    const app = mountConsole(390);
    app.press(app.find("bottom-bar-new"));

    const labelled = (label: string) =>
      document.body.querySelector<HTMLElement>(`[aria-label="${label}"]`);
    for (const row of ["New note", "New drawing", "New folder"]) {
      expect(labelled(row)).not.toBeNull();
    }

    created.length = 0;
    app.press(labelled("New note"));
    // It reached the browser as an untitled note in the destination folder —
    // and no field and no sheet were in the way.
    expect(created).toEqual(["note:"]);
    expect(document.body.querySelector("input, textarea")).toBeNull();
    expect(labelled("New note")).toBeNull();

    app.unmount();
  });

  /**
   * A PHONE CAN ASK ITS CONTEXT A QUESTION.
   *
   * It could not, and the absence was never decided — it was a fact about the
   * code that nobody had written down. `CreateButton`'s `onNewChat` is `null`
   * "where there is no panel for a conversation to open in", and on a phone that
   * read as *no panel exists*, because the only thing that raised `AgentPanel`
   * was the floating microphone `NoteEditor` mounts. So the row was absent from
   * the phone's `+` while the desktop's menu offered it, and the way to the
   * agent on a phone was: open a note, put the keyboard up so the bottom row
   * hides, press the microphone that comes back, choose the agent row.
   *
   * `AgentPanel` is a `Modal` and says in its own header that it is one
   * precisely so it can "appear identically on a surface that has no console
   * around it at all". So the layout raises it, and the Chat row is a row on
   * both densities.
   *
   * ## What this asserts, and why each half is needed
   *
   * That the row is **there** and that pressing it **opens the panel**. A test
   * of only the first passes on a row wired to nothing, which is the shape of
   * the defect this closes; a test of only the second cannot tell a phone that
   * offers the row from one that never did.
   *
   * ## Sabotage record
   *
   * Applied as local edits to `_layout.tsx`, suite run, named tests observed
   * failing, reverted. Counts are failing tests in this file.
   *
   *   the phone's branch dropped, so it opens the aside it does not have    1
   *   `hasAside` back in the gate, so the row is absent on a phone          1
   *   the gate no longer reads `modelConnected`                             3
   *   the panel never mounted                                              1
   */
  test("the + offers a chat, and choosing it opens the panel", () => {
    const app = mountConsole(390);
    app.press(app.find("bottom-bar-new"));

    const chat = document.body.querySelector<HTMLElement>('[aria-label="New chat"]');
    expect(chat).not.toBeNull();
    app.press(chat);

    expect(app.find("agent-panel")).not.toBeNull();
    // And it names the model that will answer, which is `AgentPanel`'s own
    // disclosure rule rather than this test's: a conversation whose provider is
    // unstated is one somebody cannot cost.
    expect(app.find("agent-provider")).not.toBeNull();

    app.unmount();
  });

  /**
   * And the gate travels with the row, on both densities.
   *
   * The owner's line — *"new chat should be off btw if no LLM api key
   * configured"* — is `modelConnected`'s, and #733 argues why `undefined` is
   * absent rather than present. The phone's sheet asks the same question through
   * the same value, so a context with no key is not offered a conversation here
   * either.
   */
  test("and no chat row on a phone in a context with no model key", () => {
    mockModelConnected = false;
    const app = mountConsole(390);
    app.press(app.find("bottom-bar-new"));
    expect(document.body.querySelector('[aria-label="New chat"]')).toBeNull();
    // The rest of the sheet is untouched, so this cannot pass on a sheet that
    // failed to open at all.
    expect(document.body.querySelector('[aria-label="New note"]')).not.toBeNull();
    app.unmount();
  });

  test("sign-out is reachable through the account menu, and the trigger is a target a thumb can hit", () => {
    /*
      **It is the only sign-out control in the product**, and before the panels
      went it was at the foot of the rail — this test used to press
      `frame-nav-toggle` to reach it. There is no toggle and no rail on a phone;
      it lives behind the pinned account slot, in the corner of the glass that
      is always visible.

      **It used to be reached with no press at all** — `account-sign-out` was
      the avatar's own pressable, and pressing it signed out directly. That was
      the bug this test's sabotage record predates: on a clean queue,
      `useSignOutFlow` raises no confirmation, so the one thing reachable
      without a press was also the one thing nothing should do by accident.
      The avatar now opens a menu; this test presses through it rather than
      finding the row already on screen.

      The trigger is 44pt on both axes, from the token rather than from a
      literal — what a thumb hits is the pressable, and this is the one
      control here somebody reaches for deliberately and must not miss. The
      row inside the menu is a `Modal` portal (`react-native-web`), so it is
      searched for in `document.body` rather than through `app.find`, which is
      scoped to this test's own container.
    */
    mockPathname = "/console";
    const app = mountConsole(390);

    const trigger = app.find("account-menu");
    expect(trigger).not.toBeNull();
    // Named, not just present: an icon carries nothing to a screen reader and
    // there is no menu and no keymap here to reach it by instead.
    expect(trigger!.getAttribute("aria-label")).toBe("@seyi — account menu");

    const box = window.getComputedStyle(trigger!);
    expect(Number.parseFloat(box.width)).toBeGreaterThanOrEqual(layout.minTouchTarget);
    expect(Number.parseFloat(box.height)).toBeGreaterThanOrEqual(layout.minTouchTarget);

    app.press(trigger);
    const signOut = document.body.querySelector<HTMLElement>('[data-testid="account-sign-out"]');
    expect(signOut).not.toBeNull();
    expect(signOut!.textContent).toContain("Sign out");

    app.unmount();
    mockPathname = "/console/@seyi";
  });

  test("and a pointer layout reaches it in the switcher instead", () => {
    /*
      The positive control for the move: sign-out is not deleted, it is the
      other density's answer, and a rewrite that lost it would pass every
      assertion above.

      **It used to be `rail-sign-out`, at the foot of the rail's account
      block.** The rail folded into `SwitcherMenu`, so this density's route is
      the same shape the phone's already was — open the control under your own
      name, then choose — and `AccountBlock`'s `compact` menu stays the phone's
      alone.
    */
    const app = mountConsole(1440);
    expect(app.find("rail-sign-out")).toBeNull();
    expect(app.find("account-menu")).toBeNull();

    app.press(app.find("frame-switcher"));
    const signOut = app.find("switcher-sign-out");
    expect(signOut).not.toBeNull();
    expect(signOut!.textContent).toContain("Sign out");

    app.unmount();
  });
});

/** The meeting sheet is a `Modal`, so it portals outside the container. */
/**
 * Whether the destination sheet is on screen — which it now never is.
 *
 * Kept as an assertion rather than deleted with the component: "the key asks
 * before it records" was a property of this product for a long time and its
 * reversal is the kind of thing that should read as a decision in the suite
 * rather than as a test that quietly disappeared.
 */
function sheetUp(): boolean {
  return document.body.querySelector('[data-testid="meeting-destination-sheet"]') !== null;
}
