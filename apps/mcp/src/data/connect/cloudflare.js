/**
 * Cloudflare, connected with an API token that can read the account's analytics. Its dataset is `ai-spend.csv`:
 * one row per day, AI Gateway, provider and model, with requests, tokens and what Cloudflare counted it cost in
 * US dollars (AI Gateway's own `cost`).
 *
 * The account is bound at connect: the one account the token reaches, or the one the owner named when it reaches
 * several. Editing the source's about.md never points it at another account. Cloudflare answers at most about a
 * month per query, so a run reads the last 30 days, and the sheet keeps its 400 like any other.
 */

import { appJson } from "./appFetch.js";

const API = "https://api.cloudflare.com/client/v4";
const NAME = "Cloudflare";
const TOKEN = /^[A-Za-z0-9_-]{30,120}$/;
const ACCOUNT = /^[0-9a-f]{32}$/;
/** Cloudflare's analytics refuse a range wider than about a month. */
export const CLOUDFLARE_DAYS = 30;
const DAY_MS = 86_400_000;
const MAX_GROUPS = 10_000;

export const CLOUDFLARE_SOURCE = Object.freeze({
  app: "cloudflare",
  name: NAME,
  dataset: "ai-spend",
  key: "id",
  date: "date",
  columns: Object.freeze([
    { name: "id", type: "text" },
    { name: "date", type: "date" },
    { name: "gateway", type: "text" },
    { name: "provider", type: "text" },
    { name: "model", type: "text" },
    { name: "requests", type: "number" },
    { name: "tokens_in", type: "number" },
    { name: "tokens_out", type: "number" },
    { name: "usd", type: "number" },
  ]),
});

const auth = (token) => ({ authorization: `Bearer ${token}` });

/**
 * What the owner pasted, checked with Cloudflare: the token is live, and it reaches the account to read (the one it
 * reaches, or the one named). `{ok: true, kept: {token, account}}` or `{ok: false, said}`.
 */
export async function checkCloudflareToken(input, fetcher) {
  const token = typeof input?.key === "string" ? input.key.trim() : "";
  const named = typeof input?.account === "string" ? input.account.trim().toLowerCase() : "";
  if (!TOKEN.test(token)) return { ok: false, said: "That isn't a Cloudflare API token" };
  if (named !== "" && !ACCOUNT.test(named)) return { ok: false, said: "That isn't a Cloudflare account ID; it's 32 letters and digits, on the account's overview page" };
  const verified = await appJson(fetcher, `${API}/user/tokens/verify`, { headers: auth(token) }, NAME);
  if (!verified.ok || verified.body?.result?.status !== "active") return { ok: false, said: verified.ok ? "Cloudflare says that token isn't active" : "Cloudflare refused the token" };
  const listed = await appJson(fetcher, `${API}/accounts?per_page=50`, { headers: auth(token) }, NAME);
  if (!listed.ok) return { ok: false, said: "Cloudflare didn't list an account for that token; give it Account Analytics read" };
  const accounts = (Array.isArray(listed.body?.result) ? listed.body.result : []).map((each) => String(each?.id ?? "")).filter((id) => ACCOUNT.test(id));
  let account;
  if (named !== "") {
    if (!accounts.includes(named)) return { ok: false, said: "That token can't reach the account you named" };
    account = named;
  } else if (accounts.length === 1) {
    account = accounts[0];
  } else {
    return { ok: false, said: accounts.length === 0 ? "That token reaches no Cloudflare account" : `That token reaches ${accounts.length} accounts; add the account ID to read` };
  }
  const tried = await queryAiSpend({ token, account, from: new Date(Date.now() - DAY_MS).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10), fetcher });
  if (!tried.ok) return { ok: false, said: "Cloudflare didn't let that token read AI Gateway analytics; give it Account Analytics read" };
  return { ok: true, kept: { key: token, account } };
}

const QUERY = `query AiSpend($account: string!, $from: Date!, $to: Date!, $limit: uint64!) {
  viewer { accounts(filter: {accountTag: $account}) {
    aiGatewayRequestsAdaptiveGroups(limit: $limit, filter: {date_geq: $from, date_leq: $to}, orderBy: [date_ASC]) {
      count sum { cost tokensIn tokensOut } dimensions { date gateway provider model }
    }
  } }
}`;

async function queryAiSpend({ token, account, from, to, fetcher }) {
  const answered = await appJson(
    fetcher,
    `${API}/graphql`,
    { method: "POST", headers: { ...auth(token), "content-type": "application/json" }, body: JSON.stringify({ query: QUERY, variables: { account, from, to, limit: MAX_GROUPS } }) },
    NAME,
  );
  if (!answered.ok) return { ok: false, said: answered.said, refused: answered.status === 401 || answered.status === 403 };
  if (Array.isArray(answered.body?.errors) && answered.body.errors.length > 0) return { ok: false, said: "Cloudflare refused the analytics query", refused: true };
  const groups = answered.body?.data?.viewer?.accounts?.[0]?.aiGatewayRequestsAdaptiveGroups;
  if (!Array.isArray(groups)) return { ok: false, said: "Cloudflare's answer had no AI Gateway analytics", refused: true };
  return { ok: true, groups };
}

const clip = (value) => String(value ?? "").slice(0, 120);
const number = (value) => (Number.isFinite(Number(value)) ? String(Number(value)) : "");

/** One analytics group as a row: keyed by its day, gateway, provider and model, so a later run updates that day. */
export function cloudflareRow(group) {
  const d = group?.dimensions ?? {};
  const date = typeof d.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.date) ? d.date : null;
  if (date === null) return null;
  const gateway = clip(d.gateway);
  const provider = clip(d.provider);
  const model = clip(d.model);
  return {
    id: `${date} ${gateway} ${provider} ${model}`,
    date,
    gateway,
    provider,
    model,
    requests: number(group.count),
    tokens_in: number(group.sum?.tokensIn),
    tokens_out: number(group.sum?.tokensOut),
    usd: number(group.sum?.cost),
  };
}

/** The last `CLOUDFLARE_DAYS` of AI spend: `{ok: true, rows, more: false}` or `{ok: false, said, refused}`. */
export async function fetchCloudflareRows({ kept, now, fetcher }) {
  const to = new Date(now).toISOString().slice(0, 10);
  const from = new Date(now - (CLOUDFLARE_DAYS - 1) * DAY_MS).toISOString().slice(0, 10);
  const got = await queryAiSpend({ token: kept.key, account: kept.account, from, to, fetcher });
  if (!got.ok) return got;
  return { ok: true, rows: got.groups.map(cloudflareRow).filter((row) => row !== null), more: got.groups.length >= MAX_GROUPS };
}
