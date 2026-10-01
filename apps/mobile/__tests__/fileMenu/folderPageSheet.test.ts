import { describe, expect, test } from "@jest/globals";
import { dir, ids, labels, menu } from "./fixtures";
import { actionTargetOf, runMenuAction } from "../../features/console/files/actions";

/**
 * The ••• on a phone's folder page (board 08 of the phone Home artboards,
 * approved 2026-09-30): what you do to the folder you are standing in, in the
 * board's order. Make things inside it, then Rename, Move, Pin, who can see
 * it, and Archive last. No Open (you are in it), no Duplicate, Copy, Cut or
 * addresses (a row's clipboard verbs), and no trash: a folder page puts a
 * folder away, it does not delete it.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. `itemsFor` sending a page to the row menu.   → "the board's verbs, in the board's order"
 *  2. `pageItems` dropping its `canEdit` branch.   → "a reader gets only what writes nothing"
 *  3. `actionTargetOf` without a `page` arm.        → "acts on the folder itself"
 *  4. `tagsGroup` without the tags as its value.     → "Tags sits after Pin, saying the folder's tags"
 *  5. Select notes offered without `selectable`.     → "Select notes, only where the page can pick rows"
 *  6. `runMenuAction` dropping the `tags` arm.        → "Tags opens the folder's Tags sheet; Select notes asks the page"
 */
describe("a phone folder page's ••• sheet", () => {
  const page = (path = "clients") => ({ kind: "page" as const, row: dir(path) });
  const pins = { pinned: () => false, platform: "touch" as const };

  test("the board's verbs, in the board's order", () => {
    const sheet = menu(page(), pins);
    expect(ids(sheet).filter((id) => id !== "visibility")).toEqual([
      "newNote",
      "newFolder",
      "rename",
      "moveTo",
      "pin",
      "download",
      "archive",
    ]);
    expect(labels(sheet)).toEqual(
      expect.arrayContaining(["New note", "New folder inside", "Rename…", "Move to…", "Pin to Home", "Share", "Archive folder"]),
    );
    expect(ids(sheet)).not.toEqual(expect.arrayContaining(["open"]));
    for (const gone of ["open", "duplicate", "copy", "cut", "copyPath", "copyAtPath", "delete", "newDrawing"]) {
      expect(ids(sheet)).not.toContain(gone);
    }
  });

  test("who can see it sits between Pin and Archive, for someone who may set it", () => {
    const sheet = ids(menu(page(), pins));
    const at = sheet.indexOf("visibility");
    expect(at).toBeGreaterThan(sheet.indexOf("pin"));
    expect(at).toBeLessThan(sheet.indexOf("archive"));
    expect(ids(menu(page(), { ...pins, canSetVisibility: false }))).not.toContain("visibility");
  });

  test("a folder already put away offers Restore instead", () => {
    const sheet = ids(menu(page("4-archive/2026-09-30T10-00-00-000Z/clients"), pins));
    expect(sheet).toContain("restore");
    expect(sheet).not.toContain("archive");
  });

  test("a reader gets only what writes nothing", () => {
    expect(ids(menu(page(), { ...pins, canEdit: false }))).toEqual(["pin", "download"]);
  });

  test("acts on the folder itself", () => {
    expect(actionTargetOf(page("clients/acme"))).toEqual({ path: "clients/acme", folder: "clients/acme", kind: "folder" });
  });
});

describe("Tags and Select notes on a phone folder page (boards 14 and 16)", () => {
  const page = (path = "clients") => ({ kind: "page" as const, row: dir(path) });
  const phone = { pinned: () => false, platform: "touch" as const };

  test("Tags sits after Pin, saying the folder's tags", () => {
    const sheet = menu(page(), { ...phone, tagsOf: () => ["client", "retainer"] });
    const order = ids(sheet).filter((id) => id !== "visibility");
    expect(order.slice(0, 6)).toEqual(["newNote", "newFolder", "rename", "moveTo", "pin", "tags"]);
    expect(sheet.find((item) => item.id === "tags")).toMatchObject({ label: "Tags", value: "client, retainer" });
    // No tags yet: the row, with nothing beside it.
    expect(menu(page(), { ...phone, tagsOf: () => [] }).find((item) => item.id === "tags")?.value).toBeUndefined();
    // Where they cannot be changed from here, no row at all.
    expect(ids(menu(page(), { ...phone, tagsOf: () => null }))).not.toContain("tags");
    expect(ids(menu(page(), phone))).not.toContain("tags");
  });

  test("Select notes, only where the page can pick rows", () => {
    const sheet = ids(menu(page(), { ...phone, selectable: true }));
    expect(sheet).toContain("selectNotes");
    expect(sheet.indexOf("selectNotes")).toBeGreaterThan(sheet.indexOf("pin"));
    expect(sheet.indexOf("selectNotes")).toBeLessThan(sheet.indexOf("archive"));
    expect(ids(menu(page(), phone))).not.toContain("selectNotes");
  });

  test("Tags opens the folder's Tags sheet; Select notes asks the page", () => {
    const dialogs: unknown[] = [];
    const asked: string[] = [];
    const context = {
      files: {} as never,
      contextLabel: "Northwind",
      select: () => {},
      setDialog: (dialog: unknown) => dialogs.push(dialog),
      writeClipboard: () => {},
      inheritedOf: () => "private" as const,
      startSelect: (folder: string) => asked.push(folder),
    };
    runMenuAction("tags", page("clients/acme"), context as never);
    runMenuAction("selectNotes", page("clients/acme"), context as never);
    expect(dialogs).toEqual([{ kind: "tags", folder: "clients/acme" }]);
    expect(asked).toEqual(["clients/acme"]);
  });
});
