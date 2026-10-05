/**
 * X (Twitter) Conversion API: the pure half — names, hashing, the request body.
 *
 * Dev2 asked (2026-10-05) for X ads to count sign-ups. The browser half is the
 * pixel in `apps/mobile/public/index.html`, loaded on context.lc's landing
 * page only; this is the server half, sent from the mutation that confirms
 * the sign-up, never from the browser. See `functions/xConversions.ts`.
 *
 * What X receives about a person is a SHA-256 of their trimmed, lower-cased
 * email and, when they arrived from an X ad, that ad's click id. Never the
 * address itself, and never anything about their notes.
 */

export const X_PIXEL_ID = "rgib5";
export const X_CONVERSIONS_URL = `https://ads-api.x.com/12/measurement/conversions/${X_PIXEL_ID}`;
export const X_PIXEL_TOKEN_ENV_VAR = "X_PIXEL_TOKEN";

export type XConversionKind = "waitlist" | "account";

/**
 * The event each sign-up is reported as, copied from X Events Manager
 * (`tw-rgib5-…`). `null` sends nothing for that kind: an event X has not been
 * told about is rejected, and guessing one would count sign-ups under the
 * wrong name.
 */
export const X_EVENT_IDS: Record<XConversionKind, string | null> = {
  waitlist: null,
  account: null,
};

const EVENT_ID = new RegExp(`^tw-${X_PIXEL_ID}-[a-z0-9]+$`);

export function validEventId(id: string | null): id is string {
  return id !== null && EVENT_ID.test(id);
}

/**
 * The `twclid` an X ad adds to the landing URL, as the browser reports it.
 * A stranger supplies this, so anything that is not a plausible click id is
 * dropped rather than forwarded.
 */
export function normalizeTwclid(raw: string | undefined | null): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return /^[A-Za-z0-9_-]{1,256}$/.test(trimmed) ? trimmed : null;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** X's rule for emails: trim and lower-case, then hash. */
export function hashEmail(email: string): Promise<string> {
  return sha256Hex(email.trim().toLowerCase());
}

export interface XConversion {
  eventId: string;
  at: number;
  /** Stable per sign-up, so a retry or a matching pixel event counts once. */
  conversionId: string;
  hashedEmail: string;
  twclid: string | null;
  sourceUrl: string | null;
}

export function conversionBody(conversion: XConversion): string {
  const identifier: Record<string, string> = { hashed_email: conversion.hashedEmail };
  if (conversion.twclid !== null) identifier.twclid = conversion.twclid;
  return JSON.stringify({
    conversions: [
      {
        conversion_time: new Date(conversion.at).toISOString(),
        event_id: conversion.eventId,
        ...(conversion.sourceUrl === null ? {} : { event_source_url: conversion.sourceUrl }),
        conversion_id: conversion.conversionId,
        identifiers: [identifier],
      },
    ],
  });
}
