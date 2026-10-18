/**
 * Which folder does each built-in job, as Settings › Built-in folders, the
 * import picker and "Use this folder as…" draw it (owner, 2026-10-18, every
 * board of "Built-in folder jobs"; `docs/decisions/app-and-console/folder-jobs.md`).
 *
 * The server answers (`builtInFolders.jobs`); this file only shapes that
 * answer for the screen, so it is tested without one.
 */

import { GROUP_LABEL, type JobGroup } from "@context/shared/src/folderJobInfo.cjs";

/** One job, as `builtInFolders.jobs` answers it. */
export interface FolderJobRow {
  job: string;
  label: string;
  group: string;
  line: string;
  /** The folder doing it now, wherever it is nested, or `null` (none, or not one this person can see). */
  path: string | null;
  canChange: boolean;
  canRemove: boolean;
}

/** `builtInFolders.jobs`. */
export interface FolderJobsAnswer {
  jobs: FolderJobRow[];
  inboxParts: { name: string; label: string; path: string | null }[];
  guesses: { job: string; path: string; why: string }[];
  missingNeeded: string[];
  /** Folders a job can be given to (owner only). */
  folders: string[];
}

/** The groups in the order they are drawn, each with its jobs. */
export function groupedJobs(answer: FolderJobsAnswer): { group: JobGroup; label: string; hint: string; jobs: FolderJobRow[] }[] {
  const groups: JobGroup[] = ["needed", "made", "optional"];
  return groups
    .map((group) => ({ group, label: GROUP_LABEL[group], hint: GROUP_HINT[group], jobs: answer.jobs.filter((row) => row.group === group) }))
    .filter((entry) => entry.jobs.length > 0);
}

const GROUP_HINT: Readonly<Record<JobGroup, string>> = {
  needed: "Always one each. They can move, never be removed.",
  made: "Context makes these the first time they're used.",
  optional: "Add them if they're useful.",
};

/** A folder path as the crumbs it is drawn with: `Life › Personal › Assistant`. */
export function pathCrumbs(path: string): string {
  return path.split("/").join(" › ");
}

/** The sentence under the Inbox: its own folders, which stay where they are (owner, 2026-10-18). */
export function inboxPartsLine(answer: FolderJobsAnswer): string {
  const labels = answer.inboxParts.map((part) => part.label);
  return `${labels.join(", ")} stay in the Inbox and can't be moved. Add your own notes and folders beside them.`;
}

/** What "Use this folder as…" offers for `path`: the jobs it could take, and the one it does now. */
export function jobChoicesFor(answer: FolderJobsAnswer, path: string): { job: string; label: string; line: string; now: string | null; current: boolean }[] {
  const archiveOk = !path.includes("/");
  return answer.jobs
    .filter((row) => row.canChange && (row.job !== "archive" || archiveOk))
    .map((row) => ({
      job: row.job,
      label: row.label,
      line: row.line,
      now: row.path === null || row.path === path ? null : row.path,
      current: row.path === path,
    }));
}
