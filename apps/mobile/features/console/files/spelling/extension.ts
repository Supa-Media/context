/**
 * Spelling in the note editor, the Google Docs way (Dev2, 2026-10-27, boards
 * 1–5 in the project's `spelling-suggestions/`).
 *
 * ## Why our own checker and not the browser's
 *
 * The browser drew the red line and kept the suggestions in its own context
 * menu, which a page may not open, read or add to. So the note's menu could
 * only point at Shift-right-click, and the desktop app's route to the
 * operating system's checker (`webFrame` behind `window.desktop.spelling`)
 * came back empty in practice. A checker of our own is the one way to put the
 * fix under the word somebody clicked — and it is the same checker on the web,
 * in the Mac app and in a phone browser.
 *
 * ## What this extension does
 *
 *  - **Underlines** misspelled words in the visible part of the note, with a
 *    mark decoration (`cm-misspelled`). Code, links, addresses, tags, front
 *    matter and note links are left alone — `words.ts` for what characters
 *    say, `skippedNodes` here for what the parser says. A note somebody may
 *    only read is not underlined at all: every answer to an underline is an
 *    edit.
 *  - **Leaves the word being typed alone** until the caret leaves it, as Docs
 *    does: a half-typed word is not a mistake yet.
 *  - **Opens the card** on a plain click on an underlined word, through the
 *    `spellingCard` facet — the editor host decides what a card is
 *    (`LiveEditor.web.tsx` uses its menu, which is a popover on a wide window
 *    and a sheet on a narrow one).
 *  - **Switches the browser's checker off** while ours is running, so nothing
 *    is underlined twice, and back on when ours has no dictionary (offline on
 *    a first visit), so checking never goes silent.
 *  - Holds the words ignored **in this note**, until the note is closed.
 */

import { syntaxTree } from "@codemirror/language";
import { Prec, StateEffect, StateField, type EditorState, type Extension, Facet } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { frontmatterBlock } from "../livePreview/frontmatter";
import { ensureDictionary, getSpelling, isKnownWord, subscribeSpelling, type SpellingSnapshot } from "./store";
import { noteLinkRanges, wordsIn, type WordRange } from "./words";

/** A misspelled word, with the dictionary's suggestions. */
export interface Misspelling extends WordRange {
  suggestions: string[];
}

/** Where a card for one word should open: the word's bottom-left corner, on screen. */
export interface SpellingCardRequest {
  misspelling: Misspelling;
  x: number;
  y: number;
}

/**
 * What a plain click on an underlined word does. Supplied by the editor's
 * host; absent means clicks are only clicks, and right-click still has the
 * suggestions.
 */
export const spellingCard = Facet.define<(request: SpellingCardRequest) => void, ((request: SpellingCardRequest) => void) | null>({
  combine: (values) => values[0] ?? null,
});

/** The parser's names for text that is not prose. */
const SKIPPED_NODES = new Set([
  "InlineCode",
  "FencedCode",
  "CodeBlock",
  "CodeText",
  "CodeInfo",
  "URL",
  "Autolink",
  "LinkReference",
  "HTMLTag",
  "HTMLBlock",
  "Comment",
  "CommentBlock",
  "ProcessingInstruction",
  "ProcessingInstructionBlock",
  "Tag",
]);

const ignoreWord = StateEffect.define<string>();
const forgetIgnored = StateEffect.define<null>();
/** The store changed: new words, a dictionary arrived, checking switched off. */
const spellingChanged = StateEffect.define<null>();

/** Words ignored in this note, lower-cased. Cleared when the note is closed. */
const ignoredWords = StateField.define<ReadonlySet<string>>({
  create: () => new Set(),
  update(value, transaction) {
    let next = value;
    for (const effect of transaction.effects) {
      if (effect.is(forgetIgnored)) next = new Set();
      else if (effect.is(ignoreWord)) next = new Set([...next, effect.value.toLowerCase()]);
    }
    return next;
  },
});

/** Ignore one word until the note is closed. */
export function ignoreInNote(view: EditorView, word: string): void {
  view.dispatch({ effects: ignoreWord.of(word) });
}

/** The note was closed: everything ignored in it counts again. */
export function forgetIgnoredWords(view: EditorView): void {
  view.dispatch({ effects: forgetIgnored.of(null) });
}

/** Whether our checker is the one drawing underlines right now. */
export function checkerRunning(state: SpellingSnapshot = getSpelling()): boolean {
  return state.status === "ready";
}

/**
 * The misspelled word at a document position, with suggestions, or `null`.
 *
 * Shared by the click card and the right-click menu so both offer exactly
 * what the underline promised. `null` on a note somebody may only read.
 */
export function misspellingAt(state: EditorState, position: number | null): Misspelling | null {
  if (position === null || state.readOnly) return null;
  const spelling = getSpelling();
  if (!checkerRunning(spelling) || spelling.speller === null) return null;
  const line = state.doc.lineAt(position);
  const skipped = skippedRanges(state, line.from, line.to);
  const ignored = state.field(ignoredWords, false) ?? new Set<string>();
  for (const word of wordsIn(line.text, line.from)) {
    if (position < word.from || position > word.to) continue;
    if (overlaps(skipped, word) || ignored.has(word.word.toLowerCase()) || isKnownWord(spelling, word.word)) return null;
    return { ...word, suggestions: spelling.speller.suggest(word.word) };
  }
  return null;
}

/**
 * Ranges in `[from, to)` the parser says are not prose, plus the front matter
 * and note links, sorted by start.
 */
function skippedRanges(state: EditorState, from: number, to: number): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  const front =
    state.doc.sliceString(0, 3) === "---"
      ? frontmatterBlock(state.doc.sliceString(0, Math.min(state.doc.length, 64 * 1024)))
      : null;
  if (front !== null && front.from < to && front.to > from) ranges.push(front);
  syntaxTree(state).iterate({
    from,
    to,
    enter: (node) => {
      if (!SKIPPED_NODES.has(node.name)) return;
      ranges.push({ from: node.from, to: node.to });
      return false;
    },
  });
  for (let line = state.doc.lineAt(from); ; line = state.doc.line(line.number + 1)) {
    ranges.push(...noteLinkRanges(line.text, line.from));
    if (line.to >= to || line.number >= state.doc.lines) break;
  }
  return ranges.sort((a, b) => a.from - b.from);
}

function overlaps(ranges: readonly { from: number; to: number }[], word: { from: number; to: number }): boolean {
  return ranges.some((range) => range.from < word.to && range.to > word.from);
}

const misspelledMark = Decoration.mark({ class: "cm-misspelled" });

class Underlines {
  decorations: DecorationSet;
  /** True from a typed change until the caret moves by any other means. */
  private typing = false;
  private readonly unsubscribe: () => void;

  constructor(private readonly view: EditorView) {
    this.decorations = this.build();
    this.unsubscribe = subscribeSpelling(() => {
      // Asynchronous on purpose: a store change can arrive inside another
      // view's update, and dispatching from there throws.
      queueMicrotask(() => {
        if (this.view.dom.isConnected) this.view.dispatch({ effects: spellingChanged.of(null) });
      });
    });
    /*
      Only a note somebody can write needs the dictionary: a read-only note is
      never underlined. So the homepage's visitor console, which shows notes
      nobody there may edit, never downloads one.
    */
    if (!view.state.readOnly) ensureDictionary();
  }

  update(update: ViewUpdate): void {
    const typed = update.transactions.some((tr) => tr.isUserEvent("input.type") || tr.isUserEvent("input.complete") || tr.isUserEvent("delete.backward"));
    if (typed) this.typing = true;
    else if (update.selectionSet) this.typing = false;
    const relevant =
      update.docChanged ||
      update.viewportChanged ||
      update.selectionSet ||
      update.transactions.some((tr) => tr.effects.some((e) => e.is(spellingChanged) || e.is(ignoreWord) || e.is(forgetIgnored))) ||
      update.startState.readOnly !== update.state.readOnly ||
      syntaxTree(update.startState) !== syntaxTree(update.state);
    if (update.startState.readOnly && !update.state.readOnly) ensureDictionary();
    if (relevant) this.decorations = this.build();
  }

  destroy(): void {
    this.unsubscribe();
  }

  private build(): DecorationSet {
    const { state } = this.view;
    const spelling = getSpelling();
    if (state.readOnly || !checkerRunning(spelling)) return Decoration.none;
    const ignored = state.field(ignoredWords, false) ?? new Set<string>();
    /*
      The word being typed is not a mistake yet: leave the one the caret is at
      the end of alone until the caret leaves it — but only after a typed
      change, so a caret put down by a click after an old mistake still shows
      the mistake.
    */
    const caret = this.typing && state.selection.main.empty ? state.selection.main.head : null;
    const marks = [];
    for (const { from, to } of this.view.visibleRanges) {
      const skipped = skippedRanges(state, from, to);
      for (let pos = from; pos <= to; ) {
        const line = state.doc.lineAt(pos);
        for (const word of wordsIn(line.text, line.from)) {
          if (word.to === caret) continue;
          if (overlaps(skipped, word)) continue;
          if (ignored.has(word.word.toLowerCase()) || isKnownWord(spelling, word.word)) continue;
          marks.push(misspelledMark.range(word.from, word.to));
        }
        if (line.number >= state.doc.lines) break;
        pos = line.to + 1;
      }
    }
    return Decoration.set(marks, true);
  }
}

const underlines = ViewPlugin.fromClass(Underlines, {
  decorations: (plugin) => plugin.decorations,
  eventHandlers: {
    /*
      `click` rather than `mousedown`: by now CodeMirror has put the caret
      where the person clicked, so the card is about the word under the caret
      and closing it leaves them exactly where they meant to be. A drag, a
      double-click selecting the word, or a modifier is a different gesture
      and opens nothing.
    */
    click(event: MouseEvent, view: EditorView) {
      if (event.button !== 0 || event.detail > 1) return false;
      if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false;
      const open = view.state.facet(spellingCard);
      if (open === null || !view.state.selection.main.empty) return false;
      let position: number | null = null;
      try {
        position = view.posAtCoords({ x: event.clientX, y: event.clientY });
      } catch {
        position = null;
      }
      const misspelling = misspellingAt(view.state, position);
      if (misspelling === null) return false;
      let corner: { left: number; bottom: number } | null = null;
      try {
        corner = view.coordsAtPos(misspelling.from);
      } catch {
        corner = null;
      }
      open({
        misspelling,
        x: corner?.left ?? event.clientX,
        y: (corner?.bottom ?? event.clientY) + 4,
      });
      return false;
    },
  },
});

/**
 * The browser's checker, off while ours runs and on while it cannot — and off
 * entirely when the person turned checking off (board 4: "Off means off").
 * Highest precedence so it wins over `editorSetup`'s plain `spellcheck: "true"`.
 */
const browserChecker = Prec.highest(
  EditorView.contentAttributes.of(() => {
    const spelling = getSpelling();
    if (spelling.status === "off") return { spellcheck: "false" };
    return { spellcheck: checkerRunning(spelling) ? "false" : "true" };
  }),
);

const theme = EditorView.baseTheme({
  ".cm-misspelled": {
    textDecorationLine: "underline",
    textDecorationStyle: "wavy",
    textDecorationColor: "var(--cm-misspelled, #D0453A)",
    textDecorationThickness: "1.5px",
    textUnderlineOffset: "3px",
    textDecorationSkipInk: "none",
  },
});

/** Everything above, for a surface that has a store and a card to open. */
export function spelling(): Extension {
  return [ignoredWords, underlines, browserChecker, theme];
}
