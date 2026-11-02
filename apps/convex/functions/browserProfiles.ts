import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, internalQuery, type MutationCtx } from "../_generated/server";
import { internalMutation } from "./lib/rowWatch/mutations";

/**
 * TEX'S SAVED BROWSER PROFILES AT BROWSERBASE: made, found and released here.
 *
 * Decided by the owner, 2026-10-29 (`docs/decisions/texting-assistant/vault.md`),
 * reversing 2026-10-20/22: Tex's browser keeps its sign-ins in a Browserbase
 * Context (a saved Chrome profile) by default, one per person and one per
 * group chat's set of people, because a Google sign-in replayed from the
 * sealed jar dies (it is bound to the browser's own key). The jar stays,
 * re-sealed after every run, as the fallback and the copy a person leaves with.
 *
 * The control plane holds the only handle on each profile (`browserProfiles`
 * rows), the way it holds the one on a search database, so a deleted account
 * or workspace, and "sign Tex out", release it at Browserbase. The key is
 * `BROWSERBASE_API_KEY` (and `BROWSERBASE_PROJECT_ID` to make one); without
 * them nothing is made and Tex's browser runs on the jar alone, as before.
 */

const API = "https://api.browserbase.com/v1";

/** Tries to delete a profile at Browserbase before a row is left for a person to see. */
export const MAX_RELEASE_TRIES = 12;

/** Backoff after a failed release: one minute, doubling, at most six hours. */
export function releaseBackoffMs(failures: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, failures - 1), 6 * 60 * 60 * 1000);
}

function browserbaseKey(): { key: string; projectId: string } | null {
  const key = process.env.BROWSERBASE_API_KEY ?? "";
  const projectId = process.env.BROWSERBASE_PROJECT_ID ?? "";
  return key && projectId ? { key, projectId } : null;
}

export function browserProfilesConfigured(): boolean {
  return browserbaseKey() !== null;
}

/** A new, empty profile at Browserbase; null when this deployment has no key or the vendor refused. */
export async function createBrowserbaseProfile(fetcher: typeof fetch = fetch): Promise<string | null> {
  const config = browserbaseKey();
  if (config === null) return null;
  try {
    const response = await fetcher(`${API}/contexts`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-BB-API-Key": config.key },
      body: JSON.stringify({ projectId: config.projectId }),
    });
    if (!response.ok) {
      // The status only: the vendor's body can name the account.
      console.log(JSON.stringify({ event: "browser_profile_create_refused", status: response.status }));
      return null;
    }
    const id = ((await response.json()) as { id?: unknown })?.id;
    return typeof id === "string" && /^[A-Za-z0-9-]{8,64}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** The owner's live profile, if it has one filed under this workspace. */
export const liveProfile = internalQuery({
  args: { workspaceId: v.id("workspaces"), owner: v.string() },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, { workspaceId, owner }) => {
    const row = await ctx.db
      .query("browserProfiles")
      .withIndex("by_owner", (q) => q.eq("owner", owner))
      .filter((q) => q.eq(q.field("status"), "live"))
      .first();
    return row !== null && row.workspaceId === workspaceId ? row.profileId : null;
  },
});

/** Mark a row releasing and queue its deletion at Browserbase. */
async function release(ctx: MutationCtx, rowId: Id<"browserProfiles">): Promise<void> {
  await ctx.db.patch(rowId, { status: "releasing" });
  await ctx.scheduler.runAfter(0, internal.functions.browserProfiles.releaseProfile, { rowId });
}

/**
 * File a profile just made for this owner. Two first questions at once can
 * each make one: the first filed wins and the other is released, so an owner
 * never has two. A chat whose people changed has its old profile released.
 * Answers the profile the owner now has, or null when the owner is filed
 * under another workspace (the new one is released).
 */
export const keepProfile = internalMutation({
  args: { workspaceId: v.id("workspaces"), owner: v.string(), chat: v.optional(v.string()), profileId: v.string() },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, { workspaceId, owner, chat, profileId }) => {
    const filed = await ctx.db
      .query("browserProfiles")
      .withIndex("by_owner", (q) => q.eq("owner", owner))
      .filter((q) => q.eq(q.field("status"), "live"))
      .first();
    const rowId = await ctx.db.insert("browserProfiles", {
      workspaceId,
      owner,
      ...(chat !== undefined ? { chat } : {}),
      provider: "browserbase",
      profileId,
      status: "live",
      createdAt: Date.now(),
    });
    if (filed !== null) {
      await release(ctx, rowId);
      return filed.workspaceId === workspaceId ? filed.profileId : null;
    }
    if (chat !== undefined) {
      const earlier = await ctx.db
        .query("browserProfiles")
        .withIndex("by_workspace_chat", (q) => q.eq("workspaceId", workspaceId).eq("chat", chat))
        .collect();
      for (const row of earlier) if (row._id !== rowId && row.status === "live") await release(ctx, row._id);
    }
    return profileId;
  },
});

/** "Sign Tex out": release the owner's profile. Answers how many were released. */
export const forgetProfile = internalMutation({
  args: { workspaceId: v.id("workspaces"), owner: v.string() },
  returns: v.number(),
  handler: async (ctx, { workspaceId, owner }) => {
    const rows = await ctx.db
      .query("browserProfiles")
      .withIndex("by_owner", (q) => q.eq("owner", owner))
      .collect();
    let released = 0;
    for (const row of rows) {
      if (row.workspaceId !== workspaceId || row.status !== "live") continue;
      await release(ctx, row._id);
      released += 1;
    }
    return released;
  },
});

/**
 * Every profile filed under a workspace that is being deleted: a person's own
 * browser with their personal workspace (so with their account), a group
 * chat's with its shared workspace. Called by the workspace cascade.
 */
export async function releaseWorkspaceBrowserProfiles(ctx: MutationCtx, workspaceId: Id<"workspaces">): Promise<void> {
  const rows = await ctx.db
    .query("browserProfiles")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  for (const row of rows) if (row.status === "live") await release(ctx, row._id);
}

export const releaseRow = internalQuery({
  args: { rowId: v.id("browserProfiles") },
  returns: v.union(v.null(), v.object({ profileId: v.string() })),
  handler: async (ctx, { rowId }) => {
    const row = await ctx.db.get(rowId);
    return row !== null && row.status === "releasing" ? { profileId: row.profileId } : null;
  },
});

export const releaseOutcome = internalMutation({
  args: { rowId: v.id("browserProfiles"), deleted: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { rowId, deleted }) => {
    const row = await ctx.db.get(rowId);
    if (row === null) return null;
    if (deleted) {
      await ctx.db.delete(rowId);
      return null;
    }
    const failures = (row.failures ?? 0) + 1;
    await ctx.db.patch(rowId, { failures });
    // Left `releasing` after the last try: the row is the handle a later retry needs.
    if (failures < MAX_RELEASE_TRIES) {
      await ctx.scheduler.runAfter(releaseBackoffMs(failures), internal.functions.browserProfiles.releaseProfile, { rowId });
    }
    return null;
  },
});

/** Delete one profile at Browserbase. A profile it no longer has counts as deleted. */
export const releaseProfile = internalAction({
  args: { rowId: v.id("browserProfiles") },
  returns: v.null(),
  handler: async (ctx, { rowId }) => {
    const row = await ctx.runQuery(internal.functions.browserProfiles.releaseRow, { rowId });
    if (row === null) return null;
    const config = browserbaseKey();
    let deleted = false;
    if (config !== null) {
      try {
        const response = await fetch(`${API}/contexts/${encodeURIComponent(row.profileId)}`, {
          method: "DELETE",
          headers: { "X-BB-API-Key": config.key },
        });
        deleted = response.ok || response.status === 404;
        if (!deleted) console.log(JSON.stringify({ event: "browser_profile_release_failed", status: response.status }));
      } catch {
        deleted = false;
      }
    }
    await ctx.runMutation(internal.functions.browserProfiles.releaseOutcome, { rowId, deleted });
    return null;
  },
});
