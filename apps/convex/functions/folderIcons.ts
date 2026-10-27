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

import { audienceOfNames } from "./lib/pinnedReaders";
import type { Audience } from "./lib/nodes/rowAccess";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { nameSaysSomething, suggestIconFor } from "@context/shared/src/iconSuggest";
import { contextIconByWords, suggestContextIconFor } from "@context/shared/src/contextIconSuggest";
import { contextIconMarker } from "@context/shared/src/contextIcons.cjs";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action, type ActionCtx } from "../_generated/server";
import { callerId } from "./lib/filesFns/access";
import { emojiMeaningSet } from "@context/shared/src/emojiMeaning";
import { nearestByMeaning, startFill } from "./lib/emojiMeaningLookup";
import { withJev } from "./lib/jev/client";
import { clearanceOf } from "./lib/clearance";
import type { PrivacyState } from "./lib/fileOps/privacyState";
import type { Visibility } from "./lib/privacy";
import { checkFolderIcon, visibleFolderIcons } from "./lib/fileOps/folderIcons";
import { toConvexError } from "./lib/filesFns/operationErrors";
import { NO_BUCKET, servedNodesStore } from "./lib/nodes/manifestStore";
import { servedStoreOrNotServed } from "./lib/nodes/treeGate";
import { attachTreeListing } from "./lib/nodes/treeNames";

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

/** The rules icons are judged by: the ones readers judge by (`lib/nodes/readerRules.ts`), in the shape `loadPrivacyState` gave. */
async function judgedState(ctx: ActionCtx, workspaceId: Id<"workspaces">, audience: Audience): Promise<PrivacyState> {
  const held = await ctx.runQuery(internal.functions.nodesPrivacy.readerRules, { workspaceId, audience });
  return {
    rules: held.rules.map((rule) => ({ prefix: rule.prefix, vis: rule.vis as Visibility })),
    overrides: new Map(held.overrides.map((note): [string, Visibility] => [note.path, note.vis as Visibility])),
    text: null,
    etag: null,
    invalid: false,
  };
}

/** The icons this clearance may see, over the tree's rules; none while the tree does not serve. */
async function visible(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  clearance: ReturnType<typeof clearanceOf>,
): Promise<Icons> {
  // A workspace whose file has not been imported yet starts that here.
  await ctx.runMutation(internal.functions.smallData.request, { workspaceId }).catch(() => {});
  const tree = await servedNodesStore(ctx, workspaceId, NO_BUCKET);
  if (tree === null) return [];
  // A pin reader's icons are judged by a guest's rules (`lib/pinnedReaders.ts`).
  const state = await judgedState(ctx, workspaceId, audienceOfNames(clearance.names));
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
    const tree = await servedStoreOrNotServed(ctx, args.workspaceId);
    // "Does the folder exist" is the tree's answer, asked through its listing (`namesListing`).
    attachTreeListing(ctx, args.workspaceId, tree);
    let path: string;
    try {
      path = await checkFolderIcon({
        path: args.path,
        icon: args.icon,
        clearance,
        state: await judgedState(ctx, args.workspaceId, "member"),
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
 * The emoji the picker suggests for `path`, from its name alone, or `null`
 * (with `set: "context"`, one of Context's own icons, `contextIconSuggest.ts`):
 * a name that says nothing (`untitled-2026-10-14`), switched
 * off, over the day's cap, or Clef not answering. Null is "no suggestion",
 * never an error; the picker still offers a random one.
 *
 * The emoji whose meaning fingerprint is closest to the name's answers it
 * (one embedding call, `lib/emojiMeaningLookup.ts`); Clef answers only while
 * the fingerprints are being built or the model is down.
 *
 * Only the name is sent, so nothing is read from the bucket and the answer
 * says nothing about whether `path` exists. Only an editor may ask, the one
 * who could set the icon, and Clef's questions are metered on this
 * workspace; past the day's cap the lookup by meaning still answers.
 */
export const suggest = action({
  args: { workspaceId: v.id("workspaces"), path: v.string(), set: v.optional(v.literal("context")) },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args): Promise<string | null> => {
    const started = Date.now();
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    const set = emojiMeaningSet();
    const { open, state } = await ctx.runQuery(internal.functions.emojiMeaning.prepareSuggest, {
      actorUserId: userId,
      workspaceId: args.workspaceId,
      set,
    });
    const path = args.path.slice(0, 1024);
    if (!open || !nameSaysSomething(path)) return null;
    if (args.set === "context") {
      // One of Context's own icons: a word of the name first, then Clef over the hundred.
      const byWords = contextIconByWords(path);
      if (byWords !== null) return logged(contextIconMarker(byWords.name), "words", started);
      const picked = await withJev(ctx, { feature: "iconSuggest", workspaceId: args.workspaceId }, async (jev) =>
        jev ? await suggestContextIconFor(path, (request) => jev.decide(request)) : null,
      );
      return logged(picked, "clef", started);
    }
    if (state === "ready") {
      const near = await nearestByMeaning(ctx, args.workspaceId, set, path);
      if (near !== null) return logged(near, "meaning", started);
    } else {
      await startFill(ctx, set);
    }
    const asked = await withJev(ctx, { feature: "iconSuggest", workspaceId: args.workspaceId }, async (jev) =>
      jev ? await suggestIconFor(path, (request) => jev.decide(request)) : null,
    );
    return logged(asked, "clef", started);
  },
});

/** One line per answered suggestion: which way it came and how long it took. Never the name or the emoji. */
function logged(icon: string | null, via: "meaning" | "clef" | "words", started: number): string | null {
  console.log(JSON.stringify({ event: "icon_suggest", via, answered: icon !== null, ms: Date.now() - started }));
  return icon;
}
