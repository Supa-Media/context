/**
 * THE FIRST-CONNECT GMAIL IMPORT: the fifty most recent messages, once.
 *
 * Owner decision, 2026-10-17: when somebody connects Gmail, Tex reads their
 * last fifty emails to get to know them. This is the pass that does it. It is
 * not the historical backfill #388 removed, and it does not re-enable it:
 * `runGoogleGmailBackfill` still refuses every run with
 * `GOOGLE_GMAIL_BACKFILL_DISABLED`, and `startGoogleSyncRun` still answers
 * `GOOGLE_SYNC_FORWARD_ONLY`. Nobody can ask for this — not a window, not "sync
 * more", not a second time. The connect marks it (`googleConnect/binding.ts`),
 * the forward pass runs it on Gmail's turn, and the row records it done.
 *
 * Like every Google pass it runs inside `runFileOperation`, the one credential
 * barrier, against the store that function built; the access token is minted
 * by `runGoogleForwardSync` and is never written anywhere. The argument, and
 * what reversing any of it costs, is in
 * `docs/decisions/communications/gmail-and-sync-loop.md`, "A first connect
 * reads the last fifty messages, and that is not a backfill".
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { getProfileHistoryId, runRecentImport } from "../../../../mcp/src/communications/gmailSync.js";
import type { FileStore } from "../fileOps";
import {
  classifyForwardSyncError,
  logForwardSyncFailure,
  type ForwardSyncJob,
  type ForwardSyncResult,
  timeoutFetch,
} from "./forwardSyncSupport";

type GmailJob = Extract<ForwardSyncJob, { kind: "run"; product: "gmail" }>;

/**
 * Read the fifty, write the days they land on, and end the import.
 *
 * **The cursor is left to the forward pass.** A connect already stored one;
 * a row without one takes its baseline here *before* reading, so mail that
 * lands while the import runs is behind the cursor and on a day the next pass
 * rebuilds anyway — never in neither.
 *
 * **A failure spends one attempt and is caught here**, not by the forward
 * pass's handler, so the row can count it: an import that can never succeed
 * is given up after `RECENT_IMPORT_MAX_ATTEMPTS` and Gmail syncs forward
 * without it. A retry writes nothing it already wrote: every day is rebuilt
 * from Gmail's live state, the same bytes the forward pass writes.
 */
export async function runGmailRecentImport(
  ctx: ActionCtx,
  store: FileStore,
  job: GmailJob,
  accessToken: string,
): Promise<ForwardSyncResult> {
  let baseline: string | undefined;
  let result: Awaited<ReturnType<typeof runRecentImport>>;
  try {
    baseline =
      job.historyId === undefined
        ? await getProfileHistoryId({ fetchImpl: timeoutFetch, accessToken })
        : undefined;
    result = await runRecentImport({
      store,
      fetchImpl: timeoutFetch,
      accessToken,
      mailboxSlug: job.mailboxSlug,
      address: job.address,
      folders: job.folders,
      folder: job.destinationFolder,
      // The forward pass's nonce, so an imported day and the same day
      // rewritten by a later pass keep one set of message anchors.
      nonce: `gmail:${job.connectionId}`,
      quotaBytes: job.quotaBytes,
      bytesAlreadyUsed: job.bytesAlreadyUsed,
      attachmentMode: job.attachmentMode,
      attachmentRetentionDays: job.attachmentRetentionDays,
    });
  } catch (error) {
    const { code, message } = classifyForwardSyncError(error);
    logForwardSyncFailure(job, code, error);
    await ctx.runMutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
      connectionId: job.connectionId,
      product: "gmail",
      status: "failed",
      errorCode: code,
      error: message,
      recentImport: { outcome: "failed" },
    });
    return failed(job, 0, 0, code);
  }

  if (result.quotaExceeded) {
    // What fit is written and counted. The import is over either way: the
    // quota that stopped it stops the forward pass too, and is the row's
    // failure to show, not a reason to read the fifty again.
    await ctx.runMutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
      connectionId: job.connectionId,
      product: "gmail",
      status: "failed",
      daysTouched: result.daysWritten,
      bytesWritten: result.bytesWritten,
      errorCode: "MAIL_QUOTA_EXCEEDED",
      error: "This connection reached its storage quota before the pass finished.",
      recentImport: { outcome: "done", messages: result.itemsFound },
    });
    return failed(job, result.daysWritten, result.bytesWritten, "MAIL_QUOTA_EXCEEDED");
  }

  await ctx.runMutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
    connectionId: job.connectionId,
    product: "gmail",
    status: "synced",
    ...(baseline === undefined ? {} : { historyId: baseline }),
    daysTouched: result.daysWritten,
    bytesWritten: result.bytesWritten,
    // An empty mailbox read nothing, and the console must be able to say so.
    baseline: result.itemsFound === 0,
    recentImport: { outcome: "done", messages: result.itemsFound },
  });
  return {
    kind: "googleForwardSync",
    connectionId: job.connectionId,
    status: "synced",
    daysTouched: result.daysWritten,
    bytesWritten: result.bytesWritten,
    cursorAdvanced: baseline !== undefined,
    gapDetected: false,
    truncated: false,
  };
}

function failed(job: GmailJob, daysTouched: number, bytesWritten: number, errorCode: string): ForwardSyncResult {
  return {
    kind: "googleForwardSync",
    connectionId: job.connectionId,
    status: "failed",
    daysTouched,
    bytesWritten,
    cursorAdvanced: false,
    gapDetected: false,
    truncated: false,
    errorCode,
  };
}
