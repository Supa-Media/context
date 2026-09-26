/**
 * Spelling suggestions for the note's right-click menu.
 *
 * The note replaces the browser's context menu with its own, and the browser's
 * menu is the only place a page's spelling suggestions live — the web has no
 * API for "is this word underlined" or "what would you suggest". So there are
 * two answers, one per host:
 *
 *  - **The desktop app asks the operating system's checker** through
 *    `window.desktop.spelling` (bridge version 8) — the same checker that drew
 *    the red underline — and the suggestions go at the top of the menu, where
 *    every browser puts them.
 *  - **A browser gets a signpost.** Shift-right-click has always fallen
 *    through to the browser's own menu (see `contextMenuListener`), but
 *    nothing said so, and a red underline with no suggestions under it reads
 *    as a broken feature. The menu now says where they are.
 */

import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { getDesktopBridge, type SpellingCheck } from "@context/desktop-bridge";

/** A misspelled word the menu was opened on, and what the checker offered. */
export interface SpellingFix {
  from: number;
  to: number;
  word: string;
  suggestions: string[];
}

export type SpellingChecker = (word: string) => Promise<SpellingCheck>;

/**
 * The shell's checker, or `null` in a browser and in a shell from before
 * version 8. Read per right-click rather than once, like every other bridge
 * member the console asks for: it is cheap, and it cannot go stale.
 */
export function desktopSpeller(): SpellingChecker | null {
  const spelling = getDesktopBridge()?.spelling;
  if (spelling === undefined) return null;
  return (word) => spelling.check(word);
}

/**
 * Whether Shift-right-click is a gesture this person has.
 *
 * A phone reaches this menu by a long press, and telling it about a Shift key
 * is a row about somebody else's computer. No `matchMedia` at all is read as
 * a pointer: that is an old desktop engine, not a phone.
 */
export function hasFinePointer(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  try {
    return window.matchMedia("(any-pointer: fine)").matches;
  } catch {
    return true;
  }
}

/**
 * The word under a document position, or `null` for anything that is not one.
 *
 * CodeMirror's own `wordAt`, so a word is what double-click would select. A
 * run with no letter in it — a number, a date — is not something to spell.
 */
export function wordUnder(
  state: EditorState,
  position: number | null,
): { from: number; to: number; word: string } | null {
  if (position === null) return null;
  const range = state.wordAt(position);
  if (range === null || range.empty) return null;
  const word = state.sliceDoc(range.from, range.to);
  if (!/\p{L}/u.test(word)) return null;
  return { from: range.from, to: range.to, word };
}

/**
 * Put a suggestion in place of the word the menu was opened on.
 *
 * Only while the range still says what it said. The check is a promise and
 * the menu waits on a person, and an autosave conflict or a collaborator can
 * move text into that range meanwhile — replacing whatever arrived there would
 * be an edit nobody chose. Returns whether it wrote.
 */
export function applySpellingFix(view: EditorView, fix: SpellingFix, suggestion: string): boolean {
  if (view.state.readOnly) return false;
  if (view.state.sliceDoc(fix.from, fix.to) !== fix.word) return false;
  view.dispatch({
    changes: { from: fix.from, to: fix.to, insert: suggestion },
    selection: { anchor: fix.from + suggestion.length },
    userEvent: "input.spelling",
  });
  return true;
}
