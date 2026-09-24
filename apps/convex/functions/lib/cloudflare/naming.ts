/**
 * Naming and addressing: bucket names, resource selectors, endpoints, the
 * account-token deep link, and the secret-key derivation.
 *
 * Split out of `lib/cloudflare.ts` — see that file's header for what the whole
 * module is for and the credential-handling rules it follows.
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
 *
 * **Confirmed byte-exact on 2026-08-27** against the payload Cloudflare's own
 * token-creation screen generates for an R2-Buckets-scoped policy: it renders
 * `Workers R2 Storage Bucket Item Read` and `Workers R2 Storage Bucket Item
 * Write`. This matters more than it looks, because `resolvePermissionGroupId`
 * matches on `group.name === …` and a miss throws *after* a bucket already
 * exists in the customer's account.
 *
 * Two near misses to not "correct" this into. The account-wide groups are
 * spelled `Workers R2 Storage Write` / `Read` — a different, broader
 * permission that does not go with a bucket-scoped resource selector. And the
 * published permissions reference lists **no** Bucket Item group at all, so its
 * absence there is not evidence: that page is not exhaustive.
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
 * How long a freshly minted R2 credential is allowed to take to start working.
 *
 * Creating a bucket and minting a key scoped to it do not make that key usable
 * at the S3 endpoint: Cloudflare documents R2 IAM changes as eventually
 * consistent for up to a minute, and the first production journey proved the
 * consequence by probing a new key 266ms after minting it and painting the
 * connection red (`docs/decisions/storage-and-credentials.md`).
 *
 * So **every path that mints an R2 credential and then uses it waits on this
 * window** rather than believing the first refusal — managed provisioning, the
 * managed copy's readiness gate, and the customer's own "create a bucket for
 * me". It lives here, next to the calls that do the minting, because it is a
 * fact about R2 rather than about any one of those flows, and three copies of
 * it would be three chances to fix the race in only two places.
 *
 * It does **not** apply to a credential somebody pasted: that one is as old as
 * they are and a refusal is an answer, not a wait. See `bindStorage`.
 */
export const R2_CREDENTIAL_SETTLE_MS = 2 * 60 * 1000;

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
  // Confirmed byte-exact on 2026-08-27 against the payload Cloudflare's own
  // token-creation screen generates for a bucket-scoped policy:
  //
  //   "com.cloudflare.edge.r2.bucket.<accountId>_default_<bucket>": "*"
  //
  // — including that the ordinary jurisdiction travels as the literal string
  // `default` rather than being omitted. A selector that does not match is not
  // an error: it mints a token scoped to nothing, which fails later and
  // somewhere else.
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
