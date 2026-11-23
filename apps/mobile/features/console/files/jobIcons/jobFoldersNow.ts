/**
 * Where the Inbox, the Projects folder, the Archive and the website's folder
 * are now, by job and not by name.
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
 * The Projects folder is read here by the folder page (`isProjectsFolder`:
 * List, Board and statuses) and by the note's property chips (Status, Owner,
 * Priority and Due date are offered only on a note in it). It used to be
 * "the word project in a folder's name", which lost a Projects folder renamed
 * Work and gave an Areas folder called Side projects a status column (owner,
 * 2026-10-18, picking board A of `loose-note-chips`).
 *
 * Until the root has listed it answers the default names, which the server
 * also reads as the folders doing those jobs (`jobPath`).
 */

import { DEFAULT_FOLDER, WEBSITE_FOLDER } from "@context/shared/src/folderRoles.cjs";

type JobFolders = { inbox: string; projects: string; areas: string; archive: string; website: string };

let now: JobFolders = {
  inbox: DEFAULT_FOLDER.inbox,
  projects: DEFAULT_FOLDER.projects,
  areas: DEFAULT_FOLDER.areas,
  archive: DEFAULT_FOLDER.archive,
  website: WEBSITE_FOLDER,
};

/** The folder doing the Inbox's job now. */
export function inboxFolderNow(): string {
  return now.inbox;
}

/** The folder doing the Projects folder's job now. */
export function projectsFolderNow(): string {
  return now.projects;
}

/** Whether `folder` is the Projects folder or anywhere under it, by job. */
export function inProjectsNow(folder: string): boolean {
  const projects = now.projects;
  return folder === projects || folder.startsWith(`${projects}/`);
}

/** The folder doing the Areas folder's job now: where a folder page offers List and Chart (`folderPage/areas/`). */
export function areasFolderNow(): string {
  return now.areas;
}

/** Whether `folder` is the Areas folder or anywhere under it, by job. */
export function inAreasNow(folder: string): boolean {
  const areas = now.areas;
  return folder === areas || folder.startsWith(`${areas}/`);
}

/** The folder doing the Archive's job now. */
export function archiveFolderNow(): string {
  return now.archive;
}

/** The website's folder now, wherever it is nested: where Publish is offered (`PublishWebsite.tsx`). */
export function websiteFolderNow(): string {
  return now.website;
}

/**
 * Told by the file browser as its listings change. Idempotent. A caller that
 * leaves `projects` or `website` out leaves it where it was.
 */
export function setJobFoldersNow(next: { inbox: string; archive: string; projects?: string; areas?: string; website?: string }): void {
  const projects = next.projects ?? now.projects;
  const areas = next.areas ?? now.areas;
  const website = next.website ?? now.website;
  if (next.inbox === now.inbox && next.archive === now.archive && projects === now.projects && areas === now.areas && website === now.website) return;
  now = { inbox: next.inbox, projects, areas, archive: next.archive, website };
}
