/**
 * Meta (Facebook) Conversions API: the pure half — names, checks, the body.
 *
 * Dev2 asked (2026-10-05) for Meta ads to count sign-ups the way X ads do
 * (`lib/xConversion.ts`). The browser half is Meta's pixel in
 * `apps/mobile/public/index.html`, on context.lc's landing page only; this is
 * the server half, sent from the mutation that confirms the sign-up.
 *
 * What Meta receives about a person: a SHA-256 of their trimmed, lower-cased
 * email, and the `_fbc`/`_fbp` browser ids Meta's own pixel set, when the page
 * had them. Never the address, never anything about their notes. The token
 * travels in the request body, never in the URL.
 */

import { hashEmail } from "./xConversion";

export { hashEmail };

/**
 * The pixel (dataset) id from Meta Events Manager. Not a secret: the page
 * prints it. `null` sends nothing — the pixel in `public/index.html` carries
 * the same id, and a test pins the two together.
 */
export const META_PIXEL: { id: string | null } = { id: null };
export const META_CAPI_TOKEN_ENV_VAR = "META_CAPI_TOKEN";
export const META_GRAPH_VERSION = "v21.0";

export function metaEventsUrl(pixelId: string): string {
  return `https://graph.facebook.com/${META_GRAPH_VERSION}/${pixelId}/events`;
}

export function validPixelId(id: string | null): id is string {
  return id !== null && /^\d{6,20}$/.test(id);
}

export type MetaConversionKind = "waitlist" | "account";

/** Meta's standard events: joining the list is a lead, an account a registration. */
export const META_EVENT_NAMES: Record<MetaConversionKind, string> = {
  waitlist: "Lead",
  account: "CompleteRegistration",
};

/**
 * The `_fbc` click id (`fb.1.<ms>.<fbclid>`) and `_fbp` browser id
 * (`fb.1.<ms>.<random>`), as the browser reports them. A stranger supplies
 * both, so anything not shaped like one is dropped rather than forwarded.
 */
export function normalizeFbc(raw: string | undefined | null): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return /^fb\.\d\.\d{10,16}\.[A-Za-z0-9_-]{1,512}$/.test(trimmed) ? trimmed : null;
}

export function normalizeFbp(raw: string | undefined | null): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return /^fb\.\d\.\d{10,16}\.\d{1,24}$/.test(trimmed) ? trimmed : null;
}

export interface MetaConversion {
  token: string;
  eventName: string;
  at: number;
  /** Shared with the page's `fbq` event as its `eventID`, so Meta counts it once. */
  eventId: string;
  hashedEmail: string;
  fbc: string | null;
  fbp: string | null;
  sourceUrl: string | null;
}

export function metaConversionBody(conversion: MetaConversion): string {
  const userData: Record<string, unknown> = { em: [conversion.hashedEmail] };
  if (conversion.fbc !== null) userData.fbc = conversion.fbc;
  if (conversion.fbp !== null) userData.fbp = conversion.fbp;
  return JSON.stringify({
    data: [
      {
        event_name: conversion.eventName,
        event_time: Math.floor(conversion.at / 1000),
        event_id: conversion.eventId,
        action_source: "website",
        ...(conversion.sourceUrl === null ? {} : { event_source_url: conversion.sourceUrl }),
        user_data: userData,
      },
    ],
    access_token: conversion.token,
  });
}
