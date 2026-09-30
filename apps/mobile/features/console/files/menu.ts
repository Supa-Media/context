/**
 * The file action menu, as data.
 *
 * One list of items, two presentations: a right-click context menu on the web
 * console and a long-press action sheet on a phone. They are the same menu —
 * the same items, the same order, the same words — because they are the same
 * question ("what can I do with this?") asked with a different input device.
 *
 * Written as a pure model rather than as JSX inside the menu component for the
 * reason every module in this folder is (see `jest.config.js`: the console's
 * tests run in plain node with no renderer). Two rules in particular stop being
 * checkable the moment they are expressed as `{canEdit && <Item …/>}`:
 *
 *  - **Read-only means absent, not disabled.** The landing-page demo and a
 *    workspace `member` both have `canEdit: false`. A menu of greyed-out rows
 *    tells someone their context is broken; a short menu tells them the truth.
 *    That is one `if` in a component and one impossible-to-forget branch here.
 *
 *    This carried a reassuring claim that was simply untrue: that `FileBrowser`
 *    "does not even carry the mutating methods" for a read-only console. It
 *    does — they are required members of the interface, and `useDemoFileBrowser`
 *    sets all fourteen to no-ops. So a mutating call that slips through does
 *    **not** throw; it silently does nothing, which is the harder failure to
 *    notice. Nothing here may lean on a crash to catch a mistake, and `canEdit`
 *    is the only thing that decides.
 *  - **Multi-select is a different menu, not the same menu applied N times.**
 *    Rename and duplicate are single-target operations and simply are not
 *    offered; everything else has to say how many things it will touch.
 *
 * Inlined into the component, both would have to be re-derived in the mobile
 * sheet, and the two would drift — which is the ordinary way a "Delete" that
 * the demo cannot perform ends up on the landing page.
 *
 * Nothing here imports React, react-native or the DOM, and nothing here
 * performs an action: `itemsFor` says what to offer, the caller dispatches
 * `MenuActionId` against a `FileBrowser`.
 */

import type { Clipboard } from "./clipboard";
import type { MenuItem } from "./menuItem";
import { makeItem } from "./menuMake";
import { visibilityGroup } from "./menuVisibility";
import { restoreTargetFor } from "./paths";
import type { TreeRow } from "./tree";
import type { Visibility } from "./types";

export type MenuActionId =
  | "open"
  | "openInNewTab"
  | "newNote"
  | "newDrawing"
  | "newFolder"
  | "rename"
  | "duplicate"
  | "moveTo"
  | "copy"
  | "cut"
  | "paste"
  | "copyPath"
  | "copyAtPath"
  /**
   * Put this on the person's own disk — a note as Markdown, a folder as a zip
   * of everything in it they can see.
   *
   * **Offered whether or not this console may edit**, which is the one item
   * here that is. Every other rule in this file says read-only means absent,
   * and it is about *writes*: a menu of greyed-out verbs somebody cannot
   * perform tells them their context is broken. Downloading is a read, and
   * non-negotiable #1 says the exit is "never gated, never degraded, and never
   * behind a paywall" — so hiding it from a `member`, or from a viewer of the
   * pinned context, would be the gate that sentence forbids.
   *
   * `canDownload` is a capability rather than a constant because there is one
   * surface with no bucket behind it at all: the landing page's demo console,
   * whose `FileBrowser` methods are no-ops. A Download there would be a row
   * that silently does nothing, which this file's own header names as the
   * harder failure to notice.
   */
  | "download"
  | "share"
  /**
   * The submenu's own id, and deliberately not one of the three below.
   *
   * A parent item is never dispatched — the caller opens its `items` instead —
   * but a dispatcher that forgets to check `items` would then run whichever
   * real id the parent had been given, silently setting a visibility nobody
   * asked for. An id with no handler is a no-op; an id with the wrong handler
   * is a privacy change.
   */
  | "visibility"
  | "visibilityPrivate"
  | "visibilityTeam"
  | "visibilityFollow"
  /**
   * From a breadcrumb segment back to that folder's row in the tree.
   *
   * Not an alias for `open`: you are already *in* the folder, which is why you
   * are standing on its crumb at all. This puts the *tree* on it — expands the
   * ancestors and selects the row — so the folder's full set of verbs is one
   * right-click away.
   */
  | "revealInTree"
  /** Put a note or folder on the phone's Home, for this person only (`functions/places.ts`). */
  | "pin"
  | "unpin"
  /** A folder's tags, on its front note (`TagsSheet`, board 14). */
  | "tags"
  /** Pick several rows of the folder page (board 16). */
  | "selectNotes"
  | "archive"
  | "restore"
  | "delete";

export type { MenuItem } from "./menuItem";

export type MenuTarget =
  | { kind: "background"; folder: string }
  | { kind: "row"; row: TreeRow }
  | { kind: "selection"; rows: readonly TreeRow[] }
  /** A breadcrumb segment. `""` is the context root. */
  | { kind: "crumb"; folder: string }
  /** The folder a phone's page is showing, from its •••. */
  | { kind: "page"; row: TreeRow };

export interface MenuContext {
  target: MenuTarget;
  canEdit: boolean;
  /**
   * Whether visibility items are offered at all. Owner-only, and absent
   * rather than disabled — the same rule as `canEdit` above. An editor with
   * a Visibility submenu was the live breach: changing visibility rewrites
   * the access map that decides what that editor may see, so the authority
   * is the owner's alone, and the server (`minimum: "owner"`, plus the
   * scope gate in lib/fileOps) refuses it regardless of what this menu says.
   */
  canSetVisibility: boolean;
  /**
   * Whether Share is offered. Owner-only, and absent rather than disabled —
   * the same rule as `canSetVisibility` above, and for the same reason:
   * handing a note to somebody outside the context is a decision about who
   * reads it, which is not an editor's to make. The server refuses them with
   * `minimum: "owner"` regardless of what this menu says.
   */
  canShare: boolean;
  /**
   * Whether this console can hand a file to the device at all.
   *
   * False on the landing page's demo, which has no bucket and whose browser
   * methods are no-ops. Not a permission — see `download` above, which is
   * deliberately not gated on `canEdit`.
   */
  canDownload: boolean;
  clipboard: Clipboard | null;
  /**
   * Web prints shortcuts; touch does not, and touch has no "open in new tab".
   *
   * **Nothing in the app passes `"touch"` today, and that is recorded rather
   * than left quietly true.** The only production caller is `Explorer`, which
   * is a pointer-layout region — a phone has no file tree
   * (`features/app/frame.ts`) — so it passes the literal `"web"`. The arm stays
   * for the reason that file gives for the `sheet` and `drawer` arms it keeps
   * beside it, and it is named in that enumeration: this is a *rule* about what
   * a surface with no keyboard and no tabs may be offered, it is the single
   * owner of that rule, and both values are checked by `fileMenu.test.ts` and
   * `menuRender.test.ts`. Deleting it would move the decision into whichever
   * component next grows a long-press menu, which is how "Open in new tab"
   * appears on a phone that has no tabs.
   */
  platform: "web" | "touch";
  /**
   * Whether the keyboard being printed for is an Apple one — `⌘⇧M` rather than
   * `Ctrl+Shift+M`. Inert on touch, which prints no chords at all.
   *
   * Optional, and it defaults to Apple, which is the one judgement call in
   * here. Both wrong answers are wrong; they are not equally wrong. `⌘` on
   * Windows is unmistakably foreign — nobody has that key, so the reader knows
   * at a glance they are being shown somebody else's keyboard and goes looking
   * for the real chord. `Ctrl+Shift+M` on a Mac names a chord that *does* exist
   * on the keyboard in front of them and is not this command, so they press it,
   * nothing moves, and the menu looks broken rather than mistaken. Defaulting
   * this way also makes an omitted flag behave exactly as the hard-coded glyph
   * table it replaced did, so forgetting it is a no-op rather than a
   * regression.
   *
   * The web console reads the real value from the browser and passes it; the
   * decision does not belong in here, because this module is deliberately free
   * of anything that could answer it.
   */
  apple?: boolean;
  /**
   * What this target would be visible to with **no setting of its own** — the
   * folder default it inherits.
   *
   * Supplied rather than derived: this module cannot see the listings, and the
   * one place that can (`FileEntry.inherited`, which the server computes) is
   * two layers away. A caller that does not know passes nothing, and the
   * "use the folder's setting" row then carries the check without the sentence
   * — the menu never invents a visibility it was not told, because a menu that
   * guesses wrong about who can read a note is worse than one that says less.
   */
  inherited?: Visibility;
  /**
   * Whether a path is on this person's Home. Present only where pinning is
   * (a signed-in phone); a pin is personal, so a reader may pin too.
   */
  pinned?: (path: string) => boolean;
  /**
   * A folder's tags as they are now, for "Tags  client, retainer ›" on a
   * phone's folder page. Present only where they can be changed from here.
   */
  tagsOf?: (path: string) => readonly string[] | null;
  /** The page can pick several rows: a phone's folder page (`folderSelect.tsx`). */
  selectable?: boolean;
}

/**
 * Flatten groups into one list, putting a separator between the ones that
 * survived.
 *
 * Separators are computed from grouping rather than written by hand because
 * hand-written ones are wrong the moment a group empties: hide "open in new
 * tab" on touch, hide "paste" with nothing on the clipboard, hide everything
 * mutating for a `member`, and a menu written as a flat list with `separator`
 * flags on it grows a double rule, a leading rule, or a trailing rule under a
 * last item that is no longer there. Groups cannot express any of those — an
 * empty group contributes nothing, and only a *following* non-empty group ever
 * carries a separator.
 *
 * Any `separatorBefore` already on an incoming item is dropped, so a caller
 * composing groups out of pre-built items cannot smuggle one back in.
 */
export function joinGroups<Id extends string = MenuActionId>(
  groups: readonly (readonly MenuItem<Id>[])[],
): MenuItem<Id>[] {
  const items: MenuItem<Id>[] = [];
  for (const group of groups) {
    if (group.length === 0) continue;
    group.forEach((entry, index) => {
      const { separatorBefore: _dropped, ...rest } = entry;
      items.push(index === 0 && items.length > 0 ? { ...rest, separatorBefore: true } : rest);
    });
  }
  return items;
}

/** "3 items". The only plural this menu needs. */
function items(count: number): string {
  return `${count} items`;
}

/**
 * The rows a menu is actually about, or `null` for "do not open a menu".
 *
 * Two normalisations, both of which prevent a menu that lies:
 *
 *  - **A selection of one is a row.** Which items you are offered must not
 *    depend on whether you arrived at a single note by clicking it or by
 *    marquee-selecting it alone.
 *  - **`loading` and `empty` rows are not files.** They are placeholders the
 *    tree draws so that "not loaded yet" and "nothing here" are different
 *    sentences (see `tree.ts`), and they carry `readOnly: true`, which would
 *    otherwise quietly qualify them for the privacy.md menu — offering "Copy
 *    path" for the path of a spinner.
 */
function targetRows(target: MenuTarget): readonly TreeRow[] | null {
  const rows = target.kind === "row" ? [target.row] : target.kind === "selection" ? target.rows : [];
  if (rows.length === 0) return null;
  if (!rows.every((row) => row.kind === "file" || row.kind === "folder")) return null;
  return rows;
}

/**
 * Whether pasting here is even structurally possible.
 *
 * `planPaste` is the authority on whether a paste will succeed, and it needs
 * the destination's listing to answer, so the collision cases stay there and
 * are reported after the click. The one case that needs no listing is a folder
 * pasted into itself or into its own descendant, which can never succeed under
 * any listing — so it is not offered rather than offered and refused.
 */
export function canPasteInto(clipboard: Clipboard, folder: string): boolean {
  return folder !== clipboard.path && !folder.startsWith(`${clipboard.path}/`);
}

/**
 * Right-click on empty space: the only things there are to do are create ones.
 *
 * With no `canEdit` there is nothing here at all — nothing to open, nothing to
 * create — so this returns an empty list, and the caller should show no menu
 * rather than an empty one.
 */
function backgroundItems(context: MenuContext, folder: string): MenuItem[] {
  if (!context.canEdit) return [];
  return joinGroups([createGroup(context, false), pasteGroup(context, folder)]);
}

/**
 * New note / new drawing / new folder, in that order.
 *
 * Most-used first and no `New ▸` parent in front of them: right-clicking empty
 * space has one intent, and putting the single most frequent action in the
 * product behind a hover would be tidiness bought with the thing people came to
 * do. It grows a submenu on the day there is a fifth, not before.
 *
 * `here` is the difference between the three surfaces that offer these. On a
 * folder row or a breadcrumb segment the target is a folder you are *pointing
 * at* rather than in, so the label has to say which folder it means; on empty
 * space there is nowhere else it could mean and the word would be noise.
 */
function createGroup(context: MenuContext, here: boolean): MenuItem[] {
  const where = here ? " here" : "";
  return [
    makeItem(context, "newNote", `New note${where}`),
    makeItem(context, "newDrawing", `New drawing${where}`),
    makeItem(context, "newFolder", `New folder${where}`),
  ];
}

/**
 * A breadcrumb segment's menu: the folder you are standing in.
 *
 * It creates, addresses and sets what the folder shares — and it deliberately
 * **cannot rename, move, archive or trash that folder**. You are inside it: a
 * control that removes the ground under the view you are looking at is a
 * footgun, and every one of those verbs is a right-click away on the same
 * folder's row in the tree, where the target is a thing you are pointing at
 * rather than a place you are in.
 *
 * The root (`""`) is the context itself. It has no address worth copying —
 * `""` is not something anybody can paste — so the two address items are absent
 * rather than putting an empty string on the clipboard.
 */
function crumbItems(context: MenuContext, folder: string): MenuItem[] {
  const addresses =
    folder === ""
      ? []
      : [makeItem(context, "copyPath", "Copy path"), makeItem(context, "copyAtPath", "Copy @path")];
  const opening = [
    makeItem(context, "open", "Open"),
    makeItem(context, "revealInTree", "Reveal in tree"),
  ];
  // The same early return the row menu takes, and for the same reason: with no
  // write access there is nothing between opening and addressing to offer.
  /*
    The root crumb is the context itself, and downloading it is the whole of
    "downloading everything" from non-negotiable #1 — the same archive as any
    other folder's, one level up. It is the one item the root has that is not
    about a path, which is why it sits beside `addresses` rather than in it.
  */
  const download = downloadGroup(context, { kind: "folder" });
  if (!context.canEdit) return joinGroups([opening, addresses, download]);
  return joinGroups([
    opening,
    [...createGroup(context, true), ...pasteGroup(context, folder)],
    addresses,
    download,
    context.canSetVisibility ? visibilityGroup(context, true, 1, null) : [],
  ]);
}

/**
 * The ••• on a phone's folder page (board 08 of the Home artboards, approved
 * by the owner on 2026-09-30): what you do to the folder you are standing in.
 *
 * Not the row menu. Open is where you already are, and Duplicate, Copy, Cut
 * and the addresses are a row's clipboard verbs. Unlike the breadcrumb, it
 * renames and moves the folder, because the board asks for both here and the
 * page follows the folder to its new name. It archives and never trashes:
 * "hidden, not deleted", with Undo.
 */
function pageItems(context: MenuContext, row: TreeRow): MenuItem[] {
  if (row.path === "") return homeItems(context, row);
  if (row.readOnly) return entryItems(context, [row]);
  if (!context.canEdit) return joinGroups([pinGroup(context, row), downloadGroup(context, row)]);
  const archived = restoreTargetFor(row.path) !== null;
  return joinGroups([
    [
      makeItem(context, "newNote", "New note"),
      makeItem(context, "newFolder", "New folder inside"),
      ...pasteGroup(context, row.path),
    ],
    [
      makeItem(context, "rename", "Rename…"),
      makeItem(context, "moveTo", "Move to…"),
      ...pinGroup(context, row),
      ...tagsGroup(context, row),
    ],
    context.canSetVisibility
      ? visibilityGroup(context, true, 1, row).map((item) => ({ ...item, label: "Share" }))
      : [],
    context.selectable === true ? [makeItem(context, "selectNotes", "Select notes")] : [],
    downloadGroup(context, row),
    [
      archived
        ? makeItem(context, "restore", "Restore folder")
        : makeItem(context, "archive", "Archive folder"),
    ],
  ]);
}

/**
 * Home's •••: the workspace itself. It makes things at the top, says who can
 * see it and downloads all of it, and it cannot be renamed, moved, pinned to
 * itself or archived, so none of those is offered.
 */
function homeItems(context: MenuContext, row: TreeRow): MenuItem[] {
  const download = downloadGroup(context, row);
  if (!context.canEdit) return download;
  return joinGroups([
    [makeItem(context, "newNote", "New note"), makeItem(context, "newFolder", "New folder"), ...pasteGroup(context, "")],
    context.canSetVisibility
      ? visibilityGroup(context, true, 1, row).map((item) => ({ ...item, label: "Share" }))
      : [],
    download,
  ]);
}

/**
 * Download, as its own group, or nothing.
 *
 * Shared by the row menu and the breadcrumb menu, and by both of their
 * read-only branches, because it is the one item those branches keep: it is a
 * read, and non-negotiable #1 says the exit is never gated. A second copy of
 * "is this offered" is how one of the four ends up without it.
 */
function downloadGroup(context: MenuContext, target: { kind: string } | null): MenuItem[] {
  // A `loading` or `empty` row is not a file or a folder and has no path
  // behind it, so there is nothing to hand anybody. The row menu never opens
  // on one, and asking the question here rather than trusting that is what
  // keeps this usable from four call sites.
  if (!context.canDownload || target === null) return [];
  if (target.kind !== "file" && target.kind !== "folder") return [];
  return [
    makeItem(
      context,
      "download",
      target.kind === "folder" ? "Download folder (.zip)" : "Download",
    ),
  ];
}

/** "Pin to Home" or "Unpin from Home", for one row, where there is a Home to pin to. */
function pinGroup(context: MenuContext, single: TreeRow | null): MenuItem[] {
  if (context.pinned === undefined || single === null) return [];
  return context.pinned(single.path)
    ? [makeItem(context, "unpin", "Unpin from Home")]
    : [makeItem(context, "pin", "Pin to Home")];
}

/** "Tags", with the folder's tags beside it, where they can be changed from here. */
function tagsGroup(context: MenuContext, row: TreeRow): MenuItem[] {
  const tags = context.tagsOf?.(row.path);
  if (tags == null) return [];
  const item = makeItem(context, "tags", "Tags");
  return [tags.length === 0 ? item : { ...item, value: tags.join(", ") }];
}

/** "Paste foo.md", or nothing. The label names the thing so it is not a guess. */
function pasteGroup(context: MenuContext, folder: string): MenuItem[] {
  const clipboard = context.clipboard;
  if (clipboard === null || !canPasteInto(clipboard, folder)) return [];
  return [makeItem(context, "paste", `Paste ${clipboard.name}`)];
}

function entryItems(context: MenuContext, rows: readonly TreeRow[]): MenuItem[] {
  const count = rows.length;
  const single = count === 1 ? rows[0] : null;
  const isFolder = rows.every((row) => row.kind === "folder");

  /**
   * `privacy.md` is generated from the visibility settings and written by the
   * gateway, so it cannot be renamed, moved, duplicated, deleted or given a
   * visibility of its own — and it has no `@path` worth copying, because it is
   * not a note anybody else's context can usefully address. Reading it and
   * knowing where it lives is the whole of what there is to offer.
   *
   * One read-only row poisons a whole selection: an "Archive 3 items" that
   * archives two of them is worse than no menu item, and quietly dropping the
   * one it cannot touch is exactly the kind of partial success nobody notices
   * until later.
   */
  if (rows.some((row) => row.readOnly)) {
    return joinGroups([
      single === null ? [] : [makeItem(context, "open", "Open")],
      [makeItem(context, "copyPath", single === null ? `Copy ${count} paths` : "Copy path")],
    ]);
  }

  /**
   * No `canEdit`, no mutating items — absent, never present-and-disabled.
   * `FileBrowser` does not carry the methods that would back them (the demo
   * console on the landing page runs the real components against literals),
   * so an item offered here would have nothing to call.
   */
  if (!context.canEdit) {
    if (single === null) {
      return [makeItem(context, "copyPath", `Copy ${count} paths`)];
    }
    return joinGroups([
      [makeItem(context, "open", "Open")],
      pinGroup(context, single),
      [
        makeItem(context, "copyPath", "Copy path"),
        makeItem(context, "copyAtPath", "Copy @path"),
      ],
      // The one item this branch keeps. Everything above returns early because
      // there is nothing to *write*; a download is a read, and gating the exit
      // on write access is the degradation non-negotiable #1 forbids.
      downloadGroup(context, single),
    ]);
  }

  /**
   * Restore replaces archive for anything already under `4-archive/`, because
   * for something that is already put away the recoverable action is undoing
   * it. `restoreTargetFor` reads the original path back out of the timestamped
   * folder, so this is a string question with a definite answer rather than a
   * guess — and it returns `null` for everything else, which is what keeps
   * "Restore" off an ordinary note.
   *
   * A mixed selection archives: restoring is only offered when every row knows
   * where it came from.
   */
  const archived = rows.every((row) => restoreTargetFor(row.path) !== null);

  return joinGroups([
    /*
      Opening. A folder has no document to put in a tab, so the second item is
      file-only — and it is web-only because **tabs are a pointer instrument**.

      That second half used to read "touch has a tab switcher rather than a
      pointer with a middle button", which had the causation backwards: a
      switcher *displays* a set of tabs, it does not produce one. This line was
      the only verb that produces one, so withholding it here was what left the
      phone's count button reading `1` for the life of the app — the switcher
      the comment pointed at as the alternative was the thing this made empty.
      It is gone (`files/RecentSheet.tsx`), and the gate is now saying what it
      always did: a phone has no tab surface, so it is offered no tab verb.
    */
    single === null
      ? []
      : [
          makeItem(context, "open", "Open"),
          ...(single.kind === "file" && context.platform === "web"
            ? [makeItem(context, "openInNewTab", "Open in new tab")]
            : []),
        ],

    // Creating, on a folder, means creating *inside* it — which is what "here"
    // is doing in the label. On the background the same items need no word,
    // because there is nowhere else they could mean.
    single !== null && single.kind === "folder"
      ? [
          makeItem(context, "newNote", "New note here"),
          makeItem(context, "newDrawing", "New drawing here"),
          makeItem(context, "newFolder", "New folder here"),
          ...pasteGroup(context, single.path),
        ]
      : [],

    pinGroup(context, single),

    // Rename and duplicate take one target and have no sensible plural: three
    // renames is three dialogs, and "Duplicate 3 items" is a batch job with a
    // naming scheme nobody has chosen. They are omitted rather than offered
    // for the first row of the selection.
    [
      ...(single === null
        ? []
        : [
            makeItem(context, "rename", "Rename…"),
            makeItem(context, "duplicate", "Duplicate"),
          ]),
      makeItem(context, "moveTo", single === null ? `Move ${items(count)} to…` : "Move to…"),
    ],

    // `copyEntry` and the clipboard both take folders, so a folder is copied
    // and cut exactly like a note is. A selection gets neither: the clipboard
    // holds one path (`clipboard.ts`), so "Copy 3 items" would put the first
    // on it and paste one — the partial success this menu exists to avoid.
    // Dragging with ⌥ held is how several are copied at once.
    single === null
      ? []
      : [makeItem(context, "copy", "Copy"), makeItem(context, "cut", "Cut")],

    // The `@name/1-projects/foo.md` form addresses one path in somebody else's
    // sentence or an agent's prompt; a newline-separated list of three is not
    // that, and plain "Copy 3 paths" already covers the bulk case.
    [
      makeItem(context, "copyPath", single === null ? `Copy ${count} paths` : "Copy path"),
      ...(single === null ? [] : [makeItem(context, "copyAtPath", "Copy @path")]),
    ],

    /*
      Download, on its own row group and above Share.

      Single-target only, for the reason Rename and Duplicate are: three
      downloads is three files landing in somebody's folder with no ordering
      and no way to tell which press produced which. A multi-select download is
      a real feature — one archive of the selection — and it is a different
      one, so it is omitted rather than offered as a loop.

      Not gated on `canEdit`, unlike everything above it. See `download` in
      `MenuActionId`.
    */
    downloadGroup(context, single),

    // Share takes one note and has no plural: a share is addressed to one
    // person over one path, and "Share 3 items" is three separate grants with
    // three separate links, which is a batch job nobody asked for. A folder is
    // omitted rather than refused, because `createShare` has no folder form at
    // all — see `SHARE_TRAVERSAL_DEPTH` in `functions/shares.ts`.
    context.canShare && single !== null && single.kind === "file"
      ? [makeItem(context, "share", "Share…")]
      : [],

    /*
      A selection gets no visibility submenu yet. Each row is its own write to
      `privacy.md`, with no batch form on the server and no one Undo for the
      lot, so "Share 3 items with the team" that stopped after the second would
      leave a privacy change half made — and this is the one menu item where
      half made is a disclosure rather than an inconvenience. The plural labels
      below are kept for the day there is a batch write behind them.

      A mixed selection would get none even then: "Follow folder" means
      nothing for a folder, and a submenu that applies to some of what is
      selected is the partial success this menu exists to avoid.
    */
    context.canSetVisibility && single !== null
      ? visibilityGroup(context, isFolder, count, single)
      : [],

    [
      archived
        ? makeItem(context, "restore", single === null ? `Restore ${items(count)}` : "Restore")
        : makeItem(context, "archive", single === null ? `Archive ${items(count)}` : "Archive"),
      // Deleting is an immediate move into the archive-backed trash. The toast
      // offers Undo, so there is no confirmation dialog or ellipsis.
      makeItem(
        context,
        "delete",
        single === null ? `Move ${items(count)} to trash` : "Move to trash",
        { danger: true },
      ),
    ],
  ]);
}

/**
 * What this right-click or long-press should offer.
 *
 * Order is fixed and shared by both presentations: open, create, rearrange,
 * clipboard, addresses, visibility, then the two that put something away — the
 * destructive pair last, and never first under a thumb.
 */
export function itemsFor(context: MenuContext): MenuItem[] {
  if (context.target.kind === "background") {
    return backgroundItems(context, context.target.folder);
  }
  if (context.target.kind === "crumb") return crumbItems(context, context.target.folder);
  if (context.target.kind === "page") return pageItems(context, context.target.row);
  const rows = targetRows(context.target);
  if (rows === null) return [];
  return entryItems(context, rows);
}
