/**
 * The staff console's Waitlist: who is waiting, and letting them in.
 *
 * Handlers only. Each exported function in `functions/admin.ts` authorizes
 * with `requireAdmin` inline before calling one of these — see that file's
 * header and `__tests__/adminSurface.test.ts`.
 *
 * Letting somebody in claims their "you're in" mail, or their text when they
 * joined with a phone, in the same transaction, so pressing Let in twice, or
 * on a whole selection that overlaps, tells each person once. It also puts
 * their phone, when one is known, on Tex's list (`functions/waitlistTex.ts`).
 */

import { v } from "convex/values";
import { internal } from "../../../_generated/api";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import type { AdminActor } from "../admin";
import { normalizePhone } from "../phoneCheck";
import { waitlistEmail } from "../waitlist";
import { adCampaignLabel } from "@context/shared";

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
  /** One of the two is set: how the person joined. */
  email: v.union(v.string(), v.null()),
  phone: v.union(v.string(), v.null()),
  status: waitlistStatusValidator,
  joinedAt: v.number(),
  source: v.string(),
  useFor: v.union(v.string(), v.null()),
  /** When the answer was last written from the status page, or `null`. */
  useForAt: v.union(v.number(), v.null()),
  admittedAt: v.union(v.number(), v.null()),
  /** The landing page (`/a` to `/c`) the person saw before joining, if recorded. */
  landing: v.optional(v.string()),
  /** The ad that sent them, as `adCampaignLabel` reads it, if recorded. */
  campaign: v.optional(v.string()),
});

/**
 * One row per landing page and ad: `campaign` is absent for joins no ad
 * sent, so summing a page's rows gives its total.
 */
export const landingCountsValidator = v.array(
  v.object({ landing: v.string(), campaign: v.optional(v.string()), joined: v.number(), admitted: v.number() }),
);

/**
 * Narrowing the list by the "what would you use it for?" answers, so staff can
 * pick who goes first when many are waiting (Tex launch, 2026-10-20). `search`
 * matches inside an answer, any case; `answered` keeps rows with an answer.
 */
export interface WaitlistFilter {
  search?: string;
  answered?: boolean;
}

/**
 * Rows read to answer a filtered listing, newest first. A filter has to look
 * past the newest page to find its matches; this bounds how far. Past it the
 * answer says `capped`, and the console says it searched the newest ones.
 */
export const WAITLIST_FILTER_SCAN = 4_000;
/** The longest search kept; anything past it is cut, not refused. */
const SEARCH_MAX = 100;

export const waitlistFilterValidator = v.object({
  /** Rows that matched among those read. */
  matches: v.number(),
  /** True when more rows exist than `WAITLIST_FILTER_SCAN` let it read. */
  capped: v.boolean(),
});

export async function listWaitlistHandler(
  ctx: QueryCtx,
  status: Doc<"waitlist">["status"],
  filter: WaitlistFilter = {},
) {
  const needle = (filter.search ?? "").trim().slice(0, SEARCH_MAX).toLowerCase();
  const filtering = needle.length > 0 || filter.answered === true;
  const scanned = await ctx.db
    .query("waitlist")
    .withIndex("by_status_joinedAt", (q) => q.eq("status", status))
    .order("desc")
    .take(filtering ? WAITLIST_FILTER_SCAN + 1 : WAITLIST_PAGE + 1);
  const capped = filtering && scanned.length > WAITLIST_FILTER_SCAN;
  const matching = filtering
    ? scanned.slice(0, WAITLIST_FILTER_SCAN).filter((row) => answerMatches(row, needle))
    : scanned;
  const rows = matching.slice(0, WAITLIST_PAGE);
  const counts = {
    waiting: await countStatus(ctx, "waiting"),
    admitted: await countStatus(ctx, "admitted"),
  };
  return {
    rows: rows.map((row) => ({
      id: row._id,
      email: row.email ?? null,
      phone: row.phone ?? null,
      status: row.status,
      joinedAt: row.joinedAt,
      source: row.source,
      useFor: row.useFor ?? null,
      useForAt: row.useForAt ?? null,
      admittedAt: row.admittedAt ?? null,
      landing: row.landing,
      ...campaignField(row),
    })),
    more: matching.length > WAITLIST_PAGE,
    counts,
    ...(filtering ? { filter: { matches: matching.length, capped } } : {}),
  };
}

/** Either filter needs an answer to look at, so a row without one never matches. */
function answerMatches(row: Doc<"waitlist">, needle: string): boolean {
  const answer = row.useFor?.toLowerCase();
  return answer !== undefined && answer.includes(needle);
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

function campaignField(row: Doc<"waitlist">): { campaign?: string } {
  const campaign = adCampaignLabel(row.campaign);
  return campaign === null ? {} : { campaign };
}

/**
 * Joins and admissions per landing page and ad, for the console's summary.
 * `none` is a row made before the page was recorded. Like the counts above,
 * this reads at most `COUNT_LIMIT` rows, so past that it is a floor.
 */
export async function landingCountsHandler(ctx: QueryCtx) {
  const rows = await ctx.db.query("waitlist").take(COUNT_LIMIT);
  const tallies = new Map<string, { landing: string; campaign?: string; joined: number; admitted: number }>();
  for (const row of rows) {
    const landing = row.landing ?? "none";
    const origin = { landing, ...campaignField(row) };
    const key = JSON.stringify([origin.landing, origin.campaign ?? null]);
    const tally = tallies.get(key) ?? { ...origin, joined: 0, admitted: 0 };
    tally.joined += 1;
    if (row.status === "admitted") tally.admitted += 1;
    tallies.set(key, tally);
  }
  const order = (tally: { landing: string; campaign?: string }) => `${tally.landing}\u0000${tally.campaign ?? ""}`;
  return [...tallies.values()].sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
}

async function admitRow(ctx: MutationCtx, row: Doc<"waitlist">, actor: AdminActor): Promise<boolean> {
  if (row.status === "admitted") return false;
  const now = Date.now();
  // A row joined with a phone is told by text, one with an address by mail.
  const text = row.phone !== undefined && row.email === undefined && row.admittedTextAt === undefined;
  const mail = row.email !== undefined && row.admittedMailAt === undefined;
  await ctx.db.patch(row._id, {
    status: "admitted",
    admittedAt: now,
    admittedBy: actor.userId,
    ...(mail ? { admittedMailAt: now } : {}),
    ...(text ? { admittedTextAt: now } : {}),
  });
  if (mail) {
    await ctx.scheduler.runAfter(0, internal.functions.waitlist.sendMail, {
      waitlistId: row._id,
      kind: "admitted",
    });
  }
  // Their phone goes on Tex's list too; the text does that first, so its
  // "text Tex" is never sent to a number the line would not answer.
  if (text) {
    await ctx.scheduler.runAfter(0, internal.functions.waitlistText.sendAdmitted, { waitlistId: row._id });
  } else {
    await ctx.scheduler.runAfter(0, internal.functions.waitlistTex.putOnLine, { waitlistId: row._id });
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
 * Let people in before they ever ask. Pasted text, one per line or split on
 * commas and semicolons; an address or a phone with its country code (people
 * sign in with a phone since 2026-10-09). Anything else is handed back rather
 * than dropped silently.
 */
export async function addEmailsHandler(ctx: MutationCtx, raw: string, actor: AdminActor) {
  const candidates = [
    ...new Set(
      raw
        .split(/[\n,;]+/)
        .flatMap((part) => (normalizePhone(part) !== null ? [part.trim()] : part.split(/\s+/)))
        .filter((part) => part.length > 0),
    ),
  ];
  checkBatch(candidates.length);
  const invalid: string[] = [];
  let changed = 0;
  for (const candidate of candidates) {
    const email = waitlistEmail(candidate);
    const phone = email === null ? normalizePhone(candidate) : null;
    if (email === null && phone === null) {
      invalid.push(candidate);
      continue;
    }
    const existing =
      email !== null
        ? await ctx.db
            .query("waitlist")
            .withIndex("by_email", (q) => q.eq("email", email))
            .unique()
        : await ctx.db
            .query("waitlist")
            .withIndex("by_phone", (q) => q.eq("phone", phone!))
            .first();
    if (existing !== null) {
      if (await admitRow(ctx, existing, actor)) changed += 1;
      continue;
    }
    const id = await ctx.db.insert("waitlist", {
      ...(email !== null ? { email } : { phone: phone! }),
      status: "waiting",
      joinedAt: Date.now(),
      source: "staff",
    });
    const row = await ctx.db.get(id);
    if (row !== null && (await admitRow(ctx, row, actor))) changed += 1;
  }
  return { changed, invalid };
}
