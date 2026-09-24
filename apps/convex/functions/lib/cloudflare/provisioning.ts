/**
 * The calls that actually create, mint against, and tear down a customer's R2
 * bucket: permission resolution, bucket create/read, token mint/revoke, and
 * empty-and-delete.
 *
 * Split out of `lib/cloudflare.ts` — see that file's header for what the whole
 * module is for and the credential-handling rules it follows.
 */

import { cloudflareRequest } from "./request";
import { bucketResourceSelector, type R2Jurisdiction } from "./naming";
import { CloudflareApiError } from "./errors";

/** One entry of `GET /accounts/:id/tokens/permission_groups`. */
interface PermissionGroup {
  id?: string;
  name?: string;
}

/**
 * Resolve the write permission group's id, by name, at runtime.
 *
 * This is deliberately the account-owned-token endpoint. A real account token
 * with permission to create and enumerate account tokens returns the groups
 * here, while Cloudflare rejects that same credential at the similarly named
 * `/user/tokens/permission_groups` endpoint with 403/9109. Managed storage
 * uses an account-owned token, so the user-level endpoint makes every live
 * provisioning attempt fail before bucket creation.
 *
 * Only the *read* group's id is published, so there is nothing to hardcode for
 * the write group even if hardcoding were wise. Refusing when the name is
 * absent is deliberate and is the safe direction: the alternative — falling
 * back to a broader group, or to no resource selector — mints a key with more
 * access to the customer's account than we asked them for.
 */
export async function resolvePermissionGroupId(options: {
  apiToken: string;
  accountId: string;
  name: string;
}): Promise<string> {
  const groups = await cloudflareRequest<PermissionGroup[]>({
    apiToken: options.apiToken,
    method: "GET",
    path: `/accounts/${options.accountId}/tokens/permission_groups`,
  });
  const match = (Array.isArray(groups) ? groups : []).find(
    (group) => group.name === options.name && typeof group.id === "string",
  );
  if (match?.id === undefined) {
    throw new CloudflareApiError(
      {
        errorCode: "PERMISSION_GROUP_UNAVAILABLE",
        message: `Cloudflare did not offer the "${options.name}" permission, so no correctly scoped key could be created. Nothing broader was created instead.`,
      },
      "",
    );
  }
  return match.id;
}

/**
 * Create a bucket in the customer's account.
 *
 * The jurisdiction travels as the `cf-r2-jurisdiction` **header**, not as a
 * body field — putting it in the body silently creates an ordinary bucket, and
 * the resource selector built for `eu` would then match nothing.
 */
export async function createR2Bucket(options: {
  apiToken: string;
  accountId: string;
  bucket: string;
  jurisdiction: R2Jurisdiction;
  locationHint?: string;
  storageClass?: string;
}): Promise<void> {
  await cloudflareRequest<unknown>({
    apiToken: options.apiToken,
    method: "POST",
    path: `/accounts/${options.accountId}/r2/buckets`,
    headers:
      options.jurisdiction === "default"
        ? undefined
        : { "cf-r2-jurisdiction": options.jurisdiction },
    body: {
      name: options.bucket,
      ...(options.locationHint ? { locationHint: options.locationHint } : {}),
      ...(options.storageClass ? { storageClass: options.storageClass } : {}),
    },
  });
}

/**
 * How far Cloudflare's clock may be behind ours before we stop believing it.
 *
 * `bucketCreatedDuringAttempt` compares a timestamp Cloudflare wrote against
 * one we wrote, and the safe direction is to allow a little slack: without it a
 * bucket we created a second ago could read as predating the attempt that
 * created it. The cost of the slack is a window that wide in which a bucket the
 * customer made by hand would be adopted, which needs them to have created a
 * bucket with exactly this name a minute before pressing the button.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 60_000;

/** What `GET /accounts/:id/r2/buckets/:name` tells us that we use. */
export interface R2BucketDetails {
  name?: string;
  /** ISO 8601, per Cloudflare. Absent or unparseable is treated as unknown. */
  creationDate?: string;
}

/**
 * Read one bucket's metadata.
 *
 * Exists for exactly one question — "did this attempt create this bucket?" —
 * and the only field it needs is the creation date. Same jurisdiction header as
 * the create, because a jurisdictional bucket is not visible without it and an
 * absent bucket would otherwise read as "not ours", which is the safe answer to
 * the wrong question.
 */
export async function getR2Bucket(options: {
  apiToken: string;
  accountId: string;
  bucket: string;
  jurisdiction: R2Jurisdiction;
}): Promise<R2BucketDetails> {
  const result = await cloudflareRequest<{ name?: string; creation_date?: string }>({
    apiToken: options.apiToken,
    method: "GET",
    path: `/accounts/${options.accountId}/r2/buckets/${encodeURIComponent(options.bucket)}`,
    headers:
      options.jurisdiction === "default"
        ? undefined
        : { "cf-r2-jurisdiction": options.jurisdiction },
  });
  return { name: result.name, creationDate: result.creation_date };
}

/**
 * Was this bucket created by the attempt that is now looking at it?
 *
 * **This is the whole safety argument for reusing a bucket rather than
 * refusing.** A name that is already taken is only a dead end when the bucket
 * is not ours; when it is ours — created by an earlier run of *this* attempt,
 * which then failed at the minting step — refusing sends the owner looking for
 * a new name because of a bucket we made for them.
 *
 * The evidence is Cloudflare's own record, not our memory: the bucket must have
 * been created at or after the moment this provisioning attempt was first
 * written down. A bucket the customer already had predates that by definition,
 * because they cannot have created it after starting an attempt they had not
 * started yet. Everything unknown — no date, an unparseable date, a bucket we
 * could not read — is `false`, because the direction this must fail in is
 * "leave the customer's bucket alone".
 */
export function bucketCreatedDuringAttempt(input: {
  creationDate: string | undefined;
  /** When the provisioning row was first written. Survives retries. */
  attemptStartedAt: number;
  toleranceMs?: number;
}): boolean {
  if (typeof input.creationDate !== "string" || input.creationDate.length === 0) {
    return false;
  }
  const createdAt = Date.parse(input.creationDate);
  if (Number.isNaN(createdAt)) return false;
  return createdAt >= input.attemptStartedAt - (input.toleranceMs ?? CLOCK_SKEW_TOLERANCE_MS);
}

/** What minting produced. The `value` is a Cloudflare token — handle as such. */
export interface MintedToken {
  id: string;
  value: string;
}

/**
 * Mint an account-owned API token scoped to one bucket.
 *
 * The permission group id is resolved by the caller, and the resource selector
 * names exactly one bucket. This is the only credential that survives the flow.
 */
export async function createBucketScopedToken(options: {
  apiToken: string;
  accountId: string;
  bucket: string;
  jurisdiction: R2Jurisdiction;
  permissionGroupId: string;
  name: string;
}): Promise<MintedToken> {
  const result = await cloudflareRequest<{ id?: string; value?: string }>({
    apiToken: options.apiToken,
    method: "POST",
    path: `/accounts/${options.accountId}/tokens`,
    body: {
      name: options.name,
      policies: [
        {
          effect: "allow",
          permission_groups: [{ id: options.permissionGroupId }],
          resources: {
            [bucketResourceSelector(
              options.accountId,
              options.jurisdiction,
              options.bucket,
            )]: "*",
          },
        },
      ],
    },
  });

  if (typeof result.id !== "string" || typeof result.value !== "string") {
    // KNOWN RESIDUAL: if Cloudflare returned an id but no value, a token exists
    // in the customer's account and this is the only place its id was ever
    // visible, so it cannot be revoked afterwards. Every *other* post-mint
    // failure is taken back by `revokeApiToken` in `functions/cloudflare.ts`.
    //
    // The response shape is no longer the unknown it was when this was written.
    // Cloudflare documents `POST /accounts/{id}/tokens` as returning `result.id`
    // (the token identifier) and `result.value` (the secret, 40–80 characters),
    // which is exactly what is destructured above:
    // https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/create/
    //
    // So this branch is a real defence against a response that contradicts the
    // documentation, not a hedge against not knowing what to expect — which is
    // why it still refuses to guess a delete from a body it did not understand.
    throw new CloudflareApiError(
      {
        errorCode: "PROVISION_FAILED",
        message:
          "Cloudflare created a token but did not return its value, so no usable key could be stored.",
      },
      "",
    );
  }
  return { id: result.id, value: result.value };
}

/**
 * Delete an API token we minted, by id. Best effort, and it says which.
 *
 * The hazard it closes: minting succeeds and then something after it fails —
 * the encrypt, the binding write, an eviction — leaving a live R2 token in the
 * customer's account that nothing in the control plane records, because the
 * only place its id ever existed was a local variable. That is a credential we
 * created and cannot tell them about later.
 *
 * Returns `false` rather than throwing, because every caller is already on a
 * failure path: the answer feeds `residueAfterFailure`, which is the difference
 * between telling somebody a token is there and telling them it is not.
 */
export async function revokeApiToken(options: {
  apiToken: string;
  accountId: string;
  tokenId: string;
}): Promise<boolean> {
  try {
    await cloudflareRequest<unknown>({
      apiToken: options.apiToken,
      method: "DELETE",
      path: `/accounts/${options.accountId}/tokens/${encodeURIComponent(options.tokenId)}`,
      // The answer is the status; Cloudflare's body for this call is not
      // documented to carry a result, and reading its absence as failure would
      // report a deleted token as still standing.
      resultOptional: true,
    });
    return true;
  } catch {
    return false;
  }
}

type R2ObjectRow = { key?: string };

/**
 * Empty and delete one R2 bucket through Cloudflare's account API.
 * Re-listing the first page after each batch avoids trusting a pagination
 * cursor whose contents are changing while objects are removed.
 */
export async function emptyAndDeleteR2Bucket(options: {
  apiToken: string;
  accountId: string;
  bucket: string;
}): Promise<void> {
  const bucketPath = `/accounts/${options.accountId}/r2/buckets/${encodeURIComponent(options.bucket)}`;
  for (;;) {
    const objects = await cloudflareRequest<R2ObjectRow[]>({
      apiToken: options.apiToken,
      method: "GET",
      path: `${bucketPath}/objects`,
    });
    const keys = objects.flatMap((row) => typeof row.key === "string" ? [row.key] : []);
    if (keys.length === 0) break;
    for (const key of keys) {
      // Cloudflare requires slashes in object keys to remain literal.
      const encodedKey = key.split("/").map(encodeURIComponent).join("/");
      await cloudflareRequest<unknown>({
        apiToken: options.apiToken,
        method: "DELETE",
        path: `${bucketPath}/objects/${encodedKey}`,
        resultOptional: true,
      });
    }
  }
  await cloudflareRequest<unknown>({
    apiToken: options.apiToken,
    method: "DELETE",
    path: bucketPath,
    resultOptional: true,
  });
}
