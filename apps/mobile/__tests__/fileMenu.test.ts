/**
 * The file action menu, without a renderer.
 *
 * `features/console/files/menu.ts` is the one list of items behind both the
 * web context menu and the mobile action sheet, which is what makes the rules
 * below testable at all. Written inside a component they would be two `&&`
 * expressions in two files that nobody would ever compare.
 *
 * Three of them are the point:
 *
 *  - a console that cannot edit is offered *fewer items*, not disabled ones;
 *  - `privacy.md` is generated, so almost nothing may be done to it;
 *  - a multi-selection is a different menu, and every label says how many
 *    things it is about to touch.
 *
 * The separator tests look pedantic and are not: a menu whose items appear and
 * disappear (no clipboard, no `openInNewTab` on touch, no mutations for a
 * `member`) grows a leading rule or a double rule the first time a group
 * empties, and that is the bug that ships.
 */

import { describe, expect, test } from "@jest/globals";
import {
  itemsFor,
  joinGroups,
  type MenuActionId,
  type MenuContext,
  type MenuItem,
  type MenuTarget,
} from "../features/console/files/menu";
import { put } from "../features/console/files/clipboard";
import type { TreeRow } from "../features/console/files/tree";

/* -------------------------------------------------------------------------- */
/*                                  fixtures                                  */
/* -------------------------------------------------------------------------- */

function row(kind: TreeRow["kind"], path: string, over: Partial<TreeRow> = {}): TreeRow {
  return {
    kind,
    key: path,
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    depth: 0,
    expanded: false,
    selected: false,
    markerIsDefault: kind === "folder",
    readOnly: false,
    ...over,
  };
}

const note = (path: string, over: Partial<TreeRow> = {}) => row("file", path, over);
const dir = (path: string, over: Partial<TreeRow> = {}) => row("folder", path, over);

/** Everything a menu could be about, with the permissive defaults. */
function menu(target: MenuTarget, over: Partial<Omit<MenuContext, "target">> = {}): MenuItem[] {
  const context: MenuContext = {
    target,
    canEdit: true,
    clipboard: null,
    platform: "web",
    ...over,
  };
  return itemsFor(context);
}

const ids = (list: MenuItem[]): MenuActionId[] => list.map((entry) => entry.id);
const labels = (list: MenuItem[]): string[] => list.map((entry) => entry.label);

function find(list: MenuItem[], id: MenuActionId): MenuItem | undefined {
  return list.find((entry) => entry.id === id);
}

const MUTATING: MenuActionId[] = [
  "newNote",
  "newFolder",
  "rename",
  "duplicate",
  "moveTo",
  "cut",
  "paste",
  "visibility",
  "visibilityPrivate",
  "visibilityTeam",
  "visibilityFollow",
  "archive",
  "restore",
  "delete",
];

/* -------------------------------------------------------------------------- */
/*                        a console that cannot edit                          */
/* -------------------------------------------------------------------------- */

describe("read-only means absent, not disabled", () => {
  /**
   * The landing page runs the real console against literals, and a workspace
   * `member` has read access without write access. `FileBrowser` carries no
   * mutating method for either, so an item here would have nothing to call.
   */
  test("a note offers only reading and addressing", () => {
    expect(ids(menu({ kind: "row", row: note("1-projects/plan.md") }, { canEdit: false }))).toEqual([
      "open",
      "copyPath",
      "copyAtPath",
    ]);
  });

  test("a folder offers the same three", () => {
    expect(ids(menu({ kind: "row", row: dir("1-projects") }, { canEdit: false }))).toEqual([
      "open",
      "copyPath",
      "copyAtPath",
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

  test("offers opening, rearranging, the clipboard, addresses, visibility and putting away", () => {
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
      "newFolder",
      "rename",
      "duplicate",
      "moveTo",
      "copy",
      "cut",
      "copyPath",
      "copyAtPath",
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
    expect(find(list, "newFolder")?.label).toBe("New folder here");
  });
});

describe("empty space", () => {
  const list = menu({ kind: "background", folder: "1-projects" });

  test("offers only the two creations", () => {
    expect(ids(list)).toEqual(["newNote", "newFolder"]);
  });

  /** No "here": there is nowhere else it could mean. */
  test("needs no word for where", () => {
    expect(labels(list)).toEqual(["New note", "New folder"]);
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

/* -------------------------------------------------------------------------- */
/*                                 visibility                                 */
/* -------------------------------------------------------------------------- */

describe("the visibility submenu", () => {
  /**
   * "Follow folder" removes the file's exact-note exception rather than
   * writing a value, which is the only way back to tracking the folder.
   */
  test("a note gets three: private, team, follow folder", () => {
    const submenu = find(menu({ kind: "row", row: note("1-projects/plan.md") }), "visibility");
    expect(submenu?.label).toBe("Visibility");
    expect(labels(submenu?.items ?? [])).toEqual(["Private", "Team", "Follow folder"]);
    expect(ids(submenu?.items ?? [])).toEqual([
      "visibilityPrivate",
      "visibilityTeam",
      "visibilityFollow",
    ]);
  });

  /** A folder's default *is* the value being set; there is no outer default. */
  test("a folder gets two, because it has no folder to follow", () => {
    const submenu = find(menu({ kind: "row", row: dir("1-projects") }), "visibility");
    expect(labels(submenu?.items ?? [])).toEqual(["Private", "Team"]);
  });

  test("the parent carries an id no dispatcher can mistake for an action", () => {
    const submenu = find(menu({ kind: "row", row: note("1-projects/plan.md") }), "visibility");
    expect(submenu?.id).toBe("visibility");
  });

  test("only one level deep", () => {
    const submenu = find(menu({ kind: "row", row: note("1-projects/plan.md") }), "visibility");
    for (const child of submenu?.items ?? []) expect(child.items).toBeUndefined();
  });

  test("a uniform selection still gets one", () => {
    const files = menu({
      kind: "selection",
      rows: [note("1-projects/a.md"), note("1-projects/b.md")],
    });
    expect(labels(find(files, "visibility")?.items ?? [])).toEqual([
      "Private",
      "Team",
      "Follow folder",
    ]);
    const folders = menu({ kind: "selection", rows: [dir("1-projects"), dir("2-areas")] });
    expect(labels(find(folders, "visibility")?.items ?? [])).toEqual(["Private", "Team"]);
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
    expect(find(three, "copy")?.label).toBe("Copy 3 items");
    expect(find(three, "cut")?.label).toBe("Cut 3 items");
    expect(find(three, "copyPath")?.label).toBe("Copy 3 paths");
    expect(find(three, "archive")?.label).toBe("Archive 3 items");
    expect(find(three, "delete")?.label).toBe("Delete 3 items forever…");
  });

  test("the whole list, in order", () => {
    expect(ids(three)).toEqual([
      "moveTo",
      "copy",
      "cut",
      "copyPath",
      "visibility",
      "archive",
      "delete",
    ]);
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

describe("labels say what happens, and an ellipsis promises it asks first", () => {
  const list = menu({ kind: "row", row: note("1-projects/plan.md") });

  test("deletion is permanent and says so, with the ellipsis that confirms it", () => {
    expect(find(list, "delete")?.label).toBe("Delete forever…");
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

/* -------------------------------------------------------------------------- */
/*                                 shortcuts                                  */
/* -------------------------------------------------------------------------- */

describe("shortcuts are printed on the web and absent on touch", () => {
  test("the web menu prints the ones the console binds", () => {
    const file = menu({ kind: "row", row: note("1-projects/plan.md") });
    expect(find(file, "rename")?.shortcut).toBe("F2");
    expect(find(file, "duplicate")?.shortcut).toBe("⌘D");
    expect(find(file, "moveTo")?.shortcut).toBe("⌘⇧M");
    expect(find(file, "copy")?.shortcut).toBe("⌘C");
    expect(find(file, "cut")?.shortcut).toBe("⌘X");
    expect(find(file, "copyPath")?.shortcut).toBe("⌘⇧C");
    expect(find(file, "archive")?.shortcut).toBe("⌘⌫");
    expect(find(file, "delete")?.shortcut).toBe("⌘⇧⌫");

    const folder = menu(
      { kind: "row", row: dir("1-projects") },
      { clipboard: put("copy", "2-areas/handbook.md") },
    );
    expect(find(folder, "newNote")?.shortcut).toBe("⌘N");
    expect(find(folder, "newFolder")?.shortcut).toBe("⌘⇧N");
    expect(find(folder, "paste")?.shortcut).toBe("⌘V");
  });

  /**
   * Omitted, not `undefined`: a sheet that reserves a column for a key
   * combination nobody can type has given up part of a phone's width to
   * decoration.
   */
  test("touch has no key column at all", () => {
    const list = menu(
      { kind: "row", row: dir("1-projects") },
      { platform: "touch", clipboard: put("copy", "2-areas/handbook.md") },
    );
    for (const entry of list) {
      expect(Object.prototype.hasOwnProperty.call(entry, "shortcut")).toBe(false);
      for (const child of entry.items ?? []) {
        expect(Object.prototype.hasOwnProperty.call(child, "shortcut")).toBe(false);
      }
    }
  });

  /** Touch has a tab switcher, not a pointer with a middle button. */
  test("touch has no open in new tab", () => {
    const list = menu({ kind: "row", row: note("1-projects/plan.md") }, { platform: "touch" });
    expect(find(list, "openInNewTab")).toBeUndefined();
    expect(find(list, "open")).toBeDefined();
  });

  test("otherwise the two platforms offer the same actions", () => {
    const web = ids(menu({ kind: "row", row: dir("1-projects") }));
    const touch = ids(menu({ kind: "row", row: dir("1-projects") }, { platform: "touch" }));
    expect(touch).toEqual(web);
  });
});

/* -------------------------------------------------------------------------- */
/*                                 separators                                 */
/* -------------------------------------------------------------------------- */

const a: MenuItem = { id: "open", label: "Open" };
const b: MenuItem = { id: "rename", label: "Rename…" };
const c: MenuItem = { id: "delete", label: "Delete forever…" };

describe("separators come from grouping, so the empty-group bugs cannot happen", () => {
  test("a rule between the groups that survived", () => {
    const list = joinGroups([[a], [b], [c]]);
    expect(list.map((entry) => entry.separatorBefore)).toEqual([undefined, true, true]);
  });

  test("an empty group in the middle does not leave two rules", () => {
    const list = joinGroups([[a], [], [b]]);
    expect(list.map((entry) => entry.id)).toEqual(["open", "rename"]);
    expect(list.map((entry) => entry.separatorBefore)).toEqual([undefined, true]);
  });

  test("an empty first group does not leave a rule above the first item", () => {
    const list = joinGroups([[], [a, b]]);
    expect(list[0].separatorBefore).toBeUndefined();
    expect(list[1].separatorBefore).toBeUndefined();
  });

  test("an empty last group cannot leave a rule under the bottom item", () => {
    const list = joinGroups([[a], []]);
    expect(list).toHaveLength(1);
    expect(list[0].separatorBefore).toBeUndefined();
  });

  test("every group empty is an empty menu", () => {
    expect(joinGroups([[], [], []])).toEqual([]);
  });

  test("a separator smuggled in on an item is dropped", () => {
    const list = joinGroups([[{ ...a, separatorBefore: true }, { ...b, separatorBefore: true }]]);
    for (const entry of list) {
      expect(Object.prototype.hasOwnProperty.call(entry, "separatorBefore")).toBe(false);
    }
  });

  test("the inputs are not mutated", () => {
    const group = [a];
    joinGroups([[b], group]);
    expect(a.separatorBefore).toBeUndefined();
    expect(group[0]).toBe(a);
  });

  /**
   * The property, over every menu this module can produce: no menu ever opens
   * with a rule, and nothing carries a `separatorBefore` that is neither true
   * nor absent.
   */
  test("no menu anywhere starts with a separator", () => {
    const targets: MenuTarget[] = [
      { kind: "background", folder: "" },
      { kind: "background", folder: "1-projects" },
      { kind: "row", row: note("1-projects/plan.md") },
      { kind: "row", row: dir("1-projects") },
      { kind: "row", row: note("privacy.md", { readOnly: true }) },
      { kind: "row", row: note("4-archive/2026-08-26T09-14-02-113Z/1-projects/plan.md") },
      { kind: "selection", rows: [note("1-projects/a.md"), note("1-projects/b.md")] },
      { kind: "selection", rows: [dir("1-projects"), note("2-areas/a.md")] },
    ];
    for (const target of targets) {
      for (const platform of ["web", "touch"] as const) {
        for (const canEdit of [true, false]) {
          for (const clipboard of [null, put("copy", "2-areas/handbook.md")]) {
            const list = itemsFor({ target, platform, canEdit, clipboard });
            if (list.length === 0) continue;
            expect(list[0].separatorBefore).toBeUndefined();
            for (const entry of list) {
              if (Object.prototype.hasOwnProperty.call(entry, "separatorBefore")) {
                expect(entry.separatorBefore).toBe(true);
              }
            }
          }
        }
      }
    }
  });
});
