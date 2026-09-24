import { describe, expect, test } from "@jest/globals";
import { dir, find, ids, labels, menu, note, row } from "./fixtures";


/* -------------------------------------------------------------------------- */
/*                                 visibility                                 */
/* -------------------------------------------------------------------------- */

describe("the visibility submenu", () => {
  /**
   * **These are verbs, and that is the point of them.**
   *
   * They read "Private" and "Team" for as long as this menu existed — the same
   * two words, in the same two colours, that the tree's marker and the
   * breadcrumb's chip use for the *current state*. Nothing on screen said
   * whether pressing "Team" set the visibility or filtered by it, and the only
   * way to find out was to press it and watch what happened to somebody's
   * access.
   *
   * The last item is the one worth reading twice. "Follow folder" named the
   * state it leaves behind; the act is removing this note's own exception,
   * which is the only way back to tracking the folder.
   */
  test("a note's three items say what pressing them does", () => {
    const submenu = find(menu({ kind: "row", row: note("1-projects/plan.md") }), "visibility");
    expect(submenu?.label).toBe("Visibility");
    expect(labels(submenu?.items ?? [])).toEqual([
      "Make private",
      "Share with the team",
      "Use the folder's setting",
    ]);
    expect(ids(submenu?.items ?? [])).toEqual([
      "visibilityPrivate",
      "visibilityTeam",
      "visibilityFollow",
    ]);
  });

  /** A folder's default *is* the value being set; there is no outer default. */
  test("a folder gets two, because it has no folder to follow", () => {
    const submenu = find(menu({ kind: "row", row: dir("1-projects") }), "visibility");
    expect(labels(submenu?.items ?? [])).toEqual([
      "Make everything here private",
      "Share everything here with the team",
    ]);
  });

  test("a folder's items say what they do not reach", () => {
    /*
      The half people get wrong. `setFolderVisibility` sets the folder's
      default, and a note carrying its own exception keeps it — which is
      exactly why the tree marks the exceptions and not the followers. A
      control that said "Share everything here" and meant "everything except
      four notes you cannot see from this menu" would be the console
      overstating what it just did to somebody's access.

      A count is deliberately not offered beside it. Listings are fetched per
      folder, so the client can only see the folders somebody has expanded, and
      it cannot tell a subfolder with its own rule from one merely inheriting —
      so any number would be wrong in both directions at once. This repo's own
      rule is that a floor is never printed as a total; a sentence is the
      honest form of what is actually known.
    */
    const submenu = find(menu({ kind: "row", row: dir("1-projects") }), "visibility");
    for (const item of submenu?.items ?? []) {
      expect(item.detail).toBe("Except notes with a setting of their own.");
    }
  });

  test("a note's items carry no detail line", () => {
    // A menu where every row explains itself is a menu nobody reads. The
    // folder pair earns one because its reach is not visible from the row.
    const submenu = find(menu({ kind: "row", row: note("1-projects/plan.md") }), "visibility");
    for (const item of submenu?.items ?? []) expect(item.detail).toBeUndefined();
  });

  test("the parent carries an id no dispatcher can mistake for an action", () => {
    const submenu = find(menu({ kind: "row", row: note("1-projects/plan.md") }), "visibility");
    expect(submenu?.id).toBe("visibility");
  });

  test("only one level deep", () => {
    const submenu = find(menu({ kind: "row", row: note("1-projects/plan.md") }), "visibility");
    for (const child of submenu?.items ?? []) expect(child.items).toBeUndefined();
  });

  /**
   * Not yet, even a uniform one. Each row is its own write to `privacy.md`
   * with no batch form and no single Undo, so a "Share 3 items with the team"
   * that stopped after the second would leave a privacy change half made —
   * the one item where half made is a disclosure. This used to assert the
   * plural labels for a menu nothing could open; the tree can open it now,
   * and nothing could run it.
   */
  test("a selection gets none, uniform or not", () => {
    for (const rows of [
      [note("1-projects/a.md"), note("1-projects/b.md")],
      [dir("1-projects"), dir("2-areas")],
    ]) {
      expect(find(menu({ kind: "selection", rows }), "visibility")).toBeUndefined();
    }
  });

  /** An item that applies to some of what is selected is a partial success. */
  test("a mixed selection gets none", () => {
    const list = menu({ kind: "selection", rows: [dir("1-projects"), note("2-areas/a.md")] });
    expect(find(list, "visibility")).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/*                             archive and restore                            */
/* -------------------------------------------------------------------------- */

describe("what is already put away is restored, not archived again", () => {
  const archived = note("4-archive/2026-08-26T09-14-02-113Z/1-projects/plan.md");

  test("an archived note swaps archive for restore", () => {
    const list = menu({ kind: "row", row: archived });
    expect(find(list, "restore")?.label).toBe("Restore");
    expect(find(list, "archive")).toBeUndefined();
  });

  test("an ordinary note has archive and no restore", () => {
    const list = menu({ kind: "row", row: note("1-projects/plan.md") });
    expect(find(list, "archive")?.label).toBe("Archive");
    expect(find(list, "restore")).toBeUndefined();
  });

  /** Restoring is only offered when every row knows where it came from. */
  test("a selection restores only when all of it is archived", () => {
    const all = menu({
      kind: "selection",
      rows: [archived, note("4-archive/2026-08-26T09-14-02-113Z/2-areas/b.md")],
    });
    expect(find(all, "restore")?.label).toBe("Restore 2 items");

    const mixed = menu({ kind: "selection", rows: [archived, note("1-projects/live.md")] });
    expect(find(mixed, "restore")).toBeUndefined();
    expect(find(mixed, "archive")?.label).toBe("Archive 2 items");
  });
});

/* -------------------------------------------------------------------------- */
/*                              multi-selection                               */
/* -------------------------------------------------------------------------- */

describe("a selection is a different menu, not the same one applied three times", () => {
  const three = menu({
    kind: "selection",
    rows: [note("1-projects/a.md"), note("1-projects/b.md"), note("1-projects/c.md")],
  });

  test("rename and duplicate are gone, not repeated", () => {
    expect(find(three, "rename")).toBeUndefined();
    expect(find(three, "duplicate")).toBeUndefined();
  });

  test("there is nothing to open, either", () => {
    expect(find(three, "open")).toBeUndefined();
    expect(find(three, "openInNewTab")).toBeUndefined();
  });

  test("every label says how many things it is about to touch", () => {
    expect(find(three, "moveTo")?.label).toBe("Move 3 items to…");
    expect(find(three, "copyPath")?.label).toBe("Copy 3 paths");
    expect(find(three, "archive")?.label).toBe("Archive 3 items");
    expect(find(three, "delete")?.label).toBe("Move 3 items to trash");
  });

  test("the whole list, in order", () => {
    expect(ids(three)).toEqual(["moveTo", "copyPath", "archive", "delete"]);
  });

  /**
   * The clipboard holds one path (`clipboard.ts`), so "Copy 3 items" would
   * put the first on it and paste one. ⌥-dragging the selection is how
   * several are copied at once.
   */
  test("copy and cut are gone, because the clipboard holds one path", () => {
    expect(find(three, "copy")).toBeUndefined();
    expect(find(three, "cut")).toBeUndefined();
  });

  /**
   * Which items you are offered must not depend on whether you reached one
   * note by clicking it or by selecting it alone.
   */
  test("a selection of one is the row menu", () => {
    const one = note("1-projects/plan.md");
    expect(menu({ kind: "selection", rows: [one] })).toEqual(menu({ kind: "row", row: one }));
  });

  test("a selection of none opens no menu", () => {
    expect(menu({ kind: "selection", rows: [] })).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*                          rows that are not entries                         */
/* -------------------------------------------------------------------------- */

/**
 * `loading` and `empty` are placeholders the tree draws so that "not loaded
 * yet" and "nothing here" are different sentences. They carry
 * `readOnly: true`, which would otherwise quietly qualify them for the
 * privacy.md menu — offering "Copy path" for the path of a spinner.
 */
describe("a placeholder row is not a file", () => {
  test("loading offers nothing", () => {
    expect(menu({ kind: "row", row: row("loading", "1-projects", { readOnly: true }) })).toEqual([]);
  });

  test("empty offers nothing", () => {
    expect(menu({ kind: "row", row: row("empty", "1-projects", { readOnly: true }) })).toEqual([]);
  });

  test("and one in a selection takes the whole menu down rather than half of it", () => {
    expect(
      menu({
        kind: "selection",
        rows: [note("1-projects/a.md"), row("loading", "1-projects", { readOnly: true })],
      }),
    ).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*                                  wording                                   */
/* -------------------------------------------------------------------------- */

describe("labels say what happens, and an ellipsis promises more input", () => {
  const list = menu({ kind: "row", row: note("1-projects/plan.md") });

  test("deletion is a recoverable, immediate move to trash", () => {
    expect(find(list, "delete")?.label).toBe("Move to trash");
  });

  test("a move needs a destination before it can do anything", () => {
    expect(find(list, "moveTo")?.label).toBe("Move to…");
  });

  test("the rest are sentence case and immediate", () => {
    expect(find(list, "open")?.label).toBe("Open");
    expect(find(list, "openInNewTab")?.label).toBe("Open in new tab");
    expect(find(list, "duplicate")?.label).toBe("Duplicate");
    expect(find(list, "copy")?.label).toBe("Copy");
    expect(find(list, "cut")?.label).toBe("Cut");
    expect(find(list, "copyPath")?.label).toBe("Copy path");
    expect(find(list, "copyAtPath")?.label).toBe("Copy @path");
    expect(find(list, "archive")?.label).toBe("Archive");
  });

  test("no label is shouted or title-cased", () => {
    for (const entry of list) {
      expect(entry.label).toBe(entry.label.trim());
      expect(entry.label).not.toBe(entry.label.toUpperCase());
    }
  });
});
