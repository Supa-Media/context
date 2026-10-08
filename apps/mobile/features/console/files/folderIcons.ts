/**
 * Folder icons as the console holds them: the emoji somebody gave a folder
 * from "Set icon…" in its menu, or nothing.
 *
 * The rules that move icons with their folders live in `@context/shared`'s
 * `folderIcons.cjs`, which the server runs too. This file is the console's side
 * of that: the plain map it keeps, and the lookup, which must not answer for a
 * folder whose name happens to be an object property ("constructor").
 *
 * Pure, so the hook that holds the map (`fileBrowser/useFolderIcons.ts`) can
 * be tested through it without a renderer.
 */

import { iconsAfterDelete, iconsAfterMove } from "@context/shared/src/folderIcons.cjs";

/** Folder path to emoji. Never mutated: every change is a new object. */
export type IconMap = Readonly<Record<string, string>>;

/** The server's answer shape, from `api.functions.folderIcons`. */
export type IconList = readonly { path: string; icon: string }[];

export function iconMapOf(list: IconList): IconMap {
  // `fromEntries` defines each key as an own property, so a folder named
  // `__proto__` is kept as a folder rather than setting the map's prototype.
  return Object.fromEntries(list.map(({ path, icon }) => [path, icon]));
}

/** The emoji on `path`, or `null`. Own properties only: see the header. */
export function iconFor(icons: IconMap, path: string): string | null {
  return Object.prototype.hasOwnProperty.call(icons, path) ? icons[path]! : null;
}

/** The map with `path` set to `icon`, or without it when `icon` is `null`. */
export function withIcon(icons: IconMap, path: string, icon: string | null): IconMap {
  const next: Record<string, string> = { ...icons };
  if (icon === null) delete next[path];
  else next[path] = icon;
  return next;
}

/** The map after `from` moved to `to`, its icon and those beneath it going along. The same object when nothing moved. */
export function movedIcons(icons: IconMap, from: string, to: string): IconMap {
  return iconsAfterMove(icons, from, to) ?? icons;
}

/** The map after `path` and everything beneath it are gone. The same object when none were. */
export function removedIcons(icons: IconMap, path: string): IconMap {
  return iconsAfterDelete(icons, path) ?? icons;
}
