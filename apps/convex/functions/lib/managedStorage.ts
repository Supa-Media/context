/**
 * Storage we run, in a Cloudflare account that holds customer buckets and
 * nothing else.
 *
 * `lib/cloudflare.ts` already knows how to make an R2 bucket and mint a key
 * scoped to it. It does that **in the customer's account**, from a credential
 * the customer supplies for the length of one request, and that path is
 * unchanged and still the free one. This module is the other half: the same
 * mechanics driven by *our* account, for people who should never have to open
 * a Cloudflare account at all.
 *
 * Everything downstream is deliberately identical. Provisioning mints a
 * per-bucket S3 key and stores exactly what a pasted binding stores, so the
 * gateway, the adapter and the privacy engine cannot tell a managed workspace
 * from a BYO one and have no reason to. `managed` on the binding exists for
 * the console and for the cancellation path — never for the read path.
 *
 * ## Three rules this file exists to enforce
 *
 * **One workspace, one bucket, named from something that cannot change.**
 * `managedBucketName` derives from the workspace id: immutable, unique by
 * construction, and therefore incapable of colliding no matter how many
 * buckets exist. A slug would read better in a dashboard and is the wrong
 * answer — slugs are a global namespace with a reserved list and a rename
 * story, and a bucket name that can be typed by somebody else is a bucket name
 * that can be aimed somewhere else. This is not tidiness: a bucket holding one
 * workspace is what makes handing it over possible, and prefix tenancy inside
 * one big bucket would end that (`CLAUDE.md`, non-negotiables #1 and #2).
 *
 * **The account is the boundary.** R2's bucket namespace is flat — there is no
 * grouping, no folder of buckets, no nesting — so the only thing separating
 * customer data from our own infrastructure is which account it is in. That
 * also means an API token scoped to "R2 in this account" reaches customer
 * buckets *only*, which is the property worth having.
 *
 * **The managed token is the most dangerous credential in this codebase.** It
 * creates buckets and mints further credentials across every customer bucket,
 * where the BYO setup credential is one customer's and lives for seconds. So
 * it is read from the environment inside actions and nowhere else: never
 * written to a table, never returned, never logged, never in an error string,
 * and never sent to the gateway — which continues to receive only the
 * per-bucket key, as it does for a pasted binding. Nothing in this module
 * returns it, and `__tests__/managedStorage.test.ts` asserts that.
 */

import { ConvexError } from "convex/values";
import type { Id } from "../../_generated/dataModel";
import { bucketNameProblem, isPlausibleAccountId } from "./cloudflare";

/**
 * The account that holds customer buckets. Never a literal in this repo, and
 * deliberately **not** the account this deployment's own infrastructure lives
 * in — see the module comment for why that separation is the whole boundary.
 */
export const MANAGED_R2_ACCOUNT_ID_ENV_VAR = "MANAGED_R2_ACCOUNT_ID";

/**
 * The token that can create buckets and mint keys in that account.
 *
 * Read inside actions only. If you find yourself passing this value anywhere
 * that a mutation, a query, a log line or the gateway can see it, the design
 * has gone wrong rather than the code.
 */
export const MANAGED_R2_API_TOKEN_ENV_VAR = "MANAGED_R2_API_TOKEN";

/**
 * What every managed bucket name starts with.
 *
 * It is a marker, not a namespace: the bucket still holds `1-projects/foo.md`
 * at its root like every other bucket in this product. It exists so that a
 * name can be recognised as ours by `isManagedBucketName` without a database
 * lookup — which is what lets `bindStorage` refuse one on sight.
 */
export const MANAGED_BUCKET_PREFIX = "ctx-";

export interface ManagedR2Config {
  accountId: string;
  /** Never logged, never stored, never returned to a client. */
  apiToken: string;
}

/**
 * The name of the one bucket belonging to this workspace.
 *
 * Deterministic and total: the same workspace always resolves to the same
 * bucket, so provisioning is idempotent and a retry after a half-finished
 * attempt finds the bucket it made last time rather than making a second one.
 *
 * Convex ids are lowercase alphanumeric and about 32 characters, so the result
 * sits comfortably inside R2's 3–63 character, lowercase-alphanumeric-and-
 * hyphen rule. That is checked rather than assumed — an id format that changed
 * under us should fail loudly here, at the one place that could otherwise
 * produce an unusable bucket name.
 */
export function managedBucketName(workspaceId: Id<"workspaces">): string {
  const name = `${MANAGED_BUCKET_PREFIX}${String(workspaceId).toLowerCase()}`;
  const problem = bucketNameProblem(name);
  if (problem !== null) {
    throw new ConvexError({
      code: "MANAGED_BUCKET_NAME_INVALID",
      // The workspace id is not a secret, but there is no reason to put it in
      // an error a client may render, and the name is derivable from it.
      message: `A managed bucket name could not be derived for this workspace: ${problem}`,
    });
  }
  return name;
}

/** Whether a bucket name is one we would have created. */
export function isManagedBucketName(name: string): boolean {
  return name.startsWith(MANAGED_BUCKET_PREFIX);
}

/**
 * The managed account's configuration, or `null` on a deployment that has not
 * been given one.
 *
 * `null` rather than a throw, because "this deployment does not offer managed
 * storage" is a normal state — a self-hoster following the README has no such
 * account and should still get a working gateway, and the BYO path is
 * untouched. Callers that genuinely need it use `requireManagedR2Config`.
 */
export function readManagedR2Config(): ManagedR2Config | null {
  const accountId = process.env[MANAGED_R2_ACCOUNT_ID_ENV_VAR];
  const apiToken = process.env[MANAGED_R2_API_TOKEN_ENV_VAR];
  if (typeof accountId !== "string" || accountId.length === 0) return null;
  if (typeof apiToken !== "string" || apiToken.length === 0) return null;
  // A malformed account id would otherwise be discovered as a 404 from
  // Cloudflare in the middle of somebody's signup, which reads as our outage.
  if (!isPlausibleAccountId(accountId)) return null;
  return { accountId, apiToken };
}

/** Whether this deployment can offer managed storage at all. */
export function managedStorageAvailable(): boolean {
  return readManagedR2Config() !== null;
}

export function requireManagedR2Config(): ManagedR2Config {
  const config = readManagedR2Config();
  if (config === null) {
    throw new ConvexError({
      code: "MANAGED_STORAGE_NOT_CONFIGURED",
      message: "Managed storage is not configured on this deployment.",
    });
  }
  return config;
}

/**
 * Refuse a customer-supplied Cloudflare account id that is ours.
 *
 * Nobody can act on the managed account without the managed token, so this
 * blocks nothing an attacker could otherwise do. It exists so that "the
 * managed account holds customer buckets and nothing else" is a property the
 * code enforces rather than a sentence in a decision document — and so that a
 * support engineer pasting the wrong id into the BYO provisioning flow gets a
 * refusal instead of a bucket in the wrong account.
 */
export function refuseManagedAccountId(accountId: string): void {
  const config = readManagedR2Config();
  if (config === null) return;
  if (accountId.trim().toLowerCase() !== config.accountId.trim().toLowerCase()) return;
  throw new ConvexError({
    code: "MANAGED_ACCOUNT_NOT_ALLOWED",
    message:
      "That Cloudflare account cannot be used here. Use an account you own, " +
      "or choose managed storage instead.",
  });
}

/**
 * Refuse a pasted binding that points at the managed account's R2 endpoint.
 *
 * The same reasoning as `refuseManagedAccountId`, one field along: a binding
 * is accepted by endpoint rather than by account id, so checking only the id
 * would leave the other door open. Substring rather than equality because the
 * endpoint a customer pastes may carry a jurisdiction segment or a trailing
 * slash, and the account id is the part that identifies the account either way.
 */
export function refuseManagedEndpoint(endpoint: string): void {
  const config = readManagedR2Config();
  if (config === null) return;
  if (!endpoint.toLowerCase().includes(config.accountId.toLowerCase())) return;
  throw new ConvexError({
    code: "MANAGED_ACCOUNT_NOT_ALLOWED",
    message:
      "That endpoint cannot be used here. Connect storage you own, " +
      "or choose managed storage instead.",
  });
}
