/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { contextMenuItems } from "../features/console/contextMenu";
import { ContextRowMenu } from "../features/console/ContextRowMenu";
import type { ConsoleRoute } from "../features/console/nav";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The per-context menu — a long press on the phone's context strip.
 *
 * Two layers, tested at their own levels. The *contents* are a pure function
 * (`contextMenuItems`) — every item must lead to a destination that exists
 * today, because a menu item pointing nowhere is the "undefined" pill again.
 * The *behavior* is mounted for real, because dismissal and the two-press
 * Leave are wiring rather than data.
 *
 * ## It used to be a right-click on a rail row, and that is the half that went
 *
 * The rail folded into `SwitcherMenu` (`docs/decisions/app-and-console.md`), so
 * its rows — and `RightClickTarget`, the wrapper that reached the real DOM node
 * to attach a `contextmenu` listener react-native-web would otherwise strip —
 * are gone with it. A menu row has no second menu behind it. What a pointer
 * layout has instead is the two verbs this menu offers, as rows in the
 * switcher's own menu: Settings for the context you are in, and Leave where
 * the server would allow it.
 *
 * So this mounts `ContextRowMenu` itself rather than a surface that opens it.
 * That is weaker than what it replaced in exactly one way — nothing here
 * proves a *gesture* reaches it — and `ContextStrip` is where that belongs;
 * the whole of what this file can still hold is what the menu does once it is
 * open, which is where the two-press Leave and the dismissal pair live.
 */

describe("what the menu offers", () => {
  test("every item is a real destination", () => {
    const items = contextMenuItems("agent");
    expect(items.map((item) => item.key)).toEqual(["open", "settings"]);
    expect(items[0].route).toEqual({ kind: "context", slug: "agent", view: "browse" });
    expect(items[1].route).toEqual({ kind: "context", slug: "agent", view: "settings" });
  });

  test("nothing sends anybody out of the context they right-clicked", () => {
    /*
      "Manage sharing…" pointed at the app-level Connections pane. Sharing has
      since moved into the context's own settings — `MembersSection` is mounted
      under Settings → People — so the row answered a per-context question by
      navigating away from the context, and the owner took it off.

      Pinned as a property rather than as a missing key: every route this menu
      offers is *this context's*, which is the rule the removed row broke and
      the one a re-added app-level row would break again.
    */
    for (const item of contextMenuItems("agent", { canLeave: true })) {
      if (!item.route) continue;
      expect(`${item.key}: ${item.route.kind}`).toBe(`${item.key}: context`);
    }
  });

  test("a shared context also offers Leave; an owned one never does", () => {
    // The server refuses an owner leaving (OWNER_CANNOT_LEAVE), so offering
    // it would be a menu item whose only outcome is an error.
    expect(contextMenuItems("agent", { canLeave: false }).map((i) => i.key)).not.toContain(
      "leave",
    );
    const shared = contextMenuItems("friend", { canLeave: true });
    expect(shared.map((i) => i.key)).toContain("leave");
    expect(shared.find((i) => i.key === "leave")!.label).toBe("Leave @friend…");
  });
});

function mountMenu(
  options: {
    slug?: string;
    canLeave?: boolean;
    pinned?: boolean;
    onSelect?: (route: ConsoleRoute) => void;
    onLeave?: () => void;
    onDismiss?: () => void;
  } = {},
): { host: HTMLElement; root: Root } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      createElement(ContextRowMenu as never, {
        slug: options.slug ?? "agent",
        canLeave: options.canLeave ?? false,
        pinned: options.pinned ?? false,
        onSelect: options.onSelect ?? (() => {}),
        onLeave: options.onLeave,
        onDismiss: options.onDismiss ?? (() => {}),
      } as never),
    );
  });
  return { host, root };
}

function click(node: Element) {
  act(() => {
    node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("the menu, mounted for real", () => {
  test("choosing Settings navigates there and leaves closing to the caller", () => {
    const seen: ConsoleRoute[] = [];
    const dismissed: number[] = [];
    const { host, root } = mountMenu({
      onSelect: (route) => seen.push(route),
      onDismiss: () => dismissed.push(1),
    });
    try {
      expect(host.querySelector('[data-testid="context-menu"]')).not.toBeNull();

      click(host.querySelector('[data-testid="context-menu-settings"]')!);
      expect(seen).toEqual([{ kind: "context", slug: "agent", view: "settings" }]);
      /*
        The menu does not close itself: "closing is the caller's move" is on
        the prop, and it is what lets the strip clear its own `menuSlug` in the
        same act as the navigation rather than racing it.
      */
      expect(dismissed).toEqual([]);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  test("Escape asks to be dismissed, without navigating", () => {
    const seen: ConsoleRoute[] = [];
    const dismissed: number[] = [];
    const { host, root } = mountMenu({
      onSelect: (route) => seen.push(route),
      onDismiss: () => dismissed.push(1),
    });
    try {
      act(() => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      });
      expect(dismissed).toEqual([1]);
      expect(seen).toEqual([]);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  test("a pointer-down anywhere else asks to be dismissed too", () => {
    const dismissed: number[] = [];
    const { host, root } = mountMenu({ onDismiss: () => dismissed.push(1) });
    try {
      act(() => {
        document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      });
      expect(dismissed).toEqual([1]);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  /**
   * The trap the rail's kind-based grouping introduced, pinned directly.
   *
   * A workspace you created sat under **Workspaces**, next to workspaces
   * somebody let you into. Anything deriving "can this person leave?" from the
   * group — which is what the menu's old `shared` prop did, filled in from the
   * section — offers Leave there, and the press comes back
   * `OWNER_CANNOT_LEAVE`. The role is the fact the server enforces, and it is
   * `canLeave` here because the caller is the only thing that knows it.
   */
  test("a workspace you own offers no Leave", () => {
    const left: number[] = [];
    const { host, root } = mountMenu({ canLeave: false, onLeave: () => left.push(1) });
    try {
      expect(host.querySelector('[data-testid="context-menu"]')).not.toBeNull();
      expect(host.querySelector('[data-testid="context-menu-leave"]')).toBeNull();
      expect(left).toEqual([]);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  test("Leave appears on a shared context, and takes two presses", () => {
    const left: number[] = [];
    const { host, root } = mountMenu({
      slug: "friend",
      canLeave: true,
      onLeave: () => left.push(1),
    });
    try {
      // The first press only arms it. Leaving is recoverable solely by being
      // re-invited, so the row becomes its own confirmation instead of acting.
      const leave = host.querySelector('[data-testid="context-menu-leave"]');
      expect(leave).not.toBeNull();

      click(leave!);
      expect(left).toEqual([]);
      expect(host.querySelector('[data-testid="context-menu-leave"]')!.textContent).toContain(
        "Press again",
      );

      click(host.querySelector('[data-testid="context-menu-leave"]')!);
      expect(left).toEqual([1]);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  /**
   * The gesture that opens it, asserted where it can be: in the source.
   *
   * `ContextStrip` is the only surface that draws this menu, and it opens it
   * on a long press. A mounted long press needs react-native-web's press
   * responder and its delay timer, which is a test about `Pressable` rather
   * than about either of these components — so what is held here is that the
   * strip still wires the gesture to the menu at all, which is the wiring a
   * refactor drops silently.
   */
  test("the context strip is what opens it, on a long press", () => {
    const source = readFileSync(
      join(__dirname, "..", "features", "console", "ContextStrip.tsx"),
      "utf8",
    );
    expect(source).toContain("onLongPress={() => setMenuSlug(context.slug)}");
    expect(source).toContain("<ContextRowMenu");
  });
});

/**
 * Where an open menu paints, and which element takes the click.
 *
 * Issue #197: the menu opened over the heading below it and that heading's
 * first row (the rail read "Yours" / "Shared with you" then; it groups on kind
 * now, and the geometry is unchanged), that row's hover highlight painted **on top of** the menu, and clicking
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

  /**
   * The rail's own four cases are gone with the rail, and the checker is kept.
   *
   * They mounted `ConsoleRail` at four positions — first group, later row of
   * its own group, last row of the last group, and the lift following the open
   * menu — because the defect lived in the *nesting*: an anchor inside a group
   * inside a scroller, every level at react-native-web's base `z-index: 0`.
   * There is no such nesting now. `ContextStrip` draws the menu against its
   * own `currentAnchor`, outside the horizontal scroller and with nothing
   * after it, which is the geometry the last of those four already covered.
   *
   * The checker stays because it is the general statement of the rule and its
   * self-test above is what makes it worth anything. The day a surface nests
   * this menu inside a list again, it is here to be pointed at it.
   */
  test("the strip anchors it outside the scroller, which is why it has no nesting", () => {
    const source = readFileSync(
      join(__dirname, "..", "features", "console", "ContextStrip.tsx"),
      "utf8",
    );
    expect(source).toContain("currentAnchor: { position: \"relative\", flexShrink: 0 }");
    // Stated in the component, where somebody moving the menu back inside the
    // scroller would have to read past it.
    expect(source).toContain("Anchored to the strip, not to the pill");
  });
});

