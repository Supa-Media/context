/**
 * THE AI COSTS TAB'S CHECK AGAINST CLOUDFLARE'S OWN COUNT.
 *
 * Our meter prices each use at list from token counts we are told; Cloudflare
 * counts what it actually ran. This asks Cloudflare's analytics API for the
 * same window, so the tab can say whether the two agree, and can show the two
 * things our meter does not see at all: meeting transcription (Whisper) and
 * search by meaning (bge-m3).
 *
 * It needs a read-only analytics token, `CLOUDFLARE_ANALYTICS_TOKEN`, and the
 * account it reads, `CLOUDFLARE_ANALYTICS_ACCOUNT_ID`, in the Convex
 * environment. Without them the answer is `{ configured: false }` and the tab
 * says the check isn't connected. The token can read usage numbers and nothing
 * else; it never leaves this file, and an error is reported in our words, never
 * with Cloudflare's body, which could echo the request.
 *
 * The account is the whole Cloudflare account, staging included, so its count
 * runs a little above production's meter. Workers AI is priced at the
 * published $0.011 per 1,000 neurons, before the daily free allowance.
 */

import type { AiCostsCloudflare } from "./aiCostsShape";

export const CLOUDFLARE_GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
export const USD_PER_THOUSAND_NEURONS = 0.011;

const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const DAY_MS = 86_400_000;
const TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 256_000;

const QUERY = `query($a:String!,$s:Time!,$e:Time!){viewer{accounts(filter:{accountTag:$a}){
ai:aiInferenceAdaptiveGroups(limit:100,filter:{datetime_geq:$s,datetime_lt:$e}){sum{totalNeurons} dimensions{modelId}}
gw:aiGatewayRequestsAdaptiveGroups(limit:100,filter:{datetime_geq:$s,datetime_lt:$e}){count sum{cost} dimensions{model provider}}
}}}`;

export interface CloudflareEnv {
  CLOUDFLARE_ANALYTICS_TOKEN?: string;
  CLOUDFLARE_ANALYTICS_ACCOUNT_ID?: string;
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function name(value: unknown): string | null {
  return typeof value === "string" && /^[\w@./:-]{1,128}$/.test(value) ? value : null;
}

/** The window's first instant: midnight UTC, `days - 1` days before today. */
export function windowStart(days: number, now: number): string {
  const today = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  return new Date(today - (days - 1) * DAY_MS).toISOString();
}

export async function cloudflareCheck(
  env: CloudflareEnv,
  days: number,
  options: { fetchImpl?: typeof fetch; now?: number } = {},
): Promise<AiCostsCloudflare> {
  const token = env.CLOUDFLARE_ANALYTICS_TOKEN?.trim();
  const accountId = env.CLOUDFLARE_ANALYTICS_ACCOUNT_ID?.trim();
  if (!token || !accountId || !ACCOUNT_ID.test(accountId)) return { configured: false };

  const now = options.now ?? Date.now();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const failed = (error: string): AiCostsCloudflare => ({ configured: true, error, billedUsd: 0, workersAi: [], gateway: [] });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let body: unknown;
  try {
    const response = await fetchImpl(CLOUDFLARE_GRAPHQL_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: QUERY,
        variables: { a: accountId, s: windowStart(days, now), e: new Date(now + DAY_MS).toISOString() },
      }),
      signal: controller.signal,
    });
    if (!response.ok) return failed(`Cloudflare answered ${response.status}`);
    const text = await response.text();
    if (text.length > MAX_BODY_BYTES) return failed("Cloudflare's answer was too large");
    body = JSON.parse(text);
  } catch {
    return failed("Cloudflare could not be reached");
  } finally {
    clearTimeout(timer);
  }

  const root = body as { data?: { viewer?: { accounts?: Array<{ ai?: unknown; gw?: unknown }> } }; errors?: unknown };
  const account = root?.data?.viewer?.accounts?.[0];
  if (!account || (Array.isArray(root.errors) && root.errors.length > 0)) {
    return failed("Cloudflare refused the usage query; check the token can read Analytics");
  }

  const byModel = new Map<string, number>();
  for (const group of Array.isArray(account.ai) ? account.ai : []) {
    const model = name(group?.dimensions?.modelId);
    if (model) byModel.set(model, (byModel.get(model) ?? 0) + finite(group?.sum?.totalNeurons));
  }
  const workersAi = [...byModel]
    .map(([model, neurons]) => ({ model, neurons: Math.round(neurons), usd: (neurons / 1000) * USD_PER_THOUSAND_NEURONS }))
    .sort((a, b) => b.usd - a.usd);

  const gateway = (Array.isArray(account.gw) ? account.gw : [])
    .map((group: { count?: unknown; sum?: { cost?: unknown }; dimensions?: { model?: unknown; provider?: unknown } }) => ({
      model: name(group?.dimensions?.model) ?? "unknown",
      provider: name(group?.dimensions?.provider) ?? "unknown",
      requests: Math.round(finite(group?.count)),
      costUsd: finite(group?.sum?.cost),
    }))
    .sort((a: { costUsd: number }, b: { costUsd: number }) => b.costUsd - a.costUsd);

  const billedUsd =
    workersAi.reduce((sum, row) => sum + row.usd, 0) + gateway.reduce((sum: number, row: { costUsd: number }) => sum + row.costUsd, 0);
  return { configured: true, error: null, billedUsd, workersAi, gateway };
}
