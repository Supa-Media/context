/**
 * Board 16's buttons over rows picked on a phone's folder page: which are
 * offered, and what Pin does to several rows and to its Undo.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. Move and Archive offered whatever `menu.ts` says. → "Move and Archive only where the tree's selection menu has them"
 *  2. Tags offered for a drawing alone.                  → "Tags only for notes and folders, and only where tags can be written"
 *  3. Pin re-pinning rows already on Home.               → "Pin puts on Home only the rows not there, and Undo takes off only those"
 *  4. Undo toggling instead of setting.                  → "Pin puts on Home only the rows not there, and Undo takes off only those"
 */

import { describe, expect, test } from "@jest/globals";
import { bulkActions } from "../features/console/files/bulkActions";
import type { FileEntry } from "../features/console/files/types";

const entry = (path: string, kind: "file" | "folder" = "file") =>
  ({ path, name: path.slice(path.lastIndexOf("/") + 1), kind, visibility: "private" }) as unknown as FileEntry;

const base = {
  offered: new Set<string>(),
  run: () => {},
  isPinned: () => false,
  say: () => {},
  more: () => {},
};

describe("the picked rows' bar", () => {
  test("Move and Archive only where the tree's selection menu has them", () => {
    const ran: string[] = [];
    const both = bulkActions({ ...base, entries: [entry("a.md")], offered: new Set(["moveTo", "archive"]), run: (id) => ran.push(id) });
    both.move!();
    both.archive!();
    expect(ran).toEqual(["moveTo", "archive"]);
    const restoreOnly = bulkActions({ ...base, entries: [entry("4-archive/x/a.md")], offered: new Set(["restore"]) });
    expect(restoreOnly.move).toBeUndefined();
    expect(restoreOnly.archive).toBeUndefined();
  });

  test("Tags only for notes and folders, and only where tags can be written", () => {
    const tags = () => {};
    expect(bulkActions({ ...base, entries: [entry("a.md")], tags }).tags).toBe(tags);
    expect(bulkActions({ ...base, entries: [entry("clients", "folder")], tags }).tags).toBe(tags);
    expect(bulkActions({ ...base, entries: [entry("sketch.excalidraw")], tags }).tags).toBeUndefined();
    expect(bulkActions({ ...base, entries: [entry("a.md")] }).tags).toBeUndefined();
  });

  test("Pin puts on Home only the rows not there, and Undo takes off only those", () => {
    const pinned = new Set(["b.md"]);
    const calls: string[] = [];
    let undo: (() => void) | undefined;
    let said = "";
    const actions = bulkActions({
      ...base,
      entries: [entry("a.md"), entry("b.md"), entry("clients", "folder")],
      isPinned: (path) => pinned.has(path),
      setPin: (path, kind, on) => calls.push(`${on ? "pin" : "unpin"} ${kind} ${path}`),
      say: (message, back) => {
        said = message;
        undo = back;
      },
    });
    expect(actions.pin?.pinned).toBe(false);
    actions.pin!.run();
    expect(calls).toEqual(["pin note a.md", "pin folder clients"]);
    expect(said).toBe("Pinned 2 items to Home.");
    calls.length = 0;
    undo!();
    expect(calls).toEqual(["unpin note a.md", "unpin folder clients"]);
  });

  test("with every row on Home already, Pin unpins them all", () => {
    const calls: string[] = [];
    let said = "";
    const actions = bulkActions({
      ...base,
      entries: [entry("a.md"), entry("b.md")],
      isPinned: () => true,
      setPin: (path, _kind, on) => calls.push(`${on ? "pin" : "unpin"} ${path}`),
      say: (message) => {
        said = message;
      },
    });
    expect(actions.pin?.pinned).toBe(true);
    actions.pin!.run();
    expect(calls).toEqual(["unpin a.md", "unpin b.md"]);
    expect(said).toBe("Unpinned 2 items from Home.");
  });

  test("no Pin where there is no Home to pin to", () => {
    expect(bulkActions({ ...base, entries: [entry("a.md")] }).pin).toBeUndefined();
  });
});
