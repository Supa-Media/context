/**
 * Shared with me's titles from each workspace object, where the shared notes live there (decided by the owner,
 * 2026-11-02; `docs/decisions/storage-and-credentials/facts-in-objects.md`).
 *
 * `shares.listSharedWithMe` is a live query, and a query cannot ask an object, so its titles come from the control
 * plane's copy of the notes' facts. This action answers the same titles from the objects, read at each note's
 * current text, and the app shows them over the list's own (`apps/mobile/features/console/shared/useSharedWithMe.ts`).
 *
 * It takes no paths from the caller. The list is built again here for the signed-in person (`sharedWithUser`), and
 * only the notes it says may be titled are asked about: a share's note as `readThroughShare` would open it, a grant's
 * as `guestCanSee` already did. So this answers nothing the list itself would not.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action, internalQuery } from "../_generated/server";
import { requireAuthId } from "./lib/signedIn";
import { objectFactRows, objectPropsAt } from "./lib/nodes/objectFacts";
import { titleFromProps, type TitleAsk } from "./lib/shares/inboxTitle";
import { sharedWithUser } from "./lib/shares/recipients";

const askValidator = v.object({ workspaceId: v.id("workspaces"), path: v.string() });
const titleValidator = v.object({ workspaceId: v.id("workspaces"), entryPath: v.string(), title: v.string() });

/** The notes in the caller's list whose titles may be told. */
export const titleAsks = internalQuery({
  args: {},
  returns: v.array(askValidator),
  handler: async (ctx) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    const asks: TitleAsk[] = [];
    await sharedWithUser(ctx, userId, Date.now(), asks);
    return asks;
  },
});

/** Each titled note's title as its workspace object reads it now; a note it does not answer for is left out. */
export const now = action({
  args: {},
  returns: v.array(titleValidator),
  handler: async (ctx): Promise<Array<{ workspaceId: Id<"workspaces">; entryPath: string; title: string }>> => {
    const asks: TitleAsk[] = await ctx.runQuery(internal.functions.sharedTitles.titleAsks, {});
    const byWorkspace = new Map<Id<"workspaces">, string[]>();
    for (const ask of asks) byWorkspace.set(ask.workspaceId, [...(byWorkspace.get(ask.workspaceId) ?? []), ask.path]);
    const titles: Array<{ workspaceId: Id<"workspaces">; entryPath: string; title: string }> = [];
    for (const [workspaceId, paths] of byWorkspace) {
      const held = await objectPropsAt(await objectFactRows(ctx, workspaceId), paths);
      if (held === null) continue;
      for (const path of paths) {
        const title = titleFromProps(held.get(path)?.props ?? undefined);
        if (title !== null) titles.push({ workspaceId, entryPath: path, title });
      }
    }
    return titles;
  },
});
