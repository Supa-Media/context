import { describe, expect, test } from "@jest/globals";
import { dir, find, ids, labels, menu, MUTATING, note, put } from "./fixtures";

/* -------------------------------------------------------------------------- */
/*                        a console that cannot edit                          */
/* -------------------------------------------------------------------------- */

describe("read-only means absent, not disabled", () => {
  /**
   * The landing page runs the real console against literals, and a workspace
   * `member` has read access without write access. `FileBrowser` carries no
   * mutating method for either, so an item here would have nothing to call.
   */
  test("a note offers only reading, addressing and taking a copy away", () => {
    // Download is here and nothing else new is: it is a **read**, and
    // non-negotiable #1 says the exit is never gated. The `download` block at
    // the end of this file is where that is argued.
    expect(ids(menu({ kind: "row", row: note("1-projects/plan.md") }, { canEdit: false }))).toEqual([
      "open",
      "copyPath",
      "copyAtPath",
      "download",
    ]);
  });

  test("a folder offers the same four", () => {
    expect(ids(menu({ kind: "row", row: dir("1-projects") }, { canEdit: false }))).toEqual([
      "open",
      "copyPath",
      "copyAtPath",
      "download",
    ]);
  });

  test("not one mutating item is present, disabled or otherwise", () => {
    const list = menu({ kind: "row", row: note("1-projects/plan.md") }, { canEdit: false });
    for (const id of MUTATING) expect(find(list, id)).toBeUndefined();
  });

  /** A clipboard someone else filled does not unlock a paste here. */
  test("a clipboard does not put paste back", () => {
    const list = menu(
      { kind: "background", folder: "1-projects" },
      { canEdit: false, clipboard: put("copy", "1-projects/plan.md") },
    );
    expect(list).toEqual([]);
  });

  test("empty space offers nothing at all, so no menu should open", () => {
    expect(menu({ kind: "background", folder: "" }, { canEdit: false })).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*                                 privacy.md                                 */
/* -------------------------------------------------------------------------- */

describe("privacy.md is generated, so it is read and located and nothing else", () => {
  const privacy = note("privacy.md", { readOnly: true });

  test("open and copy path, and not even an @path", () => {
    expect(ids(menu({ kind: "row", row: privacy }))).toEqual(["open", "copyPath"]);
  });

  test("it cannot be renamed, moved, given a visibility or deleted", () => {
    const list = menu({ kind: "row", row: privacy });
    for (const id of MUTATING) expect(find(list, id)).toBeUndefined();
    expect(find(list, "copy")).toBeUndefined();
  });

  /**
   * A partial "Archive 3 items" that archives two is worse than no item at
   * all, so one read-only row poisons the whole selection.
   */
  test("one read-only row takes the mutating items off a whole selection", () => {
    const list = menu({
      kind: "selection",
      rows: [note("1-projects/a.md"), note("1-projects/b.md"), privacy],
    });
    expect(ids(list)).toEqual(["copyPath"]);
    expect(labels(list)).toEqual(["Copy 3 paths"]);
  });
});

/* -------------------------------------------------------------------------- */
/*                             the ordinary menus                             */
/* -------------------------------------------------------------------------- */

describe("a note", () => {
  const list = menu({ kind: "row", row: note("1-projects/plan.md") });

  test("offers opening, rearranging, the clipboard, addresses, sharing, visibility and putting away", () => {
    expect(ids(list)).toEqual([
      "open",
      "openInNewTab",
      "rename",
      "duplicate",
      "moveTo",
      "copy",
      "cut",
      "copyPath",
      "copyAtPath",
      "download",
      "share",
      "visibility",
      "archive",
      "delete",
    ]);
  });

  /** Paste lands somewhere; a note is not somewhere. */
  test("never offers paste, even with a full clipboard", () => {
    const withClipboard = menu(
      { kind: "row", row: note("1-projects/plan.md") },
      { clipboard: put("copy", "2-areas/notes.md") },
    );
    expect(find(withClipboard, "paste")).toBeUndefined();
  });

  test("only deletion is marked dangerous", () => {
    expect(list.filter((entry) => entry.danger === true).map((entry) => entry.id)).toEqual([
      "delete",
    ]);
  });
});

describe("a folder", () => {
  const list = menu({ kind: "row", row: dir("1-projects") });

  /**
   * `copyEntry` and the clipboard both take folders, so a folder is copied and
   * cut exactly as a note is — and creating on a folder means creating inside
   * it, which is the whole of what "here" is doing in the label.
   */
  test("creates inside itself and is otherwise moved, copied and cut like a note", () => {
    expect(ids(list)).toEqual([
      "open",
      "newNote",
      "newDrawing",
      "newFolder",
      "rename",
      "duplicate",
      "moveTo",
      "copy",
      "cut",
      "copyPath",
      "copyAtPath",
      "download",
      "visibility",
      "archive",
      "delete",
    ]);
  });

  /** There is no document to put in a tab. */
  test("has no open in new tab", () => {
    expect(find(list, "openInNewTab")).toBeUndefined();
  });

  test("says where the new note goes", () => {
    expect(find(list, "newNote")?.label).toBe("New note here");
    expect(find(list, "newDrawing")?.label).toBe("New drawing here");
    expect(find(list, "newFolder")?.label).toBe("New folder here");
  });
});

describe("empty space", () => {
  const list = menu({ kind: "background", folder: "1-projects" });

  test("offers only the three creations", () => {
    // Drawing sits between them because it is a *file* like a note, and the
    // folder is the odd one out: it makes a place rather than a thing.
    expect(ids(list)).toEqual(["newNote", "newDrawing", "newFolder"]);
  });

  /** No "here": there is nowhere else it could mean. */
  test("needs no word for where", () => {
    expect(labels(list)).toEqual(["New note", "New drawing", "New folder"]);
  });
});

/* -------------------------------------------------------------------------- */
/*                                   paste                                    */
/* -------------------------------------------------------------------------- */

describe("paste appears only where something can land", () => {
  const clipboard = put("copy", "2-areas/handbook.md");

  test("nothing on the clipboard, no item", () => {
    expect(find(menu({ kind: "background", folder: "" }), "paste")).toBeUndefined();
    expect(find(menu({ kind: "row", row: dir("1-projects") }), "paste")).toBeUndefined();
  });

  test("the label names the thing rather than leaving it to memory", () => {
    const list = menu({ kind: "background", folder: "1-projects" }, { clipboard });
    expect(find(list, "paste")?.label).toBe("Paste handbook.md");
  });

  test("on a folder as well as on empty space", () => {
    const list = menu({ kind: "row", row: dir("1-projects") }, { clipboard });
    expect(find(list, "paste")?.label).toBe("Paste handbook.md");
  });

  test("not on a selection, which is not a destination", () => {
    const list = menu(
      { kind: "selection", rows: [note("1-projects/a.md"), note("1-projects/b.md")] },
      { clipboard },
    );
    expect(find(list, "paste")).toBeUndefined();
  });

  /**
   * `planPaste` refuses this whatever the destination listing says, so it is
   * not offered rather than offered and then refused. The collision cases do
   * need the listing and stay with `planPaste`.
   */
  test("not into the folder that is on the clipboard, nor below it", () => {
    const cutFolder = put("cut", "1-projects");
    expect(
      find(menu({ kind: "row", row: dir("1-projects") }, { clipboard: cutFolder }), "paste"),
    ).toBeUndefined();
    expect(
      find(menu({ kind: "row", row: dir("1-projects/plans") }, { clipboard: cutFolder }), "paste"),
    ).toBeUndefined();
    expect(
      find(menu({ kind: "background", folder: "1-projects" }, { clipboard: cutFolder }), "paste"),
    ).toBeUndefined();
    // A sibling is fine.
    expect(
      find(menu({ kind: "background", folder: "2-areas" }, { clipboard: cutFolder }), "paste"),
    ).toBeDefined();
  });
});
