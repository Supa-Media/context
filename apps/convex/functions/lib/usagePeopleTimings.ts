/**
 * The Context usage source's two timing lists, read from Workers Analytics Engine with the account's SQL API (the
 * staff stats' `CLOUDFLARE_ANALYTICS_TOKEN`), so nothing new is recorded for them and the last 90 days are there
 * on the first run:
 *
 * - **calls**: one row per sampled MCP tool call the gateway answered (`mcp_entry`, `to_response` points of
 *   `tools/call:<tool>`, `apps/mcp/src/mcp/mcpEntryPoint.js`): its time, the tool, its milliseconds, whether it
 *   answered ok, the client's product name, and the sample weight Analytics Engine gave it.
 * - **replies**: one row per text Tex answered (`tex_text_timing`, `packages/tex/worker/textTiming.ts`): its time,
 *   "one" or "group", and the seconds from the text arriving to the first bubble out.
 *
 * No workspace, no person, no path, no word: those points never held one.
 */

type Fetcher = typeof fetch;
type Row = Record<string, unknown>;

const TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 8_000_000;
/** The most rows of each list one export reads: the calls sheet keeps 14 days, well under a sheet's 50,000 rows. */
export const MAX_TIMING_ROWS = 40_000;
/** A tool name as the gateway writes it after `tools/call:`: `write:remember`, `search`. */
const TOOL = /^[a-z][a-z0-9_]{0,63}(?::[a-z][a-z0-9_]{0,63})?$/;
const CLIENT = /^[A-Za-z0-9 ._-]{0,40}$/;

export interface TimingsEnv {
  CLOUDFLARE_ANALYTICS_TOKEN?: string;
  CLOUDFLARE_ANALYTICS_ACCOUNT_ID?: string;
  APP_ENV?: string;
}

export interface UsageTimings {
  calls: { at: number; tool: string; ms: number; ok: boolean; client: string; weight: number }[];
  replies: { at: number; kind: "one" | "group"; seconds: number }[];
  /** A sentence when a list could not be read; the run keeps what the sheet already has. */
  error: string | null;
}

/** This deployment's dataset names: staging's Workers write to `_staging` twins. */
export function timingDatasets(env: TimingsEnv): { calls: string; replies: string } {
  const suffix = env.APP_ENV?.trim().toLowerCase() === "staging" ? "_staging" : "";
  return { calls: `mcp_entry${suffix}`, replies: `tex_text_timing${suffix}` };
}

/** Analytics Engine's `2026-11-10 13:00:00` (UTC) as ms. */
function slotMs(value: unknown): number {
  if (typeof value !== "string") return Number.NaN;
  return Date.parse(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
}

/** The two queries, from `since` (ms, whole seconds). The interval is built from a number, never from text. */
export function timingQueries(names: { calls: string; replies: string }, since: number): { calls: string; replies: string } {
  const from = Math.floor(Math.max(0, since) / 1000);
  return {
    calls:
      `SELECT timestamp, blob2 AS call, blob4 AS state, blob5 AS client, double1 AS ms, _sample_interval AS weight FROM ${names.calls} ` +
      `WHERE blob1 = 'mcp' AND blob3 = 'to_response' AND startsWith(blob2, 'tools/call:') AND timestamp >= toDateTime(${from}) ` +
      `ORDER BY timestamp LIMIT ${MAX_TIMING_ROWS}`,
    replies:
      `SELECT timestamp, blob1 AS kind, double5 AS first FROM ${names.replies} ` +
      `WHERE timestamp >= toDateTime(${from}) AND double5 >= 0 ORDER BY timestamp LIMIT ${MAX_TIMING_ROWS}`,
  };
}

async function sql(fetchImpl: Fetcher, token: string, accountId: string, query: string): Promise<Row[] | string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: query,
      signal: controller.signal,
    });
    if (!response.ok) return `Cloudflare answered ${response.status}`;
    const text = await response.text();
    if (text.length > MAX_BODY_BYTES) return "Cloudflare's answer was too large";
    const data = (JSON.parse(text) as { data?: unknown })?.data;
    return Array.isArray(data) ? (data as Row[]) : "Analytics Engine answered in a shape we don't know";
  } catch {
    return "Cloudflare could not be reached";
  } finally {
    clearTimeout(timer);
  }
}

const number = (value: unknown) => (typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN);

/** Rows → the calls list: anything not shaped as the gateway writes it is dropped, never passed on. */
export function callsOf(rows: Row[]): UsageTimings["calls"] {
  const out: UsageTimings["calls"] = [];
  for (const row of rows) {
    const at = slotMs(row.timestamp);
    const call = typeof row.call === "string" ? row.call.slice("tools/call:".length) : "";
    const ms = number(row.ms);
    const weight = number(row.weight);
    const client = typeof row.client === "string" && CLIENT.test(row.client) ? row.client : "";
    if (!Number.isFinite(at) || !TOOL.test(call) || !Number.isFinite(ms) || ms < 0) continue;
    out.push({ at, tool: call, ms: Math.round(ms), ok: row.state === "ok", client, weight: Number.isFinite(weight) && weight >= 1 ? Math.round(weight) : 1 });
  }
  return out;
}

/** Rows → the replies list. */
export function repliesOf(rows: Row[]): UsageTimings["replies"] {
  const out: UsageTimings["replies"] = [];
  for (const row of rows) {
    const at = slotMs(row.timestamp);
    const first = number(row.first);
    if (!Number.isFinite(at) || !Number.isFinite(first) || first < 0 || (row.kind !== "one" && row.kind !== "group")) continue;
    out.push({ at, kind: row.kind, seconds: Math.round(first / 100) / 10 });
  }
  return out;
}

/** Both lists since `since`. Without the token (self-hosting) both are empty, with a sentence saying why. */
export async function usageTimings(env: TimingsEnv, since: number, fetchImpl: Fetcher = fetch): Promise<UsageTimings> {
  const token = env.CLOUDFLARE_ANALYTICS_TOKEN?.trim();
  const accountId = env.CLOUDFLARE_ANALYTICS_ACCOUNT_ID?.trim();
  if (!token || !accountId || !/^[0-9a-f]{32}$/.test(accountId)) {
    return { calls: [], replies: [], error: "This deployment has no Cloudflare analytics token, so calls and Tex replies aren't read" };
  }
  const queries = timingQueries(timingDatasets(env), since);
  const [calls, replies] = await Promise.all([sql(fetchImpl, token, accountId, queries.calls), sql(fetchImpl, token, accountId, queries.replies)]);
  const error = typeof calls === "string" ? calls : typeof replies === "string" ? replies : null;
  return { calls: typeof calls === "string" ? [] : callsOf(calls), replies: typeof replies === "string" ? [] : repliesOf(replies), error };
}
