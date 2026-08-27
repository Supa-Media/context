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

import { describeBinding, type Command } from "../../design/keymap";
import type { Clipboard } from "./clipboard";
import { restoreTargetFor } from "./paths";
import type { TreeRow } from "./tree";

export type MenuActionId =
  | "open"
  | "openInNewTab"
  | "newNote"
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
  | "archive"
  | "restore"
  | "delete";

export interface MenuItem {
  id: MenuActionId;
  label: string;
  /** Printed on the right on web. Absent on touch. */
  shortcut?: string;
  danger?: boolean;
  /** Items after this one start a new visual group. */
  separatorBefore?: boolean;
  /** A submenu (Visibility ▸). Only ever one level deep. */
  items?: MenuItem[];
}

export type MenuTarget =
  | { kind: "background"; folder: string }
  | { kind: "row"; row: TreeRow }
  | { kind: "selection"; rows: readonly TreeRow[] };

export interface MenuContext {
  target: MenuTarget;
  canEdit: boolean;
  clipboard: Clipboard | null;
  /** Web prints shortcuts; touch does not, and touch has no "open in new tab". */
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
}

/**
 * Which command each item runs, for the sole purpose of printing its chord.
 *
 * This module does not bind anything — `keymap.ts` does — and it deliberately
 * does not keep its own copy of the chords either. It used to: a literal table
 * of `"⌘⇧M"` strings sitting twelve lines from here, which is precisely the
 * duplication `keymap.ts`'s own doc comment warns about, and it had already
 * gone wrong in two different ways.
 *
 *  - **It was wrong on every non-Apple machine.** The glyphs were baked in, so
 *    a Windows or Linux console printed `⌘⇧M` beside "Move to…" for a keyboard
 *    with no `⌘` key on it. `describeBinding` is the thing that knows both
 *    spellings.
 *  - **It could claim a chord nothing binds.** `copyPath` carried `⌘⇧C` here
 *    while `BINDINGS` has no such binding, so the menu advertised a keystroke
 *    that did nothing at all. Going through the table means a command with no
 *    binding prints no shortcut — which is a legitimate state, not an error
 *    (see `describeBinding`), and is how "only on the action sheet" is allowed
 *    to look.
 *
 * A rebind now moves the menu label with it, and a chord the menu prints is a
 * chord that exists. An item absent from this map is an item with no keystroke.
 */
const COMMANDS: Partial<Record<MenuActionId, Command>> = {
  newNote: "newNote",
  newFolder: "newFolder",
  rename: "rename",
  duplicate: "duplicate",
  moveTo: "moveTo",
  copy: "copy",
  cut: "cut",
  paste: "paste",
  archive: "archive",
  // The one pair whose names differ, and they differ on purpose: the menu item
  // is `delete` because that is where it sits in the list, the command is
  // `deleteForever` because that is what pressing it does. Mapping them here
  // rather than renaming either keeps both names honest in their own file.
  delete: "deleteForever",
};

/**
 * Build one item, omitting every field that does not apply.
 *
 * Omitted rather than set to `undefined` so that `"shortcut" in item` is a
 * usable question on touch: a sheet that reserves a column for a key
 * combination nobody can type has given up a fifth of a phone's width to
 * decoration.
 */
function makeItem(
  context: MenuContext,
  id: MenuActionId,
  label: string,
  extra: { danger?: boolean; items?: MenuItem[] } = {},
): MenuItem {
  const command = COMMANDS[id];
  const shortcut =
    context.platform === "web" && command !== undefined
      ? (describeBinding(command, context.apple ?? true) ?? undefined)
      : undefined;
  return {
    id,
    label,
    ...(shortcut === undefined ? {} : { shortcut }),
    ...(extra.danger === true ? { danger: true } : {}),
    ...(extra.items === undefined ? {} : { items: extra.items }),
  };
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
export function joinGroups(groups: readonly (readonly MenuItem[])[]): MenuItem[] {
  const items: MenuItem[] = [];
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
function canPasteInto(clipboard: Clipboard, folder: string): boolean {
  return folder !== clipboard.path && !folder.startsWith(`${clipboard.path}/`);
}

/**
 * Private / Team, plus "Follow folder" for a file.
 *
 * A folder gets two items because the third has no referent: `privacy.md` is
 * folder defaults plus exact-note exceptions, and a folder's default *is* the
 * value being set — there is no outer default for it to follow. "Follow
 * folder" on a file removes that file's exact-note exception rather than
 * writing a value, which is why it belongs in this list at all: without it the
 * only way back from an exception would be to guess the folder's default and
 * set it by hand, leaving a redundant exception behind that then stops
 * tracking the folder.
 */
function visibilityGroup(context: MenuContext, isFolder: boolean): MenuItem[] {
  const children = [
    makeItem(context, "visibilityPrivate", "Private"),
    makeItem(context, "visibilityTeam", "Team"),
    ...(isFolder ? [] : [makeItem(context, "visibilityFollow", "Follow folder")]),
  ];
  return [makeItem(context, "visibility", "Visibility", { items: children })];
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
  return joinGroups([
    [
      makeItem(context, "newNote", "New note"),
      makeItem(context, "newFolder", "New folder"),
    ],
    pasteGroup(context, folder),
  ]);
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
  const isFile = rows.every((row) => row.kind === "file");

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
      [
        makeItem(context, "copyPath", "Copy path"),
        makeItem(context, "copyAtPath", "Copy @path"),
      ],
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
    // Opening. A folder has no document to put in a tab, and touch has a tab
    // switcher rather than a pointer with a middle button, so the second item
    // is web-and-file only.
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
          makeItem(context, "newFolder", "New folder here"),
          ...pasteGroup(context, single.path),
        ]
      : [],

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
    // and cut exactly like a note is.
    [
      makeItem(context, "copy", single === null ? `Copy ${items(count)}` : "Copy"),
      makeItem(context, "cut", single === null ? `Cut ${items(count)}` : "Cut"),
    ],

    // The `@name/1-projects/foo.md` form addresses one path in somebody else's
    // sentence or an agent's prompt; a newline-separated list of three is not
    // that, and plain "Copy 3 paths" already covers the bulk case.
    [
      makeItem(context, "copyPath", single === null ? `Copy ${count} paths` : "Copy path"),
      ...(single === null ? [] : [makeItem(context, "copyAtPath", "Copy @path")]),
    ],

    // A mixed selection gets no visibility submenu: "Follow folder" means
    // nothing for a folder, and a submenu that applies to some of what is
    // selected is the partial success this menu exists to avoid.
    single !== null || isFolder || isFile ? visibilityGroup(context, isFolder) : [],

    [
      archived
        ? makeItem(context, "restore", single === null ? `Restore ${items(count)}` : "Restore")
        : makeItem(context, "archive", single === null ? `Archive ${items(count)}` : "Archive"),
      // The ellipsis is the promise that this asks first. Deletion is
      // permanent — `describeDeleteForever` is the sentence it asks with — and
      // "Move to…" needs a destination before it can do anything. "New note"
      // takes no ellipsis: it offers something rather than asking about what is
      // already there.
      makeItem(
        context,
        "delete",
        single === null ? `Delete ${items(count)} forever…` : "Delete forever…",
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
  const rows = targetRows(context.target);
  if (rows === null) return [];
  return entryItems(context, rows);
}
