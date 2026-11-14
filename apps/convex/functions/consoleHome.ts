/**
 * The staff console's "Needs you" (Home, and the sidebar's badges), the light half: how many people wait on the
 * waitlist, how many were let in by phone and never told, how many search indexes failed, which workspaces failed
 * their backup encryption check, and which mail inboxes take mail from anyone. One read, counts and slugs only, so the
 * console can ask once per visit instead of holding five live lists (review of #3291). The rest of the list comes
 * from queries the console already reads: credentials, open reports and the turns report.
 *
 * Staff only, checked inline like every function in `admin.ts`. Never an address, a phone or a note.
 */

import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { query, type QueryCtx } from "../_generated/server";
import { requireAdmin } from "./lib/admin";
import { MAIL_OPEN_SLUG_LIMIT } from "./lib/adminFns/censusGrowth";
import { toConvexError } from "./lib/adminFns/errors";
import { meaningIndexReportHandler } from "./lib/adminFns/meaningIndexes";
import { countStatus } from "./lib/adminFns/waitlist";
import { untoldCountHandler } from "./lib/adminFns/waitlistUntold";
import { rolloutStatusHandler } from "./lib/managedEncryptionFns/rollout";

/** Mail settings rows read; far above a private beta's size. */
const MAIL_ROWS_READ = 2000;

export const needsValidator = v.object({
  waiting: v.number(),
  untold: v.number(),
  failedIndexes: v.number(),
  failedBackups: v.array(v.string()),
  openMail: v.array(v.object({ slug: v.string(), ownerId: v.id("users") })),
});

/**
 * The workspaces whose mail inbox takes mail from anyone, by slug, with the account that owns each (at most 20). Only
 * a personal workspace has a mail inbox, so its owner is the account that made it; Home's line opens that person.
 */
async function openMailOf(ctx: QueryCtx): Promise<{ slug: string; ownerId: Id<"users"> }[]> {
  const rows = await ctx.db.query("ingestionSettings").take(MAIL_ROWS_READ);
  const open = new Map<string, Id<"users">>();
  for (const row of rows) {
    if (!row.allowAnySender) continue;
    const workspace = await ctx.db.get(row.workspaceId);
    if (workspace !== null) open.set(workspace.slug, workspace.createdBy);
  }
  return [...open.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, MAIL_OPEN_SLUG_LIMIT)
    .map(([slug, ownerId]) => ({ slug, ownerId }));
}

export const needs = query({
  args: {},
  returns: needsValidator,
  handler: async (ctx) => {
    await requireAdmin(ctx).catch((error: unknown) => {
      throw toConvexError(error);
    });
    const indexes = await meaningIndexReportHandler(ctx);
    const backups = await rolloutStatusHandler(ctx);
    return {
      waiting: await countStatus(ctx, "waiting"),
      untold: await untoldCountHandler(ctx),
      failedIndexes: indexes.rows.filter((row) => row.status === "failed").length,
      failedBackups: backups.workspaces.filter((row) => row.state === "failed").map((row) => row.slug),
      openMail: await openMailOf(ctx),
    };
  },
});
