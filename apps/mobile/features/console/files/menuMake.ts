import { describeBinding, type Command } from "../../design/keymap";
import type { MenuActionId, MenuContext } from "./menu";
import type { TreeRow } from "./tree";
import type { MenuItem } from "./menuItem";

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
  // Keep the established command id so existing keyboard customizations keep
  // working. The action is now recoverable even though this legacy id says
  // `deleteForever`.
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
export function makeItem(
  context: MenuContext,
  id: MenuActionId,
  label: string,
  extra: { danger?: boolean; items?: MenuItem[]; detail?: string; checked?: boolean; disabled?: boolean } = {},
): MenuItem {
  const command = COMMANDS[id];
  const shortcut =
    context.platform === "web" && command !== undefined
      ? (describeBinding(command, context.apple ?? true) ?? undefined)
      : undefined;
  return {
    id,
    label,
    ...(extra.detail === undefined ? {} : { detail: extra.detail }),
    ...(shortcut === undefined ? {} : { shortcut }),
    // `checked: false` is carried through rather than treated as absent: the
    // two mean different things to the renderer. See `MenuItem.checked`.
    ...(extra.checked === undefined ? {} : { checked: extra.checked }),
    ...(extra.danger === true ? { danger: true } : {}),
    ...(extra.disabled === true ? { disabled: true } : {}),
    ...(extra.items === undefined ? {} : { items: extra.items }),
  };
}

/**
 * "Set icon…" on one folder or note, where its icon can be changed from here.
 * Notes since 2026-10-13 (the owner: "add emojis to plain notes like
 * activity"); other files (a picture, a PDF) have none.
 *
 * Editor only, and absent rather than disabled like every other write. Not on
 * a built-in folder, whose job's drawn icon is the point: `menu.ts` leaves this
 * group out for a row with a job (`menuBuiltIn.ts`).
 */
export function iconGroup(context: MenuContext, row: TreeRow | null): MenuItem[] {
  if (!context.canEdit || row === null) return [];
  if (row.kind !== "folder" && !(row.kind === "file" && /\.md$/i.test(row.path))) return [];
  return [makeItem(context, "setIcon", "Set icon…")];
}

/**
 * "Move up" and "Move down" on one folder: its place among its sibling
 * folders, as the list draws them (owner, 2026-10-18: an order on the row
 * replaces number prefixes). Editor only, like every write, and only where the
 * caller knows the folder's place (`folderPlace`). At an end the way it cannot
 * go is dimmed, not dropped, so the pair keeps its place under a pointer; a
 * folder alone at its level gets neither.
 */
export function orderGroup(context: MenuContext, row: TreeRow | null): MenuItem[] {
  if (!context.canEdit || row === null || row.kind !== "folder") return [];
  const place = context.folderPlace?.(row.path) ?? null;
  if (place === null) return [];
  return [
    makeItem(context, "moveUp", "Move up", place.first ? { disabled: true } : {}),
    makeItem(context, "moveDown", "Move down", place.last ? { disabled: true } : {}),
  ];
}

/** "Pin to Home" or "Unpin from Home", for one row, where there is a Home to pin to. */
export function pinGroup(context: MenuContext, single: TreeRow | null): MenuItem[] {
  if (context.pinned === undefined || single === null) return [];
  return context.pinned(single.path)
    ? [makeItem(context, "unpin", "Unpin from Home")]
    : [makeItem(context, "pin", "Pin to Home")];
}

/** "Tags", with the folder's tags beside it, where they can be changed from here. */
export function tagsGroup(context: MenuContext, row: TreeRow): MenuItem[] {
  const tags = context.tagsOf?.(row.path);
  if (tags == null) return [];
  const item = makeItem(context, "tags", "Tags");
  return [tags.length === 0 ? item : { ...item, value: tags.join(", ") }];
}

/**
 * Download, as its own group, or nothing.
 *
 * Shared by the row menu and the breadcrumb menu, and by both of their
 * read-only branches, because it is the one item those branches keep: it is a
 * read, and non-negotiable #1 says the exit is never gated. A second copy of
 * "is this offered" is how one of the four ends up without it.
 */
export function downloadGroup(context: MenuContext, target: { kind: string } | null): MenuItem[] {
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
