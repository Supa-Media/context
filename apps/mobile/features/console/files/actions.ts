/**
 * What a menu item *does*, in one place.
 *
 * `menu.ts` says what to offer and this says what happens when it is chosen.
 * They are deliberately two modules: the first is a pure list and the second
 * reaches a `FileBrowser`, and keeping the split means the question "is Archive
 * offered here?" and the question "what does Archive do?" can each be answered
 * without reading the other.
 *
 * ## Why this is not a method on `Explorer`
 *
 * It was one, and for as long as it was, the tree was the only surface in the
 * console where a right-click did anything. The folder listing, the breadcrumb
 * and the tab strip each had the same items available to them through `menu.ts`
 * and no way to run them without copying a 90-line `switch` — which is how a
 * "Move to trash" that works in the tree and silently does nothing in the
 * folder view gets shipped.
 *
 * So the dispatcher takes its world as an argument. Everything it cannot do
 * itself — opening a path, raising a dialog, revealing a row, closing a tab —
 * arrives in `ActionContext`, and a surface that genuinely cannot do one of
 * those leaves it out rather than passing a no-op: `menu.ts` is then the thing
 * that must not offer the item, which is the rule that file already states
 * about `canEdit`.
 *
 * Nothing here imports React or react-native, so the whole dispatcher is
 * testable in plain node against a stub browser — the same reason every other
 * module in this folder is written this way.
 */

import type { FileBrowser } from "./browser";
import type { MenuActionId, MenuTarget } from "./menu";
import { parentPath, restoreTargetFor } from "./paths";
import type { Visibility } from "./types";

/**
 * A question the console has raised and is waiting on an answer to.
 *
 * It lives here rather than in `Explorer.tsx` because it is this dispatcher's
 * *output*: nine of the items below do nothing but set one, and a type that
 * describes what a function returns belongs beside that function. `Explorer`
 * re-exports it so every existing importer is untouched.
 */
export type Dialog =
  /**
   * "Something goes in this folder" — which of the two it is has not been asked
   * yet. Raised by the phone's `+`, which is one key for both; see
   * `CreatePrompt`. The explorer's own toolbar has room for a button each and
   * raises the two below directly.
   */
  | { kind: "create"; folder: string }
  | { kind: "newNote"; folder: string }
  | { kind: "newDrawing"; folder: string }
  | { kind: "newFolder"; folder: string }
  | { kind: "rename"; path: string }
  | { kind: "move"; path: string }
  | { kind: "archive"; path: string }
  | { kind: "share"; path: string }
  | null;

/** Which tabs a close item is about. See `closeTabs`. */
export type CloseScope = "one" | "others" | "toRight";

export interface ActionContext {
  files: FileBrowser;
  /** `@seyi`. The prefix of the addressable `@path` form. */
  contextLabel: string;
  /** Open a path in the pane. */
  select: (path: string) => void;
  setDialog: (dialog: Dialog) => void;
  writeClipboard: (text: string) => void;
  /**
   * Open a path in a tab that a subsequent click will not replace.
   *
   * Absent on a surface with no tabs, where `open` is the whole of what
   * opening means. `menu.ts` already withholds "Open in new tab" from touch,
   * so this is the second guard rather than the first.
   */
  openPinned?: (path: string) => void;
  /**
   * Put the file tree on a path — expand to it and select it.
   *
   * Absent where there is no tree to reveal into, which on this app is any
   * layout narrower than `frame.ts`'s pointer density.
   */
  reveal?: (path: string) => void;
  /** Absent where there are no tabs. */
  closeTabs?: (path: string, scope: CloseScope) => void;
  /**
   * What `path` would be visible to with no setting of its own.
   *
   * Used by `visibilityFollow`, which removes a note's exception by writing
   * the folder's own value back — see the case below for why that is the
   * expressible form of "stop having an opinion".
   */
  inheritedOf: (path: string) => Visibility;
}

/**
 * The one path an action addresses, and the folder it acts inside.
 *
 * Derived rather than passed so that a caller cannot get the pair out of step:
 * "create inside this" is the folder itself for a folder row and the *parent*
 * for a note, and a surface that worked that out for itself would eventually
 * work it out differently.
 */
export interface ActionTarget {
  /** `""` is the context root. */
  path: string;
  /** Where a creation or a paste lands. */
  folder: string;
  kind: "file" | "folder";
}

/**
 * What this menu was opened on, as the dispatcher needs it — or `null` where
 * there is nothing single to act on.
 *
 * **A selection returns `null` on purpose.** `menu.ts` models a multi-row menu
 * and writes its labels in the plural, but nothing in the console opens one
 * yet: the tree has no multi-selection to open it *from*. Picking the first row
 * and acting on that would be the worst of the three available behaviours — an
 * "Archive 3 items" that archives one is the partial success `menu.ts`'s own
 * header says this menu exists to avoid. So it declines, and the day a
 * selection exists this is the function that grows an arm for it.
 */
export function actionTargetOf(target: MenuTarget): ActionTarget | null {
  switch (target.kind) {
    case "background":
      return { path: target.folder, folder: target.folder, kind: "folder" };
    case "crumb":
      return { path: target.folder, folder: target.folder, kind: "folder" };
    case "tab":
      return { path: target.path, folder: parentPath(target.path), kind: "file" };
    case "row": {
      const row = target.row;
      const kind = row.kind === "folder" ? ("folder" as const) : ("file" as const);
      return {
        path: row.path,
        folder: kind === "folder" ? row.path : parentPath(row.path),
        kind,
      };
    }
    case "selection":
      return null;
  }
}

/**
 * Run one menu item.
 *
 * Every arm is either a `FileBrowser` call, a dialog, or a callback the caller
 * supplied — there is no fourth kind, and nothing here decides *whether* an
 * action is allowed. That is `menu.ts`'s job on the way in and the server's on
 * the way out, and this sitting in between re-deciding it would make three
 * opinions where the product has two.
 */
export function runMenuAction(
  id: MenuActionId,
  target: MenuTarget,
  context: ActionContext,
): void {
  const at = actionTargetOf(target);
  if (at === null) return;
  const { path, folder, kind } = at;
  const { files } = context;

  switch (id) {
    case "open":
      context.select(path);
      return;
    case "openInNewTab":
      // A plain open leaves a preview tab that the next click replaces; this is
      // the one that keeps it. Falls back to a plain open where there are no
      // tabs rather than doing nothing.
      if (context.openPinned !== undefined) context.openPinned(path);
      else context.select(path);
      return;
    case "revealInTree":
      // No tree on this layout is "nothing to reveal into", not an error. The
      // item is not offered there in the first place.
      context.reveal?.(path);
      return;
    case "closeTab":
      context.closeTabs?.(path, "one");
      return;
    case "closeOtherTabs":
      context.closeTabs?.(path, "others");
      return;
    case "closeTabsToRight":
      context.closeTabs?.(path, "toRight");
      return;
    case "newNote":
      context.setDialog({ kind: "newNote", folder });
      return;
    case "newDrawing":
      context.setDialog({ kind: "newDrawing", folder });
      return;
    case "newFolder":
      context.setDialog({ kind: "newFolder", folder });
      return;
    case "rename":
      context.setDialog({ kind: "rename", path });
      return;
    case "moveTo":
      context.setDialog({ kind: "move", path });
      return;
    case "archive":
      context.setDialog({ kind: "archive", path });
      return;
    case "delete":
      files.destroy(path);
      return;
    case "share":
      context.setDialog({ kind: "share", path });
      return;
    case "duplicate":
      files.duplicate(path);
      return;
    case "copy":
      files.copy(path);
      return;
    case "cut":
      files.cut(path);
      return;
    case "paste":
      files.paste(folder);
      return;
    case "restore": {
      // `paths.ts` owns the archive-path arithmetic; `menu.ts` uses the same
      // function to decide whether to offer this at all, so the two cannot
      // disagree about what is restorable.
      const original = restoreTargetFor(path);
      if (original !== null) files.move(path, parentPath(original));
      return;
    }
    case "copyPath":
      context.writeClipboard(path);
      return;
    case "copyAtPath":
      // The product's addressable form. Dragging a note out of the app produces
      // the same string, so the two ways of taking a reference agree.
      context.writeClipboard(`${context.contextLabel}/${path}`);
      return;
    case "visibilityPrivate":
      files.setVisibility(path, kind, "private");
      return;
    case "visibilityTeam":
      files.setVisibility(path, kind, "team");
      return;
    case "visibilityFollow": {
      // Setting a note to its folder's default *removes* the exception rather
      // than writing a redundant line — see `setVisibility` in
      // `functions/lib/fileOps.ts`. So "use the folder's setting" is
      // expressible with the interface as it stands.
      //
      // A folder whose rule names a group has no "follow" this control can
      // express: `setVisibility` takes the two tiers, and writing `private` or
      // `team` here would change what the note reaches rather than make it
      // follow. Doing nothing is the honest answer until the group controls
      // land.
      const inherited = context.inheritedOf(path);
      if (inherited === "private" || inherited === "team") {
        files.setVisibility(path, kind, inherited);
      }
      return;
    }
    case "visibility":
      // The submenu's parent. It opens a submenu and dispatches nothing; firing
      // an id here would set a visibility nobody asked for.
      return;
  }
}
