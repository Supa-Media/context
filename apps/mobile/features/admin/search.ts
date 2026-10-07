/**
 * The words and numbers for the Search tab (`./SearchSection`), over
 * `searchReport` (`apps/convex/functions/lib/adminFns/searchReport.ts`).
 */

import type { FunctionReturnType } from "convex/server";
import type { api } from "@context/convex/_generated/api";

export type SearchReport = FunctionReturnType<typeof api.functions.admin.searchReport>;
export type SearchView = SearchReport["view"];
export type SearchAnsweredBy = SearchReport["answeredBy"][number]["answeredBy"];
export type SearchSurface = SearchReport["slowest"][number]["surface"];

/** How long the log keeps a row (`searchTimings`' retention sweep). */
export const SEARCH_RETENTION_DAYS = 30;

export const SEARCH_WINDOWS: readonly { key: "1" | "7" | "30"; label: string }[] = [
  { key: "1", label: "24 hours" },
  { key: "7", label: "7 days" },
  { key: "30", label: "30 days" },
];

/** The three views, in the order the tiles show them, and what each one measures. */
export const SEARCH_VIEWS: readonly { key: SearchView; label: string; detail: string }[] = [
  { key: "screen", label: "In the app", detail: "From asking to the answer arriving, timed on their device" },
  { key: "app", label: "App, on our side", detail: "The same searches, measured on our servers" },
  { key: "ai", label: "AI clients", detail: "Claude, ChatGPT and the texting assistant" },
];

export function viewLabel(view: SearchView): string {
  return SEARCH_VIEWS.find((entry) => entry.key === view)?.label ?? view;
}

/** `240 ms` under a second, `1.4 s` under ten, `12 s` past that; a dash for nothing measured. */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 1000)} s`;
}

const ANSWERED_BY_LABELS: Record<SearchAnsweredBy, string> = {
  fast: "Fast search",
  index: "Index in the bucket",
  scan: "Reading notes one by one",
  none: "No index yet",
  failed: "Failed or timed out",
};

export function answeredByLabel(answeredBy: SearchAnsweredBy | null): string {
  return answeredBy === null ? "—" : ANSWERED_BY_LABELS[answeredBy];
}

export function surfaceLabel(surface: SearchSurface): string {
  switch (surface) {
    case "screen":
      return "App, on screen";
    case "app":
      return "App search";
    case "page":
      return "Search page";
    case "ai":
      return "AI client";
  }
}

function periodBefore(days: number): string {
  return days === 1 ? "the day before" : `the ${days} days before`;
}

/**
 * An average against the window before, as a sentence and a tone: faster is
 * good news, slower is bad. Within a twentieth of a second is the same.
 */
export function averageChange(
  current: { count: number; avg: number },
  prior: { count: number; avg: number },
  days: number,
): { text: string; tone: "ok" | "crit" | "neutral" } {
  if (prior.count === 0 || current.count === 0) return { text: `Nothing to compare with ${periodBefore(days)}`, tone: "neutral" };
  const diff = current.avg - prior.avg;
  if (Math.abs(diff) < 50) return { text: `Same as ${periodBefore(days)}`, tone: "neutral" };
  const amount = formatMs(Math.abs(diff));
  return diff < 0
    ? { text: `${amount} faster than ${periodBefore(days)}`, tone: "ok" }
    : { text: `${amount} slower than ${periodBefore(days)}`, tone: "crit" };
}

/** The report's buckets in the shape the shared time chart draws. */
export function chartBuckets(buckets: SearchReport["buckets"]): { label: string; turns: number; p50: number; p95: number }[] {
  return buckets.map((bucket) => ({ label: bucket.label, turns: bucket.count, p50: bucket.p50, p95: bucket.p95 }));
}
