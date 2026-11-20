/**
 * Structured log lines. The allowlist is the rule: a field that is not named
 * here is dropped, so message text, tokens and full phone numbers cannot reach
 * the log by accident. `line` is always reduced to its last four digits.
 */

const FIELDS = new Set([
  "event", "line", "seq", "ms", "ok", "status", "error", "retryable",
  "frontier", "queued", "lines", "attempt", "delay_ms", "outcome", "op", "port",
  // A Photon read: the first catch-up after start, and each later poll.
  "first", "replayed", "lag_ms",
  // A provider failure's own reason, scrubbed (`errors.mjs` `errorDetail`).
  "field", "request", "grpc", "detail",
  // A skipped gap's size, a frontier's age, a shutdown's signal, a crash's class.
  "count", "stuck_ms", "signal", "reason",
]);

export function last4(value) {
  return String(value ?? "").replace(/\D/g, "").slice(-4);
}

export function formatLog(record, now = new Date()) {
  const out = { ts: now.toISOString() };
  for (const [key, value] of Object.entries(record)) {
    if (!FIELDS.has(key) || value === undefined) continue;
    out[key] = key === "line" ? last4(value) : value;
  }
  return JSON.stringify(out);
}

/**
 * The last `limit` records, numbered, so the Durable Object can read what the
 * container logged since its last look and put it in the Worker's own logs:
 * a container's stdout is not in the Worker's telemetry. Records are the
 * allowlisted ones above, so nothing here is new to the log.
 */
export function createLogRing(limit = 200, boot = Math.random().toString(36).slice(2, 10)) {
  const records = [];
  let last = 0;
  return {
    push(line) {
      last += 1;
      records.push({ id: last, ...JSON.parse(line) });
      if (records.length > limit) records.shift();
    },
    /** Records after `id`, oldest first; `next` is the id to ask after next time, `boot` names this process. */
    after(id) {
      const from = Number.isSafeInteger(id) && id >= 0 && id <= last ? id : 0;
      return { boot, next: last, records: records.filter((record) => record.id > from) };
    },
  };
}

export function createLogger(sink = process.stdout, ring) {
  return (record) => {
    const line = formatLog(record);
    sink.write(`${line}\n`);
    ring?.push(line);
  };
}
