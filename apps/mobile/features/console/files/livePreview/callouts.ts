/**
 * Obsidian callouts: which blockquotes are callouts, and the title widget a
 * callout with no title of its own is drawn with.
 *
 * Part of the Live Preview extension; `../livePreview.ts` is the facade that
 * re-exports the public names and holds the module map.
 */

import type { EditorState } from "@codemirror/state";
import { WidgetType } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { TextRange } from "./reveal";

/* -------------------------------------------------------------------------- */
/*                                  callouts                                  */
/* -------------------------------------------------------------------------- */

/**
 * One Obsidian callout: a blockquote whose first line opens with `[!type]`.
 *
 * ## Why this exists
 *
 * Reported with a screenshot of a plugin's output beside the same note in
 * Obsidian — *"this plugin shows up weird, compare to how it shows up in
 * obsidian"* — and it was never the plugin. It writes
 * `> [!bible] [John 3:16 - NIV](…)`, which is an ordinary callout, and this
 * editor had no idea what one was: `[!bible]` parsed as a shortcut link, its
 * brackets were hidden like any other `LinkMark`, and the reader was left with
 * the word `!bible` underlined in blue in front of the reference. Every
 * `[!note]`, `[!warning]` and `[!tip]` in anybody's vault read the same way; a
 * plugin is only what finally put one on screen next to its original.
 *
 * ## Not in the grammar, so read off the text
 *
 * lezer-markdown has no callout node — callouts are Obsidian's extension, not
 * CommonMark — so this is the same shape as `frontmatterRange` and for the same
 * stated reason: the tree gives the blockquote, and the first line's text gives
 * the rest. Matching on the text of a line the tree has already called a
 * `Blockquote` is what keeps `[!note]` in the middle of a sentence from
 * becoming a box.
 *
 * ## What is deliberately not drawn
 *
 * Per-type colours and icons. Obsidian has thirteen of each, and thirteen
 * palette entries would have to cross the WebView bridge to get here — against
 * this file's own standing restraint about palette-specific tokens. The icon in
 * the report's screenshot is not Obsidian's either: it is the plugin's own CSS,
 * and Context does not load a plugin's stylesheet into the trusted realm.
 *
 * Folding is not implemented, and the `+`/`-` that asks for it is consumed as
 * part of the marker rather than left behind. A callout that will not fold is
 * legible; half a marker on screen is the bug this whole function is fixing,
 * one character smaller.
 */
export interface Callout {
  /** Where the `[!type]` marker starts — the callout's first line. */
  readonly from: number;
  /** The start of every line in the blockquote, first one first. */
  readonly lines: readonly number[];
  /** The type as written, lowercased: `note`, `warning`, `bible`. */
  readonly type: string;
  /** The marker and the space after it — what is replaced or hidden. */
  readonly marker: TextRange;
  /**
   * The `>` prefix of each line, which a callout hides and a quote does not.
   *
   * This file's `HIDDEN_MARKS` comment is emphatic that `QuoteMark` must never
   * be hidden — "a blockquote with its `>` removed reflows into the paragraph
   * above it and the reader cannot see the quote at all" — and that is exactly
   * right for a quote and exactly wrong for a callout, because the box says the
   * same thing the `>` was saying. Obsidian hides them for the same reason, and
   * leaving them in is the last visible difference from the screenshot this
   * work came from.
   */
  readonly marks: readonly TextRange[];
  /** What the author wrote after the marker, or `null` when they wrote none. */
  readonly title: string | null;
}

/**
 * `[!type]`, optionally `+` or `-`, optionally a title.
 *
 * Anchored at the start of the quoted text so a marker further into the line
 * stays prose — somebody writing *about* a callout inside a quote is not
 * writing one, and rewriting their sentence into a box would be this editor
 * editing what it was asked to display.
 *
 * The type is `[^\]]+` rather than a list of the thirteen Obsidian knows:
 * an unknown type is still a callout there, which is exactly why `[!bible]`
 * worked in the screenshot that started this, and a closed list here would put
 * this editor back to leaking the marker for every plugin and every vault that
 * defines one of its own.
 */
const CALLOUT_MARKER = /^\[!([^\]\s]+)\]([+-]?)[ \t]*/;

/** Where the `>` markers end and the quoted text begins, on one line. */
function afterQuoteMarks(text: string): number {
  let at = 0;
  while (at < text.length) {
    const ch = text[at];
    if (ch === ">" || ch === " " || ch === "\t") at += 1;
    else break;
  }
  return at;
}

export function callouts(state: EditorState, frontEnd = 0): Callout[] {
  const found: Callout[] = [];
  syntaxTree(state).iterate({
    from: 0,
    to: state.doc.length,
    enter(node) {
      if (node.from < frontEnd) return;
      if (node.name !== "Blockquote") return;
      /*
        A nested `> > [!note]` matches too, and is meant to: Obsidian nests
        callouts and the marker has to come off either way. What it does not get
        is a second box — these are line decorations, and a line already inside
        one cannot be inside another. Its title is still styled as a title, so a
        nested callout reads as a heading inside the outer box rather than as a
        box this editor cannot draw.
      */
      const first = state.doc.lineAt(node.from);
      const quoted = afterQuoteMarks(first.text);
      const match = CALLOUT_MARKER.exec(first.text.slice(quoted));
      if (match === null) return;

      /*
        Lines that START inside the quote, which is stricter than `tableLines`'
        walk and has to be. A Blockquote's `to` can sit on the newline that ends
        its last line, so "stop once this line reaches `to`" lets the blank line
        after the callout in — and a line decoration there draws an empty row of
        box under it. Caught in a real engine rather than in jsdom, which lays
        nothing out and was perfectly happy with three.
      */
      const lines: number[] = [];
      for (let line = first; line.from < node.to; ) {
        lines.push(line.from);
        if (line.to >= state.doc.length) break;
        line = state.doc.lineAt(line.to + 1);
      }

      const start = first.from + quoted;
      const rest = first.text.slice(quoted + match[0].length);
      const marks: TextRange[] = [];
      for (const from of lines) {
        const width = afterQuoteMarks(state.doc.lineAt(from).text);
        if (width > 0) marks.push({ from, to: from + width });
      }
      found.push({
        from: start,
        lines,
        type: match[1].toLowerCase(),
        marker: { from: start, to: start + match[0].length },
        marks,
        title: rest.length > 0 ? rest : null,
      });
    },
  });
  return found;
}

/**
 * The type, drawn as the title of a callout the author gave no title.
 *
 * Obsidian does the same, and the alternative is worse than it sounds: hiding
 * the marker on a bare `> [!warning]` leaves an empty `> `, which reads as a
 * blank first line of the box rather than as its heading.
 *
 * Title-cased on the first letter only. `not-a-real-type` stays as it was
 * written rather than being prettified into something the file does not say —
 * this is a label for what is in the note, not a name this editor invents.
 */
export function calloutLabel(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

export class CalloutTitleWidget extends WidgetType {
  /**
   * What the reader sees where the marker was.
   *
   * A field rather than something only `toDOM` knows, so the rule is assertable
   * without a DOM — the rest of this file's tests run against a real tree and no
   * browser, and a label that could only be checked by rendering would be the
   * one piece of this feature nothing pinned.
   */
  readonly label: string;

  constructor(readonly type: string) {
    super();
    this.label = calloutLabel(type);
  }

  eq(other: CalloutTitleWidget): boolean {
    return other.type === this.type;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "cm-lp-callout-label";
    const span = document.createElement("span");
    span.className = "cm-lp-callout-type";
    span.textContent = this.label;
    wrap.append(iconElement(this.type), span);
    return wrap;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/*                               the quiet card                               */
/* -------------------------------------------------------------------------- */

/*
  One stroke icon per family of types, drawn in the line's own colour. Not the
  per-type palette the header of this file declines: an icon is a shape in
  `currentColor`, so it crosses no bridge and names no colour. Constant markup,
  never built from the note — the type only picks which one.
*/
const ICON_PATHS: Readonly<Record<string, string>> = {
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>',
  alert: '<path d="M12 3 2 21h20z"/><path d="M12 10v5"/><path d="M12 18h.01"/>',
  bulb: '<path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7V16h8v-1.3A7 7 0 0 0 12 2z"/>',
  quote: '<path d="M7 7h4v4c0 3-2 5-4 6"/><path d="M15 7h4v4c0 3-2 5-4 6"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  note: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
};

/** Which icon a type is drawn with; anything unknown is a note. */
export function calloutIcon(type: string): keyof typeof ICON_PATHS {
  switch (type) {
    case "bible":
    case "scripture":
    case "verse":
    case "cite":
      return "book";
    case "warning":
    case "caution":
    case "attention":
    case "danger":
    case "error":
    case "bug":
    case "failure":
    case "fail":
    case "missing":
      return "alert";
    case "tip":
    case "hint":
    case "important":
    case "idea":
      return "bulb";
    case "quote":
      return "quote";
    case "success":
    case "check":
    case "done":
      return "check";
    default:
      return "note";
  }
}

function iconElement(type: string): HTMLElement {
  const holder = document.createElement("span");
  holder.className = "cm-lp-callout-icon";
  holder.setAttribute("aria-hidden", "true");
  holder.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[calloutIcon(type)]}</svg>`;
  return holder;
}

/**
 * What a titled callout's marker is drawn as: its icon, its type, and a dot
 * before the author's title. Design A's one quiet line — the type is said once,
 * small, and the title carries the weight.
 */
export class CalloutBadgeWidget extends WidgetType {
  readonly label: string;

  constructor(readonly type: string) {
    super();
    this.label = calloutLabel(type);
  }

  eq(other: CalloutBadgeWidget): boolean {
    return other.type === this.type;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-lp-callout-badge";
    const label = document.createElement("span");
    label.className = "cm-lp-callout-badge-type";
    label.textContent = this.label;
    const dot = document.createElement("span");
    dot.className = "cm-lp-callout-badge-dot";
    dot.textContent = "·";
    span.append(iconElement(this.type), label, dot);
    return span;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/** The ↗ after a title that is a link, so it reads as one without an underline. */
export class CalloutArrowWidget extends WidgetType {
  eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-lp-callout-arrow";
    span.setAttribute("aria-hidden", "true");
    span.innerHTML =
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7"/><path d="M8 7h9v9"/></svg>';
    return span;
  }

  ignoreEvent(): boolean {
    return false;
  }
}
