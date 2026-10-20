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
 *  - **A title with no words has no `#`.** Deleting a title's words takes
 *    the marker with them, and the inline title ("Name this note") above
 *    shows the name instead: **"theres a "Name this note" section at the
 *    top, and then an undeletable header # right below it, we can just get
 *    rid of the #"** (owner, 2026-10-14). Typing on that emptied line makes
 *    a title again, and a bare `#` already in a note can be deleted.
 *  - **The title stays nameable.** A keystroke that would put a slash, a
 *    backslash, a control character or a leading dot into the title does not
 *    happen — the same set `describeNameProblem` refuses for a name.
 *  - **A note with no heading gets one on its first edit**: `# <its name>`,
 *    above what was there. Opening it changes nothing; a note is never
 *    rewritten by being looked at. An empty note is no different: what is
 *    typed into it is its body, under its name. It used to become the title,
 *    and a quick note made that way could not be written in at all —
 *    everything typed renamed it (reported 2026-10-19). The name field above
 *    an empty note is where its title is typed.
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
  const beforeTitle = titleFor(before.doc.toString());
  // A heading with no words is not a title: the inline title stands in for
  // it, so its `#` is nobody's to keep.
  const was = titleRange(before) !== null && beforeTitle !== null;

  if (titleRange(after) !== null) {
    const title = titleFor(after.doc.toString());
    if (title !== null) {
      if (title === beforeTitle) return transaction;
      // Refused only when this edit made it so: a title that was already no
      // name (written elsewhere, before this rule) can still be edited back
      // into one.
      if (nameProblem(title) !== null && (!was || nameProblem(beforeTitle) === null)) return [];
      return transaction;
    }
  }

  const line = firstContentLine(after);
  const startsAHeading = line !== null && /^\s*#/.test(line.text);
  if (was) {
    // The title was there and this edit takes it away. Cleared with the rest
    // of the note, or its words deleted, the name above stands in for it and
    // a bare `#` would only sit under it; typed over, the marker goes back in
    // front of what was typed. Anything else — backspace into `# `, `## `,
    // deleting the line from the body up — does not happen.
    if (line === null) return transaction;
    if (/^\s*#\s*$/.test(line.text) && !insertsText(transaction)) {
      return withEdit(transaction, { from: line.from, to: line.to });
    }
    if (startsAHeading || !insertedInto(transaction, line.from, line.to)) return [];
    return withEdit(transaction, { from: line.from, insert: "# " });
  }

  // No title before either. Somebody writing a heading by hand gets to finish
  // it, a bare `#` left from before may go, and only typing adds a heading:
  // a blank line is not yet anything to name, and a deletion conjures nothing.
  if (startsAHeading || line === null || !insertsText(transaction)) return transaction;
  const prior = firstContentLine(before);
  if (prior !== null && /^\s*#/.test(prior.text)) return transaction;
  // Typed on a line of its own above the writing, as after a title's words
  // were deleted: what is typed is the title. Into an empty note, it is not.
  if (prior !== null && transaction.changes.mapPos(prior.from, 1) > line.to) {
    return withEdit(transaction, { from: line.from, insert: "# " });
  }
  return withEdit(transaction, { from: line.from, insert: `# ${noteNameOf(path).text}\n\n` });
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

/** The line `titleRange` reads the title from, whether or not it is one. */
function firstContentLine(state: EditorState): { from: number; to: number; text: string } | null {
  const doc = state.doc;
  let number = firstLineNumber(state);
  while (number <= doc.lines && doc.line(number).text.trim() === "") number += 1;
  if (number > doc.lines) return null;
  const line = doc.line(number);
  return { from: line.from, to: line.to, text: line.text };
}

/** Whether this edit put text on `[from, to]` of the new document. */
function insertedInto(transaction: Transaction, from: number, to: number): boolean {
  let touched = false;
  transaction.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    if (toB > fromB && fromB <= to && toB >= from) touched = true;
  });
  return touched;
}

/** Whether this edit put any text in. */
function insertsText(transaction: Transaction): boolean {
  let inserted = false;
  transaction.changes.iterChanges((_fromA, _toA, _fromB, _toB, text) => {
    if (text.length > 0) inserted = true;
  });
  return inserted;
}

/** The edit, then `change` to the document it left, caret carried past it. */
function withEdit(
  transaction: Transaction,
  change: { from: number; to?: number; insert?: string },
): readonly (Transaction | TransactionSpec)[] {
  const changes = ChangeSet.of(change, transaction.newDoc.length);
  return [transaction, { changes: change, selection: transaction.newSelection.map(changes, 1), sequential: true }];
}
