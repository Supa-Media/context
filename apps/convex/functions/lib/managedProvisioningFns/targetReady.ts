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
import { R2_CREDENTIAL_SETTLE_MS } from "../cloudflare";
import { MANAGED_STORAGE_SETTLE_POLL_MS } from "./constants";
import type { StorageCapabilities } from "../storage/shapes";
import { summarizeProbe, type ProbeResult } from "../verification";

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
    migrationTargetCredential(migration, secretAccessKey),
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
 * What the destination can do, asked at the switch-over so the new binding
 * can be `connected` from its first second (see `migrationFinish.ts`).
 *
 * Absent when the bucket did not answer, or would not take a write: then the
 * switch-over leaves the binding for the ordinary verification to decide, as
 * it always did. Never throws: a failed probe must not fail a finished copy.
 */
export async function probeCutoverCapabilities(
  migration: Doc<"managedStorageMigrations">,
  secretAccessKey: string,
): Promise<StorageCapabilities | undefined> {
  try {
    const target = storeForBinding(
      migrationTargetCredential(migration, secretAccessKey),
      undefined,
      { probeCapabilities: true },
    );
    const summary = summarizeProbe((await probeStore(target)) as unknown as ProbeResult, {
      bucket: migration.targetBucket,
    });
    return summary.ok ? summary.capabilities : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a customer destination already holds anything at all.
 *
 * Asked once, before the first write of a move out of managed storage: the
 * move's final pass makes the destination match the source, and in a bucket
 * that already held the customer's own files that would delete them. So a
 * destination with anything in it — under the chosen root prefix, which is all
 * this store can see — is refused rather than reconciled. Raw listing, so
 * Context's own plumbing under `.context/` counts too; `probeStore` removes its
 * scratch object before this is asked.
 */
export async function destinationHoldsObjects(
  migration: Doc<"managedStorageMigrations">,
  secretAccessKey: string,
): Promise<boolean> {
  const target = storeForBinding(
    migrationTargetCredential(migration, secretAccessKey),
    undefined,
    { rawObjects: true },
  );
  const page = await target.list({ limit: 1 });
  return page.objects.length > 0;
}

/** The slice of a store `clearDestination` uses. */
export interface ClearableStore {
  list(options: { limit?: number }): Promise<{ objects: { key: string }[]; truncated?: boolean }>;
  delete(key: string): Promise<unknown>;
}

/**
 * Where a start-fresh clear got to: the bucket is empty; this run's budget ran
 * out with files still there, and the caller comes back for the rest before
 * claiming it; or a listing came back unchanged after every file on it was
 * deleted (object lock, a retention rule, a key that may not delete), so
 * coming back would only repeat it.
 */
export type ClearOutcome = "empty" | "more" | "stuck";

/**
 * Empty a destination the owner agreed to start fresh in, up to a budget.
 *
 * Always lists from the start: every listed object is deleted, so the first
 * page is the next one, and a continuation token would name a listing that no
 * longer exists.
 */
export async function clearDestination(
  store: ClearableStore,
  budget: { pageSize: number; maxPages: number },
): Promise<ClearOutcome> {
  let previous: string | undefined;
  for (let page = 0; page < budget.maxPages; page += 1) {
    const listed = await store.list({ limit: budget.pageSize });
    if (listed.objects.length === 0) return "empty";
    const keys = listed.objects.map((object) => object.key).join("\n");
    if (keys === previous) return "stuck";
    previous = keys;
    for (let start = 0; start < listed.objects.length; start += CLEAR_WAVE_WIDTH) {
      await Promise.all(
        listed.objects.slice(start, start + CLEAR_WAVE_WIDTH).map((object) => store.delete(object.key)),
      );
    }
  }
  return (await store.list({ limit: 1 })).objects.length === 0 ? "empty" : "more";
}

const CLEAR_WAVE_WIDTH = 16;

/** `clearDestination` against a parked customer destination, raw. */
export async function clearMigrationTarget(
  migration: Doc<"managedStorageMigrations">,
  secretAccessKey: string,
): Promise<ClearOutcome> {
  const target = storeForBinding(
    migrationTargetCredential(migration, secretAccessKey),
    undefined,
    { rawObjects: true },
  ) as unknown as ClearableStore;
  return await clearDestination(target, { pageSize: 1000, maxPages: 20 });
}

/**
 * A start-fresh clear that did not finish never claims the bucket: nothing is
 * copied into one that still holds the owner's old files.
 */
export async function afterUnfinishedClear(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  cleared: Exclude<ClearOutcome, "empty">,
): Promise<{ ready: false }> {
  if (cleared === "stuck") {
    // Deleting did nothing, so neither would another run; the owner is told.
    await ctx.runMutation(
      internal.functions.managedProvisioning.failManagedStorageMigration,
      { workspaceId, errorCode: "DESTINATION_NOT_CLEARED" },
    );
    return { ready: false };
  }
  // More than one run can delete. This run made progress, so the next gets a
  // fresh window rather than this one's remainder.
  const retryUntil = Date.now() + R2_CREDENTIAL_SETTLE_MS;
  await ctx.scheduler.runAfter(
    0,
    internal.functions.managedProvisioning.awaitManagedTargetReady,
    { workspaceId, retryUntil },
  );
  return { ready: false };
}

/** The parked target in the ordinary gateway shape, in either direction. */
export function migrationTargetCredential(
  migration: Doc<"managedStorageMigrations">,
  secretAccessKey: string,
) {
  return {
    provider: migration.targetProvider ?? ("r2" as const),
    endpoint: migration.targetEndpoint,
    region: migration.targetRegion ?? "auto",
    bucket: migration.targetBucket,
    rootPrefix: migration.targetRootPrefix,
    accessKeyId: migration.targetAccessKeyId,
    secretAccessKey,
    forcePathStyle: migration.targetForcePathStyle,
    capabilities: { conditionalWrite: true },
    status: "connected" as const,
  };
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
