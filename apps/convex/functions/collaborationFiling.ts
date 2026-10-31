/**
 * The backfill that files every workspace's editing history by note id
 * (`packages/collaboration/src/backfill.js`; `notes-by-id.md`, "Editing
 * history is filed by note id"). A note opened since that change is filed on
 * its first read; this reaches every other head, so a move never has to carry
 * one again.
 *
 * A cron (`fileDue`) starts a pass for each keyed workspace not yet done; a
 * pass (`fileWorkspace`) lists a page of path heads at a time through the
 * console's own id layer, files each, and records the listing position, so a
 * pass that stops is continued by the next one from where it got. A failure
 * keeps the position and a fixed label. `report` gives the totals, as counts,
 * for the `Collaboration filing` workflow.
 */

import { v } from "convex/values";
import { fileHeadsByNote, supported as collaborationSupported } from "@context/collaboration";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type MutationCtx } from "../_generated/server";
import { storeForBinding } from "../../mcp/src/store/factory.js";
import type { FileStore } from "./lib/fileOps/store";
import { managedEncryptionOption } from "./lib/managedEncryptionFns/storeOption";
import { consoleIdLayoutHooks } from "./lib/noteIds/consoleLayer";
import type { GatewayCredential } from "./lib/storage/shapes";
import { consoleTexStore } from "./lib/texStore";

/** Workspaces one cron tick looks at, and pages one pass files before it hands on to the next pass. */
const WORKSPACE_PAGE = 50;
const PAGES_PER_PASS = 20;
const HEADS_PER_PAGE = 100;
/** A pass holds its workspace this long; one that stopped is taken over after it. */
export const FILING_LEASE_MS = 10 * 60 * 1000;

async function filingOf(ctx: MutationCtx, workspaceId: Id<"workspaces">): Promise<Doc<"collaborationFiling"> | null> {
  return await ctx.db
    .query("collaborationFiling")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
}

/** Every keyed workspace not yet filed, and not held by a running pass, gets a pass. */
export const fileDue = internalMutation({
  args: { cursor: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { cursor }) => {
    const now = Date.now();
    const page = await ctx.db.query("noteIdCopies").paginate({ cursor: cursor ?? null, numItems: WORKSPACE_PAGE });
    for (const copies of page.page) {
      if (copies.keyedAt === undefined) continue;
      const filing = await filingOf(ctx, copies.workspaceId);
      if (filing?.done === true) continue;
      if (filing?.leaseAt !== undefined && now - filing.leaseAt < FILING_LEASE_MS) continue;
      await ctx.scheduler.runAfter(0, internal.functions.collaborationFiling.fileWorkspace, { workspaceId: copies.workspaceId });
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.functions.collaborationFiling.fileDue, { cursor: page.continueCursor });
    return null;
  },
});

/** Take the workspace's lease: the position to start from, or `null` when another pass holds it or it is done. */
export const claim = internalMutation({
  args: { workspaceId: v.id("workspaces"), now: v.number() },
  returns: v.union(v.null(), v.object({ cursor: v.union(v.string(), v.null()) })),
  handler: async (ctx, { workspaceId, now }) => {
    const filing = await filingOf(ctx, workspaceId);
    if (filing === null) {
      await ctx.db.insert("collaborationFiling", { workspaceId, done: false, filed: 0, left: 0, leaseAt: now, updatedAt: now });
      return { cursor: null };
    }
    if (filing.done) return null;
    if (filing.leaseAt !== undefined && now - filing.leaseAt < FILING_LEASE_MS) return null;
    await ctx.db.patch(filing._id, { leaseAt: now, updatedAt: now });
    return { cursor: filing.cursor ?? null };
  },
});

/** Record one page: the position after it, what it filed, and whether the listing is finished. */
export const recordPage = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    cursor: v.union(v.string(), v.null()),
    done: v.boolean(),
    filed: v.number(),
    left: v.number(),
    now: v.number(),
    release: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const filing = await filingOf(ctx, args.workspaceId);
    if (filing === null) return null;
    await ctx.db.patch(filing._id, {
      cursor: args.cursor ?? undefined,
      done: args.done,
      filed: filing.filed + args.filed,
      left: filing.left + args.left,
      error: undefined,
      leaseAt: args.release || args.done ? undefined : args.now,
      updatedAt: args.now,
    });
    return null;
  },
});

/** A pass that failed: the position stays, and the next cron tick tries again. */
export const recordFailure = internalMutation({
  args: { workspaceId: v.id("workspaces"), error: v.string(), now: v.number() },
  returns: v.null(),
  handler: async (ctx, { workspaceId, error, now }) => {
    const filing = await filingOf(ctx, workspaceId);
    if (filing === null) return null;
    await ctx.db.patch(filing._id, { error, leaseAt: undefined, updatedAt: now });
    return null;
  },
});

/** A workspace with no bucket has no history to file. */
export const recordNoStore = internalMutation({
  args: { workspaceId: v.id("workspaces"), now: v.number() },
  returns: v.null(),
  handler: async (ctx, { workspaceId, now }) => {
    const filing = await filingOf(ctx, workspaceId);
    if (filing !== null) await ctx.db.patch(filing._id, { done: true, leaseAt: undefined, updatedAt: now });
    return null;
  },
});

function codeOf(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[A-Z_]{1,40}$/.test(code) ? code : "FILING_FAILED";
}

/** One pass over a workspace's path heads, a page at a time, handing on to another pass when it has used its pages. */
export const fileWorkspace = internalAction({
  args: { workspaceId: v.id("workspaces") },
  returns: v.null(),
  handler: async (ctx, { workspaceId }) => {
    const claimed = await ctx.runMutation(internal.functions.collaborationFiling.claim, { workspaceId, now: Date.now() });
    if (claimed === null) return null;
    let store: FileStore;
    try {
      const credential = (await ctx.runAction(internal.functions.storage.getBindingForGateway, { workspaceId })) as GatewayCredential | null;
      if (credential === null) {
        await ctx.runMutation(internal.functions.collaborationFiling.recordNoStore, { workspaceId, now: Date.now() });
        return null;
      }
      const managedEncryption = await managedEncryptionOption(ctx, workspaceId);
      // Through the console's id layer, so a head made before heads recorded ids is filed under the id of the row at its name.
      store = storeForBinding(credential, undefined, { managedEncryption, idLayout: consoleIdLayoutHooks(ctx, workspaceId), texStore: consoleTexStore(ctx, workspaceId) }) as unknown as FileStore;
    } catch (error) {
      await ctx.runMutation(internal.functions.collaborationFiling.recordFailure, { workspaceId, error: codeOf(error), now: Date.now() });
      return null;
    }
    if (!collaborationSupported(store)) {
      await ctx.runMutation(internal.functions.collaborationFiling.recordNoStore, { workspaceId, now: Date.now() });
      return null;
    }
    let cursor = claimed.cursor;
    try {
      for (let pages = 0; pages < PAGES_PER_PASS; pages += 1) {
        const page = await fileHeadsByNote(store as never, { ...(cursor === null ? {} : { cursor }), limit: HEADS_PER_PAGE });
        const last = page.done || pages === PAGES_PER_PASS - 1;
        await ctx.runMutation(internal.functions.collaborationFiling.recordPage, {
          workspaceId,
          cursor: page.cursor,
          done: page.done,
          filed: page.filed,
          left: page.left,
          now: Date.now(),
          release: last,
        });
        if (page.done) return null;
        cursor = page.cursor;
      }
    } catch (error) {
      console.error("collaboration.filing_failed", { workspaceId, code: codeOf(error) });
      await ctx.runMutation(internal.functions.collaborationFiling.recordFailure, { workspaceId, error: codeOf(error), now: Date.now() });
      return null;
    }
    await ctx.scheduler.runAfter(0, internal.functions.collaborationFiling.fileWorkspace, { workspaceId });
    return null;
  },
});

/**
 * Totals for the `Collaboration filing` workflow, whose log is public: counts
 * and fixed labels only, never a workspace, a path or a time.
 */
export const report = internalQuery({
  args: {},
  returns: v.object({
    keyedWorkspaces: v.number(),
    done: v.number(),
    running: v.number(),
    notStarted: v.number(),
    failing: v.record(v.string(), v.number()),
    filed: v.number(),
    left: v.number(),
  }),
  handler: async (ctx) => {
    const now = Date.now();
    const answer = { keyedWorkspaces: 0, done: 0, running: 0, notStarted: 0, failing: {} as Record<string, number>, filed: 0, left: 0 };
    for await (const copies of ctx.db.query("noteIdCopies")) {
      if (copies.keyedAt === undefined) continue;
      answer.keyedWorkspaces += 1;
      const filing = await ctx.db
        .query("collaborationFiling")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", copies.workspaceId))
        .unique();
      if (filing === null) {
        answer.notStarted += 1;
        continue;
      }
      answer.filed += filing.filed;
      answer.left += filing.left;
      if (filing.done) answer.done += 1;
      else if (filing.error !== undefined) answer.failing[filing.error] = (answer.failing[filing.error] ?? 0) + 1;
      else if (filing.leaseAt !== undefined && now - filing.leaseAt < FILING_LEASE_MS) answer.running += 1;
      else answer.notStarted += 1;
    }
    return answer;
  },
});
