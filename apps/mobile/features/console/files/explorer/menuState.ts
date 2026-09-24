import type { itemsFor, MenuTarget } from "../menu";

export interface MenuOpen {
  /**
   * What the menu was opened on, kept whole.
   *
   * It used to be the `TreeRow` alone, which was enough while a row was the
   * only thing in the console that had a menu. The dispatcher now takes a
   * `MenuTarget`, and storing the target rather than re-deriving one on
   * selection is what keeps "what was offered" and "what runs" the same
   * object — a menu built for the background and dispatched against a row is
   * a paste into the wrong folder.
   */
  target: MenuTarget;
  /** For the popover's title. Absent where the target has no single name. */
  title: string;
  anchor: { x: number; y: number };
  items: ReturnType<typeof itemsFor>;
}
export type MenuState = MenuOpen | null;
