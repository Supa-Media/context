/**
 * The bucket key a preview's managed bucket is given: the operator token itself, named by its id.
 *
 * Why this exists: a preview's `CLOUDFLARE_API_TOKEN` is a user token with R2 access but without the API-token
 * permission, so it cannot mint the bucket-scoped token production mints (`resolvePermissionGroupId` and
 * `createBucketScopedToken` fail on it). R2 accepts any API token that has R2 permission as S3 credentials: the
 * access key id is the token's id, and the secret is the SHA-256 of its value, which `deriveS3SecretAccessKey`
 * already computes. So the preview's bucket key is the operator token, and only the operator token's id and
 * derived secret are stored, sealed, in the preview's own deployment.
 *
 * Nothing new is exposed by this: a preview's buckets live in its own Workers account (`CLOUDFLARE_ACCOUNT_ID`),
 * never the customer-data account, and the deploy job already holds this same token. It is never used off a
 * preview; `provisionManagedStorage` and the revoke paths take this branch only when `isIsolatedPreview()`, and a
 * revoke skips it, because the key is the operator token and revoking it would revoke the preview's own access.
 */

import { cloudflareRequest } from "../cloudflare/request";

export async function previewBucketKey(options: { apiToken: string }): Promise<{ id: string; value: string }> {
  const result = await cloudflareRequest<{ id?: string; status?: string }>({
    apiToken: options.apiToken,
    method: "GET",
    path: "/user/tokens/verify",
  });
  if (typeof result.id !== "string" || result.id.length === 0 || result.status !== "active") {
    throw new Error("preview token id unavailable");
  }
  return { id: result.id, value: options.apiToken };
}
