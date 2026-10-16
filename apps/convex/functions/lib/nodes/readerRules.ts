/**
 * The `{rules, overrides}` every Convex reader judges by (`canSee`).
 *
 * `nodeMigration.accessSource` decides where they come from:
 *  - `file` (unset): the privacy mirror, as `mirrorRules` reads it. Today's answer.
 *  - `shadow`: the same mirror. The access rows are rendered beside it and the
 *    two are compared; a difference is logged as a count, never as paths of
 *    note content, and never per row. Readers still get the mirror's rules.
 *  - `rows`: `renderAccess(accessRowsOf(...), "member")`. A member's clearance
 *    is then judged against the rows, and names come from `grantedNames.ts`.
 *
 * Every reader that judges privacy in Convex goes through here, so the switch
 * has one place to be read.
 */

import type { Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { accessSourceOf } from "./accessBackfill";
import { accessRowsOf } from "./accessRows";
import { mirrorRules, type Rules } from "./log";
import { readMirror } from "./privacyMirror";
import { renderAccess } from "./rowAccess";

/**
 * A rule's setting as a shadow comparison reads it: `private` or `team`, or `list` for any named
 * grant. The rows name a list by an opaque token and the file by a name, so the two cannot be
 * compared literally; who is on a list is `accessParity.ts`'s question, not this count's.
 */
function settingClass(vis: string): string {
  return vis === "private" || vis === "team" ? vis : "list";
}

/** One line per rule and per exception, so a shadow comparison is a set difference. */
function ruleKeys(rules: Rules): Set<string> {
  const keys = new Set<string>();
  for (const rule of rules.rules) keys.add(`folder ${rule.prefix} ${settingClass(rule.vis)}`);
  for (const [path, vis] of rules.overrides) keys.add(`note ${path} ${settingClass(vis)}`);
  return keys;
}

/** How many rule or exception lines the two sets disagree on, in either direction. */
export function ruleDiffCount(a: Rules, b: Rules): number {
  const left = ruleKeys(a);
  const right = ruleKeys(b);
  let count = 0;
  for (const key of left) if (!right.has(key)) count += 1;
  for (const key of right) if (!left.has(key)) count += 1;
  return count;
}

/** The rules the access rows give a member, as `renderAccess` renders them. */
async function rowRules(ctx: QueryCtx, workspaceId: Id<"workspaces">): Promise<Rules> {
  const { rules, overrides } = renderAccess(await accessRowsOf(ctx, workspaceId), "member");
  return { rules, overrides };
}

/**
 * The rules a Convex reader judges this workspace by, under the deployment's
 * `accessSource`. In `file` and `shadow` this is exactly what readers judged
 * by before the switch existed.
 */
export async function rulesForReaders(ctx: QueryCtx, workspaceId: Id<"workspaces">): Promise<Rules> {
  const source = await accessSourceOf(ctx.db);
  if (source === "rows") return await rowRules(ctx, workspaceId);
  const fileRules = await mirrorRules(await readMirror(ctx.db, workspaceId));
  if (source === "shadow") {
    // Staff reads the count from the log. A row set the renderer refuses (two rows at one path) is
    // logged by workspace only: the comparison failing is itself the alarm.
    try {
      const count = ruleDiffCount(fileRules, await rowRules(ctx, workspaceId));
      if (count > 0) console.log(JSON.stringify({ event: "access.shadow_diff", workspaceId, count }));
    } catch {
      console.log(JSON.stringify({ event: "access.shadow_error", workspaceId }));
    }
  }
  return fileRules;
}
