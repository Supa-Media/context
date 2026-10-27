/**
 * Names as you type, from the tree, in every workspace (the search tune-up,
 * Dev2's pick, 2026-10-27; board M1).
 *
 * The palette's instant names came only from folders the browser had loaded,
 * so a note in a folder nobody had opened was not offered by name until the
 * server's word search answered, a second or more later. Every name is already
 * a row in the tree (decided by the owner, 2026-10-14: names come from the
 * tree), so this reads them there: a query, from the first letter, live, in
 * every workspace the caller can search.
 *
 * ## Who sees what
 *
 * The scope is `searchScopeFor`, the blended search's own list, narrowed by
 * `contexts` and never widened (`resolveScope`). Each workspace is then
 * re-authorized through `resolveFileAccess`, the one door a listing uses, and
 * every row passes the caller's own `canSee` against the rules the tree's
 * listing judges by (`readerView`). So a name this returns is a name the
 * caller's folder listing would show; a private note's name never reaches a
 * team member, and a workspace the caller left is not searched. A workspace
 * whose tree does not serve yet is skipped, as its listing would be.
 *
 * The query text is not logged anywhere, the blended search's rule.
 */

import { v } from "convex/values";
import { query, type QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { clearanceOf } from "./lib/clearance";
import { callerId, resolveFileAccess } from "./lib/filesFns/access";
import { searchScopeFor } from "./lib/fastSearchFns/scope";
import { resolveScope } from "./lib/blendedSearch";
import { canSee, isPlumbing } from "./lib/privacy";
import { treeServesNow } from "./lib/nodes/listing";
import { readerView } from "./lib/nodes/readerRules";
import { audienceOfNames } from "./lib/pinnedReaders";
import { drawnMoves } from "./lib/nodes/rowMoveChunks";
import { isIndexableNote } from "../../mcp/src/search/indexable.js";

/** Rows read per workspace: a palette shows a handful, and a query is bounded. */
const PER_WORKSPACE = 24;
/** Names returned in all. */
export const NAME_RESULTS = 8;
/** Workspaces searched, the most the palette's scope ever lists. */
const WORKSPACE_CAP = 16;
/** A name is short; anything longer is not a name being typed. */
const QUERY_CAP = 120;

const nameRowValidator = v.object({
  workspaceId: v.id("workspaces"),
  slug: v.string(),
  displayName: v.string(),
  path: v.string(),
  title: v.string(),
});

export type NameRow = {
  workspaceId: Id<"workspaces">;
  slug: string;
  displayName: string;
  path: string;
  title: string;
};

export const searchNames = query({
  args: {
    query: v.string(),
    /** Workspace ids to narrow to; absent or empty is every workspace the caller can search. */
    contexts: v.optional(v.array(v.id("workspaces"))),
  },
  returns: v.array(nameRowValidator),
  handler: async (ctx, args): Promise<NameRow[]> => {
    const asked = args.query.trim();
    if (asked === "" || asked.length > QUERY_CAP) return [];
    const actorUserId = await callerId(ctx);
    const scope = resolveScope(await searchScopeFor(ctx, actorUserId), args.contexts).slice(0, WORKSPACE_CAP);
    const each = await Promise.all(
      scope.map(async (context) => {
        const workspaceId = context.workspaceId as Id<"workspaces">;
        const rows = await namesIn(ctx, actorUserId, workspaceId, asked);
        return rows.map((row, rank) => ({
          rank,
          row: { workspaceId, slug: context.slug, displayName: context.displayName, ...row },
        }));
      }),
    );
    return rankNames(each.flat(), asked).slice(0, NAME_RESULTS);
  },
});

/** One workspace's matching names this caller may see, in the search index's order. */
async function namesIn(
  ctx: QueryCtx,
  actorUserId: Id<"users">,
  workspaceId: Id<"workspaces">,
  asked: string,
): Promise<{ path: string; title: string }[]> {
  let access;
  try {
    access = await resolveFileAccess(ctx, { actorUserId, workspaceId, minimum: "member" });
  } catch {
    // Not a member any more: the same nothing as a workspace with no match.
    return [];
  }
  if (!(await treeServesNow(ctx.db, workspaceId))) return [];
  const clearance = clearanceOf(access.scope, access.grantedNames);
  const { judged } = await readerView(ctx, workspaceId, audienceOfNames(clearance.names));
  // A note a folder move is still carrying is listed at its new name by the
  // tree's overlay; its row is at the old one, so it is left to the word search.
  const moving = (await drawnMoves(ctx.db, workspaceId)).map((move) => `${move.from}/`);
  const rows = await ctx.db
    .query("nodes")
    .withSearchIndex("search_name", (q) => q.search("name", asked).eq("workspaceId", workspaceId).eq("kind", "file"))
    .take(PER_WORKSPACE);
  return rows
    .filter(
      (row) =>
        row.goneAt === undefined &&
        isIndexableNote(row.path) &&
        !isPlumbing(row.path) &&
        !moving.some((from) => row.path.startsWith(from)) &&
        canSee(row.path, clearance.scope, judged.rules, judged.overrides, clearance.names),
    )
    .map((row) => ({ path: row.path, title: row.name.replace(/\.md$/i, "") }));
}

/**
 * One list from every workspace's: a name that starts with what was typed
 * first, then a name with a word that does, then the rest, each workspace's
 * own order kept within a tier so its best match leads it.
 */
export function rankNames<T extends { title: string }>(found: { rank: number; row: T }[], asked: string): T[] {
  const typed = asked.toLowerCase();
  const tier = (title: string) => {
    const name = title.toLowerCase();
    if (name.startsWith(typed)) return 0;
    if (name.split(/[^\p{L}\p{N}]+/u).some((word) => word.startsWith(typed.split(/\s+/)[0] ?? typed))) return 1;
    return 2;
  };
  return [...found]
    .sort((a, b) => tier(a.row.title) - tier(b.row.title) || a.rank - b.rank || a.row.title.localeCompare(b.row.title))
    .map((entry) => entry.row);
}
