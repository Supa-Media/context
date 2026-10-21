/**
 * The file menu for built-in folders found by job, and Move up / Move down.
 *
 * A built-in folder is known by the job on its listing entry (`jobOf`, from
 * `folderMenuFacts`), so an Inbox renamed Capture is still the Inbox: renamed
 * and moved like any folder, never archived or trashed, never given another
 * icon. Website moves like the rest. Every folder an editor may order
 * gets Move up and Move down, dimmed at the ends.
 *
 * SABOTAGE: drop `kept` from the trash branch in `menu.ts` → "Capture is
 * never put away" fails; drop the `first` check in `orderGroup` → "at the
 * top" fails; flip `descending` in `folderMenuFacts` → "Z to A" fails.
 */
import { describe, expect, test } from "@jest/globals";
import type { RowRole } from "@context/shared/src/folderRoles.cjs";
import { runMenuAction, type ActionContext } from "../../features/console/files/actions";
import type { FileBrowser } from "../../features/console/files/browser";
import { folderMenuFacts, rowJob } from "../../features/console/files/menuBuiltIn";
import type { FileEntry, FolderListing } from "../../features/console/files/types";
import { dir, find, ids, menu } from "./fixtures";

function entry(path: string, over: Partial<FileEntry> = {}): FileEntry {
  return {
    kind: "folder",
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    visibility: "private",
    inherited: "private",
    exception: false,
    readOnly: false,
    ...over,
  };
}

function listing(path: string, entries: FileEntry[]): FolderListing {
  return { path, folderDefault: "private", entries, truncated: false, manifestUsable: true };
}

/** A root whose Inbox is called Capture, Website, an own folder, and the Archive. */
const LISTINGS = {
  "": listing("", [
    entry("Capture", { role: "inbox" }),
    entry("1-projects", { role: "projects" }),
    entry("website", { role: "website" }),
    entry("Recipes"),
    entry("9-archive", { role: "archive" }),
    entry("todo.md", { kind: "file" }),
  ]),
  "1-projects": listing("1-projects", [entry("1-projects/launch")]),
};

const facts = (over: { moveFolder?: unknown } = { moveFolder: () => {} }, descending = false) =>
  folderMenuFacts({ listings: LISTINGS, ...over }, descending);

describe("a built-in folder known by its job", () => {
  test("rowJob reads the listing's job, and falls back to the name only where the listing is not known", () => {
    const context = facts();
    expect(rowJob(dir("Capture"), context)).toBe("inbox");
    expect(rowJob(dir("Recipes"), context)).toBeNull();
    // Not loaded: the name decides, the safe side.
    expect(rowJob(dir("2-areas/x"), context)).toBeNull();
    expect(rowJob(dir("0-inbox"), { jobOf: () => undefined })).toBe("inbox");
  });

  test("Capture is renamed and moved like any folder", () => {
    const list = menu({ kind: "row", row: dir("Capture") }, facts());
    for (const id of ["rename", "moveTo", "cut"] as const) expect(find(list, id)?.disabled).toBeUndefined();
  });

  test("Capture is never put away: Archive and trash dimmed, trash saying why", () => {
    const list = menu({ kind: "row", row: dir("Capture") }, facts());
    expect(find(list, "archive")?.disabled).toBe(true);
    expect(find(list, "delete")?.disabled).toBe(true);
    expect(find(list, "delete")?.detail).toMatch(/renamed or moved, but not deleted/);
  });

  test("no Set icon… on any folder with a job, extras and Website included", () => {
    for (const path of ["Capture", "website", "9-archive"]) {
      expect(ids(menu({ kind: "row", row: dir(path) }, facts()))).not.toContain("setIcon");
    }
    const clients = menu({ kind: "row", row: dir("Clients") }, { jobOf: (): RowRole => "clients" });
    expect(ids(clients)).not.toContain("setIcon");
    expect(ids(menu({ kind: "row", row: dir("Recipes") }, facts()))).toContain("setIcon");
  });

  test("an extra can be trashed: only the five main folders are kept", () => {
    const clients = menu({ kind: "row", row: dir("Clients") }, { jobOf: (): RowRole => "clients" });
    expect(find(clients, "delete")?.disabled).toBeUndefined();
  });

  test("Website is renamed and moved like the rest (its site follows it), trash offered", () => {
    const list = menu({ kind: "row", row: dir("website") }, facts());
    expect(find(list, "rename")?.disabled).toBeUndefined();
    expect(find(list, "moveTo")?.disabled).toBeUndefined();
    expect(find(list, "cut")?.disabled).toBeUndefined();
    expect(find(list, "delete")?.disabled).toBeUndefined();
  });

  test("the phone folder page's ••• renames and moves a built-in folder, and keeps it", () => {
    const page = menu({ kind: "page", row: dir("Capture") }, { ...facts(), platform: "touch" });
    expect(find(page, "rename")?.disabled).toBeUndefined();
    expect(find(page, "moveTo")?.disabled).toBeUndefined();
    expect(find(page, "archive")?.disabled).toBe(true);
    expect(find(page, "archive")?.label).toBe("Archive folder");
    expect(ids(page)).not.toContain("setIcon");
    const website = menu({ kind: "page", row: dir("website") }, { ...facts(), platform: "touch" });
    expect(find(website, "rename")?.disabled).toBeUndefined();
  });
});

describe("Move up and Move down", () => {
  test("offered on every folder an editor can order, beside Rename and Move", () => {
    const list = menu({ kind: "row", row: dir("Recipes") }, facts());
    const order = ids(list);
    expect(order.indexOf("moveUp")).toBe(order.indexOf("moveTo") + 1);
    expect(order.indexOf("moveDown")).toBe(order.indexOf("moveUp") + 1);
    expect(find(list, "moveUp")?.disabled).toBeUndefined();
    expect(find(list, "moveDown")?.disabled).toBeUndefined();
  });

  test("at the top, Move up is dimmed; at the bottom, Move down", () => {
    const top = menu({ kind: "row", row: dir("Capture") }, facts());
    expect(find(top, "moveUp")?.disabled).toBe(true);
    expect(find(top, "moveDown")?.disabled).toBeUndefined();
    const bottom = menu({ kind: "row", row: dir("9-archive") }, facts());
    expect(find(bottom, "moveUp")?.disabled).toBeUndefined();
    expect(find(bottom, "moveDown")?.disabled).toBe(true);
  });

  test("Z to A: the ends are the other way round, as drawn", () => {
    const top = menu({ kind: "row", row: dir("9-archive") }, facts(undefined, true));
    expect(find(top, "moveUp")?.disabled).toBe(true);
    expect(find(top, "moveDown")?.disabled).toBeUndefined();
  });

  test("a folder alone at its level, a note, a reader, a selection and a browser that cannot order get none", () => {
    expect(ids(menu({ kind: "row", row: dir("1-projects/launch") }, facts()))).not.toContain("moveUp");
    expect(ids(menu({ kind: "row", row: dir("todo.md") }, facts()))).not.toContain("moveUp");
    expect(ids(menu({ kind: "row", row: dir("Recipes") }, { ...facts(), canEdit: false }))).not.toContain("moveUp");
    expect(ids(menu({ kind: "selection", rows: [dir("Recipes"), dir("Capture")] }, facts()))).not.toContain("moveUp");
    expect(ids(menu({ kind: "row", row: dir("Recipes") }, facts({})))).not.toContain("moveUp");
  });

  test("the phone folder page's ••• offers them too", () => {
    const page = menu({ kind: "page", row: dir("Recipes") }, { ...facts(), platform: "touch" });
    expect(ids(page)).toEqual(expect.arrayContaining(["moveUp", "moveDown"]));
  });

  test("choosing one moves that folder through the browser", () => {
    const calls: [string, string][] = [];
    const context = {
      files: { moveFolder: (path: string, direction: string) => calls.push([path, direction]) } as unknown as FileBrowser,
      contextLabel: "@seyi",
      select: () => {},
      setDialog: () => {},
      writeClipboard: () => {},
      inheritedOf: () => "private",
    } as ActionContext;
    runMenuAction("moveUp", { kind: "row", row: dir("Recipes") }, context);
    runMenuAction("moveDown", { kind: "page", row: dir("Capture") }, context);
    expect(calls).toEqual([
      ["Recipes", "up"],
      ["Capture", "down"],
    ]);
  });
});
