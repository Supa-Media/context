/**
 * The status receipt: how somebody on the waitlist, who has no account and
 * cannot sign in, gets back to where they stand (Tex launch, 2026-10-20).
 *
 * Joining hands the browser that made the row one random secret, once. Only
 * its SHA-256 is kept, on the row (`receiptHash`). Presenting the secret
 * reads the row's state and writes its "what would you use it for?" answer
 * (`functions/waitlistStatus.ts`); nothing else does, so knowing somebody's
 * phone number or address reads nothing and changes nothing.
 *
 * What it deliberately is not:
 *
 *  - **Not issued on "already".** Anybody can type anybody's number, so the
 *    one moment a browser has earned a receipt is the moment it made the row.
 *    Typing a listed number again tells that browser what it always has
 *    ("you're already on the list") and nothing more.
 *  - **Not a sign-in.** It never makes a session, never reaches the console,
 *    and is not accepted by any other function. Admission stays where it is:
 *    staff, and the gates in `lib/waitlist.ts` and `phoneSignIn.ts`.
 *  - **Not in a URL.** The app keeps it in the origin's storage and sends it
 *    as a function argument, so it never reaches an address bar, a referrer,
 *    an analytics pixel or a request log.
 */

import type { Doc } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { hashToken } from "./crypto";
import { randomOpaqueToken } from "./gatewayAuth";

/** 32 random bytes as hex: what `randomOpaqueToken` makes. Anything else is refused unread. */
export const RECEIPT_PATTERN = /^[0-9a-f]{64}$/;

/** A new receipt: the secret for the browser, and the hash for the row. */
export async function newReceipt(): Promise<{ receipt: string; receiptHash: string }> {
  const receipt = randomOpaqueToken(32);
  return { receipt, receiptHash: await hashToken(receipt) };
}

/** The row `receipt` was issued for, or `null` for anything else, malformed included. */
export async function rowForReceipt(ctx: QueryCtx, receipt: string): Promise<Doc<"waitlist"> | null> {
  if (!RECEIPT_PATTERN.test(receipt)) return null;
  const receiptHash = await hashToken(receipt);
  return await ctx.db
    .query("waitlist")
    .withIndex("by_receiptHash", (q) => q.eq("receiptHash", receiptHash))
    .unique();
}
