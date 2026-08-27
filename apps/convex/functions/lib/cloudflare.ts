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
 * ## OPEN QUESTIONS — do not close these by guessing
 *
 *  1. **The OAuth scope name for R2 is unpublished.** Cloudflare shipped
 *     third-party OAuth (authorization code + PKCE, with account selection in
 *     the consent screen, which is what would solve account discovery for us).
 *     Enumerating the scope vocabulary needs `GET /oauth/scopes` with a real
 *     token, which this repository does not have. No scope name is written down
 *     anywhere in this module on purpose: inventing one produces a consent
 *     screen that fails at authorize time, and a client that follows discovery
 *     to a scope the server rejects is a client that concludes we lied.
 *  2. **It is not documented whether an OAuth access token authenticates
 *     against `api.cloudflare.com/client/v4`.** If it does, the OAuth path is
 *     this module unchanged with a different `apiToken`. If it does not, the
 *     OAuth path needs a different transport and the shape here is wrong for
 *     it. Verify before building it.
 *  3. **The API-token template key for "Account API Tokens Write" is not
 *     known.** Minting the bucket-scoped S3 key needs that permission, and the
 *     deep link below can only pre-tick permissions whose template keys are
 *     published; only R2's (`workers_r2`) is. So a token pasted from the link
 *     may create the bucket and then be refused at the minting step. That is
 *     classified as `INSUFFICIENT_PERMISSIONS` with a message naming the
 *     missing permission, rather than guessed at — see `templateKeys` on
 *     `apiTokenTemplateUrl` for where a verified key would slot in.
 *
 * References (documentation, not credentials):
 *  - https://developers.cloudflare.com/fundamentals/oauth/
 *  - https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/
 *  - https://developers.cloudflare.com/r2/api/tokens/
 */

/** The one API host this module talks to. */
export const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

/** Where the token-creation form lives, for the paste path. */
export const CLOUDFLARE_TOKEN_DASHBOARD = "https://dash.cloudflare.com/profile/api-tokens";

/**
 * The permission group the minted S3 key carries, **by name**.
 *
 * Only the read group's id is published, so the write group's id has to be
 * resolved at runtime — see `resolvePermissionGroupId`. Cloudflare's own docs
 * warn that `name` is cosmetic and ids are the stable identifier, which is
 * precisely why hardcoding an id we read off a support page would be worse: a
 * wrong id is a token with the wrong powers, and a token with *more* powers
 * than this is a token we promised the customer we would not leave behind.
 */
export const R2_BUCKET_WRITE_PERMISSION_GROUP =
  "Workers R2 Storage Bucket Item Write";

/**
 * Jurisdictions R2 offers. `default` is ordinary; `eu` and `fedramp` place data
 * under a specific regulatory regime and change *both* the S3 endpoint and the
 * resource selector a token is scoped with, which is why it is one value
 * threaded through rather than two independent settings that can disagree.
 */
export type R2Jurisdiction = "default" | "eu" | "fedramp";

/**
 * How a provisioning attempt failed, as something a client can branch on.
 *
 * Same discipline as `VerificationErrorCode` in `functions/provisioning.ts`:
 * coarse, closed, and each value maps to a different thing the owner does.
 *
 *  - `R2_NOT_ENTITLED`             — R2 is not switched on for this account.
 *                                    See `NOT_ENTITLED_MESSAGE`; this one is
 *                                    not a storage error and must not be
 *                                    reported as one.
 *  - `BUCKET_NAME_TAKEN`           — a bucket of that name already exists.
 *                                    Choose another name.
 *  - `INVALID_BUCKET_NAME`         — refused before any call was made.
 *  - `CREDENTIAL_REJECTED`         — Cloudflare did not accept the credential.
 *                                    Paste a new one.
 *  - `INSUFFICIENT_PERMISSIONS`    — accepted, but not allowed to do this.
 *  - `PERMISSION_GROUP_UNAVAILABLE`— the write permission group was not in the
 *                                    list Cloudflare returned, so no correctly
 *                                    scoped key can be minted. Never mint a
 *                                    broader one instead.
 *  - `CLOUDFLARE_UNAVAILABLE`      — 5xx or no answer. Retry.
 *  - `PROVISION_FAILED`            — anything else. Show the detail.
 */
export type ProvisionErrorCode =
  | "R2_NOT_ENTITLED"
  | "BUCKET_NAME_TAKEN"
  | "INVALID_BUCKET_NAME"
  | "CREDENTIAL_REJECTED"
  | "INSUFFICIENT_PERMISSIONS"
  | "PERMISSION_GROUP_UNAVAILABLE"
  | "CLOUDFLARE_UNAVAILABLE"
  | "PROVISION_FAILED";

/**
 * THE MESSAGE FOR ERROR 10042, WRITTEN ON PURPOSE.
 *
 * Cloudflare requires a payment method on the account before R2 will accept a
 * bucket, even for usage that never leaves the free tier. The same error
 * appears months later if a card expires, and when it does Cloudflare blocks
 * access to the bucket while leaving every object in it intact.
 *
 * So this is a durable, non-alarming state with a one-time fix, and the wording
 * has three jobs: say what to do, say that it is free, and say whose
 * requirement the card is. "Storage error, contact support" would be true,
 * useless, and would make us answer for somebody else's billing rule.
 */
export const NOT_ENTITLED_MESSAGE =
  "Cloudflare has not enabled R2 on this account yet. Complete R2 checkout once in the Cloudflare dashboard — R2 is free below its included limits, and the card on file is Cloudflare's requirement, not ours. Your notes are untouched; try again afterwards.";

/** What a classified failure carries. `detail` is provider text, never ours. */
export interface ProvisionFailure {
  errorCode: ProvisionErrorCode;
  message: string;
}

/** One error object out of a Cloudflare API envelope. */
export interface CloudflareApiErrorEntry {
  code?: number;
  message?: string;
}

/** Every Cloudflare API response has this shape, success or failure. */
export interface CloudflareEnvelope<T> {
  success?: boolean;
  errors?: CloudflareApiErrorEntry[];
  result?: T;
}

/**
 * A Cloudflare call that did not succeed, already classified.
 *
 * Carries no request headers and no token — an exception is one of the easiest
 * places in a system for a credential to escape, and this one is caught,
 * recorded on a row, and shown to a person.
 */
export class CloudflareApiError extends Error {
  readonly errorCode: ProvisionErrorCode;
  /** Provider text, for the honest half of the recorded error. May be empty. */
  readonly detail: string;

  constructor(failure: ProvisionFailure, detail: string) {
    super(failure.message);
    this.name = "CloudflareApiError";
    this.errorCode = failure.errorCode;
    this.detail = detail;
  }
}

/**
 * Map an HTTP status and Cloudflare's own error codes onto our closed set.
 *
 * Code first, status second: Cloudflare's numeric codes are the specific
 * signal, and 10042 in particular arrives as a 403, which would otherwise be
 * indistinguishable from "this token may not do that" — two failures with
 * completely different fixes.
 */
export function classifyCloudflareFailure(input: {
  status: number;
  errors?: CloudflareApiErrorEntry[];
}): ProvisionFailure {
  const codes = (input.errors ?? [])
    .map((entry) => entry.code)
    .filter((code): code is number => typeof code === "number");

  // 10042 `NotEntitled`. Checked before anything else, including before the
  // status, because it is the one failure here that is neither the customer's
  // mistake nor ours.
  if (codes.includes(10042)) {
    return { errorCode: "R2_NOT_ENTITLED", message: NOT_ENTITLED_MESSAGE };
  }
  // 10073: a bucket of that name is already in this account.
  if (codes.includes(10073) || input.status === 409) {
    return {
      errorCode: "BUCKET_NAME_TAKEN",
      message:
        "A bucket with that name already exists in this Cloudflare account. Choose a different name, or connect the existing bucket directly with its own access key.",
    };
  }
  if (input.status === 401 || codes.includes(10000)) {
    return {
      errorCode: "CREDENTIAL_REJECTED",
      message:
        "Cloudflare did not accept that credential. Create a fresh API token and try again.",
    };
  }
  if (input.status === 403) {
    return {
      errorCode: "INSUFFICIENT_PERMISSIONS",
      message:
        'That credential is valid but not allowed to do this. It needs "Workers R2 Storage" edit and "Account API Tokens" write on the account you chose.',
    };
  }
  if (input.status >= 500) {
    return {
      errorCode: "CLOUDFLARE_UNAVAILABLE",
      message: "Cloudflare did not answer. Nothing was changed; try again shortly.",
    };
  }
  return {
    errorCode: "PROVISION_FAILED",
    message: "Cloudflare refused the request.",
  };
}

/**
 * The S3-compatible endpoint for an account.
 *
 * The account id is the first host label, which is why `bucket` is never in the
 * host: R2's S3 endpoint is path-style, and the binding written from this is
 * addressed the same way the gateway will address it.
 */
export function r2Endpoint(
  accountId: string,
  jurisdiction: R2Jurisdiction = "default",
): string {
  const infix = jurisdiction === "default" ? "" : `${jurisdiction}.`;
  return `https://${accountId}.${infix}r2.cloudflarestorage.com`;
}

/** R2's S3 API takes `auto`; there is no region to choose. */
export const R2_REGION = "auto";

/**
 * The resource selector that scopes a token to exactly one bucket.
 *
 * `com.cloudflare.edge.r2.bucket.<ACCOUNT_ID>_<JURISDICTION>_<BUCKET_NAME>`,
 * where an ordinary bucket's jurisdiction is the literal word `default`. Get
 * this wrong in the lenient direction and the minted key can read and write
 * *every* bucket in the customer's account — including ones that have nothing
 * to do with us — which is the difference between "we hold a key to your notes"
 * and "we hold a key to your storage".
 */
export function bucketResourceSelector(
  accountId: string,
  jurisdiction: R2Jurisdiction,
  bucket: string,
): string {
  return `com.cloudflare.edge.r2.bucket.${accountId}_${jurisdiction}_${bucket}`;
}

/**
 * The S3 secret access key for an R2 API token.
 *
 * Not a value Cloudflare hands back: the access key id is the token's `id`, and
 * the secret is the **lowercase hex SHA-256 of the token's `value`**. The token
 * value itself is never stored — the derivation is one-way, so what lands in
 * the row cannot be turned back into a Cloudflare API token even by us.
 *
 * Web Crypto, so it runs unchanged in the Convex action runtime, in the Workers
 * gateway, and under `@edge-runtime/vm` in the tests — where it is checked
 * against a published SHA-256 vector rather than against itself.
 */
export async function deriveS3SecretAccessKey(tokenValue: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(tokenValue) as BufferSource,
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * R2 bucket names: 3–63 characters, lowercase letters, digits and hyphens,
 * starting and ending alphanumeric.
 *
 * Cloudflare's own pages disagree about 63 versus 64, so this takes the
 * stricter of the two: a name we refuse is a message on a form, and a name
 * Cloudflare refuses is a failed provisioning run halfway through.
 *
 * Returns the reason it is unusable, or `null` when it is fine.
 */
export function bucketNameProblem(name: string): string | null {
  if (name.length < 3 || name.length > 63) {
    return "A bucket name must be between 3 and 63 characters.";
  }
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(name)) {
    return "A bucket name may contain only lowercase letters, digits and hyphens, and must start and end with a letter or digit.";
  }
  return null;
}

/**
 * A bucket name derived from a workspace slug.
 *
 * Slugs and bucket names have nearly the same charset, so this is mostly a
 * safety net for the ends and the length. It is a *suggestion*: the person
 * types over it, and `bucketNameProblem` is what actually decides.
 */
export function suggestBucketName(slug: string): string {
  const cleaned = slug
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 55);
  const base = cleaned.length === 0 ? "context" : cleaned;
  // Padded rather than rejected: a two-character slug is a legal workspace name
  // and an illegal bucket name, and the person should get a usable default
  // rather than an error on a field they did not fill in.
  const padded = base.length < 3 ? `${base}-context` : base;
  return padded.slice(0, 63).replace(/-+$/, "");
}

/** The name the minted token carries in the customer's dashboard. */
export function scopedTokenName(bucket: string): string {
  return `Context — ${bucket}`.slice(0, 64);
}

/**
 * The Cloudflare dashboard deep link that pre-fills an API token form.
 *
 * **This is a form pre-fill, not an OAuth flow.** There is no redirect, no
 * callback and no code exchange: the person lands on their own dashboard with
 * the permissions ticked, creates the token, and copies the value back into our
 * form by hand. Anything that reads like "connect with Cloudflare" in a UI built
 * on this is a lie about what is happening.
 *
 * Two consequences, both of which the caller has to live with:
 *  - We cannot learn the account id from it. `GET /user/tokens/verify` does not
 *    return one and `GET /accounts` documents Global-API-Key auth only, so the
 *    account id is a second field the person fills in. (`GET /memberships`
 *    would answer it, but its permission has no published template key, so it
 *    cannot be pre-ticked here.)
 *  - The permissions are only as complete as the published template keys. See
 *    open question 3 in the module docstring.
 */
export function apiTokenTemplateUrl(options: {
  name: string;
  /**
   * Template keys to pre-tick. Defaults to R2 edit, the only one published.
   * A verified key for "Account API Tokens Write" belongs here — as data, not
   * as a guess in the default.
   */
  templateKeys?: ReadonlyArray<{ key: string; type: string }>;
}): string {
  const keys = options.templateKeys ?? [{ key: "workers_r2", type: "edit" }];
  const query = new URLSearchParams({
    permissionGroupKeys: JSON.stringify(keys),
    // Account-owned tokens are chosen on the form; `*` leaves the account
    // picker open rather than naming one we have not been told about.
    accountId: "*",
    zoneId: "all",
    name: options.name,
  });
  return `${CLOUDFLARE_TOKEN_DASHBOARD}?${query.toString()}`;
}

/**
 * Cloudflare account ids are 32 lowercase hex characters.
 *
 * Checked because it is typed by hand on the paste path, and a typo would
 * otherwise become a signed request to a hostname that does not exist and a
 * failure message about DNS.
 */
export function isPlausibleAccountId(accountId: string): boolean {
  return /^[0-9a-f]{32}$/.test(accountId);
}

/**
 * How long one Cloudflare API call may take.
 *
 * Same reasoning as the storage probe's deadline: a request that hangs holds an
 * action open and, here, holds a decrypted setup credential in memory for the
 * duration. `AbortSignal.timeout` is guarded rather than assumed, because this
 * code runs in three runtimes and a missing deadline is a slower failure rather
 * than a wrong one.
 */
const REQUEST_TIMEOUT_MS = 15_000;

function timeoutSignal(): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" &&
    typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    : undefined;
}

/**
 * One authenticated call to the Cloudflare API, classified on the way out.
 *
 * The token is on the `Authorization` header and nowhere else — never in the
 * URL, never in a log line. A non-2xx, an unparseable body and `success: false`
 * are all the same kind of event to a caller: a `CloudflareApiError` carrying a
 * code from the closed set.
 */
export async function cloudflareRequest<T>(options: {
  apiToken: string;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}): Promise<T> {
  const signal = timeoutSignal();
  let response: Response;
  try {
    response = await globalThis.fetch(`${CLOUDFLARE_API_BASE}${options.path}`, {
      method: options.method,
      headers: {
        Authorization: `Bearer ${options.apiToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    // No answer at all: DNS, TLS, the deadline above. Retryable, and nothing
    // was changed in the customer's account.
    throw new CloudflareApiError(
      {
        errorCode: "CLOUDFLARE_UNAVAILABLE",
        message: "Cloudflare could not be reached. Nothing was changed; try again shortly.",
      },
      String((error as { message?: unknown })?.message ?? ""),
    );
  }

  let envelope: CloudflareEnvelope<T> = {};
  let raw = "";
  try {
    raw = await response.text();
    envelope = raw.length === 0 ? {} : (JSON.parse(raw) as CloudflareEnvelope<T>);
  } catch {
    // A body that is not JSON is still a failure we have to classify; the
    // status is all we have to go on.
    envelope = {};
  }

  if (!response.ok || envelope.success === false || envelope.result === undefined) {
    const failure = classifyCloudflareFailure({
      status: response.status,
      errors: envelope.errors,
    });
    throw new CloudflareApiError(failure, describeErrors(envelope, raw));
  }
  return envelope.result;
}

/** Provider text for the honest half of a recorded error. Never our prose. */
function describeErrors(envelope: CloudflareEnvelope<unknown>, raw: string): string {
  const messages = (envelope.errors ?? [])
    .map((entry) =>
      [entry.code, entry.message].filter((part) => part !== undefined).join(" "),
    )
    .filter((line) => line.length > 0);
  if (messages.length > 0) return messages.join("; ");
  return raw.slice(0, 200);
}

/** One entry of `GET /user/tokens/permission_groups`. */
interface PermissionGroup {
  id?: string;
  name?: string;
}

/**
 * Resolve the write permission group's id, by name, at runtime.
 *
 * Only the *read* group's id is published, so there is nothing to hardcode for
 * the write group even if hardcoding were wise. Refusing when the name is
 * absent is deliberate and is the safe direction: the alternative — falling
 * back to a broader group, or to no resource selector — mints a key with more
 * access to the customer's account than we asked them for.
 */
export async function resolvePermissionGroupId(options: {
  apiToken: string;
  name: string;
}): Promise<string> {
  const groups = await cloudflareRequest<PermissionGroup[]>({
    apiToken: options.apiToken,
    method: "GET",
    path: "/user/tokens/permission_groups",
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
