/**
 * The triage desk on tex.lc/admin: the bug reports people filed by texting
 * Tex, the conversation reviews, and the problems ("themes") the triage agent
 * names from them, read from the pinned context's tree rows (decided by the
 * owner, 2026-10-24; `docs/decisions/observability/tex-telemetry.md`).
 *
 * Read from each note's facts (`props`: its front matter and first heading),
 * never its text, so the list costs one indexed range per folder. What the
 * triage agent and the reports keep in front matter is codes, dates, counts
 * and short names; a report's own words are read only when a staff member
 * opens it (`functions/texDashboard.ts`), at their own clearance.
 *
 * The desk's actions are note mail (`packages/shared/src/mail.cjs`) to the
 * agent named `triage`, plus the report's `status:`; the agent reads both on
 * its next pass. Nothing here keeps a second copy of a report.
 */

import { v, type Infer } from "convex/values";
import type { Id } from "../../../_generated/dataModel";
import type { DatabaseReader } from "../../../_generated/server";
import { BUG_FOLDER, DEFAULT_AREAS_FOLDER } from "../feedback/bugNote";
import { reviewFolder } from "../feedback/texReviewNote";

/** The name the triage agent answers to in note mail. */
export const TRIAGE_AGENT = "triage";
/** Where the triage agent keeps one note per named problem, under the reviews folder. */
export const THEMES_FOLDER = "themes";
/** A folder's own notes, which are about the folder rather than one problem. */
const ABOUT_NOTES = new Set(["readme.md", "about.md", "index.md"]);
/** Rows read from one folder; the desk shows the newest of them. */
export const TRIAGE_ROWS = 1_000;

export const TRIAGE_ACTIONS = ["comment", "triage", "retire", "reopen"] as const;
export type TriageAction = (typeof TRIAGE_ACTIONS)[number];

/** The `status:` each action leaves; a comment leaves it as it was. */
export const STATUS_AFTER: Record<TriageAction, string | null> = {
  comment: null,
  triage: "triage",
  retire: "retired",
  reopen: "open",
};

export interface TriageFolders {
  bugs: string;
  reviews: string;
  themes: string;
}

/** The three folders, under the folder doing the Areas job (`areas` where none does). */
export function triageFolders(areas: string | null): TriageFolders {
  const root = (areas ?? DEFAULT_AREAS_FOLDER).replace(/^\/+|\/+$/g, "");
  const reviews = reviewFolder(areas);
  return { bugs: `${root === "" ? DEFAULT_AREAS_FOLDER : root}/${BUG_FOLDER}`, reviews, themes: `${reviews}/${THEMES_FOLDER}` };
}

/**
 * Whether a staff member may open or act on this path from the desk: a
 * Markdown note inside the bugs or reviews folder, nothing above or beside
 * them, and no segment that walks out.
 */
export function onTheDesk(folders: TriageFolders, path: string): boolean {
  if (!path.endsWith(".md") || path.includes("\\")) return false;
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return false;
  return path.startsWith(`${folders.bugs}/`) || path.startsWith(`${folders.reviews}/`);
}

export const bugRowValidator = v.object({
  path: v.string(),
  filed: v.union(v.number(), v.null()),
  status: v.string(),
  reporter: v.union(v.literal("team"), v.literal("user"), v.null()),
  textsShared: v.boolean(),
  title: v.union(v.string(), v.null()),
  theme: v.union(v.string(), v.null()),
});

export const reviewRowValidator = v.object({
  path: v.string(),
  reviewed: v.union(v.number(), v.null()),
  status: v.string(),
  theme: v.union(v.string(), v.null()),
  task: v.union(v.string(), v.null()),
  signals: v.array(v.string()),
  average: v.union(v.number(), v.null()),
});

export const themeRowValidator = v.object({
  path: v.string(),
  slug: v.string(),
  name: v.string(),
  status: v.string(),
  signals: v.array(v.string()),
  tasks: v.array(v.string()),
  prs: v.array(v.number()),
  merged: v.union(v.number(), v.null()),
  firstSeen: v.union(v.number(), v.null()),
  fixThread: v.union(v.string(), v.null()),
});

export const texTriageValidator = v.union(
  v.object({ available: v.literal(false), reason: v.union(v.literal("no_pinned_context"), v.literal("not_a_member")) }),
  v.object({
    available: v.literal(true),
    slug: v.string(),
    bugs: v.array(bugRowValidator),
    reviews: v.array(reviewRowValidator),
    themes: v.array(themeRowValidator),
  }),
);

export type BugRow = Infer<typeof bugRowValidator>;
export type ReviewRow = Infer<typeof reviewRowValidator>;
export type ThemeRow = Infer<typeof themeRowValidator>;
export type TexTriage = Infer<typeof texTriageValidator>;

interface Facts {
  properties: Record<string, unknown>;
  heading: string | null;
}

/** A row's facts, or empty ones for a row not read yet or sealed. */
export function factsOf(props: string | undefined): Facts {
  if (props === undefined) return { properties: {}, heading: null };
  try {
    const parsed = JSON.parse(props) as { properties?: unknown; heading?: unknown };
    const properties = typeof parsed.properties === "object" && parsed.properties !== null ? (parsed.properties as Record<string, unknown>) : {};
    return { properties, heading: typeof parsed.heading === "string" ? parsed.heading : null };
  } catch {
    return { properties: {}, heading: null };
  }
}

const SHORT = 120;

function textOf(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const chars = [...trimmed];
  return chars.length > SHORT ? `${chars.slice(0, SHORT - 1).join("")}…` : trimmed;
}

/** A front-matter list, written as a YAML list, a JSON array in a string, or commas. */
export function listOf(value: unknown): string[] {
  let items: unknown[] = [];
  if (Array.isArray(value)) items = value;
  else if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        items = Array.isArray(parsed) ? parsed : [];
      } catch {
        items = trimmed.slice(1, -1).split(",");
      }
    } else items = trimmed.split(",");
  } else if (typeof value === "number") items = [value];
  return [...new Set(items.map(textOf).filter((item): item is string => item !== null).map((item) => item.replace(/^["']|["']$/g, "")))].slice(0, 20);
}

function timeOf(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== "string" && typeof value !== "number") return null;
  const at = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

/** `2026-10-18 1342 …md`, the stamp every report and review is named with, for a row not read yet. */
export function stampOf(path: string): number | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2})(\d{2}) /.exec(name);
  if (match === null) return null;
  const at = Date.parse(`${match[1]}T${match[2]}:${match[3]}:00Z`);
  return Number.isFinite(at) ? at : null;
}

function slugOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.endsWith(".md") ? name.slice(0, -3) : name;
}

export function bugRowOf(path: string, props: string | undefined): BugRow {
  const { properties, heading } = factsOf(props);
  const reporter = properties.reporter === "team" || properties.reporter === "user" ? properties.reporter : null;
  return {
    path,
    filed: timeOf(properties.filed) ?? stampOf(path),
    status: textOf(properties.status) ?? "open",
    reporter,
    textsShared: properties.texts === "shared",
    title: heading === null ? null : (textOf(heading) ?? null),
    theme: textOf(properties.theme),
  };
}

export function reviewRowOf(path: string, props: string | undefined): ReviewRow {
  const { properties } = factsOf(props);
  const average = typeof properties.average === "number" ? properties.average : Number(properties.average);
  return {
    path,
    reviewed: timeOf(properties.reviewed) ?? stampOf(path),
    status: textOf(properties.status) ?? "new",
    theme: textOf(properties.theme),
    task: textOf(properties.task),
    signals: listOf(properties.signals),
    average: Number.isFinite(average) ? average : null,
  };
}

export function themeRowOf(path: string, props: string | undefined): ThemeRow {
  const { properties, heading } = factsOf(props);
  const slug = slugOf(path);
  return {
    path,
    slug,
    name: textOf(properties.name) ?? (heading === null ? null : textOf(heading)) ?? slug,
    status: textOf(properties.status) ?? "open",
    signals: listOf(properties.signals),
    tasks: listOf(properties.tasks),
    prs: listOf(properties.prs)
      .map((pr) => Number(pr.replace(/^#/, "")))
      .filter((pr) => Number.isInteger(pr) && pr > 0),
    merged: timeOf(properties.merged),
    firstSeen: timeOf(properties.first_seen),
    fixThread: textOf(properties.fix_thread),
  };
}

/**
 * The live notes under a folder, at any depth: the last `TRIAGE_ROWS` by name,
 * which is by date for stamped names, and only those `visible` admits.
 *
 * A row says nothing about who may see it — the `nodes` schema is explicit
 * that visibility "is decided when served, by the same `canSee` over the
 * workspace's rules that every listing applies" — so the caller hands in that
 * judgement and this listing applies it like any other.
 */
export async function notesUnder(db: DatabaseReader, workspaceId: Id<"workspaces">, folder: string, visible: (path: string) => boolean) {
  const rows = await db
    .query("nodes")
    .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).gte("path", `${folder}/`).lt("path", `${folder}/\uffff`))
    .order("desc")
    .take(TRIAGE_ROWS);
  return rows.filter((row) => row.kind === "file" && row.goneAt === undefined && row.path.endsWith(".md") && visible(row.path));
}

/** Everything on the desk the caller may see, from the rows alone. */
export async function triageRows(db: DatabaseReader, workspaceId: Id<"workspaces">, folders: TriageFolders, visible: (path: string) => boolean) {
  // Reports and reviews are named with their stamp; a folder's own README or about note is not one.
  const bugs = (await notesUnder(db, workspaceId, folders.bugs, visible)).filter((row) => stampOf(row.path) !== null).map((row) => bugRowOf(row.path, row.props));
  const themes = (await notesUnder(db, workspaceId, folders.themes, visible)).filter((row) => !ABOUT_NOTES.has(row.name.toLowerCase())).map((row) => themeRowOf(row.path, row.props));
  const reviews = (await notesUnder(db, workspaceId, folders.reviews, visible))
    .filter((row) => !row.path.startsWith(`${folders.themes}/`) && !row.path.startsWith(`${folders.reviews}/scores/`))
    .filter((row) => stampOf(row.path) !== null)
    .map((row) => reviewRowOf(row.path, row.props));
  return { bugs, themes, reviews };
}

/**
 * The note with its front matter's `status:` set, adding the line (or the
 * front matter) where there is none. Everything else is left as it was.
 */
export function withStatus(text: string, status: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text);
  if (match === null) return `---\nstatus: ${status}\n---\n\n${text}`;
  const body = match[1]!;
  const lines = body.split(/\r?\n/);
  const at = lines.findIndex((line) => /^status\s*:/.test(line));
  if (at >= 0) lines[at] = `status: ${status}`;
  else lines.unshift(`status: ${status}`);
  return `---\n${lines.join("\n")}\n---${match[2]}${text.slice(match[0].length)}`;
}

/** What the mail to the triage agent says for each action. */
export function mailFor(action: TriageAction, comment: string): string | null {
  const said = comment.trim();
  switch (action) {
    case "comment":
      return said === "" ? null : said;
    case "triage":
      return said === "" ? "Please triage this and start a fix." : `Please triage this and start a fix. ${said}`;
    case "retire":
      return said === "" ? "Retired: no fix needed." : `Retired: ${said}`;
    case "reopen":
      return said === "" ? "Reopened." : `Reopened: ${said}`;
  }
}
