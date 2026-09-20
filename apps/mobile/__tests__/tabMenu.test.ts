/**
 * What a right-click on a tab offers.
 *
 * Before this the tab menu was a hand-rolled popover inside `TabStrip.tsx` —
 * its own card, its own scrim, its own rows — carrying a `TODO(menu)` asking
 * for it to be folded into the shared `Menu`, and **not one test**. That
 * combination is exactly what `docs/decisions/testing.md` is one rule about: a
 * guard nobody has checked is not a guard, and neither is a menu.
 *
 * The fold is the point of these checks. `Menu` is generic in its id, so the
 * tab menu brings its own four-item union rather than widening `MenuActionId`
 * — the file dispatcher must not grow a `closeTab` case it can never reach.
 *
 * The rules worth pinning are the two this menu does *differently* from the
 * file menu, and the one it does the same:
 *
 *  - the same: an item with nothing to act on is **absent**;
 *  - differently: "Reopen closed" is **present and disabled**;
 *  - and every verb names the tab that was clicked, not the active one.
 */

import { describe, expect, test } from "@jest/globals";
import { tabMenuItems } from "../features/console/files/TabStrip";
import { emptyTabs, tabsReducer, type TabsState } from "../features/console/files/tabs";
import { describeBinding } from "../features/design/keymap";
import { isApplePlatform } from "../features/design/applePlatform";

/**
 * The same question `tabMenuItems` asks itself. Hardcoding `true` here printed
 * `⌘⇧T` beside a row whose chord under jsdom is `Ctrl+Shift+T` — which is the
 * very mistake `menu.ts` keeps a whole paragraph about, made in the test rather
 * than in the menu.
 */
const APPLE = isApplePlatform();

const A = "1-projects/a.md";
const B = "1-projects/b.md";
const C = "1-projects/c.md";

function open(...paths: string[]): TabsState {
  return paths.reduce<TabsState>(
    (state, path) => tabsReducer(state, { type: "opened", path, mode: "pinned" }),
    emptyTabs,
  );
}

const ids = (state: TabsState, path: string) =>
  tabMenuItems(state, path).map((item) => item.id);

const find = (state: TabsState, path: string, id: string) =>
  tabMenuItems(state, path).find((item) => item.id === id);

/* -------------------------------------------------------------------------- */

describe("what the tab menu offers", () => {
  test("three tabs open, in the middle: everything applies", () => {
    expect(ids(open(A, B, C), B)).toEqual([
      "close",
      "closeOthers",
      "closeToRight",
      "reopen",
    ]);
  });

  /**
   * Absent, not inert — the file menu's rule, and right here for the same
   * reason: "Close others" on the only open tab is not something you are
   * temporarily unable to do, it is something that does not apply.
   */
  test("the only tab open offers neither bulk close", () => {
    expect(ids(open(A), A)).toEqual(["close", "reopen"]);
  });

  test("the rightmost tab has nothing to its right", () => {
    const state = open(A, B);
    expect(ids(state, B)).toContain("closeOthers");
    expect(ids(state, B)).not.toContain("closeToRight");
  });

  test("the leftmost tab of several has both", () => {
    expect(ids(open(A, B), A)).toEqual(["close", "closeOthers", "closeToRight", "reopen"]);
  });
});

describe("reopen is the one item that is present and disabled", () => {
  /**
   * The documented exception to "absent, not disabled", and it does not
   * generalise: this item is one ⌘⇧T away from being available again, it comes
   * back on its own the moment anything is closed, and a three-row menu whose
   * contents shuffle between openings is a menu nobody can learn. Absence tells
   * the truth about a permission; absence would tell a lie about an empty undo
   * stack.
   */
  test("nothing closed yet: present, and disabled", () => {
    const item = find(open(A, B), A, "reopen");
    expect(item).toBeDefined();
    expect(item?.disabled).toBe(true);
  });

  test("something closed: present, and live", () => {
    const state = tabsReducer(open(A, B), { type: "closed", path: B });
    const item = find(state, A, "reopen");
    expect(item?.disabled).toBeUndefined();
  });

  test("it is never dropped from the list either way", () => {
    expect(ids(open(A), A)).toContain("reopen");
  });
});

describe("chords come from the keymap, never from a literal", () => {
  /**
   * A menu that prints a keystroke nothing binds is worse than one that prints
   * none — `menu.ts` learned this when `copyPath` advertised `⌘⇧C` for a
   * binding that did not exist. Resolved through `describeBinding` so a rebind
   * moves the label with it.
   */
  test("close prints what the console actually binds", () => {
    expect(find(open(A), A, "close")?.shortcut).toBe(describeBinding("closeTab", APPLE));
  });

  test("reopen too", () => {
    expect(find(open(A), A, "reopen")?.shortcut).toBe(describeBinding("reopenTab", APPLE));
  });

  /**
   * Live rather than vacuous: `tabMenuItems` reads the platform itself and
   * jsdom is not an Apple one, so every chord here is spelled `Ctrl+…`. Writing
   * the two assertions above against a hardcoded `true` is what proved it.
   */
  test("a non-Apple keyboard is offered no key it does not have", () => {
    expect(APPLE).toBe(false);
    for (const item of tabMenuItems(open(A, B), A)) {
      if (item.shortcut === undefined) continue;
      expect(item.shortcut).not.toContain("⌘");
    }
  });
});

describe("separators come from grouping, as everywhere else", () => {
  test("a rule before reopen, and never above the first item", () => {
    const items = tabMenuItems(open(A, B, C), B);
    expect(items[0].separatorBefore).toBeUndefined();
    expect(items.find((item) => item.id === "reopen")?.separatorBefore).toBe(true);
  });

  test("and still exactly one rule when the closes collapse to one item", () => {
    const items = tabMenuItems(open(A), A);
    expect(items.filter((item) => item.separatorBefore === true)).toHaveLength(1);
  });
});

describe("a path that is not open", () => {
  /**
   * The strip can only raise this menu on a tab it drew, so this is a guard
   * rather than a case — but the arithmetic behind `closeToRight` is an index,
   * and an index of -1 that fell through would offer to close every tab.
   */
  test("offers no close-to-the-right, because there is no position to be right of", () => {
    expect(ids(open(A, B), "1-projects/ghost.md")).not.toContain("closeToRight");
  });
});
