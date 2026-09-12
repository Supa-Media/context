/**
 * Deleting a workspace you own.
 *
 * ## Why this exists at all
 *
 * A workspace claims its slug at step 1 of its creation flow, out of the same
 * global namespace usernames come from, and until now nothing but deleting the
 * whole account could give one back. So a workspace somebody created, skipped
 * the bucket on and never came back to held its name forever and one of the
 * ten contexts that account is allowed to own — a reservation nobody could
 * cancel, including the person who made it.
 *
 * ## What the guards are, and why each one is load-bearing
 *
 *  - **Owner only.** `requireWorkspaceRole(…, "owner")`. An editor or member
 *    destroying somebody else's workspace is the worst thing this mutation
 *    could be made to do.
 *  - **The slug, typed.** Two presses guard the account-deletion card; a
 *    workspace is addressed by name and reached from a settings section, so
 *    the confirmation is the name itself, checked on the server rather than
 *    in the panel. A client that skipped the field cannot skip the check.
 *  - **Shared only.** A brain is the one context a person is allowed exactly
 *    one of, its slug is the person's own username, and its capture address
 *    is live on the apex. Releasing that is account deletion's business and
 *    is deliberately not reachable from a settings panel.
 *  - **Not while we hold the bucket.** On managed storage the only copy of
 *    the notes is in a bucket the customer has no key to, and the free
 *    hand-off path is not built yet (`docs/decisions/billing.md`). Deleting
 *    the row either strands their notes in our infrastructure or destroys
 *    them; refusing, and saying so, is the only answer that does not break
 *    the first non-negotiable.
 *
 * The cascade itself is `deleteAccount`'s, unchanged and already proven by
 * `account.test.ts` — this file asserts the authorization, the refusals and
 * that the name really does come back.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing vitest tests
 * in this file.
 *
 *   the owner check lowered to "editor"                                   1
 *   the typed-slug comparison dropped                                     1
 *   the personal-context refusal removed                                  1
 *   the managed-bucket refusal removed                                    1
 *   the in-flight-migration refusal removed                                1
 *   the cascade swapped for a bare `ctx.db.delete(workspaceId)`           2
 */

import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import {
  addMember,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  seedStorageBinding,
  setupTest,
} from "./fixtures.helpers";
import { managedBucketName } from "../functions/lib/managedStorage";

async function workspaceOwnedBy(slug = "acme-eng") {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, slug, { kind: "shared" });
  return { t, owner, workspaceId };
}

describe("deleteWorkspace", () => {
  test("an owner can delete a workspace, and its name comes back", async () => {
    const { t, owner, workspaceId } = await workspaceOwnedBy();

    // The pre-state, asserted first: an "is gone afterwards" check over a row
    // the fixture never wrote is vacuously green.
    await t.run(async (ctx) => {
      const claim = await ctx.db
        .query("names")
        .withIndex("by_name", (q) => q.eq("name", "acme-eng"))
        .unique();
      expect(claim).not.toBeNull();
    });

    await expect(
      asUser(t, owner).mutation(api.functions.account.deleteWorkspace, {
        workspaceId,
        confirmSlug: "acme-eng",
      }),
    ).resolves.toEqual({ deleted: true });

    await t.run(async (ctx) => {
      expect(await ctx.db.get(workspaceId)).toBeNull();
      // The account survives its workspace — this is not account deletion.
      expect(await ctx.db.get(owner)).not.toBeNull();
      const claim = await ctx.db
        .query("names")
        .withIndex("by_name", (q) => q.eq("name", "acme-eng"))
        .unique();
      expect(claim).toBeNull();
      const memberships = await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .collect();
      expect(memberships).toEqual([]);
    });

    // And it is claimable again, by anybody — the whole point of freeing it.
    const other = await createUser(t, "other@example.invalid");
    await expect(createWorkspace(t, other, "acme-eng", { kind: "shared" })).resolves.toBeDefined();
  });

  test("the typed name has to match, and a near miss deletes nothing", async () => {
    const { t, owner, workspaceId } = await workspaceOwnedBy();
    const error = await captureError(() =>
      asUser(t, owner).mutation(api.functions.account.deleteWorkspace, {
        workspaceId,
        confirmSlug: "acme-engineering",
      }),
    );
    expect(errorCode(error)).toBe("CONFIRMATION_MISMATCH");
    await t.run(async (ctx) => {
      expect(await ctx.db.get(workspaceId)).not.toBeNull();
    });
  });

  test("but the shapes a person actually types are accepted", async () => {
    const { t, owner, workspaceId } = await workspaceOwnedBy();
    await expect(
      asUser(t, owner).mutation(api.functions.account.deleteWorkspace, {
        workspaceId,
        confirmSlug: "  @Acme-Eng  ",
      }),
    ).resolves.toEqual({ deleted: true });
  });

  test("only an owner: a member's delete is refused and changes nothing", async () => {
    const { t, owner, workspaceId } = await workspaceOwnedBy();
    const member = await createUser(t, "member@example.invalid");
    await addMember(t, workspaceId, member, "editor", owner);

    const error = await captureError(() =>
      asUser(t, member).mutation(api.functions.account.deleteWorkspace, {
        workspaceId,
        confirmSlug: "acme-eng",
      }),
    );
    expect(errorCode(error)).toBe("INSUFFICIENT_ROLE");
    await t.run(async (ctx) => {
      expect(await ctx.db.get(workspaceId)).not.toBeNull();
    });
  });

  test("a stranger is refused without being told the workspace exists", async () => {
    const { t, workspaceId } = await workspaceOwnedBy();
    const stranger = await createUser(t, "stranger@example.invalid");
    const error = await captureError(() =>
      asUser(t, stranger).mutation(api.functions.account.deleteWorkspace, {
        workspaceId,
        confirmSlug: "acme-eng",
      }),
    );
    expect(errorCode(error)).toBe("WORKSPACE_NOT_FOUND");
    await t.run(async (ctx) => {
      expect(await ctx.db.get(workspaceId)).not.toBeNull();
    });
  });

  test("a brain is not deletable here — it goes with the account", async () => {
    const t = setupTest();
    const owner = await createUser(t, "owner@example.invalid");
    const brain = await createWorkspace(t, owner, "seyi", { kind: "personal" });
    const error = await captureError(() =>
      asUser(t, owner).mutation(api.functions.account.deleteWorkspace, {
        workspaceId: brain,
        confirmSlug: "seyi",
      }),
    );
    expect(errorCode(error)).toBe("PERSONAL_CONTEXT");
    await t.run(async (ctx) => {
      expect(await ctx.db.get(brain)).not.toBeNull();
    });
  });

  test("and not while the notes live in a bucket we hold the key to", async () => {
    const { t, owner, workspaceId } = await workspaceOwnedBy();
    await seedStorageBinding(t, {
      workspaceId,
      boundBy: owner,
      bucket: managedBucketName(workspaceId),
      accessKeyId: "fake-managed-token-id",
    });

    const error = await captureError(() =>
      asUser(t, owner).mutation(api.functions.account.deleteWorkspace, {
        workspaceId,
        confirmSlug: "acme-eng",
      }),
    );
    expect(errorCode(error)).toBe("MANAGED_STORAGE");
    await t.run(async (ctx) => {
      expect(await ctx.db.get(workspaceId)).not.toBeNull();
    });
  });

  test("nor while a move into storage we run is under way", async () => {
    const { t, owner, workspaceId } = await workspaceOwnedBy();
    await seedStorageBinding(t, { workspaceId, boundBy: owner, bucket: "their-own-bucket" });
    const sourceBindingId = await t.run(async (ctx) => {
      const binding = await ctx.db
        .query("storageBindings")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      return binding!._id;
    });
    /*
      The managed bucket already exists by this point and already holds a
      partial copy: deleting the row that names it would leave us paying for
      storage nobody can reach.
    */
    await t.run((ctx) =>
      ctx.db.insert("managedStorageMigrations", {
        workspaceId,
        sourceBindingId,
        targetEndpoint: "https://managed.example.invalid",
        targetBucket: managedBucketName(workspaceId),
        targetAccessKeyId: "fake-target-key",
        encryptedTargetSecretAccessKey: "sealed-not-a-real-secret",
        status: "copying" as const,
        phase: "copy" as const,
        objectsCopied: 0,
        changesInPass: 0,
        readyToCutover: false,
        startedBy: owner,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    const error = await captureError(() =>
      asUser(t, owner).mutation(api.functions.account.deleteWorkspace, {
        workspaceId,
        confirmSlug: "acme-eng",
      }),
    );
    expect(errorCode(error)).toBe("MANAGED_MIGRATION");
    await t.run(async (ctx) => {
      expect(await ctx.db.get(workspaceId)).not.toBeNull();
    });
  });

  test("a bucket the customer owns is forgotten, never reached into", async () => {
    const { t, owner, workspaceId } = await workspaceOwnedBy();
    await seedStorageBinding(t, { workspaceId, boundBy: owner, bucket: "their-own-bucket" });

    await expect(
      asUser(t, owner).mutation(api.functions.account.deleteWorkspace, {
        workspaceId,
        confirmSlug: "acme-eng",
      }),
    ).resolves.toEqual({ deleted: true });

    await t.run(async (ctx) => {
      const bindings = await ctx.db
        .query("storageBindings")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .collect();
      expect(bindings).toEqual([]);
      // Nothing was scheduled at their storage: an S3 binding is forgotten,
      // and their files stay exactly where they are.
      const scheduled = await ctx.db.system.query("_scheduled_functions").collect();
      expect(scheduled.filter((job) => job.name.includes("deleteManagedTestResources"))).toEqual([]);
    });
  });

  test("one workspace's deletion never touches another's rows", async () => {
    const { t, owner, workspaceId } = await workspaceOwnedBy();
    const survivor = await createWorkspace(t, owner, "kept-one", { kind: "shared" });
    await seedStorageBinding(t, { workspaceId, boundBy: owner });
    await seedStorageBinding(t, { workspaceId: survivor, boundBy: owner });

    await asUser(t, owner).mutation(api.functions.account.deleteWorkspace, {
      workspaceId,
      confirmSlug: "acme-eng",
    });

    await t.run(async (ctx) => {
      expect(await ctx.db.get(survivor)).not.toBeNull();
      const bindings = await ctx.db
        .query("storageBindings")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", survivor))
        .collect();
      expect(bindings).toHaveLength(1);
      const claim = await ctx.db
        .query("names")
        .withIndex("by_name", (q) => q.eq("name", "kept-one"))
        .unique();
      expect(claim).not.toBeNull();
    });
  });

});
