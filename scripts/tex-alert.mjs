// Every 15 minutes, read what context-agent logged and say whether Tex's group
// path is failing (Dev2, 2026-10-27). On 2026-10-27 group decide failed on every
// call and untagged texts were dropped as unbound for hours, and nothing told
// anyone. Only codes and counts are read or written: never words, numbers or
// chat ids, because the alert lands in a public issue.
//
// Usage: node scripts/tex-alert.mjs > report.md  (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID)
// Exit 0 with an empty report: healthy. A non-empty report: open or update the alert issue.

import { code } from "./log-codes.mjs";

/** Decide calls in the window before the unavailable share counts. */
export const MIN_DECIDES = 3;

/**
 * The problems in one window of log events (`{ event, outcome, reason }` objects).
 * Empty when healthy. Each problem is one line of codes and counts.
 */
export function problemsIn(events) {
  const problems = [];
  const decides = events.filter((e) => e.event === "group_decide");
  const down = decides.filter((e) => e.outcome === "unavailable");
  if (decides.length >= MIN_DECIDES && down.length * 2 > decides.length) {
    const causes = countBy(down, (e) => e.reason ?? "unknown");
    problems.push(`group decide unavailable on ${down.length} of ${decides.length} calls (causes: ${causes})`);
  }
  const unbound = events.filter((e) => e.event === "group_turn" && e.outcome === "untagged_ignored" && e.reason === "unbound");
  if (unbound.length > 0) problems.push(`${unbound.length} untagged group texts dropped as unbound`);
  for (const outcome of ["workflow_unavailable", "workflow_gave_up"]) {
    const hits = events.filter((e) => e.event === "group_turn" && e.outcome === outcome);
    // kind: a chat routine's run or a check-in (Dev2, 2026-10-28); a turn people asked for has none.
    const kinds = `kinds: ${countBy(hits, (e) => e.kind ?? "asked")}`;
    if (hits.length > 0) problems.push(`${hits.length} group turns: ${outcome} (${outcome === "workflow_gave_up" ? `reasons: ${countBy(hits, (e) => e.reason ?? "unknown")}; ` : ""}${kinds})`);
  }
  return problems;
}

function countBy(items, key) {
  const counts = new Map();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return [...counts].map(([name, n]) => `${code(name)} ${n}`).join(", ");
}

/** The window's events with an event code, as the Texting assistant logs workflow reads them. */
async function readEvents(minutes) {
  const to = Date.now();
  const from = to - minutes * 60_000;
  const url = `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/workers/observability/telemetry/query`;
  const out = [];
  let offset;
  for (let page = 0; page < 10; page++) {
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        queryId: "tex-alert",
        timeframe: { from, to },
        view: "events",
        limit: 500,
        ...(offset ? { offset } : {}),
        parameters: { filters: [{ key: "$metadata.service", operation: "eq", type: "string", value: "context-agent" }] },
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) throw new Error(`Observability refused the query (${response.status})`);
    const events = data.result?.events?.events ?? [];
    for (const e of events) {
      let source = e.source;
      if (typeof source === "string") try { source = JSON.parse(source); } catch { source = null; }
      if ((source === null || typeof source !== "object") && typeof e.$metadata?.message === "string") {
        try { source = JSON.parse(e.$metadata.message); } catch { source = null; }
      }
      if (source && typeof source === "object" && typeof source.event === "string") {
        out.push({ event: source.event, outcome: source.outcome, reason: source.reason, kind: source.kind });
      }
    }
    if (events.length < 500) break;
    offset = events.at(-1)?.$metadata?.id;
    if (!offset) break;
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const events = await readEvents(Number(process.env.MINUTES ?? 15));
  const problems = problemsIn(events);
  if (problems.length > 0) {
    console.log(`Tex's group path in the last ${process.env.MINUTES ?? 15} minutes (${events.length} events read):\n`);
    for (const line of problems) console.log(`- ${line}`);
  }
}
