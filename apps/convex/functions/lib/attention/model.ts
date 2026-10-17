/**
 * Getting the person's attention, the control plane's half: how often, and
 * when (`docs/decisions/texting-assistant/attention.md`).
 *
 * Asked for by the owner (Dev2), 2026-10-17: "a grab my attention sort of
 * agent … strict on only grabbing my attention in emergencies or should learn
 * my tolerance … if i ask for a message back once a feature is in prod, an
 * agent can pull that lever."
 *
 * Any of the person's own agents may ask (`send` action `notify` on the
 * gateway). Whether a ping is worth a text at all is the person's say, in
 * `tex/attention.md`, and is decided on the gateway before anything reaches
 * here. This file decides only what no agent may: how many a day, how far
 * apart, and never at night unless it is an emergency.
 */

import { wallClock } from "@context/shared/src/routines.cjs";
import { nextRunFor } from "../routines/model";

/**
 * How urgent an agent says a ping is. `emergency`: something is broken or at
 * risk and they would want to know now. `asked`: they asked to be told ("text
 * me when it ships"). `fyi`: anything else, which a strict tolerance holds.
 */
export const ATTENTION_URGENCIES = ["emergency", "asked", "fyi"] as const;
export type AttentionUrgency = (typeof ATTENTION_URGENCIES)[number];

export function isAttentionUrgency(value: unknown): value is AttentionUrgency {
  return typeof value === "string" && (ATTENTION_URGENCIES as readonly string[]).includes(value);
}

/** Pings that are not emergencies, accepted in one local day. */
export const DAILY_PINGS = 5;
/** Emergencies accepted in one local day, on top of those. */
export const DAILY_EMERGENCIES = 3;
/** An ordinary ping waits at least this long after the last one reached them; several waiting go in one text. */
export const PING_SPACING_MS = 10 * 60 * 1000;
/** Night, in their own zone: an ordinary ping waits for the morning. */
export const QUIET_FROM_HOUR = 22;
export const QUIET_UNTIL = { hour: 8, minute: 0 } as const;
/**
 * No ping is due sooner than this after it is asked for: the gateway logs it
 * in `tex/attention/` right after the control plane answers, and a delivery
 * that ran first would find nothing waiting and drop it.
 */
export const ASK_SETTLE_MS = 30 * 1000;
/** Deliveries in a row that may fail before the waiting pings are given up. */
export const MAX_DELIVERY_TRIES = 3;
/** How long a failed delivery waits before it is tried again. */
export const RETRY_AFTER_MS = 10 * 60 * 1000;

const pad = (value: number) => String(value).padStart(2, "0");

/** `YYYY-MM-DD` of `now` in `timeZone`. */
export function localDay(now: number, timeZone: string): string {
  const w = wallClock(now, timeZone);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

/** Whether `now` is night in `timeZone`. */
export function isQuietHour(now: number, timeZone: string): boolean {
  const { hour } = wallClock(now, timeZone);
  return hour >= QUIET_FROM_HOUR || hour < QUIET_UNTIL.hour;
}

/**
 * When a ping asked for at `now` may be texted: an emergency at once; an
 * ordinary one at once by day, spaced `PING_SPACING_MS` after the last ping
 * that reached them, and at 8:00 their time when asked at night. "At once"
 * is `ASK_SETTLE_MS` away.
 */
export function pingDueAt(
  urgency: AttentionUrgency,
  now: number,
  timeZone: string,
  lastTextedAt: number | undefined,
): number {
  const soonest = now + ASK_SETTLE_MS;
  if (urgency === "emergency") return soonest;
  if (isQuietHour(now, timeZone)) {
    const morning = nextRunFor({ cadence: { unit: "day", every: 1 }, at: QUIET_UNTIL, paused: false }, timeZone, now);
    return Math.max(soonest, morning ?? soonest);
  }
  return Math.max(soonest, (lastTextedAt ?? 0) + PING_SPACING_MS);
}
