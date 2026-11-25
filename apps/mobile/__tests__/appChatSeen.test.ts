import { describe, expect, test } from "@jest/globals";

import { seenFrom } from "../features/tex/chat/appChatSeen";

const base = { slug: "work", editorPath: "projects/plan.md", tabPaths: [] as string[], selection: null as string | null };

describe("seenFrom", () => {
  test("the open note, the other tabs and a selection are all sent, with the workspace as @slug", () => {
    expect(
      seenFrom({
        slug: "work",
        editorPath: "projects/plan.md",
        tabPaths: ["projects/plan.md", "areas/ideas.md"],
        selection: "  the budget line  ",
      }),
    ).toEqual({
      note: { workspace: "@work", path: "projects/plan.md" },
      tabs: [{ workspace: "@work", path: "areas/ideas.md" }],
      selection: "the budget line",
    });
  });

  test("an editor path that is not a .md is dropped, and so is its note; tabs still go", () => {
    const seen = seenFrom({ ...base, editorPath: "files/photo.PNG", tabPaths: ["notes/a.md"] });
    expect(seen).toEqual({ tabs: [{ workspace: "@work", path: "notes/a.md" }] });
    expect(seen?.note).toBeUndefined();
  });

  test("a .md in capitals counts as a note", () => {
    expect(seenFrom({ ...base, editorPath: "Plan.MD" })?.note?.path).toBe("Plan.MD");
  });

  test("the editor's path is not repeated among the tabs", () => {
    const seen = seenFrom({ ...base, tabPaths: ["projects/plan.md", "projects/plan.md", "b.md"] });
    expect(seen?.tabs).toEqual([{ workspace: "@work", path: "b.md" }]);
  });

  test("tabs that are not .md are dropped", () => {
    expect(seenFrom({ ...base, tabPaths: ["x.png", "y.md"] })?.tabs?.map((t) => t.path)).toEqual(["y.md"]);
  });

  test("an open sheet (.csv) is the open note, and a sheet tab goes too", () => {
    // 2026-11-24: an empty sheet open in the editor never reached Tex, which made a new file instead of filling it.
    const seen = seenFrom({ ...base, editorPath: "inbox/untitled-2026-11-24.csv", tabPaths: ["data/costs.CSV", "a.md"] });
    expect(seen?.note).toEqual({ workspace: "@work", path: "inbox/untitled-2026-11-24.csv" });
    expect(seen?.tabs?.map((t) => t.path)).toEqual(["data/costs.CSV", "a.md"]);
  });

  test("nine other tabs send the first eight", () => {
    const tabPaths = Array.from({ length: 9 }, (_, i) => `t${i}.md`);
    const seen = seenFrom({ ...base, editorPath: null, tabPaths });
    expect(seen?.tabs?.map((t) => t.path)).toEqual(tabPaths.slice(0, 8));
  });

  test("a selection of 2000 characters is kept, one of 2001 is dropped", () => {
    expect(seenFrom({ ...base, selection: "a".repeat(2000) })?.selection).toHaveLength(2000);
    expect(seenFrom({ ...base, selection: "a".repeat(2001) })?.selection).toBeUndefined();
  });

  test("a blank selection is no selection", () => {
    expect(seenFrom({ ...base, selection: "   " })?.selection).toBeUndefined();
  });

  test("no slug is no screen at all", () => {
    expect(seenFrom({ ...base, slug: null })).toBeNull();
  });

  test("nothing open is null", () => {
    expect(seenFrom({ slug: "work", editorPath: null, tabPaths: [], selection: null })).toBeNull();
  });

  test("a note carries its workspace and path only, never an id the console does not have", () => {
    const note = seenFrom({ ...base, editorPath: "a/b.md" })?.note;
    expect(note).toEqual({ workspace: "@work", path: "a/b.md" });
  });
});
