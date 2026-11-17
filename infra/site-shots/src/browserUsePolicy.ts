/**
 * Caps and block counts for the Browser Use fallback.
 *
 * Tex stays on Browserbase. A site block may be retried on Browser Use only
 * when the gateway asks, and only inside these caps. This file is the
 * arithmetic: it never calls the vendor, and it never buys credits.
 *
 * Days and months are America/New_York, the clock the rest of Tex uses for a
 * person's day. A check that cannot be made refuses the fallback.
 */

export const BROWSER_USE_CEILING = Object.freeze({
  jobMinutes: 15,
  dayUsd: 1,
  monthUsd: 5,
  minBalanceUsd: 0.5,
});

export interface BrowserUseCaps {
  jobMinutes: number;
  dayUsd: number;
  monthUsd: number;
  minBalanceUsd: number;
}

const HOST = /^[a-z0-9.-]{1,253}$/;

/** The stricter of what the gateway asked and the hard ceiling. A missing or wild value becomes the ceiling, never a higher one. */
export function effectiveCaps(asked: unknown): BrowserUseCaps {
  const raw = asked && typeof asked === "object" ? (asked as Record<string, unknown>) : {};
  const minutes = raw.jobMinutes;
  const day = raw.dayUsd;
  const month = raw.monthUsd;
  const floor = raw.minBalanceUsd;
  return {
    jobMinutes: Number.isInteger(minutes) && (minutes as number) >= 1 && (minutes as number) <= BROWSER_USE_CEILING.jobMinutes ? (minutes as number) : BROWSER_USE_CEILING.jobMinutes,
    dayUsd: typeof day === "number" && day > 0 && day <= BROWSER_USE_CEILING.dayUsd ? day : BROWSER_USE_CEILING.dayUsd,
    monthUsd: typeof month === "number" && month > 0 && month <= BROWSER_USE_CEILING.monthUsd ? month : BROWSER_USE_CEILING.monthUsd,
    // The floor can be raised. It cannot be lowered past $0.50.
    minBalanceUsd: typeof floor === "number" && Number.isFinite(floor) && floor >= BROWSER_USE_CEILING.minBalanceUsd ? floor : BROWSER_USE_CEILING.minBalanceUsd,
  };
}

/** A New York calendar day (`YYYY-MM-DD`) and month (`YYYY-MM`). */
export function nyPeriod(now: Date): { day: string; month: string } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const take = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const year = take("year");
  const month = take("month");
  const day = take("day");
  return { day: `${year}-${month}-${day}`, month: `${year}-${month}` };
}

export interface SpendState {
  dayUsd: number;
  monthUsd: number;
}

/**
 * Why a fallback must not start, or null when it may. Spend is checked
 * before the vendor balance. A balance that cannot be read refuses, the
 * same as a balance under the floor.
 */
export function capRefusal(spent: SpendState, balanceUsd: number | null, balanceFailed: boolean, caps: BrowserUseCaps): string | null {
  if (!Number.isFinite(spent.dayUsd) || !Number.isFinite(spent.monthUsd)) return "browser-use spend could not be read";
  if (spent.dayUsd >= caps.dayUsd) return `browser-use day cap reached ($${caps.dayUsd})`;
  if (spent.monthUsd >= caps.monthUsd) return `browser-use month cap reached ($${caps.monthUsd})`;
  if (balanceFailed || balanceUsd === null || !Number.isFinite(balanceUsd)) return "browser-use balance could not be read";
  if (balanceUsd < caps.minBalanceUsd) return `browser-use balance is under $${caps.minBalanceUsd}`;
  return null;
}

/** A URL's host, and only the host. A path or query can carry a search or an email. */
export function hostFromUrl(url: unknown): string {
  if (typeof url !== "string") return "";
  try {
    const host = new URL(url).hostname.toLowerCase();
    return HOST.test(host) ? host : "";
  } catch {
    return "";
  }
}

/** The first goto step's host, or empty when the call does not open a page. */
export function hostFromSteps(steps: unknown): string {
  if (!Array.isArray(steps)) return "";
  for (const step of steps) {
    if (step && typeof step === "object" && (step as { do?: unknown }).do === "goto") {
      const host = hostFromUrl((step as { url?: unknown }).url);
      if (host) return host;
    }
  }
  return "";
}

export type BrowseOutcome = "ok" | "site_blocked" | "vendor_refused" | "error";
export type BlockReason = "403" | "captcha" | "interstitial" | "stuck_submit";

export interface BrowseLogRow {
  at: number;
  kind: "job" | "call";
  provider: "cloudflare" | "browserbase" | "browser-use";
  host: string;
  outcome: BrowseOutcome;
  reason?: BlockReason;
  /** The site-block reason that made the gateway try a fallback, even when the fallback then succeeded. */
  trigger?: BlockReason;
  durationMs: number;
  bytes?: number;
  proxyMb?: number;
  costUsd?: number;
  fallback?: { ran: boolean; outcome?: string; costUsd?: number | null };
}

const OUTCOMES = new Set(["ok", "site_blocked", "vendor_refused", "error"]);
const REASONS = new Set(["403", "captcha", "interstitial", "stuck_submit"]);
const PROVIDERS = new Set(["cloudflare", "browserbase", "browser-use"]);

function money(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 10_000 ? n : undefined;
}

/** A log row as sent, or null when it is not one. Anything else in it is dropped. */
export function browseLogRow(raw: unknown, now = Date.now()): BrowseLogRow | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  if (row.kind !== "job" && row.kind !== "call") return null;
  if (typeof row.provider !== "string" || !PROVIDERS.has(row.provider)) return null;
  if (typeof row.outcome !== "string" || !OUTCOMES.has(row.outcome)) return null;
  const host = typeof row.host === "string" && HOST.test(row.host) ? row.host : "";
  const durationMs = typeof row.durationMs === "number" && Number.isFinite(row.durationMs) && row.durationMs >= 0 && row.durationMs <= 24 * 60 * 60 * 1000 ? Math.round(row.durationMs) : 0;
  const out: BrowseLogRow = { at: now, kind: row.kind, provider: row.provider as BrowseLogRow["provider"], host, outcome: row.outcome as BrowseOutcome, durationMs };
  if (typeof row.reason === "string" && REASONS.has(row.reason)) out.reason = row.reason as BlockReason;
  if (typeof row.trigger === "string" && REASONS.has(row.trigger)) out.trigger = row.trigger as BlockReason;
  const bytes = money(row.bytes);
  if (bytes !== undefined) out.bytes = Math.round(bytes);
  const proxyMb = money(row.proxyMb);
  if (proxyMb !== undefined) out.proxyMb = proxyMb;
  const costUsd = money(row.costUsd);
  if (costUsd !== undefined) out.costUsd = costUsd;
  if (row.fallback && typeof row.fallback === "object") {
    const fallback = row.fallback as Record<string, unknown>;
    if (typeof fallback.ran === "boolean") {
      const cost = fallback.costUsd === null ? null : money(fallback.costUsd);
      out.fallback = {
        ran: fallback.ran,
        ...(typeof fallback.outcome === "string" && fallback.outcome.length > 0 && fallback.outcome.length <= 40 ? { outcome: fallback.outcome } : {}),
        ...(cost !== undefined ? { costUsd: cost } : {}),
      };
    }
  }
  return out;
}

export interface BrowseLogSummary {
  jobs: number;
  /** Site blocks on job rows: the outcome, or the trigger that started a fallback. */
  blocks: number;
  byReason: Record<string, number>;
  /** Browser Use sessions that were actually started. */
  fallbacks: number;
  vendorRefused: number;
  fallbackCostUsd: number;
}

/**
 * Counts for the block rate and the fallback trial. Job rows are one per
 * browse tool call (a captcha ladder is one job, not one row per try). Call
 * rows are vendor refusals, Browser Use sessions, and a document-host 403
 * written after the answer when the fallback flag is off. A site-blocked
 * call row counts as a block. Fallbacks are the sessions that started.
 */
export function summarizeBrowseLog(rows: readonly BrowseLogRow[]): BrowseLogSummary {
  const byReason: Record<string, number> = {};
  let jobs = 0;
  let blocks = 0;
  let fallbacks = 0;
  let vendorRefused = 0;
  let fallbackCostUsd = 0;
  for (const row of rows) {
    if (row.kind === "job") {
      jobs += 1;
      const reason = row.outcome === "site_blocked" ? (row.reason ?? row.trigger) : row.trigger;
      if (row.outcome === "site_blocked" || row.trigger) {
        blocks += 1;
        const key = reason ?? "unknown";
        byReason[key] = (byReason[key] ?? 0) + 1;
      }
    }
    if (row.kind === "call" && row.outcome === "site_blocked") {
      blocks += 1;
      const key = row.reason ?? row.trigger ?? "unknown";
      byReason[key] = (byReason[key] ?? 0) + 1;
    }
    if (row.kind === "call" && row.provider === "browser-use") {
      fallbacks += 1;
      if (typeof row.costUsd === "number") fallbackCostUsd += row.costUsd;
    }
    if (row.outcome === "vendor_refused") vendorRefused += 1;
  }
  return {
    jobs,
    blocks,
    byReason,
    fallbacks,
    vendorRefused,
    fallbackCostUsd: Math.round(fallbackCostUsd * 1_000_000) / 1_000_000,
  };
}
