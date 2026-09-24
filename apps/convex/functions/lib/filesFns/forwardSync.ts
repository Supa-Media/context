/**
 * The forward sync pass for one Google connection — Gmail, Chat and Calendar —
 * and the retired historical Gmail backfill's refusal.
 *
 * Moved verbatim out of `functions/files.ts`. Every function here runs inside
 * the credential barrier `runFileOperation`, against the store it built, and
 * is reached from nowhere else.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { fnv1a64 } from "../../../../../packages/communications/src/anchors.js";
import {
  calendarDayNotePath,
  mergeEventCaches,
  projectDay,
  renderCalendarDay,
} from "../../../../../packages/communications/src/calendar/index.js";
import { syncCalendarAccount } from "../../../../mcp/src/communications/calendar-sync.js";
import {
  CalendarContributionIncompleteError,
  loadActiveCalendarContributions,
  loadCalendarContribution,
  persistCalendarContribution,
} from "../../../../mcp/src/communications/calendarContributionStore.js";
import { placeDayParts } from "../../../../mcp/src/communications/dayPlacement.js";
/*
 * The Gmail pipeline, imported rather than ported, for exactly the reason the
 * two imports above are: `apps/mcp` targets the Workers runtime, which is
 * Convex's runtime too, and this module takes its socket, its access token and
 * its store as parameters — it opens nothing itself.
 *
 * It came back with the forward sync loop. #388 removed the historical
 * backfill that used to import it and left the module reachable from nothing
 * at all, which is how a complete, fixture-tested mail pipeline sat in the
 * repository while connected mailboxes synced nothing.
 */
import {
  getProfileHistoryId,
  GmailApiError,
  runIncrementalSync,
  writeContactDraft,
  writeDayPart,
} from "../../../../mcp/src/communications/gmailSync.js";
import {
  listMessagesPage,
  listSpacesPage,
} from "../../../../mcp/src/communications/googleChat/client.js";
import {
  ChatContributionIncompleteError,
  loadActiveChatContributions,
  persistChatContribution,
} from "../../../../mcp/src/communications/googleChat/contributionStore.js";
import {
  renderSharedGoogleChat,
  syncGoogleChat,
} from "../../../../mcp/src/communications/googleChat/sync.js";
import type { FileStore } from "../fileOps";
import {
  CalendarTimezoneMismatchError,
  classifyForwardSyncError,
  type ForwardSyncJob,
  type ForwardSyncResult,
  timeoutFetch,
  writeSharedCalendarDay,
} from "./forwardSyncSupport";
import type { OperationResult } from "./operationTypes";

/* -------------------------------------------------------------------------- */
/*                    the forward sync pass, one connection                   */
/* -------------------------------------------------------------------------- */

/**
 * Nothing to do, and the claim released.
 *
 * A skipped pass must leave `lastSyncAt` alone — a connection that has never
 * synced and one whose pass was skipped are the same connection, and making
 * the second look synced is precisely the confusion this whole loop exists to
 * remove.
 */
export async function releaseForwardSync(
  ctx: ActionCtx,
  connectionId: Id<"googleConnections">,
  reason: string | undefined,
): Promise<ForwardSyncResult> {
  await ctx.runMutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
    connectionId,
    status: "skipped",
    errorCode: reason,
  });
  return {
    kind: "googleForwardSync",
    connectionId,
    status: "skipped",
    daysTouched: 0,
    bytesWritten: 0,
    cursorAdvanced: false,
    gapDetected: false,
    truncated: false,
    errorCode: reason,
  };
}

/** A pass that could not run, recorded where the owner can read it. */
export async function failForwardSync(
  ctx: ActionCtx,
  connectionId: Id<"googleConnections">,
  errorCode: string,
  error: string,
): Promise<ForwardSyncResult> {
  await ctx.runMutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
    connectionId,
    status: "failed",
    errorCode,
    error,
  });
  return {
    kind: "googleForwardSync",
    connectionId,
    status: "failed",
    daysTouched: 0,
    bytesWritten: 0,
    cursorAdvanced: false,
    gapDetected: false,
    truncated: false,
    errorCode,
  };
}

async function runGoogleCalendarForwardSync(
  ctx: ActionCtx,
  store: FileStore,
  job: Extract<ForwardSyncJob, { kind: "run"; product: "calendar" }>,
  accessToken: string,
): Promise<ForwardSyncResult> {
  if (store.capabilities?.conditionalWrite !== true) {
    throw new Error("Shared Calendar sync requires storage with conditional writes");
  }
  const calendarStore = store as unknown as Parameters<typeof persistCalendarContribution>[0]["store"];
  const previous = await loadCalendarContribution({
    store: calendarStore,
    sourceId: job.connectionId,
  });
  const now = new Date().toISOString();
  const provider = await syncCalendarAccount({
    connection: {
      workspaceId: "private",
      account: job.address,
      calendarId: "primary",
      timezone: previous?.timezone,
      destinationFolder: job.destinationFolder,
      accessToken,
      syncToken: job.syncToken ?? null,
      lastFullSyncDate: job.lastFullSyncDate ?? null,
      eventCache: previous?.eventCache ?? new Map(),
    },
    store: calendarStore,
    fetchImpl: timeoutFetch,
    now,
    materialize: false,
  });
  if (provider.skipped || !provider.syncToken || !provider.lastFullSyncDate) {
    throw new Error("Google Calendar did not return a resumable cursor");
  }

  await persistCalendarContribution({
    store: calendarStore,
    sourceId: job.connectionId,
    contribution: {
      account: job.address,
      timezone: provider.timezone,
      destinationFolder: job.destinationFolder,
      eventCache: provider.eventCache,
    },
  });
  const contributions = await loadActiveCalendarContributions({
    store: calendarStore,
    sourceIds: job.contributorSourceIds,
  });
  const timezones = new Set(contributions.map((contribution) => contribution.timezone));
  if (timezones.size !== 1) throw new CalendarTimezoneMismatchError();
  const timezone = contributions[0]!.timezone;
  const merged = mergeEventCaches(
    contributions.map((contribution) => contribution.eventCache),
  );
  const nonceSeed = fnv1a64(
    [...job.contributorSourceIds].map(String).sort().join("\0"),
  );

  let daysTouched = 0;
  let bytesWritten = 0;
  for (const date of provider.datesTouched) {
    const events = projectDay(merged, date);
    const path = calendarDayNotePath(
      { date },
      { folder: job.destinationFolder },
    );
    const text = events.length
      ? renderCalendarDay({
          date,
          timezone,
          events,
          nonce: `calendar:${nonceSeed}:${date}`,
          now,
          origin: "calendar-sync",
        })
      : null;
    const written = await writeSharedCalendarDay(store, path, text);
    if (written.wrote) {
      daysTouched += 1;
      bytesWritten += written.bytes;
    }
  }

  await ctx.runMutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
    connectionId: job.connectionId,
    product: "calendar",
    status: "synced",
    calendarSyncToken: provider.syncToken,
    calendarLastFullSyncDate: provider.lastFullSyncDate,
    daysTouched,
    bytesWritten,
  });
  return {
    kind: "googleForwardSync",
    connectionId: job.connectionId,
    status: "synced",
    daysTouched,
    bytesWritten,
    cursorAdvanced: provider.syncToken !== job.syncToken,
    gapDetected: false,
    truncated: false,
  };
}

async function runGoogleChatForwardSync(
  ctx: ActionCtx,
  store: FileStore,
  job: Extract<ForwardSyncJob, { kind: "run"; product: "chat" }>,
  accessToken: string,
): Promise<ForwardSyncResult> {
  if (store.capabilities === undefined) {
    throw new Error("Google Chat sync requires declared storage capabilities");
  }
  // `FileStore` is the deliberately narrow view used by file operations and
  // omits `StoredObject.arrayBuffer`; every adapter returned by
  // `storeForBinding` implements the full ContextStore contract that the
  // shared communications helpers accept. Keep the cast at this one adapter
  // boundary rather than widening every ordinary file operation.
  const chatStore = store as unknown as Parameters<typeof writeContactDraft>[0];
  const result = await syncGoogleChat({
    listSpaces: ({ pageToken }: { pageToken?: string }) =>
      listSpacesPage({ fetchImpl: timeoutFetch, accessToken, pageToken }),
    listMessages: ({
      spaceName,
      sinceCreateTime,
      pageToken,
    }: {
      spaceName: string;
      sinceCreateTime: string;
      pageToken?: string;
    }) =>
      listMessagesPage({
        fetchImpl: timeoutFetch,
        accessToken,
        spaceName,
        sinceCreateTime,
        pageToken,
      }),
    connection: {
      account: job.address,
      nonceSeed: job.nonceSeed,
      cursors: job.cursors,
      spaceSettings: job.spaceSettings,
      destinationFolder: job.destinationFolder,
    },
  });

  /*
   * Commit this account's provider result before reading the shared view.
   * The manifest-last contribution store means an interrupted pass is never
   * visible as a complete account slice, and loading every active source
   * fails closed if a sibling has not completed its first pass yet.
   */
  await persistChatContribution({
    store: chatStore,
    sourceId: job.connectionId,
    contribution: result.contribution,
  });
  const contributions = await loadActiveChatContributions({
    store: chatStore,
    sourceIds: job.contributorSourceIds,
  });
  /*
    Placed against the bucket after rendering: a Chat day this workspace
    already holds a flat note for keeps it, and only a day never written
    before is filed under its month. `apps/mcp/src/communications/dayPlacement.js`
    holds the argument — a day that is regenerated on every pass and changes
    folders under itself exists twice, under one date.
  */
  const notes = await placeDayParts(
    chatStore,
    renderSharedGoogleChat({
      contributions,
      nonceSeed: job.workspaceNonceSeed,
    }),
  );

  let daysTouched = 0;
  let bytesWritten = 0;
  for (const part of notes) {
    const written = await writeDayPart(chatStore, part);
    if (written.wrote) {
      daysTouched += 1;
      bytesWritten += written.bytes;
    }
  }

  for (const draft of result.contactDrafts) {
    const written = await writeContactDraft(chatStore, draft, {
      remainingQuotaBytes: Number.MAX_SAFE_INTEGER - bytesWritten,
    });
    if (written.quotaExceeded) {
      throw new Error("Google Chat Contact exceeded the bounded sync write budget");
    }
    if (written.wrote) bytesWritten += written.bytes;
  }

  /*
   * The cursor is the commit record. It moves last, after the shared daily
   * notes and organic Contacts have all settled, so a failed write makes the
   * next pass ask Google the same question again instead of losing content.
   */
  await ctx.runMutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
    connectionId: job.connectionId,
    product: "chat",
    status: "synced",
    chatCursors: result.cursors,
    daysTouched,
    bytesWritten,
  });
  return {
    kind: "googleForwardSync",
    connectionId: job.connectionId,
    status: "synced",
    daysTouched,
    bytesWritten,
    cursorAdvanced: JSON.stringify(result.cursors) !== JSON.stringify(job.cursors),
    gapDetected: false,
    truncated: false,
  };
}

/**
 * ONE FORWARD PASS: advance this connection's cursor, write whatever changed.
 *
 * Forward-only, per #388 and `docs/decisions/communications.md`. Three shapes:
 *
 *  - **No cursor yet.** The connection was bound before a baseline could be
 *    read, so one is taken now from `users.getProfile` and stored. Nothing is
 *    fetched: forward-only means the mail from before this moment is not this
 *    loop's to collect.
 *  - **A cursor.** `history.list` from it, rebuild every day a changed message
 *    landed on from Gmail's live state, store the new cursor.
 *  - **An expired cursor.** Gmail's 404 comes back as `gapDetected` rather
 *    than an error. The documented recovery was a reconcile over the backfill
 *    window, which forward-only does not have — so the cursor is re-baselined
 *    and the gap is recorded on the row as a failure a person can read.
 *
 * **The cursor is never advanced past mail that was not written.** A quota
 * ceiling reached mid-pass, or anything thrown, leaves `historyId` exactly
 * where it was, so the next pass asks Gmail the same question again. Advancing
 * it would be the one bug in this file that loses somebody's mail silently.
 */
export async function runGoogleForwardSync(
  ctx: ActionCtx,
  store: FileStore,
  job: Extract<ForwardSyncJob, { kind: "run" }>,
): Promise<ForwardSyncResult> {
  try {
    /*
     * Inside the try, deliberately. Minting can *throw* as well as answer
     * `null` — a deployment with no Google client id configured, an envelope
     * that will not open — and a throw that escapes this function leaves the
     * scheduler holding the failure and the row holding its claim, so the
     * connection goes quiet for fifteen minutes with nothing on it to say why.
     */
    const minted = await ctx.runAction(internal.functions.googleConnect.mintGoogleAccessToken, {
      connectionId: job.connectionId,
    });
    if (minted === null) {
      // `mintGoogleAccessToken` has already marked the row
      // `reconnect_required` if Google refused the grant outright; this
      // records the pass itself.
      return await failForwardSync(
        ctx,
        job.connectionId,
        "GOOGLE_RECONNECT_REQUIRED",
        "Google needs to be reconnected before this mailbox can sync.",
      );
    }

    if (job.product === "chat") {
      return await runGoogleChatForwardSync(ctx, store, job, minted.accessToken);
    }
    if (job.product === "calendar") {
      return await runGoogleCalendarForwardSync(ctx, store, job, minted.accessToken);
    }

    if (job.historyId === undefined) {
      const historyId = await getProfileHistoryId({
        fetchImpl: timeoutFetch,
        accessToken: minted.accessToken,
      });
      await ctx.runMutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
        connectionId: job.connectionId,
        status: "synced",
        historyId,
        daysTouched: 0,
        bytesWritten: 0,
        // A cursor, not a sync: this pass read no mail, and the console must
        // be able to say so rather than showing a mailbox that looks current.
        baseline: true,
      });
      return {
        kind: "googleForwardSync",
        connectionId: job.connectionId,
        status: "synced",
        daysTouched: 0,
        bytesWritten: 0,
        cursorAdvanced: true,
        gapDetected: false,
        truncated: false,
      };
    }

    const result = await runIncrementalSync({
      store,
      fetchImpl: timeoutFetch,
      accessToken: minted.accessToken,
      mailboxSlug: job.mailboxSlug,
      address: job.address,
      folders: job.folders,
      startHistoryId: job.historyId,
      folder: job.destinationFolder,
      // The same nonce the backfill used, so a day rewritten by either path
      // keeps its message anchors — see `packages/communications/src/note.js`.
      nonce: `gmail:${job.connectionId}`,
      /*
       * NO `now`, AND THAT IS THE WHOLE POINT OF A LOOP THAT REPEATS.
       *
       * `renderDay` defaults `updated` to the latest message's own `sentAt`
       * precisely so that re-rendering an unchanged day is byte-identical, and
       * `syncOneDay` forwards whatever `now` a caller passes straight through
       * to it. The backfill removed by #388 passed a wall clock, which was
       * survivable for a one-shot import and is not for a pass that runs every
       * few minutes: every touched day would get a new `updated`, a new write,
       * and a new etag, forever — churn wearing the costume of sync activity.
       * Attachment retention is measured against a real wall clock inside
       * `syncOneDay` regardless, so nothing here loses a clock it needed.
       */
      quotaBytes: job.quotaBytes,
      bytesAlreadyUsed: job.bytesAlreadyUsed,
      attachmentMode: job.attachmentMode,
      attachmentRetentionDays: job.attachmentRetentionDays,
    });

    if (result.gapDetected) {
      const historyId = await getProfileHistoryId({
        fetchImpl: timeoutFetch,
        accessToken: minted.accessToken,
      });
      await ctx.runMutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
        connectionId: job.connectionId,
        status: "synced",
        historyId,
        daysTouched: 0,
        bytesWritten: 0,
        gapDetected: true,
        // Re-baselining reads nothing either, for the same reason.
        baseline: true,
      });
      return {
        kind: "googleForwardSync",
        connectionId: job.connectionId,
        status: "synced",
        daysTouched: 0,
        bytesWritten: 0,
        cursorAdvanced: true,
        gapDetected: true,
        truncated: false,
      };
    }

    if (result.quotaExceeded) {
      // Whatever was written stays written and is counted; the cursor does
      // not move, so the days this pass could not afford are asked for again
      // once the connection has room.
      await ctx.runMutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
        connectionId: job.connectionId,
        status: "failed",
        daysTouched: result.daysTouched.length,
        bytesWritten: result.bytesWritten,
        errorCode: "MAIL_QUOTA_EXCEEDED",
        error: "This connection reached its storage quota before the pass finished.",
      });
      return {
        kind: "googleForwardSync",
        connectionId: job.connectionId,
        status: "failed",
        daysTouched: result.daysTouched.length,
        bytesWritten: result.bytesWritten,
        cursorAdvanced: false,
        gapDetected: false,
        truncated: result.truncated === true,
        errorCode: "MAIL_QUOTA_EXCEEDED",
      };
    }

    if (result.truncated === true && result.historyId === undefined) {
      /*
       * PAGED, BUT WITH NO SAFE PLACE TO RESUME.
       *
       * Gmail may return pages that contain no records for the requested
       * `messageAdded` history type while still returning a next page token.
       * If fifty such pages exhaust this pass's bound, there is no history
       * record id to persist. Marking the row as catching up would leave the
       * cursor unchanged and make the next sweep repeat the exact same fifty
       * pages forever. Fail visibly and honor the retry ladder instead.
       */
      await ctx.runMutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
        connectionId: job.connectionId,
        status: "failed",
        daysTouched: result.daysTouched.length,
        bytesWritten: result.bytesWritten,
        errorCode: "GOOGLE_SYNC_NO_RESUME_CURSOR",
        error: "Google returned more mailbox history but no safe resume point. The next scheduled pass will try again.",
      });
      return {
        kind: "googleForwardSync",
        connectionId: job.connectionId,
        status: "failed",
        daysTouched: result.daysTouched.length,
        bytesWritten: result.bytesWritten,
        cursorAdvanced: false,
        gapDetected: false,
        truncated: true,
        errorCode: "GOOGLE_SYNC_NO_RESUME_CURSOR",
      };
    }

    /*
     * A WALK THAT RAN OUT OF PAGES IS NOT A FINISHED SYNC.
     *
     * `history.list` hands back the mailbox's *current* head on every page, so
     * a truncated walk that stored it would say "caught up" while holding only
     * the first pages — and everything behind them would be skipped forever,
     * with no gap signalled and the row reading `active`. `runIncrementalSync`
     * reports the truncation and offers the last record it actually walked
     * instead; the cursor moves there, and `catchUp` keeps this connection due
     * so the next pass drains further rather than waiting out its interval.
     */
    const truncated = result.truncated === true;
    await ctx.runMutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
      connectionId: job.connectionId,
      status: "synced",
      historyId: result.historyId,
      daysTouched: result.daysTouched.length,
      bytesWritten: result.bytesWritten,
      catchUp: truncated,
    });
    return {
      kind: "googleForwardSync",
      connectionId: job.connectionId,
      status: "synced",
      daysTouched: result.daysTouched.length,
      bytesWritten: result.bytesWritten,
      cursorAdvanced: result.historyId !== undefined,
      gapDetected: false,
      truncated,
    };
  } catch (error) {
    // The first account in a multi-account workspace can finish before a
    // sibling has ever stored its contribution. That is an expected warm-up
    // state, not an outage: keep this account's cursor in place, release the
    // claim, and let the sibling's own due pass fill the missing slice.
    if (
      error instanceof ChatContributionIncompleteError ||
      error instanceof CalendarContributionIncompleteError
    ) {
      return await releaseForwardSync(
        ctx,
        job.connectionId,
        job.product === "calendar"
          ? "CALENDAR_WAITING_FOR_ACCOUNT"
          : "CHAT_WAITING_FOR_ACCOUNT",
      );
    }
    const { code, message } = classifyForwardSyncError(error);
    // Structured, and carrying no mail: an identifier, a code, and the name of
    // whatever was thrown.
    console.log(
      JSON.stringify({
        event: "google.forward_sync_failed",
        connectionId: job.connectionId,
        product: job.product,
        errorCode: code,
        errorName: error instanceof Error ? error.name : typeof error,
        gmailStatus: error instanceof GmailApiError ? error.status : undefined,
      }),
    );
    return await failForwardSync(ctx, job.connectionId, code, message);
  }
}

export async function runGoogleGmailBackfill(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  runId: Id<"googleSyncRuns">,
): Promise<Extract<OperationResult, { kind: "googleSyncRun" }>> {
  const job = await ctx.runQuery(internal.functions.googleConnect.googleGmailBackfillForRun, {
    workspaceId,
    runId,
  });
  if (job === null) {
    return {
      kind: "googleSyncRun",
      runId,
      status: "complete",
      totalUnits: 0,
      completedUnits: 0,
      itemsFound: 0,
      daysWithMail: 0,
      bytesWritten: 0,
      continue: false,
    };
  }

  await ctx.runMutation(internal.functions.googleConnect.stopGoogleGmailBackfillRun, {
    workspaceId,
    runId,
    errorCode: "GOOGLE_GMAIL_BACKFILL_DISABLED",
    message: "Historical Gmail imports are disabled. This account will sync new mail from its current position.",
  });
  return {
    kind: "googleSyncRun",
    runId,
    status: "failed",
    totalUnits: job.totalUnits,
    completedUnits: job.completedUnits,
    itemsFound: 0,
    daysWithMail: 0,
    bytesWritten: 0,
    continue: false,
  };
}
