import { CLOSED_STATUSES, FRONT_NOTES } from "./grammar.js";
import { groupOf, orderByGroup } from "./group.js";
import { compareRows, holds } from "./select.js";

/**
 * `rows: projects`: a list whose rows are projects rather than notes.
 *
 * ## What a project is
 *
 * Anything with a `status`, and nothing else. There is no project type:
 *
 * - **A note** directly in the listed folder is a project when its own
 *   frontmatter has a `status`.
 * - **A folder** directly in the listed folder is a project when its front
 *   note (`FRONT_NOTES`, first one present) has a `status`. The row opens that
 *   note, and its `updated` is the newest save anywhere inside the folder.
 *
 * A project's **sub-projects** are found the same way one level further down:
 * a note or folder directly inside a project folder, with a `status`. Nothing
 * deeper is ever a project, so a list is at most two levels.
 *
 * ## Filtering keeps parents with their children
 *
 * `where` is tested against each project and each sub-project. A project is
 * listed when it matches or any of its sub-projects does, and it carries only
 * the sub-projects that match, so "owner is me" shows my sub-projects under
 * their parents. `progress` always counts every sub-project, because a filter
 * that hid finished work must not make a project look less finished.
 *
 * Like notes, this only narrows: every row is built from a note the caller
 * passed in, plumbing and the note holding the block are refused, and
 * `total` counts listed projects only.
 */
export function selectProjectRows(config, notes, { selfPath } = {}) {
  const base = config.from ? `${config.from}/` : "";
  const byPath = new Map();
  for (const note of notes || []) {
    const path = String(note.path || "");
    if (!path.endsWith(".md") || path === selfPath || !path.startsWith(base)) continue;
    const rest = path.slice(base.length);
    if (rest.split("/").some((segment) => segment.startsWith("."))) continue;
    byPath.set(rest, note);
  }

  const topLevel = projectsIn("", byPath);
  const matches = (project) => config.where.every((condition) => holds(condition, project.note.properties || {}));
  const kept = [];
  for (const project of topLevel) {
    const children = project.kind === "folder" ? projectsIn(`${project.folder}/`, byPath) : [];
    const shown = children.filter(matches);
    if (!matches(project) && shown.length === 0) continue;
    const closed = children.filter((child) => isClosed(child.note)).length;
    kept.push({ project, children: sortProjects(shown, config), progress: children.length ? { done: closed, total: children.length } : null });
  }

  const sorted = sortProjects(kept.map((entry) => entry.project), config);
  const rank = new Map(sorted.map((project, index) => [project, index]));
  kept.sort((a, b) => rank.get(a.project) - rank.get(b.project));
  const withGroups = kept.map((entry) => ({ ...entry, group: groupOf(entry.project.note.properties, config.group) }));
  const ordered = config.group ? orderByGroup(withGroups) : withGroups;
  const rows = ordered.slice(0, config.limit).map((entry) => ({
    ...rowOf(entry.project, config, base),
    ...(config.group ? { group: entry.group } : {}),
    progress: entry.progress,
    children: entry.children.map((child) => ({
      ...rowOf(child, config, base),
      ...(config.group ? { group: groupOf(child.note.properties, config.group) } : {}),
    })),
  }));
  return { rows, total: kept.length, truncated: kept.length > rows.length };
}

/**
 * The projects directly inside `prefix` (relative to the listed folder):
 * notes with a status, and folders whose front note has one.
 */
function projectsIn(prefix, byPath) {
  const projects = [];
  const folders = new Map();
  for (const [rest, note] of byPath) {
    if (!rest.startsWith(prefix)) continue;
    const inside = rest.slice(prefix.length);
    const slash = inside.indexOf("/");
    if (slash === -1) {
      if (FRONT_NOTES.includes(inside) && prefix !== "") continue; // the parent's own front note
      if (hasStatus(note)) projects.push({ kind: "note", note, rest, folder: null, updatedAt: note.updatedAt ?? null });
      continue;
    }
    const name = inside.slice(0, slash);
    const folder = `${prefix}${name}`;
    const seen = folders.get(folder) ?? { newest: null, front: null, frontRank: Infinity };
    const at = note.updatedAt ?? null;
    if (typeof at === "number" && (seen.newest === null || at > seen.newest)) seen.newest = at;
    const leaf = inside.slice(slash + 1);
    const frontRank = FRONT_NOTES.indexOf(leaf);
    if (frontRank !== -1 && frontRank < seen.frontRank) {
      seen.front = { note, rest };
      seen.frontRank = frontRank;
    }
    folders.set(folder, seen);
  }
  for (const [folder, seen] of folders) {
    if (seen.front === null || !hasStatus(seen.front.note)) continue;
    projects.push({ kind: "folder", note: seen.front.note, rest: seen.front.rest, folder, updatedAt: seen.newest });
  }
  return projects;
}

function hasStatus(note) {
  const status = note.properties?.status;
  const value = Array.isArray(status) ? status[0] : status;
  return typeof value === "string" && value.trim() !== "";
}

function isClosed(note) {
  const status = note.properties?.status;
  const value = Array.isArray(status) ? status[0] : status;
  return typeof value === "string" && CLOSED_STATUSES.has(value.trim().toLowerCase());
}

/** A project as the note `compareRows` sorts: its title, and the folder's newest save. */
function sortable(project) {
  return {
    note: { ...project.note, updatedAt: project.updatedAt ?? undefined },
    title: titleOfProject(project),
    project,
  };
}

function sortProjects(projects, config) {
  return projects
    .map(sortable)
    .sort((a, b) => compareRows(a, b, config.sort))
    .map((item) => item.project);
}

/**
 * A project's name: `title` from its frontmatter, else the note's first
 * heading when the caller read one, else the file or folder name.
 */
function titleOfProject(project) {
  const title = project.note.properties?.title;
  if (typeof title === "string" && title.trim()) return title.trim();
  const heading = project.note.heading;
  if (typeof heading === "string" && heading.trim()) return heading.trim();
  const name = project.kind === "folder" ? project.folder : project.rest;
  return name.split("/").pop().replace(/\.md$/, "");
}

function rowOf(project, config, base) {
  return {
    path: project.note.path,
    title: titleOfProject(project),
    kind: project.kind,
    ...(project.kind === "folder" ? { folder: `${base}${project.folder}` } : {}),
    values: config.show.map((key) => ({
      key,
      value: key === "updated" ? project.updatedAt ?? null : project.note.properties?.[key] ?? null,
    })),
  };
}
