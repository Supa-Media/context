/**
 * Letting somebody in puts their phone on Tex's list (Dev2, 2026-10-17:
 * "letting someone off the wait list automatically puts them into that
 * list"). The list is the Linq shared line's contacts, twenty at most, and a
 * number off it never reaches Tex (`lib/adminFns/texAllowlist.ts`).
 *
 * The phone is the row's own, for a row joined with a phone, or else the
 * proven phone of the account its address signs in to. An address with no
 * phone yet is put on later, when that person confirms one in the app
 * (`phoneCheck.recordConfirmedPhone`). Texting Tex to link a phone cannot be
 * the moment, because a number off the list cannot text Tex at all.
 *
 * Never fails the Let in: a full list, a line with no list, or Linq being
 * down is logged and put on the admin trail under the staff member who let
 * the row in, and staff free a slot or add the number from Tex access. Only
 * a row still admitted is added, so one removed since Let in is not.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
  type QueryCtx,
} from "../_generated/server";
import { addToLinqLineAt } from "./lib/adminFns/texAllowlist";
import { recordAdminAudit } from "./lib/adminFns/audit";
import { confirmedEmailsOf, currentPhoneOf } from "./lib/emailProof";

export const texFacts = internalQuery({
  args: { waitlistId: v.id("waitlist") },
  returns: v.union(v.null(), v.object({ phone: v.union(v.string(), v.null()) })),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.waitlistId);
    if (row === null || row.status !== "admitted") return null;
    if (row.phone !== undefined) return { phone: row.phone };
    if (row.email === undefined) return { phone: null };
    const users = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", row.email))
      .take(2);
    // Only an account that proved this address: anybody can type one in.
    const user = users.find((candidate) => candidate.emailVerificationTime !== undefined);
    return { phone: user === undefined ? null : await currentPhoneOf(ctx, user) };
  },
});

/** The trail entry, under whoever let the row in. Last four digits only. */
export const recordOutcome = internalMutation({
  args: { waitlistId: v.id("waitlist"), phone: v.string(), outcome: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.waitlistId);
    const staff = row?.admittedBy === undefined ? null : await ctx.db.get(row.admittedBy);
    if (staff === null || staff.email === undefined) return null;
    const actor = { userId: staff._id, email: staff.email };
    const details = { phone: args.phone.slice(-4), via: "waitlist", outcome: args.outcome };
    const action = args.outcome === "added" ? "tex.allowlist_added" : "tex.allowlist_refused";
    await recordAdminAudit(ctx, actor, action, "tex", details);
    return null;
  },
});

/**
 * Put the admitted row's phone on the list, and say the line's number when
 * the phone is on it (added now, or already), else `null`. Never throws.
 */
export async function putOnTexLine(
  ctx: ActionCtx,
  waitlistId: Id<"waitlist">,
  phone?: string,
): Promise<string | null> {
  const log = (event: string, extra: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ event: `waitlist_tex_${event}`, waitlistId, ...extra }));
  try {
    const facts = await ctx.runQuery(internal.functions.waitlistTex.texFacts, { waitlistId });
    const number = phone ?? facts?.phone ?? null;
    if (facts === null || number === null) return null;
    if (!process.env.LINQ_API_KEY?.trim()) {
      log("skipped", { reason: "linq_not_connected" });
      return null;
    }
    const { change, line, unlimited } = await addToLinqLineAt({ LINQ_API_KEY: process.env.LINQ_API_KEY }, number);
    // A paid line has no list to be on, and "already" changed nothing.
    if (unlimited || change.status === "already") {
      log(unlimited ? "unlimited" : "already");
      return line;
    }
    log(change.status, change.status === "error" ? { reason: change.error } : {});
    await ctx.runMutation(internal.functions.waitlistTex.recordOutcome, {
      waitlistId,
      phone: number,
      outcome: change.status,
    });
    return change.status === "added" ? line : null;
  } catch {
    log("failed", { reason: "unexpected" });
    return null;
  }
}

/**
 * The admitted waitlist row of the address `userId` proved, if it has one:
 * read before a phone is confirmed, since joining on the phone can close the
 * account and move its addresses.
 */
export async function admittedRowOf(ctx: QueryCtx, userId: Id<"users">): Promise<Id<"waitlist"> | null> {
  for (const email of (await confirmedEmailsOf(ctx, userId)).slice(0, 10)) {
    const row = await ctx.db
      .query("waitlist")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();
    if (row?.status === "admitted") return row._id;
  }
  return null;
}

/** For a row the "You're in" text does not cover: an address, or a row told already. */
export const putOnLine = internalAction({
  args: { waitlistId: v.id("waitlist"), phone: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await putOnTexLine(ctx, args.waitlistId, args.phone);
    return null;
  },
});
