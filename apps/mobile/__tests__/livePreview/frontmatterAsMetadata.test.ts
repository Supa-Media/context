import { describe, expect, test } from "@jest/globals";
import {
  decorationsFor,
  frontmatterBlock,
  frontmatterRange,
  hangingIndents,
  listGlyphs,
  openingCaret,
  selectionTouches,
  stateFor,
  syntaxTree,
  visibleText,
} from "./fixtures";

/**
 * NOTHING IS DECORATED INSIDE THE FRONTMATTER, AND A LIST IS THE CASE THAT
 * MAKES THAT MORE THAN A TIDINESS RULE.
 *
 * `hiddenMarkRanges` and the style pass have both excluded the frontmatter
 * since the block was first drawn as metadata rather than as the note's largest
 * heading. The list and table passes are new and had to be told the same thing:
 * a `tags:` block is a **YAML sequence**, the grammar reads it as a Markdown
 * list, and the first version of this drew a bullet over somebody's metadata
 * and indented it by two columns.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   the frontmatter cutoff dropped from the list passes                 3
 *   the cutoff computed but not passed on by `decorationsFor`           1
 */
describe("the frontmatter is metadata, not a list", () => {
  const NOTE = [
    "---",
    "updated: 2026-09-07",
    "tags:",
    "  - editor",
    "  - polish",
    "---",
    "",
    "- a real list item",
  ].join("\n");

  /** Where the frontmatter ends, the way `decorationsFor` computes it. */
  function frontEnd(doc: string): number {
    return frontmatterRange(doc)?.to ?? 0;
  }

  test("a YAML sequence gets no bullet", () => {
    const state = stateFor(NOTE);
    const glyphs = listGlyphs(state, frontEnd(NOTE));
    // Exactly one: the real list item below the block, not the two YAML rows.
    expect(glyphs).toHaveLength(1);
    expect(state.doc.lineAt(glyphs[0].from).text).toBe("- a real list item");
  });

  test("and no hanging indent", () => {
    const state = stateFor(NOTE);
    const lines = hangingIndents(state, frontEnd(NOTE)).map(
      (indent) => state.doc.lineAt(indent.from).text,
    );
    expect(lines).toEqual(["- a real list item"]);
  });

  test("and the real decoration set has nothing but the metadata line in there", () => {
    /*
      The three above call the passes directly, which leaves the wiring
      untested: `decorationsFor` computes the cutoff once and hands it to all
      three, and setting *that* to zero passed every assertion above. This is
      the test that fails when it does.

      Everything drawn inside the block must be the `cm-lp-frontmatter` line
      decoration and nothing else — no widget standing in for a `-`, no
      per-line indent.
    */
    const state = stateFor(NOTE);
    const inside: string[] = [];
    decorationsFor(state).between(0, frontEnd(NOTE), (_from, _to, value) => {
      const spec = value.spec as { class?: string; widget?: unknown; attributes?: unknown };
      inside.push(
        spec.widget !== undefined
          ? "widget"
          : spec.attributes !== undefined
            ? `styled:${spec.class ?? ""}`
            : (spec.class ?? "other"),
      );
    });
    expect([...new Set(inside)]).toEqual(["cm-lp-frontmatter"]);
  });

  test("without the cutoff the YAML would be decorated — the control", () => {
    /*
      The positive half. Passing 0 is what the code did before, and it proves
      the assertions above are held by the cutoff rather than by the grammar
      declining to parse the block.
    */
    const state = stateFor(NOTE);
    expect(listGlyphs(state, 0).length).toBeGreaterThan(1);
  });
});

/* -------------------------------------------------------------------------- */

describe("frontmatter is metadata, not the note's largest heading", () => {
  /**
   * **What this fixes, and why it was on every note.**
   *
   * The lezer Markdown grammar has no frontmatter node — the file's own header
   * says so — and CommonMark reads the closing `---` as a **setext underline**.
   * So a note that opens the way every Obsidian note opens:
   *
   *     ---
   *     updated: 2026-08-26
   *     ---
   *
   * had its two metadata keys drawn as a level-2 heading, bold and two-thirds
   * larger than the body, above the actual title. It was the first thing on the
   * screen and the loudest thing on it, on every note in a synced bucket.
   */
  const FRONT = "---\nupdated: 2026-08-26\nstatus: active\n---\n\n# Real title\n";

  /**
   * Is the whole block replaced right now?
   *
   * Read off `decorationsFor` rather than `visibleText`, and that is the one
   * thing worth explaining here: `hiddenMarkRanges` deliberately answers
   * *nothing* inside the frontmatter — its own comment is why, and the
   * asymmetric fences are the reason — so the helper built on it cannot see
   * this. The block decoration is `decorationsFor`'s, because whole lines are
   * what a `block: true` replace is for, and this asks the set that actually
   * reaches CodeMirror.
   */
  function blockHidden(doc: string, cursor: number | [number, number] = 500): boolean {
    const range = frontmatterBlock(doc);
    if (range === null) return false;
    const set = decorationsFor(stateFor(doc, cursor));
    const iter = set.iter();
    while (iter.value !== null) {
      const spec = iter.value.spec as { block?: boolean; widget?: unknown };
      if (spec.block === true && spec.widget === undefined && iter.from === range.from) {
        return iter.to === range.to;
      }
      iter.next();
    }
    return false;
  }

  function classesIn(doc: string, cursor: number | [number, number] = 500): string[] {
    const set = decorationsFor(stateFor(doc, cursor));
    const found: string[] = [];
    const iter = set.iter();
    while (iter.value !== null) {
      const spec = iter.value.spec as { class?: string };
      if (spec.class) found.push(spec.class);
      iter.next();
    }
    return found;
  }

  test("the grammar really does call it a heading", () => {
    /*
      The premise, asserted rather than assumed. If a future grammar learns
      about frontmatter this fails, and the fix is to delete the workaround
      rather than to discover it is now doing nothing.
    */
    const state = stateFor(FRONT);
    const names: string[] = [];
    syntaxTree(state).iterate({ enter: (node) => void names.push(node.name) });
    expect(names).toContain("SetextHeading2");
  });

  /**
   * **The block is hidden while nobody is in it, and that is new.**
   *
   * It used to be drawn always, small and dim, on the argument that it is
   * "metadata a person may need to edit". Measured in Chromium at 1440×900
   * against the console's own demo note, that meant four lines of filing —
   * `---`, `updated:`, `status:`, `---` — above the note's own title, on every
   * note anybody had ever filed anything on. Dim is not the same as out of the
   * way.
   *
   * So it follows the rule every other mark in this file follows. The editing
   * half of the old argument is kept exactly: the caret reaching it brings it
   * back in full, which is the case below, and the editor is still the one
   * thing in the product that can change a note's metadata —
   * `NoteEditor`'s Properties panel is a reader.
   */
  test("with the caret elsewhere it is not drawn at all", () => {
    const classes = classesIn(FRONT);
    expect(classes).not.toContain("cm-lp-frontmatter");
    expect(classes).not.toContain("cm-lp-h2");
    expect(blockHidden(FRONT)).toBe(true);
  });

  test("and the caret reaching it brings the whole block back", () => {
    // Anywhere inside, including the fences: the block is one object, and
    // revealing the keys without the fences is the half-hidden state this
    // file's header calls the worst of both.
    for (const cursor of [0, 10, 38]) {
      const classes = classesIn(FRONT, cursor);
      expect(`${cursor}: ${classes.includes("cm-lp-frontmatter")}`).toBe(`${cursor}: true`);
      expect(`${cursor}: ${classes.includes("cm-lp-h2")}`).toBe(`${cursor}: false`);
      expect(`${cursor}: ${blockHidden(FRONT, cursor)}`).toBe(`${cursor}: false`);
    }
  });

  test("the note's own headings still are", () => {
    // The other direction, so the fix cannot be "stop styling headings". Read
    // with the caret away, which is also the resting state.
    expect(classesIn(FRONT)).toContain("cm-lp-h1");
  });

  test("the range covers the block and stops at the closing fence", () => {
    const range = frontmatterRange(FRONT)!;
    expect(range.from).toBe(0);
    expect(FRONT.slice(range.from, range.to)).toBe(
      "---\nupdated: 2026-08-26\nstatus: active\n---",
    );
  });

  test("a rule further down the note is still a rule", () => {
    // Frontmatter is a property of the *first* line. A `---` in the middle of a
    // document is a horizontal rule and dimming it would be a new bug.
    expect(frontmatterRange("# Title\n\n---\nnot: frontmatter\n---\n")).toBeNull();
  });

  test("an unterminated fence is a horizontal rule, not a swallowed note", () => {
    /*
      The case that rules out a `@lezer/markdown` block parser here:
      `BlockContext` cannot rewind, so recognising the opener and then failing
      to find a closer would consume the rest of the document. Reading the text
      answers before anything is consumed.
    */
    const doc = "---\nthis note has no closing fence\n";
    expect(frontmatterRange(doc)).toBeNull();
    expect(classesIn(doc)).not.toContain("cm-lp-frontmatter");
    // And it is still *on screen*: not frontmatter means not hidden either,
    // which is the half a "no class" assertion cannot see now that the block
    // is replaced rather than dimmed.
    expect(blockHidden(doc)).toBe(false);
    expect(visibleText(doc, 500)).toContain("this note has no closing fence");
  });

  test("both fences are visible once it is revealed, not just the opening one", () => {
    /*
      The asymmetry this rules out. The opening `---` parses as a
      HorizontalRule and the closing one as a setext HeaderMark, so ordinary
      mark-hiding removed the closing fence and left the opening one — and the
      block read as an unterminated rule above two stray keys.

      Read with the caret inside, which is the only state the block is drawn
      in now. With it away the whole thing is gone, fences included, which is
      the case above and is not the asymmetry this is about.
    */
    expect(visibleText(FRONT, 10)).toContain("---\nupdated: 2026-08-26\nstatus: active\n---");
  });

  test("YAML's other closing fence counts", () => {
    // `...` ends a YAML document too, and Obsidian accepts it.
    const doc = "---\na: 1\n...\nbody\n";
    const range = frontmatterRange(doc)!;
    expect(doc.slice(range.from, range.to)).toBe("---\na: 1\n...");
  });

  test("an empty document, and a bare fence, are not frontmatter", () => {
    expect(frontmatterRange("")).toBeNull();
    expect(frontmatterRange("---")).toBeNull();
    expect(frontmatterRange("---\n")).toBeNull();
  });

  /**
   * WHERE THE CARET GOES WHEN A NOTE IS OPENED, AND WHY IT IS NOT ZERO.
   *
   * **This is the other half of hiding the block, and without it the first
   * half buys nothing.** The reveal rule is "the selection is in it", a note
   * opens with the caret at position 0, and position 0 is inside the
   * frontmatter — so every note with a `---` block opened showing exactly the
   * four lines that hiding it was for.
   *
   * `openingCaret` is `editorSetup.ts`'s, spent by both hosts: the web editor
   * passes it to `EditorState.create` and `replaceDocument` sets it on every
   * note switch, so a note opened cold and a note switched to agree.
   *
   * The alternative was to make the *reveal* rule cleverer — "touching the
   * range does not count at its first character" — and it is worse for a
   * reason worth writing down: ⌘↑ and Home both put the caret at 0
   * deliberately, and a rule that ignores 0 is a rule that cannot be used to
   * get there.
   */
  describe("the caret opens on the writing, not on the filing", () => {
    test("past the block and the blank line under it, on the body's first line", () => {
      const block = frontmatterBlock(FRONT)!;
      expect(openingCaret(FRONT)).toBe(block.to + 1);
      // And it really is past it, which is what stops the block revealing.
      // `frontmatterBlock`, not `frontmatterRange`: a caret one character past
      // the *fence* is on the blank line, which is hidden with it.
      expect(
        selectionTouches(block, [
          { from: openingCaret(FRONT), to: openingCaret(FRONT) },
        ]),
      ).toBe(false);
    });

    test("and the blank line under the fence is hidden with it", () => {
      /*
        `frontmatterRange` stops at the closing fence, because that is where
        the YAML stops. Hiding exactly that left a 28pt empty line above the
        note's title — the separator, still separating, with nothing on the
        other side of it. Measured in Chromium at 1440×900 before this: the
        first `.cm-line` was an empty box 28pt tall between the breadcrumb and
        the heading.
      */
      const block = frontmatterBlock(FRONT)!;
      expect(FRONT.slice(block.from, block.to)).toBe(
        "---\nupdated: 2026-08-26\nstatus: active\n---\n",
      );
      // And the fence's own range is unchanged, which is what its own tests
      // above hold and what the YAML document actually is.
      expect(frontmatterRange(FRONT)!.to).toBeLessThan(block.to);
    });

    test("several blank lines go too, and a line with anything on it stops the walk", () => {
      const spaced = "---\na: 1\n---\n\n\n\n# Title\n";
      expect(spaced.slice(0, frontmatterBlock(spaced)!.to)).toBe("---\na: 1\n---\n\n\n");
      expect(openingCaret(spaced)).toBe(spaced.indexOf("# Title"));

      const tight = "---\na: 1\n---\n# Title\n";
      expect(frontmatterBlock(tight)!.to).toBe(frontmatterRange(tight)!.to);
    });

    test("and zero for every document that has no block", () => {
      // A note with no frontmatter, an unterminated fence, and a rule further
      // down: `frontmatterRange` answers `null` for all three, and the first
      // character is the first character.
      expect(openingCaret("# Just a note\n")).toBe(0);
      expect(openingCaret("---\nno closing fence\n")).toBe(0);
      expect(openingCaret("# Title\n\n---\nnot: frontmatter\n---\n")).toBe(0);
      expect(openingCaret("")).toBe(0);
    });

    test("and never past the end of a document that ends at the fence", () => {
      // A file that is frontmatter and nothing else has no body line to land
      // on. `min` is what stops the caret being one past the document.
      const only = "---\na: 1\n---";
      expect(openingCaret(only)).toBe(only.length);
    });
  });
});
