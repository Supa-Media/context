/**
 * What the console says about the Messages backup, from what the Mac app
 * reports over the bridge (`MessagesBackupView`). Pure, so every sentence is
 * a test (`__tests__/messagesBackupView.test.ts`).
 *
 * The words follow the approved boards (owner, 2026-10-26): no "sync", no
 * "database"; the account and the Mac are named so a shared Mac is caught
 * before anything leaves; and the switch's "off" keeps what is copied.
 * `docs/decisions/communications/messages-backup.md` carries the argument.
 */

import type { ImessageStatus, MessagesBackupView } from "@context/desktop-bridge";

/** The backup on this Mac, or why there is nothing to say about it. */
export type BackupOnThisMac =
  /** A Mac app from before the backup: it reports the retired import, not this. */
  | { kind: "outdated" }
  | { kind: "here"; enabled: boolean; view: MessagesBackupView };

export function backupOnThisMac(status: ImessageStatus): BackupOnThisMac {
  if (status.backup === undefined) return { kind: "outdated" };
  return { kind: "here", enabled: status.enabled, view: status.backup };
}

/**
 * Whether the first-run card is up: the backup is on (it is by default) and
 * macOS has not been given Full Disk Access, which no app can ask for.
 * Granting it or turning the backup off answers the card for good.
 */
export function waitingForFullDiskAccess(status: ImessageStatus | null): boolean {
  if (status === null || status.backup === undefined) return false;
  return status.enabled && status.backup.phase === "needs_permission";
}

/** "+1 ••• 4410 · Sams MacBook Pro", or as much of it as is known. */
export function whoseTexts(view: MessagesBackupView): string {
  const parts = [view.account, view.machine].filter((part): part is string => part !== null);
  return parts.length === 0 ? "Texts on this Mac" : `Texts for ${parts.join(" · ")}`;
}

const MONTH = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

function count(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString("en-US");
}

/** "just now", "2 min ago", "3 hours ago", "4 days ago". */
export function ago(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** Why a pass stopped, from the closed set the Mac app reports. Never the server's words. */
const STOPPED: Record<string, string> = {
  reconnect: "This Mac needs to be connected again before it can copy more.",
  not_allowed: "Your account refused this Mac's copy. Reconnect this Mac to your own workspace.",
  not_available: "Your workspace can't keep texts yet. Update the Mac app.",
  refused: "Some texts were refused. The Mac app tries again with the next ones.",
  busy: "Context is busy. The Mac app tries again in a few minutes.",
  offline: "This Mac is offline. Copying picks up when it's back.",
  unavailable: "Context couldn't be reached. The Mac app tries again in a few minutes.",
  unreadable: "Messages couldn't be read just now. The Mac app tries again in a few minutes.",
};

/** The progress line under the switch: a title, and the detail under it. */
export function progressLines(
  enabled: boolean,
  view: MessagesBackupView,
  { now, lastCopiedAt }: { now: number; lastCopiedAt: number | null },
): { title: string; detail: string | null } {
  if (!enabled || view.phase === "off") {
    return { title: "Off", detail: "Nothing new is copied. What's already copied stays in your storage." };
  }
  switch (view.phase) {
    case "needs_permission":
      return {
        title: "Waiting for Full Disk Access",
        detail: "Open System Settings › Privacy & Security › Full Disk Access and turn on Context.",
      };
    case "no_messages":
      return { title: "No Messages on this Mac", detail: "Nothing is copied until Messages is signed in here." };
    case "not_connected":
      return { title: "This Mac isn't connected", detail: "Nothing is copied until it is." };
    case "stopped":
      return { title: "Paused", detail: STOPPED[view.problem ?? ""] ?? STOPPED.unavailable };
    case "up_to_date":
      return { title: lastCopiedAt === null ? "Up to date" : `Up to date · copied ${ago(lastCopiedAt, now)}`, detail: null };
    case "copying": {
      const parts: string[] = [];
      if (view.totalRows > 0) parts.push(`${count(Math.min(view.copiedRows, view.totalRows))} of ${count(view.totalRows)} messages`);
      if (view.reachedBack !== null) parts.push(`back to ${MONTH.format(new Date(view.reachedBack))} so far`);
      return { title: "Copying, newest first", detail: parts.length === 0 ? null : parts.join(" · ") };
    }
  }
}
