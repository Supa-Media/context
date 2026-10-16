/**
 * Access on the tree's rows, in rows mode (`nodeMigration.accessSource` =
 * `rows`): the writes that replace the rules' `privacy.md` for an owner, and
 * the switch's answer to the callers that ask whether rows are the truth.
 *
 * Internal only. The console reaches `consoleAccess` through its own handlers
 * (`lib/filesFns/visibility.ts`), which keep their owner check; the gateway
 * reaches `setAccess` through `/gateway/privacy`, which checks the person's
 * grant first. Nothing here answers outside rows mode with a write: that
 * would leave rows the rules do not read.
 */

import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx } from "../_generated/server";
import { accessSourceOf, resolveHandle } from "./lib/nodes/accessBackfill";
import { scanAccessRows } from "./lib/nodes/accessRows";
import { livePending } from "./lib/nodes/pendingAccess";
import { narrowRowForMove, setAccessRow, type SetAccessAnswer, type GranteeInput } from "./lib/nodes/setAccess";
import { renderAccess } from "./lib/nodes/rowAccess";
import { visibilityOf, type Visibility } from "./lib/privacy";

const roleValidator = v.union(v.literal("view"), v.literal("edit"));
const granteeValidator = v.union(
  v.object({ kind: v.literal("user"), userId: v.id("users"), role: roleValidator }),
  v.object({ kind: v.literal("group"), groupId: v.id("workspaceGroups"), role: roleValidator }),
  v.object({ kind: v.literal("email"), email: v.string(), role: roleValidator }),
);
const answerValidator = v.union(
  v.object({ ok: v.literal(true), version: v.number() }),
  v.object({
    ok: v.literal(false),
    code: v.union(v.literal("CONFLICT"), v.literal("NOT_FOUND"), v.literal("FORBIDDEN"), v.literal("NOT_ROWS_MODE"), v.literal("PENDING_FULL")),
  }),
);

/** Whether the rows are the truth for this deployment. */
export const rowsMode = internalQuery({
  args: {},
  returns: v.boolean(),
  handler: async (ctx): Promise<boolean> => (await accessSourceOf(ctx.db)) === "rows",
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
    if ((await accessSourceOf(ctx.db)) !== "rows") return { ok: false, code: "NOT_ROWS_MODE" };
    return await setAccessRow(ctx, args as Parameters<typeof setAccessRow>[1]);
  },
});

/**
 * The console's share verbs in rows mode. A tier (`tier`) on a note goes back
 * to inheriting when it is what the note would have anyway, as an exception
 * is removed in the rules; a folder's tier is always written. A group or a
 * person (`group`, a name) replaces the row's list with that one grant, at
 * base `private`, which is how a rule names somebody.
 */
export const consoleAccess = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    actorUserId: v.id("users"),
    path: v.string(),
    kind: v.union(v.literal("note"), v.literal("folder")),
    tier: v.optional(v.union(v.literal("private"), v.literal("team"))),
    group: v.optional(v.string()),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), path: v.string(), visibility: v.string(), inherited: v.string(), exception: v.boolean() }),
    v.object({ ok: v.literal(false), code: v.union(v.literal("NOT_FOUND"), v.literal("GROUP_NOT_FOUND"), v.literal("NOT_ROWS_MODE")) }),
  ),
  handler: async (ctx, args) => {
    if ((await accessSourceOf(ctx.db)) !== "rows") return { ok: false as const, code: "NOT_ROWS_MODE" as const };
    // The console changes what is in the tree: a path with no row does not exist, so nothing waits for one.
    const exists = await ctx.db
      .query("nodes")
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", args.workspaceId).eq("path", args.path))
      .unique();
    if (exists === null) return { ok: false as const, code: "NOT_FOUND" as const };
    const rules = renderAccess(await scanAccessRows(ctx, args.workspaceId), "member");
    const inherited = visibilityOf(args.path, rules.rules) as string;
    const actor = { userId: args.actorUserId, role: "owner" as const };

    let visibility: string;
    let base: "private" | "team" | "inherit";
    let grantees: GranteeInput[];
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
      const tier = args.tier ?? "private";
      visibility = tier;
      base = args.kind === "note" && tier === inherited ? "inherit" : tier;
      grantees = [];
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
 * Before a move in rows mode: a folder that would widen into its new parent
 * keeps its narrowing on its own row (`narrowRowForMove`). The file rules'
 * carry is not written in rows mode, so this is the only narrowing a move makes.
 */
export const narrowMove = internalMutation({
  args: { workspaceId: v.id("workspaces"), from: v.string(), to: v.string() },
  returns: v.null(),
  handler: async (ctx, { workspaceId, from, to }): Promise<null> => {
    if ((await accessSourceOf(ctx.db)) !== "rows") return null;
    await narrowRowForMove(ctx, workspaceId, from, to);
    return null;
  },
});

/** The owner's list on a row, as the grantees `setAccessRow` takes: a base-only write keeps it. */
async function ownerGranteesOf(ctx: MutationCtx, row: Doc<"nodes">): Promise<GranteeInput[]> {
  const grants = await ctx.db.query("nodeAccess").withIndex("by_node", (q) => q.eq("nodeId", row._id)).collect();
  const granted: GranteeInput[] = [];
  for (const grant of grants) {
    if (grant.source !== "owner") continue;
    if (grant.granteeKind === "user" && grant.granteeUserId !== undefined) {
      granted.push({ kind: "user", userId: grant.granteeUserId, role: grant.role });
    } else if (grant.granteeKind === "group" && grant.granteeGroupId !== undefined) {
      granted.push({ kind: "group", groupId: grant.granteeGroupId, role: grant.role });
    } else if (grant.granteeKind === "email" && grant.granteeEmail !== undefined) {
      granted.push({ kind: "email", email: grant.granteeEmail, role: grant.role });
    }
  }
  return granted;
}

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
      code: v.union(v.literal("CONFLICT"), v.literal("NOT_FOUND"), v.literal("FORBIDDEN"), v.literal("NOT_ROWS_MODE"), v.literal("PENDING_FULL")),
    }),
  ),
  handler: async (ctx, args) => {
    if ((await accessSourceOf(ctx.db)) !== "rows") return { ok: false as const, code: "NOT_ROWS_MODE" as const };
    const row = await ctx.db
      .query("nodes")
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", args.workspaceId).eq("path", args.path))
      .unique();
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
        grantees: [],
        kind: "folder",
        actor,
      });
      if (!pending.ok) return { ok: false as const, code: pending.code };
      return { ok: true as const, visibility: "team", changed: true };
    }
    if (row.access?.base !== undefined) return { ok: true as const, visibility: row.access.base, changed: false };
    const answer = await setAccessRow(ctx, {
      workspaceId: args.workspaceId,
      path: args.path,
      base: "team",
      grantees: await ownerGranteesOf(ctx, row),
      actor,
    });
    if (!answer.ok) return { ok: false as const, code: answer.code };
    return { ok: true as const, visibility: "team", changed: true };
  },
});
