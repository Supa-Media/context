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
}
export type FolderMenuState = FolderMenuOpen | null;
