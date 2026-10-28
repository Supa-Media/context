/**
 * A PERSONAL WORKSPACE'S NEW BUCKET IS LAID OUT BY ITS FIRST CHECK.
 *
 * The first run used to hold somebody on "Creating your bucket" until the new
 * key had propagated and the probe passed, then ask for the folders from the
 * browser — a second probe, and a wait nobody could see the end of. Now the
 * check that waits out the key also writes the five folders, and the binding
 * says a layout is on its way from the moment it exists, so the console can be
 * the screen those seconds are spent on.
 *
 * Sabotage record (temporary local edits, reverted):
 *   firstStructure not passed from completeManagedProvisioning   2
 *   scaffoldQueuedAt not stamped by applyBinding                 1
 *   shared workspaces laid out too                               1
 */
import { describe, expect, test, vi } from "vitest";
import { internal } from "../../_generated/api";
import { createUser, createWorkspace, setupTest, type TestConvex } from "../fixtures.helpers";
import { stubCloudflare, paidContext, configured, binding } from "./fixtures.helpers";

async function verificationArgs(t: TestConvex) {
  const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  const job = scheduled.find((entry) => entry.name.includes("verifyStorageBinding"));
  return (job?.args as Array<{ structure?: { template: string; kind?: string }; retryUntil?: number }> | undefined)?.[0];
}

describe("a new managed bucket's first check", () => {
  test("lays out the standard folders in a personal workspace, announced at once", async () => {
    const t = setupTest();
    stubCloudflare();
    try {
      await configured(t);
      const { workspaceId } = await paidContext(t, "lays-out-first");
      await t.action(internal.functions.managedProvisioning.provisionManagedStorage, { workspaceId });

      const args = await verificationArgs(t);
      expect(args?.structure).toMatchObject({ template: "para", kind: "personal" });
      expect(args?.retryUntil).toBeGreaterThan(Date.now() + 110_000);
      const row = await binding(t);
      expect(row?.status).toBe("unverified");
      expect(row?.scaffoldQueuedAt).toBeGreaterThan(Date.now() - 10_000);
      const workspace = await t.run((ctx) => ctx.db.get(workspaceId));
      expect(workspace?.structureTemplate).toBe("para");
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  test("leaves a shared workspace's layout to its own question", async () => {
    const t = setupTest();
    stubCloudflare();
    try {
      await configured(t);
      const owner = await createUser(t, "shared-first@example.invalid");
      const workspaceId = await createWorkspace(t, owner, "shared-first", { kind: "shared" });
      await t.run((ctx) =>
        ctx.db.insert("workspacePlans", {
          workspaceId,
          managedStorage: true,
          fastSearch: false,
          status: "active",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
      );
      await t.action(internal.functions.managedProvisioning.provisionManagedStorage, { workspaceId });

      const args = await verificationArgs(t);
      expect(args).toBeDefined();
      expect(args?.structure).toBeUndefined();
      expect((await binding(t))?.scaffoldQueuedAt).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });
});
