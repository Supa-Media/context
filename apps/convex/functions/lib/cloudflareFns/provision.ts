/**
 * The body of `cloudflare.provisionCloudflareStorage`, split from the
 * `decryptSecret` call that must stay in `functions/cloudflare.ts` — see that
 * file's header, and `__tests__/structure.test.ts`, which enumerates exactly
 * which modules may import `decryptSecret` at all. Everything here runs
 * *after* the setup credential has already been opened, and takes it as a
 * plain argument rather than opening it itself, so this module never needs
 * that import.
 *
 * Split out of `functions/cloudflare.ts` — see that file's header for the
 * whole flow this belongs to and the credential-handling rules it follows.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { redactSecrets } from "../verification";
import { encryptSecret, requireKeyset } from "../crypto";
import { addressingIsAmbiguous } from "../../storage";
import {
  CloudflareApiError,
  R2_BUCKET_WRITE_PERMISSION_GROUP,
  bucketCreatedDuringAttempt,
  bucketNotOursMessage,
  createBucketScopedToken,
  createR2Bucket,
  deriveS3SecretAccessKey,
  getR2Bucket,
  provisionFailureMessage,
  r2Endpoint,
  resolvePermissionGroupId,
  revokeApiToken,
  scopedTokenName,
  type ProvisionErrorCode,
  type ProvisionStage,
} from "../cloudflare";
import { DETAIL_WRAPPER_LENGTH, MAX_RECORDED_ERROR_LENGTH, MIN_DETAIL_LENGTH, truncated, type ProvisionOutcome } from "./constants";
import type { ProvisioningJob } from "./jobRead";

/**
 * Record a failure and compose its message: our sentence, then what the
 * stage says is left in the customer's account, then Cloudflare's own detail
 * trimmed to what room remains. One composer so the recorded text and the
 * classification cannot disagree — see `provisionFailureMessage`.
 */
export async function recordProvisionFailure(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  job: ProvisioningJob,
  secrets: string[],
  stage: ProvisionStage,
  tokenRevoked: boolean,
  errorCode: ProvisionErrorCode,
  message: string,
  detail: string,
): Promise<ProvisionOutcome> {
  // Our two sentences first — what went wrong, and what that left in the
  // customer's account — with Cloudflare's detail trimmed to the room that
  // remains. The other order truncates the half a person acts on.
  const ours = provisionFailureMessage({
    message,
    stage,
    errorCode,
    bucket: job.bucket,
    tokenRevoked,
  });
  const room = MAX_RECORDED_ERROR_LENGTH - ours.length - DETAIL_WRAPPER_LENGTH;
  const text =
    detail.length > 0 && room >= MIN_DETAIL_LENGTH
      ? `${ours} (Cloudflare: ${truncated(detail, room)})`
      : ours;
  const scrubbed = redactSecrets(text, secrets);
  await ctx.runMutation(internal.functions.cloudflare.failProvisioning, {
    workspaceId,
    errorCode,
    error: truncated(scrubbed, MAX_RECORDED_ERROR_LENGTH),
  });
  return { ok: false, errorCode };
}

/**
 * Create the bucket, mint the key, bind it, and forget the setup credential —
 * everything `provisionCloudflareStorage` does once it already holds the
 * opened setup credential. See that function's own doc comment in
 * `functions/cloudflare.ts` for the numbered properties this preserves.
 */
export async function runProvisionAttempt(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  job: ProvisioningJob,
  setupCredential: string,
  secrets: string[],
): Promise<ProvisionOutcome> {
  /**
   * Which call is in flight.
   *
   * The single most important variable in this function. Every recorded
   * failure is composed from it, because "Cloudflare refused" means nothing
   * was created at one stage and means a bucket now exists in somebody's
   * account at the next — and the message that got this wrong was the one
   * that told people to try again with a name we had just taken.
   */
  let stage: ProvisionStage = "resolve-permission-group";
  /** Set once the mint returns, so a later failure can try to take it back. */
  let mintedTokenId: string | undefined;
  /** Whether taking it back worked. Only ever narrows what we claim exists. */
  let tokenRevoked = false;

  const fail = (
    errorCode: ProvisionErrorCode,
    message: string,
    detail: string,
  ): Promise<ProvisionOutcome> =>
    recordProvisionFailure(ctx, workspaceId, job, secrets, stage, tokenRevoked, errorCode, message, detail);

  /**
   * Is the bucket that already exists one an earlier run of *this* attempt
   * created?
   *
   * Asked only when the create call comes back `BUCKET_NAME_TAKEN`, and
   * answered from Cloudflare's own record of when the bucket was made rather
   * than from anything we remember — see `bucketCreatedDuringAttempt`. A
   * failure to ask is a `false`: the direction this must fail in is "leave
   * the customer's own bucket alone", and the cost of being wrong that way is
   * a message telling them to pick another name.
   */
  const bucketBelongsToThisAttempt = async (): Promise<boolean> => {
    try {
      const details = await getR2Bucket({
        apiToken: setupCredential,
        accountId: job.accountId,
        bucket: job.bucket,
        jurisdiction: job.jurisdiction,
      });
      return bucketCreatedDuringAttempt({
        creationDate: details.creationDate,
        attemptStartedAt: job.createdAt,
      });
    } catch {
      return false;
    }
  };

  try {
    // By name, at runtime. Only the read group's id is published, and a
    // hardcoded id would be a guess about what a token is allowed to do.
    const permissionGroupId = await resolvePermissionGroupId({
      apiToken: setupCredential,
      accountId: job.accountId,
      name: R2_BUCKET_WRITE_PERMISSION_GROUP,
    });

    stage = "create-bucket";
    let reusedExistingBucket = false;
    try {
      await createR2Bucket({
        apiToken: setupCredential,
        accountId: job.accountId,
        bucket: job.bucket,
        jurisdiction: job.jurisdiction,
        locationHint: job.locationHint,
      });
    } catch (error) {
      if (
        !(error instanceof CloudflareApiError) ||
        error.errorCode !== "BUCKET_NAME_TAKEN"
      ) {
        throw error;
      }
      // A NAME THAT IS TAKEN IS ONLY A DEAD END IF THE BUCKET IS NOT OURS.
      //
      // The expected failure of this flow is a token that may create buckets
      // but may not mint tokens (see open question 3 in `lib/cloudflare.ts`):
      // the bucket is created, the mint is refused, and the honest recovery —
      // fix the permission, press try again — used to land here and be told
      // to choose a different name because of a bucket we had just made for
      // them. So a taken name is a question rather than a verdict, and the
      // question is answered by Cloudflare: was this bucket created after
      // this attempt began?
      if (!(await bucketBelongsToThisAttempt())) {
        return await fail(
          "BUCKET_NAME_TAKEN",
          bucketNotOursMessage(job.bucket),
          error.detail,
        );
      }
      reusedExistingBucket = true;
    }

    stage = "mint-token";
    const minted = await createBucketScopedToken({
      apiToken: setupCredential,
      accountId: job.accountId,
      bucket: job.bucket,
      jurisdiction: job.jurisdiction,
      permissionGroupId,
      name: scopedTokenName(job.bucket),
    });
    // The minted value is itself a Cloudflare API token. It is never stored:
    // what goes in the row is its SHA-256, which is what R2's S3 API expects
    // as the secret access key and cannot be turned back into a token.
    secrets.push(minted.value);
    // Recorded locally the moment it exists, so the catch below can delete a
    // token that nothing else in this system knows about.
    mintedTokenId = minted.id;

    stage = "store-binding";
    const secretAccessKey = await deriveS3SecretAccessKey(minted.value);
    const endpoint = r2Endpoint(job.accountId, job.jurisdiction);
    const encryptedSecretAccessKey = await encryptSecret(
      secretAccessKey,
      requireKeyset(),
      { workspaceId },
    );

    await ctx.runMutation(internal.functions.cloudflare.completeProvisioning, {
      workspaceId,
      actorUserId: job.requestedBy,
      endpoint,
      bucket: job.bucket,
      accessKeyId: minted.id,
      encryptedSecretAccessKey,
      // R2's S3 endpoint is path-style and its first host label is the
      // account id, so this is unset for every ordinary bucket — the same
      // thing a manual connect stores. It only has an answer when the bucket
      // is named after the account, which nothing can otherwise resolve.
      forcePathStyle: addressingIsAmbiguous(endpoint, job.bucket) ? true : undefined,
      reusedExistingBucket,
    });
    return { ok: true };
  } catch (error) {
    // Anything that fails after the mint leaves a live R2 token in the
    // customer's account whose id exists nowhere but this stack frame — the
    // one credential this flow can create and then lose. Take it back if
    // Cloudflare will let us, and say so plainly if it will not.
    if (stage === "store-binding" && mintedTokenId !== undefined) {
      tokenRevoked = await revokeApiToken({
        apiToken: setupCredential,
        accountId: job.accountId,
        tokenId: mintedTokenId,
      });
    }
    if (error instanceof CloudflareApiError) {
      return await fail(error.errorCode, error.message, error.detail);
    }
    return await fail(
      "PROVISION_FAILED",
      "Creating the bucket did not finish.",
      String((error as { message?: unknown })?.message ?? ""),
    );
  }
}
