/**
 * The AI costs tab's arithmetic and words: what the cost figures say, in a
 * sentence a person reads without knowing a feature's id or a model's name.
 *
 * Pure functions, like `./report` and `./agent`, so every number on the tab is
 * checked in `__tests__/adminAiCosts.test.ts` without mounting anything. The
 * shapes come from `apps/convex/functions/lib/adminFns/aiCostsShape.ts`.
 *
 * Money here is US dollars as a float, as the shape sends it. A figure is only
 * ever shown rounded; the sums are taken before rounding.
 */

import {
  modelLabel,
  type AiCostsCloudflare,
  type AiCostsReport,
} from "@context/convex/functions/lib/adminFns/aiCostsShape";
import { formatCount, type SegmentTone } from "./report";

// -- features -------------------------------------------------------------

/** Whisper: meeting transcription, metered by Cloudflare, with no account behind it. */
export const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";
/** bge-m3: search by meaning, metered by Cloudflare, with no account behind it. */
export const BGE_MODEL = "@cf/baai/bge-m3";

/**
 * Every feature the tab knows, in the one fixed order its colours are taken
 * in. A feature the list does not name still shows, after these, in grey.
 */
export const FEATURE_ORDER = [
  "assistant",
  "whatChanged",
  "organizer",
  "ownerSuggest",
  "transcription",
  "meaning",
] as const;

/** One colour per feature, from the console's own series palette (`./Charts`). */
const FEATURE_TONES: Readonly<Record<string, SegmentTone>> = {
  assistant: "accent",
  whatChanged: "shared",
  organizer: "muted",
  ownerSuggest: "ok",
  transcription: "warn",
  meaning: "crit",
};

/** What a person calls each feature. Anything else keeps the server's label. */
const FEATURE_NAMES: Readonly<Record<string, string>> = {
  assistant: "Texting assistant",
  whatChanged: "What changed",
  organizer: "Auto-organize",
  ownerSuggest: "Owner suggestion",
  transcription: "Meeting transcription",
  meaning: "Search by meaning",
  meetingSummary: "Meeting summaries",
};

/** Features no account pays for: Cloudflare meters them, nobody's plan does. */
const NO_ACCOUNT_FEATURES: ReadonlySet<string> = new Set(["transcription", "meaning"]);

export function featureTone(feature: string): SegmentTone {
  return FEATURE_TONES[feature] ?? "muted";
}

export function featureName(feature: string, serverLabel?: string): string {
  return FEATURE_NAMES[feature] ?? serverLabel ?? feature;
}

/** A feature's place in `FEATURE_ORDER`; unknown features come last. */
export function featureRank(feature: string): number {
  const index = (FEATURE_ORDER as readonly string[]).indexOf(feature);
  return index === -1 ? FEATURE_ORDER.length : index;
}

/** A row of the By feature table, with the Cloudflare-only rows merged in. */
export interface FeatureRow {
  feature: string;
  label: string;
  tone: SegmentTone;
  models: string[];
  uses: number;
  /** What one use is, in words; empty when a feature has no count. */
  unit: string;
  eachUsd: number | null;
  costUsd: number;
  /** True for a feature no account pays for: the "no account" pill. */
  noAccount: boolean;
}

type ReportFeature = AiCostsReport["features"][number];

/**
 * The feature list the table draws: the report's features, plus the two
 * Cloudflare-only ones when Cloudflare is configured, most expensive first.
 *
 * Cloudflare's own figures only fill a feature the report did not already
 * carry, so a report that does count transcription itself is never doubled.
 * With Cloudflare unconfigured (or still loading) nothing is added.
 */
export function mergeFeatures(
  features: readonly ReportFeature[],
  cloudflare: AiCostsCloudflare | undefined,
): FeatureRow[] {
  const rows = features.map((feature) => toRow(feature.feature, feature.label, feature.models, feature.uses, feature.unit, feature.eachUsd, feature.costUsd));
  if (cloudflare?.configured === true) {
    const have = new Set(rows.map((row) => row.feature));
    const only: [string, string, string][] = [
      ["transcription", "Meeting transcription", WHISPER_MODEL],
      ["meaning", "Search by meaning", BGE_MODEL],
    ];
    for (const [feature, label, model] of only) {
      if (have.has(feature)) continue;
      const usd = cloudflareUsd(cloudflare, model);
      const requests = cloudflare.gateway
        .filter((entry) => entry.model === model)
        .reduce((sum, entry) => sum + entry.requests, 0);
      rows.push(
        toRow(feature, label, [model], requests, requests > 0 ? "requests" : "", requests > 0 ? usd / requests : null, usd),
      );
    }
  }
  return rows.sort((a, b) => b.costUsd - a.costUsd || featureRank(a.feature) - featureRank(b.feature));
}

function toRow(
  feature: string,
  serverLabel: string,
  models: readonly string[],
  uses: number,
  unit: string,
  eachUsd: number | null,
  costUsd: number,
): FeatureRow {
  return {
    feature,
    label: featureName(feature, serverLabel),
    tone: featureTone(feature),
    models: [...models],
    uses,
    unit,
    eachUsd,
    costUsd,
    noAccount: NO_ACCOUNT_FEATURES.has(feature),
  };
}

/** What Cloudflare billed one model, Workers AI and AI Gateway together. */
function cloudflareUsd(cloudflare: Extract<AiCostsCloudflare, { configured: true }>, model: string): number {
  const workers = cloudflare.workersAi.filter((entry) => entry.model === model).reduce((sum, entry) => sum + entry.usd, 0);
  const gateway = cloudflare.gateway.filter((entry) => entry.model === model).reduce((sum, entry) => sum + entry.costUsd, 0);
  return workers + gateway;
}

/** The biggest feature and its share of everything the table adds up to. */
export function mostExpensive(rows: readonly FeatureRow[]): { label: string; costUsd: number; percent: number } | null {
  const total = rows.reduce((sum, row) => sum + row.costUsd, 0);
  const top = rows.reduce<FeatureRow | null>((best, row) => (best === null || row.costUsd > best.costUsd ? row : best), null);
  if (top === null || top.costUsd <= 0 || total <= 0) return null;
  return { label: top.label, costUsd: top.costUsd, percent: Math.round((top.costUsd / total) * 100) };
}

/** Each uses-count, in words: `412 questions`, or a dash for a feature with none. */
export function usesLine(uses: number, unit: string): string {
  return unit !== "" && uses > 0 ? `${formatCount(uses)} ${unit}` : "—";
}

/** The models a feature ran on, by their names: `Clef + GLM-4.7 Flash`. */
export function modelNames(models: readonly string[]): string {
  return models.length === 0 ? "—" : models.map((model) => modelLabel(model)).join(" + ");
}

// -- the Cloudflare check -------------------------------------------------

export interface CheckLine {
  billedUsd: number;
  linkedUsd: number;
  notLinkedUsd: number;
  /** `billed $3.27 · $1.94 linked to an account · $1.33 not linked`. */
  text: string;
}

/**
 * What Cloudflare billed, split into what an account paid for and what no
 * account did. "Linked" is every feature a person's plan covers.
 */
export function checkLine(rows: readonly FeatureRow[], billedUsd: number): CheckLine {
  const linkedUsd = rows.filter((row) => !row.noAccount).reduce((sum, row) => sum + row.costUsd, 0);
  const notLinkedUsd = rows.filter((row) => row.noAccount).reduce((sum, row) => sum + row.costUsd, 0);
  return {
    billedUsd,
    linkedUsd,
    notLinkedUsd,
    text: `billed ${formatDollars(billedUsd)} · ${formatDollars(linkedUsd)} linked to an account · ${formatDollars(notLinkedUsd)} not linked`,
  };
}

// -- money and change -----------------------------------------------------

/**
 * Dollars, the way a person writes them.
 *
 * `$3.27`, `$1.29`, `$5` for a whole number, `$1,234.50`. Under a cent the
 * price keeps two significant digits and no padding: `$0.0018`, `$0.0002`.
 * Zero is `$0`, and a value that is not a number is a dash, never `$NaN`.
 */
export function formatDollars(usd: number): string {
  if (!Number.isFinite(usd)) return "—";
  if (usd === 0) return "$0";
  const sign = usd < 0 ? "−" : "";
  const value = Math.abs(usd);
  if (value < 0.01) return `${sign}$${subCent(value)}`;
  const cents = Math.round(value * 100) / 100;
  if (Number.isInteger(cents)) return `${sign}$${cents.toLocaleString("en-US")}`;
  return `${sign}$${cents.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Two significant digits, with the trailing zeros a fixed width would add dropped. */
function subCent(value: number): string {
  const decimals = 1 - Math.floor(Math.log10(value));
  return value.toFixed(decimals).replace(/(\.\d*?)0+$/, "$1");
}

/** `the 30 days before`, or `the day before` for a one-day window. */
function periodBefore(days: number): string {
  return days === 1 ? "the day before" : `the ${days} days before`;
}

/** Spend against the window before, in signed dollars. */
export function changeLine(total: number, prior: number, days: number): string {
  const diff = roundCents(total - prior);
  if (diff === 0) return `Same as ${periodBefore(days)}`;
  return `${diff > 0 ? "+" : "−"}${formatDollars(Math.abs(diff))} vs ${periodBefore(days)}`;
}

/** A rise in spend is a warning; a fall is good news; a cent either way is neutral. */
export function changeTone(total: number, prior: number): "warn" | "ok" | "neutral" {
  const diff = roundCents(total - prior);
  if (diff > 0) return "warn";
  if (diff < 0) return "ok";
  return "neutral";
}

function roundCents(usd: number): number {
  return Math.round(usd * 100) / 100;
}

/** `12% of the $5 plan`; null when the account pays nothing, so there is no plan to measure against. */
export function planShareLine(costUsd: number, planUsd: number | null): string | null {
  if (planUsd === null || planUsd <= 0) return null;
  return `${Math.round((costUsd / planUsd) * 100)}% of the ${formatDollars(planUsd)} plan`;
}

/** The sub-line of the "Per paying account" tile. */
export function perAccountLine(payingAccounts: number): string {
  return `linked spend ÷ ${payingAccounts} paying ${payingAccounts === 1 ? "account" : "accounts"}`;
}

/** `$1.29 · 39% of the total`: the most expensive feature's sub-line. */
export function mostExpensiveLine(top: { costUsd: number; percent: number }): string {
  return `${formatDollars(top.costUsd)} · ${top.percent}% of the total`;
}

// -- the days -------------------------------------------------------------

export interface StackedDay {
  day: string;
  total: number;
  /** The day's total as a fraction of the tallest day. */
  height: number;
  /** Non-zero features that day, in `FEATURE_ORDER`. */
  segments: { feature: string; tone: SegmentTone; costUsd: number }[];
}

/** One bar per day, each stacked by feature, scaled to the tallest day. */
export function stackedDays(daily: AiCostsReport["daily"]): StackedDay[] {
  const totals = daily.map((entry) => entry.byFeature.reduce((sum, item) => sum + item.costUsd, 0));
  const tallest = totals.reduce((best, total) => Math.max(best, total), 0);
  return daily.map((entry, index) => ({
    day: entry.day,
    total: totals[index],
    height: tallest > 0 ? totals[index] / tallest : 0,
    segments: entry.byFeature
      .filter((item) => item.costUsd > 0)
      .sort((a, b) => featureRank(a.feature) - featureRank(b.feature))
      .map((item) => ({ feature: item.feature, tone: featureTone(item.feature), costUsd: item.costUsd })),
  }));
}

/** `tallest day $0.41`, or a plain statement when nothing was spent. */
export function tallestDayLine(daily: AiCostsReport["daily"]): string {
  const tallest = stackedDays(daily).reduce<StackedDay | null>(
    (best, day) => (day.total > 0 && (best === null || day.total > best.total) ? day : best),
    null,
  );
  return tallest === null ? "no spend in this window" : `tallest day ${formatDollars(tallest.total)}`;
}

// -- accounts -------------------------------------------------------------

/** One account's bar: each feature's share of its own spend, in feature order. */
export interface SplitPart {
  feature: string;
  tone: SegmentTone;
  fraction: number;
}

export function splitByFeature(byFeature: readonly { feature: string; costUsd: number }[]): SplitPart[] {
  const total = byFeature.reduce((sum, item) => sum + item.costUsd, 0);
  if (total <= 0) return [];
  return byFeature
    .filter((item) => item.costUsd > 0)
    .sort((a, b) => featureRank(a.feature) - featureRank(b.feature))
    .map((item) => ({ feature: item.feature, tone: featureTone(item.feature), fraction: item.costUsd / total }));
}

/** A capped feature's use today, as a sentence and a fraction of the cap. */
export function todayLine(item: { feature: string; label: string; used: number; cap: number }): {
  text: string;
  fraction: number;
} {
  const fraction = item.cap > 0 ? Math.min(item.used / item.cap, 1) : 0;
  return {
    text: `${featureName(item.feature, item.label)} today: ${formatCount(item.used)} of ${formatCount(item.cap)} ${todayUnit(item.feature)}`,
    fraction,
  };
}

/** What a capped feature counts, in words. */
export function todayUnit(feature: string): string {
  if (feature === "assistant") return "questions";
  if (feature === "whatChanged") return "new items";
  return "uses";
}

/** `@maya`, with the @ once. */
export function workspaceLabel(workspace: string): string {
  return workspace.startsWith("@") ? workspace : `@${workspace}`;
}

/** `34 / 100`: an account's questions today, against the cap. */
export function questionsLine(used: number, cap: number): string {
  return `${formatCount(used)} / ${formatCount(cap)}`;
}

/** The account's plan, and what it pays a month when it pays. */
export function planHeadline(plan: string, planUsd: number | null): string {
  return planUsd === null || planUsd <= 0 ? plan : `${plan} · pays ${formatDollars(planUsd)} a month`;
}

/** `+ 6 more accounts`. */
export function moreAccountsLine(count: number): string {
  return `+ ${formatCount(count)} more ${count === 1 ? "account" : "accounts"}`;
}

/**
 * A unit price (dollars per million tokens): at least two decimals, so `$0.40`
 * keeps its zero, and two significant digits below a dollar, so `$0.012` is
 * not rounded to a cent it does not have.
 */
export function formatUnitPrice(usd: number): string {
  if (!Number.isFinite(usd)) return "—";
  if (usd === 0) return "$0";
  if (usd >= 1) return formatDollars(usd);
  let text = usd.toFixed(Math.max(2, 1 - Math.floor(Math.log10(usd))));
  while (text.endsWith("0") && text.length - text.indexOf(".") - 1 > 2) text = text.slice(0, -1);
  return `$${text}`;
}

/** A model's price per million tokens, in and out. */
export function priceLine(price: { input: number; output: number } | null): string {
  if (price === null) return "—";
  return `${formatUnitPrice(price.input)} in · ${formatUnitPrice(price.output)} out`;
}
