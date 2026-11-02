/**
 * Access on the tree's rows, in rows mode (`nodeMigration.accessSource` =
 * `rows`): the writes that replace the rules' `privacy.md` for an owner, and
 * the switch's answer to the callers that ask whether rows are the truth.
 *
 * Internal, except one public mutation, `setGrantees` (the owner's own list,
 * checked there in `lib/nodes/setGrantees.ts`). The console reaches
 * `consoleAccess` through its own handlers (`lib/filesFns/visibility.ts`), which
 * keep their owner check; the gateway reaches `setAccess` through
 * `/gateway/privacy`, which checks the person's grant first. Nothing here
 * answers outside rows mode with a write: that would leave rows the rules do
 * not read.
 */

import { v } from "convex/values";
import { internalQuery, query, type MutationCtx } from "../_generated/server";
import { internalMutation, mutation } from "./lib/rowWatch/mutations";
import type { Id } from "../_generated/dataModel";
import { addGranteesHandler } from "./lib/nodes/addGrantees";
import { granteeRequestValidator, setGranteesAnswerValidator, setGranteesHandler } from "./lib/nodes/setGrantees";
import { shareListHandler, shareListValidator } from "./lib/nodes/shareList";
import { refreshSnapshot, resolveHandle } from "./lib/nodes/accessBackfill";
import { ACTIVITY_PATH } from "@context/shared/src/activity.cjs";
import { scanAccessRows } from "./lib/nodes/accessRows";
import { livePending } from "./lib/nodes/pendingAccess";
import { narrowRowForMove, narrowRowsForMoves, pendPrivateArrivals, setAccessRow, type SetAccessAnswer, type GranteeInput } from "./lib/nodes/setAccess";
import { listForTier, type BuiltIn } from "./lib/nodes/membersPosition";
import { pinnedContextWorkspace } from "./lib/pinnedContext";
import { pinReadersAreGuests } from "./lib/pinnedReaders";
import { renderAccess } from "./lib/nodes/rowAccess";
import { visibilityOf, type Visibility } from "./lib/privacy";
import { exportAccessStateOf } from "./lib/nodes/exportAccessRows";
import { privacyEtagOf } from "./lib/nodes/readerRules";
import { nodeAt } from "./lib/nodes/paths";

const roleValidator = v.union(v.literal("view"), v.literal("edit"));
type RawGrantee =
  | { kind: "user"; userId: string; role: "view" | "edit" }
  | { kind: "group"; groupId: string; role: "view" | "edit" }
  | { kind: "email"; email: string; role: "view" | "edit" };

// Ids arrive as strings from the gateway: a malformed one is an answer (`INVALID`), not an argument error.
const granteeValidator = v.union(
  v.object({ kind: v.literal("user"), userId: v.string(), role: roleValidator }),
  v.object({ kind: v.literal("group"), groupId: v.string(), role: roleValidator }),
  v.object({ kind: v.literal("email"), email: v.string(), role: roleValidator }),
);
const answerValidator = v.union(
  v.object({ ok: v.literal(true), version: v.number() }),
  v.object({
    ok: v.literal(false),
    code: v.union(
      v.literal("CONFLICT"),
      v.literal("NOT_FOUND"),
      v.literal("FORBIDDEN"),
      v.literal("PENDING_FULL"),
      v.literal("INVALID"),
    ),
  }),
);

/**
 * The gateway's grantees as the rules take them: each id must be a real id of its table, or the whole list is
 * refused (`null`). `normalizeId` checks the shape only, so an id of the right shape that names nobody is
 * still `NOT_FOUND` from the rules, as it always was.
 */
function granteesOf(ctx: MutationCtx, raw: RawGrantee[]): GranteeInput[] | null {
  const out: GranteeInput[] = [];
  for (const grantee of raw) {
    if (grantee.kind === "user") {
      const userId = ctx.db.normalizeId("users", grantee.userId);
      if (userId === null) return null;
      out.push({ kind: "user", userId, role: grantee.role });
    } else if (grantee.kind === "group") {
      const groupId = ctx.db.normalizeId("workspaceGroups", grantee.groupId);
      if (groupId === null) return null;
      out.push({ kind: "group", groupId, role: grantee.role });
    } else {
      out.push({ kind: "email", email: grantee.email, role: grantee.role });
    }
  }
  return out;
}

/** Whether the rows are the truth for this deployment. */
export const rowsMode = internalQuery({
  args: {},
  returns: v.boolean(),
  handler: async (): Promise<boolean> => true,
});

/**
 * The privacy etag a move is made under, as its guard (`rowMove`, `nodeMoves`) compares it: the rows'
 * version in rows mode (`readerMirror`), the mirror's in file mode. Movers hand this out at the start of a
 * move, after their own narrowing, so only a change that lands between the start and the move refuses it.
 */
export const privacyEtagNow = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { workspaceId }): Promise<string | null> => await privacyEtagOf(ctx, workspaceId),
});

/**
 * The access state an archive is made from (`lib/filesFns/exportAccess.ts`), in rows mode. `null` in any
 * other mode, so the archive is made exactly as it was before rows existed.
 */
export const exportAccessState = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(
    v.null(),
    v.object({
      rules: v.array(v.object({ prefix: v.string(), vis: v.string() })),
      overrides: v.array(v.array(v.string())),
      lines: v.array(
        v.object({
          path: v.string(),
          kind: v.union(v.literal("file"), v.literal("folder")),
          base: v.optional(v.union(v.literal("private"), v.literal("team"))),
          grants: v.array(v.string()),
        }),
      ),
    }),
  ),
  handler: async (ctx, { workspaceId }) => {
    return await exportAccessStateOf(ctx, workspaceId);
  },
});

/** One row's base and list, for the gateway (`/gateway/privacy`, op `setAccess`). Refused outside rows mode. */
export const setAccess = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    path: v.string(),
    base: v.union(v.literal("private"), v.literal("team"), v.literal("inherit")),
    grantees: v.optional(v.union(v.array(granteeValidator), v.literal("inherit"))),
    expectedVersion: v.optional(v.number()),
    kind: v.optional(v.union(v.literal("file"), v.literal("folder"))),
    actor: v.object({ userId: v.id("users"), role: v.union(v.literal("owner"), v.literal("editor"), v.literal("member")) }),
  },
  returns: answerValidator,
  handler: async (ctx, args): Promise<SetAccessAnswer> => {
    const grantees = args.grantees === undefined || args.grantees === "inherit" ? args.grantees : granteesOf(ctx, args.grantees);
    if (grantees === null) return { ok: false, code: "INVALID" };
    return await setAccessRow(ctx, { ...args, grantees });
  },
});

/**
 * A tier a file operation's own rule sets on one row, from the barrier's store (`lib/nodes/storeAuthority.ts`): a
 * copy narrowed to private, a move's destination tightened. The operation was authorized before its store was
 * opened, and only a base changes, never a list, so the write stands for an owner of the workspace. INTERNAL.
 */
export const setOperationTier = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    path: v.string(),
    base: v.union(v.literal("private"), v.literal("team"), v.literal("inherit")),
    expectedVersion: v.optional(v.number()),
    kind: v.optional(v.union(v.literal("file"), v.literal("folder"))),
  },
  returns: answerValidator,
  handler: async (ctx, args): Promise<SetAccessAnswer> => {
    const members = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();
    const owner = members.find((member) => member.role === "owner");
    if (owner === undefined) return { ok: false, code: "FORBIDDEN" };
    return await setAccessRow(ctx, { ...args, actor: { userId: owner.userId, role: "owner" } });
  },
});

/**
 * The activity file (`activity.md`, at the root) is private whatever its row says: it names private notes. Called
 * by the barrier after a footnote lands in it, when the rules it was written under were not private. A row that
 * is `team` goes back to `private` (its list is kept); no row means the root default, which is private.
 */
export const keepActivityPrivate = internalMutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.null(),
  handler: async (ctx, { workspaceId }): Promise<null> => {
    const row = await nodeAt(ctx.db, workspaceId, ACTIVITY_PATH);
    if (row === null || row.access?.base !== "team") return null;
    await ctx.db.patch(row._id, { access: { base: "private" } });
    await refreshSnapshot(ctx, workspaceId);
    return null;
  },
});

/**
 * The console's share verbs in rows mode. A tier (`tier`) on a note goes back
 * to inheriting when it is what the note would have anyway, as an exception
 * is removed in the rules; a folder's tier is always written. A group or a
 * person (`group`, a name) replaces the row's list with that one grant, at
 * base `private`, which is how a rule names somebody.
 *
 * `accounts` with tier `team` is the dialog's All Context users position in
 * the pinned workspace: base `team` plus the built-in accounts grant. Members
 * there is plain `team`; `members` (base `private` plus the built-in members
 * grant) is how it was written before, and is still taken. Any other tier
 * clears both built-in grants (`lib/nodes/membersPosition.ts`), so Restricted
 * means owners and the people named, and nothing hidden. Everybody else on the
 * list is kept.
 */
export const consoleAccess = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    actorUserId: v.id("users"),
    path: v.string(),
    kind: v.union(v.literal("note"), v.literal("folder")),
    tier: v.optional(v.union(v.literal("private"), v.literal("team"))),
    group: v.optional(v.string()),
    members: v.optional(v.boolean()),
    accounts: v.optional(v.boolean()),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), path: v.string(), visibility: v.string(), inherited: v.string(), exception: v.boolean() }),
    v.object({ ok: v.literal(false), code: v.union(v.literal("NOT_FOUND"), v.literal("GROUP_NOT_FOUND")) }),
  ),
  handler: async (ctx, args) => {
    // The console changes what is in the tree: a path with no row does not exist, so nothing waits for one.
    const exists = await nodeAt(ctx.db, args.workspaceId, args.path);
    if (exists === null)
      return { ok: false as const, code: "NOT_FOUND" as const };
    const rules = renderAccess(
      await scanAccessRows(ctx, args.workspaceId),
      "member",
    );
    const inherited = visibilityOf(args.path, rules.rules) as string;
    const actor = { userId: args.actorUserId, role: "owner" as const };

    let visibility: string;
    let base: "private" | "team" | "inherit";
    // A tier leaves the owner's list alone (`grantees` omitted); a group replaces it with that one grant.
    let grantees: GranteeInput[] | undefined;
    if (args.group !== undefined) {
      const grant = await resolveHandle(ctx as MutationCtx, args.workspaceId, `@${args.group}` as Visibility, new Map());
      if (grant === null) return { ok: false as const, code: "GROUP_NOT_FOUND" as const };
      visibility = `@${args.group}`;
      base = "private";
      grantees =
        grant.kind === "group"
          ? [{ kind: "group", groupId: grant.groupId, role: "view" }]
          : [{ kind: "user", userId: grant.userId, role: "view" }];
    } else {
      const position = await positionOf(ctx, args);
      const tier = position.tier;
      visibility = tier;
      // The list a tier writes: kept as it is (`undefined`), or rebuilt with a built-in grant set or cleared.
      const own = (await ctx.db
        .query("nodeAccess")
        .withIndex("by_node", (q) => q.eq("nodeId", exists._id))
        .collect()).filter((grant) => grant.source !== "share");
      grantees = listForTier(own, position.builtIn);
      // Back to inheriting only for a note with no list of its own: `inherit` clears the list, and a person
      // named on a note keeps it when the rest of the workspace is let in or shut out.
      const listed = (grantees ?? own).length > 0;
      base = args.kind === "note" && tier === inherited && !listed ? "inherit" : tier;
    }

    const answer = await setAccessRow(ctx, { workspaceId: args.workspaceId, path: args.path, base, grantees, actor });
    if (!answer.ok) return { ok: false as const, code: "NOT_FOUND" as const };
    const exception = args.kind === "note" ? visibility !== inherited : false;
    return {
      ok: true as const,
      path: args.path,
      visibility,
      inherited: args.kind === "folder" ? visibility : inherited,
      exception,
    };
  },
});

/**
 * The tier and built-in grant a console tier write means (`lib/nodes/membersPosition.ts`). `accounts` is All Context
 * users: base `team` plus the accounts grant, refused by the write outside the pinned workspace. `members` is the
 * old Members request, base `private` plus the members grant, still taken from an app that sends it; in the pinned
 * workspace it is written as plain `team` once the pin readers read as guests. A plain `team` in the pinned workspace
 * is Members now, written the old way until then.
 */
async function positionOf(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces">; tier?: "private" | "team"; members?: boolean; accounts?: boolean },
): Promise<{ tier: "private" | "team"; builtIn: BuiltIn }> {
  if (args.accounts === true) return { tier: "team", builtIn: "accounts" };
  const tier = args.tier ?? "private";
  if (args.members !== true && tier !== "team") return { tier, builtIn: null };
  const pinned = await pinnedContextWorkspace(ctx);
  const here = pinned !== null && pinned._id === args.workspaceId;
  // In the pinned workspace both spellings of Members end up the same, as the pin readers read now: plain `team`
  // once they are guests (an older app still sends `members`), the old position until then.
  if (here) return (await pinReadersAreGuests(ctx.db)) ? { tier: "team", builtIn: null } : { tier: "private", builtIn: "members" };
  return args.members === true ? { tier: "private", builtIn: "members" } : { tier, builtIn: null };
}

/**
 * Before a move in rows mode: a folder that would widen into its new parent
 * keeps its narrowing on its own row (`narrowRowForMove`). The file rules'
 * carry is not written in rows mode, so this is the only narrowing a move makes.
 */
export const narrowMove = internalMutation({
  args: { workspaceId: v.id("workspaces"), from: v.string(), to: v.string() },
  returns: v.null(),
  handler: async (ctx, { workspaceId, from, to }): Promise<null> => {
    await narrowRowForMove(ctx, workspaceId, from, to);
    return null;
  },
});

/** `narrowMove` for every move of a batch in one transaction (`lib/nodes/rowMoveBatch.ts`). */
export const narrowMoves = internalMutation({
  args: { workspaceId: v.id("workspaces"), moves: v.array(v.object({ from: v.string(), to: v.string() })) },
  returns: v.null(),
  handler: async (ctx, { workspaceId, moves }): Promise<null> => {
    await narrowRowsForMoves(ctx, workspaceId, moves);
    return null;
  },
});

/**
 * Before a move from another workspace lands, in rows mode: each note whose landing tier is narrower than where it
 * lands is born private (`pendPrivateArrivals`). `false` when that could not be kept, and nothing may land.
 */
export const narrowArrivals = internalMutation({
  args: { workspaceId: v.id("workspaces"), paths: v.array(v.string()) },
  returns: v.boolean(),
  handler: async (ctx, { workspaceId, paths }): Promise<boolean> => {
    return await pendPrivateArrivals(ctx, workspaceId, paths);
  },
});

/**
 * Website publication in rows mode (`lib/websites/publication.ts`): a folder with no base of its own takes
 * `team`, as the file's `onlyIfUnset` rule gives it; one that has a base keeps it. Its owner's list is kept.
 * A folder with no row yet takes `team` as pending access, which its row gets when it is born (`pendingAccess.ts`),
 * unless a base is already waiting for it, which is kept. No row is made here.
 */
export const ensureFolderDefault = internalMutation({
  args: { workspaceId: v.id("workspaces"), actorUserId: v.id("users"), path: v.string() },
  returns: v.union(
    v.object({ ok: v.literal(true), visibility: v.string(), changed: v.boolean() }),
    v.object({
      ok: v.literal(false),
      code: v.union(v.literal("CONFLICT"), v.literal("NOT_FOUND"), v.literal("FORBIDDEN"), v.literal("PENDING_FULL"), v.literal("INVALID")),
    }),
  ),
  handler: async (ctx, args) => {
    const row = await nodeAt(ctx.db, args.workspaceId, args.path);
    const actor = { userId: args.actorUserId, role: "owner" as const };
    if (row === null) {
      const state = await ctx.db
        .query("nodeAccessState")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
        .unique();
      const waiting = livePending(state?.pending, Date.now()).find((entry) => entry.path === args.path);
      if (waiting !== undefined) return { ok: true as const, visibility: waiting.base, changed: false };
      const pending = await setAccessRow(ctx, {
        workspaceId: args.workspaceId,
        path: args.path,
        base: "team",
        kind: "folder",
        actor,
      });
      if (!pending.ok) return { ok: false as const, code: pending.code };
      return { ok: true as const, visibility: "team", changed: true };
    }
    if (row.access?.base !== undefined) return { ok: true as const, visibility: row.access.base, changed: false };
    // A base alone: the owner's list is kept as it is.
    const answer = await setAccessRow(ctx, { workspaceId: args.workspaceId, path: args.path, base: "team", actor });
    if (!answer.ok) return { ok: false as const, code: answer.code };
    return { ok: true as const, visibility: "team", changed: true };
  },
});

/**
 * The owner's list on one row, named by handles, group ids and emails (`lib/nodes/setGrantees.ts`). Owner only:
 * a member gets `FORBIDDEN`, a non-member the same `NOT_FOUND` as a path that does not exist. Replaces the list;
 * the row's base is kept unless `base` is given, which the share dialog sends with every list.
 */
export const setGrantees = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    path: v.string(),
    grantees: v.array(granteeRequestValidator),
    base: v.optional(v.union(v.literal("private"), v.literal("team"), v.literal("inherit"))),
    expectedVersion: v.optional(v.number()),
  },
  returns: setGranteesAnswerValidator,
  handler: async (ctx, args) => await setGranteesHandler(ctx, args),
});

/**
 * Who one row is shared with, for its owner's share dialog (`lib/nodes/shareList.ts`): its own list, or the folder
 * list it follows. `null` for anyone but an owner, outside rows mode, and for a path with no row.
 */
export const shareList = query({
  args: { workspaceId: v.id("workspaces"), path: v.string() },
  returns: shareListValidator,
  handler: async (ctx, args) => await shareListHandler(ctx, args),
});

/**
 * People an AI client adds to one row's list, after the person said yes to it (`/gateway/privacy`, op
 * `addGrantees`; `lib/nodes/addGrantees.ts`). Adds to the list rather than replacing it. Owner only.
 */
export const addGrantees = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    path: v.string(),
    entries: v.array(granteeRequestValidator),
    actor: v.object({ userId: v.id("users"), role: v.union(v.literal("owner"), v.literal("editor")) }),
  },
  returns: setGranteesAnswerValidator,
  handler: async (ctx, args) => await addGranteesHandler(ctx, args),
});
