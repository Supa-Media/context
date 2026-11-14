/**
 * The staff console's Home page: the one fact its "Needs you" list cannot read from another page's query. Every other
 * line comes from queries the other pages already use (credentials, reports, turns, waitlist, search indexes, backup
 * encryption); see `apps/mobile/features/admin/console/pages/needs.web.ts`.
 *
 * Staff only, checked inline like every function in `admin.ts`. Slugs only, never an address or a note.
 */

import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireAdmin } from "./lib/admin";
import { openMailSlugs } from "./lib/adminFns/censusGrowth";
import { toConvexError } from "./lib/adminFns/errors";

/** Mail settings rows read; far above a private beta's size. */
const MAIL_ROWS_READ = 2000;

/** The workspaces whose mail inbox takes mail from anyone, as @slugs (at most 20). */
export const openMail = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => {
    await requireAdmin(ctx).catch((error: unknown) => {
      throw toConvexError(error);
    });
    const rows = await ctx.db.query("ingestionSettings").take(MAIL_ROWS_READ);
    return await openMailSlugs(ctx, rows);
  },
});
