/**
 * Whether the bridge has actually read Photon lately.
 *
 * The container answering `/health` is not a read: on 2026-11-17 the process
 * stayed up, `bridge.health` said ok with an empty queue, and Photon calls
 * had already stopped. A poll is expected about once a minute. No successful
 * read within two of those is degraded; none for three minutes, while the
 * container says it is up, is stale and the object restarts it.
 */

export const POLL_INTERVAL_MS = 60_000;
export const DEGRADED_AFTER_MS = 2 * POLL_INTERVAL_MS;
export const STALE_AFTER_MS = 3 * 60_000;

/**
 * @param {{ now: number, started: boolean, startedAt: number | null, lastReadAt: number | null }} input
 * @returns {{ ok: boolean, read: "starting" | "fresh" | "degraded" | "stale", readAgeMs: number | null }}
 */
export function readHealth({ now, started, startedAt, lastReadAt }) {
  if (!started) return { ok: true, read: "starting", readAgeMs: null };
  const age = lastReadAt == null
    ? (typeof startedAt === "number" ? now - startedAt : null)
    : now - lastReadAt;
  if (age == null || !Number.isFinite(age)) return { ok: false, read: "degraded", readAgeMs: null };
  if (lastReadAt == null) {
    if (age <= DEGRADED_AFTER_MS) return { ok: true, read: "starting", readAgeMs: age };
    if (age < STALE_AFTER_MS) return { ok: false, read: "degraded", readAgeMs: age };
    return { ok: false, read: "stale", readAgeMs: age };
  }
  if (age <= DEGRADED_AFTER_MS) return { ok: true, read: "fresh", readAgeMs: age };
  if (age < STALE_AFTER_MS) return { ok: false, read: "degraded", readAgeMs: age };
  return { ok: false, read: "stale", readAgeMs: age };
}

/** Restart only when the container claims to be up and its last read is stale. */
export function shouldRestartContainer(health) {
  return Boolean(health && health.started === true && health.read === "stale");
}
