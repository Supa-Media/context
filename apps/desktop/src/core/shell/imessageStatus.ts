/**
 * The Messages status the page is handed, rebuilt field by field in the
 * preload: what `bridge.ts` does for every payload, kept here because the
 * backup's view is the largest of them.
 *
 * Anything the contract does not name stays in the main process. A shell
 * that grew a field does not get to start shipping it to a page served from
 * the network, and a backup view that carried a word of a text would be
 * exactly that field.
 */

import type { ImessageStatus, MessagesBackupPhase, MessagesBackupView } from "@context/desktop-bridge";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function sentence(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function time(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const IMESSAGE_PERMISSIONS: readonly ImessageStatus["permission"][] = ["granted", "denied", "unknown"];

export function imessageStatusFrom(payload: unknown): ImessageStatus {
  const source = record(payload);
  const permission = source.permission;
  return {
    enabled: source.enabled === true,
    permission: IMESSAGE_PERMISSIONS.includes(permission as ImessageStatus["permission"])
      ? (permission as ImessageStatus["permission"])
      : "unknown",
    lastSyncedAt: time(source.lastSyncedAt),
    lastError: sentence(source.lastError),
    ...(source.backup === undefined ? {} : { backup: backupViewFrom(source.backup) }),
  };
}

const BACKUP_PHASES: readonly MessagesBackupPhase[] = [
  "off",
  "needs_permission",
  "no_messages",
  "not_connected",
  "copying",
  "up_to_date",
  "stopped",
];

/** Short labels only: a field that grew past one is not a label, and is dropped. */
function label(value: unknown): string | null {
  const word = sentence(value);
  return word !== null && word.length <= 80 ? word : null;
}

/**
 * The backup's progress, field by field. Anything the contract does not name
 * stays in the main process, for the reason at the top of this file.
 */
function backupViewFrom(payload: unknown): MessagesBackupView {
  const source = record(payload);
  return {
    phase: BACKUP_PHASES.includes(source.phase as MessagesBackupPhase) ? (source.phase as MessagesBackupPhase) : "off",
    copiedRows: count(source.copiedRows),
    totalRows: count(source.totalRows),
    reachedBack: time(source.reachedBack),
    problem: label(source.problem),
    account: label(source.account),
    machine: label(source.machine),
  };
}
