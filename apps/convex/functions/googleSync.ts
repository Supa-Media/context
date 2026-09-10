/**
 * THE FORWARD SYNC LOOP for a connected Google account.
 *
 * Connecting a mailbox wrote a row, a grant and a `historyId` baseline
 * (`googleConnect.ts`), and until this module existed **nothing ever advanced
 * that cursor**. There was no cron entry, the gateway's `scheduled()` handler
 * has no trigger configured and only ever reached the single-tenant legacy
 * path anyway, and `apps/mcp/src/communications/gmailSync.js` — a complete,
 * fixture-tested Gmail pipeline — was imported by nothing at all. A person
 * connected Gmail in settings and their mail never arrived, with the console
 * showing a connection that looked exactly like one working perfectly.
 *
 * So this is a **trigger, not a pipeline**: everything here decides *when* a
 * connection is polled and *what the row says afterwards*. The fetching and
 * the rendering are `gmailSync.js`'s, unchanged, driven from inside
 * `runFileOperation` — the one credential barrier — exactly as the historical
 * backfill drove them before #388 removed it.
 *
 * ## Why a pull, and not a webhook
 *
 * Google can push: `users.watch` posts Gmail changes to a Pub/Sub topic, and
 * Calendar has watch channels. Both are rejected here for now, and
 * `docs/decisions/communications.md` carries the argument in full — the short
 * version is that a push path needs a Google Cloud Pub/Sub topic in *our*
 * project, an internet-facing verified endpoint, and a re-registration every
 * seven days per mailbox, and it still needs this loop underneath it, because
 * a missed or expired watch is only ever noticed by something that polls. A
 * pull that works is worth more than a push that needs a pull to be correct.
 *
 * ## Why the floor is five minutes, and how one cron serves many intervals
 *
 * `crons.ts` runs `sweepDueGoogleSyncs` every five minutes — one job, at the
 * floor — and the sweep starts a pass only for connections that are actually
 * due (`now >= lastSyncAt + interval`). A per-connection
 * `syncIntervalMinutes` is therefore served by a fixed global tick: the cron
 * decides when to *look*, never whether a given connection may sync.
 *
 * Five minutes is the floor because it is the resolution of the tick, and
 * because below it the poll stops being cheap: every pass mints or reuses an
 * access token, calls `history.list`, and re-lists and re-renders every day a
 * changed message landed on. `apps/desktop/src/main/imessage.ts` — the sync
 * loop in this codebase that actually works — settled on the same five
 * minutes against a local SQLite file, and this one talks to Google over the
 * network on somebody else's quota.
 *
 * The **default** is fifteen minutes rather than the floor. Mail is not a
 * chat: three passes an hour keeps a brain within a quarter of an hour of the
 * mailbox, at a third of the floor's cost in Convex actions and Google calls,
 * and the person who wants the floor can set it. What a person loses by
 * choosing a longer interval is written down in
 * `docs/decisions/communications.md` and is worth stating plainly: the mail is
 * not lost, it is late — every pass rebuilds each touched day from Gmail's
 * live state, so a slower poll writes the same bytes later. The one real risk
 * is at the far end: Gmail expires a `historyId` after roughly a week, so an
 * interval measured in days makes an expired cursor likely, and an expired
 * cursor under a forward-only policy means the mail that arrived in the gap is
 * never captured. That is why `MAX_SYNC_INTERVAL_MINUTES` is one day.
 *
 * ## Forward-only
 *
 * #388 disabled historical backfill deliberately and that decision stands.
 * Nothing here re-enables it and nothing here routes around
 * `GOOGLE_SYNC_FORWARD_ONLY`: a pass advances `historyId` from wherever it is,
 * which is what the cursor was recorded for. A connection with no cursor yet
 * takes one from `users.getProfile` and starts there — the moment it is
 * adopted, not a day earlier.
 */

import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, mutation } from "../_generated/server";
import { internal } from "../_generated/api";
import { recordAudit } from "./lib/audit";
import { defaultGoogleDestinationFolder, mailConnectEnabled, requireActor } from "./googleConnect";
/*
 * The arithmetic lives in a leaf module rather than here, because
 * `googleConnect.ts` reads it too and a cycle between these two files fails as
 * an intermittently missing export rather than as an error — see that file's
 * own comment for the shape it took: a test about deleting an account, failing
 * one full-suite run in six, naming a function neither file mentions.
 */
import {
  DEFAULT_SYNC_INTERVAL_MINUTES,
  MAX_SYNC_INTERVAL_MINUTES,
  MIN_SYNC_INTERVAL_MINUTES,
  SYNC_STALL_MS,
  failureBackoffMs,
  isDue,
  syncIntervalMinutesOf,
  syncableProductsOf,
} from "./lib/googleSchedule";

/** Connections one sweep may start, bounded like every other sweep here. */
const SWEEP_BATCH = 50;

function validateSyncInterval(value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new ConvexError({
      code: "GOOGLE_SYNC_INTERVAL_INVALID",
      message: `Choose a whole number of minutes, at least ${MIN_SYNC_INTERVAL_MINUTES}.`,
    });
  }
  if (value < MIN_SYNC_INTERVAL_MINUTES) {
    throw new ConvexError({
      code: "GOOGLE_SYNC_INTERVAL_TOO_SHORT",
      message: `Sync can run at most every ${MIN_SYNC_INTERVAL_MINUTES} minutes.`,
    });
  }
  if (value > MAX_SYNC_INTERVAL_MINUTES) {
    throw new ConvexError({
      code: "GOOGLE_SYNC_INTERVAL_TOO_LONG",
      message: `Sync must run at least once a day; ${MAX_SYNC_INTERVAL_MINUTES} minutes is the longest gap.`,
    });
  }
  return value;
}

/**
 * How often this account is polled. **Owner of a personal context only.**
 *
 * The floor lives here rather than in the picker, because a picker is a
 * suggestion: this refuses four minutes from a console, from a script, and
 * from a client that has never seen the UI.
 */
export const updateGoogleSyncInterval = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    connectionId: v.id("googleConnections"),
    syncIntervalMinutes: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireActor(ctx);
    const allowed = await ctx.runQuery(internal.functions.googleConnect.requirePersonalOwner, {
      workspaceId: args.workspaceId,
      userId,
    });
    if (!allowed) {
      throw new ConvexError({
        code: "NOT_OWNER",
        message: "Only the owner can change how often this context syncs.",
      });
    }
    const minutes = validateSyncInterval(args.syncIntervalMinutes);
    const connection = await ctx.db.get(args.connectionId);
    /*
      One refusal for every way of saying no, and `workspaceId` is checked
      against the row rather than trusted from the caller. An owner of context
      A naming a connection that belongs to context B must not be able to tell
      "that is not yours" apart from "there is no such connection" — the same
      rule `updateGoogleSyncDestination` applies one file over.
    */
    if (
      connection === null ||
      connection.workspaceId !== args.workspaceId ||
      connection.disconnectedAt !== undefined
    ) {
      throw new ConvexError({
        code: "GOOGLE_CONNECTION_NOT_FOUND",
        message: "That Google account is not connected to this context.",
      });
    }

    await ctx.db.patch(args.connectionId, {
      syncIntervalMinutes: minutes,
      /*
        A shortened interval takes effect at once rather than after one more
        wait at the old one — the same property `imessage.ts` gets by reading
        its settings fresh every pass. A connection that has never synced keeps
        no `nextSyncAt` at all, because it is already due.
      */
      nextSyncAt:
        connection.lastSyncAt === undefined ? undefined : connection.lastSyncAt + minutes * 60_000,
      updatedAt: Date.now(),
    });
    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: userId,
      action: "google_sync_interval_updated",
      details: { connectionId: args.connectionId, syncIntervalMinutes: minutes },
    });
    return null;
  },
});

/**
 * THE CRON'S ONLY JOB: look, and start passes for connections that are due.
 *
 * The argument `crons.ts` requires of anything that starts work rather than
 * deleting it, made here so it can be pointed at: **this holds no decision.**
 * Whether a connection may sync at all is the connection's own state — is it
 * still connected, is it a personal context, does it enable a product this
 * engine can advance, does this deployment allow reading a restricted scope —
 * and every one of those is re-asked by `googleForwardSyncJob` inside the pass
 * itself, before a credential is opened. What the sweep decides is only *when
 * to look*, and the answer is "every five minutes, at whichever connections
 * their own interval has made due".
 *
 * The deployment flag is the one thing read here as well as there, and it is
 * read as a switch rather than as a decision: with Google's verification not
 * yet granted, a deployment that may not read mail should not be starting
 * scheduled work that opens a credential to discover that.
 */
export const sweepDueGoogleSyncs = internalMutation({
  args: {},
  returns: v.object({ started: v.number(), examined: v.number() }),
  handler: async (ctx): Promise<{ started: number; examined: number }> => {
    if (!mailConnectEnabled()) return { started: 0, examined: 0 };
    const now = Date.now();
    const rows = await ctx.db
      .query("googleConnections")
      .withIndex("by_sync_due", (q) => q.eq("disconnectedAt", undefined).lte("nextSyncAt", now))
      // Bounded, like every other sweep here: a backlog drains over several
      // runs rather than in one transaction big enough to hit a limit. The
      // index is ordered by due time, so the oldest-due drain first and no
      // connection can be starved by one that is not due yet.
      .take(SWEEP_BATCH);

    let started = 0;
    for (const row of rows) {
      // The index range already excludes these. An index is a poor place to
      // trust an invariant that lives on another field — the same belt
      // `sweepStalledBackfills` wears over `optedIn`. Unreachable while the
      // index above is right, which is the point: it is what catches the day
      // somebody changes the index.
      if (row.disconnectedAt !== undefined) continue;
      if (syncableProductsOf(row).length === 0) continue;
      if (!isDue(row, now)) continue;
      /*
        NOT OVERTAKING A PASS THAT IS STILL RUNNING.

        A claimed pass sets `syncStartedAt` and clears it when it reports, so a
        pass in flight looks recent and a lost one looks stale. Two passes on
        one mailbox is not a correctness failure — every day is rebuilt from
        Gmail's live state, so the second would write the same bytes — but it
        doubles the Google calls and races two writers onto one note's etag,
        and there is no reason to cause it on purpose.
      */
      if (row.syncStartedAt !== undefined && now - row.syncStartedAt < SYNC_STALL_MS) continue;

      const intervalMs = syncIntervalMinutesOf(row) * 60_000;
      await ctx.db.patch(row._id, {
        syncStartedAt: now,
        // Claimed, so the next tick finds it not due even if this pass never
        // reports. A pass that is genuinely lost is picked up again by the
        // stall guard above.
        nextSyncAt: now + intervalMs,
        updatedAt: now,
      });
      await ctx.scheduler.runAfter(0, internal.functions.files.runFileOperation, {
        workspaceId: row.workspaceId,
        scope: "private",
        operation: { kind: "googleForwardSync", connectionId: row._id },
      });
      started += 1;
    }
    return { started, examined: rows.length };
  },
});

const forwardSyncJobValidator = v.union(
  v.null(),
  v.object({ kind: v.literal("skip"), reason: v.string() }),
  v.object({
    kind: v.literal("run"),
    connectionId: v.id("googleConnections"),
    product: v.literal("gmail"),
    address: v.string(),
    mailboxSlug: v.string(),
    destinationFolder: v.string(),
    folders: v.array(v.union(v.literal("inbox"), v.literal("sent"))),
    quotaBytes: v.number(),
    bytesAlreadyUsed: v.number(),
    attachmentMode: v.union(v.literal("metadata-only"), v.literal("store")),
    attachmentRetentionDays: v.optional(v.union(v.number(), v.literal("forever"))),
    historyId: v.optional(v.string()),
  }),
);

/**
 * What the pass is allowed to do, re-asked at the moment it runs.
 *
 * The sweep that scheduled this ran up to a few minutes ago and holds no
 * decision (see above); in that time the account can have been disconnected,
 * the product turned off, or the grant revoked. So every gate is asked here,
 * **before** `runFileOperation` opens a bucket credential — the same ordering,
 * and the same reason, as the projection pass that asks
 * `projectionTargetForWorkspace` first.
 *
 * `null` means there is no row to report against at all. `skip` means there is
 * a row, it is not to be synced, and the claim on it must still be released.
 *
 * No secret is returned. This is the settings-and-cursor view; the refresh
 * token never leaves `mintGoogleAccessToken`.
 */
export const googleForwardSyncJob = internalQuery({
  args: { workspaceId: v.id("workspaces"), connectionId: v.id("googleConnections") },
  returns: forwardSyncJobValidator,
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    if (connection === null) return null;
    /*
     * THE TWO ARGUMENTS HAVE TO AGREE, AND THIS IS WHERE THAT IS CHECKED.
     *
     * The pass runs inside `runFileOperation`, which opens the bucket
     * credential of the `workspaceId` it was handed, and then writes mail read
     * from the account named by `connectionId`. A mismatched pair would file
     * one context's mail into another context's bucket. Nothing constructs
     * such a pair today — the sweep reads both off one row — but "no caller
     * does that" is not a tenant boundary, and this is the one place that can
     * be one, because it is the only function that sees both.
     */
    if (connection.workspaceId !== args.workspaceId) return null;
    if (connection.disconnectedAt !== undefined) {
      return { kind: "skip" as const, reason: "GOOGLE_DISCONNECTED" };
    }
    if (!mailConnectEnabled()) {
      return { kind: "skip" as const, reason: "MAIL_CONNECT_DISABLED" };
    }
    const workspace = await ctx.db.get(args.workspaceId);
    if (workspace === null || workspace.kind !== "personal") {
      // A mailbox may only ever land in a personal context
      // (`identity-and-access.md`). A workspace that changed kind under a
      // connection is not a state this writes mail through.
      return { kind: "skip" as const, reason: "NOT_PERSONAL_CONTEXT" };
    }
    if (connection.health === "reconnect_required") {
      // Minting would fail against a grant Google has already refused, once
      // per pass, forever. A reconnect rewrites `health`, which is what puts
      // this connection back in the loop.
      return { kind: "skip" as const, reason: "GOOGLE_RECONNECT_REQUIRED" };
    }
    if (!connection.products.includes("gmail") || !connection.gmail) {
      return { kind: "skip" as const, reason: "NO_SYNCABLE_PRODUCT" };
    }

    const gmail = connection.gmail;
    return {
      kind: "run" as const,
      connectionId: connection._id,
      product: "gmail" as const,
      address: connection.address,
      mailboxSlug: gmail.mailboxSlug,
      destinationFolder:
        gmail.destinationFolder ?? defaultGoogleDestinationFolder("gmail", gmail.mailboxSlug),
      folders: gmail.folders,
      quotaBytes: gmail.quotaBytes,
      bytesAlreadyUsed: connection.syncBytesWritten ?? 0,
      attachmentMode: gmail.attachmentMode,
      attachmentRetentionDays: gmail.attachmentRetentionDays,
      historyId: gmail.historyId,
    };
  },
});

/**
 * What one pass learned, written where a person can see it.
 *
 * Every exit from a pass comes through here, including the ones that did
 * nothing: the claim (`syncStartedAt`) has to be released or the connection
 * sits unsyncable for fifteen minutes for no reason.
 *
 * `lastSyncAt` is when a pass last **finished**, successfully or not, and the
 * next due time is computed from it. That is deliberate: making it mean "last
 * success" would leave a permanently failing connection due on every single
 * tick, which is the request pattern most likely to keep it failing.
 * "Last synced", the thing a person actually asks about, is
 * `gmail.lastSyncedAt`, and it moves only when mail was read.
 */
export const recordGoogleForwardSyncPass = internalMutation({
  args: {
    connectionId: v.id("googleConnections"),
    status: v.union(v.literal("synced"), v.literal("skipped"), v.literal("failed")),
    /** The cursor to store. Absent leaves the existing one exactly where it is. */
    historyId: v.optional(v.string()),
    daysTouched: v.optional(v.number()),
    bytesWritten: v.optional(v.number()),
    /** Gmail expired the cursor. Forward-only: it is re-baselined and the gap is recorded, not backfilled. */
    gapDetected: v.optional(v.boolean()),
    /**
     * The history walk ran out of pages. The cursor still moves — to the last
     * record walked — and the connection stays due, so the next pass drains
     * further instead of waiting out an interval it already knows is wrong.
     */
    catchUp: v.optional(v.boolean()),
    /**
     * This pass established a cursor rather than reading mail: a first
     * baseline, or a re-baseline after a gap. It is a successful pass and it
     * read nothing, so `gmail.lastSyncedAt` — the console's "has this ever
     * actually synced" — deliberately does not move.
     */
    baseline: v.optional(v.boolean()),
    errorCode: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  returns: v.object({ accepted: v.boolean() }),
  handler: async (ctx, args): Promise<{ accepted: boolean }> => {
    const connection = await ctx.db.get(args.connectionId);
    if (connection === null || connection.disconnectedAt !== undefined) {
      return { accepted: false };
    }
    const now = Date.now();
    const intervalMs = syncIntervalMinutesOf(connection) * 60_000;
    const error = args.error?.slice(0, 240);

    if (args.status === "skipped") {
      // Nothing was read, so `lastSyncAt` does not move — a skipped pass must
      // not be able to make a connection that has never synced look synced.
      await ctx.db.patch(args.connectionId, {
        syncStartedAt: undefined,
        nextSyncAt: now + intervalMs,
        updatedAt: now,
      });
      return { accepted: true };
    }

    if (args.status === "failed") {
      const failures = (connection.syncFailures ?? 0) + 1;
      await ctx.db.patch(args.connectionId, {
        syncStartedAt: undefined,
        lastSyncAt: now,
        nextSyncAt: now + failureBackoffMs(intervalMs, failures, args.connectionId),
        syncFailures: failures,
        /*
          BYTES ARE COUNTED ON THE PATH THAT ACTUALLY WRITES THEM.

          The one caller that reports a non-zero figure here is the quota path,
          which stops *after* writing whole days. Dropping the count froze
          `bytesAlreadyUsed` below the ceiling, so every later pass re-listed,
          re-rendered and re-wrote the same days and dropped the bytes again —
          a ceiling that could never be crossed, which is what the schema
          comment calls decoration.
        */
        syncBytesWritten: (connection.syncBytesWritten ?? 0) + (args.bytesWritten ?? 0),
        /*
          `reconnect_required` SURVIVES A FAILED PASS.

          `mintGoogleAccessToken` sets it when Google refuses the grant
          outright, and the pass's own skip gate keys on it — so overwriting it
          with a plain `error` here meant the gate never fired again and a dead
          grant was offered to Google's token endpoint every backoff, forever.
          It also erased the one state the console renders as "needs
          reconnect", which is the only thing the owner can act on.
        */
        health:
          connection.health === "reconnect_required"
            ? ("reconnect_required" as const)
            : ("error" as const),
        lastError: error ?? "This Google account did not sync.",
        errorCode: args.errorCode ?? "GOOGLE_SYNC_FAILED",
        lastSyncFailureAt: now,
        lastSyncFailureCode: args.errorCode ?? "GOOGLE_SYNC_FAILED",
        lastSyncFailure: error ?? "This Google account did not sync.",
        updatedAt: now,
      });
      return { accepted: true };
    }

    const gmail = connection.gmail
      ? {
          ...connection.gmail,
          historyId: args.historyId ?? connection.gmail.historyId,
          // A baseline or a re-baseline read no mail, so it does not claim to
          // have. `cursorReady` is what those passes make true.
          lastSyncedAt: args.baseline === true ? connection.gmail.lastSyncedAt : now,
        }
      : connection.gmail;
    /*
      A GAP IS RECORDED, NOT SMOOTHED OVER.

      Gmail dropped this mailbox's `historyId`, so the changes since it was
      issued cannot be enumerated. The documented recovery was a full reconcile
      over the backfill window, and forward-only (#388) does not have one — so
      the cursor is re-baselined to Gmail's current one and the mail that
      arrived in the gap is not captured. That is a real loss and it is written
      onto the row as a failure a person can read, even though the pass itself
      succeeded and the connection is healthy from here on.
    */
    const gap = args.gapDetected === true;
    const catchUp = args.catchUp === true;
    await ctx.db.patch(args.connectionId, {
      gmail,
      syncStartedAt: undefined,
      lastSyncAt: now,
      // A pass that knows it left work behind is due at once; anything else
      // waits its interval. `syncCatchUp` is cleared either way, so a
      // connection that has caught up stops being due every tick.
      nextSyncAt: catchUp ? now : now + intervalMs,
      syncCatchUp: catchUp ? true : undefined,
      syncFailures: undefined,
      syncBytesWritten: (connection.syncBytesWritten ?? 0) + (args.bytesWritten ?? 0),
      health: "active" as const,
      lastError: undefined,
      errorCode: undefined,
      ...(gap
        ? {
            lastSyncFailureAt: now,
            lastSyncFailureCode: "GOOGLE_SYNC_GAP",
            lastSyncFailure:
              "Google expired this mailbox's sync cursor. Mail that arrived while it was expired was not captured; syncing continues from now.",
          }
        : {}),
      updatedAt: now,
    });

    /*
      A PASS THAT WROTE INTO SOMEBODY'S BUCKET LEAVES A ROW SAYING SO.

      This is the first writer in the codebase with no person present, and
      non-negotiable #4 says the audit records the acting identity rather than
      just the scope. The identity here is `boundBy` — whoever connected the
      account, on whose grant every one of these writes is made. Naming them is
      more honest than an empty actor, and it is the name an owner needs when
      the question is "who set this up".

      Only passes that actually wrote something. A poll that found nothing is
      not an event, and recording 288 of those a day per connection would bury
      the ones that matter. Counts only: no subject, no address, no path — the
      day notes' own paths are `gmail.destinationFolder` plus a date, which the
      row already carries.
    */
    if ((args.daysTouched ?? 0) > 0) {
      await recordAudit(ctx, {
        workspaceId: connection.workspaceId,
        actorUserId: connection.boundBy,
        action: "google_sync_wrote",
        details: {
          connectionId: args.connectionId,
          product: "gmail",
          days: args.daysTouched ?? 0,
          bytes: args.bytesWritten ?? 0,
        },
      });
    }
    return { accepted: true };
  },
});
