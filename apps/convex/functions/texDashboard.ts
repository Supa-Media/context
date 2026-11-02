/**
 * tex.lc/admin's triage desk (`lib/adminFns/texTriage.ts`): the bug reports
 * filed by texting Tex, the conversation reviews and the problems the triage
 * agent names, with a way to read one, comment for the agent, send it to be
 * fixed, or retire it (decided by the owner, 2026-10-24).
 *
 * Two locks on every call, both checked here and never by the page: the
 * caller is staff, and the caller is a member of the pinned context the notes
 * live in. Membership is who may ask, never what they may see: `canSee` over
 * the workspace's rules decides that, here as in every other listing, so the
 * desk shows nobody a note their own membership would not. Reads and writes
 * then go through `runFileOperation` at the clearance `authorizeFileAccess`
 * gives that membership, as any other read of theirs would; an action writes
 * only with an editor's role.
 */

import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "./lib/signedIn";
import { appendMail, parseMail, stripMail } from "@context/shared/src/mail.cjs";
import { applyChanges } from "@context/shared/src/comments.cjs";
import { PINNED_CONTEXT_SLUG } from "@context/shared";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action, internalQuery, query, type ActionCtx, type QueryCtx } from "../_generated/server";
import { requireAdmin } from "./lib/admin";
import { clearanceOf } from "./lib/clearance";
import { resolveFileAccess } from "./lib/filesFns/access";
import { canSee } from "./lib/privacy";
import { readerView } from "./lib/nodes/readerRules";
import { audienceOfNames } from "./lib/pinnedReaders";
import { toConvexError } from "./lib/adminFns/errors";
import {
  STATUS_AFTER,
  TRIAGE_ACTIONS,
  TRIAGE_AGENT,
  mailFor,
  onTheDesk,
  texTriageValidator,
  triageFolders,
  triageRows,
  withStatus,
  type TexTriage,
  type TriageAction,
} from "./lib/adminFns/texTriage";
import { folderJobsOf } from "./lib/nodes/folderJobs";
import { pinnedContextWorkspace } from "./lib/pinnedContext";
import { getMembership } from "./lib/workspaceAuth";

/** Staff and a member of the pinned context, or why not. */
async function deskOf(ctx: QueryCtx) {
  await requireAdmin(ctx).catch((error: unknown) => {
    throw toConvexError(error);
  });
  const userId = await getAuthUserId(ctx);
  const pinned = await pinnedContextWorkspace(ctx);
  if (pinned === null || userId === null) return { ok: false as const, reason: "no_pinned_context" as const };
  if ((await getMembership(ctx, pinned._id, userId)) === null) return { ok: false as const, reason: "not_a_member" as const };
  const folders = triageFolders((await folderJobsOf(ctx.db, pinned._id)).jobs.areas ?? null);
  return { ok: true as const, userId, workspaceId: pinned._id, folders };
}

/**
 * What this member may see, as any listing judges it: their clearance from
 * live membership, over the rules the rows hold. A query has to ask
 * `resolveFileAccess` itself, which is what it is there for — a reactive
 * query cannot `runQuery`, and this is the same body `authorizeFileAccess`
 * answers with, so the listing and the read beside it cannot disagree.
 */
async function deskVisibility(ctx: QueryCtx, userId: Id<"users">, workspaceId: Id<"workspaces">): Promise<(path: string) => boolean> {
  const access = await resolveFileAccess(ctx, { actorUserId: userId, workspaceId, minimum: "member" });
  const clearance = clearanceOf(access.scope, access.grantedNames);
  const { judged } = await readerView(ctx, workspaceId, audienceOfNames(clearance.names));
  return (path: string) => canSee(path, access.scope, judged.rules, judged.overrides, clearance.names);
}

export const triage = query({
  args: {},
  returns: texTriageValidator,
  handler: async (ctx): Promise<TexTriage> => {
    const desk = await deskOf(ctx);
    if (!desk.ok) return { available: false, reason: desk.reason };
    const visible = await deskVisibility(ctx, desk.userId, desk.workspaceId);
    return { available: true, slug: PINNED_CONTEXT_SLUG, ...(await triageRows(ctx.db, desk.workspaceId, desk.folders, visible)) };
  },
});

/** The desk, for an action: staff, a member, and a path inside the bugs or reviews folder. */
export const deskFor = internalQuery({
  args: { path: v.string() },
  returns: v.object({ userId: v.id("users"), workspaceId: v.id("workspaces") }),
  handler: async (ctx, { path }): Promise<Desk> => {
    const desk = await deskOf(ctx);
    if (!desk.ok) throw new ConvexError({ code: "FORBIDDEN", message: "The triage desk is for staff on the team." });
    if (!onTheDesk(desk.folders, path)) throw new ConvexError({ code: "FORBIDDEN", message: "Only bug reports and reviews open here." });
    return { userId: desk.userId, workspaceId: desk.workspaceId };
  },
});

interface Desk {
  userId: Id<"users">;
  workspaceId: Id<"workspaces">;
}

interface Clearance {
  scope: "private" | "team";
  grantedNames: string[];
  actorName: string | null;
}

async function clearance(ctx: ActionCtx, desk: Desk, minimum: "member" | "editor"): Promise<Clearance> {
  return await ctx.runQuery(internal.functions.files.authorizeFileAccess, { actorUserId: desk.userId, workspaceId: desk.workspaceId, minimum });
}

const mailValidator = v.object({ at: v.string(), from: v.string(), to: v.union(v.string(), v.null()), text: v.string() });

async function readOnDesk(ctx: ActionCtx, desk: { workspaceId: Id<"workspaces"> }, access: { scope: "private" | "team"; grantedNames: string[] }, path: string) {
  const read = await ctx.runAction(internal.functions.files.runFileOperation, {
    workspaceId: desk.workspaceId,
    scope: access.scope,
    grantedNames: access.grantedNames,
    operation: { kind: "read", path },
  });
  if (read.kind !== "file" || read.encrypted) throw new ConvexError({ code: "NOT_FOUND", message: "That note is not readable here." });
  return read;
}

/** One report or review, as text with its mail apart. Shown, never rendered. */
export const readNote = action({
  args: { path: v.string() },
  returns: v.object({ path: v.string(), text: v.string(), mail: v.array(mailValidator) }),
  handler: async (ctx, { path }): Promise<{ path: string; text: string; mail: { at: string; from: string; to: string | null; text: string }[] }> => {
    const desk: Desk = await ctx.runQuery(internal.functions.texDashboard.deskFor, { path });
    const read = await readOnDesk(ctx, desk, await clearance(ctx, desk, "member"), path);
    const mail = parseMail(read.text).events.filter((event) => event.kind === "mail");
    return {
      path: read.path,
      text: stripMail(read.text),
      mail: mail.map((event) => ({ at: event.at, from: event.from, to: event.to ?? null, text: event.text ?? "" })),
    };
  },
});

const MAX_COMMENT = 2_000;

/**
 * Comment to the triage agent, send a note to be fixed, retire it or reopen
 * it: mail to `triage` from the staff member's handle, and the `status:` the
 * action leaves. Written at the version read, once more on a conflict.
 */
export const act = action({
  args: { path: v.string(), action: v.union(...TRIAGE_ACTIONS.map((name) => v.literal(name))), comment: v.optional(v.string()) },
  returns: v.object({ status: v.union(v.string(), v.null()) }),
  handler: async (ctx, args): Promise<{ status: string | null }> => {
    const comment = (args.comment ?? "").slice(0, MAX_COMMENT);
    const said = mailFor(args.action as TriageAction, comment);
    if (said === null) throw new ConvexError({ code: "INVALID", message: "Write a comment first." });
    const desk: Desk = await ctx.runQuery(internal.functions.texDashboard.deskFor, { path: args.path });
    const access = await clearance(ctx, desk, "editor");
    const status = STATUS_AFTER[args.action as TriageAction];
    const from = access.actorName !== null && /^[a-z0-9][a-z0-9-]{0,63}$/.test(access.actorName) ? `@${access.actorName}` : "dashboard";
    for (let attempt = 0; ; attempt += 1) {
      const read = await readOnDesk(ctx, desk, access, args.path);
      const base = status === null ? read.text : withStatus(read.text, status);
      const mail = appendMail(base, { from, kind: "mail", to: TRIAGE_AGENT, text: said });
      if (mail.error !== undefined) throw new ConvexError({ code: "INVALID", message: mail.error });
      try {
        await ctx.runAction(internal.functions.files.runFileOperation, {
          workspaceId: desk.workspaceId,
          scope: access.scope,
          grantedNames: access.grantedNames,
          actorName: access.actorName,
          operation: { kind: "write", path: read.path, text: applyChanges(base, mail.changes), expectedEtag: read.etag },
        });
        return { status };
      } catch (error) {
        const code = error instanceof ConvexError ? (error.data as { code?: string })?.code : undefined;
        if (code !== "CONFLICT" || attempt >= 1) throw error;
      }
    }
  },
});
