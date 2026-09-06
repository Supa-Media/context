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
    // The seventh key: the one destination on a row of note verbs.
    expect(app.find("bottom-bar-meeting")).not.toBeNull();
    expect(app.find("bottom-bar-separator")).not.toBeNull();
    // And the account, pinned at the leading end of the top row.
    expect(app.find("account-sign-out")).not.toBeNull();

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
    expect(labels).toContain("New note");
    // The bar is really on the screen, and not merely a set of labels somewhere
    // in the tree. It used to be enough to assert the console had rendered
    // *any* text — and then it was not, because the top bar became a toggle and
    // one group of icons with nothing in the middle. The middle has words again
    // (the context strip), so a text sweep would pass on a screen with no
    // toolbar at all; the testID is what makes this about the bar.
    expect(app.find("bottom-bar")).not.toBeNull();

    app.unmount();
  });

  test("the top row is three slots: an account, the contexts, a capsule", () => {
    /*
      The two-rows-of-chrome complaint, at the console level.
      `appFrameRender.test.ts` pins the frame's own geometry; this pins what the
      console hands it.

      **What this used to assert was `the top bar carries no words at all — a
      toggle, and nothing beside it`**, and its reason was that "the context
      chip that used to sit here is the vault switcher at the foot of the file
      tree". That footer is gone with the tree, so the chip did not go back to
      the middle of the bar — the contexts became a scrolling strip that *is*
      the middle, and the round toggle at the leading edge became the account.
      One row is still one row; what is in it changed.
    */
    const app = mountConsole(390);

    // Leading: the account. Middle: the contexts. The trailing capsule holds
    // the note's own actions and is `noteChrome.test.ts`'s.
    expect(app.find("account-sign-out")).not.toBeNull();
    expect(app.find("context-strip")).not.toBeNull();

    // The two controls that used to be here, and the chip that never was.
    expect(app.find("frame-drawer-toggle")).toBeNull();
    expect(app.find("frame-nav-toggle")).toBeNull();
    expect(app.find("storage-pill")).toBeNull();

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
 * — fails **1 test**, `sign-out is reachable, and is a target a thumb can hit`,
 * and nothing else. That is the whole of the coverage on the only sign-out
 * control this product has on a phone, which is why it is asserted from
 * `layout.minTouchTarget` rather than from a literal.
 */
describe("the phone reaches a destination with nothing opened first", () => {
  test("a context is one press on the strip, and the press raises no panel", () => {
    const app = mountConsole(390);

    // Nothing is up before, which is the whole point: this is the resting
    // state of the screen rather than something a previous press produced.
    expect(app.find("frame-nav-sheet")).toBeNull();
    expect(app.find("frame-scrim")).toBeNull();

    const pill = app.find("context-strip-seyi");
    expect(pill).not.toBeNull();
    app.press(pill);

    // Still nothing. A strip is furniture; there is no dismissal to wire up
    // and therefore none to forget.
    expect(app.find("frame-nav-sheet")).toBeNull();
    expect(app.find("frame-scrim")).toBeNull();
    expect(app.find("context-strip")).not.toBeNull();

    app.unmount();
  });

  test("the app's other place is the last key, and it raises the sheet that asks", () => {
    /*
      The seventh key. It opens a sheet and does **not** open the microphone —
      `docs/decisions/meetings.md` calls a control that silently started
      recording "the same product with the indicator removed" — and the sheet
      is a `Modal`, which react-native-web portals outside this container.
    */
    const app = mountConsole(390);
    expect(sheetUp()).toBe(false);

    app.press(app.find("bottom-bar-meeting"));
    expect(sheetUp()).toBe(true);

    // And it is dismissible from inside itself, which is the property the rail
    // sheet's `closeNav()` used to carry for the panel it replaced.
    app.press(document.body.querySelector<HTMLElement>('[data-testid="meeting-destination-cancel"]'));
    expect(sheetUp()).toBe(false);

    app.unmount();
  });

  test("sign-out is reachable, and is a target a thumb can hit", () => {
    /*
      **It is the only sign-out control in the product**, and before the panels
      went it was at the foot of the rail — this test used to press
      `frame-nav-toggle` to reach it. There is no toggle and no rail on a phone;
      it lives behind the pinned account slot, in the corner of the glass that
      is always visible, and is reached with no press at all.

      44pt on both axes, from the token rather than from a literal. The mark
      inside it is 34 (`layout.accountAvatar`) and that is legal — what a thumb
      hits is the pressable, and this is the one control here somebody reaches
      for deliberately and must not miss.
    */
    mockPathname = "/console";
    const app = mountConsole(390);

    const signOut = app.find("account-sign-out");
    expect(signOut).not.toBeNull();
    // Named, not just present: an icon carries nothing to a screen reader and
    // there is no menu and no keymap here to reach it by instead.
    expect(signOut!.getAttribute("aria-label")).toBe("@seyi — sign out");

    const box = window.getComputedStyle(signOut!);
    expect(Number.parseFloat(box.width)).toBeGreaterThanOrEqual(layout.minTouchTarget);
    expect(Number.parseFloat(box.height)).toBeGreaterThanOrEqual(layout.minTouchTarget);

    app.unmount();
    mockPathname = "/console/@seyi";
  });

  test("and a pointer layout still keeps it at the foot of the rail", () => {
    // The positive control for the move: `rail-sign-out` is not deleted, it is
    // the other density's answer. A rewrite that lost it would pass every
    // assertion above.
    const app = mountConsole(1440);
    expect(app.find("rail-sign-out")).not.toBeNull();
    expect(app.find("account-sign-out")).toBeNull();
    app.unmount();
  });
});

/** The meeting sheet is a `Modal`, so it portals outside the container. */
function sheetUp(): boolean {
  return document.body.querySelector('[data-testid="meeting-destination-sheet"]') !== null;
}
