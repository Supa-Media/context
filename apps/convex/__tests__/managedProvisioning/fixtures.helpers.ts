/**
 * THE BUCKET A CUSTOMER PAID FOR, AND THE FOUR WAYS THAT GOES WRONG.
 *
 * Managed provisioning is the one flow in this product where a failure happens
 * **after** money has changed hands, so what these assert is mostly what it
 * refuses to do:
 *
 * 1. **A retry cannot make a second bucket.** The screen after a failure says
 *    so in exactly those words, and it is true because the bucket is named
 *    from the immutable workspace id and an existing one is adopted. If this
 *    ever stops holding, somebody who pressed twice owns two buckets and their
 *    notes are in one of them.
 * 2. **It never replaces a live binding before a verified copy.** A binding is
 *    what a person's notes are behind. A redelivered webhook, or a customer
 *    who reconnects while copying, must not lose them.
 * 3. **Neither credential is ever stored.** Not the operator token it opens,
 *    and not the token it mints — what goes in the row is the SHA-256 the S3
 *    API expects, which cannot be turned back into a token.
 * 4. **A managed binding is indistinguishable from a pasted one**, because the
 *    gateway, the adapter and the privacy engine must have no idea who is
 *    paying (`storage-and-credentials.md`).
 *
 * Everything here drives a stubbed Cloudflare. Nothing in this file has run
 * against the real API — there is no managed account in this environment — so
 * the request *shapes* are documentation-derived and only the behaviour around
 * them is proven. The module header says the same and says what to check on
 * the first live run.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   adoption removed, so a taken name fails the retry                     1
 *   cutover accepting a different source binding                          1
 *   the minted token stored instead of its digest                        1
 *   the entitlement check dropped, so an unpaid context provisions        1
 *   the webhook scheduling provisioning for a plan with no managed choice 1
 */

import { vi } from "vitest";
import {
  createUser,
  createWorkspace,
  seedAppSecret,
  type TestConvex,
} from "../fixtures.helpers";
import {
  MANAGED_R2_ACCOUNT_ID_ENV_VAR,
  MANAGED_R2_API_TOKEN_SECRET,
} from "../../functions/lib/managedStorage";

export const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
export const OPERATOR_TOKEN = "cf_operator_obviously_fake";
export const MINTED_TOKEN = "cf_minted_obviously_fake";
export const MINTED_ID = "0123456789abcdef0123456789abcde0";

/**
 * Cloudflare, as a script of answers.
 *
 * Every call is recorded so a test can assert what was *not* asked as well as
 * what was — "the bucket was created once" is a claim about the absence of a
 * second call.
 */
export function stubCloudflare(
  options: { bucketTaken?: boolean; mintFails?: boolean } = {},
) {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal("fetch", async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    const ok = (result: unknown) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ success: true, errors: [], result }),
    });
    if (url.includes("/tokens/permission_groups")) {
      return ok([
        { id: "pg_write", name: "Workers R2 Storage Bucket Item Write" },
      ]);
    }
    if (url.includes("/r2/buckets") && method === "POST") {
      if (options.bucketTaken === true) {
        return {
          ok: false,
          status: 409,
          text: async () =>
            JSON.stringify({
              success: false,
              errors: [
                {
                  code: 10004,
                  message: "The bucket you tried to create already exists",
                },
              ],
            }),
        };
      }
      return ok({ name: "created" });
    }
    if (url.includes("/tokens") && method === "POST") {
      if (options.mintFails === true) {
        return {
          ok: false,
          status: 403,
          text: async () =>
            JSON.stringify({
              success: false,
              errors: [{ code: 9109, message: "Unauthorized" }],
            }),
        };
      }
      return ok({ id: MINTED_ID, value: MINTED_TOKEN });
    }
    return ok({});
  });
  return { calls };
}

export async function paidContext(t: TestConvex, slug: string) {
  const owner = await createUser(t, `${slug}@example.invalid`);
  const workspaceId = await createWorkspace(t, owner, slug);
  await t.run(async (ctx) => {
    await ctx.db.insert("workspacePlans", {
      workspaceId,
      managedStorage: true,
      fastSearch: false,
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
  return { owner, workspaceId };
}

export async function configured(t: TestConvex) {
  await seedAppSecret(t, MANAGED_R2_API_TOKEN_SECRET, OPERATOR_TOKEN);
  vi.stubEnv(MANAGED_R2_ACCOUNT_ID_ENV_VAR, ACCOUNT_ID);
}

export function binding(t: TestConvex) {
  return t.run((ctx) => ctx.db.query("storageBindings").unique());
}

