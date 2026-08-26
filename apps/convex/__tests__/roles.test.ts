/**
 * Role enforcement inside a workspace.
 *
 * Being able to see a context is not being able to repoint it at a different
 * bucket, and being able to write notes is not being able to disconnect a
 * colleague's AI client. These are the two privilege escalations that matter
 * in a shared context, so both get their own tests.
 */

import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { roleAtLeast } from "../functions/lib/workspaceAuth";
import {
  addMember,
  asUser,
  bindFakeStorage,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  seedGrant,
  setupTest,
} from "./fixtures.helpers";

/** An owner, an editor and a read-only member in one shared context. */
async function sharedContext() {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const editor = await createUser(t, "editor@example.invalid");
  const member = await createUser(t, "member@example.invalid");

  const workspaceId = await createWorkspace(t, owner, "shared-context", {
    kind: "shared",
    displayName: "Shared Context",
  });
  await addMember(t, workspaceId, editor, "editor", owner);
  await addMember(t, workspaceId, member, "member", owner);

  await bindFakeStorage(t, owner, workspaceId, { bucket: "team-bucket" });

  return { t, owner, editor, member, workspaceId };
}

describe("roleAtLeast", () => {
  test("orders owner > editor > member", () => {
    expect(roleAtLeast("owner", "member")).toBe(true);
    expect(roleAtLeast("owner", "editor")).toBe(true);
    expect(roleAtLeast("owner", "owner")).toBe(true);
    expect(roleAtLeast("editor", "member")).toBe(true);
    expect(roleAtLeast("editor", "owner")).toBe(false);
    expect(roleAtLeast("member", "editor")).toBe(false);
    expect(roleAtLeast("member", "owner")).toBe(false);
  });
});

describe("rebinding storage is owner-only", () => {
  test("a member cannot rebind storage", async () => {
    const { t, member, workspaceId } = await sharedContext();

    const error = await captureError(() =>
      bindFakeStorage(t, member, workspaceId, { bucket: "member-controlled" }),
    );
    expect(errorCode(error)).toBe("INSUFFICIENT_ROLE");

    const binding = await t.run((ctx) =>
      ctx.db
        .query("storageBindings")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique(),
    );
    expect(binding?.bucket).toBe("team-bucket");
  });

  test("an editor cannot rebind storage either", async () => {
    const { t, editor, workspaceId } = await sharedContext();

    const error = await captureError(() =>
      bindFakeStorage(t, editor, workspaceId, { bucket: "editor-controlled" }),
    );
    expect(errorCode(error)).toBe("INSUFFICIENT_ROLE");
    expect(
      (error as { data: { requiredRole: string; actualRole: string } }).data,
    ).toMatchObject({ requiredRole: "owner", actualRole: "editor" });
  });

  test("the owner can", async () => {
    const { t, owner, workspaceId } = await sharedContext();
    const result = await bindFakeStorage(t, owner, workspaceId, {
      bucket: "new-team-bucket",
    });
    expect(result.status).toBe("unverified");

    const binding = await t.run((ctx) =>
      ctx.db
        .query("storageBindings")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique(),
    );
    expect(binding?.bucket).toBe("new-team-bucket");
  });

  test("a member cannot disconnect storage", async () => {
    const { t, member, editor, workspaceId } = await sharedContext();

    expect(
      errorCode(
        await captureError(() =>
          asUser(t, member).mutation(api.functions.storage.disconnectStorage, {
            workspaceId,
          }),
        ),
      ),
    ).toBe("INSUFFICIENT_ROLE");
    expect(
      errorCode(
        await captureError(() =>
          asUser(t, editor).mutation(api.functions.storage.disconnectStorage, {
            workspaceId,
          }),
        ),
      ),
    ).toBe("INSUFFICIENT_ROLE");

    const binding = await t.run((ctx) =>
      ctx.db
        .query("storageBindings")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique(),
    );
    expect(binding).not.toBeNull();
  });

  test("every role can still see whether storage is healthy", async () => {
    const { t, editor, member, workspaceId } = await sharedContext();
    for (const userId of [editor, member]) {
      const binding = await asUser(t, userId).query(
        api.functions.storage.getStorageBinding,
        { workspaceId },
      );
      expect(binding?.status).toBe("unverified");
      expect(binding?.bucket).toBe("team-bucket");
    }
  });
});

describe("revoking someone else's grant is owner-only", () => {
  test("a member cannot revoke another user's grant", async () => {
    const { t, owner, member, workspaceId } = await sharedContext();
    const ownersGrant = await seedGrant(
      t,
      workspaceId,
      owner,
      "claude",
      "hash-owner-claude",
    );

    const error = await captureError(() =>
      asUser(t, member).mutation(api.functions.grants.revokeGrant, {
        grantId: ownersGrant,
      }),
    );
    expect(errorCode(error)).toBe("INSUFFICIENT_ROLE");

    expect((await t.run((ctx) => ctx.db.get(ownersGrant)))?.status).toBe("active");
  });

  test("an editor cannot revoke another user's grant — writing notes is not administering clients", async () => {
    const { t, owner, editor, workspaceId } = await sharedContext();
    const ownersGrant = await seedGrant(
      t,
      workspaceId,
      owner,
      "claude",
      "hash-owner-claude",
    );

    const error = await captureError(() =>
      asUser(t, editor).mutation(api.functions.grants.revokeGrant, {
        grantId: ownersGrant,
      }),
    );
    expect(errorCode(error)).toBe("INSUFFICIENT_ROLE");
    expect((await t.run((ctx) => ctx.db.get(ownersGrant)))?.status).toBe("active");
  });

  test("anyone may revoke their own grant, whatever their role", async () => {
    const { t, member, workspaceId } = await sharedContext();
    const ownGrant = await seedGrant(
      t,
      workspaceId,
      member,
      "chatgpt",
      "hash-member-chatgpt",
    );

    const result = await asUser(t, member).mutation(
      api.functions.grants.revokeGrant,
      { grantId: ownGrant },
    );
    expect(result.revoked).toBe(true);
    expect((await t.run((ctx) => ctx.db.get(ownGrant)))?.status).toBe("revoked");
  });

  test("the owner may revoke anyone's grant", async () => {
    const { t, owner, member, workspaceId } = await sharedContext();
    const membersGrant = await seedGrant(
      t,
      workspaceId,
      member,
      "chatgpt",
      "hash-member-chatgpt",
    );

    const result = await asUser(t, owner).mutation(
      api.functions.grants.revokeGrant,
      { grantId: membersGrant },
    );
    expect(result.revoked).toBe(true);
  });
});

describe("grant visibility follows role", () => {
  test("a read-only member sees only their own grants", async () => {
    const { t, owner, editor, member, workspaceId } = await sharedContext();
    await seedGrant(t, workspaceId, owner, "claude", "hash-owner");
    await seedGrant(t, workspaceId, editor, "codex", "hash-editor");
    await seedGrant(t, workspaceId, member, "chatgpt", "hash-member");

    const visible = await asUser(t, member).query(
      api.functions.grants.listGrants,
      { workspaceId },
    );
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({ clientId: "chatgpt", isMine: true });
  });

  test("owners and editors see every grant in the workspace", async () => {
    const { t, owner, editor, member, workspaceId } = await sharedContext();
    await seedGrant(t, workspaceId, owner, "claude", "hash-owner");
    await seedGrant(t, workspaceId, editor, "codex", "hash-editor");
    await seedGrant(t, workspaceId, member, "chatgpt", "hash-member");

    for (const userId of [owner, editor]) {
      const visible = await asUser(t, userId).query(
        api.functions.grants.listGrants,
        { workspaceId },
      );
      expect(visible.map((g) => g.clientId).sort()).toEqual([
        "chatgpt",
        "claude",
        "codex",
      ]);
    }
  });

  test("no role ever sees a refresh-token hash", async () => {
    const { t, owner, editor, member, workspaceId } = await sharedContext();
    await seedGrant(t, workspaceId, owner, "claude", "hash-owner-secret-value");
    await seedGrant(t, workspaceId, member, "chatgpt", "hash-member-secret-value");

    for (const userId of [owner, editor, member]) {
      const visible = await asUser(t, userId).query(
        api.functions.grants.listGrants,
        { workspaceId },
      );
      const serialized = JSON.stringify(visible);
      expect(serialized).not.toContain("hash-owner-secret-value");
      expect(serialized).not.toContain("hash-member-secret-value");
      expect(serialized).not.toContain("hashedRefreshToken");
    }
  });
});
