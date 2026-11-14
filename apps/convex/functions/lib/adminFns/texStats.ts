/**
 * TEX'S BASICS FOR ANY WINDOW (tex.lc/admin, Dev2 2026-11-10: "DAUs, Tex
 * messages sent and received, average cost per text, total costs (ai
 * inference), notes created/edited, with a date filter last 24, last 7d,
 * custom date range").
 *
 * Three sources, each asked for exactly the window, never more:
 * - texts in and out and who texted: the texting Worker's `tex_text_counts`
 *   (`apps/agent/src/textCounts.ts`), one point per text, a person named only by
 *   their inbox object's id;
 * - notes created and edited: the workspace objects' `note` points in
 *   `context_calls` (`apps/mcp/src/observability/callCounts.js`
 *   `countNoteWrite`), a note named only by its id;
 * - inference cost: Cloudflare's AI gateway, priced by the gateway, the same
 *   labels as the Spend card (`texSpend.ts`), staging's Tex included.
 *
 * The first two are read with the Analytics Engine SQL API, the third with
 * GraphQL, both with the analytics token the AI costs tab already uses.
 * Counts and ids only reach this file; what goes to the page is counts. Staff
 * only: `functions/texStats.ts` checks before calling. Errors are our words,
 * never Cloudflare's body.
 *
 * A window of up to two days is drawn by the hour, a longer one by the UTC
 * day. "People" is everyone who texted Tex 1:1 or wrote to it in a group;
 * daily active people is the average of each whole or partial UTC day's count.
 */

import { v, type Infer } from "convex/values";
import { CLOUDFLARE_GRAPHQL_URL, type CloudflareEnv } from "./aiCostsCloudflare";
import { TESTS, TEX_FEATURES } from "./texSpend";
import { COUNTS_BEGAN, beforeNames, beforeQueries } from "./texStatsBefore";

const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 1_000_000;
/**
 * The widest window. Analytics Engine keeps about three months of points, so this is the most it can hold. The
 * gateway's cost figures are kept for less, so cost older than the gateway keeps reads as zero.
 */
export const MAX_STATS_DAYS = 90;
/** Up to this, the window is drawn by the hour. */
const HOURLY_UP_TO_MS = 2 * DAY_MS;
/** The widest span one GraphQL question may cover. */
const SPAN_MS = 30 * DAY_MS;

export const TEXT_COUNTS_DATASET = "tex_text_counts";
export const CALL_COUNTS_DATASET = "context_calls";

const point = v.object({
  /** The bucket's first instant, ms since the epoch (UTC). */
  at: v.number(),
  people: v.number(),
  textsIn: v.number(),
  textsOut: v.number(),
  usd: v.number(),
  notesCreated: v.number(),
  notesEdited: v.number(),
});

export const texStatsValidator = v.union(
  v.object({ configured: v.literal(false) }),
  v.object({
    configured: v.literal(true),
    from: v.number(),
    to: v.number(),
    bucket: v.union(v.literal("hour"), v.literal("day")),
    /** Each source's failure, in our words; null when it answered. A failed source's figures are zero. */
    errors: v.object({ texts: v.union(v.string(), v.null()), notes: v.union(v.string(), v.null()), cost: v.union(v.string(), v.null()) }),
    /**
     * Distinct people in the whole window: 1:1, in groups, and either. `accounts` are the 1:1 people who have an
     * account (a personal workspace), `guests` the rest of `any`.
     */
    people: v.object({ one: v.number(), group: v.number(), any: v.number(), accounts: v.number(), guests: v.number() }),
    /** The average of each UTC day's distinct people. */
    dailyActive: v.number(),
    texts: v.object({
      /** 1:1 texts from people. */
      inOne: v.number(),
      /** Group messages queued for Tex (named it, or followed its own). */
      inGroup: v.number(),
      /** Group messages Tex only heard. */
      heardGroup: v.number(),
      outOne: v.number(),
      outGroup: v.number(),
    }),
    notes: v.object({ created: v.number(), edited: v.number(), saves: v.number() }),
    cost: v.object({ totalUsd: v.number(), testsUsd: v.number() }),
    /** Total cost over texts people sent Tex (1:1 and group messages for Tex); null with none. */
    costPerTextUsd: v.union(v.number(), v.null()),
    /**
     * When the basics' own counts began; a window starting earlier has that part read from older, coarser sources
     * (`texStatsBefore.ts`): answered texts, 1:1 people only, notes created on the one-call path, no edits.
     */
    countedSince: v.number(),
    series: v.array(point),
  }),
);
export type TexStats = Infer<typeof texStatsValidator>;

export interface TexStatsEnv extends CloudflareEnv {
  APP_ENV?: string;
}

/** The window asked for, held to `MAX_STATS_DAYS` back from now and at least an hour long. */
export function clampStatsWindow(from: unknown, to: unknown, now: number): { from: number; to: number } {
  const earliest = now - MAX_STATS_DAYS * DAY_MS;
  const end = typeof to === "number" && Number.isFinite(to) ? Math.min(Math.max(to, earliest + HOUR_MS), now) : now;
  const start = typeof from === "number" && Number.isFinite(from) ? Math.max(Math.min(from, end - HOUR_MS), earliest) : end - DAY_MS;
  return { from: Math.floor(start), to: Math.floor(end) };
}

/** The buckets the window is drawn in, oldest first. */
export function bucketsOf(from: number, to: number): { bucket: "hour" | "day"; starts: number[] } {
  const bucket = to - from <= HOURLY_UP_TO_MS ? "hour" : "day";
  const size = bucket === "hour" ? HOUR_MS : DAY_MS;
  const starts: number[] = [];
  for (let at = Math.floor(from / size) * size; at < to; at += size) starts.push(at);
  return { bucket, starts };
}

const seconds = (ms: number) => Math.floor(ms / 1000);

/** The datasets' names on this deployment: staging's Workers write to `_staging` twins. */
function datasets(env: TexStatsEnv): { texts: string; calls: string; entry: string } {
  const staging = env.APP_ENV?.trim().toLowerCase() === "staging";
  const names = staging ? { texts: `${TEXT_COUNTS_DATASET}_staging`, calls: `${CALL_COUNTS_DATASET}_staging` } : { texts: TEXT_COUNTS_DATASET, calls: CALL_COUNTS_DATASET };
  return { ...names, entry: beforeNames(staging).entry };
}

/**
 * The SQL asked of Analytics Engine, built from numbers and fixed names only, never from a request's text.
 * Exported so a test can read what is asked.
 */
export function statsQueries(names: { texts: string; calls: string; entry: string }, from: number, to: number, bucket: "hour" | "day"): Record<string, string> {
  const when = `timestamp >= toDateTime(${seconds(from)}) AND timestamp < toDateTime(${seconds(to)})`;
  const slot = `toStartOfInterval(timestamp, INTERVAL '1' ${bucket === "hour" ? "HOUR" : "DAY"})`;
  const day = "toStartOfInterval(timestamp, INTERVAL '1' DAY)";
  const asked = "blob1 = 'in' AND blob3 IN ('text', 'for_tex')";
  return {
    texts: `SELECT ${slot} AS slot, blob1 AS way, blob2 AS chat, blob3 AS what, sum(_sample_interval) AS n FROM ${names.texts} WHERE ${when} GROUP BY slot, way, chat, what FORMAT JSON`,
    peopleBySlot: `SELECT ${slot} AS slot, count(DISTINCT index1) AS n FROM ${names.texts} WHERE ${when} AND ${asked} GROUP BY slot FORMAT JSON`,
    peopleByDay: `SELECT ${day} AS slot, count(DISTINCT index1) AS n FROM ${names.texts} WHERE ${when} AND ${asked} GROUP BY slot FORMAT JSON`,
    peopleByChat: `SELECT blob2 AS chat, count(DISTINCT index1) AS n FROM ${names.texts} WHERE ${when} AND ${asked} GROUP BY chat FORMAT JSON`,
    peopleAll: `SELECT count(DISTINCT index1) AS n FROM ${names.texts} WHERE ${when} AND ${asked} FORMAT JSON`,
    accounts: `SELECT count(DISTINCT index1) AS n FROM ${names.entry} WHERE ${when} AND blob1 = 'gateway' AND blob2 = 'one' FORMAT JSON`,
    notes: `SELECT ${slot} AS slot, blob2 AS what, sum(_sample_interval) AS saves, count(DISTINCT blob3) AS notes FROM ${names.calls} WHERE ${when} AND blob1 = 'note' GROUP BY slot, what FORMAT JSON`,
    notesAll: `SELECT blob2 AS what, sum(_sample_interval) AS saves, count(DISTINCT blob3) AS notes FROM ${names.calls} WHERE ${when} AND blob1 = 'note' GROUP BY what FORMAT JSON`,
  };
}

type Row = Record<string, unknown>;
type Fetcher = typeof fetch;

const num = (value: unknown): number => {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** `2026-11-10 13:00:00` (Analytics Engine, UTC) or an ISO time, as ms; NaN when neither. */
function slotMs(value: unknown): number {
  if (typeof value !== "string") return NaN;
  return Date.parse(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
}

async function readBody(fetchImpl: Fetcher, url: string, init: RequestInit): Promise<unknown | string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    if (!response.ok) return `Cloudflare answered ${response.status}`;
    const text = await response.text();
    if (text.length > MAX_BODY_BYTES) return "Cloudflare's answer was too large";
    return JSON.parse(text);
  } catch {
    return "Cloudflare could not be reached";
  } finally {
    clearTimeout(timer);
  }
}

async function sql(fetchImpl: Fetcher, token: string, accountId: string, query: string): Promise<Row[] | string> {
  const body = await readBody(fetchImpl, `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: query,
  });
  if (typeof body === "string") return body;
  const data = (body as { data?: unknown })?.data;
  return Array.isArray(data) ? (data as Row[]) : "Analytics Engine answered in a shape we don't know";
}

const COST_QUERY = (dimension: "datetimeHour" | "date") => `query($a:String!,$s:Time!,$e:Time!){viewer{accounts(filter:{accountTag:$a}){
gw:aiGatewayRequestsAdaptiveGroups(limit:5000,filter:{datetime_geq:$s,datetime_lt:$e}){sum{cost} dimensions{${dimension} feature:metadataValue(key:"feature")}}
}}}`;

async function costGroups(fetchImpl: Fetcher, token: string, accountId: string, from: number, to: number, bucket: "hour" | "day"): Promise<Row[] | string> {
  const groups: Row[] = [];
  for (let start = from; start < to; start += SPAN_MS) {
    const end = Math.min(to, start + SPAN_MS);
    const body = await readBody(fetchImpl, CLOUDFLARE_GRAPHQL_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: COST_QUERY(bucket === "hour" ? "datetimeHour" : "date"), variables: { a: accountId, s: new Date(start).toISOString(), e: new Date(end).toISOString() } }),
    });
    if (typeof body === "string") return body;
    const root = body as { data?: { viewer?: { accounts?: Array<{ gw?: unknown }> } }; errors?: unknown };
    const account = root?.data?.viewer?.accounts?.[0];
    if (!account || (Array.isArray(root.errors) && root.errors.length > 0)) return "Cloudflare refused the usage query; check the token can read Analytics";
    if (Array.isArray(account.gw)) groups.push(...(account.gw as Row[]));
  }
  return groups;
}

export async function texStats(env: TexStatsEnv, window: { from: number; to: number }, options: { fetchImpl?: Fetcher } = {}): Promise<TexStats> {
  const token = env.CLOUDFLARE_ANALYTICS_TOKEN?.trim();
  const accountId = env.CLOUDFLARE_ANALYTICS_ACCOUNT_ID?.trim();
  if (!token || !accountId || !ACCOUNT_ID.test(accountId)) return { configured: false };
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const { from, to } = window;
  const { bucket, starts } = bucketsOf(from, to);
  const size = bucket === "hour" ? HOUR_MS : DAY_MS;
  const queries = statsQueries(datasets(env), from, to, bucket);
  const [texts, peopleBySlot, peopleByDay, peopleByChat, peopleAll, accountsAnswer, notes, notesAll, cost] = await Promise.all([
    sql(fetchImpl, token, accountId, queries.texts),
    sql(fetchImpl, token, accountId, queries.peopleBySlot),
    sql(fetchImpl, token, accountId, queries.peopleByDay),
    sql(fetchImpl, token, accountId, queries.peopleByChat),
    sql(fetchImpl, token, accountId, queries.peopleAll),
    sql(fetchImpl, token, accountId, queries.accounts),
    sql(fetchImpl, token, accountId, queries.notes),
    sql(fetchImpl, token, accountId, queries.notesAll),
    costGroups(fetchImpl, token, accountId, from, to, bucket),
  ]);
  const older = beforeQueries(beforeNames(env.APP_ENV?.trim().toLowerCase() === "staging"), from, to, bucket);
  const [oldTexts, oldCreated, oldPeopleBySlot, oldPeopleByDay] =
    older === null ? [[], [], [], []] : await Promise.all([older.texts, older.created, older.peopleBySlot, older.peopleByDay].map((query) => sql(fetchImpl, token, accountId, query)));
  const rows = (answer: Row[] | string): Row[] => (typeof answer === "string" ? [] : answer);
  const firstError = (...answers: Array<Row[] | string>) => (answers.find((a) => typeof a === "string") as string | undefined) ?? null;

  const series = starts.map((at) => ({ at, people: 0, textsIn: 0, textsOut: 0, usd: 0, notesCreated: 0, notesEdited: 0 }));
  const slotOf = (ms: number) => {
    if (!Number.isFinite(ms)) return undefined;
    const index = Math.floor((Math.floor(ms / size) * size - starts[0]) / size);
    return series[index];
  };

  const tally = { inOne: 0, inGroup: 0, heardGroup: 0, outOne: 0, outGroup: 0 };
  for (const row of rows(texts)) {
    const n = num(row.n);
    const way = row.way;
    const chat = row.chat;
    const what = row.what;
    const slot = slotOf(slotMs(row.slot));
    if (way === "in") {
      if (chat === "one" && what === "text") tally.inOne += n;
      else if (chat === "group" && what === "for_tex") tally.inGroup += n;
      else if (chat === "group" && what === "heard") tally.heardGroup += n;
      if (slot && (what === "text" || what === "for_tex")) slot.textsIn += n;
    } else if (way === "out") {
      if (chat === "one") tally.outOne += n;
      else if (chat === "group") tally.outGroup += n;
      if (slot) slot.textsOut += n;
    }
  }
  // Before counting began: each text Tex answered, and the parts it sent (`texStatsBefore.ts`).
  for (const row of rows(oldTexts)) {
    const n = num(row.n);
    const parts = num(row.parts);
    const slot = slotOf(slotMs(row.slot));
    if (row.chat === "one") (tally.inOne += n), (tally.outOne += parts);
    else if (row.chat === "group") (tally.inGroup += n), (tally.outGroup += parts);
    else continue;
    if (slot) (slot.textsIn += n), (slot.textsOut += parts);
  }
  // People: the higher of the new count and the 1:1 turns' workspaces, slot by slot and day by day.
  for (const answer of [peopleBySlot, oldPeopleBySlot]) {
    for (const row of rows(answer)) {
      const slot = slotOf(slotMs(row.slot));
      if (slot) slot.people = Math.max(slot.people, num(row.n));
    }
  }
  const byDay = new Map<number, number>();
  for (const answer of [peopleByDay, oldPeopleByDay]) {
    for (const row of rows(answer)) {
      const at = slotMs(row.slot);
      if (Number.isFinite(at)) byDay.set(at, Math.max(byDay.get(at) ?? 0, num(row.n)));
    }
  }
  const dayCount = Math.max(1, Math.ceil((to - Math.floor(from / DAY_MS) * DAY_MS) / DAY_MS));
  const dailyActive = [...byDay.values()].reduce((sum, n) => sum + n, 0) / dayCount;
  const people = { one: 0, group: 0, any: num(rows(peopleAll)[0]?.n), accounts: num(rows(accountsAnswer)[0]?.n), guests: 0 };
  for (const row of rows(peopleByChat)) {
    if (row.chat === "one") people.one = num(row.n);
    if (row.chat === "group") people.group = num(row.n);
  }
  // Every account that texted 1:1 is a 1:1 person and a person; when the entry points saw more, the higher count stands.
  people.one = Math.max(people.one, people.accounts);
  people.any = Math.max(people.any, people.one);
  people.accounts = Math.min(people.accounts, people.any);
  people.guests = Math.max(0, people.any - people.accounts);

  for (const row of rows(notes)) {
    const slot = slotOf(slotMs(row.slot));
    if (!slot) continue;
    if (row.what === "created") slot.notesCreated += num(row.notes);
    if (row.what === "edited") slot.notesEdited += num(row.notes);
  }
  const noteTally = { created: 0, edited: 0, saves: 0 };
  for (const row of rows(notesAll)) {
    if (row.what === "created") noteTally.created = num(row.notes);
    if (row.what === "edited") noteTally.edited = num(row.notes);
    noteTally.saves += num(row.saves);
  }
  for (const row of rows(oldCreated)) {
    const n = num(row.n);
    noteTally.created += n;
    const slot = slotOf(slotMs(row.slot));
    if (slot) slot.notesCreated += n;
  }

  let totalUsd = 0;
  let testsUsd = 0;
  for (const group of rows(cost)) {
    const dims = (group.dimensions ?? {}) as Row;
    const usd = num((group.sum as Row | undefined)?.cost);
    if (dims.feature === TESTS) {
      testsUsd += usd;
      continue;
    }
    if (typeof dims.feature !== "string" || !TEX_FEATURES.has(dims.feature)) continue;
    totalUsd += usd;
    const when = typeof dims.datetimeHour === "string" ? Date.parse(dims.datetimeHour) : typeof dims.date === "string" ? Date.parse(`${dims.date}T00:00:00Z`) : NaN;
    const slot = slotOf(when);
    if (slot) slot.usd += usd;
  }
  const asked = tally.inOne + tally.inGroup;
  return {
    configured: true,
    from,
    to,
    bucket,
    errors: {
      texts: firstError(texts, peopleBySlot, peopleByDay, peopleByChat, peopleAll, accountsAnswer, oldTexts, oldPeopleBySlot, oldPeopleByDay),
      notes: firstError(notes, notesAll, oldCreated),
      cost: typeof cost === "string" ? cost : null,
    },
    people,
    dailyActive,
    texts: tally,
    notes: noteTally,
    cost: { totalUsd, testsUsd },
    costPerTextUsd: asked > 0 && typeof cost !== "string" ? totalUsd / asked : null,
    countedSince: COUNTS_BEGAN,
    series,
  };
}
