/**
 * Sign-up conversions for Meta ads (Dev2, 2026-10-05): one Conversions API
 * call per new waitlist row (`Lead`) and per brand-new account
 * (`CompleteRegistration`), beside the X ones (`xConversions.ts`).
 *
 * Scheduled from inside the mutation that made the sign-up, so it is sent only
 * if the sign-up commits, and only on a deployment with a `META_CAPI_TOKEN`
 * and a pixel id (`lib/metaConversion.ts`). Everywhere else nothing is
 * scheduled. Bounded by what bounds the sign-ups themselves.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, internalQuery, type MutationCtx } from "../_generated/server";
import { validAppOrigin } from "./lib/invitationEmail";
import {
  hashEmail,
  META_CAPI_TOKEN_ENV_VAR,
  META_EVENT_NAMES,
  META_PIXEL,
  metaConversionBody,
  metaEventsUrl,
  normalizeFbc,
  normalizeFbp,
  validPixelId,
} from "./lib/metaConversion";
import { waitlistConversionId } from "./lib/xConversion";

const conversionValidator = v.union(
  v.object({
    kind: v.literal("waitlist"),
    waitlistId: v.id("waitlist"),
    fbc: v.optional(v.string()),
    fbp: v.optional(v.string()),
  }),
  v.object({ kind: v.literal("account"), userId: v.id("users") }),
);
type Conversion =
  | { kind: "waitlist"; waitlistId: Id<"waitlist">; fbc?: string; fbp?: string }
  | { kind: "account"; userId: Id<"users"> };

function token(): string | null {
  const value = process.env[META_CAPI_TOKEN_ENV_VAR];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function pixelId(): string | null {
  const id = META_PIXEL.id;
  return validPixelId(id) ? id : null;
}

export async function scheduleMetaConversion(ctx: MutationCtx, conversion: Conversion): Promise<void> {
  if (token() === null || pixelId() === null) return;
  let scheduled: Conversion = conversion;
  if (conversion.kind === "waitlist") {
    const fbc = normalizeFbc(conversion.fbc);
    const fbp = normalizeFbp(conversion.fbp);
    scheduled = {
      kind: "waitlist",
      waitlistId: conversion.waitlistId,
      ...(fbc === null ? {} : { fbc }),
      ...(fbp === null ? {} : { fbp }),
    };
  }
  await ctx.scheduler.runAfter(0, internal.functions.metaConversions.send, { conversion: scheduled, at: Date.now() });
}

/** The address to hash. `null` when the row has gone since, or has none. */
export const emailFor = internalQuery({
  args: { conversion: conversionValidator },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, { conversion }) => {
    if (conversion.kind === "waitlist") {
      const row = await ctx.db.get(conversion.waitlistId);
      return row?.email ?? null;
    }
    const user = await ctx.db.get(conversion.userId);
    return typeof user?.email === "string" && user.email.length > 0 ? user.email : null;
  },
});

/** Logs the outcome by kind and status only: never the address, hash or token. */
export const send = internalAction({
  args: { conversion: conversionValidator, at: v.number() },
  returns: v.null(),
  handler: async (ctx, { conversion, at }) => {
    const log = (event: string, extra: Record<string, unknown> = {}) =>
      console.log(JSON.stringify({ event: `meta_conversion_${event}`, kind: conversion.kind, ...extra }));
    const capiToken = token();
    const pixel = pixelId();
    if (capiToken === null || pixel === null) {
      log("skipped", { reason: "unconfigured" });
      return null;
    }
    const email = await ctx.runQuery(internal.functions.metaConversions.emailFor, { conversion });
    if (email === null) return null;
    const origin = validAppOrigin();
    const waitlist = conversion.kind === "waitlist";
    const body = metaConversionBody({
      token: capiToken,
      eventName: META_EVENT_NAMES[conversion.kind],
      at,
      eventId: waitlist ? waitlistConversionId(conversion.waitlistId) : `account-${conversion.userId}`,
      hashedEmail: await hashEmail(email),
      fbc: waitlist ? normalizeFbc(conversion.fbc) : null,
      fbp: waitlist ? normalizeFbp(conversion.fbp) : null,
      sourceUrl: waitlist && origin !== null ? new URL("/", origin).toString() : null,
    });
    try {
      const response = await fetch(metaEventsUrl(pixel), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      log(response.ok ? "sent" : "failed", response.ok ? {} : { status: response.status });
    } catch {
      log("failed", { reason: "transport_error" });
    }
    return null;
  },
});
