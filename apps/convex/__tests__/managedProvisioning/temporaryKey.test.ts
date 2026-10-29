/**
 * A NEW MANAGED BUCKET IS SERVED ON A TEMPORARY CREDENTIAL UNTIL ITS OWN KEY
 * ANSWERS.
 *
 * Cloudflare takes up to two minutes to accept a key it has just minted; R2's
 * temporary credentials work at once. These pin what that may and may not do:
 * the bucket's own key stays where every revoke reads it, the gateway is
 * handed the temporary trio only while it stands, a failure to issue one
 * changes nothing, and a rebind never carries one to another bucket.
 *
 * Sabotage record (temporary local edits, reverted):
 *   temporary credential written over accessKeyId                     1
 *   expiry ignored when opening the credential                        1
 *   clearTemporaryKey ignoring which credential was probed             1
 *   applyBinding keeping temporary fields on a rebind                  1
 */
import { describe, expect, test, vi } from "vitest";
import { internal } from "../../_generated/api";
import { setupTest } from "../fixtures.helpers";
import { decryptSecret, requireKeyset } from "../../functions/lib/crypto";
import {
  MINTED_ID,
  TEMPORARY_ID,
  TEMPORARY_SECRET,
  TEMPORARY_SESSION,
  stubCloudflare,
  paidContext,
  configured,
  binding,
} from "./fixtures.helpers";

async function scheduledNamed(t: ReturnType<typeof setupTest>, name: string) {
  const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  return scheduled.filter((job) => job.name.includes(name));
}

describe("a new managed bucket's temporary credential", () => {
  test("is bound beside the bucket's own key, sealed, and promotion is asked for", async () => {
    const t = setupTest();
    stubCloudflare();
    try {
      await configured(t);
      const { workspaceId } = await paidContext(t, "temporary-bound");
      const result = await t.action(internal.functions.managedProvisioning.provisionManagedStorage, { workspaceId });
      expect(result.ok).toBe(true);

      const row = await binding(t);
      // Every revoke reads `accessKeyId`: it is still the token we minted.
      expect(row?.accessKeyId).toBe(MINTED_ID);
      expect(row?.temporaryAccessKeyId).toBe(TEMPORARY_ID);
      expect(row?.encryptedSessionToken).toBeDefined();
      expect(JSON.stringify(row)).not.toContain(TEMPORARY_SECRET);
      expect(JSON.stringify(row)).not.toContain(TEMPORARY_SESSION);
      const context = { workspaceId };
      expect(await decryptSecret(row!.encryptedSessionToken!, requireKeyset(), context)).toBe(TEMPORARY_SESSION);
      expect(await decryptSecret(row!.encryptedTemporarySecretAccessKey!, requireKeyset(), context)).toBe(TEMPORARY_SECRET);
      expect(row!.temporaryUntil!).toBeGreaterThan(Date.now() + 60 * 60 * 1000);
      expect(await scheduledNamed(t, "promoteManagedKey")).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  test("is what the gateway is handed while it stands, and never once it has lapsed", async () => {
    const t = setupTest();
    stubCloudflare();
    try {
      await configured(t);
      const { workspaceId } = await paidContext(t, "temporary-served");
      await t.action(internal.functions.managedProvisioning.provisionManagedStorage, { workspaceId });

      const served = await t.action(internal.functions.storage.getBindingForGateway, { workspaceId });
      expect(served?.accessKeyId).toBe(TEMPORARY_ID);
      expect(served?.secretAccessKey).toBe(TEMPORARY_SECRET);
      expect(served?.sessionToken).toBe(TEMPORARY_SESSION);

      const row = await binding(t);
      await t.run((ctx) => ctx.db.patch(row!._id, { temporaryUntil: Date.now() + 1000 }));
      const lapsed = await t.action(internal.functions.storage.getBindingForGateway, { workspaceId });
      expect(lapsed?.accessKeyId).toBe(MINTED_ID);
      expect(lapsed?.sessionToken).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  test("not being issued changes nothing: the bucket waits for its own key, as before", async () => {
    const t = setupTest();
    stubCloudflare({ temporaryFails: true });
    try {
      await configured(t);
      const { workspaceId } = await paidContext(t, "temporary-refused");
      const result = await t.action(internal.functions.managedProvisioning.provisionManagedStorage, { workspaceId });
      expect(result.ok).toBe(true);
      const row = await binding(t);
      expect(row?.accessKeyId).toBe(MINTED_ID);
      expect(row?.temporaryAccessKeyId).toBeUndefined();
      expect(row?.encryptedSessionToken).toBeUndefined();
      expect(await scheduledNamed(t, "promoteManagedKey")).toHaveLength(0);
      const served = await t.action(internal.functions.storage.getBindingForGateway, { workspaceId });
      expect(served?.accessKeyId).toBe(MINTED_ID);
      expect(served?.sessionToken).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  test("is cleared only for the credential that was probed past", async () => {
    const t = setupTest();
    stubCloudflare();
    try {
      await configured(t);
      const { workspaceId } = await paidContext(t, "temporary-cleared");
      await t.action(internal.functions.managedProvisioning.provisionManagedStorage, { workspaceId });

      expect(
        await t.mutation(internal.functions.managedProvisioning.clearTemporaryKey, {
          workspaceId,
          temporaryAccessKeyId: "some-other-temporary-key",
        }),
      ).toBe(false);
      expect((await binding(t))?.temporaryAccessKeyId).toBe(TEMPORARY_ID);

      expect(
        await t.mutation(internal.functions.managedProvisioning.clearTemporaryKey, {
          workspaceId,
          temporaryAccessKeyId: TEMPORARY_ID,
        }),
      ).toBe(true);
      const row = await binding(t);
      expect(row?.temporaryAccessKeyId).toBeUndefined();
      expect(row?.encryptedTemporarySecretAccessKey).toBeUndefined();
      expect(row?.encryptedSessionToken).toBeUndefined();
      expect(row?.temporaryUntil).toBeUndefined();
      expect(row?.accessKeyId).toBe(MINTED_ID);
      const served = await t.action(internal.functions.storage.getBindingForGateway, { workspaceId });
      expect(served?.accessKeyId).toBe(MINTED_ID);
      expect(served?.sessionToken).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  test("never survives a rebind to another bucket", async () => {
    const t = setupTest();
    stubCloudflare();
    try {
      await configured(t);
      const { owner, workspaceId } = await paidContext(t, "temporary-rebind");
      await t.action(internal.functions.managedProvisioning.provisionManagedStorage, { workspaceId });
      await t.mutation(internal.functions.storage.applyBinding, {
        workspaceId,
        actorUserId: owner,
        provider: "s3",
        endpoint: "https://s3.example.invalid",
        region: "us-east-1",
        bucket: "their-own-bucket",
        accessKeyId: "their-key",
        encryptedSecretAccessKey: (await binding(t))!.encryptedSecretAccessKey!,
      });
      const row = await binding(t);
      expect(row?.bucket).toBe("their-own-bucket");
      expect(row?.temporaryAccessKeyId).toBeUndefined();
      expect(row?.encryptedSessionToken).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  test("an own key that does not answer yet keeps the temporary one and asks again", async () => {
    const t = setupTest();
    stubCloudflare();
    try {
      await configured(t);
      const { workspaceId } = await paidContext(t, "temporary-not-yet");
      await t.action(internal.functions.managedProvisioning.provisionManagedStorage, { workspaceId });
      // R2 refusing the bucket's own key: what a key still propagating looks like.
      vi.stubGlobal("fetch", async () => new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 }));
      await t.action(internal.functions.managedProvisioning.promoteManagedKey, { workspaceId, attempt: 0 });
      expect((await binding(t))?.temporaryAccessKeyId).toBe(TEMPORARY_ID);
      const again = await scheduledNamed(t, "promoteManagedKey");
      expect(again.map((job) => (job.args as Array<{ attempt: number }>)[0].attempt)).toContain(1);
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  test("promotion stops asking once the temporary credential has lapsed", async () => {
    const { nextPromotionDelayMs, promotionStillWorthAsking } = await import(
      "../../functions/lib/managedProvisioningFns/temporaryKey"
    );
    expect(nextPromotionDelayMs(0)).toBe(10_000);
    expect(nextPromotionDelayMs(20)).toBe(60_000);
    expect(promotionStillWorthAsking(undefined, 0)).toBe(false);
    expect(promotionStillWorthAsking(1_000, 999)).toBe(true);
    expect(promotionStillWorthAsking(1_000, 1_000)).toBe(false);
  });
});
