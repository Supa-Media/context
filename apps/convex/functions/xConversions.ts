/**
 * Sign-up conversions for X ads (Dev2, 2026-10-05): one Conversion API call
 * per new waitlist row and per brand-new account.
 *
 * Scheduled from inside the mutation that made the sign-up, so it is sent only
 * if the sign-up commits, and only on a deployment that has both an
 * `X_PIXEL_TOKEN` and an event id for that kind (`lib/xConversion.ts`).
 * Everywhere else — staging, tests, a self-hoster — nothing is scheduled.
 * Bounded by what bounds the sign-ups themselves: a waitlist row is one per
 * address and capped per hour (`waitlist.enter`), an account one per person.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, internalQuery, type MutationCtx } from "../_generated/server";
import { validAppOrigin } from "./lib/invitationEmail";
import {
  conversionBody,
  hashEmail,
  normalizeTwclid,
  validEventId,
  waitlistConversionId,
  X_CONVERSIONS_URL,
  X_EVENT_IDS,
  X_PIXEL_TOKEN_ENV_VAR,
  type XConversionKind,
} from "./lib/xConversion";

const conversionValidator = v.union(
  v.object({ kind: v.literal("waitlist"), waitlistId: v.id("waitlist"), twclid: v.optional(v.string()) }),
  v.object({ kind: v.literal("account"), userId: v.id("users") }),
);
type Conversion =
  | { kind: "waitlist"; waitlistId: Id<"waitlist">; twclid?: string }
  | { kind: "account"; userId: Id<"users"> };

function token(): string | null {
  const value = process.env[X_PIXEL_TOKEN_ENV_VAR];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function eventIdFor(kind: XConversionKind): string | null {
  const id = X_EVENT_IDS[kind];
  return validEventId(id) ? id : null;
}

export async function scheduleXConversion(ctx: MutationCtx, conversion: Conversion): Promise<void> {
  if (token() === null || eventIdFor(conversion.kind) === null) return;
  const scheduled: Conversion =
    conversion.kind === "waitlist"
      ? { kind: "waitlist", waitlistId: conversion.waitlistId, ...twclidField(conversion.twclid) }
      : conversion;
  await ctx.scheduler.runAfter(0, internal.functions.xConversions.send, { conversion: scheduled, at: Date.now() });
}

function twclidField(raw: string | undefined): { twclid?: string } {
  const twclid = normalizeTwclid(raw);
  return twclid === null ? {} : { twclid };
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
      console.log(JSON.stringify({ event: `x_conversion_${event}`, kind: conversion.kind, ...extra }));
    const pixelToken = token();
    const eventId = eventIdFor(conversion.kind);
    if (pixelToken === null || eventId === null) {
      log("skipped", { reason: "unconfigured" });
      return null;
    }
    const email = await ctx.runQuery(internal.functions.xConversions.emailFor, { conversion });
    if (email === null) return null;
    const origin = validAppOrigin();
    const body = conversionBody({
      eventId,
      at,
      conversionId: conversion.kind === "waitlist" ? waitlistConversionId(conversion.waitlistId) : `account-${conversion.userId}`,
      hashedEmail: await hashEmail(email),
      twclid: conversion.kind === "waitlist" ? normalizeTwclid(conversion.twclid) : null,
      sourceUrl: conversion.kind === "waitlist" && origin !== null ? new URL("/", origin).toString() : null,
    });
    try {
      const response = await fetch(X_CONVERSIONS_URL, {
        method: "POST",
        headers: { "X-Pixel-Token": pixelToken, "Content-Type": "application/json" },
        body,
      });
      log(response.ok ? "sent" : "failed", response.ok ? {} : { status: response.status });
    } catch {
      log("failed", { reason: "transport_error" });
    }
    return null;
  },
});
