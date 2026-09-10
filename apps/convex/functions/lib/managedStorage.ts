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
 * from a BYO one and have no reason to.
 *
 * ## Two values, in two different places, on purpose
 *
 * The **account id** is an identifier, not a credential. It decides nothing on
 * its own, and the guards below need it on the public bind path — which rules
 * `appSecrets` out, because `__tests__/structure.test.ts` fails any public
 * function whose call graph reaches `decryptSecret`. So it is an environment
 * variable, synced like `APPLE_TEAM_ID` and `EAS_PROJECT_ID` are: an account
 * identifier that this public repository must not commit, but that nothing is
 * lost by a process holding in the clear.
 *
 * The **API token** is a credential, and a worse one than anything this
 * codebase has held: it creates buckets and mints keys across every customer
 * bucket, where the BYO setup credential is one customer's and lives for
 * seconds. It therefore belongs in `appSecrets` — encrypted at rest, set in
 * the staff console, fingerprint-displayed, rotatable — exactly as
 * `SEARCH_D1_API_TOKEN` does for the search provisioner, and **it is not read
 * anywhere in this module**. It arrives with the provisioning action, which is
 * an `internalAction` and may therefore open it.
 *
 * Splitting them is also what stops the guards failing open. A guard that
 * needed both would quietly permit everything it exists to refuse during a
 * token rotation, or on a deployment that had set only one of the two.
 *
 * ## One workspace, one bucket, named from something that cannot change
 *
 * `managedBucketName` derives from the workspace id: immutable, unique by
 * construction, and therefore incapable of colliding no matter how many
 * buckets exist. A slug would read better in a dashboard and is the wrong
 * answer — slugs are a global namespace with a reserved list and a rename
 * story, and a bucket name that can be typed by somebody else is a bucket name
 * that can be aimed somewhere else.
 *
 * The id is used **verbatim**, never case-folded. Lower-casing it would be the
 * one operation capable of mapping two distinct workspaces onto one bucket,
 * which is precisely the invariant this file exists to hold; an id carrying a
 * character R2 will not take must fail loudly here instead.
 *
 * ## What the guards can and cannot see
 *
 * They compare host labels against the account id, which catches every address
 * Cloudflare issues for an R2 bucket — `<account>.r2.cloudflarestorage.com`,
 * its jurisdiction variants, and the virtual-hosted `<bucket>.<account>.…`
 * form. They cannot see a **custom domain** a hostname resolves to, because
 * that is a DNS fact and not a string one. That is a known limit rather than
 * an oversight: the guards exist to stop an operator or a support engineer
 * pointing the wrong flow at our own account, and neither of those arrives
 * holding a CNAME. They are not, and must not be presented as, a defence
 * against somebody who already has our token.
 *
 * A refusal is also, unavoidably, a confirm/deny oracle for a guessed account
 * id: any signed-in caller can learn whether a 32-hex string is ours. That is
 * accepted rather than overlooked — `getStorageBinding` already returns a
 * binding's endpoint to every member of its workspace, so the moment managed
 * storage ships our account id is visible to every managed customer anyway.
 * An account id is an identifier; the token is the secret, and it is not here.
 */

import { ConvexError } from "convex/values";
import type { Id } from "../../_generated/dataModel";
import { bucketNameProblem, isPlausibleAccountId } from "./cloudflare";

/**
 * The account that holds customer data — managed buckets today, and the
 * per-context search databases once those move — and deliberately **not** the
 * account this deployment's own infrastructure lives in. See the module
 * comment.
 *
 * It will end up being the same value as `SEARCH_D1_ACCOUNT_ID`, which is one
 * fact written down twice and therefore a thing that drifts; consolidating
 * them is named as the follow-up in the decision doc. Do not add a test
 * asserting the two differ — they are meant to be equal.
 *
 * Absent is an ordinary state: a deployment nobody has configured simply does
 * not offer managed storage, and the BYO path is untouched.
 */
export const MANAGED_R2_ACCOUNT_ID_ENV_VAR = "MANAGED_R2_ACCOUNT_ID";

/**
 * What every managed bucket name starts with. A marker, not a namespace: the
 * bucket still holds `1-projects/foo.md` at its root like every other bucket
 * in this product.
 */
export const MANAGED_BUCKET_PREFIX = "ctx-";

/**
 * The operator credential that creates managed buckets, by name in `appSecrets`.
 *
 * A credential, so it is encrypted at rest, set in the staff console,
 * fingerprint-displayed and rotatable — exactly where `SEARCH_D1_API_TOKEN`
 * lives, and deliberately not beside `MANAGED_R2_ACCOUNT_ID` in an environment
 * variable. The id is needed by guards on public paths that may never reach a
 * decryptable secret; the token is needed by one internal action. One value
 * could not do both jobs, and a rotation of the token must not make those
 * guards fail open.
 */
export const MANAGED_R2_API_TOKEN_SECRET = "MANAGED_R2_API_TOKEN";

/**
 * The name of the one bucket belonging to this workspace.
 *
 * Deterministic and total: the same workspace always resolves to the same
 * bucket, so provisioning is idempotent and a retry after a half-finished
 * attempt finds the bucket it made last time rather than making a second one.
 *
 * Convex ids are lowercase alphanumeric and about 32 characters, so the result
 * sits inside R2's 3-63 character, lowercase-alphanumeric-and-hyphen rule.
 * That is checked rather than assumed, and **nothing is normalised on the way
 * in** — see the module comment on why case-folding here would be the one bug
 * capable of merging two workspaces into one bucket.
 */
export function managedBucketName(workspaceId: Id<"workspaces">): string {
  const name = `${MANAGED_BUCKET_PREFIX}${String(workspaceId)}`;
  const problem = bucketNameProblem(name);
  if (problem !== null) {
    throw new ConvexError({
      code: "MANAGED_BUCKET_NAME_INVALID",
      // The id is not a secret, but there is no reason to put it in an error a
      // client may render, and it is derivable from the workspace anyway.
      message: `A managed bucket name could not be derived for this workspace: ${problem}`,
    });
  }
  return name;
}

/**
 * The configured managed account id, or `null` where there is none.
 *
 * **Unset and malformed are different answers, and conflating them is the
 * failure mode this function exists to avoid.** A guard that reads "somebody
 * fat-fingered the value" as "there is no managed account" fails open on
 * precisely the deployment that has an account worth protecting, and does it
 * silently. So:
 *
 *  - absent or empty is `null` — an ordinary state. A self-hoster has no
 *    managed account and must not be told they have misconfigured one.
 *  - present but not an account id **throws**. That is a real cost — binding
 *    stops working until somebody fixes it — and it is the correct one,
 *    because the alternative is a guard that quietly does nothing on the one
 *    deployment holding the provisioning token.
 *
 * Trimmed and case-folded first, because a value that arrived through
 * `op read`, a file, or a copy out of a dashboard very often carries a
 * trailing newline or capitals — `lib/appSecrets.ts` learned the newline half
 * of this already — and an account id is hex, where case carries nothing.
 * Only a value still malformed after that generosity is an operator error.
 *
 * `env` is injectable to match every other module in this directory, and so a
 * test can describe a deployment without mutating the process.
 */
export function managedAccountId(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const raw = env[MANAGED_R2_ACCOUNT_ID_ENV_VAR];
  if (typeof raw !== "string") return null;
  const accountId = raw.trim().toLowerCase();
  if (accountId.length === 0) return null;
  if (!isPlausibleAccountId(accountId)) {
    throw new ConvexError({
      code: "MANAGED_ACCOUNT_MISCONFIGURED",
      // Deliberately does not echo the value. It is an account identifier and
      // this message can reach a client.
      message: `${MANAGED_R2_ACCOUNT_ID_ENV_VAR} is set but is not a Cloudflare account id.`,
    });
  }
  return accountId;
}

const REFUSAL_CODE = "MANAGED_ACCOUNT_NOT_ALLOWED";

/**
 * Refuse a customer-supplied Cloudflare account id that is ours.
 *
 * Nobody can act on the managed account without the managed token, so this
 * blocks nothing an attacker could otherwise do. It exists so that "the
 * customer-data account holds nothing of ours" is a property the
 * code enforces rather than a sentence in a decision document — and so that a
 * support engineer pasting the wrong id into the BYO provisioning flow gets a
 * refusal instead of a bucket in the wrong account.
 *
 * The configured id is passed in rather than read here, so that the one place
 * deciding what "ours" means is the caller and this stays a pure function a
 * test can drive without a process.
 */
export function refuseManagedAccountId(
  candidate: string,
  configuredAccountId: string | null,
): void {
  if (configuredAccountId === null) return;
  if (candidate.trim().toLowerCase() !== configuredAccountId.toLowerCase()) return;
  throw new ConvexError({
    code: REFUSAL_CODE,
    message:
      "That Cloudflare account cannot be used here. Use an account you own, " +
      "or choose managed storage instead.",
  });
}

/**
 * Refuse a pasted endpoint that addresses the managed account.
 *
 * Host **labels**, not a substring of the whole URL: a substring test also
 * fires on an account id sitting in a path or a query string, which is a
 * refusal about the wrong thing wearing the right message, and it says
 * nothing about which host the request would actually reach. Splitting the
 * hostname covers every form Cloudflare issues — the flat
 * `<account>.r2.cloudflarestorage.com`, the jurisdiction
 * `<account>.eu.r2.cloudflarestorage.com`, and the virtual-hosted
 * `<bucket>.<account>.r2.cloudflarestorage.com`.
 *
 * An unparseable endpoint is not refused here; `assertUsableEndpoint` rejects
 * it immediately afterwards for being unparseable, which is the accurate
 * message.
 */
export function refuseManagedEndpoint(
  endpoint: string,
  configuredAccountId: string | null,
): void {
  if (configuredAccountId === null) return;
  let hostname: string;
  try {
    hostname = new URL(endpoint).hostname;
  } catch {
    return;
  }
  const wanted = configuredAccountId.toLowerCase();
  const addressesUs = hostname
    .toLowerCase()
    .split(".")
    .some((label) => label === wanted);
  if (!addressesUs) return;
  throw new ConvexError({
    code: REFUSAL_CODE,
    message:
      "That endpoint cannot be used here. Connect storage you own, " +
      "or choose managed storage instead.",
  });
}
