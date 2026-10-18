import type { MirrorStatus } from "./mirrorStatus";

/**
 * What the phone says about downloads (owner, 2026-10-16; moved under the
 * Notes title 2026-10-18): how many notes are on this device, which opens a
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

/**
 * The line under the phone's Notes title, for the workspace on screen: how
 * many of its notes are on this device, pressed for the Downloads sheet.
 * Dev2 (2026-10-18): *"under it can have a clickable number of notes
 * downloaded underneath notes, and get rid of the ugly pill in the top
 * right"* — it replaced the top-right pill of 2026-10-16, which said the same
 * only while notes were missing. `null` where this device keeps no copy.
 */
export function downloadedLine(row: DownloadRow | undefined): string | null {
  if (row === undefined) return null;
  const notes = (n: number) => `${formatCount(n)} note${n === 1 ? "" : "s"}`;
  switch (row.state) {
    case "downloading":
    case "partial":
      return `${formatCount(row.done)} of ${notes(row.total)} downloaded`;
    case "done":
      return row.total === 0 ? null : `${notes(row.total)} downloaded`;
    case "waiting":
      return "Not downloaded yet";
    case "online-only":
      return "Online only";
  }
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
