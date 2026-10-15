/**
 * Where an open note went when it was moved to the trash, and who moved it:
 * what the editor needs to show the note as trashed in place, with Restore
 * (Dev2, 2026-10-14, design A in project file `trashed-note/`).
 *
 * Read from the audit trail the console's trash writes
 * (`lib/nodes/trashTrail.ts`): the note trashed on its own, or inside a folder
 * that was, newest first. Answered only for a note this caller may see now,
 * judged by the tree's own copy of the rules. A restore made since, of the
 * note or of a folder holding it, answers `null`: the note is back.
 *
 * `readTrashedNote` is the same answer with the note's text, for a note
 * opened by an address that outlived it (a reload on `?note=`).
 */

import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action, internalQuery, query, type QueryCtx } from "../_generated/server";
import { clearanceOf } from "./lib/clearance";
import { callerId, personalNameFor, resolveFileAccess } from "./lib/filesFns/access";
import type { OperationResult } from "./lib/filesFns/operationTypes";
import { normalizePath } from "./lib/fileOps/paths";
import { readMirror } from "./lib/nodes/listing";
import { trashEntryOf } from "./lib/nodes/trashTrail";
import { canSee, type PrivacyRule, type Visibility } from "./lib/privacy";

const answerValidator = v.union(
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
);

type Answer = { trash: string; at: number; byYou: boolean; byName: string | null } | null;

async function answerFor(ctx: QueryCtx, actorUserId: Id<"users">, workspaceId: Id<"workspaces">, path: string): Promise<Answer> {
  // A folder's trash answers for every path under it, so a path is matched only as it would be stored:
  // `secret/../launch/x.md` must not read as inside `secret` while being judged as `launch/x.md`.
  if (normalizePath(path) !== path) return null;
  const { scope, grantedNames } = await resolveFileAccess(ctx, { actorUserId, workspaceId, minimum: "member" });
  const clearance = clearanceOf(scope, grantedNames);
  if (scope !== "private") {
    const mirror = await readMirror(ctx.db, workspaceId);
    if (mirror === null || mirror.invalid) return null;
    const rules: PrivacyRule[] = mirror.folders.map((rule) => ({ prefix: rule.prefix, vis: rule.visibility as Visibility }));
    const overrides = new Map(mirror.notes.map((rule): [string, Visibility] => [rule.path, rule.visibility as Visibility]));
    if (!canSee(path, clearance.scope, rules, overrides, clearance.names)) return null;
  }
  const entry = await trashEntryOf(ctx.db, workspaceId, path);
  if (entry === null) return null;
  const by = entry.actorUserId;
  return {
    trash: entry.trash,
    at: entry.at,
    byYou: by === actorUserId,
    byName: by === undefined ? null : await personalNameFor(ctx, by),
  };
}

export const trashedNote = query({
  args: { workspaceId: v.id("workspaces"), path: v.string() },
  returns: answerValidator,
  handler: async (ctx, { workspaceId, path }) => await answerFor(ctx, await callerId(ctx), workspaceId, path),
});

/** `trashedNote` for an action, which names its caller. */
export const trashedNoteFor = internalQuery({
  args: { actorUserId: v.id("users"), workspaceId: v.id("workspaces"), path: v.string() },
  returns: answerValidator,
  handler: async (ctx, { actorUserId, workspaceId, path }) => await answerFor(ctx, actorUserId, workspaceId, path),
});

/**
 * The trashed note's text, read-only, at the key the trail names: never a key
 * a client sends. A note with no trail, one this caller may not see, and one
 * the trash no longer holds are all the same "not found", the answer
 * `readNote` gives a note that does not exist.
 */
export const readTrashedNote = action({
  args: { workspaceId: v.id("workspaces"), path: v.string() },
  returns: v.object({ path: v.string(), text: v.string(), encrypted: v.boolean() }),
  handler: async (ctx, { workspaceId, path }): Promise<{ path: string; text: string; encrypted: boolean }> => {
    const actorUserId = await callerId(ctx);
    const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId,
      minimum: "member",
    });
    const answer: Answer = await ctx.runQuery(internal.functions.trashedNotes.trashedNoteFor, { actorUserId, workspaceId, path });
    if (answer === null) throw new ConvexError({ code: "FILE_NOT_FOUND", message: "That file does not exist." });
    const read = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId,
      scope,
      grantedNames,
      operation: { kind: "readTrashed", path, trash: answer.trash },
    })) as Extract<OperationResult, { kind: "trashedText" }>;
    return { path: read.path, text: read.text, encrypted: read.encrypted };
  },
});
