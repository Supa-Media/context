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
};

export type NoteIdsTotals = { files: number; copied: number; failed: number };

export type NoteIdsReport = {
  paused: boolean;
  mode: "paths" | "ids";
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

/** `@handle`, or `(no handle)`. A leading `@` in the stored value is not doubled. */
export function handleLabel(handle: string | null): string {
  const bare = handle?.replace(/^@+/, "").trim() ?? "";
  return bare === "" ? "(no handle)" : `@${bare}`;
}

/** The toggle's word: what pressing it does. */
export function pauseLabel(paused: boolean): string {
  return paused ? "Resume" : "Pause";
}
