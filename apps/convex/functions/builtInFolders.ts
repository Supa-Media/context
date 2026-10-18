/**
 * Built-in folders: adding one a workspace does not have yet (an extra from
 * "Add a folder", or a main folder an older workspace lacks; editor, like any
 * new folder; `lib/fileOps/builtInFolders.ts`), and which folder does each job
 * (owner, 2026-10-18; `lib/nodes/folderJobSettings.ts`).
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { type ActionCtx, action, internalMutation, internalQuery } from "../_generated/server";
import { type FolderJobs, JOB_LABEL, NO_JOB } from "@context/shared/src/folderRoles.cjs";
import {
  INBOX_PARTS,
  INBOX_PART_LABEL,
  JOB_GROUP,
  JOB_LINE,
  SHOWN_JOBS,
  canGiveJob,
  canRemoveJob,
  guessFolderJobs,
} from "@context/shared/src/folderJobInfo.cjs";
import { callerId } from "./lib/filesFns/access";
import type { OperationResult } from "./lib/filesFns/operationTypes";
import { type Clearance, clearanceOf } from "./lib/clearance";
import { folderVisibleAtScope } from "./lib/fileOps/listing";
import { requireFolderPath } from "./lib/fileOps/paths";
import { toConvexError } from "./lib/filesFns/operationErrors";
import { type FileErrorCode, FileOpError, notFound } from "./lib/fileOps/errors";
import { folderJobsOf } from "./lib/nodes/folderJobs";
import { decideJobChange, isRefusal, surveyFolders } from "./lib/nodes/folderJobSettings";
import type { Visibility } from "./lib/privacy";

/** Add the folder for `role` ("clients", "teams", "products", or a main role) under its fixed name. */
export const add = action({
  args: { workspaceId: v.id("workspaces"), role: v.string() },
  returns: v.object({ path: v.string(), readme: v.string() }),
  handler: async (ctx, args): Promise<{ path: string; readme: string }> => {
    const actorUserId = await callerId(ctx);
    const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "editor",
    });
    const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      grantedNames,
      operation: { kind: "addBuiltInFolder", role: args.role },
    })) as Extract<OperationResult, { kind: "folderCreated" }>;
    return { path: result.path, readme: result.readme };
  },
});

/** The jobs as they stand, and the live folders guesses are drawn from. Unfiltered: `jobs` filters. INTERNAL. */
export const survey = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({
    jobs: v.record(v.string(), v.union(v.string(), v.null())),
    folders: v.array(v.object({ path: v.string(), role: v.optional(v.string()) })),
  }),
  handler: async (ctx, { workspaceId }) => {
    const [jobs, folders] = await Promise.all([folderJobsOf(ctx.db, workspaceId), surveyFolders(ctx.db, workspaceId)]);
    return {
      jobs: jobs.jobs,
      folders: folders.map((row) => ({ path: row.path, ...(typeof row.role === "string" ? { role: row.role } : {}) })),
    };
  },
});

/** Gives `job` to `path`, or takes it away (`path` null), in one transaction (`decideJobChange`). INTERNAL. */
export const writeJob = internalMutation({
  args: { workspaceId: v.id("workspaces"), job: v.string(), path: v.union(v.string(), v.null()) },
  returns: v.union(v.null(), v.object({ code: v.string(), message: v.string() })),
  handler: async (ctx, { workspaceId, job, path }) => {
    const rowAt = async (at: string) => {
      const row = await ctx.db
        .query("nodes")
        .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).eq("path", at))
        .unique();
      return row !== null && row.goneAt === undefined && row.kind === "folder" ? row : null;
    };
    const target = path === null ? null : await rowAt(path);
    const jobs = await folderJobsOf(ctx.db, workspaceId);
    const change = decideJobChange(jobs, job, path, () => target !== null);
    if (isRefusal(change)) return change;
    for (const old of change.clear) {
      const row = await rowAt(old);
      if (row !== null && row.role !== NO_JOB) await ctx.db.patch(row._id, { role: NO_JOB });
    }
    if (change.set !== null && target !== null) await ctx.db.patch(target._id, { role: job });
    return null;
  },
});

type Access = { role: string; scope: "private" | "team"; grantedNames: string[] };
type Survey = { jobs: Record<string, string | null>; folders: { path: string; role?: string }[] };
type JobsView = {
  jobs: { job: string; label: string; group: string; line: string; path: string | null; canChange: boolean; canRemove: boolean }[];
  inboxParts: { name: string; label: string; path: string | null }[];
  guesses: { job: string; path: string; why: string }[];
  missingNeeded: string[];
};

/** One job as Settings, the import picker and the folder menu draw it. */
const jobView = v.object({
  job: v.string(),
  label: v.string(),
  group: v.string(),
  line: v.string(),
  path: v.union(v.string(), v.null()),
  canChange: v.boolean(),
  canRemove: v.boolean(),
});

/**
 * Every job: its group, its one line, the folder doing it wherever that is
 * nested, the Inbox's own folders, and guesses for jobs no folder does yet.
 * Any member; a folder the caller cannot see reads as no folder, and only an
 * owner is offered changes (a job decides where everybody's mail lands).
 */
export const jobs = action({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({
    jobs: v.array(jobView),
    inboxParts: v.array(v.object({ name: v.string(), label: v.string(), path: v.union(v.string(), v.null()) })),
    guesses: v.array(v.object({ job: v.string(), path: v.string(), why: v.string() })),
    missingNeeded: v.array(v.string()),
  }),
  handler: async (ctx, args): Promise<JobsView> => {
    try {
      const actorUserId = await callerId(ctx);
      const access: Access = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
        actorUserId,
        workspaceId: args.workspaceId,
        minimum: "member",
      });
      const visible = await visibleTo(ctx, args.workspaceId, clearanceOf(access.scope, access.grantedNames ?? []));
      const held: Survey = await ctx.runQuery(internal.functions.builtInFolders.survey, { workspaceId: args.workspaceId });
      const folders = held.folders.filter((folder) => visible(folder.path));
      const seen = new Set(folders.map((folder) => folder.path));
      const shownJobs: FolderJobs = { jobs: {} as FolderJobs["jobs"], roots: [] };
      for (const [job, path] of Object.entries(held.jobs)) {
        (shownJobs.jobs as Record<string, string | null>)[job] = path !== null && visible(path) ? path : null;
      }
      const owner = access.role === "owner";
      const inbox = shownJobs.jobs.inbox;
      return {
        jobs: SHOWN_JOBS.map((job) => ({
          job,
          label: JOB_LABEL[job],
          group: JOB_GROUP[job],
          line: JOB_LINE[job],
          path: shownJobs.jobs[job],
          canChange: owner && canGiveJob(job),
          canRemove: owner && canRemoveJob(job) && shownJobs.jobs[job] !== null,
        })),
        inboxParts: INBOX_PARTS.map((name) => {
          const path = inbox === null ? null : `${inbox}/${name}`;
          return { name, label: INBOX_PART_LABEL[name], path: path !== null && seen.has(path) ? path : null };
        }),
        guesses: owner ? guessFolderJobs(folders, shownJobs) : [],
        missingNeeded: SHOWN_JOBS.filter((job) => JOB_GROUP[job] === "needed" && shownJobs.jobs[job] === null),
      };
    } catch (error) {
      throw toConvexError(error);
    }
  },
});

/** Give `job` to the folder at `path`, or take an optional job away (`path` null). Owner. Nothing moves. */
export const setJob = action({
  args: { workspaceId: v.id("workspaces"), job: v.string(), path: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    try {
      const path = jobFolderPath(args.path);
      const actorUserId = await callerId(ctx);
      const access: Access = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
        actorUserId,
        workspaceId: args.workspaceId,
        minimum: "owner",
      });
      await giveJob(ctx, args.workspaceId, clearanceOf(access.scope, access.grantedNames ?? []), args.job, path);
      return null;
    } catch (error) {
      throw toConvexError(error);
    }
  },
});

/** A folder path for a job, or null to take the job away; never the workspace itself. */
export function jobFolderPath(input: string | null): string | null {
  if (input === null) return null;
  const path = requireFolderPath(input);
  if (path === "") throw new FileOpError("PATH_INVALID", "Name a folder, not the whole workspace.");
  return path;
}

/**
 * Give `job` to the folder at `path` (null: take it away) for a caller already
 * cleared as the workspace's owner at `clearance`: the app's `setJob` and an
 * AI client's `layout` with a job (`gatewayRoutes/workspaces.ts`). A folder the
 * caller cannot see is not found. Refusals are `FileOpError`s in words.
 */
export async function giveJob(ctx: ActionCtx, workspaceId: Id<"workspaces">, clearance: Clearance, job: string, path: string | null): Promise<void> {
  if (path !== null) {
    const visible = await visibleTo(ctx, workspaceId, clearance);
    if (!visible(path)) throw notFound();
  }
  const refused: { code: string; message: string } | null = await ctx.runMutation(internal.functions.builtInFolders.writeJob, { workspaceId, job, path });
  if (refused !== null) throw new FileOpError(refused.code as FileErrorCode, refused.message);
}

/** Whether the caller can see the folder at a path (`folderVisibleAtScope`). */
async function visibleTo(ctx: ActionCtx, workspaceId: Id<"workspaces">, clearance: Clearance): Promise<(path: string) => boolean> {
  const held: { rules: { prefix: string; vis: string }[]; overrides: { path: string; vis: string }[] } = await ctx.runQuery(
    internal.functions.nodesPrivacy.readerRules,
    { workspaceId },
  );
  const rules = held.rules.map((rule) => ({ prefix: rule.prefix, vis: rule.vis as Visibility }));
  const overrides = new Map(held.overrides.map((note): [string, Visibility] => [note.path, note.vis as Visibility]));
  return (path) => folderVisibleAtScope(path, clearance, rules, overrides);
}
