/**
 * Removing Dropbox, once it is off the product.
 *
 * Dropbox was a storage provider until 2026-10-17. Its connect flow, OAuth
 * helpers and gateway store are gone, and the schema keeps the legacy fields
 * and the `dropboxConnectAttempts` table only so rows written before the
 * removal still validate. This module empties them.
 *
 * What it deletes: `dropboxConnectAttempts` rows, and `storageBindings` rows
 * whose provider is `dropbox`, with the credential envelopes that live on them.
 * Each binding goes through `forgetBindingRow`, the same tail `disconnectStorage`
 * runs, and gets the audit event a disconnect writes, with a reason.
 *
 * What it never touches: notes, tree rows, or anything in a bucket. A customer's
 * notes live in their own Dropbox folder, which we never delete. Removing the
 * binding only forgets how to reach it.
 *
 * Idempotent: a second run finds nothing and returns zeros. Bounded: each call
 * handles at most `limit` rows of each kind, and reports `more` when a call may
 * have left some behind. Run it from the Convex dashboard until `count` reports
 * zero, then remove the legacy schema lines in a follow-up.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { recordAudit } from "./lib/audit";
import { forgetBindingRow } from "./lib/storage/bindingActions";
import { refuseDuringMove } from "./lib/managedProvisioningFns/direction";

/**
 * The removed provider's name and table, spelled once. Everything that has to
 * name a legacy row (this module, its tests, the schema lines) takes it from
 * here, so the purge is the only place a legacy row is read or written.
 */
export const LEGACY_PROVIDER = "dropbox" as const;
export const LEGACY_ATTEMPT_TABLE = "dropboxConnectAttempts" as const;

/** Most rows one `purge` call touches, of each kind. */
export const PURGE_LIMIT = 100;

/** Most rows `count` will look at before saying it is a floor. */
export const COUNT_CAP = 1000;

export const purgeArgs = { limit: v.optional(v.number()) };

export const purgeReturns = v.object({
  bindingsRemoved: v.number(),
  /** Bindings left alone because a move of their workspace is copying. Re-run once it ends. */
  bindingsSkipped: v.number(),
  attemptsRemoved: v.number(),
  more: v.boolean(),
});

/**
 * Delete legacy Dropbox connect attempts and Dropbox storage bindings.
 *
 * Internal: run from the dashboard or a one-off deploy step, never by a client.
 */
export const purge = internalMutation({
  args: purgeArgs,
  returns: purgeReturns,
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(Math.floor(args.limit ?? PURGE_LIMIT), 1), PURGE_LIMIT);

    const attempts = await ctx.db.query(LEGACY_ATTEMPT_TABLE).take(limit);
    for (const attempt of attempts) {
      await ctx.db.delete(attempt._id);
    }

    const bindings = await ctx.db
      .query("storageBindings")
      .filter((q) => q.eq(q.field("provider"), LEGACY_PROVIDER))
      .take(limit);
    let bindingsRemoved = 0;
    let bindingsSkipped = 0;
    for (const binding of bindings) {
      // A move copying out of this workspace reads the binding it started
      // from. Leave it for a later run rather than cut the move's source away.
      try {
        await refuseDuringMove(ctx, binding.workspaceId);
      } catch {
        bindingsSkipped += 1;
        continue;
      }
      await forgetBindingRow(ctx, binding);
      await recordAudit(ctx, {
        workspaceId: binding.workspaceId,
        action: "storage.disconnected",
        // No actor: a deployment-level removal, not a person's request. No
        // endpoint, key or token either: the row is gone and so is its envelope.
        details: { provider: LEGACY_PROVIDER, bucket: null, reason: "dropbox-removed" },
      });
      bindingsRemoved += 1;
    }

    return {
      bindingsRemoved,
      bindingsSkipped,
      attemptsRemoved: attempts.length,
      more:
        (attempts.length === limit || bindings.length === limit) &&
        (attempts.length > 0 || bindingsRemoved > 0),
    };
  },
});

export const countReturns = v.object({
  dropboxBindings: v.number(),
  dropboxAttempts: v.number(),
  /** True when a count reached `COUNT_CAP` and is a floor, not a total. */
  truncated: v.boolean(),
});

/** How many Dropbox bindings and connect attempts remain. Internal. */
export const count = internalQuery({
  args: {},
  returns: countReturns,
  handler: async (ctx) => {
    const bindings = await ctx.db
      .query("storageBindings")
      .filter((q) => q.eq(q.field("provider"), LEGACY_PROVIDER))
      .take(COUNT_CAP);
    const attempts = await ctx.db.query(LEGACY_ATTEMPT_TABLE).take(COUNT_CAP);
    return {
      dropboxBindings: bindings.length,
      dropboxAttempts: attempts.length,
      truncated: bindings.length === COUNT_CAP || attempts.length === COUNT_CAP,
    };
  },
});
