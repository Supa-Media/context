/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";
import { movedCaret } from "../../features/console/presence/remoteCarets";
import { member, at } from "./fixtures";

/*
  A cast follows whoever is writing (Dev2, 2026-10-01: "make sure that the
  page moves down or up to where is currently being written … maya writes
  something under but it cant be seen"). The caret to follow is the one that
  just moved.
*/
describe("movedCaret", () => {
  test("the member whose caret changed", () => {
    const maya = member({ id: "maya", head: at(4), anchor: at(4) });
    const jon = member({ id: "jon", head: at(9), anchor: at(9) });
    const later = { ...maya, head: at(40), anchor: at(40) };
    expect(movedCaret([maya, jon], [later, jon])?.id).toBe("maya");
  });

  test("somebody arriving with a caret counts as moving", () => {
    const jon = member({ id: "jon", head: at(9), anchor: at(9) });
    expect(movedCaret([], [jon])?.id).toBe("jon");
  });

  test("nobody moved, or the mover has no place yet: nothing to follow", () => {
    const jon = member({ id: "jon", head: at(9), anchor: at(9) });
    expect(movedCaret([jon], [jon])).toBeNull();
    const nowhere = member({ id: "maya", head: null, anchor: null });
    expect(movedCaret([], [nowhere])).toBeNull();
  });

  test("of several that moved at once, the last in the roster", () => {
    const a = member({ id: "a", head: at(1), anchor: at(1) });
    const b = member({ id: "b", head: at(2), anchor: at(2) });
    expect(movedCaret([], [a, b])?.id).toBe("b");
  });
});
