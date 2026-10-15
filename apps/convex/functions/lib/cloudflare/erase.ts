/**
 * Erasing one managed R2 bucket and its scoped token, a bounded step at a time.
 *
 * `emptyAndDeleteR2Bucket` (`provisioning.ts`) loops until a bucket is empty,
 * which is fine for a test account's handful of files and wrong for a real
 * workspace: one action would run until it timed out, and a timeout loses the
 * progress and the error. Account deletion erases real workspaces, so each
 * call here does a bounded amount of work and says whether there is more, and
 * the caller (`functions/managedErasure.ts`) records progress between calls.
 *
 * A 404 is an answer here, not a failure: a bucket or token that is already
 * gone is exactly the end state a retry is driving towards, and a cleanup that
 * failed on its own earlier success could never finish.
 */

import { cloudflareRequest } from "./request";
import { CloudflareApiError } from "./errors";
import { scopedTokenName } from "./naming";

/** How many keys one page lists and deletes. Cloudflare's own page ceiling. */
export const ERASE_PAGE_SIZE = 1000;

/** Deletes in flight at once: fast enough for a large bucket, polite to the API. */
const DELETE_CONCURRENCY = 16;

function isNotFound(error: unknown): boolean {
  return error instanceof CloudflareApiError && error.status === 404;
}

function bucketPath(accountId: string, bucket: string): string {
  return `/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucket)}`;
}

/**
 * List one page of the bucket and delete what it names.
 *
 * Always lists from the start rather than following a cursor: the listing is
 * changing under us as objects go, and the first page of what is left is the
 * only page that is certainly right. `more` is true when the page was full,
 * so the caller comes back; a short page means the bucket is now empty.
 */
export async function eraseR2ObjectsPage(options: {
  apiToken: string;
  accountId: string;
  bucket: string;
}): Promise<{ deleted: number; more: boolean; bucketMissing: boolean }> {
  const path = bucketPath(options.accountId, options.bucket);
  let rows: Array<{ key?: string }>;
  try {
    rows = await cloudflareRequest<Array<{ key?: string }>>({
      apiToken: options.apiToken,
      method: "GET",
      path: `${path}/objects?per_page=${ERASE_PAGE_SIZE}`,
    });
  } catch (error) {
    if (isNotFound(error)) return { deleted: 0, more: false, bucketMissing: true };
    throw error;
  }
  const keys = (Array.isArray(rows) ? rows : []).flatMap((row) =>
    typeof row.key === "string" ? [row.key] : [],
  );
  for (let start = 0; start < keys.length; start += DELETE_CONCURRENCY) {
    await Promise.all(
      keys.slice(start, start + DELETE_CONCURRENCY).map(async (key) => {
        // Cloudflare requires slashes in object keys to remain literal.
        const encodedKey = key.split("/").map(encodeURIComponent).join("/");
        try {
          await cloudflareRequest<unknown>({
            apiToken: options.apiToken,
            method: "DELETE",
            path: `${path}/objects/${encodedKey}`,
            resultOptional: true,
          });
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
      }),
    );
  }
  return { deleted: keys.length, more: keys.length > 0, bucketMissing: false };
}

/** Delete the (now empty) bucket. True when it is gone, already gone included. */
export async function deleteEmptyR2Bucket(options: {
  apiToken: string;
  accountId: string;
  bucket: string;
}): Promise<void> {
  try {
    await cloudflareRequest<unknown>({
      apiToken: options.apiToken,
      method: "DELETE",
      path: bucketPath(options.accountId, options.bucket),
      resultOptional: true,
    });
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

/**
 * Revoke the token minted for this bucket, and only that token.
 *
 * The id comes from a row, and a row is data: before deleting an API token in
 * the account that holds every customer's bucket, ask Cloudflare what the
 * token is called and require the name provisioning gave it
 * (`scopedTokenName(bucket)`). Anything else is somebody else's credential,
 * an operator's included, and is left standing.
 */
export async function revokeBucketToken(options: {
  apiToken: string;
  accountId: string;
  bucket: string;
  tokenId: string;
}): Promise<"revoked" | "absent" | "not_for_bucket"> {
  const path = `/accounts/${options.accountId}/tokens/${encodeURIComponent(options.tokenId)}`;
  let token: { name?: unknown };
  try {
    token = await cloudflareRequest<{ name?: unknown }>({
      apiToken: options.apiToken,
      method: "GET",
      path,
    });
  } catch (error) {
    if (isNotFound(error)) return "absent";
    throw error;
  }
  if (token?.name !== scopedTokenName(options.bucket)) return "not_for_bucket";
  try {
    await cloudflareRequest<unknown>({
      apiToken: options.apiToken,
      method: "DELETE",
      path,
      resultOptional: true,
    });
  } catch (error) {
    if (isNotFound(error)) return "absent";
    throw error;
  }
  return "revoked";
}
