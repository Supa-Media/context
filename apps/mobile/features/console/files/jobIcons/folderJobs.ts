/**
 * Which loaded folder does which job, and where folders sit among their
 * siblings, read from the listings the console already holds.
 *
 * A built-in folder's job is on its listing entry (`role`, from its tree row:
 * `apps/convex/functions/lib/nodes/listing.ts`), so an Inbox renamed Capture,
 * or moved into Projects, is still the Inbox here. A listing with no job on
 * any entry (the offline mirror's, the demo's, an older server's) falls back
 * at the root to what the names say, the way the server does for a folder no
 * row claims (`folderJobs`). Below the root a name is only a name.
 *
 * Pure, like the rest of this folder, so it is tested without a renderer
 * (`__tests__/folderJobsModel.test.ts`).
 */

import {
  DEFAULT_FOLDER,
  JOB_LABEL,
  ROLE_DESCRIPTION,
  compareListingEntries,
  folderJobs,
  isRowRole,
  jobAt,
  WEBSITE_FOLDER,
  type RowRole,
} from "@context/shared/src/folderRoles.cjs";
import { texPartIcon } from "@context/shared/src/folderIcons.cjs";
import { parentPath } from "../paths";

/** The fields of a listing entry this reads. */
export interface JobEntry {
  kind: string;
  path: string;
  name: string;
  role?: string | null;
  order?: number | null;
  archiveOf?: string | null;
}

export interface JobListing<Entry extends JobEntry = JobEntry> {
  entries: readonly Entry[];
}

export type JobListings = Readonly<Record<string, JobListing | undefined>>;

/** The job of each folder in one listing (`folder` is the listing's own path, `""` the root). */
export function listingJobs(folder: string, listing: JobListing): Map<string, RowRole> {
  const jobs = new Map<string, RowRole>();
  const folders = listing.entries.filter((entry) => entry.kind === "folder");
  for (const entry of folders) if (isRowRole(entry.role)) jobs.set(entry.path, entry.role);
  if (folder !== "" || jobs.size > 0) return jobs;
  // No job on any root entry: a listing from before jobs were on rows. Names decide.
  const byName = folderJobs(folders.map((entry) => ({ path: entry.path, name: entry.name, top: true })));
  for (const entry of folders) {
    const job = jobAt(byName, entry.path);
    if (job !== null) jobs.set(entry.path, job);
  }
  return jobs;
}

/** The job of every loaded folder that has one. */
export function loadedJobs(listings: JobListings): Map<string, RowRole> {
  const jobs = new Map<string, RowRole>();
  for (const [folder, listing] of Object.entries(listings)) {
    if (listing === undefined) continue;
    for (const [path, job] of listingJobs(folder, listing)) if (!jobs.has(path)) jobs.set(path, job);
  }
  return jobs;
}

/**
 * The drawn part of a folder or note of Tex's own (`texPartIcon`), under the
 * folder whose job is Tex wherever it is nested, or `null`. Parts sit at most
 * two below it (`routines/every-day`).
 */
export function texPartIconUnder(jobs: ReadonlyMap<string, RowRole>, path: string): string | null {
  for (let above = parentPath(path), depth = 0; above !== "" && depth < 2; above = parentPath(above), depth += 1) {
    if (jobs.get(above) === "tex") return texPartIcon(path.slice(above.length + 1));
  }
  return null;
}

/**
 * Each loaded folder in Archive that is the archive copy of a built-in folder
 * (`archiveOf`, `lib/nodes/archiveTwins.ts`), by the job it mirrors.
 */
export function loadedTwins(listings: JobListings): Map<string, RowRole> {
  const twins = new Map<string, RowRole>();
  for (const listing of Object.values(listings)) {
    for (const entry of listing?.entries ?? []) {
      if (entry.kind === "folder" && isRowRole(entry.archiveOf)) twins.set(entry.path, entry.archiveOf);
    }
  }
  return twins;
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/**
 * The job of the folder at `path`: its job, `null` for none, or `undefined`
 * when the listing it sits in has not loaded and nobody can say.
 */
export function jobOfPath(listings: JobListings, path: string): RowRole | null | undefined {
  const parent = parentOf(path);
  const listing = listings[parent];
  if (listing === undefined) return undefined;
  return listingJobs(parent, listing).get(path) ?? null;
}

/** Whether the folder at `path` is a built-in folder's archive copy, as its loaded listing says. */
export function isTwinPath(listings: JobListings, path: string): boolean {
  const entry = listings[parentOf(path)]?.entries.find((candidate) => candidate.path === path);
  return entry?.kind === "folder" && isRowRole(entry.archiveOf);
}

/**
 * Where the folder doing `job` is, among the loaded listings, else `fallback`
 * (the job's default name). The fallback is right until the root has loaded,
 * and still a safe write target after: the server reads a default name as
 * the folder doing that job (`jobPath`).
 */
export function jobFolder(listings: JobListings, job: RowRole, fallback: string): string {
  const root = listings[""];
  if (root !== undefined) {
    for (const [path, found] of listingJobs("", root)) if (found === job) return path;
  }
  for (const [path, found] of loadedJobs(listings)) if (found === job) return path;
  return fallback;
}

/** Where the Inbox is: the folder doing its job, else `inbox`. */
export function inboxFolder(listings: JobListings): string {
  return jobFolder(listings, "inbox", DEFAULT_FOLDER.inbox);
}

/** Where the Projects folder is: the folder doing its job, else `projects`. */
export function projectsFolder(listings: JobListings): string {
  return jobFolder(listings, "projects", DEFAULT_FOLDER.projects);
}

/** Where the Archive is: the folder doing its job, else `9-archive`. */
export function archiveFolder(listings: JobListings): string {
  return jobFolder(listings, "archive", DEFAULT_FOLDER.archive);
}

/** Where the website's folder is, wherever it is nested: the folder doing its job, else `website`. */
export function websiteFolder(listings: JobListings): string {
  return jobFolder(listings, "website", WEBSITE_FOLDER);
}

/**
 * The line under a built-in folder's title (board 9): "Built-in Inbox." and
 * what lands there, or `null` when its name already says the job (an Inbox
 * still called Inbox, or `0-inbox`). Plain words, in the folder's own terms.
 */
export function builtInLine(job: RowRole, name: string): string | null {
  const label = JOB_LABEL[job];
  if (name.toLowerCase().includes(label.toLowerCase())) return null;
  const about = (ROLE_DESCRIPTION as Readonly<Record<string, string>>)[job];
  return about === undefined ? `Built-in ${label}.` : `Built-in ${label}. ${about}`;
}

/* -------------------------------------------------------------------------- */
/*                                 sibling order                               */
/* -------------------------------------------------------------------------- */

/** The folders beside `path` (itself included), in the order its listing draws them, or `null` before it has loaded. */
export function siblingFolders(listings: JobListings, path: string): string[] | null {
  const listing = listings[parentOf(path)];
  if (listing === undefined) return null;
  const folders = listing.entries.filter((entry) => entry.kind === "folder").map((entry) => entry.path);
  return folders.includes(path) ? folders : null;
}

/** Where a folder sits among its siblings, for the menu: `null` when it cannot be moved among them. */
export function folderPlace(listings: JobListings, path: string): { first: boolean; last: boolean } | null {
  const siblings = siblingFolders(listings, path);
  if (siblings === null || siblings.length < 2) return null;
  const index = siblings.indexOf(path);
  return { first: index === 0, last: index === siblings.length - 1 };
}

/** `siblings` with `path` one place up or down, or `null` when it is already at that end. */
export function reorderedSiblings(siblings: readonly string[], path: string, direction: "up" | "down"): string[] | null {
  const index = siblings.indexOf(path);
  if (index < 0) return null;
  const to = direction === "up" ? index - 1 : index + 1;
  if (to < 0 || to >= siblings.length) return null;
  const next = [...siblings];
  next[index] = siblings[to]!;
  next[to] = path;
  return next;
}

/** The step `folderOrder.set` writes between neighbours (`ORDER_STEP` there). */
export const ORDER_STEP = 10;

/**
 * `listing` (whose path is `parent`) as it reads once `folders` are in that
 * order: each named folder takes `order` index × 10, as the server writes, and
 * the entries are sorted by the server's own comparator, so the row moves now
 * and does not move again when the confirming listing arrives.
 */
export function withFolderOrder<Entry extends JobEntry, L extends JobListing<Entry>>(
  parent: string,
  listing: L,
  folders: readonly string[],
): L {
  const place = new Map(folders.map((path, index) => [path, index * ORDER_STEP]));
  const entries = listing.entries.map((entry) => {
    const order = entry.kind === "folder" ? place.get(entry.path) : undefined;
    return order === undefined ? entry : { ...entry, order };
  });
  entries.sort((a, b) => compareListingEntries(parent, a, b));
  return { ...listing, entries };
}
