// Summarise `convex logs --jsonl` into failed functions and error shapes, for a
// public run page (`.github/workflows/control-plane-errors.yml`). Every value
// that could name a tenant is scrubbed before it is counted.
import { readFileSync } from "node:fs";

export function scrub(text) {
  return String(text)
    .split("\n")[0]
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "<q>")
    .replace(/[A-Za-z0-9_-]*\d[A-Za-z0-9_-]*/g, "<n>")
    .replace(/\S+@\S+/g, "<e>")
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/[^A-Za-z<>:()., -]/g, "")
    .slice(0, 140);
}

export function summarise(lines, match = "") {
  const counts = new Map();
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const path = typeof event.identifier === "string" ? event.identifier : typeof event.udfPath === "string" ? event.udfPath : "";
    if (!/^[A-Za-z0-9_:/.-]{1,120}$/.test(path) || (match && !path.includes(match))) continue;
    const error = event.error ?? event.message?.error;
    if (error === undefined || error === null || error === "") continue;
    const key = `${path} | ${scrub(error)}`;
    const seen = counts.get(key) ?? { count: 0, last: 0 };
    const at = Number(event.timestamp ?? 0);
    counts.set(key, { count: seen.count + 1, last: Math.max(seen.last, Number.isFinite(at) ? at : 0) });
  }
  return [...counts].sort((a, b) => b[1].last - a[1].last);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const lines = readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean);
  const rows = summarise(lines, process.env.MATCH ?? "");
  console.log(`${lines.length} events read, ${rows.length} distinct failures.`);
  for (const [key, { count, last }] of rows) {
    const when = last > 0 ? new Date(last > 1e12 ? last : last * 1000).toISOString().slice(0, 16) : "?";
    console.log(`${when}Z  x${count}  ${key}`);
  }
}
