/**
 * THE FREE MANAGED TIER: A BUCKET WE RUN, NO CARD, A THOUSAND NOTES.
 *
 * Three properties matter here.
 *
 * **It is off unless a deployment deliberately turns it on.** A free tier puts
 * a new signup's notes in a bucket they hold no key to, and the only exit
 * non-negotiable #1 accepts from such a bucket — free export, or handing it to
 * storage of their own — is not built yet. So the tier ships dark in
 * production; staging turns it on (storage there is already free).
 *
 * **It is one per account.** Every free context is a bucket we create and pay
 * for with no card behind it.
 *
 * **It gates provisioning, never access.** Turning the switch off stops new
 * free buckets being minted; it does nothing to a bucket that already exists.
 *
 * ## Sabotage record (temporary local edits, reverted; failures measured)
 *
 *   `collect.ts` dropping the `freeManaged` argument                      1
 *   provisioning standing ignoring the deployment switch                  1
 *   the one-per-account limit raised out of reach                         1
 *   a second press scheduling a second provisioning run                   1
 */

import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import {
  addMember,
  asUser,
  createWorkspace,
  errorCode,
  captureError,
  createUser,
  seedStorageBinding,
  setupTest,
} from "../fixtures.helpers";
import {
  FREE_MANAGED_STORAGE_ENV_VAR,
  MANAGED_R2_ACCOUNT_ID_ENV_VAR,
  managedBucketName,
} from "../../functions/lib/managedStorage";
import { FREE_MANAGED_NOTE_CAP } from "../../functions/lib/premium";
import { context } from "./fixtures.helpers";

/** Fake, and shaped like a Cloudflare account id. This repository is public. */
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";

function freeTierOn() {
  vi.stubEnv(FREE_MANAGED_STORAGE_ENV_VAR, "enabled");
  vi.stubEnv(MANAGED_R2_ACCOUNT_ID_ENV_VAR, ACCOUNT_ID);
}

describe("offering the free tier", () => {
  test("a deployment that has not switched it on does not offer it", async () => {
    const t = setupTest();
    vi.stubEnv(MANAGED_R2_ACCOUNT_ID_ENV_VAR, ACCOUNT_ID);
    try {
      const { owner, workspaceId } = await context(t, "free-off");
      const status = await asUser(t, owner).query(api.functions.billing.status, { workspaceId });
      expect(status.freeManagedAvailable).toBe(false);
      expect(status.freeManagedEligible).toBe(false);
      expect(
        errorCode(
          await captureError(() =>
            asUser(t, owner).mutation(api.functions.billing.startFreeManaged, { workspaceId }),
          ),
        ),
      ).toBe("FREE_TIER_UNAVAILABLE");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("switched on with nowhere to put the bucket is still not an offer", async () => {
    const t = setupTest();
    vi.stubEnv(FREE_MANAGED_STORAGE_ENV_VAR, "enabled");
    try {
      const { owner, workspaceId } = await context(t, "free-no-account");
      const status = await asUser(t, owner).query(api.functions.billing.status, { workspaceId });
      expect(status.freeManagedAvailable).toBe(false);
      expect(
        errorCode(
          await captureError(() =>
            asUser(t, owner).mutation(api.functions.billing.startFreeManaged, { workspaceId }),
          ),
        ),
      ).toBe("FREE_TIER_UNAVAILABLE");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("where it is on, the status says so and names the cap", async () => {
    const t = setupTest();
    freeTierOn();
    try {
      const { owner, workspaceId } = await context(t, "free-on");
      const status = await asUser(t, owner).query(api.functions.billing.status, { workspaceId });
      expect(status.freeManagedAvailable).toBe(true);
      expect(status.freeManagedEligible).toBe(true);
      expect(status.freeManagedNoteCap).toBe(FREE_MANAGED_NOTE_CAP);
      expect(status.freeManaged).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("starting on the free tier", () => {
  test("an owner starts it, and provisioning is scheduled without a card", async () => {
    const t = setupTest();
    freeTierOn();
    try {
      const { owner, workspaceId } = await context(t, "free-start");
      await expect(
        asUser(t, owner).mutation(api.functions.billing.startFreeManaged, { workspaceId }),
      ).resolves.toEqual({ started: true });

      const plan = await t.run((ctx) => ctx.db.query("workspacePlans").unique());
      expect(plan).toMatchObject({
        managedStorage: true,
        fastSearch: false,
        freeManaged: true,
        status: "none",
        managedProvisioning: "running",
      });
      expect(plan?.stripeCustomerId).toBeUndefined();
      expect(await t.run((ctx) => ctx.db.query("billingSessions").collect())).toEqual([]);

      const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
      expect(jobs.some((job) => job.name.includes("provisionManagedStorage"))).toBe(true);

      const audit = await t.run((ctx) => ctx.db.query("auditEvents").collect());
      expect(audit.map((event) => event.action)).toContain("billing.free_managed_started");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("a second press does not schedule a second bucket", async () => {
    const t = setupTest();
    freeTierOn();
    try {
      const { owner, workspaceId } = await context(t, "free-twice");
      await asUser(t, owner).mutation(api.functions.billing.startFreeManaged, { workspaceId });
      const before = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
      await expect(
        asUser(t, owner).mutation(api.functions.billing.startFreeManaged, { workspaceId }),
      ).resolves.toEqual({ started: true });
      const after = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
      expect(after).toHaveLength(before.length);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("only an owner may start it", async () => {
    const t = setupTest();
    freeTierOn();
    try {
      const { workspaceId, owner } = await context(t, "free-editor");
      const editor = await createUser(t, "free-editor-editor@example.invalid");
      await addMember(t, workspaceId, editor, "editor", owner);
      expect(
        errorCode(
          await captureError(() =>
            asUser(t, editor).mutation(api.functions.billing.startFreeManaged, { workspaceId }),
          ),
        ),
      ).toBe("INSUFFICIENT_ROLE");
      expect(await t.run((ctx) => ctx.db.query("workspacePlans").collect())).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("a context that already has storage is not moved onto it", async () => {
    // Moving an existing bucket into managed storage is a copy with its own
    // verification (`managedStorageMigrations`); this entry point never does it.
    const t = setupTest();
    freeTierOn();
    try {
      const { owner, workspaceId } = await context(t, "free-bound");
      await seedStorageBinding(t, { workspaceId, boundBy: owner });
      const status = await asUser(t, owner).query(api.functions.billing.status, { workspaceId });
      expect(status.freeManagedEligible).toBe(false);
      expect(
        errorCode(
          await captureError(() =>
            asUser(t, owner).mutation(api.functions.billing.startFreeManaged, { workspaceId }),
          ),
        ),
      ).toBe("STORAGE_ALREADY_CONNECTED");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("one free context per account", async () => {
    const t = setupTest();
    freeTierOn();
    try {
      const { owner, workspaceId } = await context(t, "free-first");
      await asUser(t, owner).mutation(api.functions.billing.startFreeManaged, { workspaceId });
      const second = await createWorkspace(t, owner, "free-second");

      const status = await asUser(t, owner).query(api.functions.billing.status, { workspaceId: second });
      expect(status.freeManagedAvailable).toBe(true);
      expect(status.freeManagedEligible).toBe(false);
      expect(
        errorCode(
          await captureError(() =>
            asUser(t, owner).mutation(api.functions.billing.startFreeManaged, { workspaceId: second }),
          ),
        ),
      ).toBe("FREE_TIER_LIMIT");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("what the free tier is entitled to", () => {
  test("provisioning treats a free context as entitled while the tier is on", async () => {
    const t = setupTest();
    freeTierOn();
    try {
      const { owner, workspaceId } = await context(t, "free-entitled");
      await asUser(t, owner).mutation(api.functions.billing.startFreeManaged, { workspaceId });
      const standing = await t.query(internal.functions.managedProvisioning.provisioningStanding, { workspaceId });
      expect(standing?.entitled).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("and stops minting new free buckets the moment it is switched off", async () => {
    const t = setupTest();
    freeTierOn();
    const { owner, workspaceId } = await context(t, "free-switched-off");
    await asUser(t, owner).mutation(api.functions.billing.startFreeManaged, { workspaceId });
    vi.unstubAllEnvs();
    vi.stubEnv(MANAGED_R2_ACCOUNT_ID_ENV_VAR, ACCOUNT_ID);
    try {
      const standing = await t.query(internal.functions.managedProvisioning.provisioningStanding, { workspaceId });
      expect(standing?.entitled).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("the cap is reported once the bucket is ours, and not before", async () => {
    const t = setupTest();
    freeTierOn();
    try {
      const { owner, workspaceId } = await context(t, "free-cap");
      await asUser(t, owner).mutation(api.functions.billing.startFreeManaged, { workspaceId });
      let status = await asUser(t, owner).query(api.functions.billing.status, { workspaceId });
      expect(status.freeManaged).toBe(true);
      expect(status.noteCap).toBeUndefined();

      await seedStorageBinding(t, {
        workspaceId,
        boundBy: owner,
        bucket: managedBucketName(workspaceId),
      });
      status = await asUser(t, owner).query(api.functions.billing.status, { workspaceId });
      expect(status.storageIsManaged).toBe(true);
      expect(status.noteCap).toBe(FREE_MANAGED_NOTE_CAP);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("a free context never reads as a lapsed paid one", async () => {
    // `collect.ts` makes a managed context that is not paying read-only. A
    // free context never paid, so that rule must not reach it.
    const t = setupTest();
    freeTierOn();
    try {
      const { owner, workspaceId } = await context(t, "free-writable");
      await asUser(t, owner).mutation(api.functions.billing.startFreeManaged, { workspaceId });
      await seedStorageBinding(t, {
        workspaceId,
        boundBy: owner,
        bucket: managedBucketName(workspaceId),
      });
      expect(
        await t.query(internal.functions.collect.collectContextWritable, { workspaceId }),
      ).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
