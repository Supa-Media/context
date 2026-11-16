/**
 * Tex's old number: the one global setting that says whether Tex's old Sendblue line answers each chat once with the new
 * number instead of a turn (`apps/agent/src/oldLine.ts`). Staff set it in the console's Lines page; every change is
 * audited. One row; no row is `off`.
 *
 * The Worker reads it through `/agent-texts/old-line` (`lib/gatewayRoutes/agentTexts.ts`), behind its own secret.
 */

import { ConvexError, v } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internalQuery, query } from "../_generated/server";
import { mutation } from "./lib/rowWatch/mutations";
import { requireAdmin, type AdminActor } from "./lib/admin";
import { recordAdminAudit } from "./lib/adminFns/audit";
import { toConvexError } from "./lib/adminFns/errors";
import { isPhoneNumber } from "./textLinks";

const modeValidator = v.union(v.literal("off"), v.literal("redirect"));
const settingValidator = v.object({
  mode: modeValidator,
  number: v.union(v.string(), v.null()),
  archiveOn: v.union(v.string(), v.null()),
});
const staffSettingValidator = v.object({
  ...settingValidator.fields,
  updatedAt: v.union(v.number(), v.null()),
  updatedBy: v.union(v.id("users"), v.null()),
});

type Setting = typeof settingValidator.type;

function refuse(message: string): never {
  throw new ConvexError({ code: "INVALID_ARGUMENT", message });
}

async function staff(ctx: QueryCtx): Promise<AdminActor> {
  try {
    return await requireAdmin(ctx);
  } catch (error) {
    throw toConvexError(error);
  }
}

/** `YYYY-MM-DD` that is a real calendar day (no February 30th). */
export function isArchiveDay(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m === null) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

async function current(ctx: QueryCtx | MutationCtx) {
  return await ctx.db.query("texOldLine").first();
}

/** The setting as the Worker and the console read it; the default when no row exists. */
function asSetting(row: Awaited<ReturnType<typeof current>>): Setting {
  return {
    mode: row?.mode ?? "off",
    number: row?.number ?? null,
    archiveOn: row?.archiveOn ?? null,
  };
}

/** Staff's view: the setting plus who last changed it and when. */
export const getTexOldLine = query({
  args: {},
  returns: staffSettingValidator,
  handler: async (ctx) => {
    await staff(ctx);
    const row = await current(ctx);
    return { ...asSetting(row), updatedAt: row?.updatedAt ?? null, updatedBy: row?.updatedBy ?? null };
  },
});

/** Set the old line's mode, new number and archive day. `redirect` needs a number; a day is `YYYY-MM-DD`. */
export const setTexOldLine = mutation({
  args: { mode: modeValidator, number: v.union(v.string(), v.null()), archiveOn: v.union(v.string(), v.null()) },
  returns: staffSettingValidator,
  handler: async (ctx, args) => {
    const actor = await staff(ctx);
    const number = args.number?.trim() || null;
    const archiveOn = args.archiveOn?.trim() || null;
    if (number !== null && !isPhoneNumber(number)) refuse("The new number must be a phone number in E.164, like +18133350746.");
    if (args.mode === "redirect" && number === null) refuse("Redirecting needs a number to send people to.");
    if (archiveOn !== null && !isArchiveDay(archiveOn)) refuse("The archive day must be a real day, as YYYY-MM-DD.");

    const row = await current(ctx);
    const fields = { mode: args.mode, number: number ?? undefined, archiveOn: archiveOn ?? undefined, updatedAt: Date.now(), updatedBy: actor.userId };
    if (row === null) await ctx.db.insert("texOldLine", fields);
    else await ctx.db.replace(row._id, fields);
    await recordAdminAudit(ctx, actor, "tex.old_line_set", "tex.old_line", { mode: args.mode, archiveOn });
    return { mode: args.mode, number, archiveOn, updatedAt: fields.updatedAt, updatedBy: actor.userId };
  },
});

/** The setting as the Worker reads it, for a Lab test chat's object too (`texLabSandbox.ts`). */
export async function oldLineSetting(ctx: QueryCtx): Promise<Setting> {
  return asSetting(await current(ctx));
}

/** The setting the Worker reads (`/agent-texts/old-line`). Phone and day only; who changed it stays with staff. */
export const oldLineForWorker = internalQuery({
  args: {},
  returns: settingValidator,
  handler: async (ctx) => asSetting(await current(ctx)),
});
