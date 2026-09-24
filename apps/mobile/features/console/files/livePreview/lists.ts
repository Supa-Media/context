/**
 * Lists and tasks, read off the tree: hanging indents, finished tasks, and the
 * bullets and checkboxes that are drawn in place of their markers.
 *
 * Part of the Live Preview extension; `../livePreview.ts` is the facade that
 * re-exports the public names and holds the module map.
 */

import type { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { swallowTrailingSpace, type TextRange } from "./reveal";

/* ---------------------------- lists and tables ---------------------------- */

/**
 * A line inside a list item, and how far its text sits from the margin.
 *
 * ## Why a list needed anything at all
 *
 * `- item` was drawn as the literal hyphen it is, in the body font, with no
 * indent — so a nested list read as three hyphens in a column and a wrapped
 * item's second line started back at the margin, underneath its own bullet.
 * On a phone, where almost every list item wraps, that is the whole of "bullet
 * points don't render properly": nothing about the text says which lines belong
 * to which item.
 *
 * ## Why an indent per *line* rather than per item
 *
 * A nested item's lines are also its parent's lines — the parent `ListItem`
 * spans the whole subtree — so the two would both want to indent them, by
 * different amounts. Resolving that in the range set would mean relying on
 * which of two line decorations at one position CodeMirror applies last.
 * Deciding it here instead is one map keyed by line, written in tree order, so
 * the deepest item is simply the last writer and the answer is a fact rather
 * than an ordering.
 *
 * ## Why `ch`
 *
 * The marker is `-`, `*`, `+` or `12.`, and what the wrapped text has to clear
 * is the marker plus the space after it, measured in characters. `ch` is the
 * width of a `0` in the current font, which in a proportional face is a little
 * wider than a hyphen and a space — so a wrapped line clears its bullet with a
 * small margin rather than landing exactly on the first letter. Exact alignment
 * would need the rendered width of that specific prefix, which is a measurement
 * and not a decoration, and being a few pixels generous is the failure that
 * still reads as a list.
 */
export interface HangingIndent {
  /** The start of one line. */
  readonly from: number;
  /** Characters of indent and marker that line's text should clear. */
  readonly columns: number;
}

/**
 * The hanging indent for every line that is inside a list item.
 *
 * Pure over the state, and exported for its own test: the interesting cases are
 * nesting, a wrapped item and a marker wider than one character, and all three
 * are properties of a tree rather than of a rendered editor.
 *
 * `frontEnd` is where the YAML frontmatter ends, and nothing before it is
 * touched — for the reason `hiddenMarkRanges` states at length. A `tags:` block
 * is a YAML sequence, the grammar reads it as a Markdown list, and indenting
 * somebody's metadata by two columns is the same class of mistake as drawing
 * it as a heading. Defaults to zero so a caller with no frontmatter — every
 * test that is not about this — says nothing.
 */
export function hangingIndents(state: EditorState, frontEnd = 0): HangingIndent[] {
  const byLine = new Map<number, number>();
  syntaxTree(state).iterate({
    from: 0,
    to: state.doc.length,
    enter(node) {
      if (node.from < frontEnd) return;
      if (node.name !== "ListItem") return;
      const mark = node.node.getChild("ListMark");
      if (mark === null) return;
      const first = state.doc.lineAt(mark.from);
      /*
        The marker's own columns, counted from the margin, plus the one space
        that separates it from the text. `12.` indents further than `-`, which
        is the whole reason this is measured rather than a constant.

        **A task's marker is `- [ ]`, not `-`.** `TaskMarker` is a child of the
        item beside `ListMark`, and measuring only the `ListMark` under-indented
        every wrapped line of a task by the width of its own checkbox — so the
        second line of a wrapped task ran back under the box, which is the exact
        thing this function exists to prevent, on the one list item that draws
        the widest marker. Seen in a browser at 390pt; no test covered it
        because every task fixture fitted on one line.
      */
      // `ListItem > Task > TaskMarker`, never a direct child — checked against
      // the real tree rather than assumed, because `getChild("TaskMarker")`
      // answers `null` here and reads exactly like a line that works.
      const task = node.node.getChild("Task")?.getChild("TaskMarker") ?? null;
      const columns = (task ?? mark).to - first.from + 1;
      for (let line = first; ; ) {
        // Written unconditionally: a deeper item is entered after its parent,
        // so the last write for a line is the innermost item that owns it.
        byLine.set(line.from, columns);
        if (line.to >= node.to || line.to >= state.doc.length) break;
        line = state.doc.lineAt(line.to + 1);
      }
    },
  });
  return [...byLine.entries()]
    .map(([from, columns]) => ({ from, columns }))
    .sort((a, b) => a.from - b.from);
}

/**
 * A piece of list syntax drawn as the thing it means.
 *
 * A union rather than one shape with optional fields, because the two are not
 * variations of each other: a bullet is a **character** standing in for a
 * character, and a checkbox is a **control** standing in for three. The first
 * version gave both a `glyph: string` and drew ☐ for a task, which is how a
 * checkbox came to be a piece of text in a text font — thin, differently shaped
 * on every platform, and not obviously pressable. See `TaskWidget`.
 */
export type ListGlyph =
  | { readonly kind: "bullet"; readonly from: number; readonly to: number }
  | {
      readonly kind: "task";
      readonly from: number;
      readonly to: number;
      /** `[x]` rather than `[ ]`. Decides both the box and its line's text. */
      readonly checked: boolean;
    };

/**
 * Is this `TaskMarker` ticked?
 *
 * "Anything that is not `[ ]`" rather than "is `[x]`", which reads as though it
 * were generous and is not: lezer's GFM grammar recognises only `[ ]`, `[x]`
 * and `[X]` as a `TaskMarker`, so a plugin's `[-]` for a cancelled task is
 * never a `Task` node and never reaches here. The phrasing is for the `[X]`
 * that a capital-writing editor produces, and the limit is pinned by a test —
 * a comment claiming the generous reading was written first and was wrong.
 */
export function isTicked(
  doc: { sliceString: (from: number, to: number) => string },
  from: number,
  to: number,
): boolean {
  return doc.sliceString(from, to).toLowerCase() !== "[ ]";
}

/**
 * The text of every finished task, so it can be drawn as finished.
 *
 * The other half of a checkbox, and the half a glyph could never have: in
 * Obsidian a completed task's text is struck through and dimmed, which is what
 * lets somebody skim a list and see what is left without reading it. The box
 * alone says the same thing in a space one character wide.
 *
 * **Unconditional, unlike the box.** The markup a task is written in hides when
 * the caret leaves its line and comes back when it enters — that is the reveal
 * rule, and it applies to `[x]` because those are three characters somebody may
 * want to edit. Whether the task is *done* is not markup; it is what the note
 * says. So the strikethrough stays put while the caret moves through the line,
 * exactly as a heading stays large while you edit it. "Styling is unconditional
 * — that is the 'live' in Live Preview."
 *
 * The range starts after the marker and its one following space: a strikethrough
 * over leading whitespace draws a line into the gap before the first word.
 */
export function completedTasks(state: EditorState, frontEnd = 0): TextRange[] {
  const done: TextRange[] = [];
  syntaxTree(state).iterate({
    from: 0,
    to: state.doc.length,
    enter(node) {
      if (node.from < frontEnd) return;
      if (node.name !== "Task") return;
      const marker = node.node.getChild("TaskMarker");
      if (marker === null || !isTicked(state.doc, marker.from, marker.to)) return;
      const from = swallowTrailingSpace(state.doc, marker.to);
      if (from >= node.to) return;
      done.push({ from, to: node.to });
    },
  });
  return done;
}

/**
 * Bullets and checkboxes, drawn as a bullet and a checkbox.
 *
 * ## The one construct in this file that does NOT reveal under the caret
 *
 * Everything else here hides its markup when the cursor is elsewhere and shows
 * it the instant the cursor arrives, because you cannot edit syntax you cannot
 * see. **A list marker is the exception, and on a touch screen the reveal rule
 * was not a nicety being traded away — it made the checkbox unpressable.**
 *
 * A tap on a phone places the caret before the synthesized `mousedown` arrives.
 * So the sequence was: finger lands, caret goes on that line, the line is now
 * "revealed", the decoration is recomputed, the widget is replaced by the
 * literal `- [x] ` — and then `mousedown` fires and finds nothing under it,
 * because the element the press was aimed at no longer exists. The owner
 * described it exactly: "it's impossible to click, it just goes back into text
 * form", on mobile, with desktop fine. Desktop was fine for an unrelated
 * reason: there the handler's own `preventDefault()` stops the caret landing,
 * so the box survived its own press.
 *
 * Obsidian does not reveal these either, and the owner's description of it is
 * the specification: "you are able to check the box in UI form, but still edit
 * it as text if you hit the back button". Which is what a replaced range gives
 * you for free — arrowing or backspacing into it edits the characters
 * underneath. Nothing is hidden from editing; it is drawn as what it means and
 * it stays drawn.
 *
 * The rest of the file is unchanged: `**bold**`, `## heading` and a link's
 * plumbing still come back the moment the caret enters them. The difference is
 * what the markup *is*. `**` is punctuation around text you are formatting, and
 * hiding it permanently would be a block editor with extra steps. `- ` and
 * `[x]` are a marker and a control — there is no formatted text inside them to
 * edit, and drawing them is the entire feature.
 *
 * An ordered list's `1.` is deliberately left alone. It is already the number a
 * reader wants to see, and replacing it with a drawn one would mean this editor
 * renumbering a list, which is a document model doing the counting — the exact
 * thing this file exists not to have.
 *
 * `frontEnd` excludes the frontmatter — see `hangingIndents`. A YAML sequence
 * drawn with bullets would be the editor decorating text it has already decided
 * to draw as plain metadata.
 */
export function listGlyphs(state: EditorState, frontEnd = 0): ListGlyph[] {
  const glyphs: ListGlyph[] = [];
  syntaxTree(state).iterate({
    from: 0,
    to: state.doc.length,
    enter(node) {
      if (node.from < frontEnd) return;
      if (node.name === "ListMark") {
        const parent = node.node.parent;
        // `1.` is a number, not a marker to redraw. See above.
        if (parent === null || parent.parent?.name !== "BulletList") return;
        glyphs.push({ kind: "bullet", from: node.from, to: node.to });
        return;
      }
      if (node.name !== "TaskMarker") return;
      glyphs.push({
        kind: "task",
        from: node.from,
        to: node.to,
        checked: isTicked(state.doc, node.from, node.to),
      });
    },
  });
  return glyphs;
}
