/**
 * The Reports page's data, pure: the artifact's `REPORTS` list (`P.reports`), built from the two
 * sources it merges. Content reports made in the app (`functions/contentReports.ts`, "In the app")
 * and bug reports people filed by texting Tex (the triage desk's rows, `texDashboard.triage`,
 * "Texted to Tex"). Nothing here reads Convex or React; the page hands the rows in.
 */

export type ReportSrc = "content" | "tex";

/** One row of the list and of the side panel: the artifact's report shape, plus the note's path for a Tex one. */
export type Report = {
  id: string;
  src: ReportSrc;
  title: string;
  kind: string;
  when: string;
  reporter: string;
  about: string;
  details: string;
  open: boolean;
  handled?: string;
  thread?: Array<[Speaker, string]>;
  /** Tex reports only: the note's path, which `id` stands for in the address. */
  path?: string;
};

export type Speaker = "them" | "tex";

/** The URL filters this page owns (`src`: all | content | tex; `st`: open | all). */
export type ReportFilters = { src: string; st: string };

/** A content report as `api.functions.contentReports.listReports` returns it (`show: "all"`). */
export type ContentRow = {
  id: string;
  createdAt: number;
  kind: string;
  reason: string;
  details: string | null;
  reporter: string;
  about: string | null;
  workspace: string | null;
  handledAt: number | null;
  handledBy: string | null;
};

/** A Tex bug report as the triage desk lists it (`bugRowValidator`). */
export type TexBug = {
  path: string;
  filed: number | null;
  status: string;
  reporter: "team" | "user" | null;
  textsShared: boolean;
  title: string | null;
};

/** One Tex note, read on the desk (`texDashboard.readNote`), kept by path while the page is open. */
export type NoteState =
  | { state: "loading" }
  | { state: "error" }
  | { state: "ready"; message: string; texts: Array<[Speaker, string]> | null };
export type Notes = Record<string, NoteState>;

/** The words the desk's content kinds have (the control plane's `KIND_WORDS`). */
const KIND_WORDS: Record<string, string> = {
  share: "A note shared with them",
  grant: "A note shared with them by name",
  invitation: "An invitation",
  workspace_note: "A note in a workspace they belong to",
  public_page: "A public page",
};

/** Statuses the desk leaves a report at once it has been sent on, or closed: only `open` still waits. */
const TEX_CLOSED = new Set(["triage", "triaged", "fixing", "fixed", "retired"]);
const TEX_STATUS_WORDS: Record<string, string> = {
  triage: "Sent to triage",
  triaged: "Sent to triage",
  fixing: "Being fixed",
  fixed: "Fixed",
  retired: "Retired",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** `Nov 12`, in UTC like the desk's dates. */
export function shortDay(at: number): string {
  const d = new Date(at);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** The artifact's relative time: `3h ago`, `2d ago`; a week or more, the date. */
export function ago(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - at) / MINUTE));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor((hours * HOUR) / DAY);
  return days < 7 ? `${days}d ago` : shortDay(at);
}

export function kindWords(kind: string): string {
  return KIND_WORDS[kind] ?? kind;
}

/** FNV-1a of the path, as `t-` and eight hex digits: short, stable, and letters, digits and hyphens only for the address. */
function texHash(path: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return "t-" + (h >>> 0).toString(16).padStart(8, "0");
}

/** Each path's id, in list order; a hash that repeats gets a counter, so no two reports share one. */
export function texIds(paths: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const path of paths) {
    if (out.has(path)) continue;
    const base = texHash(path);
    let id = base;
    for (let n = 1; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    out.set(path, id);
  }
  return out;
}

/**
 * A Tex note's text as the page shows it: the message the person sent (the first fenced block) and,
 * when they shared them, their texts with Tex (the block under "## Their recent texts with Tex"),
 * one line each. A line that starts `tex:` is Tex's; any other is theirs.
 */
export function parseTexNote(text: string): { message: string; texts: Array<[Speaker, string]> | null } {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const cut = body.indexOf("## Their recent texts with Tex");
  const head = cut < 0 ? body : body.slice(0, cut);
  const tail = cut < 0 ? "" : body.slice(cut);
  const message = fenced(head) ?? head.replace(/^#[^\n]*\n?/, "").trim();
  // Written by the gateway's reportGate.recentTexts: "Them: …" and "Tex: …" turns, blank-line separated; a turn may run over several lines.
  const raw = (fenced(tail) ?? tail.replace(/^##[^\n]*\n?/, "")).split(/\r?\n/);
  const texts: Array<[Speaker, string]> = [];
  for (const line of raw) {
    const turn = /^(tex|them)\s*:\s?(.*)$/i.exec(line);
    if (turn) texts.push([turn[1]!.toLowerCase() === "tex" ? "tex" : "them", turn[2] ?? ""]);
    else if (line.trim() !== "" && texts.length > 0) texts[texts.length - 1]![1] += "\n" + line;
    else if (line.trim() !== "") texts.push(["them", line.trim()]);
  }
  return { message, texts: cut < 0 || texts.length === 0 ? null : texts };
}

/** The contents of the first fenced `text` block in `s`, or null. */
function fenced(s: string): string | null {
  const match = /^(`{3,})text\r?\n([\s\S]*?)\r?\n\1[ \t]*$/m.exec(s);
  return match ? match[2]! : null;
}

function contentReport(row: ContentRow, now: number): Report {
  const handled = row.handledAt !== null;
  return {
    id: row.id,
    src: "content",
    title: row.reason,
    kind: kindWords(row.kind),
    when: ago(row.createdAt, now),
    reporter: row.reporter,
    about: [row.workspace, row.about].filter((part) => part).join(" · "),
    details: row.details ?? "",
    open: !handled,
    ...(handled ? { handled: `Handled by ${row.handledBy ?? "someone"} · ${shortDay(row.handledAt!)}` } : {}),
  };
}

function texReport(bug: TexBug, id: string, now: number, note: NoteState | undefined): Report {
  const open = !TEX_CLOSED.has(bug.status.toLowerCase());
  const loaded = note?.state === "ready" ? note : null;
  const details = note?.state === "error" ? "This note could not be opened." : loaded ? loaded.message : "Loading the texts";
  return {
    id,
    src: "tex",
    path: bug.path,
    title: bug.title ?? "Bug report",
    kind: "Texted to Tex",
    when: bug.filed === null ? "" : ago(bug.filed, now),
    reporter: bug.reporter === "team" ? "team" : "someone using Tex",
    about: bug.textsShared ? "Texts attached" : "No texts attached",
    details,
    open,
    ...(open ? {} : { handled: TEX_STATUS_WORDS[bug.status.toLowerCase()] ?? bug.status }),
    ...(loaded && loaded.texts ? { thread: loaded.texts } : {}),
  };
}

/** Both sources as one list, newest first (a Tex report by its filing time, a content one by its creation). */
export function mergeReports(input: { content: readonly ContentRow[]; tex: readonly TexBug[]; notes: Notes; now: number }): Report[] {
  const ids = texIds(input.tex.map((bug) => bug.path));
  const items: Array<{ at: number; report: Report }> = [];
  for (const row of input.content) items.push({ at: row.createdAt, report: contentReport(row, input.now) });
  for (const bug of input.tex) {
    const id = ids.get(bug.path)!;
    items.push({ at: bug.filed ?? 0, report: texReport(bug, id, input.now, input.notes[bug.path]) });
  }
  return items.sort((a, b) => b.at - a.at).map((item) => item.report);
}

/** The list as the filters show it: `st` open keeps the open ones; `src` keeps one source. */
export function filterReports(reports: readonly Report[], f: ReportFilters): Report[] {
  return reports.filter((r) => (f.st !== "open" || r.open) && (f.src === "all" || r.src === f.src));
}
