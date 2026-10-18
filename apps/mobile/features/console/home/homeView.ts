import { useEffect, useState } from "react";

/**
 * WHICH OF THE PHONE'S TWO TOP PAGES IS SHOWING: INBOX OR FOLDERS.
 *
 * The leadership weekly of 2026-10-17: *"maybe it should open you up in the
 * inbox instead of opening it at home"*. The phone now starts on Inbox — the
 * loose notes, with folders shrunk to one row of small round icons — and the
 * last of those icons, "All", opens Folders, which is what Home was, slimmed
 * to Pinned and the folder list (boards 1 and 2,
 * `meeting-2026-10-17/phone-inbox/`).
 *
 * Both are the workspace's own page — nothing is selected on either — so the
 * difference is not a path and does not belong in `?note=`, whose rules
 * (`noteAddress.ts`) are about which note is open. It is held here, the way
 * `homeTag.ts` holds a tag: a module value any surface can set (the back
 * button, a tag pressed in search) and the page reads.
 *
 * A launch starts on Inbox, always: that is the point.
 */
export type HomeView = "inbox" | "folders";

let current: HomeView = "inbox";
const listeners = new Set<(view: HomeView) => void>();

export function setHomeView(view: HomeView): void {
  if (view === current) return;
  current = view;
  for (const listener of listeners) listener(view);
}

export function homeView(): HomeView {
  return current;
}

export function useHomeView(): HomeView {
  const [view, setView] = useState<HomeView>(current);
  useEffect(() => {
    setView(current);
    listeners.add(setView);
    return () => {
      listeners.delete(setView);
    };
  }, []);
  return view;
}

/**
 * The page key Folders slides under (`PageSlide`): Inbox is `""`, the
 * workspace's own page as it always was, and Folders sits one step in from it.
 */
export const FOLDERS_PAGE = "\u0000folders";

/**
 * The Inbox's folder before anything has listed: where a quick note lands
 * (Dev2, 2026-09-30: "inbox is the default folder") and what the phone's
 * first page lists. Read `inboxFolderNow()` instead: the Inbox can be renamed,
 * and that answers the folder doing its job (`files/jobIcons/jobFoldersNow.ts`).
 */
export const INBOX_FOLDER = "0-inbox";

export { inboxFolderNow } from "../files/jobIcons/jobFoldersNow";
