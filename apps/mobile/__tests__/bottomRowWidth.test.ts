/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

/**
 * **The bottom row, solved at every width a phone actually has.**
 *
 * This file exists because the suite could not see the bug it is named after.
 * A seventh key was added to the compact toolbar and `bottomBarInset` was taken
 * from 52 to 24 to pay for it, and the arithmetic behind that was done at one
 * width — 390 — and nowhere else. At 375 (iPhone SE 2/3, 12/13 mini, 8/7/6s)
 * the seven targets wanted 43.14pt each against a 44pt floor; at 360 (most
 * Android) 41.00; at 320, 35.29. `minWidth: 44` held them at the floor, so
 * instead of shrinking they **spilled past the pill's rounded edge** — `bar`
 * sets no `overflow` and React Native's default is `visible`.
 *
 * Two tests were supposed to be the guard and neither could see any of it:
 *
 *  - one asserted `318 / 7` against `toBeCloseTo(45.43, 2)` — a comment
 *    reproduced as an expectation, at one width, with the separator's own point
 *    left out of the divisor;
 *  - the other read `min-width` and `min-height` off computed style, which are
 *    the literal constants `BottomBar` types into its stylesheet. They read 44
 *    at any viewport, with any number of actions, in any amount of overflow.
 *
 * So the guard here is a **layout solve**, not a lookup. It reads the flex
 * declarations react-native-web actually resolved onto the pill and its
 * children — basis, grow, shrink, floor, and the separator's unshrinkable point
 * — runs the CSS flexible-lengths algorithm over them at each width, and
 * asserts two things that a number typed into a stylesheet cannot satisfy on
 * its own: **every target lands on or above the touch floor**, and **the row
 * fits inside the pill**. Overflow is the failure the old tests were blind to,
 * so overflow is what is measured.
 *
 * ## What this can and cannot claim
 *
 * jsdom lays nothing out, so the solve is ours rather than the browser's. That
 * is the point: what the browser would do with these declarations is
 * computable, and computing it is the only thing standing between this row and
 * a phone. What it cannot tell you is whether the pill *looks* right at 320 —
 * that is a screenshot, and nobody has taken one at that width.
 */

/* -------------------------------------------------------------------------- */
/* The widths.                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Real devices, and the two edges of the range.
 *
 * Every one of these is `compact` — the frame's breakpoint is 880 — so every
 * one of them draws this row. The list is deliberately not "390 and the
 * reference": the bug was that 390 and 440 were the only two widths anybody
 * had done the arithmetic at, and both of them fit.
 */
const DEVICES: ReadonlyArray<{ width: number; what: string }> = [
  { width: 440, what: "iPhone 16 Pro Max — the reference the pill was measured off" },
  { width: 414, what: "iPhone 11 / XR / 8 Plus" },
  { width: 393, what: "iPhone 15 / 14 Pro, Pixel 7" },
  { width: 390, what: "iPhone 12–14 — the one width the arithmetic was done at" },
  { width: 381, what: "the break-even width at the resting geometry" },
  { width: 375, what: "iPhone SE 2/3, 12/13 mini, 8/7/6s — overflowed by 6pt" },
  { width: 360, what: "most Android — overflowed by 21pt" },
  { width: 320, what: "iPhone SE 1st gen, and any browser window this narrow" },
];

/** The worst case the console can build: six note verbs and one destination. */
const KEYS = 7;
/** One rule, before the seventh key. */
const RULES = 1;

/* -------------------------------------------------------------------------- */

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

jest.mock("expo-router", () => ({
  Slot: () => null,
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  usePathname: () => "/console/@seyi",
}));

jest.mock("@convex-dev/auth/react", () => ({
  useAuthActions: () => ({ signOut: async () => {} }),
}));

jest.mock("../features/console/useLiveConsoleData", () => ({
  useLiveConsoleData: () => mockConsoleData(),
}));

const { BottomBar, MIN_TOUCH_TARGET } =
  require("../features/console/BottomBar") as typeof import("../features/console/BottomBar");
const { layout, bottomBarGeometry } =
  require("../features/design/tokens") as typeof import("../features/design/tokens");
const { emptyEditor } =
  require("../features/console/files/editor") as typeof import("../features/console/files/editor");
import type { BottomBarAction } from "../features/console/BottomBar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* -------------------------------------------------------------------------- */
/* A flexbox solver, over declarations the render actually produced.            */
/* -------------------------------------------------------------------------- */

interface FlexItem {
  id: string;
  basis: number;
  grow: number;
  shrink: number;
  /** The floor below which this item stops shrinking. */
  min: number;
}

function styleOf(node: HTMLElement, property: string): number {
  return Number.parseFloat(window.getComputedStyle(node).getPropertyValue(property));
}

/** The first of these that resolved to a number. */
function firstNumber(...values: number[]): number {
  for (const value of values) if (Number.isFinite(value)) return value;
  return 0;
}

/**
 * The row's children, as the flex algorithm sees them.
 *
 * `flex-basis` is `auto` on the separator — it has a `width` and no basis — so
 * its own width stands in, which is what `auto` resolves to for an item with a
 * definite width. Nothing here is a constant from the source: every term is
 * read back off the node react-native-web rendered.
 */
function rowItems(bar: HTMLElement): FlexItem[] {
  return [...bar.children].map((child) => {
    const node = child as HTMLElement;
    const width = styleOf(node, "width");
    return {
      id: node.dataset.testid ?? "",
      basis: firstNumber(styleOf(node, "flex-basis"), width),
      grow: firstNumber(styleOf(node, "flex-grow")),
      shrink: firstNumber(styleOf(node, "flex-shrink")),
      min: firstNumber(styleOf(node, "min-width"), width),
    };
  });
}

/**
 * CSS "resolve the flexible lengths", enough of it for one row.
 *
 * Shrink is proportional to `shrink × basis`; an item that would go under its
 * floor is frozen there and the remaining deficit is redistributed among the
 * rest — which is exactly what makes this row overflow rather than shrink once
 * every target has hit 44.
 */
function solveRow(items: FlexItem[], content: number): number[] {
  const frozen = items.map(() => false);
  const sizes = items.map((item) => item.basis);

  for (let pass = 0; pass <= items.length; pass += 1) {
    for (let i = 0; i < items.length; i += 1) if (!frozen[i]) sizes[i] = items[i].basis;

    const free = content - sizes.reduce((total, size) => total + size, 0);
    const movable = items.map(
      (item, i) => !frozen[i] && (free < 0 ? item.shrink > 0 : item.grow > 0),
    );
    if (Math.abs(free) < 1e-9 || !movable.some(Boolean)) return sizes;

    if (free > 0) {
      const denominator = items.reduce((total, item, i) => total + (movable[i] ? item.grow : 0), 0);
      for (let i = 0; i < items.length; i += 1) {
        if (movable[i]) sizes[i] += (free * items[i].grow) / denominator;
      }
      return sizes;
    }

    const denominator = items.reduce(
      (total, item, i) => total + (movable[i] ? item.shrink * item.basis : 0),
      0,
    );
    if (denominator === 0) return sizes;

    let clamped = false;
    for (let i = 0; i < items.length; i += 1) {
      if (!movable[i]) continue;
      const next = items[i].basis + (free * (items[i].shrink * items[i].basis)) / denominator;
      if (next < items[i].min) {
        sizes[i] = items[i].min;
        frozen[i] = true;
        clamped = true;
      } else {
        sizes[i] = next;
      }
    }
    if (!clamped) return sizes;
  }

  return sizes;
}

interface Solved {
  /** Every target's resolved width, the separator excluded. */
  targets: number[];
  /** What the row came to, the separator included. */
  content: number;
  /** What the pill has room for inside its own padding. */
  room: number;
}

/**
 * Solve the rendered row at a known window width.
 *
 * The pill's available width is the window less the band `AppFrame` insets for
 * it (`layout.bottomBarInset` either side) and less whatever the bar's own
 * margins are — negative margins widen it — and then less its own padding.
 * Read, not assumed: a bar that reached outside its band, or padded itself into
 * an overflow, shows up here as a `room` too small for its `content`.
 */
function solveBar(bar: HTMLElement, width: number): Solved {
  const band = width - layout.bottomBarInset * 2;
  const outer = band - styleOf(bar, "margin-left") - styleOf(bar, "margin-right");
  const room = outer - styleOf(bar, "padding-left") - styleOf(bar, "padding-right");

  const items = rowItems(bar);
  const sizes = solveRow(items, room);

  return {
    targets: sizes.filter((_, i) => items[i].id !== "bottom-bar-separator"),
    content: sizes.reduce((total, size) => total + size, 0),
    room,
  };
}

/* -------------------------------------------------------------------------- */
/* Mounting.                                                                   */
/* -------------------------------------------------------------------------- */

const live: Array<() => void> = [];

/**
 * Tear every root down.
 *
 * Called at the end of each test that mounts the whole console rather than only
 * from `afterEach`, because `useMeetingFlow` recalls its remembered destination
 * asynchronously: a root still mounted when the test body returns sets state
 * outside `act` and fills the run with React's warning about it. Unmounting
 * inside the body is what makes that effect's own `live = false` win the race.
 */
function drop(): void {
  while (live.length > 0) live.pop()?.();
}

afterEach(() => {
  drop();
  document.body.innerHTML = "";
});

function atWidth(width: number): void {
  // react-native-web measures `document.documentElement.clientWidth`, which
  // jsdom reports as 0, and caches it until a `resize` invalidates it.
  Object.defineProperty(document.documentElement, "clientWidth", {
    value: width,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, "clientHeight", {
    value: 844,
    configurable: true,
  });
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 844, configurable: true });
  window.dispatchEvent(new Event("resize"));
}

function mount(element: ReturnType<typeof createElement>, width: number): HTMLElement {
  atWidth(width);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  act(() => {
    root.render(element);
  });
  live.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
}

function need(container: HTMLElement, testID: string): HTMLElement {
  const node = container.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
  if (node === null) throw new Error(`no element with testID ${testID}`);
  return node;
}

/** The seven-key row, as a fixture: six verbs and one separated destination. */
function sevenKeys(): BottomBarAction[] {
  const key = (id: string): BottomBarAction => ({
    id,
    label: `Do ${id}`,
    icon: "more",
    onPress: () => {},
  });
  return [
    key("back"),
    key("forward"),
    key("search"),
    key("new"),
    key("tabs"),
    key("save"),
    { ...key("elsewhere"), separated: true },
  ];
}

/* -------------------------------------------------------------------------- */
/* The console's own row, with a note open so the tab key is on it.             */
/* -------------------------------------------------------------------------- */

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
        entries: [],
      },
    },
    expanded: new Set<string>(),
    toggleFolder: () => {},
    // Deliberately `null` while the editor holds a path: `useTabs` opens its
    // strip off `editor.path`, so this is the seven-key row — back, forward,
    // search, new, tabs, save, meeting — without mounting CodeMirror into
    // jsdom, which is a different test's business entirely.
    selectedPath: null,
    select: () => {},
    editor: { ...emptyEditor, path: "1-projects/plan.md", status: "clean" as const },
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
    fastSearch: { status: null, loading: false },
    members: { members: [], loading: false },
    loading: false,
    failure: null,
  } as never;
}

const ConsoleLayout = (require("../app/(app)/console/_layout") as { default: () => unknown })
  .default;

function mountConsole(width: number): HTMLElement {
  return mount(createElement(ConsoleLayout as never), width);
}

/* -------------------------------------------------------------------------- */

describe("the geometry, before anything is rendered", () => {
  /**
   * The table, from the tokens rather than from the comment beside them.
   *
   * SABOTAGE: `bottomBarGeometry` returning the resting inset and pad at every
   * width — which is what it did before this branch, spelled as two constants.
   * Fails at 375, 360 and 320, and only there.
   */
  test.each(DEVICES)("$width fits seven keys — $what", ({ width }) => {
    const solved = bottomBarGeometry(width, KEYS, RULES);

    expect(solved.fits).toBe(true);
    expect(solved.target).not.toBeNull();
    expect(solved.target as number).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);

    // Never negative, and never more than the resting geometry asks for: this
    // spends room, it does not invent it.
    expect(solved.inset).toBeGreaterThanOrEqual(0);
    expect(solved.pad).toBeGreaterThanOrEqual(0);
    expect(solved.inset).toBeLessThanOrEqual(layout.bottomBarInset);
    expect(solved.pad).toBeLessThanOrEqual(layout.bottomBarPad);

    // And the row is inside the pill, which is inside the screen. Stated as the
    // identity it is: everything the width is spent on, added up, is the width.
    // `inner` is what the *targets* divide — the rule's point is already out of
    // it, which is the term the arithmetic this replaces kept forgetting.
    expect((solved.target as number) * KEYS).toBeCloseTo(solved.inner as number, 9);
    const spent =
      (solved.inner as number) +
      RULES * layout.bottomBarRule +
      solved.pad * 2 +
      solved.inset * 2;
    expect(spent).toBeCloseTo(width, 9);
  });

  /**
   * The control, and the reason this file exists.
   *
   * At the geometry this replaced — the inset and the pad held at their resting
   * values whatever the width — three of the eight devices put the targets
   * under the floor, and `minWidth` then made that an overflow rather than a
   * squeeze.
   */
  test("held at the resting inset and pad, three of these devices overflow", () => {
    const resting = (width: number) =>
      (width - layout.bottomBarInset * 2 - layout.bottomBarPad * 2 - layout.bottomBarRule) / KEYS;

    const under = DEVICES.filter(({ width }) => resting(width) < MIN_TOUCH_TARGET).map(
      ({ width }) => width,
    );
    expect(under).toEqual([375, 360, 320]);

    // The sizes the bug actually produced, to the point.
    expect(resting(375)).toBeCloseTo(43.14, 2);
    expect(resting(360)).toBeCloseTo(41.0, 2);
    expect(resting(320)).toBeCloseTo(35.29, 2);
    // And the width it was signed off at, which is the whole story: it fits.
    expect(resting(390)).toBeCloseTo(45.29, 2);
  });

  test("the widths that already fitted are not moved", () => {
    // The pill is a measurement (`layout.bottomBarInset`), so nothing above the
    // break-even width may lose a point of it. Only the phones that were
    // broken change.
    for (const width of [440, 414, 393, 390, 381]) {
      const solved = bottomBarGeometry(width, KEYS, RULES);
      expect(solved.inset).toBe(layout.bottomBarInset);
      expect(solved.pad).toBe(layout.bottomBarPad);
    }
  });

  /**
   * **What happens at 320, stated rather than implied.**
   *
   * Seven targets on the floor plus the rule need 309pt, and a 320pt screen has
   * 320. It fits, and what pays for it is the pill's own padding first and then
   * the sliver of note either side — at that width the sliver is 5pt rather
   * than 24, and the row is what the screen is for.
   *
   * The claim that seven keys "cannot fit at 320 by any choice of inset" holds
   * only while `bottomBarPad` is treated as fixed. It is not: it is the first
   * thing spent, and it is worth the least, because a 44pt target around a 22pt
   * icon already carries 11pt of air at each end of the row.
   */
  test("320 spends the padding first and the sliver second, and still fits", () => {
    const solved = bottomBarGeometry(320, KEYS, RULES);
    expect(solved.pad).toBe(0);
    expect(solved.inset).toBeGreaterThan(0);
    expect(solved.inset).toBeLessThan(layout.bottomBarInset);
    expect(solved.target as number).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
  });

  /**
   * And below that it genuinely cannot, so it says so instead of pretending.
   *
   * 309pt is the floor for this row: seven targets at 44 and one unshrinkable
   * rule. A window narrower than that has no arrangement — the alternatives are
   * a target under the floor or a key off the edge, and `fits: false` is the
   * one honest thing left to return.
   */
  test("under the width seven keys need, it reports that rather than faking it", () => {
    expect(bottomBarGeometry(309, KEYS, RULES).fits).toBe(true);
    expect(bottomBarGeometry(308, KEYS, RULES).fits).toBe(false);
    // And nothing is quietly squeezed on the way: the pill has spent
    // everything it has by then.
    const solved = bottomBarGeometry(280, KEYS, RULES);
    expect(solved.inset).toBe(0);
    expect(solved.pad).toBe(0);
    expect(solved.fits).toBe(false);
  });

  /**
   * A width of 0 is react-native-web before it has measured anything.
   *
   * "Absent is not zero" is the rule this console applies to every other
   * unanswered measurement, and a first paint that read a missing width as a
   * 0pt screen would collapse the pill onto the note and then expand it — a
   * flicker on every launch, in the name of a screen nobody has.
   */
  test("an unmeasured width gets the resting geometry, not the narrowest one", () => {
    for (const width of [0, Number.NaN, -1]) {
      const solved = bottomBarGeometry(width, KEYS, RULES);
      expect(solved.inset).toBe(layout.bottomBarInset);
      expect(solved.pad).toBe(layout.bottomBarPad);
      expect(solved.target).toBeNull();
      expect(solved.fits).toBe(true);
    }
  });

  test("a shorter row keeps more of the pill, because it needs less of it", () => {
    // Five keys and no rule is the row on a context somebody was invited into,
    // with nothing open: it never comes near the floor, so it never spends the
    // sliver.
    const five = bottomBarGeometry(320, 5, 0);
    expect(five.inset).toBe(layout.bottomBarInset);
    expect(five.pad).toBe(layout.bottomBarPad);
  });
});

/* -------------------------------------------------------------------------- */

describe("the rendered row, solved", () => {
  /**
   * The test the old pair could not be.
   *
   * SABOTAGE: `paddingHorizontal` and `marginHorizontal` back to the constants
   * — that is, the bar ignoring the geometry it is handed. Fails at 375, 360
   * and 320 on the overflow assertion, which is the assertion `min-width` could
   * never make.
   */
  test.each(DEVICES)("seven keys fit inside the pill at $width", ({ width }) => {
    const container = mount(createElement(BottomBar, { actions: sevenKeys() }), width);
    const solved = solveBar(need(container, "bottom-bar"), width);

    expect(solved.targets).toHaveLength(KEYS);
    for (const size of solved.targets) {
      expect(size).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET - 1e-9);
    }
    // The half the old tests were blind to: what was laid out is not wider
    // than what it was laid out in.
    expect(solved.content).toBeLessThanOrEqual(solved.room + 1e-9);
  });

  test("and the pill never reaches outside the band the frame gives it", () => {
    // The bar may spend the sliver; it may not spend the edge of the glass.
    for (const { width } of DEVICES) {
      const container = mount(createElement(BottomBar, { actions: sevenKeys() }), width);
      const bar = need(container, "bottom-bar");
      const reach = -Math.min(0, styleOf(bar, "margin-left"));
      expect(reach).toBeLessThanOrEqual(layout.bottomBarInset);
      expect(styleOf(bar, "margin-left")).toBe(styleOf(bar, "margin-right"));
    }
  });

  /**
   * **Below 309pt it fails loudly, which is the only honest thing left.**
   *
   * Seven targets on the floor and one unshrinkable rule need 309pt. Under
   * that there is no arrangement: the choices are a target a thumb cannot hit
   * or a key past the edge of the glass, and both are bugs. The person who can
   * fix either is a developer, so the row says so where a developer will hear
   * it rather than shipping one of them in silence — which is exactly what it
   * did at 375, 360 and 320 for the life of this branch.
   *
   * SABOTAGE: dropped the `reportUnfittable` call. Fails here and only here.
   */
  test("a width no arrangement fits complains, once, and not again", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      mount(createElement(BottomBar, { actions: sevenKeys() }), 288);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("288pt");

      // A re-render, or a second mount at the same width, is the same layout
      // and not new information: a row that cannot be drawn must not turn into
      // a console nobody reads.
      mount(createElement(BottomBar, { actions: sevenKeys() }), 288);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("and a width that fits says nothing at all", () => {
    // The other direction, so the complaint cannot be "warn on every phone".
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const { width } of DEVICES) {
        mount(createElement(BottomBar, { actions: sevenKeys() }), width);
      }
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("the reference width still draws the reference pill", () => {
    // Nothing about the wide case moves: 440 keeps its 52pt… 24pt sliver and
    // its 12pt of padding, which is what the measurement bought.
    const container = mount(createElement(BottomBar, { actions: sevenKeys() }), 440);
    const bar = need(container, "bottom-bar");
    expect(styleOf(bar, "padding-left")).toBe(layout.bottomBarPad);
    expect(styleOf(bar, "margin-left")).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */

describe("the console's own bottom row", () => {
  /**
   * **Seven keys, and the seventh is the meeting key.**
   *
   * `expect(toolbar()).toHaveLength(6)` was deleted with no replacement when
   * the row grew, so nothing asserted how many keys are on it or what the last
   * one is. The count is the whole of the width problem — six fit at 375 and
   * seven do not — and the position is the whole of the separator's argument:
   * six verbs that act on the note, then a rule, then one destination that
   * leaves it.
   *
   * Asserted against the real row rather than a fixture, because `BottomBar`
   * deliberately does not know what its last key opens; the layout does.
   */
  test("is seven keys, and the meeting key is the seventh", () => {
    const container = mountConsole(390);
    const row = [...need(container, "bottom-bar").children] as HTMLElement[];

    expect(row.map((node) => node.dataset.testid)).toEqual([
      "bottom-bar-back",
      "bottom-bar-forward",
      "bottom-bar-search",
      "bottom-bar-new",
      "bottom-bar-tabs",
      "bottom-bar-save",
      "bottom-bar-separator",
      "bottom-bar-meeting",
    ]);

    // Seven targets, not eight children: the rule is not a key.
    expect(row.filter((node) => node.dataset.testid !== "bottom-bar-separator")).toHaveLength(KEYS);
    expect(need(container, "bottom-bar-meeting").getAttribute("aria-label")).toBe(
      "Record a meeting",
    );

    drop();
  });

  /**
   * The same row, at every width, solved.
   *
   * The fixture above proves the mechanism; this proves it against the list the
   * console actually builds — the one that grew a seventh key and broke three
   * of these devices.
   */
  test.each(DEVICES)("clears the touch floor and stays in the pill at $width", ({ width }) => {
    const container = mountConsole(width);
    const solved = solveBar(need(container, "bottom-bar"), width);

    expect(solved.targets).toHaveLength(KEYS);
    for (const size of solved.targets) {
      expect(size).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET - 1e-9);
    }
    expect(solved.content).toBeLessThanOrEqual(solved.room + 1e-9);

    drop();
  });
});
