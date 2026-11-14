/**
 * The container's own log lines, brought into the Worker's logs. A container's stdout is not in Workers
 * telemetry, so without this nothing the listener says (a line started, a stream failed, a token renewal
 * failed) is visible anywhere. Each wake reads the records since the last one and logs each with
 * `from: "container"`, then one `bridge.health` line: per line its last four digits and frontier, the queue
 * depth, and whether the listeners started. The container's log allowlist (`container/log.mjs`) already keeps
 * message text and full numbers out; this adds nothing to it.
 */

import type { Fetchish, Log } from "./pump";

/** Where the last read ended: the container process (`boot`) and its last record's number. */
export type LogCursor = { boot: string; next: number };

type Records = { boot?: string; next?: number; records?: Record<string, unknown>[] };

const MAX_RECORDS = 200;

/** Logs what the container logged after `cursor`, then its health; resolves the cursor to use next time. */
export async function forwardContainerLogs(port: Fetchish, cursor: LogCursor, log: Log): Promise<LogCursor> {
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
  try {
    const response = await port.fetch("http://container/health");
    if (!response.ok) {
      log({ event: "bridge.health", ok: false, status: response.status });
    } else {
      const health = (await response.json()) as { started?: boolean; queued?: number; lines?: { line: string; frontier: number | null }[] };
      log({ event: "bridge.health", ok: true, started: health.started === true, queued: health.queued ?? 0, lines: health.lines ?? [] });
    }
  } catch (error) {
    log({ event: "bridge.health", ok: false, error: error instanceof Error ? error.name : "unknown" });
  }
  return next;
}
