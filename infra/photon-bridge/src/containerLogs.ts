/**
 * The container's own log lines, brought into the Worker's logs. A container's stdout is not in Workers
 * telemetry, so without this nothing the listener says (a line started, a stream failed, a token renewal
 * failed) is visible anywhere. Each wake reads the records since the last one and logs each with
 * `from: "container"`, then one `bridge.health` line: per line its last four digits and frontier, the queue
 * depth, whether the listeners started, and how long ago a Photon read succeeded. `ok` is false when that
 * read is older than two poll intervals. The container's log allowlist (`container/log.mjs`) already keeps
 * message text and full numbers out; this adds nothing to it.
 */

import { readHealth, type ReadState } from "../container/readHealth.mjs";
import type { Fetchish, Log } from "./pump";

/** Where the last read ended: the container process (`boot`) and its last record's number. */
export type LogCursor = { boot: string; next: number };

type Records = { boot?: string; next?: number; records?: Record<string, unknown>[] };

const MAX_RECORDS = 200;

export type ReportedHealth = {
  ok: boolean;
  read: ReadState;
  readAgeMs: number | null;
  started: boolean;
};

function asTime(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Logs what the container logged after `cursor`, then its health. Health is
 * ok only when a Photon read has succeeded within two poll intervals.
 */
export async function forwardContainerLogs(
  port: Fetchish,
  cursor: LogCursor,
  log: Log,
  now: () => number = Date.now,
): Promise<{ cursor: LogCursor; health: ReportedHealth | null }> {
  let next = cursor;
  try {
    // A container that restarted is another process, numbering from 1: read it again from the start.
    let response = await port.fetch(`http://container/logs?after=${cursor.next}`);
    let body = response.ok ? ((await response.json()) as Records) : undefined;
    if (body && body.boot !== cursor.boot && cursor.next > 0) {
      response = await port.fetch("http://container/logs?after=0");
      body = response.ok ? ((await response.json()) as Records) : undefined;
    }
    if (body) {
      const records = Array.isArray(body.records) ? body.records.slice(-MAX_RECORDS) : [];
      for (const record of records) {
        if (record && typeof record === "object") log({ from: "container", ...record });
      }
      next = { boot: typeof body.boot === "string" ? body.boot : "", next: Number.isSafeInteger(body.next) ? (body.next as number) : 0 };
    } else {
      log({ event: "bridge.logs_failed", status: response.status });
    }
  } catch (error) {
    log({ event: "bridge.logs_failed", error: error instanceof Error ? error.name : "unknown" });
  }
  let health: ReportedHealth | null = null;
  try {
    const response = await port.fetch("http://container/health");
    if (!response.ok) {
      log({ event: "bridge.health", ok: false, status: response.status });
    } else {
      const body = (await response.json()) as {
        started?: boolean;
        startedAt?: number | null;
        lastReadAt?: number | null;
        queued?: number;
        lines?: { line: string; frontier: number | null }[];
        skipped?: Record<string, number>;
        checks?: number;
      };
      const verdict = readHealth({
        now: now(),
        started: body.started === true,
        startedAt: asTime(body.startedAt),
        lastReadAt: asTime(body.lastReadAt),
      });
      health = { ok: verdict.ok, read: verdict.read, readAgeMs: verdict.readAgeMs, started: body.started === true };
      log({
        event: "bridge.health",
        ok: verdict.ok,
        read: verdict.read,
        read_age_ms: verdict.readAgeMs,
        last_read_at: asTime(body.lastReadAt),
        started: body.started === true,
        queued: body.queued ?? 0,
        lines: body.lines ?? [],
        skipped: body.skipped ?? {},
        checks: body.checks ?? 0,
      });
    }
  } catch (error) {
    log({ event: "bridge.health", ok: false, error: error instanceof Error ? error.name : "unknown" });
  }
  return { cursor: next, health };
}
