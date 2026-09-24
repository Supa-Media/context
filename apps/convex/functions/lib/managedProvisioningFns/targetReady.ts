/**
 * The probe and post-probe logic behind `managedProvisioning.awaitManagedTargetReady`,
 * split from the `decryptSecret` call that must stay in
 * `functions/managedProvisioning.ts` — see that file's header, and
 * `__tests__/structure.test.ts`, which enumerates exactly which modules may
 * import `decryptSecret` at all. This module takes the already-opened target
 * secret as a plain argument and never imports the decrypt itself.
 *
 * Split out of `functions/managedProvisioning.ts` — see that file's header
 * comment on `provisionManagedStorage` for the whole flow this belongs to,
 * and `awaitManagedTargetReady`'s own doc comment there for why this polls
 * rather than letting the copy fail and be retried.
 */

import { internal } from "../../../_generated/api";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { storeForBinding } from "../../../../mcp/src/store/factory.js";
import { probeStore } from "../../../../mcp/src/store/index.js";
import { MANAGED_STORAGE_SETTLE_POLL_MS } from "./constants";

/**
 * `probeStore` is the same probe `verifyStorageBinding` runs against a pasted
 * credential — one listing, one write, one read, cleaned up after itself,
 * under `.context/`, never note surface. Running the same readiness question
 * on both paths is the point; a managed bucket is not a special kind of
 * bucket.
 */
export async function probeManagedTarget(
  migration: Doc<"managedStorageMigrations">,
  secretAccessKey: string,
): Promise<boolean> {
  const target = storeForBinding(
    {
      provider: "r2",
      endpoint: migration.targetEndpoint,
      region: "auto",
      bucket: migration.targetBucket,
      accessKeyId: migration.targetAccessKeyId,
      secretAccessKey,
      capabilities: { conditionalWrite: true },
      status: "connected",
    },
    undefined,
    { probeCapabilities: true },
  );
  const probe = await probeStore(target);
  // Not `probe.ok`: that folds in conditional-write verification, which is
  // a question about the binding and is asked at cutover by the ordinary
  // verification `applyBinding` schedules. What the copy needs to start is
  // narrower and is exactly these two.
  return probe.reachable === true && probe.writable === true;
}

/**
 * What happens once the probe has answered (or failed to open the envelope).
 * Ready starts the copy; not ready retries until the deadline, then fails the
 * migration with a code of ours.
 */
export async function finishAwaitManagedTargetReady(
  ctx: ActionCtx,
  args: { workspaceId: Id<"workspaces">; retryUntil: number },
  migration: Doc<"managedStorageMigrations">,
  ready: boolean,
): Promise<{ ready: boolean }> {
  if (ready) {
    await ctx.scheduler.runAfter(
      0,
      internal.functions.managedProvisioning.runManagedStorageMigration,
      { workspaceId: args.workspaceId },
    );
    return { ready: true };
  }

  const remaining = args.retryUntil - Date.now();
  if (remaining > 0) {
    // Hoisted rather than inlined into the call: `structure.test.ts` reads
    // scheduled targets positionally, and a nested call in the delay slot
    // hides from it what was queued.
    const delay = Math.min(MANAGED_STORAGE_SETTLE_POLL_MS, remaining);
    await ctx.scheduler.runAfter(
      delay,
      internal.functions.managedProvisioning.awaitManagedTargetReady,
      args,
    );
    return { ready: false };
  }

  console.error("managed_storage.target_not_ready", {
    workspaceId: args.workspaceId,
    bucket: migration.targetBucket,
  });
  await ctx.runMutation(
    internal.functions.managedProvisioning.failManagedStorageMigration,
    { workspaceId: args.workspaceId, errorCode: "TARGET_NOT_READY" },
  );
  return { ready: false };
}
