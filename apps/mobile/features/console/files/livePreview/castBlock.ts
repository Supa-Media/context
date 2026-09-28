/**
 * ```` ```cast ```` fences: the homepage's demo script, folded to one row.
 *
 * A cast block is a script for the people and agents the homepage shows
 * working in a website page (`packages/shared/src/websiteCast.ts`, and
 * "The homepage's cast" in `docs/decisions/websites.md`). A site never shows
 * it as text. In the owner's editor it used to show as eight lines of
 * `@maya types: …` in the code face, in the middle of the page they are
 * writing, which is the loudest thing on a phone screen and the least read.
 *
 * So it folds the way the frontmatter does (`frontmatter.ts`): one row saying
 * what it is and how long it is — "▸ Demo script · 8 steps" — while nobody is
 * in it, and its own source the moment the caret reaches it. Tapping the row
 * puts the caret on the script's first line, which is the reveal rule's own
 * trigger, so there is one way in rather than two.
 *
 * `castFences` is pure over the state like every other pass in
 * `decorations.ts`. What keeps an *unclosed* fence from swallowing the note is
 * the grammar's business, in `castGrammar.ts`.
 *
 * Part of the Live Preview extension; `../livePreview.ts` is the facade that
 * re-exports the public names and holds the module map.
 */

import type { EditorState } from "@codemirror/state";
import { EditorView, WidgetType } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { splitWebsiteCast } from "@context/shared/src/websiteCast";
import { CAST_OPEN } from "./castGrammar";
import { revealSelection } from "./engagement";
import { selectionTouches } from "./reveal";

/** A cast fence that is drawn folded right now. */
export interface CastFence {
  /** The whole fence, both fence lines included. */
  readonly from: number;
  readonly to: number;
  /** The steps the homepage will play from this block. */
  readonly steps: number;
}

/**
 * How many steps each block contributes, counted by the shared parser itself.
 *
 * Cumulatively over the document rather than one block at a time, because the
 * parser's answer for a block depends on the blocks above it: a `replies` step
 * needs a thread an earlier block started, and the whole page is capped at
 * `MAX_CAST_STEPS`. Counting a block alone would say a step plays that never
 * does.
 *
 * `ends` are the offsets just past each block's closing fence, in order.
 * Memoised on the document text, since the decorations are rebuilt on every
 * caret move and the text has not changed for any of those.
 */
let countCache: { doc: string; ends: string; counts: number[] } | null = null;

export function castStepCounts(doc: string, ends: readonly number[]): number[] {
  const key = ends.join(",");
  if (countCache !== null && countCache.doc === doc && countCache.ends === key) {
    return countCache.counts;
  }
  const counts: number[] = [];
  let before = 0;
  for (const end of ends) {
    const total = splitWebsiteCast(doc.slice(0, end)).steps.length;
    counts.push(Math.max(0, total - before));
    before = total;
  }
  countCache = { doc, ends: key, counts };
  return counts;
}

/**
 * Every closed cast fence that should be drawn as its folded row right now.
 *
 * Left as source, and so editable, when:
 *
 *  - **the selection touches it** — the reveal rule, and the only way to edit
 *    a script nobody can see (`revealSelection` also keeps a note nobody has
 *    touched, and a read-only one, folded);
 *  - **it is not at the margin** — a block widget replaces whole lines, and a
 *    fence inside a list item is not whole lines, `htmlPreviews`' reason;
 *  - **it is not closed** — `castGrammar` has already made that one a line of
 *    text rather than a fence, so there is nothing here to fold.
 *
 * `frontEnd` excludes the frontmatter, as every pass here does.
 */
export function castFences(state: EditorState, frontEnd = 0): CastFence[] {
  const found: Array<{ from: number; to: number }> = [];
  syntaxTree(state).iterate({
    from: 0,
    to: state.doc.length,
    enter(node) {
      if (node.name !== "FencedCode") return;
      if (node.from < frontEnd) return false;
      const open = state.doc.lineAt(node.from);
      if (open.from !== node.from || !CAST_OPEN.test(open.text)) return false;
      if (state.doc.lineAt(node.to).to !== node.to) return false;
      if (node.node.getChildren("CodeMark").length < 2) return false;
      found.push({ from: node.from, to: node.to });
      return false;
    },
  });
  if (found.length === 0) return [];

  const counts = castStepCounts(
    state.doc.toString(),
    found.map((fence) => fence.to),
  );
  const selection = revealSelection(state);
  return found
    .map((fence, index) => ({ ...fence, steps: counts[index] ?? 0 }))
    .filter((fence) => !selectionTouches(fence, selection));
}

/** "8 steps", "1 step". */
export function castLabel(steps: number): string {
  return `Demo script · ${steps} ${steps === 1 ? "step" : "steps"}`;
}

/**
 * The folded row.
 *
 * It answers its own press rather than leaving it to CodeMirror, because on a
 * phone there is no press for CodeMirror to answer: a tap on a
 * `contenteditable=false` block puts no native caret anywhere, so the row
 * would be a thing that looks tappable and is not. The press puts the caret on
 * the script's first line as a pointer selection — which engages the editor
 * (`editorEngaged`) and trips the reveal rule, the same road a click into any
 * other markup takes.
 */
export class CastWidget extends WidgetType {
  constructor(private readonly steps: number) {
    super();
  }

  eq(other: CastWidget): boolean {
    return other.steps === this.steps;
  }

  toDOM(view: EditorView): HTMLElement {
    const row = document.createElement("div");
    row.className = "cm-lp-cast";
    row.setAttribute("role", "button");
    row.setAttribute("aria-label", `${castLabel(this.steps)}. Edit the script.`);
    const twisty = document.createElement("span");
    twisty.className = "cm-lp-cast-twisty";
    twisty.textContent = "▸";
    const name = document.createElement("span");
    name.className = "cm-lp-cast-name";
    name.textContent = "Demo script";
    const count = document.createElement("span");
    count.className = "cm-lp-cast-count";
    count.textContent = `· ${this.steps} ${this.steps === 1 ? "step" : "steps"}`;
    row.append(twisty, name, count);
    row.addEventListener("click", (event) => {
      event.preventDefault();
      if (view.state.readOnly) return;
      const at = view.posAtDOM(row);
      const open = view.state.doc.lineAt(at);
      const body = Math.min(open.to + 1, view.state.doc.length);
      view.dispatch({
        selection: { anchor: body },
        userEvent: "select.pointer",
        scrollIntoView: true,
      });
      view.focus();
    });
    return row;
  }

  /* The row handles its own press; see the class comment. */
  ignoreEvent(): boolean {
    return true;
  }
}
