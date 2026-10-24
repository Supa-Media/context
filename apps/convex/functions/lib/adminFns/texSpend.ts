/**
 * WHAT TEX ACTUALLY COST, AS CLOUDFLARE COUNTED IT (tex.lc/admin).
 *
 * Every model call Tex makes goes through our AI gateway (`apps/mcp/src/agent/
 * aiGateway.js`) with a `cf-aig-metadata` label naming the feature and the job
 * (`feature: "assistant", client: "texts"`, and so on). The gateway prices each
 * call itself, cache reads and writes at their own rates, and its analytics
 * keep that cost per day, model and label even though the call's words are
 * never logged (`cf-aig-collect-log: false`). This reads those figures for the
 * window, so the dashboard shows what Tex cost rather than our own estimate
 * from token counts (the owner, 2026-10-24: "wire in actual pricing through
 * cloudflare ai gateway, because ... cached tokens are way cheaper").
 *
 * Grouped by day, model, feature and job only: the workspace label is never
 * asked for. Same token and account as the AI costs tab
 * (`aiCostsCloudflare.ts`), which is the whole Cloudflare account, so staging's
 * Tex is in here too. Errors are our words, never Cloudflare's body.
 *
 * Cloudflare answers at most about a month per question and keeps about two
 * months, so a 90-day window is asked in 30-day pieces and starts at the
 * oldest day it still holds (`keptFrom`); the page leaves earlier days blank
 * rather than drawing them as free.
 */

import { v, type Infer } from "convex/values";
import { CLOUDFLARE_GRAPHQL_URL, windowStart, type CloudflareEnv } from "./aiCostsCloudflare";

const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const DAY_MS = 86_400_000;
const TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 512_000;
/** The widest span one question may cover, and how far back Cloudflare keeps these figures (both with a margin). */
const SPAN_DAYS = 30;
const KEPT_DAYS = 60;

/** The gateway labels that are Tex's own work; `benchmark` is the test suites, counted apart. */
const TEX_FEATURES = new Set(["assistant", "image", "self-review", "handback-judge", "handback-miner", "egress-judge", "mail-checker"]);
const TESTS = "benchmark";

const QUERY = `query($a:String!,$s:Time!,$e:Time!){viewer{accounts(filter:{accountTag:$a}){
gw:aiGatewayRequestsAdaptiveGroups(limit:5000,filter:{datetime_geq:$s,datetime_lt:$e}){count sum{cost freshInputTokens cacheReadTokens cacheWriteTokens tokensOut} dimensions{date model feature:metadataValue(key:"feature") job:metadataValue(key:"client")}}
}}}`;

export const texSpendValidator = v.union(
  v.object({ configured: v.literal(false) }),
  v.object({
    configured: v.literal(true),
    error: v.union(v.string(), v.null()),
    /** Tex's cost in the window, in US dollars, as the gateway priced it. */
    totalUsd: v.number(),
    /** The test suites' cost in the same window, kept out of the total. */
    testsUsd: v.number(),
    /** The first day Cloudflare still holds; days before it are unknown, not free. */
    keptFrom: v.string(),
    /** One entry per day of the window, oldest first, `YYYY-MM-DD` in UTC. */
    days: v.array(v.object({ day: v.string(), usd: v.number(), requests: v.number() })),
    models: v.array(
      v.object({
        model: v.string(),
        requests: v.number(),
        usd: v.number(),
        freshInputTokens: v.number(),
        cacheReadTokens: v.number(),
        cacheWriteTokens: v.number(),
        outputTokens: v.number(),
      }),
    ),
    /** What the money went on: texts, group texts, check-ins, housekeeping, dreams, judges. */
    jobs: v.array(v.object({ job: v.string(), usd: v.number(), requests: v.number() })),
  }),
);
export type TexSpend = Infer<typeof texSpendValidator>;

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function label(value: unknown): string | null {
  return typeof value === "string" && /^[\w.:-]{1,64}$/.test(value) ? value : null;
}

/** The job a call was for: the assistant's own client label, or the feature itself. */
function jobOf(feature: string, job: string | null): string {
  if (feature === "assistant") return job ?? "texts";
  return feature;
}

/** Every day of the window, oldest first, as `YYYY-MM-DD`. */
export function windowDays(days: number, now: number): string[] {
  const start = Date.parse(windowStart(days, now));
  return Array.from({ length: days }, (_, i) => new Date(start + i * DAY_MS).toISOString().slice(0, 10));
}

export async function texSpend(env: CloudflareEnv, days: number, options: { fetchImpl?: typeof fetch; now?: number } = {}): Promise<TexSpend> {
  const token = env.CLOUDFLARE_ANALYTICS_TOKEN?.trim();
  const accountId = env.CLOUDFLARE_ANALYTICS_ACCOUNT_ID?.trim();
  if (!token || !accountId || !ACCOUNT_ID.test(accountId)) return { configured: false };

  const now = options.now ?? Date.now();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const dayList = windowDays(days, now);
  const kept = windowDays(Math.min(days, KEPT_DAYS), now);
  const failed = (error: string): TexSpend => ({
    configured: true,
    error,
    totalUsd: 0,
    testsUsd: 0,
    keptFrom: kept[0],
    days: dayList.map((day) => ({ day, usd: 0, requests: 0 })),
    models: [],
    jobs: [],
  });

  const groups: unknown[] = [];
  for (let i = 0; i < kept.length; i += SPAN_DAYS) {
    const from = Date.parse(`${kept[i]}T00:00:00Z`);
    const to = i + SPAN_DAYS < kept.length ? Date.parse(`${kept[i + SPAN_DAYS]}T00:00:00Z`) : now + DAY_MS;
    const answer = await ask(fetchImpl, token, accountId, new Date(from).toISOString(), new Date(to).toISOString());
    if (typeof answer === "string") return failed(answer);
    groups.push(...answer);
  }

  const byDay = new Map(dayList.map((day) => [day, { usd: 0, requests: 0 }]));
  const models = new Map<string, { requests: number; usd: number; freshInputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; outputTokens: number }>();
  const jobs = new Map<string, { usd: number; requests: number }>();
  let testsUsd = 0;
  for (const group of groups as Array<{ count?: unknown; sum?: Record<string, unknown>; dimensions?: Record<string, unknown> }>) {
    const feature = label(group?.dimensions?.feature);
    const usd = finite(group?.sum?.cost);
    const requests = Math.round(finite(group?.count));
    if (feature === TESTS) {
      testsUsd += usd;
      continue;
    }
    if (feature === null || !TEX_FEATURES.has(feature)) continue;
    const day = byDay.get(String(group?.dimensions?.date));
    if (day) {
      day.usd += usd;
      day.requests += requests;
    }
    const model = label(group?.dimensions?.model) ?? "unknown";
    const m = models.get(model) ?? { requests: 0, usd: 0, freshInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
    m.requests += requests;
    m.usd += usd;
    m.freshInputTokens += finite(group?.sum?.freshInputTokens);
    m.cacheReadTokens += finite(group?.sum?.cacheReadTokens);
    m.cacheWriteTokens += finite(group?.sum?.cacheWriteTokens);
    m.outputTokens += finite(group?.sum?.tokensOut);
    models.set(model, m);
    const job = jobOf(feature, label(group?.dimensions?.job));
    const j = jobs.get(job) ?? { usd: 0, requests: 0 };
    j.usd += usd;
    j.requests += requests;
    jobs.set(job, j);
  }
  const daysOut = dayList.map((day) => ({ day, ...byDay.get(day)! }));
  return {
    configured: true,
    error: null,
    keptFrom: kept[0],
    totalUsd: daysOut.reduce((sum, day) => sum + day.usd, 0),
    testsUsd,
    days: daysOut,
    models: [...models].map(([model, m]) => ({ model, ...m })).sort((a, b) => b.usd - a.usd),
    jobs: [...jobs].map(([job, j]) => ({ job, ...j })).sort((a, b) => b.usd - a.usd),
  };
}

/** One question to Cloudflare: the groups, or what went wrong in our words. */
async function ask(fetchImpl: typeof fetch, token: string, accountId: string, from: string, to: string): Promise<unknown[] | string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let body: unknown;
  try {
    const response = await fetchImpl(CLOUDFLARE_GRAPHQL_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: QUERY, variables: { a: accountId, s: from, e: to } }),
      signal: controller.signal,
    });
    if (!response.ok) return `Cloudflare answered ${response.status}`;
    const text = await response.text();
    if (text.length > MAX_BODY_BYTES) return "Cloudflare's answer was too large";
    body = JSON.parse(text);
  } catch {
    return "Cloudflare could not be reached";
  } finally {
    clearTimeout(timer);
  }
  const root = body as { data?: { viewer?: { accounts?: Array<{ gw?: unknown }> } }; errors?: unknown };
  const account = root?.data?.viewer?.accounts?.[0];
  if (!account || (Array.isArray(root.errors) && root.errors.length > 0)) return "Cloudflare refused the usage query; check the token can read Analytics";
  return Array.isArray(account.gw) ? account.gw : [];
}
