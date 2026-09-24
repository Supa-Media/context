import { describe, expect, test, vi } from "vitest";
import { api } from "../../_generated/api";
import { decryptSecret, requireKeyset } from "../../functions/lib/crypto";
import {
  deriveS3SecretAccessKey,
} from "../../functions/lib/cloudflare";
import {
  asUser,
  createWorkspace,
  drainScheduled,
} from "../fixtures.helpers";
import { memoryS3 } from "../storeStub.helpers";
import {
  FAKE_ACCOUNT_ID,
  SETUP_TOKEN,
  MINTED_TOKEN_VALUE,
  MINTED_TOKEN_ID,
  BUCKET,
  CloudflareFailure,
  cloudflareStub,
  provisioning,
  useCloudflare,
  startProvisioning,
  bindingRow,
  provisioningRow,
  everyStoredDocument,
} from "./fixtures.helpers";

describe("the setup credential does not survive the flow", () => {
  /**
   * THE TEST THIS FEATURE EXISTS UNDER.
   *
   * Not "it is not in the binding" — *no table*, including the one that briefly
   * holds it, and including the audit trail, and including anything a public
   * function hands back. Sabotage it by having the flow store or return the
   * token and this fails.
   */
  test("the token appears in no table and in no public return value", async () => {
    const { t, owner, workspaceId } = await provisioning();

    const started = await startProvisioning(t, owner, workspaceId);
    expect(JSON.stringify(started)).not.toContain(SETUP_TOKEN);

    // Checked *before* the scheduled job as well as after it. The in-flight row
    // is deleted on success, so a leak into it would otherwise be tidied away
    // by the very thing that made it — and the window it exists in is exactly
    // the window this feature adds.
    expect(await everyStoredDocument(t)).not.toContain(SETUP_TOKEN);

    await drainScheduled(t);

    expect(await everyStoredDocument(t)).not.toContain(SETUP_TOKEN);
    // The minted token's own value is a Cloudflare credential too: only its
    // SHA-256 is ever stored, so the value itself must be absent as well.
    expect(await everyStoredDocument(t)).not.toContain(MINTED_TOKEN_VALUE);

    const view = asUser(t, owner);
    const returned = JSON.stringify([
      await view.query(api.functions.cloudflare.getCloudflareProvisioning, {
        workspaceId,
      }),
      await view.query(api.functions.cloudflare.getCloudflareSetupLink, { workspaceId }),
      await view.query(api.functions.storage.getStorageBinding, { workspaceId }),
      await view.query(api.functions.audit.listEvents, { workspaceId }),
    ]);
    expect(returned).not.toContain(SETUP_TOKEN);
    expect(returned).not.toContain(MINTED_TOKEN_VALUE);
  });

  /**
   * THE SEALED ENVELOPE IS NOT A CONSOLATION PRIZE EITHER.
   *
   * A test that only searches for the plaintext passes happily while a public
   * query hands out the ciphertext, which is the same disclosure with an
   * offline step in front of it — `functions/storage.ts` says exactly this
   * about `encryptedSecretAccessKey`, and the rule is not weaker here because
   * the credential is more powerful. Checked while the attempt is still in
   * flight, because that is the only moment an envelope exists to leak.
   */
  test("no public function hands out the sealed envelope", async () => {
    const { t, owner, workspaceId } = await provisioning();
    await startProvisioning(t, owner, workspaceId);

    const envelope = (await provisioningRow(t, workspaceId))!.encryptedSetupCredential!;
    expect(envelope.length).toBeGreaterThan(20);

    const view = asUser(t, owner);
    const returned = JSON.stringify([
      await view.query(api.functions.cloudflare.getCloudflareProvisioning, {
        workspaceId,
      }),
      await view.query(api.functions.cloudflare.getCloudflareSetupLink, { workspaceId }),
      await view.query(api.functions.storage.getStorageBinding, { workspaceId }),
      await view.query(api.functions.audit.listEvents, { workspaceId }),
    ]);
    expect(returned).not.toContain(envelope);
  });

  /** The sealed envelope is not a consolation prize — it goes too. */
  test("nothing is left sealed on the row either", async () => {
    const { t, owner, workspaceId } = await provisioning();
    await startProvisioning(t, owner, workspaceId);

    // Before the scheduled job runs, the envelope is on the row — and it is an
    // envelope, not the token.
    const pending = await provisioningRow(t, workspaceId);
    expect(pending!.status).toBe("pending");
    expect(pending!.encryptedSetupCredential).toBeDefined();
    expect(pending!.encryptedSetupCredential).not.toContain(SETUP_TOKEN);
    expect(
      await decryptSecret(pending!.encryptedSetupCredential!, requireKeyset(), {
        workspaceId,
      }),
    ).toBe(SETUP_TOKEN);

    await drainScheduled(t);
    expect(await provisioningRow(t, workspaceId)).toBeNull();
  });

  /**
   * The envelope is bound to its workspace, exactly like a storage secret, so
   * a row copied into another context yields a decrypt failure rather than
   * somebody else's Cloudflare account.
   */
  test("the envelope only opens in the workspace it was sealed for", async () => {
    const { t, owner, workspaceId } = await provisioning();
    const otherWorkspace = await createWorkspace(t, owner, "borealis");
    await startProvisioning(t, owner, workspaceId);

    const pending = await provisioningRow(t, workspaceId);
    await expect(
      decryptSecret(pending!.encryptedSetupCredential!, requireKeyset(), {
        workspaceId: otherWorkspace,
      }),
    ).rejects.toThrow();
  });

  /** A failure keeps the explanation and drops the credential. */
  test("a failed attempt keeps its reason and loses its credential", async () => {
    const { t, owner, workspaceId } = await provisioning({
      bucketFailure: {
        status: 403,
        errors: [{ code: 10042, message: "Please enable R2 through the Cloudflare Dashboard." }],
      },
    });
    await startProvisioning(t, owner, workspaceId);
    await drainScheduled(t);

    const row = await provisioningRow(t, workspaceId);
    expect(row!.status).toBe("failed");
    expect(row!.encryptedSetupCredential).toBeUndefined();
    expect(await everyStoredDocument(t)).not.toContain(SETUP_TOKEN);
  });

  /**
   * Nothing a provider says about a credential ends up stored. Cloudflare has
   * no reason to echo a token back, which is exactly why this is checked: the
   * recorded string is provider text on a surface every member can read.
   */
  test("provider text that quotes the token is redacted before it is stored", async () => {
    const { t, owner, workspaceId } = await provisioning({
      bucketFailure: {
        status: 400,
        errors: [{ code: 1234, message: `Invalid token ${SETUP_TOKEN} supplied` }],
      },
    });
    await startProvisioning(t, owner, workspaceId);
    await drainScheduled(t);

    const row = await provisioningRow(t, workspaceId);
    expect(row!.error).toBeDefined();
    expect(row!.error).not.toContain(SETUP_TOKEN);
    expect(row!.error).toContain("[redacted]");
    expect(await everyStoredDocument(t)).not.toContain(SETUP_TOKEN);
  });
});

/**
 * THE ONE BODY THAT CAN CARRY A CREDENTIAL.
 *
 * `describeErrors` falls back to the raw body when Cloudflare sends no
 * structured errors, and `POST /accounts/:id/tokens` is the only call here
 * whose body ever contains a live token. At that moment the value is not yet on
 * the action's secret list — it cannot be, because the call that would have
 * returned it threw — so redaction downstream could not save it even in
 * principle. It is stripped at the source instead.
 */
describe("a provider body never carries a credential onto the row", () => {
  test("a mint response that echoes the token is scrubbed before it is recorded", async () => {
    const { t, owner, workspaceId } = await provisioning({
      tokenFailureBody: {
        status: 200,
        body: {
          success: false,
          result: { id: MINTED_TOKEN_ID, value: MINTED_TOKEN_VALUE },
        },
      },
    });
    await startProvisioning(t, owner, workspaceId);
    await drainScheduled(t);

    const row = await provisioningRow(t, workspaceId);
    expect(row!.status).toBe("failed");
    expect(row!.error).not.toContain(MINTED_TOKEN_VALUE);
    expect(row!.error).toContain("[redacted]");
    expect(await everyStoredDocument(t)).not.toContain(MINTED_TOKEN_VALUE);

    // …and it is not on the surface every member of the workspace can read.
    const published = await asUser(t, owner).query(
      api.functions.cloudflare.getCloudflareProvisioning,
      { workspaceId },
    );
    expect(JSON.stringify(published)).not.toContain(MINTED_TOKEN_VALUE);
  });
});

/* -------------------------------------------------------------------------- */
/*                              failing honestly                              */
/* -------------------------------------------------------------------------- */

describe("every failure is a state the owner can act on", () => {
  test("10042 is a billing prerequisite, not a storage error", async () => {
    const { t, owner, workspaceId } = await provisioning({
      bucketFailure: {
        status: 403,
        errors: [{ code: 10042, message: "Please enable R2 through the Cloudflare Dashboard." }],
      },
    });
    await startProvisioning(t, owner, workspaceId);
    await drainScheduled(t);

    const published = await asUser(t, owner).query(
      api.functions.cloudflare.getCloudflareProvisioning,
      { workspaceId },
    );
    expect(published!.status).toBe("failed");
    expect(published!.errorCode).toBe("R2_NOT_ENTITLED");
    expect(published!.error).toMatch(/free/i);
    expect(published!.error).toMatch(/R2 checkout/i);

    // No half-built binding was left behind.
    expect(await bindingRow(t, workspaceId)).toBeNull();
  });

  test("a name that is already taken is handled rather than thrown", async () => {
    const { t, owner, workspaceId, cloudflare } = await provisioning({
      bucketFailure: {
        status: 409,
        errors: [{ code: 10073, message: "The bucket you tried to create already exists." }],
      },
    });
    // The public call still succeeds — the work is scheduled, not awaited.
    await startProvisioning(t, owner, workspaceId);
    await drainScheduled(t);

    const row = await provisioningRow(t, workspaceId);
    expect(row!.status).toBe("failed");
    expect(row!.errorCode).toBe("BUCKET_NAME_TAKEN");
    expect(row!.error).toMatch(/different name/i);
    // No token was minted for a bucket that was not created.
    expect(cloudflare.calls.some((call) => call.path.endsWith("/tokens"))).toBe(false);
    expect(await bindingRow(t, workspaceId)).toBeNull();
  });

  /**
   * A correctly scoped key or none at all. If Cloudflare cannot offer the write
   * permission group, the flow stops *before* creating a bucket — there is no
   * branch that widens the key to get past it.
   */
  test("an unavailable permission group stops the flow before anything is created", async () => {
    const { t, owner, workspaceId, cloudflare } = await provisioning({
      permissionGroups: [
        { id: "fake-read-group-id", name: "Workers R2 Storage Bucket Item Read" },
      ],
    });
    await startProvisioning(t, owner, workspaceId);
    await drainScheduled(t);

    const row = await provisioningRow(t, workspaceId);
    expect(row!.errorCode).toBe("PERMISSION_GROUP_UNAVAILABLE");
    expect(row!.error).toMatch(/nothing broader/i);
    expect(cloudflare.calls.map((call) => call.path)).toEqual([
      `/client/v4/accounts/${FAKE_ACCOUNT_ID}/tokens/permission_groups`,
    ]);
  });

  test("a rejected credential says so, and says to replace it", async () => {
    const { t, owner, workspaceId } = await provisioning({
      permissionGroupsFailure: {
        status: 401,
        errors: [{ code: 10000, message: "Authentication error" }],
      },
    });
    await startProvisioning(t, owner, workspaceId);
    await drainScheduled(t);

    const row = await provisioningRow(t, workspaceId);
    expect(row!.errorCode).toBe("CREDENTIAL_REJECTED");
    expect(row!.error).toMatch(/fresh API token/i);
  });

  test("a token Cloudflare will not show us is a failure, not a broken binding", async () => {
    const { t, owner, workspaceId } = await provisioning({ tokenWithoutValue: true });
    await startProvisioning(t, owner, workspaceId);
    await drainScheduled(t);

    expect((await provisioningRow(t, workspaceId))!.errorCode).toBe("PROVISION_FAILED");
    expect(await bindingRow(t, workspaceId)).toBeNull();
  });

  test("Cloudflare being unreachable is retryable and changes nothing", async () => {
    const { t, owner, workspaceId } = await provisioning();
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    await startProvisioning(t, owner, workspaceId);
    await drainScheduled(t);

    const row = await provisioningRow(t, workspaceId);
    expect(row!.errorCode).toBe("CLOUDFLARE_UNAVAILABLE");
    expect(await bindingRow(t, workspaceId)).toBeNull();
  });

  /**
   * A failed provisioning attempt must not disturb storage that already works.
   * The failure is about a bucket that does not exist; the binding is about one
   * that does.
   */
  test("a failed attempt does not touch an existing binding", async () => {
    const { t, owner, workspaceId } = await provisioning();
    await startProvisioning(t, owner, workspaceId);
    await drainScheduled(t);
    const before = await bindingRow(t, workspaceId);
    expect(before!.status).toBe("connected");

    // Same workspace, second attempt, Cloudflare now refusing.
    const failing = cloudflareStub({
      bucketFailure: { status: 500, errors: [{ code: 1, message: "boom" }] },
    });
    const bucket = memoryS3(BUCKET);
    vi.stubGlobal("fetch", async (input: URL | RequestInfo, init: RequestInit = {}) => {
      const url = new URL(typeof input === "string" ? input : String(input));
      return url.hostname === "api.cloudflare.com"
        ? await failing.fetchImpl(input, init)
        : await bucket.fetchImpl(input, init);
    });
    await startProvisioning(t, owner, workspaceId, { bucket: "atlas-second" });
    await drainScheduled(t);

    const after = await bindingRow(t, workspaceId);
    expect(after!.status).toBe("connected");
    expect(after!.bucket).toBe(BUCKET);
    expect(after!.accessKeyId).toBe(before!.accessKeyId);
    expect((await provisioningRow(t, workspaceId))!.errorCode).toBe(
      "CLOUDFLARE_UNAVAILABLE",
    );
  });
});

/* -------------------------------------------------------------------------- */
/*               what exists in the customer's account afterwards             */
/* -------------------------------------------------------------------------- */

/**
 * THE FAILURE THIS FLOW WAS ALWAYS GOING TO HAVE.
 *
 * Only R2's API-token template key is published, so a token pasted from our own
 * deep link can create a bucket and then be refused at the minting step — open
 * question 3 in `lib/cloudflare.ts` says so in as many words. Every test above
 * fails *before* the bucket call or fails everything at once; none of them ever
 * exercised the one shape the design predicts, and under it the product created
 * a bucket in somebody's Cloudflare account and then told them nothing was
 * changed and to try again — which walked them straight into `BUCKET_NAME_TAKEN`
 * on the bucket it had just made for them.
 */
describe("a bucket that exists is never described as if it did not", () => {
  const MINT_REFUSED: CloudflareFailure = {
    status: 403,
    errors: [{ code: 9109, message: "Unauthorized to access requested resource" }],
  };
  const NAME_TAKEN: CloudflareFailure = {
    status: 409,
    errors: [{ code: 10073, message: "The bucket you tried to create already exists." }],
  };

  test("the bucket is created, the mint is refused, and the record says both", async () => {
    const { t, owner, workspaceId, cloudflare } = await provisioning({
      tokenFailure: MINT_REFUSED,
    });
    await startProvisioning(t, owner, workspaceId);
    await drainScheduled(t);

    // The bucket call happened and succeeded; the mint is what failed.
    expect(cloudflare.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `GET /client/v4/accounts/${FAKE_ACCOUNT_ID}/tokens/permission_groups`,
      `POST /client/v4/accounts/${FAKE_ACCOUNT_ID}/r2/buckets`,
      `POST /client/v4/accounts/${FAKE_ACCOUNT_ID}/tokens`,
    ]);

    const published = await asUser(t, owner).query(
      api.functions.cloudflare.getCloudflareProvisioning,
      { workspaceId },
    );
    expect(published!.status).toBe("failed");
    expect(published!.errorCode).toBe("INSUFFICIENT_PERMISSIONS");
    // The half that was always right: what went wrong and which permission.
    expect(published!.error).toMatch(/Account API Tokens/);
    // The half that was missing, and the reason the retry used to dead-end.
    expect(published!.error).toContain(BUCKET);
    expect(published!.error).toMatch(/was created in your Cloudflare account/i);
    expect(published!.error).toMatch(/same name/i);
    expect(published!.error).not.toMatch(/nothing was (changed|created)/i);

    // Nothing half-bound, and the credential is gone as on any other failure.
    expect(await bindingRow(t, workspaceId)).toBeNull();
    expect(
      (await provisioningRow(t, workspaceId))!.encryptedSetupCredential,
    ).toBeUndefined();
    expect(await everyStoredDocument(t)).not.toContain(SETUP_TOKEN);
  });

  test("the retry is not a dead end: the bucket we made is reused, not refused", async () => {
    const { t, owner, workspaceId } = await provisioning({ tokenFailure: MINT_REFUSED });
    await startProvisioning(t, owner, workspaceId);
    await drainScheduled(t);
    expect((await provisioningRow(t, workspaceId))!.errorCode).toBe(
      "INSUFFICIENT_PERMISSIONS",
    );

    // The owner adds the missing permission and presses try again with the
    // same name — which is what the recorded message told them to do. The
    // bucket from the first run is in the way, and it is ours.
    const retry = useCloudflare({
      bucketFailure: NAME_TAKEN,
      bucketDetails: { name: BUCKET, creation_date: new Date().toISOString() },
    });
    await startProvisioning(t, owner, workspaceId);
    await drainScheduled(t);

    const binding = await bindingRow(t, workspaceId);
    expect(binding).not.toBeNull();
    expect(binding!.bucket).toBe(BUCKET);
    expect(binding!.accessKeyId).toBe(MINTED_TOKEN_ID);
    // Verified against the real bucket by the real probe, like any connect.
    expect(binding!.status).toBe("connected");
    expect(await provisioningRow(t, workspaceId)).toBeNull();

    // It did not assume the bucket was ours — it asked Cloudflare when the
    // bucket was created, which is the only evidence that is not our own
    // memory.
    expect(retry.calls.map((call) => `${call.method} ${call.path}`)).toContain(
      `GET /client/v4/accounts/${FAKE_ACCOUNT_ID}/r2/buckets/${BUCKET}`,
    );

    // And "we created a bucket" and "we used one we had created" are different
    // facts, so the audit trail keeps them apart.
    const events = await asUser(t, owner).query(api.functions.audit.listEvents, {
      workspaceId,
    });
    const provisioned = events.find((event) => event.action === "storage.provisioned");
    expect(provisioned!.details!.reusedExistingBucket).toBe(true);
  });

  /**
   * THE OTHER DIRECTION, WHICH MATTERS MORE.
   *
   * Reuse must never become a way to adopt a bucket somebody already had. The
   * only thing separating the two is Cloudflare's own creation date, so this is
   * the same setup as the test above with one field changed.
   */
  test("a bucket that predates the attempt is refused, not adopted", async () => {
    const { t, owner, workspaceId, cloudflare } = await provisioning({
      bucketFailure: NAME_TAKEN,
      bucketDetails: {
        name: BUCKET,
        creation_date: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString(),
      },
    });
    await startProvisioning(t, owner, workspaceId);
    await drainScheduled(t);

    const row = await provisioningRow(t, workspaceId);
    expect(row!.errorCode).toBe("BUCKET_NAME_TAKEN");
    expect(row!.error).toMatch(/cannot tell that it created it/i);
    expect(row!.error).toMatch(/different name/i);
    // No key was minted over storage that may not be ours, and nothing was
    // bound to it.
    expect(cloudflare.calls.some((call) => call.path.endsWith("/tokens"))).toBe(false);
    expect(await bindingRow(t, workspaceId)).toBeNull();
  });

  test("a 5xx at the mint step reports the bucket rather than claiming innocence", async () => {
    const { t, owner, workspaceId } = await provisioning({
      tokenFailure: { status: 503, errors: [{ code: 1, message: "service unavailable" }] },
    });
    await startProvisioning(t, owner, workspaceId);
    await drainScheduled(t);

    const row = await provisioningRow(t, workspaceId);
    expect(row!.errorCode).toBe("CLOUDFLARE_UNAVAILABLE");
    expect(row!.error).toContain(BUCKET);
    expect(row!.error).toMatch(/was created in your Cloudflare account/i);
    expect(row!.error).not.toMatch(/nothing was (changed|created)/i);
  });

  test("a socket that dies at the mint step reports the bucket too", async () => {
    const { t, owner, workspaceId } = await provisioning({ tokenNetworkFailure: true });
    await startProvisioning(t, owner, workspaceId);
    await drainScheduled(t);

    const row = await provisioningRow(t, workspaceId);
    expect(row!.errorCode).toBe("CLOUDFLARE_UNAVAILABLE");
    expect(row!.error).toMatch(/was created in your Cloudflare account/i);
    expect(row!.error).not.toMatch(/nothing was (changed|created)/i);
  });

  /**
   * A create that never got an answer is the one case where the truthful answer
   * is "we do not know", and saying either of the two confident things would be
   * a guess about somebody else's account.
   */
  test("a create that never answered says the bucket may or may not be there", async () => {
    const { t, owner, workspaceId } = await provisioning({
      bucketFailure: { status: 500, errors: [{ code: 1, message: "boom" }] },
    });
    await startProvisioning(t, owner, workspaceId);
    await drainScheduled(t);

    const row = await provisioningRow(t, workspaceId);
    expect(row!.errorCode).toBe("CLOUDFLARE_UNAVAILABLE");
    expect(row!.error).toMatch(/may or may not have been created/i);
    expect(row!.error).not.toMatch(/nothing was (changed|created)/i);
  });

  /** And the claim is still made where it is true, which is the point of it. */
  test("a failure before the bucket call still says nothing was created", async () => {
    const { t, owner, workspaceId } = await provisioning({
      permissionGroupsFailure: {
        status: 401,
        errors: [{ code: 10000, message: "Authentication error" }],
      },
    });
    await startProvisioning(t, owner, workspaceId);
    await drainScheduled(t);

    const row = await provisioningRow(t, workspaceId);
    expect(row!.errorCode).toBe("CREDENTIAL_REJECTED");
    expect(row!.error).toMatch(/nothing was created/i);
  });
});

/* -------------------------------------------------------------------------- */
/*                    the credential this flow can lose                       */
/* -------------------------------------------------------------------------- */

