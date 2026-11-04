/**
 * A folder's Sort submenu (`features/console/files/menuSort.ts`; owner,
 * 2026-11-04, `docs/decisions/app-and-console/folder-sort.md`): the seven
 * ways to sort, no size, the one drawn ticked, "Apply to folders inside"
 * unless the folder is in custom order, and none of it for a note or a
 * reader. Choosing one goes through `setFolderSort`.
 *
 * SABOTAGE: drop the custom check before `sortInside` → "custom order has
 * nothing to apply inside" fails. A reader is refused twice, in `sortGroup`
 * and in `entryItems`' early return, so dropping either alone stays green.
 */
import { describe, expect, test } from "@jest/globals";
import { runMenuAction, type ActionContext } from "../../features/console/files/actions";
import type { FileBrowser } from "../../features/console/files/browser";
import type { MenuItem } from "../../features/console/files/menuItem";
import { dir, find, ids, menu, note } from "./fixtures";

const sortOf = (drawn: string | null) => () => ({ drawn: drawn as never });
const sub = (list: MenuItem[]): MenuItem[] => (find(list, "sort") as { items?: MenuItem[] } | undefined)?.items ?? [];

describe("a folder's Sort menu", () => {
  test("the seven ways, the one drawn ticked, and Apply to folders inside", () => {
    const items = sub(menu({ kind: "row", row: dir("Projects") }, { sortOf: sortOf("edited-desc") }));
    expect(items.map((item) => item.label)).toEqual([
      "Custom order",
      "Name, A to Z",
      "Name, Z to A",
      "Edited, newest first",
      "Edited, oldest first",
      "Created, newest first",
      "Created, oldest first",
      "Apply to folders inside",
    ]);
    expect(items.filter((item) => item.checked === true).map((item) => item.id)).toEqual(["sortEditedDesc"]);
  });

  test("a folder with no setting anywhere draws by name, so Name, A to Z is ticked", () => {
    const items = sub(menu({ kind: "row", row: dir("Projects") }, { sortOf: sortOf(null) }));
    expect(find(items, "sortNameAsc")?.checked).toBe(true);
  });

  test("custom order has nothing to apply inside", () => {
    const items = sub(menu({ kind: "row", row: dir("Projects") }, { sortOf: sortOf("custom") }));
    expect(ids(items)).not.toContain("sortInside");
  });

  test("a note, a reader, and a console that cannot write get no Sort", () => {
    expect(ids(menu({ kind: "row", row: note("Projects/a.md") }, { sortOf: sortOf(null) }))).not.toContain("sort");
    expect(ids(menu({ kind: "row", row: dir("Projects") }, { sortOf: sortOf(null), canEdit: false }))).not.toContain("sort");
    expect(ids(menu({ kind: "row", row: dir("Projects") }, {}))).not.toContain("sort");
  });

  test("choosing one sets the folder's sort; Apply to folders inside keeps the drawn one", () => {
    const calls: unknown[][] = [];
    const context = {
      files: { setFolderSort: (...args: unknown[]) => calls.push(args) } as unknown as FileBrowser,
      contextLabel: "@somebody",
      select: () => {},
      setDialog: () => {},
      writeClipboard: () => {},
      inheritedOf: () => "private",
    } as ActionContext;
    runMenuAction("sortCreatedAsc", { kind: "row", row: dir("Projects") }, context);
    runMenuAction("sortInside", { kind: "row", row: dir("Projects") }, context);
    expect(calls).toEqual([
      ["Projects", "created-asc"],
      ["Projects", undefined, true],
    ]);
  });
});
