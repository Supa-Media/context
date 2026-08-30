import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ROW_COMMANDS,
  applyRowIntent,
  intentForRowCommand,
  type RowCommand,
  type RowIntent,
} from "../features/console/files/rowCommand";
import { itemsFor, type MenuItem } from "../features/console/files/menu";
import type { TreeRow } from "../features/console/files/tree";
import type { FolderListing } from "../features/console/files/types";

/**
 * **Every chord the row menu prints, something answers.**
 *
 * `menu.ts` states that contract for itself and delivers half of it: it routes
 * each shortcut through `describeBinding`, so a printed chord is one that
 * exists in `BINDINGS`. Nothing checked the other half. The console's keyboard
 * handler answered these ten commands with `return false` under a comment
 * saying "`Explorer` binds them itself", and `Explorer` has no keyboard handler
 * at all — so `F2`, `⌘D`, `⌘⇧M`, `⌘C`, `⌘X`, `⌘V`, `⌘⌫` and `⌘⇧⌫` were printed
 * beside rows they did nothing to.
 *
 * That is the same shape as the other lies this app has been carrying: a
 * comment thorough enough that a reader stops looking. The tests here are what
 * the comment was standing in for.
 */

function row(path: string, kind: "file" | "folder", readOnly = false): TreeRow {
  return {
    id: path,
    path,
    name: path.split("/").pop()!,
    kind,
    depth: 0,
    expanded: false,
    visibility: "private",
    inherited: "private",
    exception: false,
    readOnly,
  } as unknown as TreeRow;
}

function entry(path: string, kind: "file" | "folder", readOnly = false) {
  return {
    kind,
    path,
    name: path.split("/").pop()!,
    visibility: "private" as const,
    inherited: "private" as const,
    exception: false,
    readOnly,
  };
}

const LISTINGS: Record<string, FolderListing | undefined> = {
  "": {
    path: "",
    folderDefault: "private",
    entries: [entry("1-projects", "folder"), entry("privacy.md", "file", true)],
    truncated: false,
    manifestUsable: true,
  },
  "1-projects": {
    path: "1-projects",
    folderDefault: "private",
    entries: [entry("1-projects/note.md", "file")],
    truncated: false,
    manifestUsable: true,
  },
};

const NOTE = "1-projects/note.md";

function at(selectedPath: string | null, canEdit = true) {
  return { canEdit, selectedPath, listings: LISTINGS };
}

/* -------------------------------------------------------------------------- */

describe("the chords the menu advertises", () => {
  function shortcutted(items: MenuItem[]): string[] {
    return items.flatMap((item) =>
      item.items !== undefined
        ? shortcutted(item.items)
        : item.shortcut === undefined
          ? []
          : [item.id],
    );
  }

  test("every one of them is a command this module resolves", () => {
    /*
      The drift guard. A new menu row that prints a chord, or a chord added to
      an existing row, has to appear here — otherwise it is advertised and
      unanswered, which is the state this whole change is about.

      `delete` is the one name that differs between the two files, deliberately:
      the menu item is `delete` because that is where it sits in the list, the
      command is `deleteForever` because that is what pressing it does.
    */
    const menuIdToCommand: Record<string, RowCommand> = {
      newNote: "newNote",
      newFolder: "newFolder",
      rename: "rename",
      duplicate: "duplicate",
      moveTo: "moveTo",
      copy: "copy",
      cut: "cut",
      paste: "paste",
      archive: "archive",
      delete: "deleteForever",
    };

    const advertised = new Set<string>();
    for (const target of [
      { kind: "background" as const, folder: "1-projects" },
      { kind: "row" as const, row: row(NOTE, "file") },
      { kind: "row" as const, row: row("1-projects", "folder") },
    ]) {
      for (const id of shortcutted(
        itemsFor({
          target,
          canEdit: true,
          canSetVisibility: true,
          canShare: true,
          clipboard: { mode: "copy", path: NOTE, name: "note.md" },
          platform: "web",
          apple: true,
        }),
      )) {
        advertised.add(id);
      }
    }

    // Not vacuous: the menu really does print chords, and this is how many.
    expect(advertised.size).toBeGreaterThanOrEqual(9);

    for (const id of advertised) {
      const command = menuIdToCommand[id];
      expect(command).toBeDefined();
      expect(ROW_COMMANDS).toContain(command!);
    }
  });

  test("the console routes each of them into this module", () => {
    /*
      A source check, because the routing is a `case` list inside a component
      that a unit test cannot mount. Deleting one of those labels would leave
      the command falling through to the numbered-tab default and answering
      `false` again — silently, and exactly the way it did before.
    */
    const source = readFileSync(
      join(__dirname, "..", "app", "(app)", "console", "_layout.tsx"),
      "utf8",
    );
    for (const command of ROW_COMMANDS) {
      expect(source).toContain(`case "${command}":`);
    }
    expect(source).toContain("intentForRowCommand(");
    expect(source).toContain("applyRowIntent(");
  });
});

/* -------------------------------------------------------------------------- */

describe("what a keystroke resolves to", () => {
  test("a console that cannot edit resolves nothing", () => {
    // Every mutating method is present and inert on a read-only browser
    // (`browser.ts`), so a keystroke that got through would look like it
    // worked and do nothing at all. `menu.ts` refuses to draw these for the
    // same reason.
    for (const command of ROW_COMMANDS) {
      expect(intentForRowCommand(command, at(NOTE, false))).toBeNull();
    }
  });

  test("creating and pasting work with nothing selected", () => {
    // No selection is the root, not "no target" — which is the state somebody
    // who has just opened the console is in.
    expect(intentForRowCommand("newNote", at(null))).toEqual({ kind: "newNote", folder: "" });
    expect(intentForRowCommand("paste", at(null))).toEqual({ kind: "paste", folder: "" });
  });

  test("creating inside a selected folder means inside it", () => {
    expect(intentForRowCommand("newFolder", at("1-projects"))).toEqual({
      kind: "newFolder",
      folder: "1-projects",
    });
  });

  test("creating with a note selected means beside it", () => {
    expect(intentForRowCommand("newNote", at(NOTE))).toEqual({
      kind: "newNote",
      folder: "1-projects",
    });
  });

  test("the row commands need a row", () => {
    for (const command of ["rename", "moveTo", "duplicate", "archive", "deleteForever"] as const) {
      expect(intentForRowCommand(command, at(null))).toBeNull();
    }
  });

  test("a generated file is not a target", () => {
    /*
      `privacy.md` is written by the gateway and every write path in the product
      refuses it, so F2 on it would raise a rename dialog whose Save is refused
      at the server. `menu.ts` collapses its whole menu to Open and Copy path
      for the same reason.
    */
    for (const command of ["rename", "moveTo", "duplicate", "archive", "deleteForever"] as const) {
      expect(intentForRowCommand(command, at("privacy.md"))).toBeNull();
    }
  });

  test("a row in a folder that is not loaded is still a target", () => {
    // Unknown is not read-only. Refusing here would make a keystroke depend on
    // whether some parent folder happened to have been expanded.
    expect(intentForRowCommand("rename", at("4-archive/elsewhere/thing.md"))).toEqual({
      kind: "rename",
      path: "4-archive/elsewhere/thing.md",
    });
  });

  test("delete knows whether it is aiming at a folder", () => {
    // The dialog's copy differs — a folder takes its contents with it.
    expect(intentForRowCommand("deleteForever", at("1-projects"))).toEqual({
      kind: "delete",
      path: "1-projects",
      isFolder: true,
    });
    expect(intentForRowCommand("deleteForever", at(NOTE))).toEqual({
      kind: "delete",
      path: NOTE,
      isFolder: false,
    });
  });

  test("archiving something already archived restores it instead", () => {
    // The same substitution `menu.ts` makes, through the same function, so the
    // menu and the key cannot disagree about which of the two a row gets.
    const archived = "4-archive/2026-08-26T09-14-02-113Z/1-projects/note.md";
    expect(intentForRowCommand("archive", at(archived))).toEqual({
      kind: "restore",
      path: archived,
      to: NOTE,
    });
  });
});

/* -------------------------------------------------------------------------- */

describe("carrying an intent out", () => {
  function spy() {
    const calls: string[] = [];
    const dialogs: RowIntent[] = [];
    const files = {
      duplicate: (p: string) => calls.push(`duplicate:${p}`),
      copy: (p: string) => calls.push(`copy:${p}`),
      cut: (p: string) => calls.push(`cut:${p}`),
      paste: (f: string) => calls.push(`paste:${f}`),
      move: (p: string, f: string) => calls.push(`move:${p}->${f}`),
    };
    return { calls, dialogs, files, onDialog: (d: RowIntent) => dialogs.push(d) };
  }

  test("every command reaches either the browser or a dialog", () => {
    /*
      The claim in one test. Ten commands, each resolved against a selection
      that has a target for it, and none of them may end in nothing happening —
      which is precisely what all ten did before.
    */
    for (const command of ROW_COMMANDS) {
      const s = spy();
      const intent = intentForRowCommand(command, at(NOTE));
      expect(intent).not.toBeNull();
      expect(applyRowIntent(intent!, s.files, s.onDialog)).toBe(true);
      expect(s.calls.length + s.dialogs.length).toBe(1);
    }
  });

  test("restore is a move out of the archive", () => {
    const s = spy();
    const archived = "4-archive/2026-08-26T09-14-02-113Z/1-projects/note.md";
    applyRowIntent(intentForRowCommand("archive", at(archived))!, s.files, s.onDialog);
    expect(s.calls).toEqual([`move:${archived}->1-projects`]);
  });

  test("the six that need typing go to the dialogs, and nowhere near the browser", () => {
    for (const command of ["newNote", "newFolder", "rename", "moveTo", "deleteForever"] as const) {
      const s = spy();
      applyRowIntent(intentForRowCommand(command, at(NOTE))!, s.files, s.onDialog);
      expect(s.calls).toEqual([]);
      expect(s.dialogs).toHaveLength(1);
    }
  });
});
