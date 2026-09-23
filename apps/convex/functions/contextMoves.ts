/**
 * Moving a note, or a whole folder, out of one context and into another.
 *
 * The console has always been able to move something *within* a context:
 * `files.moveEntry` renames the key, rewrites every link that pointed at it,
 * and carries its privacy exception across, all inside the request that asked
 * for it. Two things that operation cannot do are what this module exists for.
 *
 * ## It crosses a tenancy boundary, so it cannot be one call
 *
 * Tenancy here is bucket-level (CLAUDE.md #2): a context is a bucket, and two
 * contexts are two buckets, usually under two different credentials and often
 * in two different customers' accounts. There is no portable server-side copy
 * between them — the storage adapter has `get`, `put`, `delete` and `list` and
 * nothing else — so the bytes have to be read out of one and written into the
 * other by something holding both, one bounded batch at a time.
 *
 * That "something" is deliberately **not** one function with two credentials.
 * `runFileOperation` is the single enumerated credential barrier in this
 * deployment (`__tests__/structure.test.ts`), it opens exactly one workspace's
 * bucket, and a second barrier holding two customers' plaintext secrets in one
 * scope would have to argue for itself all over again. So a batch is three
 * calls through the one barrier — export from the source, import into the
 * destination, delete from the source — and this module, which holds no
 * credential at all, is what puts them in order. The engine half is the
 * "moving between two contexts" section of `lib/fileOps.ts`.
 *
 * ## It has no size limit, so it cannot be one request
 *
 * `FOLDER_OPERATION_CAP` refuses a single-store move past five hundred files,
 * and that refusal is right there: `movePath` rewrites the manifest as though
 * the whole walk happened, so a partial walk cannot be operated on safely.
 * Here the all-or-nothing unit is one *object* — copied, verified, then
 * deleted — so a folder of nine thousand notes is not a bigger operation, it
 * is more batches. The row in `contextMoves` is what survives the request that
 * started it: each batch schedules the next, and a person watches a count
 * instead of a spinner that would time out long before the folder did.
 *
 * Which also means a move that dies — a bucket that stops answering, a note
 * edited underneath it — is **resumable rather than lost**. Everything already
 * carried is gone from the source, so `resumeContextMove` simply starts
 * batching again and does not see it.
 *
 * ## Who may do it
 *
 * `owner` on the source and `editor` on the destination, and the asymmetry is
 * the point. Moving something *out* of a context removes it from everybody who
 * could read it there, which is a decision about that context's contents that
 * an editor invited to help with one project does not get to make. Moving
 * something *in* is an ordinary write, which is exactly what `editor` means.
 *
 * ## What it does not do
 *
 * It does not rewrite links, it does not carry attachments, and it never
 * widens anything. All three are argued where they are implemented, in
 * `lib/fileOps.ts` — see `landingVisibility` in particular, which is why this
 * module has no "are you sure this becomes visible to them?" step: it cannot.
 */

import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "../_generated/server";
import { CONTEXT_MOVE_SKIP_CAP } from "./lib/fileOps";
import { requireWorkspaceRole, workspaceNotFound } from "./lib/workspaceAuth";

/**
 * Batches one scheduled link may run before handing on to the next.
 *
 * A Convex action has a wall clock, and a batch is a bucket read, a bucket
 * write and a bucket delete per object — so the number is chosen against that
 * clock rather than against the folder. Several per link keeps a small move
 * to one scheduled hop; chaining keeps a large one going without any single
 * hop being able to run out of time in the middle of a batch.
 */
const BATCHES_PER_PASS = 6;

/**
 * Passes one move may chain before it stops and says so.
 *
 * The backstop, not the mechanism: a move ends because a pass found nothing
 * left, and this only catches a move that is somehow making progress forever.
 * At forty batches a pass it is a very large folder's worth of room.
 */
const MAX_PASSES = 2_000;

const skipValidator = v.object({
  path: v.string(),
  reason: v.union(v.literal("encrypted")),
});

const moveRowValidator = v.object({
  moveId: v.id("contextMoves"),
  sourceWorkspaceId: v.id("workspaces"),
  destinationWorkspaceId: v.id("workspaces"),
  from: v.string(),
  to: v.string(),
  status: v.union(v.literal("moving"), v.literal("complete"), v.literal("failed")),
  movedObjects: v.number(),
  movedBytes: v.number(),
  skipped: v.array(skipValidator),
  error: v.optional(v.string()),
  updatedAt: v.number(),
});

/* -------------------------------------------------------------------------- */
/*                                  starting                                  */
/* -------------------------------------------------------------------------- */

/**
 * Begin a move into another context.
 *
 * Returns as soon as the row exists and the first pass is scheduled. It
 * deliberately does not wait for the move: a folder can be arbitrarily large,
 * and a caller that waited would be back to the timeout this whole module is
 * built to avoid. `listContextMoves` is how the console follows it.
 */
export const startContextMove = action({
  args: {
    sourceWorkspaceId: v.id("workspaces"),
    from: v.string(),
    destinationWorkspaceId: v.id("workspaces"),
    to: v.string(),
  },
  returns: v.object({ moveId: v.id("contextMoves") }),
  handler: async (ctx, args): Promise<{ moveId: Id<"contextMoves"> }> => {
    const actorUserId = await callerId(ctx);
    const moveId: Id<"contextMoves"> = await ctx.runMutation(
      internal.functions.contextMoves.openMove,
      { ...args, actorUserId },
    );
    await ctx.scheduler.runAfter(0, internal.functions.contextMoves.advanceContextMove, {
      moveId,
      passesLeft: MAX_PASSES,
    });
    return { moveId };
  },
});

/**
 * Pick a stopped move back up.
 *
 * The same authorization as starting one, re-run rather than remembered: the
 * row records who pressed Move, and a person can have been demoted out of
 * either context since. A move that is already finished is left alone rather
 * than reopened.
 */
export const resumeContextMove = action({
  args: { moveId: v.id("contextMoves") },
  returns: v.object({ resumed: v.boolean() }),
  handler: async (ctx, args): Promise<{ resumed: boolean }> => {
    const actorUserId = await callerId(ctx);
    const resumed: boolean = await ctx.runMutation(
      internal.functions.contextMoves.reopenMove,
      { moveId: args.moveId, actorUserId },
    );
    if (resumed) {
      await ctx.scheduler.runAfter(0, internal.functions.contextMoves.advanceContextMove, {
        moveId: args.moveId,
        passesLeft: MAX_PASSES,
      });
    }
    return { resumed };
  },
});

/**
 * Stop showing a finished move, on every device rather than on this one.
 *
 * The notice a move ends with is the only outcome in the console that arrives
 * as a sentence nobody pressed for — the move outlives the press, and the row
 * behind it is listable for a day so that a person who was not looking still
 * finds out. Which leaves the console needing somewhere to record that they
 * *have* looked, and before this there was nowhere: dismissal lived in one
 * component's `useState`, so the line came back on every launch until the row
 * aged out, and its Dismiss button was a control that worked until you closed
 * the app. A notice that cannot be answered is a notice people learn to read
 * past, which is the opposite of what a move needs from one.
 *
 * `owner` on the source, re-asked here rather than taken from the row: the
 * row records who pressed Move, and roles change. The same authorization
 * `listContextMoves` makes, because this only ever hides something from that.
 *
 * ## Only a move that finished, and only one that finished cleanly
 *
 * `moving` is refused because there is no outcome to acknowledge yet, and
 * `contextMoveNotices` goes on drawing a running move whatever anybody says.
 *
 * `failed` is refused for a sharper reason, and it is the one thing to
 * re-read before widening this. **A failed move's notice carries the only
 * control that can finish it.** The destination-root collision check runs
 * only while nothing has landed (`advanceContextMove`), so a resume walks
 * past it and a *fresh* move over the same folder does not: it is refused
 * `DESTINATION_EXISTS` against the half this move already put there. Making
 * that notice permanently hideable would mean one press leaves a folder split
 * across two contexts with the clean way to reunite it gone from the screen.
 *
 * So a failure can be put aside for the session — the pane's own state does
 * that, and the button says "Not now" rather than "Dismiss" — and it comes
 * back, because it is still true. Only `complete` is an outcome there is
 * nothing left to do about, and only `complete` can be answered for good.
 *
 * Idempotent: two devices can both be showing the line, and the second press
 * is a consequence of that rather than a race worth reporting.
 */
export const dismissContextMove = mutation({
  args: { moveId: v.id("contextMoves") },
  returns: v.object({ dismissed: v.boolean() }),
  handler: async (ctx, args) => {
    const actorUserId = await callerId(ctx);
    const row = await ctx.db.get(args.moveId);
    // A move that is not there answers as one somebody else owns, for the
    // reason `reopenMove` sets out at length: three outcomes over an id space
    // must not be two distinguishable answers.
    if (row === null) throw workspaceNotFound();
    await requireWorkspaceRole(ctx, row.sourceWorkspaceId, actorUserId, "owner");
    if (row.status !== "complete") return { dismissed: false };
    if (row.dismissedAt === undefined) {
      await ctx.db.patch(args.moveId, { dismissedAt: Date.now() });
    }
    return { dismissed: true };
  },
});

/**
 * The moves out of this context worth showing somebody.
 *
 * Owner-only, and scoped to the **source**: a move is a thing that happens to
 * the context it is leaving, which is also the only context whose owner had to
 * authorize it. Finished rows stay for a day so a move does not disappear from
 * the screen at ninety-nine percent — the same day `listDurableMoves` keeps
 * its own, for the same reason.
 *
 * A day is a long time to be told the same thing, which is what `dismissedAt`
 * is for: a finished row the owner has acknowledged is gone from here for
 * good, rather than for as long as one console stayed open. A **running** one
 * is listed whatever it says, because a move still carrying notes is not
 * something anybody can have finished reading about — the same rule
 * `contextMoveNotices` applies on the other side of the wire.
 */
export const listContextMoves = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.array(moveRowValidator),
  handler: async (ctx, args) => {
    const actorUserId = await callerId(ctx);
    await requireWorkspaceRole(ctx, args.workspaceId, actorUserId, "owner");
    const rows = await ctx.db
      .query("contextMoves")
      .withIndex("by_source_updatedAt", (q) => q.eq("sourceWorkspaceId", args.workspaceId))
      .order("desc")
      .take(20);
    const cutoff = Date.now() - 24 * 60 * 60 * 1_000;
    return rows
      .filter(
        (row) =>
          row.status === "moving" ||
          (row.updatedAt >= cutoff && row.dismissedAt === undefined),
      )
      .slice(0, 10)
      .map((row) => ({
        moveId: row._id,
        sourceWorkspaceId: row.sourceWorkspaceId,
        destinationWorkspaceId: row.destinationWorkspaceId,
        from: row.from,
        to: row.to,
        status: row.status,
        movedObjects: row.movedObjects,
        movedBytes: row.movedBytes,
        skipped: row.skipped,
        ...(row.error === undefined ? {} : { error: row.error }),
        updatedAt: row.updatedAt,
      }));
  },
});

/* -------------------------------------------------------------------------- */
/*                          authorization and the row                         */
/* -------------------------------------------------------------------------- */

/**
 * Both roles, both paths, and the refusals that have to happen before any
 * bucket is opened.
 *
 * In a mutation rather than in the action above, so the checks and the row are
 * one transaction: an action that authorized and then wrote could be raced
 * into two rows for one press, and two passes batching the same folder would
 * each see the other's half-deleted listing.
 */
export const openMove = internalMutation({
  args: {
    sourceWorkspaceId: v.id("workspaces"),
    destinationWorkspaceId: v.id("workspaces"),
    actorUserId: v.id("users"),
    from: v.string(),
    to: v.string(),
  },
  returns: v.id("contextMoves"),
  handler: async (ctx, args) => {
    await authorizeMove(ctx, args);
    const now = Date.now();
    return await ctx.db.insert("contextMoves", {
      sourceWorkspaceId: args.sourceWorkspaceId,
      destinationWorkspaceId: args.destinationWorkspaceId,
      actorUserId: args.actorUserId,
      from: normalizeMovePath(args.from),
      to: normalizeMovePath(args.to),
      status: "moving",
      movedObjects: 0,
      movedBytes: 0,
      skipped: [],
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const reopenMove = internalMutation({
  args: { moveId: v.id("contextMoves"), actorUserId: v.id("users") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.moveId);
    if (row === null) {
      /*
        A MOVE THAT IS NOT THERE ANSWERS AS ONE SOMEBODY ELSE OWNS.

        The two arms below are the only other outcomes — a role refusal, which
        throws `WORKSPACE_NOT_FOUND`, and `false` for a move that has already
        finished — and returning `false` here instead would make those three
        cases two distinguishable answers over an id space. Anybody holding a
        move id could then ask whether it is live, which is activity in a
        context they have proven nothing about.

        The cost is that an owner resuming a move whose row has aged out is
        told the context is not found rather than the move. Rare, recoverable
        by starting the move again, and the right side of the trade: the same
        one `authorizeFileAccess` makes when it answers `WORKSPACE_NOT_FOUND`
        for a workspace that exists and one that never did.
      */
      throw workspaceNotFound();
    }
    if (row.status !== "failed") return false;
    await authorizeMove(ctx, {
      sourceWorkspaceId: row.sourceWorkspaceId,
      destinationWorkspaceId: row.destinationWorkspaceId,
      actorUserId: args.actorUserId,
      from: row.from,
      to: row.to,
    });
    await ctx.db.patch(args.moveId, {
      status: "moving",
      error: undefined,
      actorUserId: args.actorUserId,
      updatedAt: Date.now(),
      /*
        A resumed move is never a dismissed one. Today nothing can reach here
        holding a dismissal — `dismissContextMove` takes `complete` only, and
        a complete move is never reopened — so this is insurance, and it is
        the insurance worth keeping: the day failures become answerable, a row
        that stayed dismissed through its next outcome would finish in
        silence, which is the one case where "it carried everything" and "it
        carried nothing" look identical from the console.
      */
      dismissedAt: undefined,
    });
    return true;
  },
});

async function authorizeMove(
  ctx: Parameters<typeof requireWorkspaceRole>[0],
  args: {
    sourceWorkspaceId: Id<"workspaces">;
    destinationWorkspaceId: Id<"workspaces">;
    actorUserId: Id<"users">;
    from: string;
    to: string;
  },
): Promise<void> {
  if (args.sourceWorkspaceId === args.destinationWorkspaceId) {
    /*
      Not a cross-context move at all, and refusing beats quietly doing the
      slower thing. `files.moveEntry` is the operation for this: it rewrites
      every link that pointed at what moved, which this one cannot do and does
      not pretend to. Routing a same-context move through here would silently
      break references for the one case where following them is possible.
    */
    throw new ConvexError({
      code: "SAME_CONTEXT",
      message: "That is a move within one context. Use the ordinary move, which also fixes links.",
    });
  }
  const from = normalizeMovePath(args.from);
  const to = normalizeMovePath(args.to);
  if (from === "" || to === "") {
    throw new ConvexError({
      code: "PATH_INVALID",
      message: "A move needs a note or folder to move and somewhere to put it.",
    });
  }

  // Source first, so somebody who owns neither is refused by the context they
  // are taking from rather than by the one they are giving to — which is also
  // the only one of the two whose existence they have proven anything about.
  await requireWorkspaceRole(ctx, args.sourceWorkspaceId, args.actorUserId, "owner");
  await requireWorkspaceRole(ctx, args.destinationWorkspaceId, args.actorUserId, "editor");
}

/**
 * Trim the slashes a path picker can leave on either end.
 *
 * The engine's own `requirePath` rejects rather than repairs, which is right
 * for a key arriving from a tool call. This is the console's own dialog, and a
 * trailing slash on a folder somebody picked is not an error worth showing
 * them.
 */
function normalizeMovePath(input: string): string {
  return input.replace(/^\/+/, "").replace(/\/+$/, "").trim();
}

/* -------------------------------------------------------------------------- */
/*                                 one pass                                   */
/* -------------------------------------------------------------------------- */

export const readMove = internalQuery({
  args: { moveId: v.id("contextMoves") },
  returns: v.union(
    v.null(),
    v.object({
      sourceWorkspaceId: v.id("workspaces"),
      destinationWorkspaceId: v.id("workspaces"),
      actorUserId: v.id("users"),
      from: v.string(),
      to: v.string(),
      status: v.union(v.literal("moving"), v.literal("complete"), v.literal("failed")),
      movedObjects: v.number(),
      movedBytes: v.number(),
      skipped: v.array(skipValidator),
    }),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.moveId);
    if (row === null) return null;
    return {
      sourceWorkspaceId: row.sourceWorkspaceId,
      destinationWorkspaceId: row.destinationWorkspaceId,
      actorUserId: row.actorUserId,
      from: row.from,
      to: row.to,
      status: row.status,
      movedObjects: row.movedObjects,
      movedBytes: row.movedBytes,
      skipped: row.skipped,
    };
  },
});

export const recordMoveProgress = internalMutation({
  args: {
    moveId: v.id("contextMoves"),
    movedObjects: v.number(),
    movedBytes: v.number(),
    skipped: v.array(skipValidator),
    status: v.union(v.literal("moving"), v.literal("complete"), v.literal("failed")),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.moveId);
    if (row === null) return null;
    const now = Date.now();
    await ctx.db.patch(args.moveId, {
      movedObjects: row.movedObjects + args.movedObjects,
      movedBytes: row.movedBytes + args.movedBytes,
      skipped: args.skipped,
      status: args.status,
      ...(args.error === undefined ? {} : { error: args.error }),
      updatedAt: now,
      ...(args.status === "moving" ? {} : { completedAt: now }),
    });
    return null;
  },
});

/**
 * Carry the next few batches, then schedule the next pass or stop.
 *
 * **Every failure here ends with the row saying what happened.** A pass that
 * threw and left the row at `moving` would be a move that is not moving and
 * cannot be resumed, which is the state a person cannot act on and cannot tell
 * apart from a slow one.
 */
export const advanceContextMove = internalAction({
  args: { moveId: v.id("contextMoves"), passesLeft: v.number() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const row = await ctx.runQuery(internal.functions.contextMoves.readMove, {
      moveId: args.moveId,
    });
    if (row === null || row.status !== "moving") return null;

    const skipped = [...row.skipped];
    let movedObjects = 0;
    let movedBytes = 0;
    let remaining = true;

    const stop = async (
      status: "complete" | "failed",
      error?: string,
    ): Promise<null> => {
      await ctx.runMutation(internal.functions.contextMoves.recordMoveProgress, {
        moveId: args.moveId,
        movedObjects,
        movedBytes,
        skipped,
        status,
        ...(error === undefined ? {} : { error }),
      });
      await ctx.runMutation(internal.functions.audit.recordEvent, {
        workspaceId: row.sourceWorkspaceId,
        actorUserId: row.actorUserId,
        action: status === "complete" ? "file.moveOut" : "file.moveOut.failed",
        paths: [row.from, row.to],
        details: {
          objects: row.movedObjects + movedObjects,
          bytes: row.movedBytes + movedBytes,
          skipped: skipped.length,
          ...(error === undefined ? {} : { error }),
        },
      });
      /*
        AND ONE IN THE DESTINATION'S OWN TRAIL, BECAUSE IT IS ITS OWN CONTEXT.

        The mover reaches the destination as an `editor`, which is somebody
        else's context in every case that matters. Every other write an editor
        makes there leaves a row — `file.create`, `file.write`, `file.delete` —
        and this one carried an unbounded number of notes in and left nothing.
        `listContextMoves` cannot stand in for it either: it is indexed
        `by_source_updatedAt` and gated on owning the SOURCE, which is right
        for a progress list and leaves the destination's owner with no record
        of the move in any place they can read.

        Two deliberate narrowings:

          - **Only when something actually landed.** A move that failed before
            a byte arrived did not happen here, and a row saying it did would
            tell this context's readers about an attempt rather than an event.
          - **The destination path only.** `row.from` names a folder inside a
            context these readers have nothing to do with. An audit row is a
            record of what happened HERE, and the source's own trail already
            carries both halves for the person who owns that side.
      */
      const landedObjects = row.movedObjects + movedObjects;
      if (landedObjects > 0) {
        await ctx.runMutation(internal.functions.audit.recordEvent, {
          workspaceId: row.destinationWorkspaceId,
          actorUserId: row.actorUserId,
          action: status === "complete" ? "file.moveIn" : "file.moveIn.partial",
          paths: [row.to],
          details: {
            objects: landedObjects,
            bytes: row.movedBytes + movedBytes,
          },
        });
      }
      return null;
    };

    /*
      BOTH ROLES, ASKED AGAIN, ON EVERY PASS.

      `openMove` established them when somebody pressed Move, and a large move
      outlives that press by minutes. In between, an owner can have handed the
      source on, or the destination's owner can have taken this person's write
      access back — and a job that kept batching on the strength of a check made
      before either would be carrying notes out of a context on an authority
      that no longer exists.

      It also supplies the two *scopes*, which is not a detail: the destination
      write goes through the same `assertDestinationsVisible` every other write
      does, so a mover who owns the destination must arrive at it as `private`
      and an editor as `team`. Hardcoding `team` here — which this did — refused
      the commonest case there is, one person moving something between two
      contexts they own, with `not found` about their own folder.
    */
    let source: { scope: "private" | "team"; grantedNames: string[] };
    let destination: { scope: "private" | "team"; grantedNames: string[] };
    try {
      source = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
        actorUserId: row.actorUserId,
        workspaceId: row.sourceWorkspaceId,
        minimum: "owner",
      });
      destination = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
        actorUserId: row.actorUserId,
        workspaceId: row.destinationWorkspaceId,
        minimum: "editor",
      });
    } catch {
      return await stop(
        "failed",
        "This move stopped because the access it was started with is no longer in place. Everything already moved is in the new context.",
      );
    }

    try {
      for (let batch = 0; batch < BATCHES_PER_PASS && remaining; batch += 1) {
        const exported = await ctx.runAction(internal.functions.files.runFileOperation, {
          workspaceId: row.sourceWorkspaceId,
          scope: source.scope,
          grantedNames: source.grantedNames,
          operation: {
            kind: "contextMoveExport",
            from: row.from,
            to: row.to,
            skip: skipped.map((entry) => entry.path),
          },
        });
        if (exported.kind !== "contextMoveExported") return await stop("failed", UNEXPECTED);
        remaining = exported.remaining;
        for (const entry of exported.skipped) {
          if (!skipped.some((seen) => seen.path === entry.path)) skipped.push(entry);
        }
        if (skipped.length > CONTEXT_MOVE_SKIP_CAP) {
          return await stop(
            "failed",
            `More than ${CONTEXT_MOVE_SKIP_CAP} notes here are encrypted to this context and cannot move. Take them out of the encrypted state first, or move this in smaller pieces.`,
          );
        }
        if (exported.objects.length === 0) {
          /*
            NOTHING TO CARRY, ON A MOVE THAT HAS CARRIED NOTHING.

            Every other way of reaching an empty export is ordinary — a batch
            whose candidates were all skipped, or the pass after the last
            object went. This one is not: it means the path somebody typed or
            picked is not there, and completing on it would tell them their
            note is in the other context.

            `movePath` throws `notFound` for the same case. Here the export
            cannot: an export that refused an empty subtree would refuse the
            final pass of every successful move.
          */
          if (row.movedObjects + movedObjects === 0 && skipped.length === 0) {
            return await stop(
              "failed",
              `There is nothing at ${row.from} to move.`,
            );
          }
          break;
        }

        const landed = await ctx.runAction(internal.functions.files.runFileOperation, {
          workspaceId: row.destinationWorkspaceId,
          scope: destination.scope,
          grantedNames: destination.grantedNames,
          operation: {
            kind: "contextMoveImport",
            objects: exported.objects,
            /*
              Only while nothing of this move has landed yet. It is the check
              that refuses a merge onto a folder the destination already has —
              and by the second batch the folder it would be looking at is this
              move's own, so asking again would refuse the move halfway through
              itself.
            */
            ...(row.movedObjects + movedObjects === 0 ? { root: row.to } : {}),
          },
        });
        if (landed.kind !== "contextMoveLanded") return await stop("failed", UNEXPECTED);

        if (landed.landed.length > 0) {
          const carried = new Map(
            exported.objects.map((object) => [object.source, object.bytes.byteLength]),
          );
          const removed = await ctx.runAction(internal.functions.files.runFileOperation, {
            workspaceId: row.sourceWorkspaceId,
            scope: source.scope,
            grantedNames: source.grantedNames,
            operation: {
              kind: "contextMoveDelete",
              sources: landed.landed.map((entry) => {
                const exportedObject = exported.objects.find(
                  (object) => object.source === entry.source,
                )!;
                return {
                  path: entry.source,
                  etag: exportedObject.etag,
                  ...(exportedObject.collaborationEtag === undefined
                    ? {}
                    : { collaborationEtag: exportedObject.collaborationEtag }),
                };
              }),
            },
          });
          if (removed.kind !== "contextMoveRemoved") return await stop("failed", UNEXPECTED);
          movedObjects += removed.deleted.length;
          for (const path of removed.deleted) movedBytes += carried.get(path) ?? 0;

          if (removed.conflicts.length > 0) {
            /*
              SOMEBODY EDITED IT BETWEEN THE COPY AND THE DELETE.

              The copy at the destination is the older text, so it is the copy
              that goes: taking the source out instead would lose the edit,
              and leaving both would quietly fork the note. Everything else in
              this batch has already moved and stays moved, and running the
              move again picks the note up with its new etag.
            */
            const stale = landed.landed.filter((entry) =>
              removed.conflicts.includes(entry.source),
            );
            await ctx
              .runAction(internal.functions.files.runFileOperation, {
                workspaceId: row.destinationWorkspaceId,
                scope: destination.scope,
                grantedNames: destination.grantedNames,
                // The same conditional-delete operation the source half uses,
                // pointed the other way: it removes each copy only if it still
                // holds the etag this move gave it, and clears the exception
                // the import wrote beside it. A plain delete would take
                // whatever is at that path, including something the
                // destination's own owner put there in between.
                operation: {
                  kind: "contextMoveDelete",
                  sources: stale.map((entry) => ({
                    path: entry.destination,
                    etag: entry.etag,
                  })),
                },
              })
              .catch(() => undefined);
            return await stop(
              "failed",
              "A note changed while it was being moved, so the move stopped. Everything already moved is in the new context; run it again to finish.",
            );
          }
        }
        if (landed.failure !== null) {
          return await stop(
            "failed",
            landed.failure.code === "DESTINATION_EXISTS"
              ? "Something is already at that path in the other context, so the move stopped. Pick a name nothing there is using and run it again."
              : landed.failure.message,
          );
        }
      }
    } catch (error) {
      return await stop("failed", messageOf(error));
    }

    if (remaining) {
      if (args.passesLeft <= 1) {
        return await stop(
          "failed",
          "This move is taking more passes than expected and has stopped. Everything already moved is in the new context; run it again to finish.",
        );
      }
      await ctx.runMutation(internal.functions.contextMoves.recordMoveProgress, {
        moveId: args.moveId,
        movedObjects,
        movedBytes,
        skipped,
        status: "moving",
      });
      await ctx.scheduler.runAfter(0, internal.functions.contextMoves.advanceContextMove, {
        moveId: args.moveId,
        passesLeft: args.passesLeft - 1,
      });
      return null;
    }

    /*
      Nothing left under the source. What the source manifest still says about
      it has to go too — a folder rule outlives its folder, and the name comes
      back the day anything recreates that path, carrying a visibility nobody
      chose. Rules covering what stayed behind are kept, which is what the
      survivor list is.
    */
    try {
      await ctx.runAction(internal.functions.files.runFileOperation, {
        workspaceId: row.sourceWorkspaceId,
        scope: source.scope,
        grantedNames: source.grantedNames,
        operation: {
          kind: "contextMoveFinish",
          from: row.from,
          survivors: skipped.map((entry) => entry.path),
        },
      });
    } catch (error) {
      return await stop("failed", messageOf(error));
    }
    return await stop("complete");
  },
});

const UNEXPECTED = "The move could not be completed. Nothing further was moved.";

function messageOf(error: unknown): string {
  if (error instanceof ConvexError) {
    const data = error.data as { message?: unknown } | undefined;
    if (typeof data?.message === "string") return data.message;
  }
  return error instanceof Error && error.message !== "" ? error.message : UNEXPECTED;
}

async function callerId(ctx: Parameters<typeof getAuthUserId>[0]): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) {
    throw new ConvexError({ code: "NOT_AUTHENTICATED", message: "Not authenticated" });
  }
  return userId as Id<"users">;
}
