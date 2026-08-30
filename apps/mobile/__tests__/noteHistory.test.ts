import { describe, expect, test } from "@jest/globals";
import {
  canGoBack,
  canGoForward,
  currentPath,
  emptyHistory,
  stepped,
  visited,
  type HistoryState,
} from "../features/console/files/history";

/**
 * The two controls Obsidian's toolbar leads with, and which ours did not have.
 *
 * A phone shows one note at a time, so "the one I was just looking at" is a
 * destination you reach constantly and cannot see. Without this the only route
 * back was to open the drawer and find it in the tree.
 */

function walk(...paths: string[]): HistoryState {
  return paths.reduce(visited, emptyHistory);
}

describe("where you have been", () => {
  test("nothing visited is nowhere to go", () => {
    expect(currentPath(emptyHistory)).toBeNull();
    expect(canGoBack(emptyHistory)).toBe(false);
    expect(canGoForward(emptyHistory)).toBe(false);
  });

  test("one visit is still nowhere to go back to", () => {
    // The first note is not somewhere you arrived *from*.
    const one = walk("a.md");
    expect(canGoBack(one)).toBe(false);
    expect(canGoForward(one)).toBe(false);
  });

  test("back and forward walk the list", () => {
    const three = walk("a.md", "b.md", "c.md");
    expect(currentPath(three)).toBe("c.md");

    const back = stepped(three, -1);
    expect(currentPath(back)).toBe("b.md");
    expect(canGoForward(back)).toBe(true);

    expect(currentPath(stepped(back, 1))).toBe("c.md");
  });

  test("re-opening the note you are on records nothing", () => {
    /*
      The bug that makes a back button untrustworthy. The console re-selects
      the open note on plenty of ordinary events — a listing refresh, a rename
      that lands on the same path — and if each one were an entry, back would
      need two presses to go anywhere, then three.
    */
    const twice = visited(visited(walk("a.md", "b.md"), "b.md"), "b.md");
    expect(twice.entries).toEqual(["a.md", "b.md"]);
    expect(currentPath(stepped(twice, -1))).toBe("a.md");
  });

  test("a revisit further back is a new entry, not a jump", () => {
    // Distinct from the case above: you *went somewhere else* and came back,
    // which is a visit. Collapsing it would make back skip the return trip.
    const state = walk("a.md", "b.md", "a.md");
    expect(state.entries).toEqual(["a.md", "b.md", "a.md"]);
    expect(currentPath(stepped(state, -1))).toBe("b.md");
  });

  test("visiting after stepping back drops the forward tail", () => {
    /*
      A browser's rule, and the reason it is a browser's rule: a forward entry
      is a prediction about a branch you have just left. Keeping it would offer
      to take somebody forward to somewhere they never chose from here.
    */
    const branched = visited(stepped(walk("a.md", "b.md", "c.md"), -1), "d.md");
    expect(branched.entries).toEqual(["a.md", "b.md", "d.md"]);
    expect(canGoForward(branched)).toBe(false);
  });

  test("neither end runs off", () => {
    const one = walk("a.md");
    expect(stepped(one, -1)).toBe(one);
    expect(stepped(one, 1)).toBe(one);
    expect(stepped(emptyHistory, -1)).toBe(emptyHistory);
  });

  test("nothing is mutated", () => {
    // The reducer is handed to React state; a returned object that shares an
    // array with its input is a render that does not happen.
    const before = walk("a.md", "b.md");
    const snapshot = [...before.entries];
    visited(before, "c.md");
    stepped(before, -1);
    expect(before.entries).toEqual(snapshot);
  });
});
