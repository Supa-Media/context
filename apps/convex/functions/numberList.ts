/**
 * Putting the sign-in numbers confirmed before the one list on it (`lib/numberList.ts`; Dev2, 2026-11-16). Manual,
 * from `.github/workflows/number-list-backfill.yml`: a page of accounts at a time, each page scheduling the next, and
 * running it again adds nothing. Someone who turned Tex off before `textingStops` existed is found by the audit their
 * unlinking wrote, and stays off. Logs counts only, never a number.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internalMutation } from "./lib/rowWatch/mutations";
import { markTextingStopped, signInNumber, syncSignInNumber } from "./lib/numberList";
import { personalWorkspaceOf } from "./textLinks";

/** Accounts read per page. */
const PAGE = 100;
/** A code confirmed after staff typed the number, not the same write: the console sets both within this. */
const STAFF_SLACK_MS = 5_000;
/** Audit rows read per account looking for an earlier unlink; the newest first. */
const AUDIT_SCAN = 500;
const UNLINKS = new Set(["texts.phone.unlinked", "texts.phone.moved"]);

/** Whether this person turned Tex off (or had their number moved away) before the stop marker existed. */
async function unlinkedBefore(ctx: MutationCtx, userId: Id<"users">): Promise<boolean> {
  const personal = await personalWorkspaceOf(ctx, userId);
  if (personal === null) return false;
  const rows = await ctx.db
    .query("auditEvents")
    .withIndex("by_workspace_at", (q) => q.eq("workspaceId", personal))
    .order("desc")
    .take(AUDIT_SCAN);
  return rows.some((row) => row.actorUserId === userId && UNLINKS.has(row.action));
}

/** Most staff console rows read for numbers staff typed; the console's trail is short. */
const ADMIN_SCAN = 5000;

/**
 * When staff last typed each account's number in the console (`person.phone_set`), by account. Such a number was not
 * proven by a code, so it goes on the list only if a code confirmed it after (a later `phoneVerificationTime`).
 */
async function staffTypedAt(ctx: MutationCtx): Promise<Map<string, number>> {
  const at = new Map<string, number>();
  const rows = await ctx.db.query("adminAuditEvents").withIndex("by_at").order("desc").take(ADMIN_SCAN);
  for (const row of rows) {
    if (row.action === "person.phone_set" && row.subject !== undefined && !at.has(row.subject)) at.set(row.subject, row.at);
  }
  return at;
}

export const backfill = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())), added: v.optional(v.number()), kept: v.optional(v.number()), read: v.optional(v.number()) },
  returns: v.object({ added: v.number(), kept: v.number(), read: v.number(), done: v.boolean() }),
  handler: async (ctx, args) => {
    const page = await ctx.db.query("users").paginate({ cursor: args.cursor ?? null, numItems: PAGE });
    let added = args.added ?? 0;
    let kept = args.kept ?? 0;
    const read = (args.read ?? 0) + page.page.length;
    const typed = await staffTypedAt(ctx);
    for (const user of page.page) {
      if (signInNumber(user) === null) continue;
      const typedAt = typed.get(String(user._id));
      if (typedAt !== undefined && (user.phoneVerificationTime ?? 0) <= typedAt + STAFF_SLACK_MS) continue;
      const listed = (await ctx.db.query("phoneLinks").withIndex("by_user", (q) => q.eq("userId", user._id)).first()) !== null;
      if (!listed && (await unlinkedBefore(ctx, user._id))) {
        await markTextingStopped(ctx, user._id);
        kept += 1;
        continue;
      }
      if (await syncSignInNumber(ctx, user._id)) added += 1;
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.functions.numberList.backfill, { cursor: page.continueCursor, added, kept, read });
    } else {
      console.log(JSON.stringify({ event: "number_list_backfilled", added, kept, read }));
    }
    return { added, kept, read, done: page.isDone };
  },
});
