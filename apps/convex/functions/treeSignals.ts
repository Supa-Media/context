import { v } from "convex/values";
import { internalMutation, query } from "../_generated/server";
import { callerId, resolveFileAccess } from "./files";
import { audiencesOf, isAudience } from "./lib/treeAudiences";

/**
 * A hint, per audience, that a workspace's file tree changed.
 *
 * The console keeps a tree of every folder and note a person can see, drawn
 * from metadata on the device and refreshed by walking the bucket's manifest.
 * This is what tells it to walk *now* — when a colleague, an agent, a meeting
 * or an import creates, moves or deletes something — rather than at the next
 * periodic pass. It rides the Convex connection the app already holds, so it
 * costs no socket per folder or per note.
 *
 * It carries a timestamp and nothing else. The walk that follows goes through
 * `syncManifest`, which is `canSee` at the reader's clearance, so the hint
 * decides only *when* a client asks, never *what* it is shown. And the
 * timestamp itself is filtered: each change moves only the stamps of the
 * audiences that can see it (`lib/treeAudiences.ts`), and a reader is served
 * the newest stamp among their own audiences — so a team member's hint never
 * moves for a private note, and never says when one changed.
 *
 * Losing a hint costs freshness, not correctness: the client's periodic walk
 * reconciles whatever a crash between a write and its hint, or a writer that
 * sends none (Obsidian writing to the bucket directly), left behind.
 */

/** More than any real change touches; a bound on a loop, not a policy. */
const MAX_AUDIENCES = 64;

/**
 * Move the stamps of these audiences to now. Forward-only, and clamped to the
 * server's clock, as `markWorkspaceActivity` is. Internal: the console reaches
 * it from `runFileOperation`, the gateway through `/gateway/tree`.
 */
export const markTreeChanged = internalMutation({
  args: { workspaceId: v.id("workspaces"), audiences: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const workspace = await ctx.db.get(args.workspaceId);
    if (workspace === null) return null;
    const at = Date.now();
    const audiences = [...new Set(args.audiences)].filter(isAudience).slice(0, MAX_AUDIENCES);
    for (const audience of audiences) {
      const row = await ctx.db
        .query("treeSignals")
        .withIndex("by_workspace_audience", (q) =>
          q.eq("workspaceId", args.workspaceId).eq("audience", audience),
        )
        .unique();
      if (row === null) {
        await ctx.db.insert("treeSignals", { workspaceId: args.workspaceId, audience, at });
      } else if (row.at < at) {
        await ctx.db.patch(row._id, { at });
      }
    }
    return null;
  },
});

/**
 * When this caller's view of a workspace's tree last changed, or `null` for
 * never. Subscribed by the console for the workspace it has open; a new value
 * means "walk the manifest again".
 *
 * The audiences come from the same resolver `listFiles` and `syncManifest`
 * use. A caller that resolver refuses — a non-member, a departed member, a
 * context that does not exist — gets `null`, the same answer as a context
 * that never changed, rather than an error: `useQuery` rethrows a query's
 * error into the render, so a membership revoked while the console is open
 * would take the page down, and the walk the console makes next is where a
 * refusal is shown. `null` says nothing a stranger could use.
 */
export const treeSignal = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(v.number(), v.null()),
  handler: async (ctx, args): Promise<number | null> => {
    let access: Awaited<ReturnType<typeof resolveFileAccess>>;
    try {
      access = await resolveFileAccess(ctx, {
        actorUserId: await callerId(ctx),
        workspaceId: args.workspaceId,
        minimum: "member",
      });
    } catch {
      return null;
    }
    const { scope, grantedNames } = access;
    let newest: number | null = null;
    for (const audience of audiencesOf(scope, grantedNames)) {
      const row = await ctx.db
        .query("treeSignals")
        .withIndex("by_workspace_audience", (q) =>
          q.eq("workspaceId", args.workspaceId).eq("audience", audience),
        )
        .unique();
      if (row !== null && (newest === null || row.at > newest)) newest = row.at;
    }
    return newest;
  },
});
