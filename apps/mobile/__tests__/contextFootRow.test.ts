/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

/**
 * The workspaces along the foot of the file tree.
 *
 * The row exists because switching was invisible at rest: the only control was
 * the title bar's chip, so nothing on the screen said that a second workspace
 * existed at all. `foot.ts` holds the argument; this holds the guards.
 *
 * ## Two halves, two rooms — the shape `contextStrip.test.ts` established
 *
 * The **rules** are `footPlan`, a pure function of a width and a list, and they
 * are asserted directly. That is where this feature can go wrong quietly: the
 * arithmetic decides whether a name is drawn or clipped, and a clipped name is
 * a bug nobody sees until a workspace with a long name meets a narrow panel.
 *
 * The **drawing** is mounted for real, because what can be wrong about it is a
 * fact about the DOM react-native-web produces: whether a mark reaches a screen
 * reader as a name rather than as the letter `S`, and whether pressing one
 * actually asks to go anywhere.
 *
 * ## What this cannot assert
 *
 * jsdom performs no layout, so `onLayout` never fires and the mounted row
 * always plans at the resting column width. Every width other than that one is
 * tested through `footPlan` directly, which is the honest division: the
 * measurement is one line of arithmetic on a number the platform supplies, and
 * **the pixels are unverified** — there is no browser here and none of this has
 * been looked at.
 */

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const { ContextFootRow } =
  require("../features/console/ContextFootRow") as typeof import("../features/console/ContextFootRow");
const { footPlan, RECENT_SLOTS } =
  require("../features/console/foot") as typeof import("../features/console/foot");
const { layout } =
  require("../features/design/tokens") as typeof import("../features/design/tokens");
import type { ConsoleContext } from "../features/console/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* -------------------------------------------------------------------------- */

const live: Array<() => void> = [];
afterEach(() => {
  while (live.length > 0) live.pop()?.();
  document.body.innerHTML = "";
});

function context(over: Partial<ConsoleContext> & { slug: string }): ConsoleContext {
  return {
    id: `id-${over.slug}`,
    displayName: over.slug,
    role: "owner",
    kind: "shared",
    status: "ok",
    ...over,
  };
}

/** Four, which is the shape the row was drawn for: one of yours and three not. */
function four(): ConsoleContext[] {
  return [
    context({ slug: "seyi", kind: "personal" }),
    context({ slug: "supa", role: "editor" }),
    context({ slug: "public-worship", role: "member" }),
    context({ slug: "context-lc", role: "member", pinned: true }),
  ];
}

const visited = (...slugs: string[]) => slugs.map((slug) => ({ slug }));

interface Mounted {
  find: (testID: string) => HTMLElement | null;
  need: (testID: string) => HTMLElement;
  press: (testID: string) => void;
  text: () => string;
}

function mount(element: ReactElement): Mounted {
  Object.defineProperty(document.documentElement, "clientWidth", {
    value: 1440,
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
  act(() => root.render(element));
  live.push(() => {
    act(() => root.unmount());
    container.remove();
  });

  const find = (testID: string) =>
    container.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
  const need = (testID: string) => {
    const node = find(testID);
    if (node === null) throw new Error(`no element with testID ${testID}`);
    return node;
  };
  return {
    find,
    need,
    text: () => container.textContent ?? "",
    press: (testID) => {
      const node = need(testID);
      act(() => {
        node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    },
  };
}

/* -------------------------------------------------------------------------- */

describe("footPlan: what goes on the row", () => {
  test("no row where there is nowhere to go", () => {
    /*
      One workspace and no others. The name is already in the title bar, so a
      band offering a choice of one is chrome that does nothing — and the points
      it would take belong to the tree above it. `stripEntries` refuses to draw
      the phone's strip on exactly this reasoning.
    */
    expect(
      footPlan({
        width: 260,
        contexts: [context({ slug: "seyi", kind: "personal" })],
        currentSlug: "seyi",
        recent: [],
      }),
    ).toBeNull();

    expect(
      footPlan({ width: 260, contexts: [], currentSlug: null, recent: [] }),
    ).toBeNull();
  });

  test("the context you are in is not on it", () => {
    const plan = footPlan({
      width: 460,
      contexts: four(),
      currentSlug: "supa",
      recent: [],
    });
    expect(plan?.recent.map((c) => c.slug)).not.toContain("supa");
  });

  test("most recently visited first, and never alphabetical", () => {
    /*
      The order somebody is actually moving in. An alphabetical row is stable and
      useless: it puts a workspace nobody has opened in front of the two being
      alternated between all morning, forever.
    */
    const plan = footPlan({
      width: 460,
      contexts: four(),
      currentSlug: "seyi",
      recent: visited("public-worship", "supa"),
    });
    expect(plan?.recent.map((c) => c.slug)).toEqual([
      "public-worship",
      "supa",
      "context-lc",
    ]);
  });

  test("the pinned context is held last, however recently it was opened", () => {
    /*
      `@context-lc` is the read-only workspace every account reaches without
      being invited. It is not somebody's own work and it must not outrank a
      workspace that is — `stripOrder` owns that rule and this row inherits it
      rather than restating it.
    */
    const plan = footPlan({
      width: 460,
      contexts: four(),
      currentSlug: "seyi",
      recent: visited("context-lc", "supa", "public-worship"),
    });
    expect(plan?.recent.at(-1)?.slug).toBe("context-lc");
  });

  test("three at most, whatever the width", () => {
    const many = [
      context({ slug: "seyi", kind: "personal" }),
      ...Array.from({ length: 9 }, (_, i) => context({ slug: `w${i}` })),
    ];
    const plan = footPlan({
      width: layout.explorerMaxWidth,
      contexts: many,
      currentSlug: "seyi",
      recent: [],
    });
    /*
      Extra width buys names, not a fourth workspace. A row that grew toward a
      dozen marks is the rail coming back at the bottom of the panel, which is
      the decision this one is careful not to reverse.

      **Three written out, not `RECENT_SLOTS`.** Asserting the constant against
      itself is a test that agrees with whatever the constant is changed to,
      which is the shape of guard that passes while the thing it guards is gone.
      The second line is what ties the exported name to the number, so a change
      to either has to come here and say so.
    */
    expect(plan?.recent).toHaveLength(3);
    expect(RECENT_SLOTS).toBe(3);
  });
});

describe("footPlan: what the width buys", () => {
  test("two short workspaces are named at the resting width", () => {
    /*
      The owner's own case: "if someone only has two workspaces and they're able
      to comfortably fit on that bottom panel without it being too crowded, then
      why not?". They fit, so they are named.
    */
    const plan = footPlan({
      width: layout.explorerWidth,
      contexts: [context({ slug: "seyi", kind: "personal" }), context({ slug: "supa" })],
      currentSlug: "seyi",
      recent: [],
    });
    expect(plan?.named).toBe(true);
    expect(plan?.recent.map((c) => c.slug)).toEqual(["supa"]);
  });

  test("three long names do not fit the resting width, so the row draws marks", () => {
    const plan = footPlan({
      width: layout.explorerWidth,
      contexts: four(),
      currentSlug: "seyi",
      recent: visited("supa", "public-worship", "context-lc"),
    });
    expect(plan?.named).toBe(false);
    expect(plan?.recent).toHaveLength(3);
  });

  test("dragging the panel open buys the names", () => {
    const of = (width: number) =>
      footPlan({
        width,
        contexts: [
          context({ slug: "seyi", kind: "personal" }),
          context({ slug: "supa" }),
          context({ slug: "fount" }),
        ],
        currentSlug: "seyi",
        recent: visited("supa", "fount"),
      });
    /*
      The point of measuring at all: the same list, the same three workspaces,
      and the only thing that changed is how far the seam was dragged.
    */
    expect(of(layout.explorerMinWidth)?.named).toBe(false);
    expect(of(layout.explorerMaxWidth)?.named).toBe(true);
  });

  test("the floor still holds all three, however long the current name", () => {
    /*
      The product claim about the narrow end: dragging the panel to its floor
      costs you the names, never the destinations. `@public-worship` is the
      longest slug in the fixture and the current pill gives way to it — see
      `foot.ts` on why that one label is allowed to and a recent's is not.
    */
    const plan = footPlan({
      width: layout.explorerMinWidth,
      contexts: four(),
      currentSlug: "public-worship",
      recent: visited("seyi", "supa", "context-lc"),
    });
    expect(plan?.named).toBe(false);
    expect(plan?.recent.map((c) => c.slug)).toEqual(["seyi", "supa", "context-lc"]);
  });

  test("below the floor the row sheds its least-recent rather than overflowing", () => {
    /*
      A guard, exercised rather than assumed — "a guard nobody has checked is not
      a guard". No panel is this narrow today: `clampExplorerWidth` refuses
      anything under `explorerMinWidth`, and at that floor three marks fit with
      room to spare. The two numbers live in different files though, and the day
      the floor moves down this is what decides between a shorter row and three
      marks drawn past the edge of the panel.
    */
    const plan = footPlan({
      width: 150,
      contexts: four(),
      currentSlug: "seyi",
      recent: visited("supa", "public-worship", "context-lc"),
    });
    expect(plan!.recent.length).toBeLessThan(3);
    // Least-recent first out: the head of the log survives.
    expect(plan?.recent[0]?.slug).toBe("supa");
    expect(footPlan({ width: 40, contexts: four(), currentSlug: "seyi", recent: [] })).toBeNull();
  });

  test("what is planned fits the room it was planned for, at every width", () => {
    /*
      The guard that matters, swept rather than sampled. The constants in
      `foot.ts` are an estimate of what the drawing costs, and the one thing that
      must hold for every arrangement is that the estimate never plans a row
      wider than the room it was given — that is the difference between a
      fallback and a clipped name.
    */
    const CHAR = 7;
    const CHROME = 18 + 6 + 5 + 9;
    const pill = (slug: string) => CHROME + (slug.length + 1) * CHAR;
    for (let width = layout.explorerMinWidth; width <= layout.explorerMaxWidth; width += 1) {
      const plan = footPlan({
        width,
        contexts: four(),
        currentSlug: "seyi",
        recent: visited("supa", "public-worship", "context-lc"),
      });
      if (plan === null) continue;
      /*
        Two budgets, because the current pill is allowed to give in the marks
        shape and not in the named one. `foot.ts` argues which label may be cut
        and why it is only ever that one.
      */
      const items = plan.named
        ? plan.recent.reduce((sum, c) => sum + pill(c.slug), 0)
        : plan.recent.length * 24;
      const current = plan.named ? pill("seyi") : CHROME;
      const drawn = 20 + current + 8 + 8 + 24 + items + 6 * (plan.recent.length - 1);
      expect(drawn).toBeLessThanOrEqual(width);
    }
  });

  test("an unmeasured row plans at the resting width, not at zero", () => {
    /*
      `width: null` is the first render, before `onLayout`. Treating it as zero
      would draw no row for a frame and then one, on every mount — and a control
      that appears late is one people learn not to look for.
    */
    const unmeasured = footPlan({
      width: null,
      contexts: four(),
      currentSlug: "seyi",
      recent: [],
    });
    const resting = footPlan({
      width: layout.explorerWidth,
      contexts: four(),
      currentSlug: "seyi",
      recent: [],
    });
    expect(unmeasured).toEqual(resting);
    expect(unmeasured).not.toBeNull();
  });
});

describe("the row, drawn", () => {
  const row = (over: Partial<Parameters<typeof ContextFootRow>[0]> = {}) =>
    createElement(ContextFootRow, {
      contexts: four(),
      currentSlug: "seyi",
      recent: visited("supa", "public-worship"),
      onOpen: () => {},
      ...over,
    });

  test("pressing a workspace asks to go to it", () => {
    const opened: string[] = [];
    const ui = mount(row({ onOpen: (slug: string) => opened.push(slug) }));
    ui.press("context-foot-supa");
    expect(opened).toEqual(["supa"]);
  });

  test("every workspace has a name a screen reader can read", () => {
    /*
      The rail's rule, and the reason an icon-only collapse was killed once
      already: "a rail that becomes a row of unlabelled glyphs to a screen reader
      is not collapsed, it is broken". At the resting width these are marks — a
      single letter — so the label is spelled out rather than left to be
      concatenated from whatever the platform finds inside.
    */
    const ui = mount(row());
    for (const slug of ["supa", "public-worship", "context-lc"]) {
      expect(ui.need(`context-foot-${slug}`).getAttribute("aria-label")).toBe(
        `Switch to @${slug}`,
      );
    }
  });

  test("the current context is named, and is not a control", () => {
    const ui = mount(row());
    const current = ui.need("context-foot-current");
    expect(current.textContent).toContain("@seyi");
    /*
      The breadcrumb's head is already the way up to the root of this context,
      one panel over. A second control for it at the far end of the column would
      be two answers to one question, and this is the worse-placed of the two.
    */
    expect(current.getAttribute("role")).not.toBe("button");
  });

  test("no row at all where there is nowhere to go", () => {
    const ui = mount(
      row({
        contexts: [context({ slug: "seyi", kind: "personal" })],
        currentSlug: "seyi",
      }),
    );
    expect(ui.find("context-foot-row")).toBeNull();
  });

  test("the menu slot is drawn where one is passed", () => {
    const ui = mount(
      row({ menu: createElement("div", { "data-testid": "context-foot-switcher" }) }),
    );
    expect(ui.find("context-foot-switcher")).not.toBeNull();
  });
});
