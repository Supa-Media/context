/**
 * THE USAGE TAB: VISITS, TIME IN APP, PAGES AND BUTTONS, READ FROM POSTHOG.
 *
 * The app sends PostHog cleaned screen views, a thirty-second "in use" tick
 * and named button presses (`apps/mobile/features/observability/`). This asks
 * PostHog's query API for the window and the window before it, and hands the
 * staff console figures and nothing else: hosts, days, cleaned routes, fixed
 * button names and counts. Never a person, an address or an event.
 *
 * It needs a PostHog personal API key with query read access,
 * `POSTHOG_PERSONAL_API_KEY`, in the Convex environment, and optionally the
 * project, `POSTHOG_PROJECT_ID` (else the key's own project). Without the key
 * the answer is `{ connected: false }` and the tab says so. The key never
 * leaves this file, and an error is reported in our words, never with
 * PostHog's body, which could echo the query.
 *
 * Production only. A web event counts when it came from context.lc or tex.lc, and
 * a native one when the app said it was a production build (`app_env`).
 */

import { isCleanRoute, isUsageButton, isUsageAction, isUsageOutcome, USAGE_FUNNELS, ACTIVE_EVENT, BUTTON_EVENT, type UsageStepId } from "@context/shared";
import type { UsageAnalytics, UsageButtonRow, UsagePageRow, UsageSite, UsageTime } from "./usageAnalyticsShape";

export const POSTHOG_API_HOST = "https://us.posthog.com";
/** The sites the tab draws a card for, in order. */
export const USAGE_SITES = ["context.lc", "tex.lc"] as const;
export const USAGE_TOP_ROWS = 10;

const DAY_MS = 86_400_000;
const TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 512_000;
/** Seconds counted for every thirty-second stretch a session sent anything in. */
const TICK_SECONDS = 30;
const PROJECT_ID = /^\d{1,12}$/;

export interface PostHogEnv {
  POSTHOG_PERSONAL_API_KEY?: string;
  POSTHOG_PROJECT_ID?: string;
}

/** The days the window covers, oldest first, ending today (UTC). */
export function windowDays(days: number, now: number): string[] {
  const today = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  return Array.from({ length: days }, (_, index) => new Date(today - (days - 1 - index) * DAY_MS).toISOString().slice(0, 10));
}

/** `toDateTime('2026-10-21 00:00:00')`: built from a number, never from a request. */
function at(ms: number): string {
  return `toDateTime('${new Date(ms).toISOString().slice(0, 19).replace("T", " ")}', 'UTC')`;
}

const SITE_LIST = USAGE_SITES.map((host) => `'${host}'`).join(", ");
const PRODUCTION = `(properties.$host IN (${SITE_LIST}) OR (properties.app_env = 'production' AND properties.$lib != 'web'))`;
const COUNTED = `event IN ('$screen', '${ACTIVE_EVENT}', '${BUTTON_EVENT}')`;
const SESSION = "toString(properties.$session_id)";
const ACTION_LIST = "'landing_cta_clicked', 'tex_messages_opened', 'tex_contact_downloaded', 'tex_console_opened'";
const PRODUCT = `if(properties.$host = 'tex.lc' OR properties.app_product = 'tex', 'tex', 'context')`;

const FUNNEL_STEPS: Record<UsageStepId, string> = {
  landing: "event = '$screen' AND properties.$screen_name = '/'",
  signup_started: "event = 'signup_started'",
  signup_submitted: "event = 'signup_submitted' AND coalesce(properties.resend, false) = false",
  waitlist_joined: "event = 'signup_result' AND properties.result = 'joined'",
  code_sent: "event = 'signup_result' AND properties.result = 'sent' AND coalesce(properties.resend, false) = false",
  code_submitted: "event = 'signin_code_submitted'",
  signed_in: "event = 'signin_code_result' AND properties.result = 'success'",
  setup_started: "event = 'onboarding_step_viewed' AND properties.step = 'name' AND coalesce(properties.resumed, false) = false",
  workspace_created: "event = 'workspace_created'",
  setup_completed: "event = 'onboarding_completed'",
  note_opened: "event = 'note_opened'",
  text_page: "event = '$screen' AND properties.$screen_name = '/text'",
  messages_opened: "event = 'tex_messages_opened'",
};

type QueryName = "daily" | "sites" | "time" | "pages" | "buttons" | "funnels" | "outcomes";
export type UsageRows = Record<"daily" | "sites" | "time" | "pages" | "buttons", readonly Row[]> &
  Partial<Record<"funnels" | "outcomes", readonly Row[]>>;

/** The seven questions, as HogQL. Exported so a test can read what is asked. */
export function usageQueries(days: number, now: number): Record<QueryName, string> {
  const [first] = windowDays(days, now);
  const start = Date.parse(`${first}T00:00:00Z`);
  const end = start + days * DAY_MS;
  const prior = start - days * DAY_MS;
  const S = at(start);
  const E = at(end);
  const P = at(prior);
  const current = `if(timestamp >= ${S}, 1, 0)`;
  return {
    daily:
      `SELECT toString(properties.$host), toString(toDate(timestamp)), count(DISTINCT ${SESSION}) FROM events ` +
      `WHERE ${COUNTED} AND properties.$host IN (${SITE_LIST}) AND timestamp >= ${S} AND timestamp < ${E} ` +
      `GROUP BY 1, 2 LIMIT 1000`,
    sites:
      `SELECT toString(properties.$host), ${current}, count(DISTINCT ${SESSION}), count(DISTINCT person_id) FROM events ` +
      `WHERE ${COUNTED} AND properties.$host IN (${SITE_LIST}) AND timestamp >= ${P} AND timestamp < ${E} ` +
      `GROUP BY 1, 2 LIMIT 100`,
    time:
      `SELECT current, count(), quantile(0.5)(seconds), avg(seconds), sum(seconds), count(DISTINCT person) FROM (` +
      `SELECT ${SESSION} AS session, any(person_id) AS person, if(min(timestamp) >= ${S}, 1, 0) AS current, ` +
      `count(DISTINCT toStartOfInterval(timestamp, toIntervalSecond(${TICK_SECONDS}))) * ${TICK_SECONDS} AS seconds ` +
      `FROM events WHERE ${COUNTED} AND ${PRODUCTION} AND ${SESSION} != '' AND timestamp >= ${P} AND timestamp < ${E} ` +
      `GROUP BY session) GROUP BY current LIMIT 10`,
    pages:
      // A note's path is one `:value` per folder; the depth is not a different page.
      `SELECT replaceRegexpAll(toString(properties.$screen_name), '(/:value)+', '/:value'), count(), ` +
      `count(DISTINCT person_id) FROM events ` +
      `WHERE event = '$screen' AND ${PRODUCTION} AND timestamp >= ${S} AND timestamp < ${E} ` +
      `GROUP BY 1 ORDER BY 2 DESC LIMIT 50`,
    buttons:
      `SELECT if(event = '${BUTTON_EVENT}', toString(properties.button), event), count(), count(DISTINCT person_id) FROM events ` +
      `WHERE (event = '${BUTTON_EVENT}' OR event IN (${ACTION_LIST})) AND ${PRODUCTION} AND timestamp >= ${S} AND timestamp < ${E} ` +
      `GROUP BY 1 ORDER BY 2 DESC LIMIT 50`,
    // windowFunnel enforces event order and a fixed conversion window per
    // merged person. Return only a histogram of the furthest step reached.
    funnels: USAGE_FUNNELS.map((funnel) =>
      `SELECT '${funnel.id}', level, count() FROM (` +
      // PostHog timestamps are DateTime64; ClickHouse windowFunnel requires DateTime.
      `SELECT person_id, windowFunnel(${funnel.windowSeconds})(toDateTime(timestamp), ` +
      funnel.steps.map((step) => `(${FUNNEL_STEPS[step]})`).join(", ") +
      `) AS level FROM events WHERE ${PRODUCTION} AND ${PRODUCT} = '${funnel.product}' ` +
      `AND timestamp >= ${S} AND timestamp < ${E} AND properties.app_analytics_version >= 2 ` +
      `AND event IN ('$screen', 'signup_started', 'signup_submitted', 'signup_result', 'signin_code_submitted', ` +
      `'signin_code_result', 'onboarding_step_viewed', 'workspace_created', 'onboarding_completed', 'note_opened', 'tex_messages_opened') ` +
      `GROUP BY person_id) WHERE level > 0 GROUP BY level LIMIT 10`
    ).join(" UNION ALL "),
    outcomes:
      `SELECT event, toString(properties.result), count(), count(DISTINCT person_id) FROM events ` +
      `WHERE event IN ('signup_result', 'signin_code_result', 'note_save_result') AND ${PRODUCTION} ` +
      `AND timestamp >= ${S} AND timestamp < ${E} GROUP BY 1, 2 LIMIT 100`,
  };
}

type Row = readonly unknown[];

function count(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

/** Turn PostHog's rows into the tab's figures. Everything unexpected is dropped. */
export function shapeUsage(
  days: number,
  now: number,
  rows: UsageRows,
): UsageAnalytics {
  const dayList = windowDays(days, now);
  const sites: UsageSite[] = USAGE_SITES.map((host) => {
    const perDay = new Map<string, number>();
    for (const row of rows.daily) if (row[0] === host && typeof row[1] === "string") perDay.set(row[1], count(row[2]));
    const totals = (period: number) => rows.sites.find((row) => row[0] === host && count(row[1]) === period);
    const now_ = totals(1);
    const before = totals(0);
    return {
      host,
      visits: Math.round(count(now_?.[2])),
      visitors: Math.round(count(now_?.[3])),
      priorVisits: Math.round(count(before?.[2])),
      priorVisitors: Math.round(count(before?.[3])),
      daily: dayList.map((day) => ({ day, count: Math.round(perDay.get(day) ?? 0) })),
    };
  });

  const timeOf = (period: number): UsageTime | null => {
    const row = rows.time.find((candidate) => count(candidate[0]) === period);
    if (row === undefined || count(row[1]) === 0) return null;
    return {
      sessions: Math.round(count(row[1])),
      medianSeconds: Math.round(count(row[2])),
      averageSeconds: Math.round(count(row[3])),
      totalSeconds: Math.round(count(row[4])),
      people: Math.round(count(row[5])),
    };
  };

  const pages: UsagePageRow[] = rows.pages
    .filter((row) => typeof row[0] === "string" && isCleanRoute(row[0]))
    .slice(0, USAGE_TOP_ROWS)
    .map((row) => ({ route: row[0] as string, views: Math.round(count(row[1])), people: Math.round(count(row[2])) }));

  const buttons: UsageButtonRow[] = rows.buttons
    .filter((row) => isUsageButton(row[0]) || isUsageAction(row[0]))
    .slice(0, USAGE_TOP_ROWS)
    .map((row) => ({ button: row[0] as string, clicks: Math.round(count(row[1])), people: Math.round(count(row[2])) }));

  const funnels = USAGE_FUNNELS.map((funnel) => ({
    id: funnel.id,
    steps: funnel.steps.map((key, index) => ({
      key,
      people: (rows.funnels ?? []).reduce((total, row) =>
        row[0] === funnel.id && Number.isInteger(Number(row[1])) && count(row[1]) >= index + 1 && count(row[1]) <= funnel.steps.length
          ? total + Math.round(count(row[2])) : total, 0),
    })),
  }));
  const outcomes = (rows.outcomes ?? [])
    .filter((row) => isUsageOutcome(row[0], row[1]))
    .map((row) => ({ event: row[0] as string, result: row[1] as string, attempts: Math.round(count(row[2])), people: Math.round(count(row[3])) }));
  return { connected: true, error: null, days, sites, time: timeOf(1), priorTime: timeOf(0), pages, buttons, funnels, outcomes };
}

async function ask(
  url: string,
  key: string,
  query: string,
  fetchImpl: typeof fetch,
): Promise<{ rows: Row[] } | { error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: { kind: "HogQLQuery", query }, name: "staff console usage" }),
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      return { error: "PostHog refused the key; check it can read queries" };
    }
    if (response.status === 429) return { error: "PostHog asked us to slow down; try again in a minute" };
    if (!response.ok) return { error: `PostHog answered ${response.status}` };
    const text = await response.text();
    if (text.length > MAX_BODY_BYTES) return { error: "PostHog's answer was too large" };
    const body = JSON.parse(text) as { results?: unknown };
    if (!Array.isArray(body.results)) return { error: "PostHog's answer was not a table" };
    return { rows: body.results.filter((row): row is Row => Array.isArray(row)) };
  } catch {
    return { error: "PostHog could not be reached" };
  } finally {
    clearTimeout(timer);
  }
}

export async function usageAnalytics(
  env: PostHogEnv,
  days: number,
  options: { fetchImpl?: typeof fetch; now?: number } = {},
): Promise<UsageAnalytics> {
  const key = env.POSTHOG_PERSONAL_API_KEY?.trim();
  if (!key) return { connected: false };
  const projectId = env.POSTHOG_PROJECT_ID?.trim();
  if (projectId && !PROJECT_ID.test(projectId)) return { connected: true, error: "PostHog project id must be numeric" };
  const project = projectId || "@current";
  const url = `${POSTHOG_API_HOST}/api/projects/${project}/query/`;
  const now = options.now ?? Date.now();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  const queries = usageQueries(days, now);
  const names = Object.keys(queries) as (keyof typeof queries)[];
  const answers = await Promise.all(names.map((name) => ask(url, key, queries[name], fetchImpl)));
  const failed = answers.find((answer): answer is { error: string } => "error" in answer);
  if (failed !== undefined) return { connected: true, error: failed.error };
  const rows = Object.fromEntries(names.map((name, index) => [name, (answers[index] as { rows: Row[] }).rows]));
  return shapeUsage(days, now, rows as Record<keyof typeof queries, Row[]>);
}
