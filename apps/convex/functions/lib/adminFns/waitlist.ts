/**
 * The staff console's Waitlist: who is waiting, and letting them in.
 *
 * Handlers only. Each exported function in `functions/admin.ts` authorizes
 * with `requireAdmin` inline before calling one of these — see that file's
 * header and `__tests__/adminSurface.test.ts`.
 *
 * Letting somebody in claims their "you're in" mail in the same transaction,
 * so pressing Let in twice, or on a whole selection that overlaps, mails each
 * person once.
 */

import { v } from "convex/values";
import { internal } from "../../../_generated/api";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import type { AdminActor } from "../admin";
import { waitlistEmail } from "../waitlist";

/** Rows one listing returns, newest first. */
export const WAITLIST_PAGE = 200;
/** Addresses one Let in, Remove or Add emails may touch. */
export const WAITLIST_BATCH = 200;

export const waitlistStatusValidator = v.union(
  v.literal("waiting"),
  v.literal("admitted"),
  v.literal("removed"),
);

export const waitlistRowValidator = v.object({
  id: v.id("waitlist"),
  email: v.string(),
  status: waitlistStatusValidator,
  joinedAt: v.number(),
  source: v.string(),
  useFor: v.union(v.string(), v.null()),
  admittedAt: v.union(v.number(), v.null()),
});

export async function listWaitlistHandler(
  ctx: QueryCtx,
  status: Doc<"waitlist">["status"],
) {
  const rows = await ctx.db
    .query("waitlist")
    .withIndex("by_status_joinedAt", (q) => q.eq("status", status))
    .order("desc")
    .take(WAITLIST_PAGE + 1);
  const counts = {
    waiting: await countStatus(ctx, "waiting"),
    admitted: await countStatus(ctx, "admitted"),
  };
  return {
    rows: rows.slice(0, WAITLIST_PAGE).map((row) => ({
      id: row._id,
      email: row.email,
      status: row.status,
      joinedAt: row.joinedAt,
      source: row.source,
      useFor: row.useFor ?? null,
      admittedAt: row.admittedAt ?? null,
    })),
    more: rows.length > WAITLIST_PAGE,
    counts,
  };
}

/** A floor past the ceiling, like the census: `10000` means "at least". */
const COUNT_LIMIT = 10_000;
async function countStatus(ctx: QueryCtx, status: Doc<"waitlist">["status"]): Promise<number> {
  const rows = await ctx.db
    .query("waitlist")
    .withIndex("by_status_joinedAt", (q) => q.eq("status", status))
    .take(COUNT_LIMIT);
  return rows.length;
}

async function admitRow(ctx: MutationCtx, row: Doc<"waitlist">, actor: AdminActor): Promise<boolean> {
  if (row.status === "admitted") return false;
  const now = Date.now();
  const mail = row.admittedMailAt === undefined;
  await ctx.db.patch(row._id, {
    status: "admitted",
    admittedAt: now,
    admittedBy: actor.userId,
    ...(mail ? { admittedMailAt: now } : {}),
  });
  if (mail) {
    await ctx.scheduler.runAfter(0, internal.functions.waitlist.sendMail, {
      waitlistId: row._id,
      kind: "admitted",
    });
  }
  return true;
}

function checkBatch(size: number) {
  if (size > WAITLIST_BATCH) throw new Error(`At most ${WAITLIST_BATCH} at a time.`);
}

export async function admitHandler(ctx: MutationCtx, ids: Id<"waitlist">[], actor: AdminActor) {
  checkBatch(ids.length);
  let changed = 0;
  for (const id of ids) {
    const row = await ctx.db.get(id);
    if (row !== null && (await admitRow(ctx, row, actor))) changed += 1;
  }
  return { changed };
}

export async function removeHandler(ctx: MutationCtx, ids: Id<"waitlist">[]) {
  checkBatch(ids.length);
  let changed = 0;
  for (const id of ids) {
    const row = await ctx.db.get(id);
    if (row === null || row.status === "removed") continue;
    await ctx.db.patch(id, { status: "removed" });
    changed += 1;
  }
  return { changed };
}

/**
 * Let addresses in before they ever ask. Pasted text, split on commas,
 * whitespace and newlines; anything that is not an address is handed back
 * rather than dropped silently.
 */
export async function addEmailsHandler(ctx: MutationCtx, raw: string, actor: AdminActor) {
  const candidates = [...new Set(raw.split(/[\s,;]+/).filter((part) => part.length > 0))];
  checkBatch(candidates.length);
  const invalid: string[] = [];
  let changed = 0;
  for (const candidate of candidates) {
    const email = waitlistEmail(candidate);
    if (email === null) {
      invalid.push(candidate);
      continue;
    }
    const existing = await ctx.db
      .query("waitlist")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();
    if (existing !== null) {
      if (await admitRow(ctx, existing, actor)) changed += 1;
      continue;
    }
    const id = await ctx.db.insert("waitlist", {
      email,
      status: "waiting",
      joinedAt: Date.now(),
      source: "staff",
    });
    const row = await ctx.db.get(id);
    if (row !== null && (await admitRow(ctx, row, actor))) changed += 1;
  }
  return { changed, invalid };
}
