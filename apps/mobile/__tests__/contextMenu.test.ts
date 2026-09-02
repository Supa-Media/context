/**
 * @jest-environment jsdom
 */

import { describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { contextMenuItems } from "../features/console/contextMenu";
import { ConsoleRail } from "../features/console/ConsoleRail";
import type { ConsoleData } from "../features/console/types";
import type { ConsoleRoute } from "../features/console/nav";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The right-click menu on a rail context.
 *
 * Two layers, tested at their own levels. The *contents* are a pure function
 * (`contextMenuItems`) — every item must lead to a destination that exists
 * today, because a menu item pointing nowhere is the "undefined" pill again.
 * The *behavior* is mounted for real, because the wiring is exactly the part
 * that silently breaks: react-native-web strips `onContextMenu`, so the
 * listener is attached to the DOM node through a ref (the PR #504 paste
 * lesson), and a refactor that loses the ref loses the feature with every
 * pure test still green.
 */

describe("what the menu offers", () => {
  test("every item is a real destination", () => {
    const items = contextMenuItems("agent");
    expect(items.map((item) => item.key)).toEqual(["open", "settings", "sharing"]);
    expect(items[0].route).toEqual({ kind: "context", slug: "agent", view: "browse" });
    expect(items[1].route).toEqual({ kind: "context", slug: "agent", view: "settings" });
    // Sharing lives in Connections (MembersSection is mounted there), so the
    // item goes where the answer actually is.
    expect(items[2].route).toEqual({ kind: "app", section: "connections" });
  });

  test("a shared context also offers Leave; an owned one never does", () => {
    // The server refuses an owner leaving (OWNER_CANNOT_LEAVE), so offering
    // it would be a menu item whose only outcome is an error.
    expect(contextMenuItems("agent", { shared: false }).map((i) => i.key)).not.toContain(
      "leave",
    );
    const shared = contextMenuItems("friend", { shared: true });
    expect(shared.map((i) => i.key)).toContain("leave");
    expect(shared.find((i) => i.key === "leave")!.label).toBe("Leave @friend…");
  });
});

function context(id: string, slug: string, role: "owner" | "editor") {
  return { id, slug, displayName: slug, role, kind: "personal", status: "ok" };
}

/** The least ConsoleData the rail needs: its two reads are contexts and loading. */
function railData(
  contexts = [
    context("ctx-1", "agent", "owner"),
    // Somebody else's context, reached by invitation — lands under
    // "Shared with you", which is the only place Leave is offered.
    context("ctx-2", "friend", "editor"),
  ],
): ConsoleData {
  return { loading: false, contexts } as unknown as ConsoleData;
}

function mountRail(
  onNavigate: (route: ConsoleRoute) => void,
  onLeaveContext?: (id: string) => void,
  data: ConsoleData = railData(),
): { host: HTMLElement; root: Root } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      createElement(ConsoleRail as never, {
        data,
        route: { kind: "app", section: "map" },
        mode: "full",
        onNavigate,
        account: null,
        onLeaveContext,
      } as never),
    );
  });
  return { host, root };
}

function rightClick(node: Element) {
  act(() => {
    node.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  });
}

function click(node: Element) {
  act(() => {
    node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("the menu, mounted for real", () => {
  test("right-click opens it; choosing Settings navigates there and closes it", () => {
    const seen: ConsoleRoute[] = [];
    const { host, root } = mountRail((route) => seen.push(route));
    try {
      const entry = host.querySelector('[aria-label="Open @agent"]');
      expect(entry).not.toBeNull();

      expect(host.querySelector('[data-testid="context-menu"]')).toBeNull();
      rightClick(entry!);
      expect(host.querySelector('[data-testid="context-menu"]')).not.toBeNull();

      click(host.querySelector('[data-testid="context-menu-settings"]')!);
      expect(seen).toEqual([{ kind: "context", slug: "agent", view: "settings" }]);
      expect(host.querySelector('[data-testid="context-menu"]')).toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  test("Escape closes it without navigating", () => {
    const onNavigate = jest.fn();
    const { host, root } = mountRail(onNavigate as never);
    try {
      rightClick(host.querySelector('[aria-label="Open @agent"]')!);
      expect(host.querySelector('[data-testid="context-menu"]')).not.toBeNull();

      act(() => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      });
      expect(host.querySelector('[data-testid="context-menu"]')).toBeNull();
      expect(onNavigate).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  test("a pointer-down anywhere else closes it", () => {
    const onNavigate = jest.fn();
    const { host, root } = mountRail(onNavigate as never);
    try {
      rightClick(host.querySelector('[aria-label="Open @agent"]')!);
      act(() => {
        document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      });
      expect(host.querySelector('[data-testid="context-menu"]')).toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  test("Leave appears only on the shared context, and takes two presses", () => {
    const left: string[] = [];
    const { host, root } = mountRail(
      () => {},
      (id) => left.push(id),
    );
    try {
      // The owned context has no Leave.
      rightClick(host.querySelector('[aria-label="Open @agent"]')!);
      expect(host.querySelector('[data-testid="context-menu-leave"]')).toBeNull();

      // The shared one does — and the first press only arms it. Leaving is
      // recoverable solely by being re-invited, so the row becomes its own
      // confirmation instead of acting.
      rightClick(host.querySelector('[aria-label="Open @friend"]')!);
      const leave = host.querySelector('[data-testid="context-menu-leave"]');
      expect(leave).not.toBeNull();

      click(leave!);
      expect(left).toEqual([]);
      expect(host.querySelector('[data-testid="context-menu-leave"]')!.textContent).toContain(
        "Press again",
      );

      click(host.querySelector('[data-testid="context-menu-leave"]')!);
      expect(left).toEqual(["ctx-2"]);
      expect(host.querySelector('[data-testid="context-menu"]')).toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  test("a plain left click still just opens the context", () => {
    const seen: ConsoleRoute[] = [];
    const { host, root } = mountRail((route) => seen.push(route));
    try {
      click(host.querySelector('[aria-label="Open @agent"]')!);
      expect(seen).toEqual([{ kind: "context", slug: "agent", view: "browse" }]);
      expect(host.querySelector('[data-testid="context-menu"]')).toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});

/**
 * Where an open menu paints, and which element takes the click.
 *
 * Issue #197: the menu opened over the "Shared with you" heading and its first
 * row, that row's hover highlight painted **on top of** the menu, and clicking
 * "Settings…" navigated to the shared context instead. For an account whose
 * only context is the first in the rail, that made the context Settings pane
 * unreachable by its only affordance.
 *
 * ## The ancestor that traps it, which the issue asked to be identified
 *
 * Not the `ScrollView`, which was the standing guess. **Every react-native-web
 * `View` sets `position: relative; z-index: 0`** in its base style
 * (`react-native-web/dist/exports/View/index.js`), so every one of them is a
 * *stacking context*. The menu's `zIndex: 30` is therefore confined to
 * `RightClickTarget`'s own anchor, and what actually decides the paint order
 * against the rest of the rail is the anchor's `0` among its siblings, and the
 * "Yours" `Group`'s `0` among the groups. A later sibling at the same z-index
 * paints last, so it paints on top — and hit-testing follows paint order, so it
 * also takes the click. That is one mechanism, not two, which is why raising
 * the z-index of the right ancestors fixes both halves together.
 *
 * ## What this file can and cannot assert
 *
 * jsdom lays nothing out and implements no hit-testing, so this is not a click
 * test — `elementFromPoint` would answer nothing. What it can do is resolve
 * react-native-web's injected stylesheet, which is where the whole defect
 * lives: the property asserted is that **at every level between the open menu
 * and the rail's scroll viewport, the ancestor carrying the menu out-ranks its
 * later siblings**. That is exactly the CSS rule that was being violated, and
 * the one the browser consults for both painting and pointer targeting.
 *
 * The walk stops at the scroll viewport because the menu is genuinely clipped
 * there — the account block below it can never be overlapped, so demanding the
 * `ScrollView` out-rank it would be asking for a lift nothing needs.
 *
 * That the two halves really do move together was **measured rather than
 * assumed**, in headless Chrome over a static page reproducing this exact
 * nesting (`position: relative; z-index: 0` at every level, the menu absolute
 * at 30, a later sibling group beneath it), asking `elementFromPoint` for the
 * centre of the menu's "Settings…" row:
 *
 *     before the lift: hits #shared-row     <- the bug, reproduced
 *     after  the lift: hits #item-settings
 *
 * So one z-index change moves the paint and the pointer at once, and there is
 * no state in which the menu looks right while the wrong element is clickable.
 * **Nothing in CI holds that measurement** — it was taken by hand, and this
 * repo has no browser harness to keep it in. What CI holds is the declaration
 * the browser then acts on, which is where the defect actually was; the step
 * from "the menu out-ranks that row" to "the menu takes the click" is argued
 * from the CSS rule rather than re-run on every commit, and is worth
 * re-measuring if either element ever gains a `pointer-events` override.
 *
 * One thing this deliberately does not check, because it is a different bug:
 * the menu is `position: absolute`, so it adds no height to the scroll content
 * and a menu opened on the rail's last visible row is still **clipped** by the
 * `ScrollView`. That is unchanged by this fix and unrelated to it — the fix is
 * about which of two overlapping elements wins, not about the viewport.
 *
 * The checker carries a self-test, because its assertion is that it found
 * *nothing* — so anything that shortens the walk turns every case below green
 * without looking at the rail at all. That is not hypothetical here: it is how
 * the first version of this file passed against the broken code.
 */

/** `auto` orders as 0 among positioned siblings; it just makes no context. */
function order(node: Element): number {
  const value = getComputedStyle(node).zIndex;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * True of the react-native-web `ScrollView` that clips the rail's content.
 *
 * jsdom answers `""` for a declaration nobody made, so an unset `overflow` has
 * to be read as `visible` — treating the empty string as "clips" stops the walk
 * at the menu itself and the whole check passes vacuously, which is how the
 * first version of this file went green against the broken code.
 */
function clips(node: Element): boolean {
  const value = getComputedStyle(node).overflowY;
  return value !== "" && value !== "visible";
}

/**
 * Every level between `menu` and the scroll viewport where a later sibling
 * would paint over the menu — described, so a failure names the level.
 */
function stackingFaults(menu: Element, host: Element): string[] {
  const faults: string[] = [];
  let node: Element | null = menu;
  while (node && node !== host && !clips(node)) {
    for (let after = node.nextElementSibling; after; after = after.nextElementSibling) {
      if (order(after) >= order(node)) {
        faults.push(
          `"${(node.textContent ?? "").slice(0, 20)}" at z=${order(node)} is painted over by ` +
            `a later sibling "${(after.textContent ?? "").slice(0, 20)}" at z=${order(after)}`,
        );
      }
    }
    node = node.parentElement;
  }
  return faults;
}

describe("an open menu paints above the rows that follow it", () => {
  test("the checker itself catches an inversion", () => {
    // `stackingFaults` asserts an *empty* list, so anything that shortens the
    // walk makes all four tests below pass by finding nothing — which is
    // exactly how the first version of this file went green against the broken
    // code. So the checker is run against a DOM built to be wrong: a menu
    // inside an anchor inside a group, every level at the base `z-index: 0`
    // that react-native-web gives a View, with a later sibling at each of the
    // two levels the real defect lived at.
    const host = document.createElement("div");
    host.innerHTML = `
      <div style="position:relative;z-index:0;overflow-y:auto">
        <div style="position:relative;z-index:0">
          <div style="position:relative;z-index:0">
            <div style="position:relative;z-index:0">
              <div style="position:absolute;z-index:30">menu</div>
            </div>
            <div style="position:relative;z-index:0">later row</div>
          </div>
          <div style="position:relative;z-index:0">later group</div>
        </div>
      </div>`;
    document.body.appendChild(host);
    try {
      const faults = stackingFaults(host.querySelector("div[style*='absolute']")!, host);
      expect(faults).toHaveLength(2);
      expect(faults.join(" ")).toContain("later row");
      expect(faults.join(" ")).toContain("later group");

      // ...and stays quiet once those two levels out-rank their siblings,
      // which is the shape the rail is in after the fix.
      for (const node of host.querySelectorAll("div[style*='absolute']")) {
        (node.parentElement as HTMLElement).style.zIndex = "1";
        ((node.parentElement as HTMLElement).parentElement as HTMLElement).style.zIndex = "1";
      }
      expect(stackingFaults(host.querySelector("div[style*='absolute']")!, host)).toEqual([]);
    } finally {
      host.remove();
    }
  });

  /** Two of each, so both the group and the row level have later siblings. */
  const crowded = railData([
    context("ctx-1", "agent", "owner"),
    context("ctx-2", "second", "owner"),
    context("ctx-3", "friend", "editor"),
    context("ctx-4", "fourth", "editor"),
  ]);

  test("a menu in the first group out-ranks the group that follows it", () => {
    const { host, root } = mountRail(() => {}, undefined, crowded);
    try {
      rightClick(host.querySelector('[aria-label="Open @agent"]')!);
      const menu = host.querySelector('[data-testid="context-menu"]')!;
      expect(stackingFaults(menu, host)).toEqual([]);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  test("...and out-ranks the later rows of its own group", () => {
    // The same defect one level down: without the anchor's own lift, the menu
    // is trapped under the *next context in the same group* even when the
    // group is lifted as a whole.
    const { host, root } = mountRail(() => {}, undefined, crowded);
    try {
      rightClick(host.querySelector('[aria-label="Open @friend"]')!);
      const menu = host.querySelector('[data-testid="context-menu"]')!;
      expect(stackingFaults(menu, host)).toEqual([]);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  test("the case that already worked still does: the last row of the last group", () => {
    const { host, root } = mountRail(() => {}, undefined, crowded);
    try {
      rightClick(host.querySelector('[aria-label="Open @fourth"]')!);
      const menu = host.querySelector('[data-testid="context-menu"]')!;
      expect(stackingFaults(menu, host)).toEqual([]);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  test("the lift follows the open menu, and closing puts it back", () => {
    // Lifting every group unconditionally would silently invert the rail's
    // normal top-to-bottom order, so the raised element has to be *the* one
    // holding the open menu and nothing else — and only while it is open.
    const { host, root } = mountRail(() => {}, undefined, crowded);
    const lifted = () =>
      [...host.querySelectorAll("div")].filter((node) => order(node) > 0).length;
    try {
      expect(lifted()).toBe(0);

      rightClick(host.querySelector('[aria-label="Open @agent"]')!);
      // The menu itself, its anchor, and its group — and no second group, no
      // second row.
      expect(lifted()).toBe(3);

      act(() => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      });
      expect(lifted()).toBe(0);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});
