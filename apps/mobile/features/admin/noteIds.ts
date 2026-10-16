/**
 * The "Notes by id" card on the Search tab (`./NoteIdsView`) as data: the
 * overall percent copied, the counts line, the workspace rows in the order
 * staff need them, and the words for each status and diagnosis. Pure, so the
 * rules are pinned by `adminNoteIds.test.ts`.
 *
 * The report is `api.functions.noteIds.report` (`apps/convex/functions/
 * noteIds.ts`). Its shape is typed here rather than read from the generated
 * api, so this file compiles and tests before that module lands.
 *
 * Percent is floored to one decimal, never rounded: a copy at 99.97% reads
 * 99.9%, so the card never says "100.0%" while a note is still left.
 */

export type NoteIdsStatus = "idle" | "copying" | "done" | "failed";

export type NoteIdsDiagnosis = { checkedAt: number; checked: number; missing: number; differs: number };

export type NoteIdsWorkspace = {
  workspaceId: string;
  /** The handle without the `@`; null for a workspace that has none. */
  handle: string | null;
  files: number;
  copied: number;
  failed: number;
  status: NoteIdsStatus;
  error: string | null;
  diagnosis: NoteIdsDiagnosis | null;
  /** Why files failed, by note id (no paths); absent from an older server. */
  failures?: { noteId: string; reason: string }[];
  /** Keys mode only (0 otherwise): live, non-plumbing files, and how many of them are keyed. */
  liveFiles: number;
  keyed: number;
  /** When the flip to keyed rows started, and when it found none left; null until then. */
  keyedAt: number | null;
  keyedDoneAt: number | null;
  /** Held by an archived account: the switch to keys does not count it (the gate checks live workspaces only). */
  archived: boolean;
  /** The old-copy cleanup (absent from an older server). */
  cleanup?: NoteIdsCleanup;
};

/** A workspace's old-copy cleanup: its last count, its run, and the refusal each button gets now. */
export type NoteIdsCleanup = {
  running: "count" | "delete" | null;
  countedAt: number | null;
  toDelete: number;
  unclaimed: number;
  readingPaths: number;
  startedAt: number | null;
  finishedAt: number | null;
  deleted: number;
  failed: { reason: string; count: number }[];
  error: string | null;
  countBlocked: { code: string; message: string } | null;
  deleteBlocked: { code: string; message: string } | null;
};

export type NoteIdsTotals = { files: number; copied: number; failed: number; liveFiles: number; keyed: number };

export type NoteIdsReport = {
  paused: boolean;
  mode: "paths" | "ids" | "keys";
  totals: NoteIdsTotals;
  workspaces: NoteIdsWorkspace[];
};

const count = (value: number) => value.toLocaleString("en-US");

/** Copied as a share of files, clamped to 0 to 100; null when there are no files to copy. */
export function percentOf(copied: number, files: number): number | null {
  if (!Number.isFinite(files) || files <= 0) return null;
  const share = (copied / files) * 100;
  return Math.min(100, Math.max(0, share));
}

/** `12.3%`, floored to one decimal; `—` when there are no files. */
export function formatPercent(copied: number, files: number): string {
  if (!Number.isFinite(files) || files <= 0 || !Number.isFinite(copied)) return "—";
  const clamped = Math.min(files, Math.max(0, copied));
  // Integer arithmetic on tenths, so 0.29 * 100 can never floor to 28.9.
  const tenths = Math.floor((clamped * 1000) / files);
  return `${Math.floor(tenths / 10)}.${tenths % 10}%`;
}

/** The bar's fill, 0 to 1. */
export function barShare(copied: number, files: number): number {
  const percent = percentOf(copied, files);
  return percent === null ? 0 : percent / 100;
}

/** `12,034 of 12,500 files copied`, with ` · 3 failed` only when something failed. */
export function countsLine(totals: NoteIdsTotals): string {
  const base = `${count(totals.copied)} of ${count(totals.files)} files copied`;
  return totals.failed > 0 ? `${base} · ${count(totals.failed)} failed` : base;
}

/** A workspace that needs a person: some files failed, or its copy said so. */
export function isFailing(row: NoteIdsWorkspace): boolean {
  return row.failed > 0 || row.status === "failed";
}

/**
 * Failed first, then the lowest percent copied. A workspace with no files has
 * no percent and sorts after every workspace that has one; ties go by handle
 * (no handle last), then by workspace id, so the order is stable between refreshes.
 */
export function sortWorkspaces(rows: readonly NoteIdsWorkspace[]): NoteIdsWorkspace[] {
  return [...rows].sort((a, b) => {
    const failing = Number(isFailing(b)) - Number(isFailing(a));
    if (failing !== 0) return failing;
    const pa = percentOf(a.copied, a.files);
    const pb = percentOf(b.copied, b.files);
    if (pa !== pb) {
      if (pa === null) return 1;
      if (pb === null) return -1;
      return pa - pb;
    }
    if (a.handle !== b.handle) {
      if (a.handle === null) return 1;
      if (b.handle === null) return -1;
      return a.handle.localeCompare(b.handle);
    }
    return a.workspaceId.localeCompare(b.workspaceId);
  });
}

/** Not started, Copying, Copied, or `Failed: <error>` (`Failed` alone when the error is unknown). */
export function statusLabel(row: NoteIdsWorkspace): string {
  switch (row.status) {
    case "idle":
      return "Not started";
    case "copying":
      return "Copying";
    case "done":
      return "Copied";
    case "failed": {
      const error = row.error?.trim() ?? "";
      return error === "" ? "Failed" : `Failed: ${error}`;
    }
  }
}

/** `Checked 120 · 0 missing · 1 differs`; null when the workspace has not been checked. */
export function diagnosisLine(diagnosis: NoteIdsDiagnosis | null | undefined): string | null {
  if (diagnosis === undefined || diagnosis === null) return null;
  return `Checked ${count(diagnosis.checked)} · ${count(diagnosis.missing)} missing · ${count(diagnosis.differs)} differs`;
}

const FAILURE_REASONS: Record<string, string> = {
  too_large: "too big to copy",
  changed: "kept changing while it was copied",
  missing: "not in the bucket",
  copy_failed: "the copy failed",
  verify_failed: "the copy did not match the original",
  no_answer: "the mover did not answer",
  no_etag: "the bucket gave no version for it",
};

/** One line per failed file: `Note 3f2a9c1b: too big to copy`. Unknown reasons are shown as they are. */
export function failureLines(failures: { noteId: string; reason: string }[] | undefined): string[] {
  return (failures ?? []).map(({ noteId, reason }) => `Note ${noteId.slice(0, 8)}: ${FAILURE_REASONS[reason] ?? reason}`);
}

/** `@handle`, or `(no handle)`. A leading `@` in the stored value is not doubled. */
export function handleLabel(handle: string | null): string {
  const bare = handle?.replace(/^@+/, "").trim() ?? "";
  return bare === "" ? "(no handle)" : `@${bare}`;
}

/** The toggle's word: what pressing it does. */
export function pauseLabel(paused: boolean): string {
  return paused ? "Resume" : "Pause";
}

export type NoteIdsMode = NoteIdsReport["mode"];

/** Which keys reads use right now, in plain words. */
export function modeLabel(mode: NoteIdsMode): string {
  if (mode === "keys") return "Reading from notes/ only";
  return mode === "ids" ? "Reading from notes/" : "Reading from paths";
}

/**
 * The mode the switch button moves to. Keys mode is one-way and has no switch
 * (the card hides the button there), so it stays keys.
 */
export function nextMode(mode: NoteIdsMode): NoteIdsMode {
  if (mode === "keys") return "keys";
  return mode === "ids" ? "paths" : "ids";
}

/** The button's words: what pressing it does. */
export function switchLabel(mode: NoteIdsMode): string {
  if (mode === "keys") return "Reads come from notes/ only";
  return mode === "ids" ? "Switch back to paths" : "Switch to notes/";
}

/** `12 of 40 on notes/ only`: live files already keyed, in keys mode. */
export function keyedLine(keyed: number, liveFiles: number): string {
  return `${count(keyed)} of ${count(liveFiles)} on notes/ only`;
}

/**
 * The confirm's words, before the switch and in plain language. Switching to
 * `notes/` says a note that is still being copied is read from its path until
 * its copy catches up, and that saves keep going to both places, so a switch
 * back loses nothing.
 */
export function switchNote(mode: NoteIdsMode): string {
  if (mode === "keys") return "Reads come from notes/ only. Keys mode has no switch back from here.";
  if (mode === "ids") {
    return "Notes will be read from their paths again. Nothing is deleted, and the copies in notes/ stay where they are.";
  }
  return "Notes will be read from their copies in notes/, which are named by each note's id rather than its name. " +
    "A note whose copy is out of date is read from its path until its copy catches up. " +
    "Saves go to both places from now on, so you can switch back at any time without losing anything.";
}

/** Whether a row's copy is complete: the pass done, every file copied, none failed (the gate's own rule). */
export function rowFullyCopied(row: NoteIdsWorkspace): boolean {
  return row.status === "done" && row.failed === 0 && row.copied === row.files;
}

/** How many live workspaces are not fully copied: the number the switch to keys waits on. */
export function workspacesNotReady(rows: readonly NoteIdsWorkspace[]): number {
  return rows.filter((row) => !row.archived && !rowFullyCopied(row)).length;
}

/** The keys button: shown in ids mode only, enabled once every live workspace is copied, else the plain reason. */
export type KeysSwitch = { shown: boolean; enabled: boolean; reason: string | null };

export function keysSwitch(mode: NoteIdsMode, rows: readonly NoteIdsWorkspace[]): KeysSwitch {
  if (mode !== "ids") return { shown: false, enabled: false, reason: null };
  const waiting = workspacesNotReady(rows);
  if (waiting === 0) return { shown: true, enabled: true, reason: null };
  const noun = waiting === 1 ? "workspace is" : "workspaces are";
  return { shown: true, enabled: false, reason: `${count(waiting)} ${noun} not fully copied yet.` };
}

/** The button's words. */
export function keysLabel(): string {
  return "Make notes/ the only copy";
}

/** The confirm, in plain language: what is true after it, and that it cannot be switched back. */
const FAILED_REASONS: Record<string, string> = {
  delete_failed: "the delete failed",
  kept: "kept, because a note still reads it",
};

/**
 * The old-copy cleanup in plain words, one line per fact: a run in progress,
 * a finished delete, or the last count. A fixed error label is shown as it is.
 */
export function cleanupSummary(cleanup: NoteIdsCleanup): string[] {
  const lines: string[] = [];
  if (cleanup.running === "count") lines.push("Counting old copies…");
  else if (cleanup.running === "delete") lines.push(`Deleting old copies… ${count(cleanup.deleted)} deleted so far`);
  else if (cleanup.finishedAt !== null) {
    const failed = cleanup.failed.reduce((sum, entry) => sum + entry.count, 0);
    const reasons = cleanup.failed.map((entry) => FAILED_REASONS[entry.reason] ?? entry.reason).join(", ");
    lines.push(
      failed > 0
        ? `Deleted ${count(cleanup.deleted)} old copies · ${count(failed)} could not be deleted: ${reasons}`
        : `Deleted ${count(cleanup.deleted)} old copies`,
    );
  } else if (cleanup.countedAt !== null) {
    lines.push(
      `Counted: ${count(cleanup.toDelete)} old copies to delete · ${count(cleanup.unclaimed)} that no note names · ` +
        `${count(cleanup.readingPaths)} notes still read from a path`,
    );
  } else lines.push("Not counted yet.");
  if (cleanup.error !== null && cleanup.error.trim() !== "") lines.push(cleanup.error);
  return lines;
}

/** The count button's words. */
export function countLabel(): string {
  return "Count old copies";
}

/** The delete button's words: the one-way door says so in its own label. */
export function deleteLabel(): string {
  return "Delete old copies — can't be undone";
}

/**
 * Each button enabled or not, with the plain reason when it is not. Neither is
 * offered while a run is going; otherwise the server's refusal is the reason.
 */
export function cleanupButtons(cleanup: NoteIdsCleanup): {
  count: { enabled: boolean; reason: string | null };
  delete: { enabled: boolean; reason: string | null };
} {
  const running = cleanup.running !== null;
  const countRefusal = cleanup.countBlocked?.message ?? null;
  const deleteRefusal = cleanup.deleteBlocked?.message ?? null;
  return {
    count: { enabled: !running && countRefusal === null, reason: running ? null : countRefusal },
    delete: { enabled: !running && deleteRefusal === null, reason: running ? null : deleteRefusal },
  };
}

export function keysNote(): string {
  return (
    "After this, every note lives only under notes/, and names live only in Context. " +
    "This cannot be switched back."
  );
}

/** How many notes in one workspace share an id with another note (the rows in each group, summed). */
export function sharedIdsLine(count: number): string {
  if (count === 0) return "No notes share an id with another note";
  return `${count.toLocaleString("en-US")} ${count === 1 ? "note shares" : "notes share"} an id with another note`;
}

/**
 * A group that is left as it is, in plain words: the heading says why, and each
 * path is listed under it. Nothing in the group changes until someone has looked.
 */
export function needsLookLines(paths: readonly string[]): { heading: string; paths: string[] } {
  return {
    heading: "These notes share an id. One is stored under the id's key, so they were left as they are. Look at them first.",
    paths: [...paths],
  };
}
