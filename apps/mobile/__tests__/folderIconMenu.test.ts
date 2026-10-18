/**
 * "Set icon…" in the file menu, and what it does when chosen.
 *
 * Offered for a folder or note an editor can change, on the tree's menu and on a
 * phone's folder page alike, and for no other file, no read-only row and no
 * console that cannot edit. Not built-in folders, since 2026-10-18: their job's
 * drawn icon is the point (board 9), so they cannot take another.
 */

import { describe, expect, test } from "@jest/globals";
import { actionTargetOf, runMenuAction, type ActionContext, type Dialog } from "../features/console/files/actions";
import type { FileBrowser } from "../features/console/files/browser";
import { isBuiltInRow } from "../features/console/files/menuBuiltIn";
import { dir, find, ids, menu, note, row } from "./fileMenu/fixtures";

describe("Set icon… is offered for a folder an editor can change", () => {
  test("a folder row, for an editor", () => {
    const item = find(menu({ kind: "row", row: dir("1-projects/launch") }), "setIcon");
    expect(item?.label).toBe("Set icon…");
  });

  test("not a built-in folder: its job's drawn icon is the point", () => {
    const builtIn = dir("1-projects");
    expect(isBuiltInRow(builtIn)).toBe(true);
    expect(ids(menu({ kind: "row", row: builtIn }))).not.toContain("setIcon");
    expect(ids(menu({ kind: "page", row: builtIn }))).not.toContain("setIcon");
  });

  test("a renamed built-in folder neither, known by the job on its listing entry", () => {
    const jobOf = (path: string) => (path === "Capture" ? ("inbox" as const) : null);
    expect(ids(menu({ kind: "row", row: dir("Capture") }, { jobOf }))).not.toContain("setIcon");
    // A folder named like a job that does not do it is somebody's own.
    expect(ids(menu({ kind: "row", row: dir("1-projects") }, { jobOf }))).toContain("setIcon");
  });

  test("a note can have one too (2026-10-13)", () => {
    expect(ids(menu({ kind: "row", row: note("1-projects/plan.md") }))).toContain("setIcon");
  });

  test("a file that is not a note has none", () => {
    expect(ids(menu({ kind: "row", row: note("1-projects/photo.png") }))).not.toContain("setIcon");
  });

  test("a note on a console that cannot edit has none", () => {
    expect(ids(menu({ kind: "row", row: note("1-projects/plan.md") }, { canEdit: false }))).not.toContain("setIcon");
  });

  test("a read-only row, such as privacy.md, has none", () => {
    expect(ids(menu({ kind: "row", row: note("privacy.md", { readOnly: true }) }))).not.toContain("setIcon");
  });

  test("a console that cannot edit is offered nothing for a folder: absent, not disabled", () => {
    const list = menu({ kind: "row", row: dir("1-projects") }, { canEdit: false });
    expect(ids(list)).not.toContain("setIcon");
  });

  test("a multi-selection of folders is not a bulk icon: no item", () => {
    const list = menu({ kind: "selection", rows: [dir("1-projects"), dir("2-areas")] });
    expect(ids(list)).not.toContain("setIcon");
  });

  test("the phone folder page's ••• offers it for a folder an editor can change", () => {
    const list = menu({ kind: "page", row: dir("1-projects/launch") });
    expect(ids(list)).toContain("setIcon");
  });

  test("the phone folder page's ••• does not, for a console that cannot edit", () => {
    const list = menu({ kind: "page", row: dir("1-projects") }, { canEdit: false });
    expect(ids(list)).not.toContain("setIcon");
  });

  test("the breadcrumb and the background do not offer it: they are not a folder's row", () => {
    expect(ids(menu({ kind: "crumb", folder: "1-projects" }))).not.toContain("setIcon");
    expect(ids(menu({ kind: "background", folder: "1-projects" }))).not.toContain("setIcon");
  });
});

describe("choosing Set icon… opens the folder's dialog", () => {
  function harness() {
    const dialogs: Dialog[] = [];
    const context = {
      files: {} as FileBrowser,
      contextLabel: "@seyi",
      select: () => {},
      setDialog: (dialog: Dialog) => dialogs.push(dialog),
      writeClipboard: () => {},
      inheritedOf: () => "private",
    } as ActionContext;
    return { dialogs, context };
  }

  test("a folder row opens the icon dialog for that folder", () => {
    const h = harness();
    runMenuAction("setIcon", { kind: "row", row: dir("2-areas/cooking") }, h.context);
    expect(h.dialogs).toEqual([{ kind: "folderIcon", path: "2-areas/cooking" }]);
  });

  test("a phone folder page's ••• opens the same dialog for the folder it shows", () => {
    const h = harness();
    runMenuAction("setIcon", { kind: "page", row: dir("2-areas/cooking") }, h.context);
    expect(h.dialogs).toEqual([{ kind: "folderIcon", path: "2-areas/cooking" }]);
  });

  test("a note opens the same dialog for that note", () => {
    const h = harness();
    runMenuAction("setIcon", { kind: "row", row: note("2-areas/plan.md") }, h.context);
    expect(h.dialogs).toEqual([{ kind: "folderIcon", path: "2-areas/plan.md" }]);
  });

  test("the action target of a folder is the folder itself", () => {
    expect(actionTargetOf({ kind: "row", row: row("folder", "2-areas/cooking") })).toEqual({
      path: "2-areas/cooking",
      folder: "2-areas/cooking",
      kind: "folder",
    });
  });
});
