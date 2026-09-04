/**
 * Turning the admin report into the things a screen draws.
 *
 * Pure functions, no React, no Convex — so the arithmetic behind every number
 * on the dashboard can be checked without mounting anything. That matters more
 * here than on most screens: a figure that is quietly wrong is worse than a
 * figure that is missing, because nobody goes looking for it.
 */

/** One day's value in a series. */
export interface Point {
  day: string;
  count: number;
}

export interface Series {
  metric: string;
  points: Point[];
  total: number;
}

/**
 * How each metric is labelled, and the order the tiles appear in.
 *
 * An explicit list rather than a loop over whatever the server sent, because a
 * dashboard is a layout: a metric the server adds should appear deliberately,
 * with a name a person recognizes, rather than as a tile called
 * `mcp.tool_call` in whatever position the iteration order happened to give
 * it. A metric with no entry here is still rendered — under its raw name, at
 * the end — so a newly-added counter is visible rather than silently dropped.
 */
export const METRIC_LABELS: Record<string, string> = {
  "mcp.tool_call": "Tool calls",
  "mcp.session": "MCP connections",
  "search.query": "Searches",
  "note.write": "Notes written",
  "app.session": "App sessions",
  "web.visit": "Site visits",
  "account.signin": "Sign-ins",
  "account.created": "Accounts created",
};

export const METRIC_ORDER: readonly string[] = [
  "mcp.tool_call",
  "search.query",
  "note.write",
  "mcp.session",
  "app.session",
  "web.visit",
  "account.created",
  "account.signin",
];

export function metricLabel(metric: string): string {
  return METRIC_LABELS[metric] ?? metric;
}

export function orderSeries(series: readonly Series[]): Series[] {
  const rank = new Map(METRIC_ORDER.map((metric, index) => [metric, index]));
  return [...series].sort((a, b) => {
    const ra = rank.get(a.metric) ?? Number.MAX_SAFE_INTEGER;
    const rb = rank.get(b.metric) ?? Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    return a.metric.localeCompare(b.metric);
  });
}

/**
 * The bar heights for a sparkline, as fractions of the tallest day.
 *
 * Scaled to the series' own maximum rather than to a shared one: these sit
 * next to each other and one metric is routinely two orders of magnitude
 * bigger than another, so a shared scale would draw every small series as a
 * flat line at zero. The tile carries the total, which is what makes the
 * per-series scale readable rather than misleading.
 *
 * An all-zero series returns all zeroes rather than dividing by zero, and a
 * single day returns its one bar at full height — a lone bar is the honest
 * picture of one day of data.
 */
export function barHeights(points: readonly Point[]): number[] {
  const max = points.reduce((best, point) => Math.max(best, point.count), 0);
  if (max <= 0) return points.map(() => 0);
  return points.map((point) => point.count / max);
}

/**
 * The change between the most recent day and the one before it.
 *
 * `null` where there is no previous day to compare against, or where the
 * previous day was zero — a rise from nothing is not a percentage, and
 * rendering it as one ("+∞%", or worse, "+100%") is the kind of number that
 * gets quoted later.
 */
export function dayOverDay(points: readonly Point[]): number | null {
  if (points.length < 2) return null;
  const latest = points[points.length - 1].count;
  const previous = points[points.length - 2].count;
  if (previous === 0) return null;
  return (latest - previous) / previous;
}

/** `+12%`, `−4%`, or `—` where there is nothing to compare. */
export function formatDelta(delta: number | null): string {
  if (delta === null) return "—";
  const percent = Math.round(delta * 100);
  if (percent === 0) return "0%";
  // A real minus sign, not a hyphen: this sits beside numerals at a small
  // size, where a hyphen reads as a dash between them.
  return percent > 0 ? `+${percent}%` : `−${Math.abs(percent)}%`;
}

/**
 * Thousands separated, and large numbers shortened.
 *
 * A tile is narrow and `1,284,003` in it wraps or truncates; `1.28M` does not.
 * The threshold is 10,000 rather than 1,000 because four digits fit and
 * `9.9K` loses precision a person reading a daily figure actually wants.
 */
export function formatCount(count: number): string {
  if (!Number.isFinite(count)) return "—";
  const value = Math.round(count);
  if (Math.abs(value) < 10_000) return value.toLocaleString("en-US");
  if (Math.abs(value) < 1_000_000) return `${(value / 1_000).toFixed(1)}K`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

/** `2026-09-04` → `4 Sep`, for an axis that has to fit. */
export function shortDay(day: string): string {
  const parsed = Date.parse(`${day}T00:00:00.000Z`);
  if (Number.isNaN(parsed)) return day;
  const date = new Date(parsed);
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${date.getUTCDate()} ${months[date.getUTCMonth()]}`;
}

/**
 * Relative time, for "set 3 days ago" beside a credential.
 *
 * Deliberately coarse. The exact moment a token was rotated is not what an
 * operator is checking; whether it was *recently* is.
 */
export function relativeTime(at: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

/**
 * The integrations Context.LC knows how to use, offered as suggestions.
 *
 * A console that only lets you type a name into a box is a console where the
 * name is wrong half the time and the integration silently does not work —
 * the code reads `SEARCH_D1_API_TOKEN` and somebody set `D1_API_TOKEN`. These
 * are the names the code actually reads, so picking one from the list cannot
 * be misspelled.
 *
 * **It is a list of suggestions, not an allowlist.** A name not on it is
 * still accepted: the point is to make the common case unmissable, not to
 * require a deploy before a new integration can be configured. What *is*
 * refused is the reserved set, and that is enforced on the server
 * (`functions/lib/appSecrets.ts`), never here — a client-side check is a
 * convenience, and this one is a security rule.
 */
export interface KnownSecret {
  name: string;
  description: string;
  /** What stops working while this is unset. */
  unsetMeans: string;
}

export const KNOWN_SECRETS: readonly KnownSecret[] = [
  {
    name: "SEARCH_D1_API_TOKEN",
    description: "Cloudflare API token, scoped to D1:Edit, on the Supa Media account.",
    unsetMeans: "Per-brain search databases cannot be provisioned.",
  },
  {
    name: "SEARCH_D1_ACCOUNT_ID",
    description: "The Cloudflare account the search databases are created in.",
    unsetMeans: "Per-brain search databases cannot be provisioned.",
  },
  {
    name: "STRIPE_SECRET_KEY",
    description: "Stripe secret key for subscriptions and billing.",
    unsetMeans: "Nothing can be charged.",
  },
  {
    name: "STRIPE_WEBHOOK_SECRET",
    description: "Verifies that a webhook delivery really came from Stripe.",
    unsetMeans: "Stripe webhooks are refused, so payments never settle in-product.",
  },
  {
    name: "RESEND_API_KEY_TRANSACTIONAL",
    description: "Outbound product mail, separate from the sign-in sender.",
    unsetMeans: "Transactional mail is not sent.",
  },
];

/** Known names that have no row yet, in the order the console offers them. */
export function unsetKnownSecrets(
  configured: readonly { name: string }[],
): KnownSecret[] {
  const have = new Set(configured.map((row) => row.name));
  return KNOWN_SECRETS.filter((known) => !have.has(known.name));
}
