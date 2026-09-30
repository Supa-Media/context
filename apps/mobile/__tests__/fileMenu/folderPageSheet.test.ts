import { describe, expect, test } from "@jest/globals";
import { dir, ids, labels, menu } from "./fixtures";
import { actionTargetOf } from "../../features/console/files/actions";

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
