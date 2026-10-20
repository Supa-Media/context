/**
 * Where somebody on the waitlist stands, read with the status receipt their
 * browser was handed at joining (`lib/waitlistReceipt.ts`). The page is
 * `/waitlist` (tex.lc's "You're on the list" / "You're in"); nobody needs to
 * be signed in, and nothing here signs anybody in.
 *
 * The page only ever shows what the server says here, and the query is live,
 * so a staff Let in turns "You're on the list" into "You're in" on an open
 * page without a refresh:
 *
 *  - `waiting` covers a row staff removed as well as one still waiting. A
 *    removal is never announced (`lib/schema/waitlist.ts`), and that holds
 *    here too: the receipt holder sees exactly what they saw before.
 *  - `admitted` is the row's own status. The Tex line comes with it only when
 *    one is actually configured for this person (`TEX_LINE_NUMBERS`, the same
 *    `texLineFor` the "You're in" text uses), so the page never names a
 *    number Tex would not answer. Admitted without a line reads "You're in"
 *    and says the number is on its way.
 *
 * An unknown, malformed or forgotten receipt is `null`: one answer for all of
 * them, so a guess learns nothing about whether a row exists.
 */

import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { mutation, query, type QueryCtx } from "../_generated/server";
import { dedicatedTexLines, texLineFor } from "./lib/adminFns/texAllowlist";
import { currentPhoneOf } from "./lib/emailProof";
import { hasTextedTex } from "./texHome";
import { tryConsumeRateLimit } from "./lib/rateLimit";
import { USE_FOR_MAX } from "./lib/waitlist";
import { rowForReceipt } from "./lib/waitlistReceipt";

/** Answers one receipt may save per hour: plenty for a person, nothing for a script. */
export const ANSWERS_PER_HOUR = 30;
const HOUR_MS = 60 * 60 * 1000;

const statusValidator = v.union(
  v.null(),
  v.object({
    state: v.union(v.literal("waiting"), v.literal("admitted")),
    /** How the row joined, masked: the last four digits, or the address's first letter and domain. */
    contact: v.union(
      v.object({ kind: v.literal("phone"), ending: v.string() }),
      v.object({ kind: v.literal("email"), masked: v.string() }),
    ),
    useFor: v.union(v.string(), v.null()),
    /** On `admitted` only, and only when a line is configured for this person. */
    texLine: v.union(v.string(), v.null()),
    /** On `admitted`: true until this person's phone first texts Tex, so Open Messages starts them with "hi". */
    firstText: v.boolean(),
  }),
);

export const status = query({
  args: { receipt: v.string() },
  returns: statusValidator,
  handler: async (ctx, args) => {
    const row = await rowForReceipt(ctx, args.receipt);
    if (row === null) return null;
    const admitted = row.status === "admitted";
    const phone = admitted ? await phoneOf(ctx, row) : null;
    const lines = dedicatedTexLines(process.env.TEX_LINE_NUMBERS);
    return {
      state: admitted ? ("admitted" as const) : ("waiting" as const),
      contact: contactOf(row),
      useFor: row.useFor ?? null,
      texLine: phone === null || lines.length === 0 ? null : texLineFor(lines, phone),
      firstText: phone === null ? true : !(await hasTextedTex(ctx, phone)),
    };
  },
});

/**
 * Save, change or clear the answer. Only while the row is not let in: once it
 * is, the answer has done its job and the page stops asking. `saved: false`
 * covers every refusal (an unknown receipt, a let-in row, too many saves) so
 * it says nothing a guess could use.
 */
export const answer = mutation({
  args: { receipt: v.string(), useFor: v.string() },
  returns: v.object({ saved: v.boolean() }),
  handler: async (ctx, args) => {
    const row = await rowForReceipt(ctx, args.receipt);
    if (row === null || row.status === "admitted") return { saved: false };
    if (!(await tryConsumeRateLimit(ctx, { key: `waitlist.answer:${row._id}`, limit: ANSWERS_PER_HOUR, windowMs: HOUR_MS }))) {
      return { saved: false };
    }
    const useFor = args.useFor.trim().slice(0, USE_FOR_MAX);
    await ctx.db.patch(row._id, { useFor: useFor.length > 0 ? useFor : undefined, useForAt: Date.now() });
    return { saved: true };
  },
});

function contactOf(row: Doc<"waitlist">) {
  if (row.phone !== undefined) return { kind: "phone" as const, ending: row.phone.slice(-4) };
  const [local = "", domain = ""] = (row.email ?? "").split("@");
  return { kind: "email" as const, masked: `${local.slice(0, 1)}•••@${domain}` };
}

/**
 * The phone this person texts Tex from, which picks their line: a phone row's
 * own phone; an address row's phone is the one the account that proved the
 * address holds, as `waitlistTex.texFacts` reads it.
 */
async function phoneOf(ctx: QueryCtx, row: Doc<"waitlist">): Promise<string | null> {
  if (row.phone !== undefined) return row.phone;
  if (row.email === undefined) return null;
  const users = await ctx.db
    .query("users")
    .withIndex("by_email", (q) => q.eq("email", row.email))
    .take(2);
  const user = users.find((candidate) => candidate.emailVerificationTime !== undefined);
  return user === undefined ? null : await currentPhoneOf(ctx, user);
}
