import type { FileBrowser } from "./browser";
import { findEntry, targetFolder } from "./tree";
import { isMarkdown, parentPath, restoreTargetFor } from "./paths";
import type { FolderListing } from "./types";

/**
 * What a file command means when it arrives from the keyboard.
 *
 * ## The gap this closes
 *
 * `menu.ts` prints a chord beside nine of its rows — `F2`, `⌘D`, `⌘⇧M`, `⌘C`,
 * `⌘X`, `⌘V`, `⌘⌫`, `⌘⇧⌫` — and routes every one through `describeBinding` so
 * that, in its own words, "a chord the menu prints is a chord that exists".
 * That guarantees the chord is in `BINDINGS`. It does not guarantee anything is
 * listening, and nothing was: the console's keyboard handler answered these ten
 * commands with `return false` under a comment saying "`Explorer` binds them
 * itself", and `Explorer` binds no key at all. Every chord the row menu
 * advertised was dead.
 *
 * ## Why the tree and the keyboard do not share one switch
 *
 * They take different input, and folding them together would mean inventing one
 * for whichever caller lacks it. `Explorer.runAction` acts on **the row under
 * the pointer** — the row that was right-clicked or long-pressed, which may not
 * be the selected one. A keystroke has no pointer, so it acts on **the
 * selection**, and on nothing when there is none.
 *
 * What they must agree about is *which commands are available at all*, and that
 * is what lives here: the `canEdit` rule and the read-only rule, stated once,
 * in a module a test can drive without a renderer. Both are `menu.ts`'s, and
 * both are load-bearing —
 *
 *  - **No `canEdit`, no command.** A read-only browser carries every mutating
 *    method and they are inert (`browser.ts`), so a keystroke that reached one
 *    would look like it worked and do nothing at all. `menu.ts` refuses to draw
 *    the item for exactly this reason; the keyboard cannot be the way in.
 *  - **A read-only row is not a target.** `privacy.md` is generated, and the
 *    console's every write path refuses it. Offering `F2` on it would raise a
 *    rename dialog whose Save is refused at the server.
 *
 * Everything else — the dialogs, the clipboard, the file actions — stays with
 * the caller, because *raising* a dialog is a question about which component
 * owns it and this module has no view.
 */

/** The commands this module answers for. The rest of `Command` is not ours. */
export type RowCommand =
  | "newNote"
  | "newFolder"
  | "rename"
  | "duplicate"
  | "moveTo"
  | "copy"
  | "cut"
  | "paste"
  | "archive"
  | "deleteForever";

export const ROW_COMMANDS: readonly RowCommand[] = [
  "newNote",
  "newFolder",
  "rename",
  "duplicate",
  "moveTo",
  "copy",
  "cut",
  "paste",
  "archive",
  "deleteForever",
];

/**
 * What to do, resolved against the selection.
 *
 * The first six carry the same tags as `Explorer`'s `Dialog` union, so a caller
 * holding one of those hands it straight to `ExplorerDialogs` rather than
 * translating — two spellings of "the rename dialog" is two things to keep in
 * step.
 */
export type RowIntent =
  | { kind: "newNote"; folder: string }
  | { kind: "newFolder"; folder: string }
  | { kind: "rename"; path: string }
  | { kind: "move"; path: string }
  | { kind: "archive"; path: string }
  | { kind: "delete"; path: string; isFolder: boolean }
  | { kind: "duplicate"; path: string }
  | { kind: "copy"; path: string }
  | { kind: "cut"; path: string }
  | { kind: "paste"; folder: string }
  | { kind: "restore"; path: string; to: string };

export interface RowContext {
  canEdit: boolean;
  selectedPath: string | null;
  listings: Readonly<Record<string, FolderListing | undefined>>;
}

export function intentForRowCommand(
  command: RowCommand,
  context: RowContext,
): RowIntent | null {
  if (!context.canEdit) return null;

  const { selectedPath, listings } = context;

  /*
    Creating and pasting need a folder rather than a row, and `targetFolder`
    already answers "which folder is this selection in" for the toolbar's `+`.
    It is total — no selection is the root — so these three work with nothing
    selected, which is the state somebody who has just opened the console is in.
  */
  if (command === "newNote" || command === "newFolder" || command === "paste") {
    const folder = targetFolder(listings, selectedPath);
    return command === "paste" ? { kind: "paste", folder } : { kind: command, folder };
  }

  if (selectedPath === null) return null;

  /*
    `findEntry` answers `null` for a path in a folder that is not loaded — which
    happens, because listings are fetched per folder. Unknown is not read-only:
    refusing there would make a keystroke depend on whether a parent folder
    happened to have been expanded, and the server refuses the writes that
    matter anyway. What is refused is a row we *know* is generated.
  */
  const entry = findEntry(listings, selectedPath);
  if (entry !== null && entry.readOnly) return null;

  const isFolder = entry === null ? !isMarkdown(selectedPath) : entry.kind === "folder";

  switch (command) {
    case "rename":
      return { kind: "rename", path: selectedPath };
    case "moveTo":
      return { kind: "move", path: selectedPath };
    case "duplicate":
      return { kind: "duplicate", path: selectedPath };
    case "copy":
      return { kind: "copy", path: selectedPath };
    case "cut":
      return { kind: "cut", path: selectedPath };
    case "archive": {
      /*
        Already archived, so the recoverable action is undoing that — the same
        substitution `menu.ts` makes, through the same function, so the menu and
        the key cannot disagree about which of the two a row gets.
      */
      const original = restoreTargetFor(selectedPath);
      return original === null
        ? { kind: "archive", path: selectedPath }
        : { kind: "restore", path: selectedPath, to: original };
    }
    case "deleteForever":
      return { kind: "delete", path: selectedPath, isFolder };
  }
}

/**
 * Carry an intent out.
 *
 * Here rather than in the console's keyboard handler so that "every chord the
 * menu prints does something" is a claim a test can make without a renderer —
 * which is the whole reason those chords went four releases doing nothing.
 * Answers **false** for an intent it did not act on, which is what the keymap
 * needs to leave the browser's own behaviour alone.
 *
 * The five direct ones go to the browser; the six that need somebody to type or
 * confirm something go to whoever owns the dialogs. Restore is a move, exactly
 * as it is on the row menu, computed from the archived path rather than
 * remembered.
 */
export function applyRowIntent(
  intent: RowIntent,
  files: Pick<FileBrowser, "duplicate" | "copy" | "cut" | "paste" | "move">,
  onDialog: (dialog: Extract<RowIntent, { kind: DialogKind }>) => void,
): boolean {
  switch (intent.kind) {
    case "duplicate":
      files.duplicate(intent.path);
      return true;
    case "copy":
      files.copy(intent.path);
      return true;
    case "cut":
      files.cut(intent.path);
      return true;
    case "paste":
      files.paste(intent.folder);
      return true;
    case "restore":
      files.move(intent.path, parentPath(intent.to));
      return true;
    default:
      onDialog(intent);
      return true;
  }
}

/**
 * The intents that are a dialog rather than a call.
 *
 * Named so `applyRowIntent`'s `onDialog` is typed as the six it can actually
 * receive: a callback taking every `RowIntent` would accept `copy`, and the
 * caller would have to handle a case that cannot reach it.
 */
type DialogKind = "newNote" | "newFolder" | "rename" | "move" | "archive" | "delete";
