import { useSyncExternalStore } from "react";
import { isNotePath, type IncompleteReason, type MirrorIndex } from "./mirror";

/**
 * How much of each context is on this device — the fact the owner asked to be
 * able to see: "it should be clear when notes are not synced".
 *
 * One value per workspace, published by `useMirrorSync` as it runs and read
 * by anything that draws it (`mirrorCopy.ts` words it). A module-level store
 * rather than React state, because the sync is device-wide and mounted once
 * while the surfaces that draw its result are wherever the console puts them —
 * the same shape `epoch.ts` and `mirrorHolds.ts` already have for facts about
 * the device rather than about a screen.
 */

export type MirrorState =
  /** A sync is running for this context now. */
  | "syncing"
  /** The last sync listed everything and every note is here at its current version. */
  | "synced"
  /** The last sync could not finish, or could not fetch everything it listed. */
  | "partial"
  /** This device has no mirror at all — a browser with IndexedDB blocked. */
  | "unavailable"
  /** Nothing for this context has been synced on this device yet. */
  | "never";

export interface MirrorStatus {
  state: MirrorState;
  /** Notes with a body on this device. */
  notes: number;
  /** Their size, as the bucket counts it. */
  bytes: number;
  /** When a sync last finished for this context, complete or not. */
  lastSyncedAt: number | null;
  /** Notes listed and not on this device at their current version. */
  remaining?: number;
  /** Notes listed in all — the denominator of "340 of 1,204". */
  total?: number;
  truncatedReason?: IncompleteReason;
}

export const UNAVAILABLE: MirrorStatus = Object.freeze({
  state: "unavailable",
  notes: 0,
  bytes: 0,
  lastSyncedAt: null,
}) as MirrorStatus;

/** What an index says about itself, when no sync is running. */
export function statusFromIndex(index: MirrorIndex | null): MirrorStatus {
  if (index === null) return { state: "never", notes: 0, bytes: 0, lastSyncedAt: null };
  let notes = 0;
  let bytes = 0;
  for (const entry of index.entries.values()) {
    if (!entry.body || !isNotePath(entry.path)) continue;
    notes += 1;
    bytes += entry.size ?? 0;
  }
  const remaining = index.remaining ?? 0;
  if (index.lastSyncedAt === undefined) {
    // Notes opened online before any sync ran: some copies, no claim about
    // the rest.
    return { state: "never", notes, bytes, lastSyncedAt: null };
  }
  const settled = notes - Math.min(notes, remaining);
  return {
    state: index.complete === true ? "synced" : "partial",
    notes,
    bytes,
    lastSyncedAt: index.lastSyncedAt,
    ...(remaining > 0 ? { remaining } : {}),
    total: settled + remaining,
    ...(index.complete === true || index.incomplete === undefined
      ? {}
      : { truncatedReason: index.incomplete }),
  };
}

/* --------------------------------- the store ------------------------------ */

let statuses: ReadonlyMap<string, MirrorStatus> = new Map();
const listeners = new Set<() => void>();

function emit(next: ReadonlyMap<string, MirrorStatus>): void {
  statuses = next;
  for (const listener of listeners) listener();
}

export function publishMirrorStatus(workspaceId: string, status: MirrorStatus): void {
  const next = new Map(statuses);
  next.set(workspaceId, status);
  emit(next);
}

/** For sign-out, and for a context this device no longer holds. */
export function forgetMirrorStatus(workspaceId?: string): void {
  if (workspaceId === undefined) {
    emit(new Map());
    return;
  }
  if (!statuses.has(workspaceId)) return;
  const next = new Map(statuses);
  next.delete(workspaceId);
  emit(next);
}

export function mirrorStatuses(): ReadonlyMap<string, MirrorStatus> {
  return statuses;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Every context's mirror status, re-rendering when any changes. */
export function useMirrorStatuses(): ReadonlyMap<string, MirrorStatus> {
  return useSyncExternalStore(subscribe, mirrorStatuses, mirrorStatuses);
}

/** One context's, or `undefined` before anything has been said about it. */
export function useMirrorStatus(workspaceId: string | null): MirrorStatus | undefined {
  const all = useMirrorStatuses();
  return workspaceId === null ? undefined : all.get(workspaceId);
}
