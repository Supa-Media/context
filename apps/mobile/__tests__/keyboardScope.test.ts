/**
 * Which region a keystroke belongs to.
 *
 * Pure, so it runs in plain node. The ordering is the whole content of this
 * module and each swap is a real bug, so each is asserted rather than left to
 * the reader of an `if` chain.
 *
 * This exists because the branch shipped a keyboard layer that resolved
 * thirty-three of its thirty-seven commands to nothing: the only caller passed
 * `"global"` or `"overlay"` and never `"tree"` or `"editor"`, so ⌘S did not
 * save while the context menu printed six chords beside its rows.
 */

import { describe, expect, test } from "@jest/globals";
import { scopeForFocus, TREE_REGION_TEST_ID } from "../features/console/keyboardScope";

const NOWHERE = { overlayOpen: false, inTree: false, inEditor: false };

describe("scope", () => {
  test("focus in the note is the editor", () => {
    expect(scopeForFocus({ ...NOWHERE, inEditor: true })).toBe("editor");
  });

  test("focus in the tree is the tree", () => {
    expect(scopeForFocus({ ...NOWHERE, inTree: true })).toBe("tree");
  });

  test("anywhere else is global", () => {
    expect(scopeForFocus(NOWHERE)).toBe("global");
  });
});

describe("the ordering, which is the point", () => {
  test("an overlay beats the editor", () => {
    // Swap these and ⌘S fires while a delete-forever confirmation is open.
    expect(scopeForFocus({ overlayOpen: true, inTree: false, inEditor: true })).toBe("overlay");
  });

  test("an overlay beats the tree", () => {
    expect(scopeForFocus({ overlayOpen: true, inTree: true, inEditor: false })).toBe("overlay");
  });

  test("an overlay beats everything at once", () => {
    expect(scopeForFocus({ overlayOpen: true, inTree: true, inEditor: true })).toBe("overlay");
  });

  test("the editor beats the tree", () => {
    // The explorer's filter box is a text field inside the tree region. Were
    // the tree to win, typing in it would run file commands on the selection.
    expect(scopeForFocus({ overlayOpen: false, inTree: true, inEditor: true })).toBe("editor");
  });
});

describe("the contract with the DOM", () => {
  test("the region is found by a testID, and the name is stated once", () => {
    // `testID` becomes `data-testid`; react-native-web generates class names
    // and renders everything as a div, so this is the only stable hook. If the
    // Explorer's testID is renamed, this constant is what has to move with it.
    expect(TREE_REGION_TEST_ID).toBe("explorer-tree");
  });
});
