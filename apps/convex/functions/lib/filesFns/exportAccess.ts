/**
 * The notes and the `access.md` a "Download as folders" archive is made from,
 * in rows mode (`nodeMigration.accessSource` = `rows`).
 *
 * ## Why the note list is filtered again here
 *
 * `notePaths` lists the tree's rows and judges them by the privacy mirror the
 * tree keeps, which is the `privacy.md` the rules were last written to. In
 * rows mode a setting changed on a row never reaches that mirror, so `notePaths`
 * can name a note the rows hold back. An archive must not carry it. So the
 * list is read again here, judged by the same rules a member's listing is
 * judged by in rows mode (`exportAccessRows.ts`), and only what both allow goes
 * in. That can only remove a path, never add one, so a stale mirror can make an
 * archive short but never wider.
 *
 * In file mode the answer is `{ mode: "file" }` and the caller makes the
 * archive exactly as it did before this existed.
 */

import { v } from "convex/values";
import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { clearanceOf } from "../clearance";
import { canSee, type PrivacyRule, type Visibility } from "../privacy";
import { renderAccessMarkdown } from "../nodes/exportAccess";
import { NOTE_PATHS_CHUNK } from "../fileOps/search";
import { callerId } from "./access";
import { notePathsHandler } from "./search";

export const exportAccessValidator = v.union(
  v.object({ mode: v.literal("file") }),
  v.object({
    mode: v.literal("rows"),
    /** The notes to put in the archive, in chunks; `null` when the tree is not listed yet. */
    chunks: v.union(v.null(), v.array(v.array(v.string()))),
    /** The `access.md` for this folder. */
    access: v.string(),
  }),
);

export type ExportAccessAnswer = typeof exportAccessValidator.type;

/** See `files.exportAccess`. */
export async function exportAccessHandler(
  ctx: ActionCtx,
  args: { workspaceId: Id<"workspaces">; folder: string },
): Promise<ExportAccessAnswer> {
  const actorUserId = await callerId(ctx);
  const { role, scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
    actorUserId,
    workspaceId: args.workspaceId,
    minimum: "member",
  });
  const state = await ctx.runQuery(internal.functions.nodesAccess.exportAccessState, { workspaceId: args.workspaceId });
  if (state === null) return { mode: "file" };

  const clearance = clearanceOf(scope, grantedNames);
  const rules = state.rules as PrivacyRule[];
  const overrides = new Map(state.overrides as [string, Visibility][]);
  const folder = args.folder === "/" ? "" : args.folder;
  const within = (path: string) => folder === "" || path === folder || path.startsWith(`${folder}/`);
  const visible = (path: string) => canSee(path, clearance.scope, rules, overrides, clearance.names);

  const answer = await notePathsHandler(ctx, { workspaceId: args.workspaceId });
  const listed = answer.paths ?? (answer.pathChunks === undefined ? null : answer.pathChunks.flat());
  if (listed === null) return { mode: "rows", chunks: null, access: "" };

  const notes = listed.filter((path) => within(path) && visible(path));
  const lines = state.lines.filter((line) => {
    if (!within(line.path)) return false;
    if (line.kind === "file") return visible(line.path);
    return notes.some((path) => path.startsWith(`${line.path}/`));
  });
  const chunks: string[][] = [];
  for (let start = 0; start < notes.length; start += NOTE_PATHS_CHUNK) {
    chunks.push(notes.slice(start, start + NOTE_PATHS_CHUNK));
  }
  return {
    mode: "rows",
    chunks,
    access: renderAccessMarkdown(lines, { names: role === "owner" }),
  };
}
