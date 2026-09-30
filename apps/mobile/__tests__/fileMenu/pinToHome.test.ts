import { describe, expect, test } from "@jest/globals";
import { dir, ids, labels, menu, note } from "./fixtures";
import { runMenuAction, type ActionContext } from "../../features/console/files/actions";
import type { FileBrowser } from "../../features/console/files/browser";

/**
 * "Pin to Home" (board 08 of the phone Home artboards, 2026-09-30): offered on
 * one note or folder where there is a Home to pin to, and to a reader too,
 * because a pin is the person's own and writes nothing in the workspace.
 */
describe("Pin to Home in the menu", () => {
  const pinned = (paths: string[]) => (path: string) => paths.includes(path);

  test("absent where there is no Home to pin to", () => {
    expect(ids(menu({ kind: "row", row: dir("clients") }))).not.toContain("pin");
  });

  test("a folder or a note offers Pin, or Unpin once it is pinned", () => {
    expect(labels(menu({ kind: "row", row: dir("clients") }, { pinned: pinned([]) }))).toContain("Pin to Home");
    expect(labels(menu({ kind: "row", row: note("clients/a.md") }, { pinned: pinned(["clients/a.md"]) }))).toContain(
      "Unpin from Home",
    );
  });

  test("a reader can pin, since a pin writes nothing in the workspace", () => {
    expect(ids(menu({ kind: "row", row: dir("clients") }, { canEdit: false, pinned: pinned([]) }))).toContain("pin");
  });

  test("a selection of several is not pinned as one", () => {
    const rows = [note("a.md"), note("b.md")];
    expect(ids(menu({ kind: "selection", rows }, { pinned: pinned([]) }))).not.toContain("pin");
  });
});

describe("Pin to Home, dispatched", () => {
  test("pins the row as what it is", () => {
    const toggled: [string, string][] = [];
    const context: ActionContext = {
      files: {} as FileBrowser,
      contextLabel: "@seyi",
      select: () => {},
      setDialog: () => {},
      writeClipboard: () => {},
      inheritedOf: () => "team",
      togglePin: (path, kind) => toggled.push([path, kind]),
    };
    runMenuAction("pin", { kind: "row", row: dir("clients") }, context);
    runMenuAction("unpin", { kind: "row", row: note("clients/a.md") }, context);
    expect(toggled).toEqual([
      ["clients", "folder"],
      ["clients/a.md", "note"],
    ]);
  });
});
