/**
 * The Tex dashboard's spend by day (tex.lc/admin): Cloudflare's billed figure
 * when it answered, else our own estimate from token counts. Pure. A day
 * Cloudflare no longer keeps is `null` and drawn as a gap, never as zero.
 */

import type { FunctionReturnType } from "convex/server";
import type { api } from "@context/convex/_generated/api";
import type { TexReport } from "./model";

export type TexSpend = FunctionReturnType<typeof api.functions.texSpend.report>;

const DAY_MS = 86_400_000;

function dayOf(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** Every day of the report's window, oldest first, ending on its last day. */
export function windowDayList(report: TexReport, now = Date.now()): string[] {
  const last = report.turns.byDay[report.turns.byDay.length - 1]?.day ?? dayOf(now);
  const end = Date.parse(`${last}T00:00:00Z`);
  return Array.from({ length: report.days }, (_, i) => dayOf(end - (report.days - 1 - i) * DAY_MS));
}

/** Real spend when Cloudflare answered, else our own estimate from token counts; null where neither knows. */
export function spendByDay(report: TexReport, spend: TexSpend | undefined, days: readonly string[]): { values: (number | null)[]; real: boolean } {
  if (spend !== undefined && spend.configured && spend.error === null) {
    const usd = new Map(spend.days.map((day) => [day.day, day.usd]));
    return { values: days.map((day) => (day < spend.keptFrom ? null : (usd.get(day) ?? null))), real: true };
  }
  const micro = new Map(report.turns.byDay.map((day) => [day.day, day.costMicroUsd / 1_000_000]));
  return { values: days.map((day) => micro.get(day) ?? null), real: false };
}
