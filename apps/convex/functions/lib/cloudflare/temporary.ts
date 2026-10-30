/**
 * Temporary R2 credentials for a bucket we have just made.
 *
 * Cloudflare takes up to two minutes (`R2_CREDENTIAL_SETTLE_MS`) to accept an
 * API token it has just minted, and the bucket-scoped key a new managed bucket
 * gets is exactly such a token. R2 can also issue temporary credentials for one
 * bucket, derived from a parent key it already trusts, which work the moment
 * they are made. So a new bucket is served on those while its own key settles,
 * and the person who has just signed up waits for neither.
 *
 * The parent is the operator token itself — the one that creates the buckets,
 * which holds R2 write on the account and has been trusted for as long as the
 * deployment has run — named by its id, which `tokens/verify` returns. The
 * credentials are scoped to the one bucket, read and write on its objects, and
 * expire after `TEMPORARY_CREDENTIAL_TTL_SECONDS`.
 *
 * NOT RUN AGAINST CLOUDFLARE from where this was written: the request follows
 * Cloudflare's published API (`POST /accounts/{id}/r2/temp-access-credentials`).
 * Every caller treats a failure here as "no temporary credential" and falls
 * back to waiting for the bucket's own key, which is what happened before.
 */

import { cloudflareRequest } from "./request";

/**
 * How long R2 honours a temporary credential. A bucket's own key replaces it
 * within minutes; the hours are slack for a promotion that keeps failing, and
 * once they pass the gateway is handed the bucket's own key regardless.
 */
export const TEMPORARY_CREDENTIAL_TTL_SECONDS = 6 * 60 * 60;

export interface TemporaryCredential {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

/** The id of the token making this call: the parent temporary credentials are signed from. */
export async function callerTokenId(options: { apiToken: string; accountId: string }): Promise<string> {
  const result = await cloudflareRequest<{ id?: string; status?: string }>({
    apiToken: options.apiToken,
    method: "GET",
    path: `/accounts/${options.accountId}/tokens/verify`,
  });
  if (typeof result.id !== "string" || result.id.length === 0 || result.status !== "active") {
    throw new Error("operator token id unavailable");
  }
  return result.id;
}

/** Read and write on one bucket's objects, usable at once, for `ttlSeconds`. */
export async function createTemporaryR2Credential(options: {
  apiToken: string;
  accountId: string;
  bucket: string;
  parentAccessKeyId: string;
  ttlSeconds: number;
}): Promise<TemporaryCredential> {
  const result = await cloudflareRequest<{
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
  }>({
    apiToken: options.apiToken,
    method: "POST",
    path: `/accounts/${options.accountId}/r2/temp-access-credentials`,
    body: {
      bucket: options.bucket,
      parentAccessKeyId: options.parentAccessKeyId,
      permission: "object-read-write",
      ttlSeconds: options.ttlSeconds,
    },
  });
  if (
    typeof result.accessKeyId !== "string" ||
    typeof result.secretAccessKey !== "string" ||
    typeof result.sessionToken !== "string" ||
    !result.accessKeyId ||
    !result.secretAccessKey ||
    !result.sessionToken
  ) {
    throw new Error("temporary credential incomplete");
  }
  return {
    accessKeyId: result.accessKeyId,
    secretAccessKey: result.secretAccessKey,
    sessionToken: result.sessionToken,
  };
}
