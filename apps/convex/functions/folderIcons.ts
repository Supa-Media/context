/**
 * Folder icons: the emoji somebody gave a folder from "Set icon…" in its menu.
 *
 * Held in Convex (`folderIcons`, `lib/schema/smallData.ts`) since 2026-10-14,
 * and read from there: no bucket is opened to list or set one. Each change is
 * written to the workspace's own `.context/folder-icons.json` afterwards
 * (`lib/smallData/sync.ts`), so the export keeps them. Who sees which is
 * decided over the tree's rules mirror (`lib/fileOps/folderIcons.ts`). Any
 * member reads the icons of the folders they can see; changing one changes
 * what everybody's folder list looks like, so it takes an editor, the same
 * role renaming the folder takes.
 *
 * Until a workspace's file has been imported, it shows the icons Convex
 * holds, which may be none; asking starts the import.
 */

import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { emojiRequest, nameSaysSomething, readEmoji, readTopic, topicRequest } from "@context/shared/src/iconSuggest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action, type ActionCtx } from "../_generated/server";
import { callerId } from "./lib/filesFns/access";
import { withJev } from "./lib/jev/client";
import { clearanceOf } from "./lib/clearance";
import { loadPrivacyState } from "./lib/fileOps";
import { checkFolderIcon, visibleFolderIcons } from "./lib/fileOps/folderIcons";
import { toConvexError } from "./lib/filesFns/operationErrors";
import { servedNodesStore } from "./lib/nodes/manifestStore";
import { NO_BUCKET, servedStoreOrLoading } from "./lib/nodes/treeLoading";

type Icons = Array<{ path: string; icon: string }>;

async function clearanceFor(ctx: ActionCtx, workspaceId: Id<"workspaces">, minimum: "member" | "editor") {
  const actorUserId = await callerId(ctx);
  const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
    actorUserId,
    workspaceId,
    minimum,
  });
  return clearanceOf(scope, grantedNames ?? []);
}

/** The icons this clearance may see, over the tree's rules; none while the tree is still loading. */
async function visible(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  clearance: ReturnType<typeof clearanceOf>,
): Promise<Icons> {
  // A workspace whose file has not been imported yet starts that here.
  await ctx.runMutation(internal.functions.smallData.request, { workspaceId }).catch(() => {});
  const tree = await servedNodesStore(ctx, workspaceId, NO_BUCKET);
  if (tree === null) return [];
  const state = await loadPrivacyState(tree);
  const held = await ctx.runQuery(internal.functions.smallData.icons, { workspaceId });
  const icons = visibleFolderIcons(Object.fromEntries(held.map(({ path, icon }) => [path, icon])), { clearance, state });
  return Object.entries(icons).map(([path, icon]) => ({ path, icon }));
}

const iconsValidator = v.array(v.object({ path: v.string(), icon: v.string() }));

/** Every icon on a folder the caller can see. Any member. */
export const list = action({
  args: { workspaceId: v.id("workspaces") },
  returns: iconsValidator,
  handler: async (ctx, args): Promise<Icons> =>
    await visible(ctx, args.workspaceId, await clearanceFor(ctx, args.workspaceId, "member")),
});

/** Give a folder an icon, or remove it with `icon: null`. Editor. Answers with every icon the caller can see. */
export const set = action({
  args: { workspaceId: v.id("workspaces"), path: v.string(), icon: v.union(v.string(), v.null()) },
  returns: iconsValidator,
  handler: async (ctx, args): Promise<Icons> => {
    const clearance = await clearanceFor(ctx, args.workspaceId, "editor");
    const tree = await servedStoreOrLoading(ctx, args.workspaceId);
    let path: string;
    try {
      path = await checkFolderIcon({
        path: args.path,
        icon: args.icon,
        clearance,
        state: await loadPrivacyState(tree),
        tree,
        hasEmoji: async (name) =>
          (await ctx.runQuery(internal.functions.smallData.emojiLeaf, { workspaceId: args.workspaceId, name })) !== null,
      });
    } catch (error) {
      throw toConvexError(error);
    }
    await ctx.runMutation(internal.functions.smallData.setIcon, { workspaceId: args.workspaceId, path, icon: args.icon });
    return await visible(ctx, args.workspaceId, clearance);
  },
});

/**
 * The emoji the picker suggests for `path`, from its name alone, or `null`:
 * a name that says nothing (`untitled-2026-10-14`), no topic fits, switched
 * off, over the day's cap, or Clef not answering. Null is "no suggestion",
 * never an error; the picker still offers a random one.
 *
 * Only the name is sent, so nothing is read from the bucket and the answer
 * says nothing about whether `path` exists. Only an editor may ask, the one
 * who could set the icon, and it is metered on this workspace.
 */
export const suggest = action({
  args: { workspaceId: v.id("workspaces"), path: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args): Promise<string | null> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId: userId,
      workspaceId: args.workspaceId,
      minimum: "editor",
    });
    const path = args.path.slice(0, 1024);
    if (!nameSaysSomething(path)) return null;
    const kind = path.toLowerCase().endsWith(".md") ? "note" : "folder";
    return await withJev(ctx, { feature: "iconSuggest", workspaceId: args.workspaceId }, async (jev): Promise<string | null> => {
      if (!jev) return null;
      const topic = readTopic(await jev.decide(topicRequest(path, kind)));
      if (topic === null) return null;
      const request = emojiRequest(path, kind, topic);
      return request === null ? null : readEmoji(await jev.decide(request), topic);
    });
  },
});
