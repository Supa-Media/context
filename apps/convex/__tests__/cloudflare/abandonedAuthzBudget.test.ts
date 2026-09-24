import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { encryptSecret, requireKeyset } from "../../functions/lib/crypto";
import {
  scopedTokenName,
} from "../../functions/lib/cloudflare";
import {
  asUser,
  captureError,
  createUser,
  createWorkspace,
  drainScheduled,
  errorCode,
  type TestConvex,
} from "../fixtures.helpers";
import { memoryS3 } from "../storeStub.helpers";
import {
  FAKE_ACCOUNT_ID,
  SETUP_TOKEN,
  MINTED_TOKEN_VALUE,
  MINTED_TOKEN_ID,
  BUCKET,
  provisioning,
  withoutDigest,
  startProvisioning,
  bindingRow,
  provisioningRow,
  everyStoredDocument,
  cloudflareStub,
} from "./fixtures.helpers";

describe("a token minted and then not stored is taken back", () => {
  test("a failure after the mint deletes the token and says the bucket is there", async () => {
    const { t, owner, workspaceId, cloudflare } = await provisioning();
    withoutDigest();

    await startProvisioning(t, owner, workspaceId);
    await drainScheduled(t);

    // The token was minted, so it was deleted again — by id, which existed
    // nowhere but the action's own stack frame.
    expect(cloudflare.calls.map((call) => `${call.method} ${call.path}`)).toContain(
      `DELETE /client/v4/accounts/${FAKE_ACCOUNT_ID}/tokens/${MINTED_TOKEN_ID}`,
    );

    const row = await provisioningRow(t, workspaceId);
    expect(row!.errorCode).toBe("PROVISION_FAILED");
    expect(row!.error).toMatch(/was created in your Cloudflare account/i);
    // Nothing to go and clean up, so nothing is asked of them.
    expect(row!.error).not.toContain(scopedTokenName(BUCKET));

    expect(await bindingRow(t, workspaceId)).toBeNull();
    expect(await everyStoredDocument(t)).not.toContain(MINTED_TOKEN_VALUE);
    expect(await everyStoredDocument(t)).not.toContain(SETUP_TOKEN);
  });

  test("a token we could not delete is named, because nothing else will name it", async () => {
    const { t, owner, workspaceId } = await provisioning({
      tokenRevokeFailure: {
        status: 403,
        errors: [{ code: 9109, message: "Unauthorized to access requested resource" }],
      },
    });
    withoutDigest();

    await startProvisioning(t, owner, workspaceId);
    await drainScheduled(t);

    const row = await provisioningRow(t, workspaceId);
    expect(row!.error).toContain(scopedTokenName(BUCKET));
    expect(row!.error).toMatch(/dashboard/i);
    expect(row!.error).not.toMatch(/nothing was (changed|created)/i);
    // The token's value is still nowhere, even though the token outlived us.
    expect(await everyStoredDocument(t)).not.toContain(MINTED_TOKEN_VALUE);
  });
});

/* -------------------------------------------------------------------------- */
/*                 an attempt that never finishes gives it up                 */
/* -------------------------------------------------------------------------- */

/**
 * THE INVARIANT THIS TABLE EXISTS FOR, WHEN NOTHING GOES TO PLAN.
 *
 * "There is no steady state in which the control plane holds an account-level
 * cloud credential" (CLAUDE.md) held only for attempts that finished. Both
 * paths that destroy the envelope need the scheduled action to reach them, and
 * a job lost to a deploy, an eviction, or a throw on the way to recording a
 * failure all leave a `pending` row holding the customer's Cloudflare account
 * credential — and, because a pending row refuses every further attempt, an
 * owner who cannot start again either.
 */
describe("an abandoned attempt stops holding the credential", () => {
  /** A row exactly as a lost scheduled job leaves it: pending, sealed, stale. */
  async function stuckAttempt(
    t: TestConvex,
    owner: Id<"users">,
    workspaceId: Id<"workspaces">,
    overrides: Record<string, unknown> = {},
  ) {
    const encryptedSetupCredential = await encryptSecret(SETUP_TOKEN, requireKeyset(), {
      workspaceId,
    });
    return await t.run((ctx) =>
      ctx.db.insert("cloudflareProvisioning", {
        workspaceId,
        requestedBy: owner,
        credentialSource: "api-token" as const,
        encryptedSetupCredential,
        accountId: FAKE_ACCOUNT_ID,
        bucket: BUCKET,
        jurisdiction: "default" as const,
        status: "pending" as const,
        createdAt: Date.now() - 60 * 60 * 1000,
        updatedAt: Date.now() - 60 * 60 * 1000,
        expiresAt: Date.now() - 45 * 60 * 1000,
        ...overrides,
      }),
    );
  }

  test("the sweep destroys the envelope and says what it cannot know", async () => {
    const { t, owner, workspaceId } = await provisioning();
    await stuckAttempt(t, owner, workspaceId);
    expect(await everyStoredDocument(t)).toContain("encryptedSetupCredential");

    const result = await t.mutation(
      internal.functions.cloudflare.purgeExpiredProvisioning,
      {},
    );
    expect(result).toEqual({ expired: 1, deleted: 0, moreRemaining: false });

    const row = await provisioningRow(t, workspaceId);
    expect(row!.status).toBe("failed");
    expect(row!.errorCode).toBe("PROVISION_EXPIRED");
    expect(row!.encryptedSetupCredential).toBeUndefined();
    expect(await everyStoredDocument(t)).not.toContain(SETUP_TOKEN);

    // An abandoned attempt may have got as far as creating the bucket, and
    // nobody knows whether it did — so it says that rather than either of the
    // two confident answers.
    expect(row!.error).toMatch(/may or may not have been created/i);
    expect(row!.error).toContain(BUCKET);

    const events = await asUser(t, owner).query(api.functions.audit.listEvents, {
      workspaceId,
    });
    expect(events.map((event) => event.action)).toContain("storage.provision_failed");
  });

  test("a row from before the deadline existed is treated as long expired", async () => {
    const { t, owner, workspaceId } = await provisioning();
    await stuckAttempt(t, owner, workspaceId, { expiresAt: undefined });

    await t.mutation(internal.functions.cloudflare.purgeExpiredProvisioning, {});
    const row = await provisioningRow(t, workspaceId);
    expect(row!.status).toBe("failed");
    expect(row!.encryptedSetupCredential).toBeUndefined();
  });

  test("a stale pending row does not block a fresh attempt", async () => {
    const { t, owner, workspaceId } = await provisioning();
    await stuckAttempt(t, owner, workspaceId);

    // No sweep in between: the owner should not have to wait an hour for a
    // cron to unblock a bucket they are trying to create now.
    await startProvisioning(t, owner, workspaceId);
    await drainScheduled(t);

    expect(await provisioningRow(t, workspaceId)).toBeNull();
    expect((await bindingRow(t, workspaceId))!.accessKeyId).toBe(MINTED_TOKEN_ID);
  });

  test("an attempt that is actually running is left alone", async () => {
    const { t, owner, workspaceId } = await provisioning();
    await stuckAttempt(t, owner, workspaceId, {
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    const result = await t.mutation(
      internal.functions.cloudflare.purgeExpiredProvisioning,
      {},
    );
    expect(result).toEqual({ expired: 0, deleted: 0, moreRemaining: false });
    expect((await provisioningRow(t, workspaceId))!.status).toBe("pending");
  });

  /**
   * The second half of the deadline: once a row has failed it holds no
   * credential, only an explanation, so it is kept for a week and then deleted.
   * A failed row must also stop matching the sweep, or a backlog of them would
   * crowd out the pending rows that matter.
   */
  test("a failed row is deleted once its explanation is stale", async () => {
    const { t, owner, workspaceId } = await provisioning();
    await stuckAttempt(t, owner, workspaceId);

    // First sweep: the attempt is retired and its deadline moves forward.
    await t.mutation(internal.functions.cloudflare.purgeExpiredProvisioning, {});
    const retired = await provisioningRow(t, workspaceId);
    expect(retired!.expiresAt).toBeGreaterThan(Date.now());

    // A second sweep the same day changes nothing.
    expect(
      await t.mutation(internal.functions.cloudflare.purgeExpiredProvisioning, {}),
    ).toEqual({ expired: 0, deleted: 0, moreRemaining: false });

    // A week later it is a row nobody reads.
    await t.run((ctx) =>
      ctx.db.patch(retired!._id, { expiresAt: Date.now() - 1000 }),
    );
    expect(
      await t.mutation(internal.functions.cloudflare.purgeExpiredProvisioning, {}),
    ).toEqual({ expired: 0, deleted: 1, moreRemaining: false });
    expect(await provisioningRow(t, workspaceId)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                             who may ask for it                             */
/* -------------------------------------------------------------------------- */

describe("only an owner may create storage for a context", () => {
  test("a member of another context cannot provision into this one", async () => {
    const { t, workspaceId, cloudflare } = await provisioning();
    const stranger = await createUser(t, "stranger@example.invalid");

    const error = await captureError(() =>
      startProvisioning(t, stranger, workspaceId),
    );
    // The same refusal a non-existent workspace gets: a stranger learns
    // nothing about whether this context is here.
    expect(errorCode(error)).toBe("WORKSPACE_NOT_FOUND");
    expect(cloudflare.calls).toEqual([]);
    expect(await provisioningRow(t, workspaceId)).toBeNull();
  });

  /**
   * Our own account is not one a customer may provision into.
   *
   * This path exists to make a bucket **in the customer's account**; a bucket
   * it made in ours would be a customer bucket nobody could hand over, which
   * is the whole promise managed storage rests on. Driven through the real
   * action rather than only against the pure guard, because with only the unit
   * test the call in `provisionCloudflareR2` could be deleted and the suite
   * would stay green.
   */
  test("the account holding managed buckets is refused, and Cloudflare is never called", async () => {
    const managed = "0123456789abcdef0123456789abcdef";
    const previous = process.env.MANAGED_R2_ACCOUNT_ID;
    process.env.MANAGED_R2_ACCOUNT_ID = managed;
    try {
      const { t, owner, workspaceId, cloudflare } = await provisioning();

      for (const accountId of [managed, managed.toUpperCase(), `  ${managed}  `]) {
        expect(
          errorCode(
            await captureError(() =>
              startProvisioning(t, owner, workspaceId, {
                credential: { source: "api-token", apiToken: SETUP_TOKEN, accountId },
              }),
            ),
          ),
          `${accountId} was accepted`,
        ).toBe("MANAGED_ACCOUNT_NOT_ALLOWED");
      }

      expect(cloudflare.calls).toEqual([]);
      expect(await provisioningRow(t, workspaceId)).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.MANAGED_R2_ACCOUNT_ID;
      else process.env.MANAGED_R2_ACCOUNT_ID = previous;
    }
  });

  test("an editor cannot provision, and nothing is queued when they try", async () => {
    const { t, workspaceId, cloudflare } = await provisioning();
    const editor = await createUser(t, "editor@example.invalid");
    await t.run((ctx) =>
      ctx.db.insert("workspaceMembers", {
        workspaceId,
        userId: editor,
        role: "editor",
        joinedAt: Date.now(),
      }),
    );

    const error = await captureError(() => startProvisioning(t, editor, workspaceId));
    expect(errorCode(error)).toBe("INSUFFICIENT_ROLE");
    expect(cloudflare.calls).toEqual([]);
    expect(await provisioningRow(t, workspaceId)).toBeNull();
  });

  test("the setup link is owner-only", async () => {
    const { t, owner, workspaceId } = await provisioning();
    const member = await createUser(t, "member@example.invalid");
    await t.run((ctx) =>
      ctx.db.insert("workspaceMembers", {
        workspaceId,
        userId: member,
        role: "member",
        joinedAt: Date.now(),
      }),
    );

    expect(
      errorCode(
        await captureError(() =>
          asUser(t, member).query(api.functions.cloudflare.getCloudflareSetupLink, {
            workspaceId,
          }),
        ),
      ),
    ).toBe("INSUFFICIENT_ROLE");

    const link = await asUser(t, owner).query(
      api.functions.cloudflare.getCloudflareSetupLink,
      { workspaceId },
    );
    expect(link.suggestedBucket).toBe("atlas");
    expect(link.accountIdRequired).toBe(true);
  });

  test("status is readable by any member, the credential by nobody", async () => {
    const { t, owner, workspaceId } = await provisioning();
    const member = await createUser(t, "member@example.invalid");
    await t.run((ctx) =>
      ctx.db.insert("workspaceMembers", {
        workspaceId,
        userId: member,
        role: "member",
        joinedAt: Date.now(),
      }),
    );
    await startProvisioning(t, owner, workspaceId);

    const view = await asUser(t, member).query(
      api.functions.cloudflare.getCloudflareProvisioning,
      { workspaceId },
    );
    expect(view!.status).toBe("pending");
    expect(JSON.stringify(view)).not.toContain(SETUP_TOKEN);
    expect(Object.keys(view!)).not.toContain("encryptedSetupCredential");
  });
});

/* -------------------------------------------------------------------------- */
/*                          refusals and the in-flight row                    */
/* -------------------------------------------------------------------------- */

describe("what is refused before Cloudflare is ever called", () => {
  test("an implausible account id, an illegal bucket name, an empty token", async () => {
    const { t, owner, workspaceId, cloudflare } = await provisioning();

    expect(
      errorCode(
        await captureError(() =>
          startProvisioning(t, owner, workspaceId, {
            credential: {
              source: "api-token",
              apiToken: SETUP_TOKEN,
              accountId: "not-an-account",
            },
          }),
        ),
      ),
    ).toBe("INVALID_ACCOUNT_ID");

    expect(
      errorCode(
        await captureError(() =>
          startProvisioning(t, owner, workspaceId, { bucket: "Not A Bucket" }),
        ),
      ),
    ).toBe("INVALID_BUCKET_NAME");

    expect(
      errorCode(
        await captureError(() =>
          startProvisioning(t, owner, workspaceId, {
            credential: { source: "api-token", apiToken: "  ", accountId: FAKE_ACCOUNT_ID },
          }),
        ),
      ),
    ).toBe("INVALID_CREDENTIAL");

    expect(cloudflare.calls).toEqual([]);
    expect(await provisioningRow(t, workspaceId)).toBeNull();
  });

  test("two runs at once would orphan a credential, so the second is refused", async () => {
    const { t, owner, workspaceId } = await provisioning();
    await startProvisioning(t, owner, workspaceId);

    expect(
      errorCode(
        await captureError(() =>
          startProvisioning(t, owner, workspaceId, { bucket: "atlas-again" }),
        ),
      ),
    ).toBe("PROVISION_IN_PROGRESS");
  });

  test("a failed attempt can simply be retried", async () => {
    const { t, owner, workspaceId } = await provisioning({
      bucketFailure: { status: 500, errors: [{ code: 1, message: "boom" }] },
    });
    await startProvisioning(t, owner, workspaceId);
    await drainScheduled(t);
    expect((await provisioningRow(t, workspaceId))!.status).toBe("failed");

    // Cloudflare recovers; the same call goes through and the stale failure is
    // not left sitting next to a working binding.
    const working = cloudflareStub();
    const bucket = memoryS3(BUCKET);
    vi.stubGlobal("fetch", async (input: URL | RequestInfo, init: RequestInit = {}) => {
      const url = new URL(typeof input === "string" ? input : String(input));
      return url.hostname === "api.cloudflare.com"
        ? await working.fetchImpl(input, init)
        : await bucket.fetchImpl(input, init);
    });
    await startProvisioning(t, owner, workspaceId);
    await drainScheduled(t);

    expect(await provisioningRow(t, workspaceId)).toBeNull();
    expect((await bindingRow(t, workspaceId))!.accessKeyId).toBe(MINTED_TOKEN_ID);
  });

  test("dismissing a stuck attempt destroys the sealed credential now", async () => {
    const { t, owner, workspaceId } = await provisioning();
    await startProvisioning(t, owner, workspaceId);
    expect((await provisioningRow(t, workspaceId))!.encryptedSetupCredential).toBeDefined();

    const dismissed = await asUser(t, owner).mutation(
      api.functions.cloudflare.dismissProvisioning,
      { workspaceId },
    );
    expect(dismissed).toEqual({ dismissed: true });
    expect(await provisioningRow(t, workspaceId)).toBeNull();
    expect(await everyStoredDocument(t)).not.toContain(SETUP_TOKEN);

    // The job that was already queued finds nothing to do and writes no
    // binding, rather than finishing a run the owner cancelled.
    await drainScheduled(t);
    expect(await bindingRow(t, workspaceId)).toBeNull();
  });

  test("dismissing is owner-only, and is a no-op when there is nothing to dismiss", async () => {
    const { t, owner, workspaceId } = await provisioning();
    const editor = await createUser(t, "editor@example.invalid");
    await t.run((ctx) =>
      ctx.db.insert("workspaceMembers", {
        workspaceId,
        userId: editor,
        role: "editor",
        joinedAt: Date.now(),
      }),
    );

    expect(
      await asUser(t, owner).mutation(api.functions.cloudflare.dismissProvisioning, {
        workspaceId,
      }),
    ).toEqual({ dismissed: false });

    await startProvisioning(t, owner, workspaceId);
    expect(
      errorCode(
        await captureError(() =>
          asUser(t, editor).mutation(api.functions.cloudflare.dismissProvisioning, {
            workspaceId,
          }),
        ),
      ),
    ).toBe("INSUFFICIENT_ROLE");
    expect((await provisioningRow(t, workspaceId))!.status).toBe("pending");
  });
});

/* -------------------------------------------------------------------------- */

/**
 * The provisioning budget belongs to the context, not to the deployment.
 *
 * `PROVISION_LIMIT` is five accepted bucket creations per hour, and its own
 * comment says why: every accepted request creates real objects in a customer's
 * cloud account, so unlimited is a way to fill somebody's account with buckets
 * using a credential they gave us for one. The counter it spends is the thing
 * that has to be theirs alone.
 *
 * Nothing reached it. `beginProvisioning` refuses a second attempt while the
 * first is pending, so every test here makes one or two calls and the limit
 * never engages — which is how the suite stayed green with `${args.workspaceId}`
 * dropped from the key. Keyed globally, five failed attempts anywhere in the
 * deployment stop every other customer from creating storage at all, at the one
 * moment in their life with us where nothing works yet and there is nothing to
 * fall back to.
 *
 * ## Two wrong keys, and why it takes two neighbours to rule out both
 *
 * `:all` and `:${args.actorUserId}` are different mistakes, and a second
 * *tenant* only catches the first — two owners have different ids either way.
 * The same owner's second context is what refutes a budget keyed by the
 * caller, and it is the one that matters most here, because the ceiling exists
 * to protect one Cloudflare account from being filled with buckets: a shared
 * workspace with three owners would get three times the ceiling against the
 * same account.
 *
 * ## Why each attempt is marked failed first
 *
 * The refusals in this mutation throw, and a throw rolls the transaction back
 * — the counted request with it. So an attempt that is refused for being a
 * duplicate spends nothing, and the only way to reach the limit is five
 * attempts that are *accepted*. That is the shape production has: a run that
 * fails leaves `failed` on the row, and `a failed attempt can simply be
 * retried`. Patching the row between calls is that retry, without five round
 * trips through a stubbed Cloudflare.
 *
 * Sabotage, as failing tests across the whole `apps/convex` suite:
 *
 *   `storage.provision:all`                                          0 -> 1
 *   `storage.provision:${args.actorUserId}`                          0 -> 1
 *   the `consumeRateLimit` call deleted outright                          1
 */
describe("the provisioning budget is one context's, not everybody's", () => {
  test("a second context can still create storage after the first spends its budget", async () => {
    const { t, owner, workspaceId } = await provisioning();
    const mine = await createWorkspace(t, owner, "bravo");
    const neighbour = await createUser(t, "neighbour@example.invalid");
    const theirs = await createWorkspace(t, neighbour, "charlie");

    /** What a run that did not get there leaves behind. */
    const markFailed = () =>
      t.run(async (ctx) => {
        const row = await ctx.db
          .query("cloudflareProvisioning")
          .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
          .unique();
        if (row !== null) await ctx.db.patch(row._id, { status: "failed" });
      });

    let spent = 0;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await markFailed();
      try {
        await startProvisioning(t, owner, workspaceId);
        spent += 1;
      } catch {
        break;
      }
    }
    expect(spent).toBeGreaterThan(0);
    expect(spent).toBeLessThan(20);
    await markFailed();
    expect(
      errorCode(await captureError(() => startProvisioning(t, owner, workspaceId))),
    ).toBe("RATE_LIMITED");

    // Neither of the other two contexts has asked for anything, so both first
    // buckets are accepted: the owner's own second context rules out a budget
    // keyed by the caller, and the neighbour's is the cross-tenant claim.
    expect(
      await startProvisioning(t, owner, mine, { bucket: "bravo-context" }),
    ).toMatchObject({ status: "pending" });
    expect(
      await startProvisioning(t, neighbour, theirs, { bucket: "charlie-context" }),
    ).toMatchObject({ status: "pending" });
  });
});
