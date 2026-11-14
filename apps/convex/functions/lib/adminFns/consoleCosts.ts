/**
 * THE STAFF CONSOLE'S AI COSTS PAGE, FROM CLOUDFLARE'S OWN COUNT.
 *
 * One batched GraphQL request to the AI gateway's analytics (and Workers AI's)
 * for the window and the window before it, each row labelled by feature,
 * client, payer and model (`consoleCostsMap.ts` says what each label means).
 * Money is US dollars at what Cloudflare billed. Staff only: `consoleAi.costs`
 * checks before calling. Counts and totals only reach the page; an error is
 * reported in our words, never with Cloudflare's body.
 *
 * Window: `[now - days, now)` and the same length before it. Buckets are UTC
 * days (`days` of them, oldest first, zero-filled) or 24 hours when `days` is 1.
 * Lab runs are shown apart and kept out of the people total.
 */

import { CLOUDFLARE_GRAPHQL_URL, USD_PER_THOUSAND_NEURONS } from "./aiCostsCloudflare";
import { MAX_STATS_DAYS, texStats, type TexStatsEnv } from "./texStats";
import { consoleCostsValidator, type ConsoleCosts } from "./consoleCostsShape";
import {
  CLOUDFLARE_PAYER,
  CREDIT_KEYS,
  FEATURES,
  LAB_FEATURES,
  PLAN_PAYER,
  TEX_STEPS,
  gatewayBucket,
  payerKeyOf,
  workersAiBucket,
  type Bucket,
  type FeatureKey,
} from "./consoleCostsMap";

export {
  CLOUDFLARE_PAYER,
  CREDIT_KEYS,
  FEATURES,
  PAYER_LABEL_SINCE,
  PLAN_PAYER,
  TEX_STEPS,
  type CreditKey,
  type FeatureKey,
  type TexStepDef,
} from "./consoleCostsMap";

export { consoleCostsValidator, type ConsoleCosts } from "./consoleCostsShape";

export const CONSOLE_DAY_CHOICES = [1, 7, 30, 90] as const;
const DEFAULT_DAYS = 30;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const TIMEOUT_MS = 20_000;
const MAX_BODY_CHARS = 8_000_000;
/** Cloudflare's group ceilings per question. */
const GATEWAY_LIMIT = 10_000;
const AI_LIMIT = 1_000;
/** How far back each dataset keeps its analytics, and the longest range one sub-query may span. */
export const GATEWAY_RETENTION_DAYS = 62;
export const WORKERS_AI_RETENTION_DAYS = 32;
export const MAX_RANGE_DAYS = 31;


export type ConsoleEnv = TexStatsEnv;

/** Our turn log's read of the window (`consoleAi.meter`). */
export interface ConsoleMeter {
  jobUsd: number;
  jobTurns: number;
  answered: number;
  truncated: boolean;
}

export interface ConsoleCostsOptions {
  fetchImpl?: typeof fetch;
  now?: number;
  /** The background jobs' spend and the answered texts from our own meter in the window. */
  meter?: ConsoleMeter;
  /** Texts people sent in a window, or null when they could not be counted. Defaults to `texStats`. */
  texCounts?: (window: { from: number; to: number }) => Promise<number | null>;
}

export function clampConsoleDays(days: unknown): number {
  return (CONSOLE_DAY_CHOICES as readonly number[]).includes(days as number) ? (days as number) : DEFAULT_DAYS;
}

/** The window and the one before it, in ms. */
export function consoleWindow(days: number, now: number) {
  const span = days * DAY_MS;
  return { days, from: now - span, to: now, priorFrom: now - 2 * span, priorTo: now - span };
}

/** The buckets, oldest first: 24 hours when `days` is 1, otherwise `days` UTC days ending today. */
export function consoleBuckets(days: number, now: number): { hourly: boolean; starts: number[] } {
  const hourly = days === 1;
  const size = hourly ? HOUR_MS : DAY_MS;
  const count = hourly ? 24 : days;
  const last = Math.floor(now / size) * size;
  return { hourly, starts: Array.from({ length: count }, (_, i) => last - (count - 1 - i) * size) };
}

const iso = (ms: number) => new Date(ms).toISOString();
const finite = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const round = (value: number) => Math.round(value * 1e6) / 1e6;

const DIM_FEATURE = 'feature:metadataValue(key:"feature")';
const DIM_CLIENT = 'client:metadataValue(key:"client")';
const DIM_PAYER = 'payer:metadataValue(key:"payer")';

/** One question the window needs, before it is fitted to what Cloudflare keeps. */
interface Logical {
  base: string;
  kind: "gw" | "ai";
  from: number;
  to: number;
  dims: string[];
}

/** One GraphQL sub-query: a chunk of a logical range, with its own alias. */
interface Sub extends Logical {
  alias: string;
}

/**
 * A range held to its dataset's retention (less one hour of slack) and cut into
 * chunks of at most MAX_RANGE_DAYS. `clamped` when its start moved to fit.
 */
function fit(range: Logical, now: number): { chunks: Array<{ from: number; to: number }>; clamped: boolean } {
  const keep = (range.kind === "gw" ? GATEWAY_RETENTION_DAYS : WORKERS_AI_RETENTION_DAYS) * DAY_MS;
  const start = Math.max(range.from, now - keep + HOUR_MS);
  const chunks: Array<{ from: number; to: number }> = [];
  for (let from = start; from < range.to; from += MAX_RANGE_DAYS * DAY_MS) {
    chunks.push({ from, to: Math.min(from + MAX_RANGE_DAYS * DAY_MS, range.to) });
  }
  return { chunks, clamped: start > range.from };
}

/** One GraphQL request carrying every sub-query, each with its own window variables. */
function buildQuery(subs: Sub[], accountId: string) {
  const declared = ["$a:String!"];
  const variables: Record<string, string> = { a: accountId };
  const fields: string[] = [];
  for (const sub of subs) {
    declared.push(`$${sub.alias}S:Time!`, `$${sub.alias}E:Time!`);
    variables[`${sub.alias}S`] = iso(sub.from);
    variables[`${sub.alias}E`] = iso(sub.to);
    const filter = `filter:{datetime_geq:$${sub.alias}S,datetime_lt:$${sub.alias}E}`;
    const field =
      sub.kind === "gw"
        ? `aiGatewayRequestsAdaptiveGroups(limit:${GATEWAY_LIMIT},${filter}){count sum{cost} dimensions{${sub.dims.join(" ")}}}`
        : `aiInferenceAdaptiveGroups(limit:${AI_LIMIT},${filter}){count sum{totalNeurons} dimensions{${sub.dims.join(" ")}}}`;
    fields.push(`${sub.alias}:${field}`);
  }
  const query = `query(${declared.join(",")}){viewer{accounts(filter:{accountTag:$a}){${fields.join("\n")}}}}`;
  return { query, variables };
}

type Row = { count?: unknown; sum?: Record<string, unknown>; dimensions?: Record<string, unknown> };
const REFUSED = "Cloudflare refused the usage query; check the token can read Analytics";

/** One question to Cloudflare: each sub-query's rows by alias, or our words for what went wrong. */
async function askCloudflare(
  fetchImpl: typeof fetch,
  token: string,
  accountId: string,
  subs: Sub[],
): Promise<Record<string, Row[]> | string> {
  const { query, variables } = buildQuery(subs, accountId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let body: unknown;
  try {
    const response = await fetchImpl(CLOUDFLARE_GRAPHQL_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
    if (!response.ok) return `Cloudflare answered ${response.status}`;
    const raw = await response.text();
    if (raw.length > MAX_BODY_CHARS) return "Cloudflare's answer was too large";
    body = JSON.parse(raw);
  } catch {
    return "Cloudflare could not be reached";
  } finally {
    clearTimeout(timer);
  }
  const root = body as { data?: { viewer?: { accounts?: Array<Record<string, unknown>> } }; errors?: unknown };
  const account = root?.data?.viewer?.accounts?.[0];
  if (!account || (Array.isArray(root.errors) && root.errors.length > 0)) return REFUSED;
  const out: Record<string, Row[]> = {};
  for (const sub of subs) {
    const rows = account[sub.alias];
    if (!Array.isArray(rows)) return REFUSED;
    out[sub.alias] = rows as Row[];
  }
  return out;
}

/**
 * The window cut at the first credit key's start, so an unlabeled call before
 * it is the plan's and one after it is a credit key's. Never grouped by time.
 */
function pieces(from: number, to: number, since: number): Array<{ from: number; to: number; beforeSince: boolean }> {
  if (since > from && since < to) {
    return [
      { from, to: since, beforeSince: true },
      { from: since, to, beforeSince: false },
    ];
  }
  return [{ from, to, beforeSince: to <= since }];
}

interface Acc {
  usd: number;
  calls: number;
  models: Map<string, number>;
}
const newAcc = (): Acc => ({ usd: 0, calls: 0, models: new Map() });
function addTo(target: Acc, model: string, usd: number, calls: number) {
  target.usd += usd;
  target.calls += calls;
  target.models.set(model, (target.models.get(model) ?? 0) + usd);
}
const modelNames = (target: Acc) => [...target.models].sort((a, b) => b[1] - a[1]).map(([name]) => name);

export async function consoleCosts(env: ConsoleEnv, days: number, options: ConsoleCostsOptions = {}): Promise<ConsoleCosts> {
  const token = env.CLOUDFLARE_ANALYTICS_TOKEN?.trim();
  const accountId = env.CLOUDFLARE_ANALYTICS_ACCOUNT_ID?.trim();
  if (!token || !accountId || !/^[0-9a-f]{32}$/.test(accountId)) return { configured: false };

  const now = options.now ?? Date.now();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const win = consoleWindow(clampConsoleDays(days), now);
  const buckets = consoleBuckets(win.days, now);
  const bucketDim = buckets.hourly ? "datetimeHour" : "date";
  const size = buckets.hourly ? HOUR_MS : DAY_MS;
  // A row from before the first bucket is dropped (-1), never clamped into bar 0.
  const bucketIndex = (ms: number) => {
    const index = Math.floor((Math.floor(ms / size) * size - buckets.starts[0]) / size);
    return index >= 0 && index < buckets.starts.length ? index : -1;
  };
  const rowTime = (dims: Record<string, unknown> | undefined) => {
    const raw = text(dims?.[bucketDim]);
    return raw ? Date.parse(buckets.hourly ? raw : `${raw}T00:00:00Z`) : NaN;
  };

  // Every credit key that is still open needs its own spend since it began.
  const open = CREDIT_KEYS.filter((credit) => !credit.spent);
  const windowPieces = pieces(win.from, win.to, Date.parse(CREDIT_KEYS[0].since));
  const logical: Logical[] = [
    ...windowPieces.map((piece, i) => ({
      base: `w${i}`,
      kind: "gw" as const,
      from: piece.from,
      to: piece.to,
      dims: [DIM_FEATURE, DIM_CLIENT, DIM_PAYER, "model", "wholesale", "statusCode", bucketDim],
    })),
    { base: "pr", kind: "gw", from: win.priorFrom, to: win.priorTo, dims: [DIM_FEATURE, DIM_CLIENT, "model"] },
    { base: "aw", kind: "ai", from: win.from, to: win.to, dims: ["modelId", bucketDim] },
    { base: "ap", kind: "ai", from: win.priorFrom, to: win.priorTo, dims: ["modelId"] },
    ...open.map((credit, i) => ({
      base: `u${i}`,
      kind: "gw" as const,
      from: Date.parse(credit.since),
      to: now,
      dims: [DIM_PAYER, "wholesale"],
    })),
  ];
  const fitted = logical.map((range) => ({ range, ...fit(range, now) }));
  const subs: Sub[] = fitted.flatMap(({ range, chunks }) =>
    chunks.map((chunk, k) => ({ ...range, alias: `${range.base}_${k}`, from: chunk.from, to: chunk.to })),
  );
  const fittedOf = (base: string) => fitted.find((f) => f.range.base === base)!;
  const windowStarts = fitted.filter((f) => /^w\d+$/.test(f.range.base)).flatMap((f) => f.chunks.map((c) => c.from));
  const coverageFrom = windowStarts.length > 0 ? Math.min(...windowStarts) : win.to;
  const priorPartial = fittedOf("pr").clamped || fittedOf("ap").clamped;

  const answer = await askCloudflare(fetchImpl, token, accountId, subs);
  if (typeof answer === "string") {
    return {
      configured: true, error: answer, days: win.days, from: win.from, to: win.to, totalUsd: 0, priorUsd: 0,
      labRunsUsd: 0, billedUsd: 0, outOfPocketUsd: 0, outOfPocketPeopleUsd: 0, texts: null, perTextUsd: null,
      priorPerTextUsd: null, devDaysLeft: null, payers: [], features: [], daily: [], texUsd: 0, texSteps: [],
      coverageFrom, priorPartial, answered: null, meterTruncated: false,
    };
  }

  const rowsOf = (base: string): Row[] => subs.filter((s) => s.base === base).flatMap((s) => answer[s.alias] ?? []);
  const payerUsd = new Map<string, number>();
  const payerAdd = (key: string, usd: number) => payerUsd.set(key, (payerUsd.get(key) ?? 0) + usd);
  let outOfPocketUsd = 0;
  let outOfPocketPeopleUsd = 0;
  let labRunsUsd = 0;
  const features = new Map<FeatureKey, Acc>(FEATURES.map((f) => [f.key, newAcc()]));
  const steps = new Map(TEX_STEPS.map((s) => [s.id, { usd: 0, calls: 0 }]));
  const daily = buckets.starts.map(() => new Map<FeatureKey, number>());

  const place = (bucket: Bucket, model: string, usd: number, calls: number, at: number) => {
    if (bucket.kind === "lab") return;
    const key: FeatureKey = bucket.kind === "tex" ? "tex" : bucket.key;
    addTo(features.get(key)!, model, usd, calls);
    if (bucket.kind === "tex") {
      const step = steps.get(bucket.step);
      if (step) {
        step.usd += usd;
        step.calls += calls;
      }
    }
    const index = Number.isFinite(at) ? bucketIndex(at) : -1;
    if (index >= 0) daily[index].set(key, (daily[index].get(key) ?? 0) + usd);
  };

  // The window: gateway rows, each one's payer, and the Workers AI rows.
  windowPieces.forEach((piece, i) => {
    for (const row of rowsOf(`w${i}`)) {
      const dims = row.dimensions ?? {};
      const feature = text(dims.feature);
      const client = text(dims.client);
      const model = text(dims.model) || "unknown";
      const wholesale = Number(dims.wholesale) === 1;
      const ok = Number(dims.statusCode) === 200;
      const usd = finite(row.sum?.cost);
      // A refused attempt costs nothing and is not a call.
      const calls = ok ? Math.round(finite(row.count)) : 0;
      payerAdd(payerKeyOf(text(dims.payer), wholesale, piece.beforeSince), usd);
      if (wholesale) {
        outOfPocketUsd += usd;
        if (!LAB_FEATURES.has(feature)) outOfPocketPeopleUsd += usd;
      }
      const bucket = gatewayBucket(feature, client, model);
      if (bucket.kind === "lab") labRunsUsd += usd;
      place(bucket, model, usd, calls, rowTime(dims));
    }
  });
  for (const row of rowsOf("aw")) {
    const dims = row.dimensions ?? {};
    const model = text(dims.modelId) || "unknown";
    const usd = (finite(row.sum?.totalNeurons) / 1000) * USD_PER_THOUSAND_NEURONS;
    // Cloudflare bills Workers AI directly: it is out of pocket, and all of it is people's.
    payerAdd(CLOUDFLARE_PAYER.key, usd);
    outOfPocketUsd += usd;
    outOfPocketPeopleUsd += usd;
    place(workersAiBucket(model), model, usd, Math.round(finite(row.count)), rowTime(dims));
  }

  // The window before: totals only, the test suites kept out.
  let priorUsd = 0;
  let priorTexUsd = 0;
  for (const row of rowsOf("pr")) {
    const dims = row.dimensions ?? {};
    const bucket = gatewayBucket(text(dims.feature), text(dims.client), text(dims.model) || "unknown");
    if (bucket.kind === "lab") continue;
    const usd = finite(row.sum?.cost);
    priorUsd += usd;
    if (bucket.kind === "tex") priorTexUsd += usd;
  }
  for (const row of rowsOf("ap")) {
    const bucket = workersAiBucket(text(row.dimensions?.modelId));
    const usd = (finite(row.sum?.totalNeurons) / 1000) * USD_PER_THOUSAND_NEURONS;
    priorUsd += usd;
    if (bucket.kind === "tex") priorTexUsd += usd;
  }

  // What each open credit key has spent since it began.
  const usedBy = new Map<string, number>();
  open.forEach((credit, i) => {
    let used = 0;
    for (const row of rowsOf(`u${i}`)) {
      const dims = row.dimensions ?? {};
      if (payerKeyOf(text(dims.payer), Number(dims.wholesale) === 1, false) === credit.key) used += finite(row.sum?.cost);
    }
    usedBy.set(credit.key, used);
  });

  // Background jobs come out of the front door's cost, never more than it.
  const meter = options.meter;
  const front = steps.get("fd")!;
  const job = steps.get("job")!;
  const movedUsd = Math.min(finite(meter?.jobUsd), front.usd);
  front.usd -= movedUsd;
  job.usd += movedUsd;
  const movedCalls = Math.min(Math.max(0, Math.round(meter?.jobTurns ?? 0)), front.calls);
  front.calls -= movedCalls;
  job.calls += movedCalls;

  let totalUsd = 0;
  for (const f of features.values()) totalUsd += f.usd;
  const texUsd = features.get("tex")!.usd;
  const texCounts = options.texCounts ?? defaultTexCounts(env, fetchImpl);
  // The texts are counted for at most MAX_STATS_DAYS back, so a prior window that starts before that is not counted.
  const priorTextsKnown = win.priorFrom >= now - MAX_STATS_DAYS * DAY_MS;
  const [texts, priorTexts] = await Promise.all([
    texCounts({ from: win.from, to: win.to }),
    priorTextsKnown ? texCounts({ from: win.priorFrom, to: win.priorTo }) : null,
  ]);
  const perText = (usd: number, count: number | null) => (count !== null && count > 0 ? usd / count : null);

  const payerRow = (key: string, label: string, note: string | null, capUsd: number | null, usedUsd: number | null) => {
    const leftUsd = capUsd !== null && usedUsd !== null ? Math.max(0, capUsd - usedUsd) : null;
    return {
      key,
      label,
      usd: round(payerUsd.get(key) ?? 0),
      capUsd,
      usedUsd: usedUsd === null ? null : round(usedUsd),
      leftUsd: leftUsd === null ? null : round(leftUsd),
      note,
    };
  };
  const payers = CREDIT_KEYS.map((credit) => {
    const used = credit.spent ? credit.capUsd : (usedBy.get(credit.key) ?? 0);
    return payerRow(credit.key, credit.label, credit.spent ? "Spent" : null, credit.capUsd, used);
  });
  payers.push(payerRow(PLAN_PAYER.key, PLAN_PAYER.label, PLAN_PAYER.note, null, null));
  payers.push(payerRow(CLOUDFLARE_PAYER.key, CLOUDFLARE_PAYER.label, CLOUDFLARE_PAYER.note, null, null));
  if ((payerUsd.get("unknown") ?? 0) > 0) payers.push(payerRow("unknown", "Other payer", null, null, null));

  // The dev key only began paying at its `since`: its pace is over the shorter of the window and its life so far.
  const dev = payers.find((p) => p.key === CREDIT_KEYS[0].key);
  const paceDays = Math.max(Math.min(win.days, (now - Date.parse(CREDIT_KEYS[0].since)) / DAY_MS), 1 / 24);
  const devDaysLeft = dev && dev.leftUsd !== null && dev.usd > 0 ? Math.round(dev.leftUsd / (dev.usd / paceDays)) : null;

  return {
    configured: true,
    error: null,
    days: win.days,
    from: win.from,
    to: win.to,
    totalUsd: round(totalUsd),
    priorUsd: round(priorUsd),
    labRunsUsd: round(labRunsUsd),
    billedUsd: round(totalUsd + labRunsUsd),
    outOfPocketUsd: round(outOfPocketUsd),
    outOfPocketPeopleUsd: round(outOfPocketPeopleUsd),
    texts,
    coverageFrom,
    priorPartial,
    answered: meter ? meter.answered : null,
    meterTruncated: meter?.truncated ?? false,
    perTextUsd: perText(texUsd, texts),
    priorPerTextUsd: perText(priorTexUsd, priorTexts),
    devDaysLeft,
    payers,
    features: FEATURES.map((f) => {
      const a = features.get(f.key)!;
      return {
        key: f.key,
        label: f.label,
        models: modelNames(a),
        usd: round(a.usd),
        share: totalUsd > 0 ? a.usd / totalUsd : 0,
      };
    }),
    daily: buckets.starts.map((at, i) => ({
      label: buckets.hourly ? iso(at).slice(0, 16).replace("T", " ") : iso(at).slice(0, 10),
      byFeature: [...daily[i]].filter(([, usd]) => usd > 0).map(([key, usd]) => ({ key, usd: round(usd) })),
    })),
    texUsd: round(texUsd),
    texSteps: TEX_STEPS.map((s) => {
      const st = steps.get(s.id)!;
      return {
        id: s.id,
        label: s.label,
        model: s.model,
        on: s.on,
        calls: st.calls,
        usd: round(st.usd),
        share: texUsd > 0 ? st.usd / texUsd : 0,
      };
    }).sort((a, b) => b.usd - a.usd),
  };
}

/** Texts people sent Tex, from the same window's basics; null when they could not be counted. */
function defaultTexCounts(env: ConsoleEnv, fetchImpl: typeof fetch) {
  return async (window: { from: number; to: number }): Promise<number | null> => {
    try {
      const stats = await texStats(env, window, { fetchImpl });
      if (!stats.configured || stats.errors.texts !== null) return null;
      return stats.texts.inOne + stats.texts.inGroup;
    } catch {
      return null;
    }
  };
}
