/**
 * Notes moving between the caller's own workspaces, for the console map
 * ("Personal → Supa, 9 moved today") — `docs/decisions/app-and-console/
 * live-map-history.md`.
 *
 * ## Two places a cross-workspace move happens, one place to read them
 *
 *  - **The console** moves a note or a folder through `contextMoves.ts`. Its
 *    `contextMoves` row already holds both workspace ids, both paths, the
 *    mover and when it finished, so it is read directly.
 *  - **An AI client** moves one note with `move_note` and a source and
 *    destination context (`apps/mcp/src/tools/moves/acrossContexts.js`). That
 *    used to leave rows only in the two buckets' own audit folders, which no
 *    request could afford to walk across every workspace somebody belongs
 *    to. It now also reports the move (`POST /gateway/moves`), and
 *    `recordAgentMove` below writes the same `file.moveOut` / `file.moveIn`
 *    pair a console move writes, with the destination workspace on the
 *    source's row.
 *
 * ## What a caller is shown
 *
 * Only moves whose BOTH workspaces the caller is a member of now, and of
 * those only the ones whose source path and destination path the caller may
 * see now — each judged by its own bucket's live `privacy.md`, through the
 * credential barrier (`visiblePaths`). A move that fails either end is
 * **dropped, not shown with its path withheld**: the activity feed's rule
 * (`visibleEntries`) is that a change somebody may not see is absent, never
 * greyed and never counted, because a gap a reader can count is the
 * disclosure. A console folder move carries no object count for the same
 * reason — `movedObjects` counts notes at the mover's clearance.
 */

import { ConvexError, v } from "convex/values";
import { type ActionCtx, action, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { recordAudit } from "./lib/audit";
import { getMembership } from "./lib/workspaceAuth";
import { callerId, personalNameFor } from "./lib/filesFns/access";

/**
 * The widest range one call may ask for: the map's longest replay is a week.
 * Not named `*_WINDOW_MS`: that suffix is the rate-limit windows' convention,
 * which `controlPlane/clients.test.ts` bounds by the limiter's sweep.
 */
export const MOVE_RANGE_MAX_MS = 31 * 24 * 60 * 60 * 1000;

/** Moves one answer may carry. Past it, `truncated`. */
export const MOVE_ANSWER_CAP = 500;

/** Audit rows one workspace's scan may read looking for moves. */
const AUDIT_SCAN_CAP = 4_000;

/** Console move rows one workspace's scan may read. */
const CONTEXT_MOVE_SCAN_CAP = 500;

const PATH_LIMIT = 1_024;

const moveValidator = v.object({
  at: v.number(),
  fromWorkspaceId: v.id("workspaces"),
  toWorkspaceId: v.id("workspaces"),
  fromPath: v.string(),
  toPath: v.string(),
  /** The mover's `@name` (their personal workspace's slug), or null. */
  actorName: v.union(v.string(), v.null()),
  /** A person in the console, or an AI client through `move_note`. */
  via: v.union(v.literal("console"), v.literal("agent")),
});

type Move = {
  at: number;
  fromWorkspaceId: Id<"workspaces">;
  toWorkspaceId: Id<"workspaces">;
  fromPath: string;
  toPath: string;
  actorName: string | null;
  via: "console" | "agent";
};

/**
 * An AI client moved one note between two contexts. Called by the gateway's
 * `/gateway/moves` route only, and never trusted further than the membership
 * table: the mover must be able to write both ends right now, or nothing is
 * recorded — a report naming a workspace somebody is not in is a forged row
 * in that workspace's trail, and a status code would tell the caller which.
 */
export const recordAgentMove = internalMutation({
  args: {
    fromWorkspaceId: v.string(),
    toWorkspaceId: v.string(),
    fromPath: v.string(),
    toPath: v.string(),
    actorUserId: v.string(),
    actorClientId: v.optional(v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const from = ctx.db.normalizeId("workspaces", args.fromWorkspaceId);
    const to = ctx.db.normalizeId("workspaces", args.toWorkspaceId);
    const actor = ctx.db.normalizeId("users", args.actorUserId);
    if (from === null || to === null || actor === null || from === to) return false;
    if (!isNotePath(args.fromPath) || !isNotePath(args.toPath)) return false;
    for (const workspaceId of [from, to]) {
      const membership = await getMembership(ctx, workspaceId, actor);
      if (membership === null || membership.role === "member") return false;
    }
    const clientId =
      typeof args.actorClientId === "string" && args.actorClientId.length <= 256
        ? args.actorClientId
        : undefined;
    // The same pair a console move writes (`contextMoves.ts`, `stop`): the
    // source's row names both ends, and the destination's names only its own
    // path, because the source is a context its readers need not be in.
    await recordAudit(ctx, {
      workspaceId: from,
      actorUserId: actor,
      actorClientId: clientId,
      action: "file.moveOut",
      paths: [args.fromPath],
      details: { toWorkspaceId: to, toPath: args.toPath, via: "agent", objects: 1 },
    });
    await recordAudit(ctx, {
      workspaceId: to,
      actorUserId: actor,
      actorClientId: clientId,
      action: "file.moveIn",
      paths: [args.toPath],
      details: { objects: 1 },
    });
    return true;
  },
});

function isNotePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= PATH_LIMIT &&
    path.endsWith(".md") &&
    !path.startsWith("/") &&
    !path.split("/").some((segment) => segment === "" || segment === ".." || segment.startsWith("."))
  );
}

/** Every workspace this person is a real member of — never a pinned reach. */
export const memberWorkspaceIds = internalQuery({
  args: { actorUserId: v.id("users") },
  returns: v.array(v.id("workspaces")),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_user", (q) => q.eq("userId", args.actorUserId))
      .collect();
    return rows.map((row) => row.workspaceId);
  },
});

/**
 * Moves out of one workspace into one of `peers`, in `[from, to]`, before any
 * path is judged. Re-checks the caller's membership of this workspace itself:
 * `peers` comes from the action, and this is the transaction that reads rows.
 */
export const moveCandidates = internalQuery({
  args: {
    actorUserId: v.id("users"),
    workspaceId: v.id("workspaces"),
    peers: v.array(v.id("workspaces")),
    from: v.number(),
    to: v.number(),
  },
  returns: v.object({ moves: v.array(moveValidator), truncated: v.boolean() }),
  handler: async (ctx, args) => {
    if ((await getMembership(ctx, args.workspaceId, args.actorUserId)) === null) {
      return { moves: [], truncated: false };
    }
    const peers = new Set<string>(args.peers);
    peers.delete(args.workspaceId);
    const names = new Map<string, string | null>();
    const nameOf = async (userId: Id<"users"> | undefined): Promise<string | null> => {
      if (userId === undefined) return null;
      if (!names.has(userId)) names.set(userId, await personalNameFor(ctx, userId));
      return names.get(userId) ?? null;
    };
    const moves: Move[] = [];
    let truncated = false;

    // The console's moves. `updatedAt` is never earlier than `completedAt`,
    // so the index bound is a superset and `completedAt` decides.
    let scanned = 0;
    for await (const row of ctx.db
      .query("contextMoves")
      .withIndex("by_source_updatedAt", (q) =>
        q.eq("sourceWorkspaceId", args.workspaceId).gte("updatedAt", args.from),
      )) {
      if (++scanned > CONTEXT_MOVE_SCAN_CAP) {
        truncated = true;
        break;
      }
      const at = row.completedAt;
      if (at === undefined || at < args.from || at > args.to) continue;
      if (row.status === "moving" || row.movedObjects === 0) continue;
      if (!peers.has(row.destinationWorkspaceId)) continue;
      moves.push({
        at,
        fromWorkspaceId: row.sourceWorkspaceId,
        toWorkspaceId: row.destinationWorkspaceId,
        fromPath: row.from,
        toPath: row.to,
        actorName: await nameOf(row.actorUserId),
        via: "console",
      });
    }

    // An AI client's moves, as `recordAgentMove` wrote them.
    scanned = 0;
    for await (const row of ctx.db
      .query("auditEvents")
      .withIndex("by_workspace_at", (q) =>
        q.eq("workspaceId", args.workspaceId).gte("at", args.from).lte("at", args.to),
      )
      .order("desc")) {
      if (++scanned > AUDIT_SCAN_CAP) {
        truncated = true;
        break;
      }
      if (row.action !== "file.moveOut" || row.details?.via !== "agent") continue;
      const toWorkspaceId = row.details?.toWorkspaceId;
      const toPath = row.details?.toPath;
      if (typeof toWorkspaceId !== "string" || typeof toPath !== "string") continue;
      if (!peers.has(toWorkspaceId) || row.paths.length !== 1) continue;
      moves.push({
        at: row.at,
        fromWorkspaceId: args.workspaceId,
        toWorkspaceId: toWorkspaceId as Id<"workspaces">,
        fromPath: row.paths[0],
        toPath,
        actorName: await nameOf(row.actorUserId),
        via: "agent",
      });
    }
    return { moves, truncated };
  },
});

/**
 * Cross-workspace moves among the caller's own workspaces in `[from, to]`
 * (epoch ms, at most `MOVE_RANGE_MAX_MS` apart), newest first. See the header
 * for exactly what is dropped and why.
 */
export const list = action({
  args: { from: v.number(), to: v.number() },
  returns: v.object({ moves: v.array(moveValidator), truncated: v.boolean() }),
  handler: async (ctx, args): Promise<{ moves: Move[]; truncated: boolean }> => {
    const actorUserId = await callerId(ctx);
    if (
      !Number.isFinite(args.from) ||
      !Number.isFinite(args.to) ||
      args.from > args.to ||
      args.to - args.from > MOVE_RANGE_MAX_MS
    ) {
      throw new ConvexError({
        code: "INVALID_RANGE",
        message: "Ask for a range of at most 31 days, oldest first.",
      });
    }
    const mine: Id<"workspaces">[] = await ctx.runQuery(
      internal.functions.workspaceMoves.memberWorkspaceIds,
      { actorUserId },
    );
    if (mine.length < 2) return { moves: [], truncated: false };

    let truncated = false;
    const candidates: Move[] = [];
    for (const workspaceId of mine) {
      const found: { moves: Move[]; truncated: boolean } = await ctx.runQuery(
        internal.functions.workspaceMoves.moveCandidates,
        { actorUserId, workspaceId, peers: mine, from: args.from, to: args.to },
      );
      candidates.push(...found.moves);
      truncated = truncated || found.truncated;
    }
    if (candidates.length === 0) return { moves: [], truncated };

    // Every path to be revealed, asked of its own bucket at the caller's own
    // scope there. A bucket that cannot answer reveals nothing.
    const asked = new Map<Id<"workspaces">, Set<string>>();
    const ask = (workspaceId: Id<"workspaces">, path: string) => {
      if (!asked.has(workspaceId)) asked.set(workspaceId, new Set());
      asked.get(workspaceId)!.add(path);
    };
    for (const move of candidates) {
      ask(move.fromWorkspaceId, move.fromPath);
      ask(move.toWorkspaceId, move.toPath);
    }
    const visible = new Map<Id<"workspaces">, Set<string>>();
    for (const [workspaceId, paths] of asked) {
      visible.set(workspaceId, await visibleIn(ctx, actorUserId, workspaceId, [...paths]));
    }

    const seen = (workspaceId: Id<"workspaces">, path: string) =>
      visible.get(workspaceId)?.has(path) === true;
    const moves = candidates
      .filter((move) => seen(move.fromWorkspaceId, move.fromPath) && seen(move.toWorkspaceId, move.toPath))
      .sort((a, b) => b.at - a.at);
    return {
      moves: moves.slice(0, MOVE_ANSWER_CAP),
      truncated: truncated || moves.length > MOVE_ANSWER_CAP,
    };
  },
});

async function visibleIn(
  ctx: ActionCtx,
  actorUserId: Id<"users">,
  workspaceId: Id<"workspaces">,
  paths: string[],
): Promise<Set<string>> {
  try {
    const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId,
      minimum: "member",
    });
    const result = await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId,
      scope,
      grantedNames,
      operation: { kind: "visiblePaths", paths },
    });
    return new Set(result.kind === "visiblePaths" ? result.paths : []);
  } catch {
    // No membership any more, no binding, an unreachable bucket: all the same
    // answer, and the safe one.
    return new Set();
  }
}
