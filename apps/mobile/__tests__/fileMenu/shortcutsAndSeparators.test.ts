import { describe, expect, test } from "@jest/globals";
import {
  BINDINGS,
  describeBinding,
  dir,
  find,
  ids,
  itemsFor,
  joinGroups,
  menu,
  type MenuItem,
  type MenuTarget,
  note,
  put,
} from "./fixtures";


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
   * This used to read `expect(…copyPath…).toBe("⌘⇧C")`, and it was pinning a
   * lie: `keymap.ts` binds no `copyPath` command, so the menu was advertising a
   * chord that did nothing when pressed. Now that the labels come from the
   * binding table there is nowhere for an invented chord to come from, and the
   * assertion is the true half of the old one — the item is still offered, it
   * simply no longer promises a keystroke.
   *
   * If `copyPath` is ever bound, this test should be *replaced* by one naming
   * the new chord, not deleted.
   */
  test("an item with no binding prints no chord rather than inventing one", () => {
    const file = menu({ kind: "row", row: note("1-projects/plan.md") });
    expect(find(file, "copyPath")).toBeDefined();
    expect(find(file, "copyPath")?.shortcut).toBeUndefined();
    expect(BINDINGS.some((binding) => binding.command === ("copyPath" as never))).toBe(false);
  });

  /**
   * The bug this whole wiring exists to kill: the chords were Apple glyphs
   * baked into a literal table, so a Windows or Linux console printed `⌘⇧M`
   * next to "Move to…" for a keyboard that has no `⌘` key on it.
   */
  test("a non-Apple console prints Ctrl+…, and no key that keyboard does not have", () => {
    const file = menu({ kind: "row", row: note("1-projects/plan.md") }, { apple: false });
    expect(find(file, "duplicate")?.shortcut).toBe("Ctrl+D");
    expect(find(file, "moveTo")?.shortcut).toBe("Ctrl+Shift+M");
    expect(find(file, "copy")?.shortcut).toBe("Ctrl+C");
    expect(find(file, "archive")?.shortcut).toBe("Ctrl+Backspace");
    expect(find(file, "delete")?.shortcut).toBe("Ctrl+Shift+Backspace");
    // A chord with no modifier is the same sentence on every keyboard.
    expect(find(file, "rename")?.shortcut).toBe("F2");

    const folder = menu(
      { kind: "row", row: dir("1-projects") },
      { apple: false, clipboard: put("copy", "2-areas/handbook.md") },
    );
    for (const entry of [...file, ...folder]) {
      for (const glyph of ["⌘", "⇧", "⌥", "⌫"]) {
        expect(entry.shortcut ?? "").not.toContain(glyph);
      }
    }
  });

  /** Omitting the flag prints the Apple spelling; see the note on `apple`. */
  test("an unstated keyboard is an Apple one", () => {
    const stated = menu({ kind: "row", row: note("1-projects/plan.md") }, { apple: true });
    const unstated = menu({ kind: "row", row: note("1-projects/plan.md") });
    expect(unstated).toEqual(stated);
  });

  /**
   * The property behind both of the above, and the reason the literal table
   * had to go: every chord this menu prints is one `keymap.ts` can produce, on
   * whichever keyboard it was asked about. A hand-written glyph — a rebind that
   * moved, or a chord nothing binds — has no matching binding and fails here.
   */
  test("every chord the menu prints is one the keymap actually binds", () => {
    for (const apple of [true, false]) {
      const printable = new Set(
        BINDINGS.map((binding) => describeBinding(binding.command, apple)).filter(
          (chord): chord is string => chord !== null,
        ),
      );
      for (const target of [
        { kind: "row", row: note("1-projects/plan.md") } as const,
        { kind: "row", row: dir("1-projects") } as const,
        { kind: "background", folder: "1-projects" } as const,
        {
          kind: "selection",
          rows: [note("1-projects/a.md"), note("1-projects/b.md")],
        } as const,
      ]) {
        const list = menu(target, { apple, clipboard: put("copy", "2-areas/handbook.md") });
        for (const entry of list) {
          if (entry.shortcut === undefined) continue;
          expect(printable.has(entry.shortcut)).toBe(true);
        }
      }
    }
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
            const list = itemsFor({
              target,
              platform,
              canEdit,
              canSetVisibility: canEdit,
              canShare: canEdit,
              canDownload: true,
              clipboard,
            });
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

describe("visibility is offered only to the owner", () => {
  /**
   * The second half of the live breach's fix. The server refuses an editor's
   * visibility write (`minimum: "owner"`); this is the layer that stops the
   * menu OFFERING it — absent, never present-and-refused, per this module's
   * own first rule.
   */
  test("an editor's menu has everything mutating except Visibility", () => {
    const list = menu(
      { kind: "row", row: note("1-projects/plan.md") },
      { canSetVisibility: false },
    );
    const ids = list.map((item) => item.id);
    expect(ids).toContain("rename");
    expect(ids).toContain("archive");
    expect(ids).not.toContain("visibility");
  });

  test("a folder's menu drops it the same way", () => {
    const list = menu({ kind: "row", row: dir("2-areas") }, { canSetVisibility: false });
    expect(list.map((item) => item.id)).not.toContain("visibility");
  });

  test("the owner keeps it", () => {
    const list = menu({ kind: "row", row: note("1-projects/plan.md") });
    expect(list.map((item) => item.id)).toContain("visibility");
  });
});
