export const POLL_INTERVAL_MS: number;
export const DEGRADED_AFTER_MS: number;
export const STALE_AFTER_MS: number;

export type ReadState = "starting" | "fresh" | "degraded" | "stale";

export function readHealth(input: {
  now: number;
  started: boolean;
  startedAt: number | null;
  lastReadAt: number | null;
}): { ok: boolean; read: ReadState; readAgeMs: number | null };

export function shouldRestartContainer(
  health: { started?: boolean; read?: string } | null | undefined,
): boolean;
