/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";
import { mountFrame } from "./fixtures";

/**
 * THE ACCOUNT BUTTON NEVER LEAVES THE SCREEN ON A POINTER LAYOUT.
 *
 * Its home is the foot of the file tree, which the explorer draws. The tree can
 * be folded away (⌘B, the status toggle, the seam) and some routes have none,
 * and the button is where the workspaces, Settings and the only pointer
 * sign-out are — so while there is no column, `AppFrame` draws the same menu
 * behind an avatar at the leading end of the status bar.
 *
 * SABOTAGE: drop `regions.explorer !== "column"` from `frameStatusRow` and
 * "not beside a tree that already carries it" fails; drop the whole fallback
 * and both "folded" and "no tree" fail.
 */
describe("the account button's fallback in the status bar", () => {
  test("not beside a tree that already carries it", () => {
    const app = mountFrame(1440);
    expect(app.find("explorer")).not.toBeNull();
    expect(app.find("account-fallback")).toBeNull();
    app.unmount();
  });

  test("folded tree: the status bar carries it, and gives it back on unfold", () => {
    const app = mountFrame(1440);
    app.press("status-toggle-explorer");
    expect(app.find("explorer")).toBeNull();
    expect(app.find("account-fallback")).not.toBeNull();

    app.press("status-toggle-explorer");
    expect(app.find("account-fallback")).toBeNull();
    app.unmount();
  });

  test("no tree on this route: the status bar carries it", () => {
    const app = mountFrame(1440, "the note", { explorer: false });
    expect(app.find("account-fallback")).not.toBeNull();
    app.unmount();
  });

  test("a phone draws none: its account is the top row's", () => {
    const app = mountFrame(390, "the note", { explorer: false });
    expect(app.find("account-fallback")).toBeNull();
    expect(app.find("account")).not.toBeNull();
    app.unmount();
  });
});
