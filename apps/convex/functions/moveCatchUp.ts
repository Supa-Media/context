/**
 * The passes after a storage move switches over.
 *
 * What they do and the rule they keep are in `lib/moveCatchUp.ts`. This module
 * is the part that holds a key: it opens the old bucket's sealed secret for one
 * listed page at a time, which is why it is on the short list of modules that
 * may import `decryptSecret` (`__tests__/structure/fixtures.helpers.ts`).
 *
 * What bounds that:
 *
 *  - The envelope travels in the scheduled arguments, sealed, the way the
 *    Dropbox funeral carries its grant, and exists only for the passes: the
 *    last one is thirty minutes after the switch, and nothing reschedules it.
 *    No table holds it, so no row outlives the work.
 *  - The old bucket is only ever read. Every write goes to the workspace's
 *    current binding, create-only, and only while that binding is still the
 *    one the move switched to. A workspace that moved again, disconnected, or
 *    was deleted stops the passes on their next run.
 *  - Nothing it logs names a file, a bucket or a key: counts only.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, internalQuery } from "../_generated/server";
import { decryptSecret, requireKeyset } from "./lib/crypto";
import { storeForBinding } from "../../mcp/src/store/factory.js";
import { catchUpPage, type CatchUpStore } from "./lib/moveCatchUp";
import { keptManagedBucketOption, managedEncryptionOption } from "./lib/managedEncryptionFns/storeOption";
import {
  CATCH_UP_PASS_DELAYS_MS,
  MIGRATION_OBJECT_BYTE_CAP,
  MIGRATION_PAGE_SIZE,
  MIGRATION_WAVE_BYTE_BUDGET,
  MIGRATION_WAVE_WIDTH,
} from "./lib/managedProvisioningFns/constants";
import { providerValidator } from "./lib/storage/shapes";

/** The old binding as it stood at the switch, its secret still sealed. */
const sourceSnapshotValidator = v.object({
  provider: providerValidator,
  endpoint: v.string(),
  region: v.string(),
  bucket: v.string(),
  rootPrefix: v.optional(v.string()),
  accessKeyId: v.string(),
  encryptedSecretAccessKey: v.string(),
  forcePathStyle: v.optional(v.boolean()),
});

const catchUpArgs = {
  workspaceId: v.id("workspaces"),
  /** The binding the move switched to. Any other binding ends the passes. */
  targetBindingId: v.id("storageBindings"),
  /** Old-bucket files changed at or after this are read; see the margin. */
  since: v.number(),
  cutoverAt: v.number(),
  /**
   * Which way the move went. Out of managed storage, the old bucket is the
   * managed one, and once managed encryption exists its objects must be read
   * through it, as the move's own source is: a raw read would carry
   * ciphertext into the customer's bucket.
   */
  direction: v.union(v.literal("to_customer"), v.literal("to_managed")),
  /** Index into `CATCH_UP_PASS_DELAYS_MS`. */
  pass: v.number(),
  /** Where this pass has listed up to, when it spans several runs. */
  cursor: v.optional(v.string()),
  source: sourceSnapshotValidator,
};

/** One listed page of one pass, then the next page or the next pass. */
export const runMoveCatchUp = internalAction({
  args: catchUpArgs,
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const log = (event: string, details: Record<string, unknown> = {}) =>
      console.log(`storage.move_catchup.${event}`, {
        workspaceId: args.workspaceId,
        pass: args.pass,
        ...details,
      });
    const current: string | null = await ctx.runQuery(
      internal.functions.moveCatchUp.currentBindingId,
      { workspaceId: args.workspaceId },
    );
    if (current !== args.targetBindingId) {
      log("stopped", { reason: "binding_changed" });
      return null;
    }

    const nextPass = async () => {
      const pass = args.pass + 1;
      if (pass >= CATCH_UP_PASS_DELAYS_MS.length) {
        log("finished");
        return;
      }
      // Hoisted: the structure test reads a scheduled call's slots by position.
      const at = Math.max(Date.now(), args.cutoverAt + CATCH_UP_PASS_DELAYS_MS[pass]!);
      await ctx.scheduler.runAt(
        at,
        internal.functions.moveCatchUp.runMoveCatchUp,
        { ...args, pass, cursor: undefined },
      );
    };

    let truncated = false;
    let cursor: string | undefined;
    try {
      const targetCredential = await ctx.runAction(
        internal.functions.storage.getBindingForGateway,
        { workspaceId: args.workspaceId },
      );
      // Not connected yet, or gone: the next pass asks again.
      if (targetCredential === null) {
        log("skipped", { reason: "target_unavailable" });
        await nextPass();
        return null;
      }
      const { encryptedSecretAccessKey, ...sourceFields } = args.source;
      const secretAccessKey = await decryptSecret(encryptedSecretAccessKey, requireKeyset(), {
        workspaceId: args.workspaceId,
      });
      const source = storeForBinding(
        {
          ...sourceFields,
          secretAccessKey,
          capabilities: { conditionalWrite: true },
          status: "connected" as const,
        },
        undefined,
        {
          rawObjects: true,
          // The managed bucket a workspace just left may hold sealed files.
          // Its mode comes from the encryption row, not the binding (which is
          // the customer's now), so late files arrive plain, never sealed.
          managedEncryption:
            args.direction === "to_customer" ? await keptManagedBucketOption(ctx, args.workspaceId) : null,
        },
      ) as unknown as CatchUpStore;
      const target = storeForBinding(targetCredential, undefined, {
        rawObjects: true,
        // Moving back in, the destination is the managed bucket, which may
        // already be encrypted again: late files are sealed on the way in.
        managedEncryption: await managedEncryptionOption(ctx, args.workspaceId),
      }) as unknown as CatchUpStore;

      const page = await source.list({ cursor: args.cursor, limit: MIGRATION_PAGE_SIZE });
      const counts = await catchUpPage({
        source,
        target,
        objects: page.objects,
        since: args.since,
        byteCap: MIGRATION_OBJECT_BYTE_CAP,
        maxWidth: MIGRATION_WAVE_WIDTH,
        byteBudget: MIGRATION_WAVE_BYTE_BUDGET,
      });
      log("page", { listed: page.objects.length, ...counts });
      truncated = page.truncated && page.cursor !== undefined && page.cursor !== args.cursor;
      cursor = page.cursor;
    } catch (error) {
      // The old bucket stopped answering, or its key would not open. Nothing
      // was written for a page that failed before its reads; the next pass
      // lists again from the start.
      log("page_failed", { error: error instanceof Error ? error.name : "unknown" });
      await nextPass();
      return null;
    }

    if (truncated) {
      await ctx.scheduler.runAfter(0, internal.functions.moveCatchUp.runMoveCatchUp, {
        ...args,
        cursor,
      });
      return null;
    }
    await nextPass();
    return null;
  },
});

/** The workspace's binding id right now, or null when it has none. */
export const currentBindingId = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(v.null(), v.id("storageBindings")),
  handler: async (ctx, args) => {
    const binding = await ctx.db
      .query("storageBindings")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();
    return binding?._id ?? null;
  },
});
