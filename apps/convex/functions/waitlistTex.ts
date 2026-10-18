/**
 * With Tex on a dedicated Sendblue line (`TEX_LINE_NUMBERS`, 2026-10-18) there
 * is no list: this only says which number to text. Before that:
 *
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
 * down is logged and put on the admin trail under whoever acted (the staff
 * member who let the row in, or the person confirming their phone), and
 * staff free a slot or add the number from Tex access. Only a row still
 * admitted is added, so one removed since Let in is not. A phone change
 * takes the old number off first, so each person holds one slot.
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
import { addToLinqLineAt, dedicatedTexLines, removeFromLinqLine, texLineFor } from "./lib/adminFns/texAllowlist";
import { recordAdminAudit } from "./lib/adminFns/audit";
import { confirmedEmailsOf, currentPhoneOf } from "./lib/emailProof";
import { textTexNumber } from "./waitlistText";

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

/**
 * The trail entry, under whoever acted: `actorUserId` when a person changed
 * it themselves (confirming a phone), else the staff member who let the row
 * in. Last four digits only.
 */
export const recordOutcome = internalMutation({
  args: {
    waitlistId: v.id("waitlist"),
    phone: v.string(),
    outcome: v.string(),
    actorUserId: v.optional(v.id("users")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.waitlistId);
    const actingId = args.actorUserId ?? row?.admittedBy;
    const acting = actingId === undefined ? null : await ctx.db.get(actingId);
    if (acting === null || acting.email === undefined) return null;
    const actor = { userId: acting._id, email: acting.email };
    const via = args.actorUserId === undefined ? "waitlist" : "phone_confirmed";
    const details = { phone: args.phone.slice(-4), via, outcome: args.outcome };
    const action =
      args.outcome === "added"
        ? "tex.allowlist_added"
        : args.outcome === "removed"
          ? "tex.allowlist_removed"
          : "tex.allowlist_refused";
    await recordAdminAudit(ctx, actor, action, "tex", details);
    return null;
  },
});

/** Who acted, and the number a phone change leaves behind. */
export interface PutOnOptions {
  actorUserId?: Id<"users">;
  replaces?: string;
}

/**
 * Put the admitted row's phone on the list, and say the line's number when
 * the phone is on it (added now, or already), else `null`. Never throws.
 * `replaces` comes off first, so a changed phone frees its old slot before
 * the new one takes one, and a full list does not lock the person out.
 */
export async function putOnTexLine(
  ctx: ActionCtx,
  waitlistId: Id<"waitlist">,
  phone?: string,
  options: PutOnOptions = {},
): Promise<string | null> {
  const log = (event: string, extra: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ event: `waitlist_tex_${event}`, waitlistId, ...extra }));
  try {
    const facts = await ctx.runQuery(internal.functions.waitlistTex.texFacts, { waitlistId });
    const number = phone ?? facts?.phone ?? null;
    if (facts === null || number === null) return null;
    // A dedicated line has no list: anybody can text it.
    const dedicated = dedicatedTexLines(process.env.TEX_LINE_NUMBERS);
    if (dedicated.length > 0) {
      log("dedicated");
      return texLineFor(dedicated, number);
    }
    if (!process.env.LINQ_API_KEY?.trim()) {
      log("skipped", { reason: "linq_not_connected" });
      return null;
    }
    const env = { LINQ_API_KEY: process.env.LINQ_API_KEY };
    const record = async (phoneOf: string, outcome: string) =>
      await ctx.runMutation(internal.functions.waitlistTex.recordOutcome, {
        waitlistId,
        phone: phoneOf,
        outcome,
        ...(options.actorUserId === undefined ? {} : { actorUserId: options.actorUserId }),
      });
    if (options.replaces !== undefined && options.replaces !== number) {
      const removal = await removeFromLinqLine(env, options.replaces);
      log(`old_${removal.status}`);
      // Only a slot actually freed goes on the trail; "absent" changed nothing.
      if (removal.status === "removed" || removal.status === "error") await record(options.replaces, removal.status);
    }
    const { change, line, unlimited } = await addToLinqLineAt(env, number);
    // A paid line has no list to be on, and "already" changed nothing.
    if (unlimited || change.status === "already") {
      log(unlimited ? "unlimited" : "already");
      return line;
    }
    log(change.status, change.status === "error" ? { reason: change.error } : {});
    await record(number, change.status);
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

/**
 * For a row the "You're in" text at Let in does not cover: an address, or a
 * row told already. Once the phone is on the line, a row never texted is sent
 * "Text Tex at …" (`waitlistText.textTexNumber`).
 */
export const putOnLine = internalAction({
  args: {
    waitlistId: v.id("waitlist"),
    phone: v.optional(v.string()),
    actorUserId: v.optional(v.id("users")),
    replaces: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { actorUserId, replaces } = args;
    const line = await putOnTexLine(ctx, args.waitlistId, args.phone, { actorUserId, replaces });
    if (line === null) return null;
    // Tex cannot text first, so the person is told where Tex is (once per row).
    const phone =
      args.phone ?? (await ctx.runQuery(internal.functions.waitlistTex.texFacts, { waitlistId: args.waitlistId }))?.phone;
    if (phone) await textTexNumber(ctx, args.waitlistId, phone, line);
    return null;
  },
});
