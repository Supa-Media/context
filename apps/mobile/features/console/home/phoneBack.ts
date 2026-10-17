import type { SlideDirection } from "../../design/components/PageSlide";
import { parentPath } from "../files/paths";
import { scopeLabel } from "../layout/SearchScope";
import { FOLDERS_PAGE, INBOX_FOLDER, setHomeView, type HomeView } from "./homeView";

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
 * the top of the workspace to Folders. Up rather than history, because history
 * after a search or a link is a place nobody remembers being; up is always the
 * same answer for the same page.
 *
 * The phone starts on Inbox now (leadership weekly, 2026-10-17; `homeView.ts`),
 * so the top of the ladder is Inbox, then Folders. A note lying loose in the
 * Inbox goes straight back to Inbox, the page it was opened from.
 *
 * Nothing on Inbox itself, where the slot is the workspace's own button.
 */
export interface PhoneBackTarget {
  /** The folder to open, or `null` for one of the two top pages. */
  folder: string | null;
  /** What the button says: the folder's name, "Inbox" or "Folders". */
  label: string;
  /** Which top page, when `folder` is `null`. */
  view?: HomeView;
}

export const HOME_LABEL = "Inbox";
export const FOLDERS_LABEL = "Folders";
export const VISITOR_HOME_LABEL = "Home";

/**
 * Every level above the page, Home first and the page's own folder last;
 * ‹ goes to the last one (owner, 2026-10-15: one press, one level).
 *
 * From 2026-10-13 to 2026-10-15 ‹ opened these as a menu; the owner then
 * asked for a back button that just goes back, pressed once per level.
 *
 * `[]` on Home, which has no ‹.
 */
export function phoneBackLevels(
  selectedPath: string | null,
  mapOpen = false,
  view: HomeView = "inbox",
  /**
   * The homepage's visitor, whose one top page is the workspace's own (they
   * have no Inbox): one level above the top, called Home, as before.
   */
  visitor = false,
): PhoneBackTarget[] {
  const home: PhoneBackTarget = { folder: null, label: visitor ? VISITOR_HOME_LABEL : HOME_LABEL, view: "inbox" };
  if (mapOpen) return [home];
  if (selectedPath === null || selectedPath === "") return view === "folders" && !visitor ? [home] : [];
  const parent = parentPath(selectedPath);
  if (parent === INBOX_FOLDER && !visitor) return [home];
  const levels: PhoneBackTarget[] = visitor ? [home] : [home, { folder: null, label: FOLDERS_LABEL, view: "folders" }];
  const segments = parent.split("/").filter(Boolean);
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
 * note found by search. `""` is Inbox and `FOLDERS_PAGE` is Folders, one
 * step in from it.
 */
export function slideDirection(from: string, to: string): SlideDirection {
  if (from === to) return "none";
  if (to === "") return "back";
  if (from === "") return "forward";
  if (to === FOLDERS_PAGE) return "back";
  if (from === FOLDERS_PAGE) return "forward";
  if (from.startsWith(`${to}/`)) return "back";
  return "forward";
}

/**
 * Go to one of the levels: a folder by selecting it, or one of the two top
 * pages by saying which and closing whatever is open. The one place both
 * callers of `PhoneBack` go through, so a ‹ and a swipe cannot disagree.
 */
export function goToLevel(
  target: PhoneBackTarget,
  files: { select: (path: string) => unknown; deselect: () => unknown },
): void {
  if (target.folder !== null) {
    void files.select(target.folder);
    return;
  }
  setHomeView(target.view ?? "inbox");
  void files.deselect();
}
