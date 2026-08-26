/**
 * TENANT ISOLATION.
 *
 * One workspace is one security boundary. The bar is not "a stranger cannot
 * read your notes" — the control plane holds no notes. The bar is that a
 * stranger cannot **read, list, or infer the existence of** another
 * workspace, its storage binding, its connected clients, or its audit trail.
 *
 * Inference is the part that is easy to get wrong and easy to lose in a
 * refactor. An endpoint that answers `FORBIDDEN` for a real workspace and
 * `NOT_FOUND` for a fake one is an oracle: harvest ids, learn which contexts
 * exist, learn from slugs what people are working on. So several tests below
 * assert that the error for "someone else's" is **byte-identical** to the
 * error for "never existed", not merely that both fail.
 *
 * If you are changing an endpoint and one of these breaks, the endpoint is
 * wrong. Do not adjust the assertion.
 */

import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  FAKE_STORAGE,
  asUser,
  addMember,
  bindFakeStorage,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  seedGrant,
  setupTest,
  type TestConvex,
} from "./fixtures.helpers";

/**
 * A syntactically valid workspace id that refers to nothing.
 *
 * Produced by creating and deleting a row, so it is indistinguishable from a
 * live id in shape — which is exactly the guess an attacker would make.
 */
async function danglingWorkspaceId(t: TestConvex): Promise<Id<"workspaces">> {
  return await t.run(async (ctx) => {
    const id = await ctx.db.insert("workspaces", {
      slug: "temporary-placeholder",
      displayName: "Temporary",
      createdBy: (await ctx.db.insert("users", { createdAt: Date.now() })) as Id<"users">,
      kind: "personal",
      structureTemplate: "para",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await ctx.db.delete(id);
    return id;
  });
}

/** Serialize a thrown error's payload so two failures can be compared exactly. */
function errorShape(error: unknown): string {
  return JSON.stringify((error as { data?: unknown }).data ?? null);
}

/**
 * Two tenants, fully furnished: each with a workspace, a storage binding, a
 * grant, and audit history. `mallory` belongs to neither.
 */
async function twoTenants() {
  const t = setupTest();
  const alice = await createUser(t, "alice@example.invalid");
  const bob = await createUser(t, "bob@example.invalid");
  const mallory = await createUser(t, "mallory@example.invalid");

  const aliceWs = await createWorkspace(t, alice, "alice-context", {
    displayName: "Alice's Context",
  });
  const bobWs = await createWorkspace(t, bob, "bob-context", {
    displayName: "Bob's Context",
  });
  // Mallory has a workspace of her own, so she is a legitimate, authenticated
  // user — not an anonymous caller. This is the realistic attacker.
  const malloryWs = await createWorkspace(t, mallory, "mallory-context");

  await bindFakeStorage(t, alice, aliceWs, { bucket: "alice-private-bucket" });
  await bindFakeStorage(t, bob, bobWs, { bucket: "bob-private-bucket" });

  const aliceGrant = await seedGrant(t, aliceWs, alice, "claude", "hash-alice");
  const bobGrant = await seedGrant(t, bobWs, bob, "chatgpt", "hash-bob");

  await t.run(async (ctx) => {
    await ctx.db.insert("auditEvents", {
      workspaceId: aliceWs,
      actorUserId: alice,
      action: "note.read",
      paths: ["1-projects/alice-secret-project.md"],
      at: Date.now(),
    });
    await ctx.db.insert("auditEvents", {
      workspaceId: bobWs,
      actorUserId: bob,
      action: "note.read",
      paths: ["1-projects/bob-secret-project.md"],
      at: Date.now(),
    });
  });

  return { t, alice, bob, mallory, aliceWs, bobWs, malloryWs, aliceGrant, bobGrant };
}

describe("a non-member cannot read another workspace", () => {
  test("getWorkspace refuses, and refuses identically to a workspace that never existed", async () => {
    const { t, mallory, aliceWs } = await twoTenants();
    const dangling = await danglingWorkspaceId(t);

    const foreign = await captureError(() =>
      asUser(t, mallory).query(api.functions.workspaces.getWorkspace, {
        workspaceId: aliceWs,
      }),
    );
    const nonexistent = await captureError(() =>
      asUser(t, mallory).query(api.functions.workspaces.getWorkspace, {
        workspaceId: dangling,
      }),
    );

    expect(errorCode(foreign)).toBe("WORKSPACE_NOT_FOUND");
    // The whole point: these must be indistinguishable.
    expect(errorShape(foreign)).toBe(errorShape(nonexistent));
  });

  test("the refusal leaks neither the slug nor the display name", async () => {
    const { t, mallory, aliceWs } = await twoTenants();
    const error = await captureError(() =>
      asUser(t, mallory).query(api.functions.workspaces.getWorkspace, {
        workspaceId: aliceWs,
      }),
    );
    const serialized = `${errorShape(error)}${(error as Error).message ?? ""}`;
    expect(serialized).not.toContain("alice-context");
    expect(serialized).not.toContain("Alice");
  });

  test("listMembers refuses, identically to a workspace that never existed", async () => {
    const { t, mallory, aliceWs } = await twoTenants();
    const dangling = await danglingWorkspaceId(t);

    const foreign = await captureError(() =>
      asUser(t, mallory).query(api.functions.workspaces.listMembers, {
        workspaceId: aliceWs,
      }),
    );
    const nonexistent = await captureError(() =>
      asUser(t, mallory).query(api.functions.workspaces.listMembers, {
        workspaceId: dangling,
      }),
    );

    expect(errorCode(foreign)).toBe("WORKSPACE_NOT_FOUND");
    expect(errorShape(foreign)).toBe(errorShape(nonexistent));
  });

  test("listMyWorkspaces returns only the caller's own", async () => {
    const { t, mallory, malloryWs, alice, aliceWs, bob, bobWs } =
      await twoTenants();

    const mine = await asUser(t, mallory).query(
      api.functions.workspaces.listMyWorkspaces,
      {},
    );
    expect(mine.map((w) => w.workspaceId)).toEqual([malloryWs]);

    // ...and symmetrically for the other two, so this is not an artifact of
    // Mallory happening to be last.
    const aliceList = await asUser(t, alice).query(
      api.functions.workspaces.listMyWorkspaces,
      {},
    );
    expect(aliceList.map((w) => w.workspaceId)).toEqual([aliceWs]);
    const bobList = await asUser(t, bob).query(
      api.functions.workspaces.listMyWorkspaces,
      {},
    );
    expect(bobList.map((w) => w.workspaceId)).toEqual([bobWs]);
  });

  test("an unauthenticated caller sees nothing at all", async () => {
    const { t, aliceWs } = await twoTenants();

    expect(
      errorCode(
        await captureError(() =>
          t.query(api.functions.workspaces.listMyWorkspaces, {}),
        ),
      ),
    ).toBe("NOT_AUTHENTICATED");
    expect(
      errorCode(
        await captureError(() =>
          t.query(api.functions.workspaces.getWorkspace, { workspaceId: aliceWs }),
        ),
      ),
    ).toBe("NOT_AUTHENTICATED");
  });
});

describe("a non-member cannot see another workspace's storage binding", () => {
  test("getStorageBinding refuses, identically to a workspace that never existed", async () => {
    const { t, mallory, aliceWs } = await twoTenants();
    const dangling = await danglingWorkspaceId(t);

    const foreign = await captureError(() =>
      asUser(t, mallory).query(api.functions.storage.getStorageBinding, {
        workspaceId: aliceWs,
      }),
    );
    const nonexistent = await captureError(() =>
      asUser(t, mallory).query(api.functions.storage.getStorageBinding, {
        workspaceId: dangling,
      }),
    );

    expect(errorCode(foreign)).toBe("WORKSPACE_NOT_FOUND");
    expect(errorShape(foreign)).toBe(errorShape(nonexistent));
  });

  test("the bucket name never reaches a non-member", async () => {
    const { t, mallory, aliceWs } = await twoTenants();
    const error = await captureError(() =>
      asUser(t, mallory).query(api.functions.storage.getStorageBinding, {
        workspaceId: aliceWs,
      }),
    );
    expect(errorShape(error)).not.toContain("alice-private-bucket");
  });

  test("a non-member cannot rebind another workspace's storage", async () => {
    const { t, mallory, aliceWs } = await twoTenants();

    const error = await captureError(() =>
      bindFakeStorage(t, mallory, aliceWs, { bucket: "mallory-controlled" }),
    );
    expect(errorCode(error)).toBe("WORKSPACE_NOT_FOUND");

    // Alice's binding is untouched — a failed hijack must not have partially
    // applied.
    const binding = await t.run((ctx) =>
      ctx.db
        .query("storageBindings")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", aliceWs))
        .unique(),
    );
    expect(binding?.bucket).toBe("alice-private-bucket");
  });

  test("a non-member cannot disconnect another workspace's storage", async () => {
    const { t, mallory, aliceWs } = await twoTenants();

    const error = await captureError(() =>
      asUser(t, mallory).mutation(api.functions.storage.disconnectStorage, {
        workspaceId: aliceWs,
      }),
    );
    expect(errorCode(error)).toBe("WORKSPACE_NOT_FOUND");

    const binding = await t.run((ctx) =>
      ctx.db
        .query("storageBindings")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", aliceWs))
        .unique(),
    );
    expect(binding).not.toBeNull();
  });
});

describe("a non-member cannot see another workspace's grants", () => {
  test("listGrants refuses, identically to a workspace that never existed", async () => {
    const { t, mallory, aliceWs } = await twoTenants();
    const dangling = await danglingWorkspaceId(t);

    const foreign = await captureError(() =>
      asUser(t, mallory).query(api.functions.grants.listGrants, {
        workspaceId: aliceWs,
      }),
    );
    const nonexistent = await captureError(() =>
      asUser(t, mallory).query(api.functions.grants.listGrants, {
        workspaceId: dangling,
      }),
    );

    expect(errorCode(foreign)).toBe("WORKSPACE_NOT_FOUND");
    expect(errorShape(foreign)).toBe(errorShape(nonexistent));
  });

  test("revokeGrant on a foreign grant is indistinguishable from a grant id that never existed", async () => {
    const { t, mallory, aliceGrant, malloryWs } = await twoTenants();

    // A grant id that once existed and no longer does.
    const dangling = await t.run(async (ctx) => {
      const id = await ctx.db.insert("oauthGrants", {
        workspaceId: malloryWs,
        userId: mallory,
        clientId: "temp",
        scopes: [],
        hashedRefreshToken: "hash-temp",
        status: "active",
        createdAt: Date.now(),
      });
      await ctx.db.delete(id);
      return id;
    });

    const foreign = await captureError(() =>
      asUser(t, mallory).mutation(api.functions.grants.revokeGrant, {
        grantId: aliceGrant,
      }),
    );
    const nonexistent = await captureError(() =>
      asUser(t, mallory).mutation(api.functions.grants.revokeGrant, {
        grantId: dangling,
      }),
    );

    expect(errorCode(foreign)).toBe("GRANT_NOT_FOUND");
    expect(errorShape(foreign)).toBe(errorShape(nonexistent));

    // Alice's client still works.
    const grant = await t.run((ctx) => ctx.db.get(aliceGrant));
    expect(grant?.status).toBe("active");
  });
});

describe("a non-member cannot read another workspace's audit trail", () => {
  test("listEvents refuses, identically to a workspace that never existed", async () => {
    const { t, mallory, aliceWs } = await twoTenants();
    const dangling = await danglingWorkspaceId(t);

    const foreign = await captureError(() =>
      asUser(t, mallory).query(api.functions.audit.listEvents, {
        workspaceId: aliceWs,
      }),
    );
    const nonexistent = await captureError(() =>
      asUser(t, mallory).query(api.functions.audit.listEvents, {
        workspaceId: dangling,
      }),
    );

    expect(errorCode(foreign)).toBe("WORKSPACE_NOT_FOUND");
    expect(errorShape(foreign)).toBe(errorShape(nonexistent));
  });

  test("a member's own audit trail contains only their workspace's events", async () => {
    const { t, alice, aliceWs, bob, bobWs } = await twoTenants();

    const aliceEvents = await asUser(t, alice).query(
      api.functions.audit.listEvents,
      { workspaceId: aliceWs },
    );
    const bobEvents = await asUser(t, bob).query(api.functions.audit.listEvents, {
      workspaceId: bobWs,
    });

    const alicePaths = aliceEvents.flatMap((e) => e.paths);
    const bobPaths = bobEvents.flatMap((e) => e.paths);

    expect(alicePaths).toContain("1-projects/alice-secret-project.md");
    expect(alicePaths).not.toContain("1-projects/bob-secret-project.md");
    expect(bobPaths).toContain("1-projects/bob-secret-project.md");
    expect(bobPaths).not.toContain("1-projects/alice-secret-project.md");
  });
});

describe("membership is the boundary, and it is checked every time", () => {
  test("access appears the moment a membership row does, and vanishes the moment it goes", async () => {
    const { t, alice, mallory, aliceWs } = await twoTenants();

    // Before: nothing.
    expect(
      errorCode(
        await captureError(() =>
          asUser(t, mallory).query(api.functions.workspaces.getWorkspace, {
            workspaceId: aliceWs,
          }),
        ),
      ),
    ).toBe("WORKSPACE_NOT_FOUND");

    await addMember(t, aliceWs, mallory, "member", alice);

    // After: readable.
    const workspace = await asUser(t, mallory).query(
      api.functions.workspaces.getWorkspace,
      { workspaceId: aliceWs },
    );
    expect(workspace.slug).toBe("alice-context");

    // Removed: gone again, with no lingering session or cached authority.
    await t.run(async (ctx) => {
      const membership = await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace_user", (q) =>
          q.eq("workspaceId", aliceWs).eq("userId", mallory),
        )
        .unique();
      if (membership) await ctx.db.delete(membership._id);
    });

    expect(
      errorCode(
        await captureError(() =>
          asUser(t, mallory).query(api.functions.workspaces.getWorkspace, {
            workspaceId: aliceWs,
          }),
        ),
      ),
    ).toBe("WORKSPACE_NOT_FOUND");
  });

  test("removing a member invalidates their already-issued client grants", async () => {
    const { t, alice, mallory, aliceWs } = await twoTenants();
    await addMember(t, aliceWs, mallory, "editor", alice);
    await seedGrant(t, aliceWs, mallory, "codex", "hash-mallory-codex");

    // While a member, the gateway resolves her token.
    expect(
      await t.query(internal.functions.grants.resolveGrantByRefreshToken, {
        hashedRefreshToken: "hash-mallory-codex",
      }),
    ).not.toBeNull();

    await t.run(async (ctx) => {
      const membership = await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace_user", (q) =>
          q.eq("workspaceId", aliceWs).eq("userId", mallory),
        )
        .unique();
      if (membership) await ctx.db.delete(membership._id);
    });

    // Once removed, the same token resolves to nothing — no waiting for expiry.
    expect(
      await t.query(internal.functions.grants.resolveGrantByRefreshToken, {
        hashedRefreshToken: "hash-mallory-codex",
      }),
    ).toBeNull();
  });

  test("a grant cannot be created for a workspace its user does not belong to", async () => {
    const { t, mallory, aliceWs } = await twoTenants();
    const error = await captureError(() =>
      t.mutation(internal.functions.grants.createGrant, {
        workspaceId: aliceWs,
        userId: mallory,
        clientId: "claude",
        scopes: ["context.read"],
        hashedRefreshToken: "hash-forged",
      }),
    );
    expect(errorCode(error)).toBe("WORKSPACE_NOT_FOUND");
  });
});

describe("storage bindings belong to workspaces, not to people", () => {
  test("a user in two workspaces gets each workspace's own binding, not their own", async () => {
    const t = setupTest();
    const alice = await createUser(t, "alice@example.invalid");
    const bob = await createUser(t, "bob@example.invalid");

    const aliceWs = await createWorkspace(t, alice, "alice-context");
    const sharedWs = await createWorkspace(t, bob, "shared-context", {
      kind: "shared",
    });
    await addMember(t, sharedWs, alice, "editor", bob);

    await bindFakeStorage(t, alice, aliceWs, { bucket: "alice-personal" });
    await bindFakeStorage(t, bob, sharedWs, { bucket: "shared-team" });

    const personal = await asUser(t, alice).query(
      api.functions.storage.getStorageBinding,
      { workspaceId: aliceWs },
    );
    const shared = await asUser(t, alice).query(
      api.functions.storage.getStorageBinding,
      { workspaceId: sharedWs },
    );

    // Same person, two contexts, two different buckets. This is the property
    // that a `userId`-keyed binding would have made impossible.
    expect(personal?.bucket).toBe("alice-personal");
    expect(shared?.bucket).toBe("shared-team");
    expect(FAKE_STORAGE.bucket).not.toBe(shared?.bucket);
  });
});
