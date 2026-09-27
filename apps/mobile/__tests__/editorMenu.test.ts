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

/* -------------------------------------------------------------------------- */
/*                          the two voice rows                                */
/* -------------------------------------------------------------------------- */

/**
 * DICTATE AND ASK, AND WHY THEY ARE GATED SEPARATELY.
 *
 * The owner asked for one of them by name: *"dictating inside of a note should
 * also be a thing still doe, just have people right click inside a note, and
 * then have an option to dictate notes."* The second came with it because the
 * caret is where both belong — one puts words in, the other asks about the
 * words already there.
 *
 * They are two flags rather than one "in the console" flag, and the tests
 * below are mostly about that. Dictation needs a microphone and a writable
 * note; asking needs a right panel for the answer to land in, which a phone
 * does not have whatever the microphone says. One flag would be wrong on some
 * surface, and it would be wrong on the surface nobody is testing on.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. `ask` gated on `canEdit` as well, which is the obvious tidy-up.
 *     → **1 fails**: `a read-only note can still be asked about`. Asking about
 *     `privacy.md` or somebody else's context is an ordinary thing to want,
 *     and read-only is about typing rather than about reading.
 *  2. The two rows put after the formatting block instead of before it.
 *     → **1 fails**: `they lead the verbs, because they are why the menu was
 *     opened`.
 *  3. `canDictate` defaulting to `true` when absent.
 *     → **2 fail**: `a surface that supplies neither gets neither` and — the
 *     one I did not predict — the *existing* `neither is offered with nothing
 *     selected`, which is this file's older check that an editable note with
 *     no selection offers no Cut and no Copy. It reads the whole list, so a
 *     row appearing from nowhere reddens it. The landing-page case I did
 *     predict stays green, because it is read-only and `canDictate` never
 *     reaches it.
 */
describe("dictating and asking from the caret", () => {
  const inConsole = { canEdit: true, hasSelection: false, apple: true, canDictate: true, canAsk: true };

  test("both are offered where both work", () => {
    expect(ids(inConsole)).toContain("dictate");
    expect(ids(inConsole)).toContain("ask");
  });

  test("they lead the verbs, because they are why the menu was opened", () => {
    const got = ids(inConsole);
    expect(got[0]).toBe("dictate");
    expect(got[1]).toBe("ask");
    // ...and the formatting rows are still all there, below them.
    expect(got).toContain("bold");
    expect(got.indexOf("bold")).toBeGreaterThan(got.indexOf("ask"));
  });

  test("a surface that supplies neither gets neither", () => {
    const got = ids({ canEdit: true, hasSelection: false, apple: true });
    expect(got).not.toContain("dictate");
    expect(got).not.toContain("ask");
  });

  /**
   * Dictation is a write; asking is not. `privacy.md`, an encrypted note and
   * somebody else's context are all read-only here, and all of them are
   * things people ask about.
   */
  test("a read-only note can still be asked about", () => {
    const got = ids({
      canEdit: false,
      hasSelection: false,
      apple: true,
      canDictate: true,
      canAsk: true,
    });
    expect(got).toEqual(["ask"]);
  });

  test("and cannot be dictated into, whatever the surface says", () => {
    const got = ids({
      canEdit: false,
      hasSelection: true,
      apple: true,
      canDictate: true,
      canAsk: false,
    });
    expect(got).toEqual(["copy"]);
  });

  /**
   * The landing page's preview is read-only and has no console around it, so
   * both flags are absent and the empty-list rule still holds: the browser's
   * own menu opens rather than an empty box.
   */
  test("the landing page's read-only preview still gets nothing", () => {
    expect(editorMenuItems({ canEdit: false, hasSelection: false, apple: true })).toEqual([]);
  });

  test("a phone with a microphone and no panel gets dictation alone", () => {
    const got = ids({
      canEdit: true,
      hasSelection: false,
      apple: true,
      canDictate: true,
      canAsk: false,
    });
    expect(got[0]).toBe("dictate");
    expect(got).not.toContain("ask");
  });

  /**
   * Neither prints a chord, and that is deliberate rather than an omission:
   * nothing binds one. A menu that advertised a keystroke nothing listens for
   * is the defect `keymap.ts` spends a paragraph on, arrived at from the other
   * direction.
   */
  test("neither advertises a chord nothing binds", () => {
    for (const item of editorMenuItems(inConsole)) {
      if (item.id === "dictate" || item.id === "ask") {
        expect(item.shortcut).toBeUndefined();
      }
    }
  });
});

describe("spelling", () => {
  test("suggestions for a misspelled word come first, one row each", () => {
    const got = ids({
      canEdit: true,
      hasSelection: false,
      apple: true,
      spelling: { suggestions: ["permission", "permissions"] },
    });
    expect(got.slice(0, 2)).toEqual(["spelling:0", "spelling:1"]);
    expect(got).toContain("bold");
  });

  test("a flagged word with nothing to suggest says so, inertly", () => {
    const items = editorMenuItems({
      canEdit: true,
      hasSelection: false,
      apple: true,
      spelling: { suggestions: [] },
    });
    expect(items[0]).toMatchObject({ id: "noSuggestions", disabled: true });
  });

  test("a note nobody may write is offered no spelling fix", () => {
    const got = ids({
      canEdit: false,
      hasSelection: true,
      apple: true,
      spelling: { suggestions: ["permission"] },
      spellingHint: true,
    });
    expect(got).toEqual(["copy"]);
  });

  test("a browser is told where its suggestions are, last and inert", () => {
    const items = editorMenuItems({ canEdit: true, hasSelection: false, apple: true, spellingHint: true });
    const last = items[items.length - 1];
    expect(last).toMatchObject({ id: "spellingHint", disabled: true, separatorBefore: true });
    expect(last?.shortcut).toBe("⇧ Right-click");
    const windows = editorMenuItems({ canEdit: true, hasSelection: false, apple: false, spellingHint: true });
    expect(windows[windows.length - 1]?.shortcut).toBe("Shift+Right-click");
  });

  test("no hint where a checker was asked", () => {
    expect(ids({ canEdit: true, hasSelection: false, apple: true })).not.toContain("spellingHint");
  });
});
