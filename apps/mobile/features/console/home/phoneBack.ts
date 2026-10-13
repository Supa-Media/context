import type { SlideDirection } from "../../design/components/PageSlide";
import { parentPath } from "../files/paths";
import { scopeLabel } from "../layout/SearchScope";

/**
 * WHERE THE PHONE'S BACK BUTTON GOES, AND WHAT IT SAYS.
 *
 * The owner's review of the phone Home (2026-10-01): *"we should probably put
 * back buttons at the top left when people click into folders or notes for
 * quick navigation"*. The way up used to be the path row under the top bar —
 * the workspace's pill, then each folder — which scrolled away with the page
 * and was a row of small targets rather than one obvious one.
 *
 * Apple Notes' rule: back is **up**, one level, and it names where it goes.
 * A note goes to its folder, a folder to the folder it is in, and anything at
 * the top of the workspace to Home. Up rather than history, because history
 * after a search or a link is a place nobody remembers being; up is always the
 * same answer for the same page.
 *
 * Nothing on Home itself, where the slot is the workspace's own button.
 */
export interface PhoneBackTarget {
  /** The folder to open, or `null` for Home. */
  folder: string | null;
  /** What the button says: the folder's name, or "Home". */
  label: string;
}

export const HOME_LABEL = "Home";

/**
 * Every place ‹ can take you, Home first and the page's own folder last.
 *
 * The owner's pick for the note's top bar (2026-10-13): pressing ‹ opens a
 * short menu of the levels above the page — *"I like the idea of clicking back
 * and then the menu opening"* — instead of a capsule that spelled out one
 * folder's name. Home is always the first row, which is how the bar gets its
 * Home button without a second one.
 *
 * `[]` on Home. A page at the top of the workspace has one level, Home, and the
 * button goes straight there: a menu with one row is a press that asks you to
 * press again.
 */
export function phoneBackLevels(selectedPath: string | null, mapOpen = false): PhoneBackTarget[] {
  const home: PhoneBackTarget = { folder: null, label: HOME_LABEL };
  if (mapOpen) return [home];
  if (selectedPath === null || selectedPath === "") return [];
  const levels = [home];
  const segments = parentPath(selectedPath).split("/").filter(Boolean);
  segments.forEach((_, index) => {
    const folder = segments.slice(0, index + 1).join("/");
    levels.push({ folder, label: scopeLabel(folder) });
  });
  return levels;
}

/**
 * Which way a page change slides: deeper is forward, up is back.
 *
 * Read against the page that was on screen, so a jump sideways — a search
 * result, a link to another folder — is forward, the way Apple Notes pushes a
 * note found by search. `""` is Home.
 */
export function slideDirection(from: string, to: string): SlideDirection {
  if (from === to) return "none";
  if (to === "") return "back";
  if (from === "") return "forward";
  if (from.startsWith(`${to}/`)) return "back";
  return "forward";
}
