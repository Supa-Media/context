/**
 * Going back to Off from rows (`privacyRows.backToOff`): the rows are written
 * back as the privacy rules before the switch says the rules decide again, so
 * the rules answer what the rows answered. Split out of `privacyRows.ts` for
 * its size.
 *
 * Refused, and nothing written, unless every bound workspace's rows can be
 * said as rules (`rulesFromRows`): a row the rules cannot express is named,
 * up to ten paths, and the owner narrows it before going back.
 *
 * Needs the rules to be the authority (`privacyAuthority`). The bucket's
 * `privacy.md` is written from the rules the owner's rows render to; with the
 * file as the authority, the next read of it would put back its older rules,
 * and a note the owner had narrowed would be readable again.
 */

import { ConvexError } from "convex/values";
import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { boundWorkspaces } from "../../nodesMigration";
import { newRulesVersion, privacyAuthorityOn, privacyRowOf, scheduleExport } from "../nodes/privacyAuthority";
import { rulesFromRows } from "../nodes/rowsToRules";

/** The most refused paths one refusal lists. */
export const REFUSED_PATHS_MAX = 10;

const TOO_MANY = { code: "ROWS_TOO_MANY", message: "There are too many workspaces to check at once." } as const;

interface Plan {
  workspaceId: Id<"workspaces">;
  folders: { prefix: string; visibility: string }[];
  notes: { path: string; visibility: string }[];
}

/** Write every bound workspace's rows as its rules, or throw without writing any. */
export async function renderRowsAsRules(ctx: MutationCtx): Promise<void> {
  const { ids, truncated } = await boundWorkspaces(ctx);
  if (truncated) throw new ConvexError(TOO_MANY);
  if (!(await privacyAuthorityOn(ctx.db))) {
    throw new ConvexError({
      code: "ROWS_NEEDS_AUTHORITY",
      message: "Turn on the privacy rules as the authority before going back to Off. Otherwise the file would put back older rules.",
    });
  }
  const plans: Plan[] = [];
  const refused: string[] = [];
  for (const workspaceId of ids) {
    const rendered = await rulesFromRows(ctx, workspaceId);
    if (rendered.ok) plans.push({ workspaceId, folders: rendered.folders, notes: rendered.notes });
    else refused.push(...rendered.paths);
  }
  if (refused.length > 0) {
    const paths = refused.slice(0, REFUSED_PATHS_MAX);
    throw new ConvexError({
      code: "ROWS_NOT_REPRESENTABLE",
      message:
        `${refused.length} ${refused.length === 1 ? "row has" : "rows have"} access the privacy rules cannot say ` +
        `(an email, an edit grant, two grants, or a team base with a list): ${paths.join(", ")}. ` +
        "Change those rows first, then try again.",
      paths,
    });
  }
  for (const plan of plans) await writeRules(ctx, plan);
}

/** The workspace's rules as its rows rendered them, exported like any rules change. */
async function writeRules(ctx: MutationCtx, plan: Plan): Promise<void> {
  const now = Date.now();
  const fields = {
    etag: newRulesVersion(now, Math.random),
    invalid: false,
    folders: plan.folders,
    notes: plan.notes,
    observedAt: now,
    exportOwed: true,
    fileAhead: undefined,
  };
  const row = await privacyRowOf(ctx, plan.workspaceId);
  if (row === null) await ctx.db.insert("nodePrivacy", { workspaceId: plan.workspaceId, ...fields });
  else await ctx.db.patch(row._id, fields);
  await scheduleExport(ctx, plan.workspaceId, 0);
}
