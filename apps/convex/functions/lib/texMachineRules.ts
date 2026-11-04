/**
 * The rules a paired machine is held to, in one place: who may own one, what a pairing code looks like once
 * normalized, and how long a pairing lives. Pure, so the gateway routes, the app functions and the tests all read
 * the same answer (`docs/decisions/texting-assistant/machines.md`).
 */

import type { WorkspaceRole } from "./workspaceAuth";

export const TEX_MACHINE_OS = ["macos", "linux", "windows"] as const;
export type TexMachineOs = (typeof TEX_MACHINE_OS)[number];

/** Raw Ed25519 public key, base64url without padding. */
export const TEX_MACHINE_PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const TEX_MACHINE_NAME_MAX = 100;

/** A pairing code is shown for this long before it stops being approvable. */
export const PAIRING_TTL_MS = 10 * 60 * 1000;
/** An approved pairing may still be claimed for this long past its code's expiry. */
export const PAIRING_CLAIM_GRACE_MS = 10 * 60 * 1000;
/** Pairing rows are kept this long past expiry, then swept. */
export const PAIRING_RETENTION_MS = 60 * 60 * 1000;
/** A machine's `lastSeenAt` is written at most this often. */
export const LAST_SEEN_WRITE_INTERVAL_MS = 10 * 60 * 1000;

/** The OAuth client id a run grant reads as: a machine job's part, not the texting client it acts for. */
export const TEX_MACHINE_RUN_CLIENT_ID = "context_tex_machine_run";
/** A run grant never lives longer than this, whatever the gateway asks. */
export const TEX_MACHINE_RUN_MAX_MS = 30 * 60 * 1000;
/** The workspace object's run id: `run_` and 24 lower-case hex digits. */
export const TEX_MACHINE_RUN_ID_PATTERN = /^run_[0-9a-f]{24}$/;

/** A group chat's key (`textGroups.groupKey`): sha256 hex. Anything else names no chat. */
export const CHAT_GROUP_KEY_PATTERN = /^[0-9a-f]{64}$/;
/** Most machines one group chat may borrow at once. */
export const TEX_MACHINE_CHAT_LIMIT = 10;

/**
 * "May own a machine in this workspace." Personal: only the owner, who is the person the workspace is theirs by.
 * Shared: an owner or an editor. A `member` never owns one, so a machine can never be attached to a workspace its
 * owner can only read.
 */
export function mayOwnTexMachine(kind: "personal" | "shared", role: WorkspaceRole): boolean {
  if (kind === "personal") return role === "owner";
  return role === "owner" || role === "editor";
}

/**
 * Upper-cases a typed or displayed pairing code and drops everything but letters and digits, so `kq7-4mp` and
 * `KQ74MP` are the same code. `null` unless six characters remain.
 */
export function normalizePairingCode(code: string): string | null {
  const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return normalized.length === 6 ? normalized : null;
}

/** What a pairing code is hashed from. Domain-separated so the digest names nothing else in this system. */
export function pairingCodeHashInput(normalizedCode: string): string {
  return `tex-machine-pair:${normalizedCode}`;
}

export function isValidMachineName(name: string): boolean {
  return name.length >= 1 && name.length <= TEX_MACHINE_NAME_MAX;
}

export function isTexMachineOs(value: unknown): value is TexMachineOs {
  return typeof value === "string" && (TEX_MACHINE_OS as readonly string[]).includes(value);
}
