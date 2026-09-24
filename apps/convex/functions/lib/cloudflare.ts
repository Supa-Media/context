/**
 * Talking to Cloudflare's API on a customer's behalf, as pure functions.
 *
 * Everything here is either a string transformation or one `fetch` against
 * `api.cloudflare.com`. Nothing here reads or writes the database, nothing here
 * holds a decrypted credential for longer than the call it was passed to, and
 * nothing here is a Convex function — which is what makes it unit-testable
 * against a stubbed socket and what keeps `functions/cloudflare.ts` down to the
 * five Convex functions that carry the credential lifecycle.
 *
 * ## What this is for
 *
 * A person who has a Cloudflare account but no bucket should not have to learn
 * the R2 console, the S3-compatibility page and the API-token screen before
 * they can use a notes product. Given one credential that can act on their
 * account, we create a bucket *in their account* and mint an S3 key scoped to
 * that one bucket, and then throw the powerful credential away. What persists
 * is exactly the same thing a manual connect would have produced: one
 * bucket-scoped access key id and secret. The customer still owns the storage,
 * can see both objects in their own dashboard, and can revoke either without
 * asking us.
 *
 * ## The two credential sources
 *
 * Downstream, an OAuth access token and a pasted API token are the same thing:
 * a `Bearer` value on an HTTPS request. So every function here takes an opaque
 * `apiToken` string and does not care where it came from. Only the *acquisition*
 * differs, and that difference lives above this module.
 *
 * ## ANSWERED 2026-08-27, against a real account
 *
 *  1. **The R2 OAuth scopes exist.** `GET /oauth/scopes` returns 383 scopes,
 *     among them `workers-r2.write`, `workers-r2.read`,
 *     `workers-r2.metadata_read`, and `workers-r2-bucket-item.read` /
 *     `.write`. So a "Connect Cloudflare" button does not have to fall back to
 *     the token deep link for want of a scope. Note the two vocabularies: the
 *     catalogue uses dotted ids, while `wrangler`'s stored grant uses short
 *     names (`workers:write`, `account:read`). A self-managed OAuth client
 *     picks from the catalogue — do not copy wrangler's strings.
 *  2. **Yes, an OAuth access token authenticates against
 *     `api.cloudflare.com/client/v4`,** as a plain `Authorization: Bearer`.
 *     Verified: 200 on `/accounts`, `/user`, `/accounts/{id}/r2/buckets` and
 *     `/accounts/{id}/workers/scripts`. So the OAuth path is this module
 *     unchanged with a different `apiToken` — for the account and bucket calls.
 *     Two traps found on the way:
 *       - **`/user/tokens/verify` returns 401 `1000 Invalid API Token` for an
 *         OAuth token.** Never use it to check whether a credential is good;
 *         `GET /accounts` is the check that works for both sources.
 *       - R2 bucket access answered 200 from a grant carrying no `workers-r2.*`
 *         scope at all — bucket administration rides on `workers:write`.
 *
 * ## STILL OPEN, and now known to be worse than a missing template key
 *
 *  3. **An OAuth grant can never mint the credential we store.** The
 *     383-scope catalogue contains **no API-Tokens-Write scope** — the only
 *     token scopes in it are Zero Trust service tokens
 *     (`access-service-token.*`) — and `/accounts/{id}/tokens`,
 *     `/accounts/{id}/tokens/permission_groups` and
 *     `/user/tokens/permission_groups` all answer **403** to an OAuth token.
 *     `POST /accounts/{id}/r2/temp-access-tokens` exists but is temporary by
 *     construction, so it cannot back a persistent binding either.
 *
 *     So OAuth can select the account and create the bucket and then stop.
 *     **That makes `INSUFFICIENT_PERMISSIONS` the guaranteed outcome of a
 *     pure-OAuth flow rather than an edge case**, which is a product decision
 *     (a hybrid: OAuth for discovery, a pasted token to mint) and not
 *     something to resolve inside this module.
 *
 *     The **deep link's** template key for "Account API Tokens Write" is still
 *     unknown, and no API can supply it — it is a dashboard URL parameter
 *     (`?permissionGroupKeys=[…]`), so it has to be read off the address bar of
 *     the token-creation screen. Only R2's (`workers_r2`) is published. See
 *     `templateKeys` on `apiTokenTemplateUrl` for where a verified key slots in.
 *
 *     **That failure is the expected one, so this module is built around it.**
 *     It happens *after* a bucket exists in the customer's account, which is
 *     why a classified failure carries the stage it happened at (see
 *     `ProvisionStage`) and why the message a person reads is composed by
 *     `provisionFailureMessage` rather than by the classifier alone. A message
 *     that says "nothing was changed" when a bucket was created is not a
 *     cosmetic problem: it is the sentence that sends somebody back into
 *     `BUCKET_NAME_TAKEN` on a bucket we made for them.
 *
 * References (documentation, not credentials):
 *  - https://developers.cloudflare.com/fundamentals/oauth/
 *  - https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/
 *  - https://developers.cloudflare.com/r2/api/tokens/
 *
 * ## Layout of this module
 *
 * Split into `lib/cloudflare/` by responsibility — failure classification and
 * narration (`errors.ts`), naming and addressing (`naming.ts`), the
 * authenticated request helper (`request.ts`), and the actual
 * create/mint/revoke/delete calls (`provisioning.ts`). This file is a facade:
 * every name it exported before the split it still exports, from the same
 * path.
 */

export type {
  AttemptResidue,
  CloudflareApiErrorEntry,
  CloudflareEnvelope,
  ProvisionErrorCode,
  ProvisionFailure,
  ProvisionStage,
} from "./cloudflare/errors";
export {
  bucketNotOursMessage,
  classifyCloudflareFailure,
  CloudflareApiError,
  NOT_ENTITLED_MESSAGE,
  provisionFailureMessage,
  residueAfterFailure,
  residueSentence,
} from "./cloudflare/errors";

export type { R2Jurisdiction } from "./cloudflare/naming";
export {
  apiTokenTemplateUrl,
  bucketNameProblem,
  bucketResourceSelector,
  CLOUDFLARE_API_BASE,
  CLOUDFLARE_TOKEN_DASHBOARD,
  deriveS3SecretAccessKey,
  isPlausibleAccountId,
  R2_BUCKET_WRITE_PERMISSION_GROUP,
  R2_CREDENTIAL_SETTLE_MS,
  R2_REGION,
  r2Endpoint,
  scopedTokenName,
  suggestBucketName,
} from "./cloudflare/naming";

export { cloudflareRequest, stripCredentialFields } from "./cloudflare/request";

export type { MintedToken, R2BucketDetails } from "./cloudflare/provisioning";
export {
  bucketCreatedDuringAttempt,
  CLOCK_SKEW_TOLERANCE_MS,
  createBucketScopedToken,
  createR2Bucket,
  emptyAndDeleteR2Bucket,
  getR2Bucket,
  resolvePermissionGroupId,
  revokeApiToken,
} from "./cloudflare/provisioning";
