import type { itemsFor, MenuTarget } from "../../files/menu";

/**
 * An open listing menu: what it was opened on, kept whole.
 *
 * The target rather than a path, for the reason `Explorer`'s own `MenuOpen`
 * gives: a menu built for one target and dispatched against another is a paste
 * into the wrong folder, and storing the object that was offered makes that
 * unrepresentable.
 */
export interface FolderMenuOpen {
  target: MenuTarget;
  title: string;
  anchor: { x: number; y: number };
  items: ReturnType<typeof itemsFor>;
  /**
   * Opened by a press and hold on a phone row, so drawn as the lifted preview
   * and short menu (`HoldMenu.tsx`) rather than the sheet. More turns it back
   * into the sheet, with the items the hold menu did not place.
   */
  hold?: boolean;
}
export type FolderMenuState = FolderMenuOpen | null;
