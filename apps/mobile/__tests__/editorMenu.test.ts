/**
 * WHAT RIGHT-CLICKING A NOTE OFFERS.
 *
 * The model, in plain node with no renderer, for the reason `fileMenu.test.ts`
 * gives about its own: the two rules that matter — read-only means *absent*,
 * and a chord is printed from the binding table rather than from a literal —
 * stop being checkable the moment they are expressed as `{canEdit && <Row/>}`.
 */

import { describe, expect, test } from "@jest/globals";
import { BINDINGS, describeBinding } from "../features/design/keymap";
import {
  editorMenuItems,
  LINE_PREFIXES,
  type EditorMenuId,
} from "../features/console/files/editorMenu";

const ids = (context: Parameters<typeof editorMenuItems>[0]): EditorMenuId[] =>
  editorMenuItems(context).map((item) => item.id);

describe("an editable note", () => {
  test("offers the markers, the block prefixes and a table", () => {
    const got = ids({ canEdit: true, hasSelection: true, apple: true });
    for (const id of [
      "bold",
      "italic",
      "strikethrough",
      "code",
      "link",
      "heading",
      "bulletList",
      "numberedList",
      "task",
      "quote",
      "table",
    ] satisfies EditorMenuId[]) {
      expect(got).toContain(id);
    }
  });

  test("Heading is a submenu and never a dispatchable id of its own", () => {
    const heading = editorMenuItems({ canEdit: true, hasSelection: false, apple: true }).find(
      (item) => item.id === "heading",
    );
    expect(heading?.items?.map((item) => item.id)).toEqual([
      "heading1",
      "heading2",
      "heading3",
    ]);
    // The trap this guards is in `menu.ts`'s own words: an id with no handler
    // is a no-op, an id with the wrong handler rewrites somebody's line.
    expect(LINE_PREFIXES.heading).toBeUndefined();
  });

  test("every block row has a prefix, and every prefix has a row", () => {
    const items = editorMenuItems({ canEdit: true, hasSelection: false, apple: true });
    const flat = items.flatMap((item) => item.items ?? [item]).map((item) => item.id);
    for (const id of Object.keys(LINE_PREFIXES) as EditorMenuId[]) {
      expect(flat).toContain(id);
    }
    expect(Object.values(LINE_PREFIXES).every((prefix) => prefix?.endsWith(" "))).toBe(true);
  });
});

describe("a note this viewer may not write", () => {
  test("offers Copy and nothing else", () => {
    expect(ids({ canEdit: false, hasSelection: true, apple: true })).toEqual(["copy"]);
  });

  /**
   * An empty list is a real answer and the caller has to honour it: a read-only
   * note with nothing selected has no verbs, and the right behaviour is to let
   * the browser's own menu open rather than suppress it for an empty box.
   * `rowInteractions.web.ts` states the same rule for the file tree.
   */
  test("and nothing at all when there is also no selection", () => {
    expect(editorMenuItems({ canEdit: false, hasSelection: false, apple: true })).toEqual([]);
  });

  test("Cut is absent even though Copy is there", () => {
    expect(ids({ canEdit: false, hasSelection: true, apple: true })).not.toContain("cut");
  });
});

describe("Cut and Copy follow the selection", () => {
  test("neither is offered with nothing selected", () => {
    const got = ids({ canEdit: true, hasSelection: false, apple: true });
    expect(got).not.toContain("cut");
    expect(got).not.toContain("copy");
    // …and the menu still starts cleanly, with no rule above its first row.
    expect(editorMenuItems({ canEdit: true, hasSelection: false, apple: true })[0]).toMatchObject({
      id: "bold",
      separatorBefore: false,
    });
  });

  test("and Paste is never offered, on any arm", () => {
    for (const canEdit of [true, false]) {
      for (const hasSelection of [true, false]) {
        expect(ids({ canEdit, hasSelection, apple: true })).not.toContain(
          "paste" as EditorMenuId,
        );
      }
    }
  });
});

describe("chords come from the binding table, not from this file", () => {
  test("the three marker rows print what keymap.ts says they are", () => {
    const items = editorMenuItems({ canEdit: true, hasSelection: true, apple: true });
    const shortcutFor = (id: EditorMenuId) => items.find((item) => item.id === id)?.shortcut;

    expect(shortcutFor("bold")).toBe(describeBinding("bold", true));
    expect(shortcutFor("italic")).toBe(describeBinding("italic", true));
    expect(shortcutFor("strikethrough")).toBe(describeBinding("strikethrough", true));
    expect(shortcutFor("bold")).toBe("⌘B");
  });

  test("and the same rows print the other platform's spelling", () => {
    const items = editorMenuItems({ canEdit: true, hasSelection: true, apple: false });
    expect(items.find((item) => item.id === "bold")?.shortcut).toBe("Ctrl+B");
    expect(items.find((item) => item.id === "strikethrough")?.shortcut).toBe("Ctrl+Shift+X");
  });

  /**
   * A row with no binding prints no chord, which `describeBinding` treats as a
   * legitimate state rather than an error — and is the only honest answer,
   * because advertising a keystroke nothing binds is a bug `menu.ts` has
   * already had once.
   */
  test("rows with no binding print nothing", () => {
    const items = editorMenuItems({ canEdit: true, hasSelection: true, apple: true });
    for (const id of ["code", "link", "table", "quote", "cut", "copy"] satisfies EditorMenuId[]) {
      expect(items.find((item) => item.id === id)?.shortcut).toBeUndefined();
    }
  });

  test("every chord the menu prints is a binding that really exists", () => {
    const printed = editorMenuItems({ canEdit: true, hasSelection: true, apple: true })
      .flatMap((item) => item.items ?? [item])
      .map((item) => item.shortcut)
      .filter((shortcut): shortcut is string => shortcut !== undefined);
    const real = BINDINGS.map((binding) => describeBinding(binding.command, true));
    for (const shortcut of printed) expect(real).toContain(shortcut);
  });
});
