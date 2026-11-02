/**
 * A new managed bucket, served on a temporary credential until its own key
 * answers.
 *
 * Signing up used to wait for Cloudflare to accept the bucket's freshly minted
 * key — up to two minutes (`R2_CREDENTIAL_SETTLE_MS`), the "taking time to set
 * up your account" the owner asked about (2026-10-28). R2's temporary
 * credentials work the moment they are issued (`lib/cloudflare/temporary.ts`),
 * so the binding is written with one beside the bucket's own key, the gateway
 * is handed it (`storage/credentialOpening.ts`), and `promoteManagedKey` clears
 * it once the bucket's own key has answered a probe.
 *
 * The bucket's own key stays in `accessKeyId` / `encryptedSecretAccessKey`
 * throughout, so every revoke and every "is this our token" check is
 * untouched. Issuing a temporary credential is best effort: on any failure the
 * binding is written as it always was, and verification waits out the key.
 */

import { v } from "convex/values";
import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx, MutationCtx, QueryCtx } from "../../../_generated/server";
import { storeForBinding } from "../../../../mcp/src/store/factory.js";
import { probeStore } from "../../../../mcp/src/store/index.js";
import {
  callerTokenId,
  createTemporaryR2Credential,
  TEMPORARY_CREDENTIAL_TTL_SECONDS,
} from "../cloudflare";
import { encryptSecret, requireKeyset } from "../crypto";
import type { GatewayCredential } from "../storage/shapes";

/** `SealedTemporaryCredential`, as an argument validator. */
export const sealedTemporaryValidator = v.optional(
  v.object({
    accessKeyId: v.string(),
    encryptedSecretAccessKey: v.string(),
    encryptedSessionToken: v.string(),
    until: v.number(),
  }),
);

/** What `applyBinding` takes as `temporary`: every part sealed. */
export interface SealedTemporaryCredential {
  accessKeyId: string;
  encryptedSecretAccessKey: string;
  encryptedSessionToken: string;
  until: number;
}

/** Every 10 seconds for the first two minutes, then every minute. */
export function nextPromotionDelayMs(attempt: number): number {
  return attempt < 12 ? 10_000 : 60_000;
}

/** Give up asking once the temporary credential has lapsed: the gateway is on the own key by then anyway. */
export function promotionStillWorthAsking(until: number | undefined, now: number): boolean {
  return until !== undefined && now < until;
}

/**
 * Issue and seal a temporary credential for `bucket`, or `null`.
 *
 * Never throws: the caller's fallback is the old wait, which is always safe.
 * Cloudflare's text is not logged, for the reason `provisionManagedStorage`
 * gives; the stage is.
 */
export async function issueTemporaryCredential(options: {
  apiToken: string;
  accountId: string;
  bucket: string;
  workspaceId: Id<"workspaces">;
}): Promise<SealedTemporaryCredential | null> {
  let stage = "verify";
  try {
    const parentAccessKeyId = await callerTokenId(options);
    stage = "issue";
    const issued = await createTemporaryR2Credential({
      apiToken: options.apiToken,
      accountId: options.accountId,
      bucket: options.bucket,
      parentAccessKeyId,
      ttlSeconds: TEMPORARY_CREDENTIAL_TTL_SECONDS,
    });
    stage = "seal";
    const keyset = requireKeyset();
    const context = { workspaceId: options.workspaceId };
    return {
      accessKeyId: issued.accessKeyId,
      encryptedSecretAccessKey: await encryptSecret(issued.secretAccessKey, keyset, context),
      encryptedSessionToken: await encryptSecret(issued.sessionToken, keyset, context),
      until: Date.now() + TEMPORARY_CREDENTIAL_TTL_SECONDS * 1000,
    };
  } catch {
    console.error("managed_storage.temporary_credential_failed", {
      workspaceId: options.workspaceId,
      stage,
    });
    return null;
  }
}

/**
 * Whether the bucket's own key now reads and writes, probed the way
 * verification probes. `credential` is the bucket's own key, opened by the
 * caller (the only module allowed to); it is used for this probe alone.
 */
export async function ownKeyAnswers(credential: GatewayCredential): Promise<boolean> {
  try {
    const store = storeForBinding(credential, undefined, { probeCapabilities: true });
    const probe = (await probeStore(store)) as { reachable?: boolean; writable?: boolean };
    return probe.reachable === true && probe.writable === true;
  } catch {
    return false;
  }
}

/** The binding as promotion needs it, still sealed. */
export async function promotionStanding(ctx: { db: QueryCtx["db"] }, workspaceId: Id<"workspaces">) {
  const binding = await ctx.db
    .query("storageBindings")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  if (binding === null || binding.temporaryAccessKeyId === undefined) return null;
  return binding;
}

/**
 * Stop handing out the temporary credential. Only the one that was probed
 * past: a binding rewritten meanwhile (a rebind, a move) is left alone.
 */
export async function clearTemporaryCredential(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces">; temporaryAccessKeyId: string },
): Promise<boolean> {
  const binding = await promotionStanding(ctx, args.workspaceId);
  if (binding === null || binding.temporaryAccessKeyId !== args.temporaryAccessKeyId) return false;
  await ctx.db.patch(binding._id, {
    temporaryAccessKeyId: undefined,
    encryptedTemporarySecretAccessKey: undefined,
    encryptedSessionToken: undefined,
    temporaryUntil: undefined,
    updatedAt: Date.now(),
  });
  return true;
}

/** What `temporaryKeyStanding` answers: the bucket's own key, still sealed, and what to probe it with. */
export async function temporaryKeyStandingHandler(ctx: { db: QueryCtx["db"] }, workspaceId: Id<"workspaces">) {
  const binding = await promotionStanding(ctx, workspaceId);
  if (
    binding === null ||
    binding.temporaryAccessKeyId === undefined ||
    !binding.endpoint ||
    !binding.bucket ||
    !binding.accessKeyId ||
    !binding.encryptedSecretAccessKey
  ) {
    return null;
  }
  return {
    temporaryAccessKeyId: binding.temporaryAccessKeyId,
    until: binding.temporaryUntil,
    encryptedSecretAccessKey: binding.encryptedSecretAccessKey,
    credential: {
      provider: "r2" as const,
      endpoint: binding.endpoint,
      region: binding.region ?? "auto",
      bucket: binding.bucket,
      accessKeyId: binding.accessKeyId,
      forcePathStyle: binding.forcePathStyle,
      capabilities: binding.capabilities,
      status: binding.status,
    },
  };
}

/** Ask again later, or stop once the temporary credential has lapsed. */
export async function schedulePromotion(
  ctx: Pick<ActionCtx, "scheduler"> | Pick<MutationCtx, "scheduler">,
  args: { workspaceId: Id<"workspaces">; attempt: number; until: number | undefined },
): Promise<void> {
  const delay = nextPromotionDelayMs(args.attempt);
  if (!promotionStillWorthAsking(args.until, Date.now() + delay)) return;
  await ctx.scheduler.runAfter(delay, internal.functions.managedProvisioning.promoteManagedKey, {
    workspaceId: args.workspaceId,
    attempt: args.attempt,
  });
}
