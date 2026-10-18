/**
 * Where the Inbox and the Archive are now, by job and not by name.
 *
 * An Inbox renamed Capture is still where quick notes land and what the
 * phone's first page lists; an Archive renamed or moved is still where
 * Restore reads an archived path from. Most places that ask have the
 * listings to hand and use `inboxFolder` / `archiveFolder`. A few do not: the
 * phone's pages are built from notes rather than listings, and `restoreTargetFor`
 * and the offline mirror's download rule are plain functions of a path. They
 * read this, which the open file browser sets from its listings
 * (`useFolderJobs`), the way `homeView.ts` holds which top page is showing.
 *
 * Until the root has listed it answers the default names, which the server
 * also reads as the folders doing those jobs (`jobPath`).
 */

import { DEFAULT_FOLDER } from "@context/shared/src/folderRoles.cjs";

let now: { inbox: string; archive: string } = { inbox: DEFAULT_FOLDER.inbox, archive: DEFAULT_FOLDER.archive };

/** The folder doing the Inbox's job now. */
export function inboxFolderNow(): string {
  return now.inbox;
}

/** The folder doing the Archive's job now. */
export function archiveFolderNow(): string {
  return now.archive;
}

/** Told by the file browser as its listings change. Idempotent. */
export function setJobFoldersNow(next: { inbox: string; archive: string }): void {
  if (next.inbox === now.inbox && next.archive === now.archive) return;
  now = { ...next };
}
