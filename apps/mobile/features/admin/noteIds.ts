/**
 * The "Notes by id" card on the Search tab (`./NoteIdsView`) as data: the
 * diagnosis words, the handle, and the old-copy cleanup's words and refusals.
 * Pure, so the rules are pinned by `adminNoteIds.test.ts`.
 *
 * The report is `api.functions.noteIds.report` (`apps/convex/functions/
 * noteIds.ts`). Its shape is typed here rather than read from the generated
 * api, so this file compiles and tests before that module lands.
 */

export type NoteIdsDiagnosis = { checkedAt: number; checked: number; missing: number; differs: number };

export type NoteIdsWorkspace = {
  workspaceId: string;
  /** The handle without the `@`; null for a workspace that has none. */
  handle: string | null;
  /** The last diagnosis of the workspace's id copies, or null before one ran. */
  diagnosis: NoteIdsDiagnosis | null;
  /** Held by an archived account. */
  archived: boolean;
  /** The old-copy cleanup (absent from an older server). */
  cleanup?: NoteIdsCleanup;
};

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

export type NoteIdsReport = {
  workspaces: NoteIdsWorkspace[];
  truncated: boolean;
};

const count = (value: number) => value.toLocaleString("en-US");

export function diagnosisLine(diagnosis: NoteIdsDiagnosis | null | undefined): string | null {
  if (diagnosis === undefined || diagnosis === null) return null;
  return `Checked ${count(diagnosis.checked)} · ${count(diagnosis.missing)} missing · ${count(diagnosis.differs)} differs`;
}

/** `@handle`, or `(no handle)`. A leading `@` in the stored value is not doubled. */
export function handleLabel(handle: string | null): string {
  const bare = handle?.replace(/^@+/, "").trim() ?? "";
  return bare === "" ? "(no handle)" : `@${bare}`;
}

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
