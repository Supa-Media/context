/**
 * The product-usage vocabulary, as a closed set.
 *
 * Every counter this platform keeps is named here. That is the point of the
 * module: a metric name that arrives as free text from a caller is a metric
 * name an attacker chooses, and a table keyed on one is a table whose rows can
 * be made to say anything and whose index can be filled with junk. The
 * recorder refuses a name that is not in this list.
 *
 * ## What a metric may count
 *
 * A number of times something happened. Nothing else. There is deliberately no
 * facility here for a dimension, a label, a tag, or a free-form detail field:
 * every one of those is where "what was it about" gets in, and what a person
 * searched for or wrote is not ours to hold (CLAUDE.md, "The customer owns the
 * content, and can always leave with it"). If a future question needs a breakdown, the answer is another
 * named metric, decided deliberately, not a label bag.
 *
 * ## Days are UTC, and that is a reporting decision worth stating
 *
 * A day boundary has to be *somewhere*, and picking the viewer's timezone
 * would make yesterday's figure change depending on who opened the page.
 * Counters are bucketed by UTC date and the console says so, so a number is
 * the same number for everyone looking at it.
 */

/**
 * Which kind of agent a grant belongs to, read off the OAuth client's name.
 *
 * Closed, so the admin dashboard can break totals down by agent without the
 * control plane storing a free-text client name against a metric.
 */
export const CLIENT_FAMILIES = ["claude", "chatgpt", "codex", "gemini", "other"] as const;
export type ClientFamily = (typeof CLIENT_FAMILIES)[number];

function familyMetrics<P extends string>(prefix: P) {
  return CLIENT_FAMILIES.map((family) => `${prefix}.${family}` as const);
}

/** Every counter the platform keeps. Adding one is a deliberate edit. */
export const USAGE_METRICS = [
  /** MCP tool calls served by the gateway, per workspace. */
  "mcp.tool_call",
  /** MCP sessions opened — an `initialize`, per workspace. */
  "mcp.session",
  /** Searches served, any surface. The figure the D1 work is judged on. */
  "search.query",
  /** Notes written through any surface, per workspace. */
  "note.write",
  /** Console screens opened by a signed-in person. */
  "app.session",
  /** Landing-page visits. No workspace, nobody signed in. */
  "web.visit",
  /** Accounts that completed sign-in. */
  "account.signin",
  /** Accounts created. */
  "account.created",
  // Platform-wide totals of `usageHourly`, by client family, for the admin
  // dashboard. Bumped by `recordHourly` only, so they cover Premium workspaces.
  ...familyMetrics("mcp.request_tokens"),
  ...familyMetrics("mcp.response_tokens"),
] as const;

export function clientFamily(clientName: string | undefined): ClientFamily {
  const name = (clientName ?? "").toLowerCase();
  // Codex before ChatGPT: both are OpenAI's, and Codex names itself.
  if (name.includes("codex")) return "codex";
  if (name.includes("chatgpt") || name.includes("openai")) return "chatgpt";
  if (name.includes("claude") || name.includes("anthropic")) return "claude";
  if (name.includes("gemini") || name.includes("google")) return "gemini";
  return "other";
}

/**
 * What `usageHourly` counts. Tokens are what crossed the MCP boundary:
 * the tool call in, Context's answer out.
 */
export const HOURLY_METRICS = [
  "mcp.request_tokens",
  "mcp.response_tokens",
  "mcp.calls",
  "mcp.failed_calls",
  "mcp.images",
  "note.write",
] as const;
export type HourlyMetric = (typeof HOURLY_METRICS)[number];
const HOURLY_SET: ReadonlySet<string> = new Set(HOURLY_METRICS);
export function isHourlyMetric(value: unknown): value is HourlyMetric {
  return typeof value === "string" && HOURLY_SET.has(value);
}

export const TOKEN_METHODS = ["exact", "estimated", "count"] as const;
const METHOD_SET: ReadonlySet<string> = new Set(TOKEN_METHODS);
export function isTokenMethod(value: unknown): value is (typeof TOKEN_METHODS)[number] {
  return typeof value === "string" && METHOD_SET.has(value);
}

/**
 * The model, as a string this table may hold.
 *
 * Model ids are open-ended (`/agent` takes a person's own), so a fixed list
 * would label every new release "other". Instead the *shape* is closed: a known
 * provider prefix and a short id in a restricted alphabet. Anything else is
 * "other", and no model at all is "unknown" (an external MCP client never
 * says which model it runs).
 */
const MODEL_SHAPES = [
  /^(?:anthropic\/)?claude-[a-z0-9.-]{1,48}$/,
  /^(?:openai\/)?(?:gpt-|o\d)[a-z0-9.-]{0,48}$/,
  /^(?:google\/)?gemini-[a-z0-9.-]{1,48}$/,
  /^@cf\/[a-z0-9._-]{1,32}\/[a-z0-9._-]{1,64}$/,
];

export function normalizeModel(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) return "unknown";
  const model = raw.trim().toLowerCase();
  return MODEL_SHAPES.some((shape) => shape.test(model)) ? model : "other";
}

/**
 * Distinct models one workspace may add in a day before the rest are "other".
 * The shapes above bound what a model string looks like, not how many there
 * are, and a caller who controls the header could otherwise mint rows at will.
 */
export const MAX_MODELS_PER_WORKSPACE_DAY = 20;

/** One token report may claim at most this many (a 64 MiB answer, at 4 bytes per token). */
export const MAX_TOKEN_EVENT_COUNT = 16_777_216;

/** Hourly rows older than this are pruned: a year of heatmap, and some slack. */
export const HOURLY_RETENTION_DAYS = 400;

/** UTC hour of `at`, 0 to 23. */
export function hourOf(at: number): number {
  return new Date(at).getUTCHours();
}

export type UsageMetric = (typeof USAGE_METRICS)[number];

const METRIC_SET: ReadonlySet<string> = new Set(USAGE_METRICS);

/** Metrics counted per context. Every other metric is platform-wide. */
export const PER_WORKSPACE_METRICS: ReadonlySet<string> = new Set([
  "mcp.tool_call",
  "mcp.session",
  "search.query",
  "note.write",
  "app.session",
]);

/** Where a context was seen, for the active-context count. */
export const USAGE_SURFACES = ["mcp", "app", "web"] as const;
export type UsageSurface = (typeof USAGE_SURFACES)[number];

const SURFACE_SET: ReadonlySet<string> = new Set(USAGE_SURFACES);

export function isUsageMetric(value: unknown): value is UsageMetric {
  return typeof value === "string" && METRIC_SET.has(value);
}

export function isUsageSurface(value: unknown): value is UsageSurface {
  return typeof value === "string" && SURFACE_SET.has(value);
}

/** `YYYY-MM-DD`, UTC. */
export const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function dayKey(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

export function isDayKey(value: unknown): value is string {
  return typeof value === "string" && DAY_PATTERN.test(value);
}

/**
 * The `count` days ending at `endDay`, oldest first.
 *
 * Built by walking UTC midnights rather than by subtracting 86,400,000 from a
 * local timestamp, so it does not skip or repeat a day across a DST boundary
 * in whatever zone the server happens to think it is in.
 */
export function dayRange(endDay: string, count: number): string[] {
  if (!isDayKey(endDay) || !Number.isInteger(count) || count <= 0) return [];
  const end = Date.parse(`${endDay}T00:00:00.000Z`);
  if (Number.isNaN(end)) return [];
  const days: string[] = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    days.push(dayKey(end - i * 86_400_000));
  }
  return days;
}

/**
 * How much one report may ask for.
 *
 * A cap rather than a paging cursor because the console shows a trend line and
 * a trend line has a natural length. It also bounds the read: without it, a
 * `days: 100000` argument is a full-table scan an authenticated caller can ask
 * for at will.
 */
export const MAX_REPORT_DAYS = 90;
export const DEFAULT_REPORT_DAYS = 30;

export function clampReportDays(days: unknown): number {
  if (typeof days !== "number" || !Number.isFinite(days)) {
    return DEFAULT_REPORT_DAYS;
  }
  const whole = Math.floor(days);
  if (whole < 1) return 1;
  if (whole > MAX_REPORT_DAYS) return MAX_REPORT_DAYS;
  return whole;
}
