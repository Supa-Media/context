/**
 * Which projects serve which area. Pure: no React, no storage.
 *
 * A project stays in the Projects folder. It names the area it serves with one
 * line in its front note, the same line agents and the gateway's
 * `orient { area }` already read and write:
 *
 *     area: areas/finance
 *
 * The value is the area's folder. One project serves one area; a project with
 * no line, or a line naming no area, serves none. An area counts the projects
 * of its sub-areas too, since a folded row hides them (the owner, 2026-11-25,
 * approving the "Projects in areas" boards).
 *
 * Which folders are projects: every folder directly in the Projects folder,
 * and every folder one level down in one of those that has no status of its
 * own (a grouping folder such as `backlog/`), as the Projects List draws them;
 * plus any deeper folder whose front note names an area, so a line an agent
 * wrote is never lost. See `docs/decisions/app-and-console/areas-as-seats.md`.
 */

import type { ListNote } from "../../listBlock/model";
import { baseName, folderLabel } from "../../paths";
import { summarizeFolder } from "../model";
import { folderStatuses, groupOfStatus, type StatusGroup } from "../statuses";
import { AREA_KEY, areaTitle } from "./seat";

export interface AreaProject {
  /** The project's folder, `projects/stripe-sync`. */
  readonly folder: string;
  /** Its title as the Projects List draws it. */
  readonly name: string;
  /** Its status as written; `""` when it has none. */
  readonly status: string;
  /** The group that status is in; a project with no status is Not started, an unplaced word is null. */
  readonly group: StatusGroup | null;
  readonly owner: string | null;
  /** The area it says it serves, as written and trimmed of slashes; null when it names none. */
  readonly area: string | null;
  /** The front note its `area:` line is written to, and whether writing creates it. */
  readonly target: string;
  readonly creates: boolean;
}

/** An area line as compared: no `@`, no slashes at either end, any case. */
export function areaKey(value: string): string {
  return value.trim().replace(/^@+/, "").replace(/^\/+|\/+$/g, "").toLowerCase();
}

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return String(value[0] ?? "").trim();
  return "";
}

/** The area a front note names, or null: `area: true` and `area: false` are an Areas folder's own words, never a project's. */
function areaOf(value: unknown): string | null {
  const said = text(value).replace(/^\/+|\/+$/g, "");
  if (said === "" || /^(true|false)$/i.test(said)) return null;
  return said;
}

const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** Every folder under `root` that a note names, with its depth below `root`. */
function foldersUnder(root: string, notes: readonly ListNote[]): Map<string, number> {
  const prefix = `${root}/`;
  const found = new Map<string, number>();
  for (const note of notes) {
    if (!note.path.startsWith(prefix)) continue;
    const parts = note.path.slice(prefix.length).split("/").slice(0, -1);
    for (let depth = 1; depth <= parts.length; depth += 1) found.set(`${root}/${parts.slice(0, depth).join("/")}`, depth);
  }
  return found;
}

/** The Projects folder's projects, in name order. */
export function projectsUnder(root: string, notes: readonly ListNote[]): AreaProject[] {
  if (root === "") return [];
  const folders = foldersUnder(root, notes);
  const summaries = new Map([...folders.keys()].map((folder) => [folder, summarizeFolder(folder, notes)]));
  const statusOf = (folder: string) => text(summaries.get(folder)?.properties.status);
  // A folder directly in the Projects folder with no status of its own, holding subfolders that have one, groups projects (`backlog/`).
  const grouping = new Set([...folders].filter(([folder, depth]) => depth === 1 && statusOf(folder) === "" && hasProjectsInside(folder, folders, statusOf)).map(([folder]) => folder));
  const projects: AreaProject[] = [];
  for (const [folder, depth] of folders) {
    const summary = summaries.get(folder)!;
    const area = areaOf(summary.properties[AREA_KEY]);
    const listed = depth === 1 ? !grouping.has(folder) : depth === 2 && grouping.has(parentOf(folder));
    if (!listed && area === null) continue;
    const status = statusOf(folder);
    const list = folderStatuses(parentOf(folder), notes).list;
    projects.push({
      folder,
      name: summary.title ?? folderLabel(baseName(folder)),
      status,
      group: status.toLowerCase() === "note" ? null : groupOfStatus(status, list),
      owner: text(summary.properties.owner) || null,
      area,
      target: summary.target,
      creates: summary.creates,
    });
  }
  return projects.sort((a, b) => a.name.localeCompare(b.name));
}

/** Whether a folder holds subfolders with statuses of their own: `backlog/` holding projects. */
function hasProjectsInside(folder: string, folders: ReadonlyMap<string, number>, statusOf: (folder: string) => string): boolean {
  for (const [inner, depth] of folders) {
    if (depth === 2 && parentOf(inner) === folder && statusOf(inner) !== "") return true;
  }
  return false;
}

/** The projects that serve `area` or one of the folders inside it. */
export function projectsOfArea(area: string, projects: readonly AreaProject[]): AreaProject[] {
  const key = areaKey(area);
  return projects.filter((project) => {
    if (project.area === null) return false;
    const said = areaKey(project.area);
    return said === key || said.startsWith(`${key}/`);
  });
}

/** An area's projects by where they are: in progress first, as a row counts them. */
export interface AreaProjects {
  readonly inProgress: readonly AreaProject[];
  readonly notStarted: readonly AreaProject[];
  readonly done: readonly AreaProject[];
  /** Words nobody placed in a group: listed with not started, never counted as in progress. */
  readonly other: readonly AreaProject[];
}

export function groupedProjects(area: string, projects: readonly AreaProject[]): AreaProjects {
  const mine = projectsOfArea(area, projects);
  return {
    inProgress: mine.filter((project) => project.group === "in-progress"),
    notStarted: mine.filter((project) => project.group === "not-started"),
    done: mine.filter((project) => project.group === "done"),
    other: mine.filter((project) => project.group === null),
  };
}

/** What the folded line under the in-progress list says: "3 not started · 1 done", or "" for none. */
export function restLine(grouped: AreaProjects): string {
  const parts: string[] = [];
  const waiting = grouped.notStarted.length + grouped.other.length;
  if (waiting > 0) parts.push(`${waiting} not started`);
  if (grouped.done.length > 0) parts.push(`${grouped.done.length} done`);
  return parts.join(" · ");
}

/** Projects offered by "Attach a project": every project not serving this area, those serving none first. */
export function attachChoices(area: string, projects: readonly AreaProject[]): AreaProject[] {
  const key = areaKey(area);
  const others = projects.filter((project) => project.area === null || areaKey(project.area) !== key);
  return [...others.filter((project) => project.area === null), ...others.filter((project) => project.area !== null)];
}

/** The write that attaches a project to an area, or detaches it with `null`. */
export function attachChange(project: AreaProject, area: string | null): { target: string; changes: [string, string | null][]; creates: boolean } {
  return { target: project.target, changes: [[AREA_KEY, area]], creates: project.creates && area !== null };
}

/** The area a project's line names, as the tree draws it: its last folder's name, or null for a line naming no area here. */
export function areaLabelOf(project: AreaProject, areas: ReadonlySet<string>): string | null {
  if (project.area === null) return null;
  const key = areaKey(project.area);
  for (const folder of areas) if (areaKey(folder) === key) return folder;
  return null;
}

/**
 * The tag a project's row on the Projects List shows: the area it serves, by
 * its last folder's name, which opens it; "No area" for a project in progress
 * that serves none; nothing for any other (a list of old finished projects
 * does not fill with grey).
 */
export function projectAreaTag(properties: Readonly<Record<string, unknown>>, tone: string | null): { folder: string | null; label: string } | undefined {
  const area = areaOf(properties[AREA_KEY]);
  if (area !== null) return { folder: area, label: areaTitle(area.slice(area.lastIndexOf("/") + 1)) };
  return tone === "in-progress" ? { folder: null, label: "No area" } : undefined;
}
