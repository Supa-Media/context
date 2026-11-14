/**
 * Structured log lines. The allowlist is the rule: a field that is not named
 * here is dropped, so message text, tokens and full phone numbers cannot reach
 * the log by accident. `line` is always reduced to its last four digits.
 */

const FIELDS = new Set([
  "event", "line", "seq", "ms", "ok", "status", "error", "retryable",
  "frontier", "queued", "lines", "attempt", "delay_ms", "outcome", "op", "port",
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

export function createLogger(sink = process.stdout) {
  return (record) => {
    sink.write(`${formatLog(record)}\n`);
  };
}
