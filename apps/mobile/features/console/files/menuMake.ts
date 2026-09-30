import { describeBinding, type Command } from "../../design/keymap";
import type { MenuActionId, MenuContext } from "./menu";
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
  extra: { danger?: boolean; items?: MenuItem[]; detail?: string; checked?: boolean } = {},
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
    ...(extra.items === undefined ? {} : { items: extra.items }),
  };
}
