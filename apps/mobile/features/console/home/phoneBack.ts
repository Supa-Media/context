import type { SlideDirection } from "../../design/components/PageSlide";
import { baseName, displayName, isMarkdown, parentPath } from "../files/paths";
import { scopeLabel } from "../layout/SearchScope";
import { FOLDERS_PAGE, inboxFolderNow, setHomeView, type HomeView } from "./homeView";
import { leavePage, previousPage } from "./phoneHistory";

/**
 * WHERE THE PHONE'S BACK BUTTON GOES, AND WHAT IT SAYS.
 *
 * The owner's review of the phone Home (2026-10-01): *"we should probably put
 * back buttons at the top left when people click into folders or notes for
 * quick navigation"*. The way up used to be the path row under the top bar —
 * the workspace's pill, then each folder — which scrolled away with the page
 * and was a row of small targets rather than one obvious one.
 *
 * **Back is the page before this one** (Dev2, 2026-10-18: *"it should take me
 * to the previous page, regardless of how nested the note i clicked was"*),
 * from `phoneHistory.ts`. Only a page with nothing before it — the app opened
 * straight onto it by a link — goes **up** instead, one level, naming where it
 * goes: a note to its folder, a folder to the folder it is in, the top of the
 * workspace to Folders. That was the whole rule from 2026-10-01 until Notes
 * began listing notes from every folder, when up became a walk through pages
 * nobody had opened.
 *
 * The phone starts on Notes (leadership weekly, 2026-10-17; `homeView.ts`),
 * so the top of the ladder is Notes, then Folders. A note lying loose in the
 * Inbox goes up to Notes.
 *
 * Nothing on Notes itself, where the slot is the workspace's own button.
 */
export interface PhoneBackTarget {
  /** The folder to open, or `null` for one of the two top pages. */
  folder: string | null;
  /** What the button says: the page's name, "Notes" or "Folders". */
  label: string;
  /** Which top page, when `folder` is `null`. */
  view?: HomeView;
}

/**
 * The phone's first page. It was called Inbox (2026-10-17) until it listed
 * hand-written notes from every folder; Dev2 (2026-10-18): *"the header being
 * inbox is a little weird when it's not actually the inbox folder"*.
 */
export const HOME_LABEL = "Notes";
export const FOLDERS_LABEL = "Folders";
export const VISITOR_HOME_LABEL = "Home";

/** Where a page key (`PageSlide`'s, as `phoneHistory.ts` keeps them) goes back to. */
export function pageTarget(key: string, visitor = false): PhoneBackTarget {
  if (key === "") return { folder: null, label: visitor ? VISITOR_HOME_LABEL : HOME_LABEL, view: "inbox" };
  if (key === FOLDERS_PAGE) return { folder: null, label: FOLDERS_LABEL, view: "folders" };
  return { folder: key, label: isMarkdown(key) ? displayName(baseName(key)) : scopeLabel(key) };
}

/**
 * Home first, then where ‹ goes: the page before this one when there is one
 * (`previous`, from `phoneHistory.ts`), else every level above the page down
 * to its own folder, ‹ going to the last (owner, 2026-10-15: one press, one
 * level). Holding ‹ goes to the first.
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
  /** The page shown before this one, as a page key; `null` for none. */
  previous: string | null = null,
): PhoneBackTarget[] {
  const up = upLevels(selectedPath, mapOpen, view, visitor);
  if (previous === null || up.length === 0 || mapOpen) return up;
  const home = up[0]!;
  const back = pageTarget(previous, visitor);
  return back.folder === null && back.view === home.view ? [home] : [home, back];
}

function upLevels(selectedPath: string | null, mapOpen: boolean, view: HomeView, visitor: boolean): PhoneBackTarget[] {
  const home: PhoneBackTarget = { folder: null, label: visitor ? VISITOR_HOME_LABEL : HOME_LABEL, view: "inbox" };
  if (mapOpen) return [home];
  if (selectedPath === null || selectedPath === "") return view === "folders" && !visitor ? [home] : [];
  const parent = parentPath(selectedPath);
  if (parent === inboxFolderNow() && !visitor) return [home];
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
 * note found by search, and returning to the page before is back. `""` is Notes and `FOLDERS_PAGE` is Folders, one
 * step in from it.
 */
export function slideDirection(from: string, to: string): SlideDirection {
  if (from === to) return "none";
  // Back to the page before, wherever it is: read before this visit is recorded.
  if (previousPage() === to) return "back";
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
  const key = target.folder ?? (target.view === "folders" ? FOLDERS_PAGE : "");
  if (key !== previousPage()) leavePage(key === "");
  if (target.folder !== null) {
    void files.select(target.folder);
    return;
  }
  setHomeView(target.view ?? "inbox");
  void files.deselect();
}
