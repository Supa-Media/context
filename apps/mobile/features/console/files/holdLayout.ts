/**
 * What a press and hold on a phone row shows, Apple Notes' way (the owner's
 * board of 2026-10-16): the row lifts as a preview, and a short menu sits
 * under it with Share, Move and Delete across the top, the everyday verbs in
 * a list, Select on its own, and More for the rest.
 *
 * **It invents no item.** The items are `menu.ts`'s own for the row, so a
 * hold can never offer what a right-click would refuse; this only decides
 * which of them stand where, and shortens a label where the row it sits in
 * already says the rest ("Move to…" is "Move" under a Move glyph). Anything
 * it does not place goes to More untouched, which is how a new verb added to
 * `menu.ts` stays reachable on a phone without anybody remembering this file.
 */

import { countLabel, whenLabel, type HomeNote } from "../home/homeModel";
import type { MenuActionId, MenuItem } from "./menu";
import { baseName, displayName, folderLabel, parentPath } from "./paths";

export interface HoldLayout {
  /** The three across the top, in this order: Share, Move, Delete. */
  top: MenuItem[];
  /** The list under them. */
  main: MenuItem[];
  /** Behind More, in the row menu's own order and grouping. */
  more: MenuItem[];
}

/**
 * The top row, in order, with the word each is shown with.
 *
 * Delete is the trash with Undo, as it is in the row menu.
 */
const TOP: readonly (readonly [MenuActionId, string])[] = [
  ["share", "Share"],
  ["moveTo", "Move"],
  ["delete", "Delete"],
];

const MAIN: readonly (readonly [MenuActionId, string])[] = [
  // Something already in the archive is put back first, before anything else is done to it.
  ["restore", "Restore"],
  ["pin", "Pin to Home"],
  ["unpin", "Unpin from Home"],
  ["rename", "Rename"],
  ["duplicate", "Duplicate"],
  ["newNote", "New note here"],
  ["setIcon", "Icon"],
];

/** Never offered from a hold: tapping the lifted preview is Open. */
const DROPPED: ReadonlySet<MenuActionId> = new Set(["open"]);

export function holdLayout(items: readonly MenuItem[]): HoldLayout {
  // A disabled row (a built-in folder's Rename and Delete) is an explanation,
  // not a verb, and an explanation belongs with the rest under More.
  const usable = (id: MenuActionId) => items.find((item) => item.id === id && item.disabled !== true);
  const placed = new Set<MenuItem>();
  const take = (pairs: readonly (readonly [MenuActionId, string])[]) =>
    pairs.flatMap(([id, label]) => {
      const item = usable(id);
      if (item === undefined) return [];
      placed.add(item);
      const { separatorBefore: _dropped, ...rest } = item;
      return [{ ...rest, label }];
    });
  const top = take(TOP);
  const main = take(MAIN);
  const more: MenuItem[] = [];
  for (const item of items) {
    if (placed.has(item) || DROPPED.has(item.id)) continue;
    const { separatorBefore, ...rest } = item;
    more.push(more.length > 0 && separatorBefore === true ? { ...rest, separatorBefore } : rest);
  }
  return { top, main, more };
}

/** What the lifted card shows: a note's opening, or a folder's newest notes. */
export type HoldPreview =
  | { kind: "note"; title: string; meta: string | null; text: string | null }
  | {
      kind: "folder";
      title: string;
      meta: string;
      notes: { path: string; title: string; text: string | null }[];
    };

/** How many of a folder's notes its lifted card lists. */
export const FOLDER_PREVIEW_NOTES = 3;

/**
 * The preview for one row, from what this device already holds about the
 * workspace's notes (`useHomeSource`): no read of the note's body, so a hold
 * never waits on the network or the bucket.
 */
export function holdPreview(
  entry: { kind: "file" | "folder"; path: string; name: string; updatedAt?: number },
  notes: readonly HomeNote[],
  folders: readonly string[],
  now: number,
): HoldPreview {
  if (entry.kind === "folder") {
    const prefix = `${entry.path}/`;
    const inside = notes.filter((note) => note.path.startsWith(prefix));
    const newest = [...inside]
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, FOLDER_PREVIEW_NOTES)
      .map((note) => ({ path: note.path, title: note.title, text: note.lede }));
    const subfolders = folders.filter((path) => path.startsWith(prefix)).length;
    const latest = inside.reduce((at, note) => Math.max(at, note.updatedAt ?? 0), 0);
    return {
      kind: "folder",
      title: folderLabel(entry.name),
      meta: [countLabel(inside.length, subfolders), ...(latest > 0 ? [`changed ${whenLabel(latest, now)}`] : [])].join(
        " · ",
      ),
      notes: newest,
    };
  }
  const note = notes.find((candidate) => candidate.path === entry.path);
  const at = note?.updatedAt ?? entry.updatedAt;
  const place = folderLabel(baseName(parentPath(entry.path)));
  const meta = [place, ...(at === undefined ? [] : [whenLabel(at, now)])].filter((part) => part !== "").join(" · ");
  return {
    kind: "note",
    title: note?.title ?? displayName(entry.name),
    meta: meta === "" ? null : meta,
    text: note?.lede ?? null,
  };
}
