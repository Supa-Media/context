/**
 * Spelling in the note editor: Context's own checker, whose fixes sit on top
 * of the note's right-click menu (Dev2, 2026-10-27, boards in the project's
 * `spelling-suggestions/`).
 *
 * ## Why our own checker and not the browser's
 *
 * The browser kept its suggestions in its own context menu, which a page may
 * not open, read or add to. So the note's menu could only point at
 * Shift-right-click, and the desktop app's route to the operating system's
 * checker (`webFrame` behind `window.desktop.spelling`) came back empty in
 * practice. A checker of our own is the one way to put the fix in the menu of
 * the word somebody right-clicked — and it is the same checker on the web, in
 * the Mac app and in a phone browser (a long press).
 *
 * ## No red line (Dev2, 2026-10-28)
 *
 * The first build drew a wavy red underline under every misspelled word and
 * opened a card on a plain click. Notes are full of names and coined words,
 * so the line marked almost everything and took over the page. Dev2 asked to
 * leave the line out and keep the suggestions: nothing is drawn, a plain click
 * is only a click, and the fixes are in the right-click menu. With no line to
 * point at it, a card opening on a click would come out of nowhere.
 *
 * ## What this extension does
 *
 *  - **Finds the misspelled word** under a right-click (`misspellingAt`).
 *    Code, links, addresses, tags, front matter and note links are left
 *    alone — `words.ts` for what characters say, `SKIPPED_NODES` here for
 *    what the parser says. A note somebody may only read gets no fixes:
 *    every fix is an edit.
 *  - **Loads the dictionary** the first time a note somebody can write opens.
 *  - **Switches the browser's checker off** so it draws no line either, and
 *    back on only when ours could not load (offline on a first visit), so
 *    checking never goes silent.
 *  - Holds the words ignored **in this note**, until the note is closed.
 */

import { syntaxTree } from "@codemirror/language";
import { Prec, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { frontmatterBlock } from "../livePreview/frontmatter";
import { ensureDictionary, getSpelling, isKnownWord, subscribeSpelling, type SpellingSnapshot } from "./store";
import { noteLinkRanges, wordsIn, type WordRange } from "./words";

/** A misspelled word, with the dictionary's suggestions. */
export interface Misspelling extends WordRange {
  suggestions: string[];
}

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

/** Whether our checker has its dictionary and is answering right now. */
export function checkerRunning(state: SpellingSnapshot = getSpelling()): boolean {
  return state.status === "ready";
}

/**
 * The misspelled word at a document position, with suggestions, or `null`.
 *
 * What the right-click menu offers on top. `null` on a note somebody may
 * only read.
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

/**
 * Keeps the dictionary loading and the browser's checker attribute current.
 * Draws nothing.
 */
class Checker {
  private readonly unsubscribe: () => void;

  constructor(private readonly view: EditorView) {
    this.unsubscribe = subscribeSpelling(() => {
      /*
        Asynchronous on purpose: a store change can arrive inside another
        view's update, and dispatching from there throws. The dispatch makes
        CodeMirror read `browserChecker` again.
      */
      queueMicrotask(() => {
        if (this.view.dom.isConnected) this.view.dispatch({ effects: spellingChanged.of(null) });
      });
    });
    /*
      Only a note somebody can write needs the dictionary: a read-only note
      gets no fixes. So the homepage's visitor console, which shows notes
      nobody there may edit, never downloads one.
    */
    if (!view.state.readOnly) ensureDictionary();
  }

  update(update: ViewUpdate): void {
    if (update.startState.readOnly && !update.state.readOnly) ensureDictionary();
  }

  destroy(): void {
    this.unsubscribe();
  }
}

const checker = ViewPlugin.fromClass(Checker);

/**
 * The browser's checker, which draws a red line, so off — on only when ours
 * could not load its dictionary, and never when the person turned checking
 * off (board 4: "Off means off"). Off while ours is still loading too, so the
 * line does not flash up for the moment before it arrives. Highest precedence
 * so it wins over `editorSetup`'s plain `spellcheck: "true"`.
 */
const browserChecker = Prec.highest(
  EditorView.contentAttributes.of(() => ({ spellcheck: getSpelling().status === "failed" ? "true" : "false" })),
);

/** Everything above, for a surface whose right-click menu offers the fixes. */
export function spelling(): Extension {
  return [ignoredWords, checker, browserChecker];
}
