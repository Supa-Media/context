/**
 * Which folders the console keeps live from Convex (`useLiveTree.ts`): the
 * root always, the folder on screen, then expanded folders shallowest first,
 * within `LIVE_FOLDERS`, in one stable order so the same set is the same
 * subscription.
 */
import { LIVE_FOLDERS, liveFolders } from "../features/console/files/fileBrowser/useLiveTree";

describe("liveFolders", () => {
  test("the root is always live, alone when nothing is open", () => {
    expect(liveFolders(new Set(), null, false)).toEqual([""]);
  });

  test("a viewed folder is live, and a viewed note's folder", () => {
    expect(liveFolders(new Set(), "1-projects/a", true)).toEqual(["", "1-projects/a"]);
    expect(liveFolders(new Set(), "1-projects/a/note.md", false)).toEqual(["", "1-projects/a"]);
  });

  test("expanded folders join, in a stable order whatever order they opened in", () => {
    const one = liveFolders(new Set(["b", "a/x", "a"]), null, false);
    const two = liveFolders(new Set(["a", "b", "a/x"]), null, false);
    expect(one).toEqual(["", "a", "a/x", "b"]);
    expect(two).toEqual(one);
  });

  test("past the bound, the shallowest folders win, and the viewed one is never dropped", () => {
    const deep = Array.from({ length: LIVE_FOLDERS + 10 }, (_, index) => `x/${String(index).padStart(3, "0")}/y`);
    const expanded = new Set([...deep, "top"]);
    const live = liveFolders(expanded, "z/seen", true);
    expect(live).toHaveLength(LIVE_FOLDERS);
    expect(live).toContain("top");
    expect(live).toContain("z/seen");
    expect(live).toContain("");
  });
});
