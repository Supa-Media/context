/**
 * A note always starts with its `# title`, and the title is always a name a
 * file can have.
 *
 * **"files have to have a header, like a beginning header, … that you can't
 * remove, … the starting hashtag as well. And yeah, it just means that they
 * have to have valid file names as a header"** (owner, 2026-10-14). The title
 * is the file's name (`linkedTitle.ts`), so a note with no title has a name
 * nobody can see or edit from the page, and a title holding a slash names a
 * file that cannot exist. This keeps both from happening while somebody types:
 *
 *  - **The `#` stays.** An edit that would take a titled note's first line out
 *    of being a `# ` heading — backspacing into the marker, `## `, deleting the
 *    line — does not happen. Clearing the whole note (select all, then type)
 *    keeps the marker in front of whatever was typed.
 *  - **The title stays nameable.** A keystroke that would put a slash, a
 *    backslash, a control character or a leading dot into the title does not
 *    happen — the same set `describeNameProblem` refuses for a name.
 *  - **A note with no heading gets one on its first edit**: `# <its name>`,
 *    above what was there. Opening it changes nothing; a note is never
 *    rewritten by being looked at.
 *
 * Only what a person types is held to this. A document put on screen, a
 * collaborator's edit arriving through the shared room, undo and redo all go
 * through untouched — those are not this person's keystroke to refuse, and
 * refusing one would split the buffer from the room. Address names
 * (`nameIsAddress`: `index.md`, `about.md`, a website page) and drawings are
 * left alone, as `linkedTitle.ts` leaves them.
 *
 * One `transactionFilter` in `editorExtensions`, so the web editor and the
 * native editor's WebView guest get the same rule from the same code.
 */

import { ChangeSet, EditorState, type Extension, type Transaction, type TransactionSpec } from "@codemirror/state";
import { isDrawingPath } from "@context/drawings";
import { nameIsAddress } from "./addressNames";
import { titleRange } from "./liveEditorWeb/titleLine";
import { noteNameOf } from "./noteName";
import { describeNameProblem } from "./paths";
import { titleFor } from "./untitled";

/** `path()` is the note being edited, read at call time; `null` holds nothing. */
export function titleLock(path: () => string | null): Extension {
  return EditorState.transactionFilter.of((transaction) => lockTitle(transaction, path()));
}

/** The filter itself, for tests: the transaction as it should be, or `[]` to drop it. */
export function lockTitle(
  transaction: Transaction,
  path: string | null,
): Transaction | readonly (Transaction | TransactionSpec)[] {
  if (!transaction.docChanged || !typed(transaction)) return transaction;
  if (path === null || nameIsAddress(path) || isDrawingPath(path)) return transaction;
  const before = transaction.startState;
  const after = transaction.state;
  const was = titleRange(before);
  const is = titleRange(after);

  if (is !== null) {
    const title = titleFor(after.doc.toString());
    if (title === null || title === titleFor(before.doc.toString())) return transaction;
    // Refused only when this edit made it so: a title that was already no
    // name (written elsewhere, before this rule) can still be edited back
    // into one.
    if (nameProblem(title) !== null && (was === null || nameProblem(titleFor(before.doc.toString())) === null)) {
      return [];
    }
    return transaction;
  }

  const line = firstContentLine(after);
  const startsAHeading = line !== null && /^\s*#/.test(line.text);
  if (was !== null) {
    // The title was there and this edit takes it away. Typed over the whole
    // note, the marker goes back in front of what was typed; anything else —
    // backspace into `# `, `## `, deleting the line — does not happen.
    if (startsAHeading || line === null || !insertedInto(transaction, line.from, line.to)) {
      if (line !== null || !emptyAfterFrontMatter(after)) return [];
      // Frontmatter with nothing after it, not even a line break, takes one.
      const lead = firstLineNumber(after) > after.doc.lines ? "\n" : "";
      return withPrefix(transaction, contentStart(after), `${lead}# `);
    }
    return withPrefix(transaction, line.from, "# ");
  }

  // No title before either. Somebody writing a heading by hand gets to finish
  // it; a blank line is not yet anything to name.
  if (startsAHeading || line === null) return transaction;
  if (firstContentLine(before) === null) return withPrefix(transaction, line.from, "# ");
  return withPrefix(transaction, line.from, `# ${noteNameOf(path).text}\n\n`);
}

/** Input, deletion, a paste or a drop: a person at the keyboard. */
function typed(transaction: Transaction): boolean {
  return (
    transaction.isUserEvent("input") || transaction.isUserEvent("delete") || transaction.isUserEvent("move")
  );
}

function nameProblem(title: string | null): string | null {
  if (title === null) return null;
  return describeNameProblem(`${title}.md`);
}

/** The first line after the frontmatter, counted the way `titleRange` counts. */
function firstLineNumber(state: EditorState): number {
  const doc = state.doc;
  if (doc.line(1).text.trim() !== "---") return 1;
  let number = 2;
  while (number <= doc.lines && doc.line(number).text.trim() !== "---") number += 1;
  return number + 1;
}

/** Where the writing starts: after the frontmatter, when there is some. */
function contentStart(state: EditorState): number {
  const number = firstLineNumber(state);
  return number > state.doc.lines ? state.doc.length : state.doc.line(number).from;
}

/** The line `titleRange` reads the title from, whether or not it is one. */
function firstContentLine(state: EditorState): { from: number; to: number; text: string } | null {
  const doc = state.doc;
  let number = firstLineNumber(state);
  while (number <= doc.lines && doc.line(number).text.trim() === "") number += 1;
  if (number > doc.lines) return null;
  const line = doc.line(number);
  return { from: line.from, to: line.to, text: line.text };
}

function emptyAfterFrontMatter(state: EditorState): boolean {
  return state.doc.sliceString(contentStart(state)).trim() === "";
}

/** Whether this edit put text on `[from, to]` of the new document. */
function insertedInto(transaction: Transaction, from: number, to: number): boolean {
  let touched = false;
  transaction.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    if (toB > fromB && fromB <= to && toB >= from) touched = true;
  });
  return touched;
}

/** The edit, then `insert` at `at` of the document it left, caret carried past it. */
function withPrefix(transaction: Transaction, at: number, insert: string): readonly (Transaction | TransactionSpec)[] {
  const changes = ChangeSet.of({ from: at, insert }, transaction.newDoc.length);
  return [
    transaction,
    { changes: { from: at, insert }, selection: transaction.newSelection.map(changes, 1), sequential: true },
  ];
}
