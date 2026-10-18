/**
 * The first lines on the phone's Notes page (Dev2, 2026-10-18: "loading note
 * content … so that we can display the first few lines … if it's still being
 * downloaded maybe we should have UI to show that it's loading").
 *
 * SABOTAGE: return `null` from `ledeOf` before a folder answers and "a row is
 * loading until its folder answers" fails; drop the `done` mark in the
 * `catch` and "a folder that fails stops loading" fails.
 */

import { beforeEach, describe, expect, test } from "@jest/globals";
import { forgetNoteLedes, ledeOf, readLedes } from "../features/console/home/noteLedes";
import type { FolderListSource, ListSource } from "../features/console/files/listBlock/model";

function sourceOf(folders: Record<string, { path: string; lede: string | null }[] | Error>) {
  const asked: string[] = [];
  const source: FolderListSource = {
    load: async (folder, subfolders): Promise<ListSource | null> => {
      asked.push(`${folder}|${subfolders}`);
      const answer = folders[folder];
      if (answer instanceof Error) throw answer;
      return {
        complete: true,
        notes: (answer ?? []).map((note) => ({ path: note.path, properties: {}, heading: null, lede: note.lede })),
      };
    },
  };
  return { source, asked };
}

beforeEach(() => forgetNoteLedes());

describe("the first lines on the Notes page", () => {
  test("a note the device keeps draws its own line at once, asking nothing", () => {
    const { source, asked } = sourceOf({});
    expect(ledeOf(source, { path: "a/b.md", lede: "Kept here" })).toBe("Kept here");
    expect(asked).toEqual([]);
  });

  test("a row is loading until its folder answers, then shows the line", async () => {
    const { source, asked } = sourceOf({ "1-projects/x": [{ path: "1-projects/x/plan.md", lede: "First line" }] });
    const note = { path: "1-projects/x/plan.md", lede: null };
    expect(ledeOf(source, note)).toBeUndefined();
    await readLedes(source, ["1-projects/x"]);
    expect(ledeOf(source, note)).toBe("First line");
    // One folder, without its subfolders: the page names only the notes it draws.
    expect(asked).toEqual(["1-projects/x|false"]);
  });

  test("the top level is a folder like any other", async () => {
    const { source } = sourceOf({ "": [{ path: "todo.md", lede: "Buy milk" }] });
    await readLedes(source, [""]);
    expect(ledeOf(source, { path: "todo.md", lede: null })).toBe("Buy milk");
  });

  test("a note its folder did not name has nothing to show, not a bar forever", async () => {
    const { source } = sourceOf({ a: [] });
    await readLedes(source, ["a"]);
    expect(ledeOf(source, { path: "a/empty.md", lede: null })).toBeNull();
  });

  test("a folder that fails stops loading", async () => {
    const { source } = sourceOf({ a: new Error("offline") });
    await readLedes(source, ["a"]);
    expect(ledeOf(source, { path: "a/n.md", lede: null })).toBeNull();
  });

  test("each folder is asked once, however often the page draws", async () => {
    const { source, asked } = sourceOf({ a: [{ path: "a/n.md", lede: "x" }] });
    await Promise.all([readLedes(source, ["a", "a"]), readLedes(source, ["a"])]);
    await readLedes(source, ["a"]);
    expect(asked).toEqual(["a|false"]);
  });

  test("with no source there is nothing to wait for", () => {
    expect(ledeOf(undefined, { path: "a/n.md", lede: null })).toBeNull();
  });
});
