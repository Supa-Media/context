import type { MirrorStatus } from "./mirrorStatus";

/**
 * What the phone says about downloads (owner, 2026-10-16): one pill at the
 * top right while notes are coming down, "340 / 1,204", that opens a
 * Downloads sheet with a line per workspace and a Don't download button.
 *
 * Pure, so the words are tested without a renderer. Counts only, never note
 * text or paths.
 */

export type DownloadState =
  /** Notes are coming down now. */
  | "downloading"
  /** Every note this device keeps is here at its current version. */
  | "done"
  /** Part is here; the rest comes on the next connected pass. */
  | "partial"
  /** Nothing from this workspace has been downloaded yet. */
  | "waiting"
  /** The person chose to keep this workspace online only. */
  | "online-only";

export interface DownloadRow {
  workspaceId: string;
  /** `@slug`. */
  label: string;
  state: DownloadState;
  done: number;
  total: number;
}

export function downloadRows(
  contexts: readonly { id: string; slug: string }[],
  statuses: ReadonlyMap<string, MirrorStatus>,
  onlineOnly: ReadonlySet<string>,
): DownloadRow[] {
  return contexts.map((context) => {
    const base = { workspaceId: context.id, label: `@${context.slug}` };
    if (onlineOnly.has(context.id)) return { ...base, state: "online-only", done: 0, total: 0 };
    const status = statuses.get(context.id);
    if (status === undefined || status.state === "never" || status.state === "unavailable") {
      return { ...base, state: "waiting", done: status?.notes ?? 0, total: 0 };
    }
    const total = status.total ?? status.notes;
    const done = Math.min(status.notes, total);
    if (status.state === "syncing" && done < total) return { ...base, state: "downloading", done, total };
    if (status.state === "partial" && done < total) return { ...base, state: "partial", done, total };
    return { ...base, state: "done", done: total, total };
  });
}

/** "1,204" — the device's locale grouping is not worth a dependency here. */
export function formatCount(n: number): string {
  return String(Math.max(0, Math.round(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export interface DownloadPill {
  done: number;
  total: number;
  /** "340 / 1,204", or "28%" once the numbers are too long for the top row. */
  text: string;
  label: string;
  fraction: number;
}

/**
 * The pill, or `null` when nothing is coming down. Across every workspace,
 * so there is one entry point however many are syncing.
 */
export function downloadPill(rows: readonly DownloadRow[]): DownloadPill | null {
  if (!rows.some((row) => row.state === "downloading")) return null;
  let done = 0;
  let total = 0;
  for (const row of rows) {
    if (row.state === "downloading" || row.state === "partial") {
      done += row.done;
      total += row.total;
    }
  }
  if (total <= 0) return null;
  const fraction = Math.min(1, done / total);
  const counts = `${formatCount(done)} / ${formatCount(total)}`;
  const text = total >= 10_000 ? `${Math.floor(fraction * 100)}%` : counts;
  return { done, total, fraction, text, label: `Downloading notes, ${formatCount(done)} of ${formatCount(total)}` };
}

/** The right-hand words on a workspace's row in the sheet. */
export function rowStatus(row: DownloadRow): string {
  switch (row.state) {
    case "downloading":
    case "partial":
      return `${formatCount(row.done)} of ${formatCount(row.total)}`;
    case "done":
      return row.total === 0 ? "Nothing to download" : `All ${formatCount(row.total)}`;
    case "waiting":
      return "Next";
    case "online-only":
      return "Online only";
  }
}
