/**
 * Multi-tenancy, OAuth, and the ways both are supposed to fail.
 *
 * Two workspaces are stood up on the **same provider, the same endpoint, and
 * adjacent bucket names** (`tenant-a` / `tenant-ab`), because that is the
 * arrangement where a prefix comparison, a `startsWith`, or a stale credential
 * actually leaks. Tenants on different providers would pass an isolation suite
 * that a one-character bug defeats.
 *
 * Two more are stood up on Dropbox, where that arrangement gets tighter still:
 * no bucket name and no per-tenant endpoint, so **the same two URLs and the
 * same customer-chosen folder, separated by the access token alone.**
 *
 * Offline and dependency-free: the control plane is an in-memory server
 * speaking the documented HTTP contract, the object store is an in-memory S3
 * backend the real `S3Store` signs requests against, and the Dropbox tenants
 * run against an in-memory Dropbox the real `DropboxStore` calls.
 *
 * ## Sabotage record
 *
 * A suite that cannot fail proves nothing, so this one was deliberately broken
 * three ways before it was trusted. No flag ships to do it — a switch that
 * disables tenancy is not something that belongs in a deployable artifact — so
 * these were run as temporary local edits and reverted:
 *
 * 1. **Tenant resolution returns the wrong workspace**, with the control plane
 *    reverting to the single-secret design where it trusts the workspace id the
 *    gateway asks for. 13 checks failed, including tenant A reading tenant B's
 *    note, tenant A's write landing in tenant B's bucket, and the byte-identical
 *    refusal collapsing.
 * 2. **`redirectUriMatches` weakened to `presented.startsWith(registered)`.**
 *    2 checks failed, including the `…/callback.evil` suffix attack.
 * 3. **PKCE not enforced** — `plain` accepted at the authorization endpoint and
 *    the verifier never compared. 2 checks failed.
 * 4. **The in-memory Dropbox ignores the bearer token** and serves every tenant
 *    out of one account — the shape of a gateway that built a store from the
 *    wrong binding. 2 checks failed, including the two tenants' identically
 *    pathed `1-projects/alpha.md` resolving to one file. Sabotaging the *stub*
 *    rather than the source is the point here: a backend that cannot tell its
 *    accounts apart would make every Dropbox isolation claim below vacuous.
 * 5. **The store factory drops `rootPrefix` for Dropbox.** 4 checks failed
 *    here, because a folder the customer chose is not something the adapter may
 *    lose track of. See `storeFactory.test.mjs` for the rest of that record.
 * 6. **The loopback exception's host and scheme comparisons**, one at a time.
 *    Before the two checks added beside the port attack, each failed
 *    **nothing**; now each fails 1. The host half is the serious one: the
 *    branch is reached whenever the *registered* URI is loopback, which is
 *    every CLI client, so without the equality `http://127.0.0.1/callback`
 *    matches `http://evil.test/callback` and the authorization code goes to
 *    whoever owns that name. Sabotage 2 above covered the exact-match path and
 *    this one is the exception carved out of it — the carve-out needed its own
 *    record, because "ignores the port and nothing else" was a claim about
 *    three fields with one of them asserted.
 * 7. **`normalizeClientName`, one filter at a time, then both, then the
 *    character class from both sides.** Dropping the hostile-character strip
 *    fails **2** and *not* the line-break check, because the whitespace
 *    collapse catches `\n` as well — two guards over one input, each of which
 *    reads as covered alone. Dropping the collapse alone fails **1**; dropping
 *    both fails **4**, which is the number that says what is actually held.
 *    Capping before the collapse rather than after fails 1, and removing the
 *    trailing-surrogate trim fails 1 — that last is a defect the function would
 *    introduce itself, so it is sabotaged like any other.
 *
 *    The class is pinned in **both** directions, which is the part worth
 *    keeping: widening it back to all of `Cf` — the first version of this fix —
 *    fails **2**, because it takes apart a Persian name and an emoji sequence;
 *    narrowing it to `Cc` alone also fails **2**, because the bidi overrides and
 *    the invisible spacers walk through. A normaliser is the kind of function
 *    that only ever gets tested for doing too little.
 *
 * This file used to hold every one of these checks directly, in one
 * 2,345-line function that built a single shared harness (a real S3 backend,
 * a real Dropbox backend, and a real control-plane stub) and ran every
 * section against it in order — nearly every section reads state a previous
 * one left behind (a listing's own text, a response object, an authorization
 * flow's client id and PKCE verifier), most sharply in §14's rollup, which
 * asserts that no response anywhere in the whole run ever said a secret.
 *
 * It is now a thin facade over `test/tenancy/*.test.mjs`, split by
 * responsibility, that builds that same harness once and threads it through
 * every section in its original order, so `import { runTenancyChecks } from
 * "./tenancy.test.mjs"` keeps working unchanged and the checks run exactly as
 * they did before.
 */

import { createTenancyHarness } from "./tenancy/fixtures.mjs";
import { runTenancyCrossTenantIsolationChecks } from "./tenancy/crossTenantIsolation.test.mjs";
import { runTenancyResolutionChecks } from "./tenancy/resolutionScopeRevocation.test.mjs";
import { runTenancyDiscoveryChecks } from "./tenancy/discoveryAndStaticToken.test.mjs";
import { runTenancyRegistrationAndPkceChecks } from "./tenancy/registrationAndPkce.test.mjs";
import { runTenancyRedirectAndTokenChecks } from "./tenancy/redirectAndToken.test.mjs";
import { runTenancyAuditAndSecretChecks } from "./tenancy/auditAndSecrets.test.mjs";

export async function runTenancyChecks(check) {
  const harness = await createTenancyHarness();
  await runTenancyCrossTenantIsolationChecks(check, harness);
  await runTenancyResolutionChecks(check, harness);
  await runTenancyDiscoveryChecks(check, harness);
  await runTenancyRegistrationAndPkceChecks(check, harness);
  await runTenancyRedirectAndTokenChecks(check, harness);
  await runTenancyAuditAndSecretChecks(check, harness);
  harness.restoreAll();
}
