import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { definedOnly, type ForwardSyncProduct, type ForwardSyncResult } from "./forwardSyncSupport";

/*
 * How a forward pass that did not sync is recorded on its connection: skipped
 * (nothing to do, claim released) or failed (why, in words a person can act
 * on, and for a rate limit which call met it and when Google said it lifts).
 */

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
  /** The product whose turn this was, when one was chosen. */
  product?: ForwardSyncProduct,
): Promise<ForwardSyncResult> {
  await ctx.runMutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
    connectionId,
    status: "skipped",
    errorCode: reason,
    ...(product === undefined ? {} : { product }),
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
  /** The product whose turn failed, so its siblings get the next one. */
  product?: ForwardSyncProduct,
  detail: { errorReason?: string; errorCall?: string; errorRetryAfterAt?: number } = {},
): Promise<ForwardSyncResult> {
  await ctx.runMutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
    connectionId,
    status: "failed",
    errorCode,
    error,
    ...(product === undefined ? {} : { product }), ...definedOnly(detail),
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
