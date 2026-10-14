/**
 * Where an open note went when it was moved to the trash, and who moved it:
 * what the editor needs to show the note as trashed in place, with Restore
 * (Dev2, 2026-10-14, design A in project file `trashed-note/`).
 *
 * Read from the audit trail the console's trash writes (`file.archive` with
 * `trash: true`, paths `[note, trash key]`), newest first, and answered only
 * for a note this caller may see now, judged by the tree's own copy of the
 * rules. A restore made since (`restoredFromTrash`) answers `null`: the note
 * is back.
 */

import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { clearanceOf } from "./lib/clearance";
import { callerId, personalNameFor, resolveFileAccess } from "./lib/filesFns/access";
import { readMirror } from "./lib/nodes/listing";
import { canSee, type PrivacyRule, type Visibility } from "./lib/privacy";

/** Trail rows read looking for the trash: a few minutes of a busy workspace, which is when this is asked. */
const SCAN = 300;

export const trashedNote = query({
  args: { workspaceId: v.id("workspaces"), path: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      /** The trash key Restore takes back from. */
      trash: v.string(),
      at: v.number(),
      /** Whether the caller moved it there. */
      byYou: v.boolean(),
      /** "@ana", or `null` when the mover has no personal workspace. */
      byName: v.union(v.string(), v.null()),
    }),
  ),
  handler: async (ctx, { workspaceId, path }) => {
    const actorUserId = await callerId(ctx);
    const { scope, grantedNames } = await resolveFileAccess(ctx, { actorUserId, workspaceId, minimum: "member" });
    const clearance = clearanceOf(scope, grantedNames);
    if (scope !== "private") {
      const mirror = await readMirror(ctx.db, workspaceId);
      if (mirror === null || mirror.invalid) return null;
      const rules: PrivacyRule[] = mirror.folders.map((rule) => ({ prefix: rule.prefix, vis: rule.visibility as Visibility }));
      const overrides = new Map(mirror.notes.map((rule): [string, Visibility] => [rule.path, rule.visibility as Visibility]));
      if (!canSee(path, clearance.scope, rules, overrides, clearance.names)) return null;
    }
    const events = await ctx.db
      .query("auditEvents")
      .withIndex("by_workspace_at", (q) => q.eq("workspaceId", workspaceId))
      .order("desc")
      .take(SCAN);
    for (const event of events) {
      if (event.action === "file.move" && event.details?.restoredFromTrash === true && event.paths[1] === path) return null;
      if (event.action !== "file.archive" || event.details?.trash !== true || event.paths[0] !== path) continue;
      const trash = event.paths[1];
      if (typeof trash !== "string" || !trash.startsWith(".context/trash/")) return null;
      const by = event.actorUserId as Id<"users"> | undefined;
      return {
        trash,
        at: event.at,
        byYou: by === actorUserId,
        byName: by === undefined ? null : await personalNameFor(ctx, by),
      };
    }
    return null;
  },
});
