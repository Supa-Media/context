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
  /**
   * A member gets `GRANT_NOT_FOUND`, not `INSUFFICIENT_ROLE`.
   *
   * This assertion used to expect `INSUFFICIENT_ROLE`, and that was the bug:
   * `listGrants` deliberately shows a `member` only their own grants, so an
   * `INSUFFICIENT_ROLE` here confirmed that a guessed grant id was real and
   * belonged to a colleague — the same disclosure the listing rule exists to
   * prevent, reached through a different endpoint. An editor now gets the same
   * refusal for the same reason (see the next test): the listing no longer
   * shows them anybody else's grants either.
   */
  test("a member is told nothing about a grant they could not have listed", async () => {
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
    expect(errorCode(error)).toBe("GRANT_NOT_FOUND");

    // ...and byte-identical to a grant id that never existed, so the refusal
    // is not an oracle even in aggregate.
    const dangling = await t.run(async (ctx) => {
      const id = await ctx.db.insert("oauthGrants", {
        workspaceId,
        userId: member,
        clientId: "temp",
        scopes: [],
        hashedRefreshToken: "hash-temp",
        status: "active" as const,
        createdAt: Date.now(),
      });
      await ctx.db.delete(id);
      return id;
    });
    const nonexistent = await captureError(() =>
      asUser(t, member).mutation(api.functions.grants.revokeGrant, {
        grantId: dangling,
      }),
    );
    expect(JSON.stringify((error as { data: unknown }).data)).toBe(
      JSON.stringify((nonexistent as { data: unknown }).data),
    );

    expect((await t.run((ctx) => ctx.db.get(ownersGrant)))?.status).toBe("active");
  });

  /**
   * An editor is told nothing either, and that is a change.
   *
   * The refusal named the missing role while an editor could enumerate every
   * grant in the workspace — nothing was disclosed by naming what they lacked
   * about a row they could already read. `listGrants` is owner-only now, so
   * the same sentence became an existence oracle: `INSUFFICIENT_ROLE` for a
   * colleague's real grant and `GRANT_NOT_FOUND` for an invented id tells an
   * editor which guessed ids are real. The rule in `grants.ts` did not move;
   * its premise did.
   */
  test("an editor cannot revoke another user's grant, and is told nothing about it", async () => {
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
    expect(errorCode(error)).toBe("GRANT_NOT_FOUND");

    // ...and byte-identical to a grant id that never existed.
    const dangling = await t.run(async (ctx) => {
      const id = await ctx.db.insert("oauthGrants", {
        workspaceId,
        userId: editor,
        clientId: "temp",
        scopes: [],
        hashedRefreshToken: "hash-temp-editor",
        status: "active" as const,
        createdAt: Date.now(),
      });
      await ctx.db.delete(id);
      return id;
    });
    const nonexistent = await captureError(() =>
      asUser(t, editor).mutation(api.functions.grants.revokeGrant, {
        grantId: dangling,
      }),
    );
    expect(JSON.stringify((error as { data: unknown }).data)).toBe(
      JSON.stringify((nonexistent as { data: unknown }).data),
    );

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

  test("an editor sees only their own — writing notes is not administering clients", async () => {
    const { t, owner, editor, member, workspaceId } = await sharedContext();
    await seedGrant(t, workspaceId, owner, "claude", "hash-owner");
    await seedGrant(t, workspaceId, editor, "codex", "hash-editor");
    await seedGrant(t, workspaceId, member, "chatgpt", "hash-member");

    const visible = await asUser(t, editor).query(
      api.functions.grants.listGrants,
      { workspaceId },
    );
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({ clientId: "codex", isMine: true });
  });

  test("the owner sees every grant, because revoking any of them is theirs to do", async () => {
    const { t, owner, editor, member, workspaceId } = await sharedContext();
    await seedGrant(t, workspaceId, owner, "claude", "hash-owner");
    await seedGrant(t, workspaceId, editor, "codex", "hash-editor");
    await seedGrant(t, workspaceId, member, "chatgpt", "hash-member");

    const visible = await asUser(t, owner).query(
      api.functions.grants.listGrants,
      { workspaceId },
    );
    expect(visible.map((g) => g.clientId).sort()).toEqual([
      "chatgpt",
      "claude",
      "codex",
    ]);
    // And says which of them are somebody else's, so a console listing them
    // beside the owner's own can tell them apart.
    expect(
      visible.filter((g) => g.isMine).map((g) => g.clientId),
    ).toEqual(["claude"]);
  });

  /**
   * The case this rule was narrowed for.
   *
   * A person invited into somebody's personal brain opened Settings and found
   * the owner's connected clients listed there — every AI tool that person
   * uses, its reach, and when it last ran. Nothing about a personal context
   * makes an invitee responsible for the owner's tooling, and there was never
   * a lever here for them to pull: `revokeGrant` has always been owner-or-self.
   */
  test("an invitee to a personal brain cannot enumerate the owner's clients", async () => {
    const t = setupTest();
    const seyi = await createUser(t, "seyi@example.invalid");
    const guest = await createUser(t, "guest@example.invalid");
    const brain = await createWorkspace(t, seyi, "seyi", {
      kind: "personal",
      displayName: "seyi",
    });
    await addMember(t, brain, guest, "editor", seyi);

    await seedGrant(t, brain, seyi, "claude", "hash-seyi-claude");
    await seedGrant(t, brain, seyi, "chatgpt", "hash-seyi-chatgpt");
    const guestsOwn = await seedGrant(t, brain, guest, "codex", "hash-guest-codex");

    const visible = await asUser(t, guest).query(
      api.functions.grants.listGrants,
      { workspaceId: brain },
    );
    expect(visible.map((g) => g.grantId)).toEqual([guestsOwn]);
    expect(JSON.stringify(visible)).not.toContain("claude");
    expect(JSON.stringify(visible)).not.toContain("chatgpt");
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
