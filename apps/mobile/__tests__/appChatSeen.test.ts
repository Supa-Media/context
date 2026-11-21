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
      note: { workspace: "@work", noteId: "projects/plan.md", path: "projects/plan.md" },
      tabs: [{ workspace: "@work", noteId: "areas/ideas.md", path: "areas/ideas.md" }],
      selection: "the budget line",
    });
  });

  test("an editor path that is not a .md is dropped, and so is its note; tabs still go", () => {
    const seen = seenFrom({ ...base, editorPath: "files/photo.PNG", tabPaths: ["notes/a.md"] });
    expect(seen).toEqual({ tabs: [{ workspace: "@work", noteId: "notes/a.md", path: "notes/a.md" }] });
    expect(seen?.note).toBeUndefined();
  });

  test("a .md in capitals counts as a note", () => {
    expect(seenFrom({ ...base, editorPath: "Plan.MD" })?.note?.path).toBe("Plan.MD");
  });

  test("the editor's path is not repeated among the tabs", () => {
    const seen = seenFrom({ ...base, tabPaths: ["projects/plan.md", "projects/plan.md", "b.md"] });
    expect(seen?.tabs).toEqual([{ workspace: "@work", noteId: "b.md", path: "b.md" }]);
  });

  test("tabs that are not .md are dropped", () => {
    expect(seenFrom({ ...base, tabPaths: ["x.png", "y.md"] })?.tabs?.map((t) => t.path)).toEqual(["y.md"]);
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

  test("a 200-character path's noteId is its last 128 characters", () => {
    const path = `${"a".repeat(200 - 3)}.md`;
    expect(path).toHaveLength(200);
    const note = seenFrom({ ...base, editorPath: path })?.note;
    expect(note?.noteId).toBe(path.slice(-128));
    expect(note?.noteId).toHaveLength(128);
    expect(note?.path).toBe(path);
  });
});
