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
    description: "Cloudflare API token, scoped to D1:Edit, on the customer-data account.",
    unsetMeans: "Per-workspace search databases cannot be provisioned.",
  },
  {
    name: "SEARCH_D1_ACCOUNT_ID",
    description: "The Cloudflare account the search databases are created in.",
    unsetMeans: "Per-workspace search databases cannot be provisioned.",
  },
  {
    name: "STRIPE_SECRET_KEY",
    description: "Stripe secret key for subscriptions and billing.",
    unsetMeans: "Nothing can be charged.",
  },
  {
    name: "MANAGED_R2_API_TOKEN",
    description:
      "Cloudflare API token that creates one managed bucket and one bucket-scoped key per context.",
    unsetMeans: "Managed storage cannot be provisioned.",
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

/**
 * A total the server may have stopped counting.
 *
 * `usageReport` reads one bounded page rather than the whole table, so a
 * number past its ceiling comes back as a floor. Rendering that as a plain
 * figure would state a number the server did not measure; `10,000+` says what
 * is actually known.
 */
export interface CountedTotal {
  count: number;
  isFloor: boolean;
}

export function formatTotal(total: CountedTotal): string {
  return total.isFloor ? `${formatCount(total.count)}+` : formatCount(total.count);
}

// -- the census -----------------------------------------------------------

/**
 * The four jobs the staff console does, as tabs.
 *
 * They were one scroll: eleven identical tiles, then a credential form. The
 * problem was not length, it was that "how is the product doing" and "set a
 * Stripe key" are different errands with different urgency, and a page that
 * interleaves them makes somebody scroll past growth figures to rotate a token
 * and past a token form to read a growth figure. Splitting them is also what
 * lets each section have a shape of its own rather than being a tile row.
 */
export const ADMIN_TABS = [
  { key: "growth", label: "Growth" },
  { key: "estate", label: "Estate" },
  { key: "activity", label: "Activity" },
  { key: "credentials", label: "Credentials" },
] as const;

export type AdminTab = (typeof ADMIN_TABS)[number]["key"];

export function isAdminTab(value: string): value is AdminTab {
  return ADMIN_TABS.some((tab) => tab.key === value);
}

/** The windows the console offers. The server clamps at ninety. */
export const WINDOW_CHOICES = [7, 30, 90] as const;
export const DEFAULT_WINDOW = 30;

/**
 * A signed whole number, for "how many more than last time".
 *
 * **This is the change a two-to-ten-customer dashboard should print, and a
 * percentage is not.** One signup against a baseline of one is `+100%`, which
 * is a number that gets quoted and means nothing; `+1` is the fact.
 * `dayOverDay` and `formatDelta` above stay for the activity metrics, where
 * the counts are large enough for a ratio to carry information.
 *
 * A real minus sign, matching `formatDelta`.
 */
export function formatSigned(change: number): string {
  if (!Number.isFinite(change)) return "—";
  const value = Math.round(change);
  if (value === 0) return "±0";
  return value > 0 ? `+${formatCount(value)}` : `−${formatCount(Math.abs(value))}`;
}

/**
 * "+2 vs 1 before" — the period's arrivals, and the period before it.
 *
 * Both halves, deliberately. The change alone hides that `+0` can mean "two
 * and two" or "nothing and nothing", which at this size are entirely different
 * weeks.
 */
export function periodCaption(newInWindow: number, newInPrior: number): string {
  return `${formatSigned(newInWindow - newInPrior)} — ${formatCount(
    newInWindow,
  )} vs ${formatCount(newInPrior)} before`;
}

/** Whole dollars from cents. Money never passes through a float. */
export function formatMoney(cents: number): string {
  if (!Number.isFinite(cents)) return "—";
  const whole = Math.round(cents) / 100;
  return Number.isInteger(whole)
    ? `$${whole.toLocaleString("en-US")}`
    : `$${whole.toFixed(2)}`;
}

/** A ratio, or an em dash where there was nothing to divide by. */
export function formatRatio(ratio: number | null): string {
  return ratio === null ? "—" : ratio.toFixed(1);
}

/** `relativeTime`, or "never" — which is a fact, not a missing value. */
export function formatLastUsed(at: number | null, now: number = Date.now()): string {
  return at === null ? "never" : relativeTime(at, now);
}

// -- composition bars -----------------------------------------------------

/**
 * The smallest slice a stacked bar will draw, as a percentage.
 *
 * One paying context out of four hundred is 0.25% of the bar, which at any
 * sane width is nothing — and "nothing" and "zero" must not look the same on a
 * chart whose whole job is to show a small number existing. Non-zero slices
 * are lifted to this floor and the large ones scaled down to make room, so the
 * bar still totals 100.
 *
 * **The widths are then no longer proportional, and that is the trade.** It is
 * taken because the label beside every slice carries the actual count: the bar
 * is there to show composition at a glance, and the number is there to be
 * read. A chart that renders a real customer as zero pixels is the worse lie.
 */
export const MIN_SEGMENT_PERCENT = 2;

export interface CompositionPart {
  key: string;
  label: string;
  count: number;
  tone: SegmentTone;
}

export type SegmentTone =
  | "accent"
  | "ok"
  | "warn"
  | "crit"
  | "shared"
  | "muted";

export interface CompositionSegment extends CompositionPart {
  /** Width, as a percentage of the bar. Never below `MIN_SEGMENT_PERCENT`. */
  percent: number;
}

/**
 * Parts to bar segments, dropping the empty ones.
 *
 * An all-zero composition returns `[]` rather than an empty bar, so the screen
 * can say "nothing yet" instead of drawing a shape that looks like data.
 */
export function compositionOf(
  parts: readonly CompositionPart[],
): CompositionSegment[] {
  const present = parts.filter((part) => part.count > 0);
  const total = present.reduce((sum, part) => sum + part.count, 0);
  if (total <= 0) return [];

  const raw = present.map((part) => ({
    ...part,
    percent: (part.count / total) * 100,
  }));
  const short = raw.filter((part) => part.percent < MIN_SEGMENT_PERCENT);
  if (short.length === 0) return raw;

  const floorTotal = short.length * MIN_SEGMENT_PERCENT;
  const tall = raw.filter((part) => part.percent >= MIN_SEGMENT_PERCENT);
  const tallTotal = tall.reduce((sum, part) => sum + part.percent, 0);
  // Everything is below the floor, or lifting would leave the rest with less
  // than they started with. An even split is the honest fallback: at that
  // point the bar carries no proportion worth preserving.
  if (tallTotal <= floorTotal) {
    return raw.map((part) => ({ ...part, percent: 100 / raw.length }));
  }

  const scale = (100 - floorTotal) / tallTotal;
  return raw.map((part) =>
    part.percent < MIN_SEGMENT_PERCENT
      ? { ...part, percent: MIN_SEGMENT_PERCENT }
      : { ...part, percent: part.percent * scale },
  );
}

// -- the funnel -----------------------------------------------------------

export const FUNNEL_LABELS: Record<string, string> = {
  "signed-up": "Signed up",
  "made-a-context": "Made a context",
  "connected-storage": "Connected storage",
  "connected-a-client": "Connected a client",
  paying: "Paying",
};

export interface FunnelRow {
  step: string;
  label: string;
  count: number;
  /** Share of everybody who signed up, 0–1. */
  share: number;
  /**
   * Change from the step above. **Positive is possible** — see
   * `lib/census.ts`: the steps are independent thresholds, not a nested
   * funnel, and somebody with a client on a context whose bucket never
   * verified is the customer worth finding rather than an anomaly to hide.
   */
  change: number | null;
}

export function funnelRows(
  steps: readonly { step: string; count: number }[],
): FunnelRow[] {
  const base = steps[0]?.count ?? 0;
  return steps.map((entry, index) => ({
    step: entry.step,
    label: FUNNEL_LABELS[entry.step] ?? entry.step,
    count: entry.count,
    share: base > 0 ? entry.count / base : 0,
    change: index === 0 ? null : entry.count - steps[index - 1].count,
  }));
}

// -- names for the things the census counts -------------------------------

/**
 * Storage providers, as a person says them.
 *
 * A provider the server starts returning falls through to its raw key rather
 * than vanishing, for the same reason `metricLabel` does: a new one should
 * appear looking unfinished, not be silently dropped from the totals somebody
 * is reading.
 */
export const PROVIDER_LABELS: Record<string, string> = {
  r2: "Cloudflare R2",
  s3: "Amazon S3",
  b2: "Backblaze B2",
  "s3-compatible": "S3-compatible",
  dropbox: "Dropbox",
};

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

export const BINDING_STATUS_LABELS: Record<string, string> = {
  connected: "Connected",
  unverified: "Unverified",
  error: "Error",
};

export function bindingStatusLabel(status: string): string {
  return BINDING_STATUS_LABELS[status] ?? status;
}

/**
 * A binding status as a chip tone.
 *
 * `unverified` is amber rather than grey: a bucket nothing has reached is not
 * a neutral state on a console whose job is to notice one.
 */
export function bindingStatusTone(status: string): "ok" | "warn" | "crit" {
  if (status === "connected") return "ok";
  if (status === "error") return "crit";
  return "warn";
}

export const PLAN_LABELS: Record<string, string> = {
  active: "Paying",
  past_due: "Past due",
  canceled: "Cancelled",
  unknown: "Unrecognised",
  none: "Free",
};

export function planLabel(status: string): string {
  return PLAN_LABELS[status] ?? status;
}

export function planTone(status: string): "ok" | "warn" | "crit" | "neutral" {
  if (status === "active") return "ok";
  if (status === "past_due") return "crit";
  if (status === "canceled" || status === "unknown") return "warn";
  return "neutral";
}
